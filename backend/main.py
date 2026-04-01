import logging
import os
from datetime import datetime, timezone
from typing import List, Optional

import httpx
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from apollo import Contact, enrich_contact, search_contacts_raw
from claude_email import apply_template, draft_company_email
from db import (
    already_contacted, get_all_contacted_ids, get_available_weeks,
    get_leaderboard, mark_contacted,
    store_user_token, get_user_token, update_cached_access_token,
    schedule_emails, get_due_emails, mark_email_sent, mark_email_failed,
)
from gmail import refresh_access_token, send_email

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="CMG Lead Gen API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://cmgsourcing.vercel.app",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

import re as _re
ALLOWED_EMAILS: set[str] = {
    e.strip().lower()
    for e in _re.split(r'[,\n\r]+', os.getenv("ALLOWED_EMAILS", ""))
    if e.strip()
}
logger.info("ALLOWED_EMAILS loaded: %s", ALLOWED_EMAILS)

GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
CRON_SECRET          = os.getenv("CRON_SECRET", "")


def _redirect_uri(request: Request) -> str:
    host = request.headers.get("x-forwarded-host") or request.url.hostname
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    return f"{scheme}://{host}/auth/callback"


def _frontend_url(request: Request) -> str:
    host = request.headers.get("x-forwarded-host") or request.url.hostname
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    # If running locally, frontend is on :5173
    if host in ("localhost", "127.0.0.1"):
        return "http://localhost:5173"
    # In production on Railway, frontend is on Vercel
    return "https://cmgsourcing.vercel.app"


# ── Auth dependency ────────────────────────────────────────────────────────────

async def require_auth(authorization: Optional[str] = Header(None)) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Sign in with Google to use this tool.")
    token = authorization.removeprefix("Bearer ")
    async with httpx.AsyncClient() as client:
        r = await client.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"access_token": token},
        )
    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid or expired Google token.")
    email = r.json().get("email", "").lower()
    logger.info("Token email received: '%s', in allowlist: %s", email, email in ALLOWED_EMAILS)
    if not email or email not in ALLOWED_EMAILS:
        raise HTTPException(status_code=403, detail=f"{email} is not authorised to use this tool.")
    logger.info("Authenticated request from %s", email)
    return email


# ── Shared helpers ─────────────────────────────────────────────────────────────

def _normalise_domain(website: str) -> str:
    domain = website.lower()
    for prefix in ("https://", "http://", "www."):
        if domain.startswith(prefix):
            domain = domain[len(prefix):]
    return domain.rstrip("/")


# ── Pydantic request models ────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    industry: str
    website: str
    target_title: str = "CEO"
    limit: int = 5


class EnrichContactInput(BaseModel):
    apollo_id: str
    first_name: str  # kept for response passthrough only


class EnrichRequest(BaseModel):
    contacts: List[EnrichContactInput]


class DraftContactInput(BaseModel):
    apollo_id: str = ""
    first_name: str
    last_name: str
    email: str
    title: str
    company: str


class DraftRequest(BaseModel):
    industry: str
    sender_name: str = ""
    contacts: List[DraftContactInput]


class CommitContactInput(BaseModel):
    apollo_id: str = ""
    first_name: str
    last_name: str
    email: str
    title: str
    company: str
    subject: str
    body: str


class CommitRequest(BaseModel):
    contacts: List[CommitContactInput]
    scheduled_time: str          # ISO 8601 UTC e.g. "2026-04-01T09:00:00Z"


# ── Step 1: health ─────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


# ── Server-side OAuth ──────────────────────────────────────────────────────────

@app.get("/auth/google")
async def auth_google(request: Request):
    """Redirect the browser to Google's OAuth consent screen."""
    import urllib.parse
    redirect_uri = _redirect_uri(request)
    logger.info("auth/google redirect_uri=%s headers=%s", redirect_uri, dict(request.headers))
    params = urllib.parse.urlencode({
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile https://www.googleapis.com/auth/gmail.send",
        "access_type": "offline",
        "prompt": "consent",
    })
    return RedirectResponse(f"https://accounts.google.com/o/oauth2/v2/auth?{params}")


