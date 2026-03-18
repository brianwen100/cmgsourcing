import os
from datetime import datetime, timezone

from supabase import create_client, Client

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
        {"apollo_id": c["apollo_id"], "sent_by": sent_by, "created_at": now}
        for c in contacts
        if c.get("apollo_id")
    ]
    if rows:
        get_db().table("contacted").upsert(rows, on_conflict="apollo_id").execute()


def get_leaderboard() -> list[dict]:
    """Return send counts grouped by sender, descending."""
    res = (
        get_db()
        .table("contacted")
        .select("sent_by")
        .not_.is_("sent_by", "null")
        .execute()
    )
    counts: dict[str, int] = {}
    for row in res.data:
        sender = row["sent_by"]
        counts[sender] = counts.get(sender, 0) + 1
    return [
        {"email": email, "count": count}
        for email, count in sorted(counts.items(), key=lambda x: x[1], reverse=True)
    ]
