import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from supabase import create_client, Client

PT = ZoneInfo("America/Los_Angeles")

_client: Client | None = None


def get_db() -> Client:
    global _client
    if _client is None:
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_KEY")
        if not url or not key:
            raise RuntimeError("SUPABASE_URL and SUPABASE_KEY must be set in .env")
        _client = create_client(url, key)
    return _client


def already_contacted(apollo_ids: list[str]) -> set[str]:
    """Return the subset of apollo_ids that are already in the contacted table."""
    if not apollo_ids:
        return set()
    res = (
        get_db()
        .table("contacted")
        .select("apollo_id")
        .in_("apollo_id", apollo_ids)
        .execute()
    )
    return {row["apollo_id"] for row in res.data}


def get_all_contacted_ids() -> set[str]:
    """Return every apollo_id ever contacted. Used to seed pagination dedup."""
    res = get_db().table("contacted").select("apollo_id").execute()
    return {row["apollo_id"] for row in res.data}


def mark_contacted(contacts: list[dict], sent_by: str = "") -> None:
    """Insert/upsert contacts into the contacted table after a successful send."""
    now = datetime.now(timezone.utc).isoformat()
    rows = [
        {
            "apollo_id":  c["apollo_id"],
            "sent_by":    sent_by,
            "created_at": now,
            "first_name": c.get("first_name", ""),
            "last_name":  c.get("last_name", ""),
            "title":      c.get("title", ""),
            "company":    c.get("company", ""),
            "email":      c.get("email", ""),
        }
        for c in contacts
        if c.get("apollo_id")
    ]
    if rows:
        get_db().table("contacted").upsert(rows, on_conflict="apollo_id").execute()


def _week_start(dt: datetime) -> datetime:
    """Return Monday 00:00:00 UTC of the week containing dt, using Pacific Time boundaries."""
    dt_pt = dt.astimezone(PT)
    # isoweekday: Mon=1 … Sun=7
    days_since_monday = dt_pt.isoweekday() - 1
    monday_pt = (dt_pt - timedelta(days=days_since_monday)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return monday_pt.astimezone(timezone.utc)


def get_available_weeks() -> list[str]:
    """Return ISO date strings (YYYY-MM-DD, Monday in PT) for every week that has data, newest first."""
    res = (
        get_db()
        .table("contacted")
        .select("created_at")
        .not_.is_("created_at", "null")
        .execute()
    )
    weeks: set[str] = set()
    for row in res.data:
        dt = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        monday_utc = _week_start(dt)
        # Store the date as it appears in PT so the label reads naturally
        weeks.add(monday_utc.astimezone(PT).date().isoformat())
    return sorted(weeks, reverse=True)


def get_leaderboard(week_start: str | None = None) -> list[dict]:
    """Return send counts grouped by sender for the given week (or all time)."""
    query = get_db().table("contacted").select("sent_by").not_.is_("sent_by", "null")
    if week_start:
        # week_start is a PT date string (YYYY-MM-DD); convert Monday 00:00 PT → UTC
        naive = datetime.fromisoformat(week_start)
        start_pt = naive.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=PT)
        start_utc = start_pt.astimezone(timezone.utc)
        end_utc = start_utc + timedelta(days=7)
        query = query.gte("created_at", start_utc.isoformat()).lt("created_at", end_utc.isoformat())
    res = query.execute()
    counts: dict[str, int] = {}
    for row in res.data:
        sender = row["sent_by"]
        counts[sender] = counts.get(sender, 0) + 1
    return [
        {"email": email, "count": count}
        for email, count in sorted(counts.items(), key=lambda x: x[1], reverse=True)
    ]


# ── OAuth token storage ────────────────────────────────────────────────────────

def store_user_token(
    email: str,
    refresh_token: str,
    access_token: str | None = None,
    expires_in: int | None = None,
) -> None:
    """Upsert OAuth tokens for a user."""
    now = datetime.now(timezone.utc)
    row: dict = {
        "email": email,
        "refresh_token": refresh_token,
        "updated_at": now.isoformat(),
    }
    if access_token:
        row["access_token"] = access_token
    if expires_in is not None:
        row["token_expiry"] = (now + timedelta(seconds=expires_in)).isoformat()
    get_db().table("user_tokens").upsert(row, on_conflict="email").execute()


def get_user_token(email: str) -> dict | None:
    """Return the stored token row for a user, or None if not found."""
    res = (
        get_db()
        .table("user_tokens")
        .select("*")
        .eq("email", email)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def update_cached_access_token(email: str, access_token: str, expires_in: int) -> None:
    """Update the cached access token after a refresh."""
    now = datetime.now(timezone.utc)
    get_db().table("user_tokens").update({
        "access_token": access_token,
        "token_expiry": (now + timedelta(seconds=expires_in)).isoformat(),
        "updated_at": now.isoformat(),
    }).eq("email", email).execute()


# ── Scheduled emails ───────────────────────────────────────────────────────────

def schedule_emails(rows: list[dict]) -> None:
    """Insert rows into the scheduled_emails table."""
    if not rows:
        return
    get_db().table("scheduled_emails").insert(rows).execute()


def get_due_emails() -> list[dict]:
    """Return pending emails whose send_at is now or in the past."""
    now = datetime.now(timezone.utc).isoformat()
    res = (
        get_db()
        .table("scheduled_emails")
        .select("*")
        .eq("status", "pending")
        .lte("send_at", now)
        .execute()
    )
    return res.data or []


def mark_email_sent(id: str, gmail_message_id: str) -> None:
    """Mark a scheduled email as sent."""
    get_db().table("scheduled_emails").update({
        "status": "sent",
        "gmail_message_id": gmail_message_id,
    }).eq("id", id).execute()


def mark_email_failed(id: str, error_message: str) -> None:
    """Mark a scheduled email as failed."""
    get_db().table("scheduled_emails").update({
        "status": "failed",
        "error_message": error_message,
    }).eq("id", id).execute()