@app.get("/auth/callback")
async def auth_callback(request: Request, code: Optional[str] = None, error: Optional[str] = None):
    """Exchange the auth code for tokens and redirect back to the frontend."""
    frontend = _frontend_url(request)
    if error or not code:
        return RedirectResponse(f"{frontend}?auth_error={error or 'missing_code'}")

    redirect_uri = _redirect_uri(request)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
    if r.status_code != 200:
        logger.error("Token exchange failed: %s", r.text)
        return RedirectResponse(f"{frontend}?auth_error=token_exchange_failed")

    tokens = r.json()
    access_token  = tokens["access_token"]
    refresh_token = tokens.get("refresh_token", "")
    expires_in    = int(tokens.get("expires_in", 3600))

    # Fetch user info
    async with httpx.AsyncClient(timeout=10.0) as client:
        ui = await client.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    if not ui.ok:
        return RedirectResponse(f"{frontend}?auth_error=userinfo_failed")
    user_info = ui.json()
    email = user_info.get("email", "").lower()

    if email not in ALLOWED_EMAILS:
        logger.warning("Unauthorised OAuth login attempt: %s", email)
        return RedirectResponse(f"{frontend}?auth_error=not_authorised")

    # Persist tokens (only store refresh_token if we got one; re-consent forces a new one)
    if refresh_token:
        store_user_token(email, refresh_token, access_token, expires_in)
    else:
        # Update access token only (refresh token already in DB from prior consent)
        row = get_user_token(email)
        if row:
            update_cached_access_token(email, access_token, expires_in)

    import urllib.parse
    qs = urllib.parse.urlencode({
        "access_token": access_token,
        "email":        email,
        "name":         user_info.get("name", ""),
        "picture":      user_info.get("picture", ""),
        "expires_in":   expires_in,
    })
    logger.info("OAuth callback success for %s", email)
    return RedirectResponse(f"{frontend}?{qs}")


# ── Server-side token refresh helper ──────────────────────────────────────────

async def get_fresh_access_token(email: str) -> str:
    """Return a valid access token for email, refreshing if needed."""
    row = get_user_token(email)
    if not row:
        raise HTTPException(status_code=401, detail=f"No stored token for {email}. Please sign in again.")

    # Check if cached token is still valid (with 60s buffer)
    expiry_str = row.get("token_expiry")
    if expiry_str and row.get("access_token"):
        expiry = datetime.fromisoformat(expiry_str.replace("Z", "+00:00"))
        if datetime.now(timezone.utc).timestamp() < expiry.timestamp() - 60:
            return row["access_token"]

    # Refresh
    if not row.get("refresh_token"):
        raise HTTPException(status_code=401, detail=f"No refresh token for {email}. Please sign in again.")
    access_token, expires_in = await refresh_access_token(
        row["refresh_token"], GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
    )
    update_cached_access_token(email, access_token, expires_in)
    logger.info("Refreshed access token for %s", email)
    return access_token


# ── Leaderboard ─────────────────────────────────────────────────────────────────

@app.get("/api/leaderboard/weeks")
async def leaderboard_weeks():
    return get_available_weeks()


@app.get("/api/leaderboard")
async def leaderboard(week_start: Optional[str] = None):
    return get_leaderboard(week_start=week_start)


# ── Step 2: Search (Apollo raw, no enrichment) ─────────────────────────────────

@app.post("/api/search")
async def search_leads(req: SearchRequest, user: str = Depends(require_auth)):
    """
    Apollo mixed_people/search only.
    Returns raw contacts — email may be null. No enrichment, no Claude.
    """
    domain = _normalise_domain(req.website)
    logger.info("Search: domain=%s title=%s limit=%d", domain, req.target_title, req.limit)

    # Fetch all previously contacted IDs upfront so Apollo pagination
    # keeps going until it finds `limit` genuinely fresh contacts.
    contacted_ids = get_all_contacted_ids()
    logger.info("Loaded %d contacted IDs for dedup", len(contacted_ids))

    contacts = await search_contacts_raw(domain, req.target_title, req.limit, contacted_ids)
    logger.info("Returning %d fresh contacts", len(contacts))

    return [
        {
            "apollo_id": c.apollo_id,
            "first_name": c.first_name,
            "last_name": c.last_name,
            "email": c.email,
            "title": c.title,
            "company": c.company,
            "domain": c.domain,
            "has_email": c.has_email,
            "enriched": c.enriched,
        }
        for c in contacts
    ]


# ── Step 4: Enrich (Apollo people/match, explicit opt-in) ─────────────────────

@app.post("/api/enrich")
async def enrich_contacts(req: EnrichRequest, user: str = Depends(require_auth)):
    """
    Apollo people/match for specific contacts.
    Only called when the user explicitly requests enrichment.
    """
    results = []
    for item in req.contacts:
        logger.info("Enriching %s (apollo_id=%s)", item.first_name, item.apollo_id)
        email = await enrich_contact(item.apollo_id)
        results.append(
            {
                "first_name": item.first_name,
                "email": email,
                "enriched": True,
                "enrichment_failed": email is None,
            }
        )
    return results


# ── Step 6: Draft (Claude — one call per unique company) ──────────────────────

@app.post("/api/draft")
async def generate_drafts(req: DraftRequest, user: str = Depends(require_auth)):
    """
    Claude email generation — ONE call per unique company.
    Returns per-contact drafts with {first_name}/{title} already substituted.
    """
    # Group contacts by company
    companies: dict[str, list[DraftContactInput]] = {}
    for c in req.contacts:
        companies.setdefault(c.company, []).append(c)

    results = []
    for company, members in companies.items():
        logger.info("Drafting template for company=%s industry=%s", company, req.industry)
        try:
            template = await draft_company_email(
                company=company,
                industry=req.industry,
                target_title=members[0].title,
            )
        except Exception as exc:
            logger.error("Claude draft failed for %s: %s", company, exc)
            template = {"subject": f"Partnership Opportunity — {company}", "body": ""}

        # Substitute per-contact placeholders for each member
        for member in members:
            contact_obj = Contact(
                first_name=member.first_name,
                last_name=member.last_name,
                email=member.email,
                title=member.title,
                company=member.company,
                domain="",
                apollo_id="",
                has_email=bool(member.email),
            )
            final = apply_template(template["subject"], template["body"], contact_obj, req.industry, req.sender_name)
            results.append(
                {
                    "apollo_id": member.apollo_id,
                    "first_name": member.first_name,
                    "last_name": member.last_name,
                    "email": member.email,
                    "title": member.title,
                    "company": member.company,
                    "subject": final["subject"],
                    "body": final["body"],
                    # Raw company template so the UI can show one editor per company
                    "company_template_subject": template["subject"],
                    "company_template_body": template["body"],
                }
            )

    return results


# ── Step 8: Commit (server-side scheduled send via Supabase) ──────────────────

@app.post("/api/commit")
async def commit_leads(
    req: CommitRequest,
    user: str = Depends(require_auth),
):
    """
    Write emails to scheduled_emails table for the cron job to send.
    Marks contacts immediately in the contacted table for dedup.
    """
    rows = []
    results = []
    for item in req.contacts:
        if not item.email:
            logger.warning("Skipping %s — no email", item.first_name)
            continue
        rows.append({
            "sender_email": user,
            "to_email":     item.email,
            "subject":      item.subject,
            "body":         item.body,
            "send_at":      req.scheduled_time,
            "status":       "pending",
            "apollo_id":    item.apollo_id or None,
            "first_name":   item.first_name,
            "last_name":    item.last_name,
            "title":        item.title,
            "company":      item.company,
        })
        results.append({
            "email":          item.email,
            "scheduled_time": req.scheduled_time,
            "status":         "scheduled",
        })

    if rows:
        schedule_emails(rows)
        logger.info("Scheduled %d emails in Supabase for %s", len(rows), user)

    # Mark all contacts immediately so they're filtered in future searches
    if rows:
        mark_contacted([item.dict() for item in req.contacts if item.email], sent_by=user)
        logger.info("Marked %d contacts as contacted (sent_by=%s)", len(rows), user)

    return results


# ── Cron: send due emails ──────────────────────────────────────────────────────

@app.post("/api/cron/send-due")
async def cron_send_due(x_cron_secret: Optional[str] = Header(None)):
    """Called by Railway cron every minute. Sends all due pending emails."""
    if not CRON_SECRET or x_cron_secret != CRON_SECRET:
        raise HTTPException(status_code=401, detail="Invalid cron secret.")

    due = get_due_emails()
    logger.info("Cron: %d due emails", len(due))
    sent_count = failed_count = 0

    for row in due:
        email_id      = row["id"]
        sender_email  = row["sender_email"]
        to_email      = row["to_email"]
        subject       = row["subject"]
        body          = row["body"]

        try:
            access_token = await get_fresh_access_token(sender_email)
            msg_id = await send_email(to_email, subject, body, access_token)
            mark_email_sent(email_id, msg_id)
            logger.info("Cron sent email id=%s to %s (gmail_id=%s)", email_id, to_email, msg_id)
            sent_count += 1
        except Exception as exc:
            mark_email_failed(email_id, str(exc))
            logger.error("Cron failed email id=%s to %s: %s", email_id, to_email, exc)
            failed_count += 1

    return {"sent": sent_count, "failed": failed_count}


