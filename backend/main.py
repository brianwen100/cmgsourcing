import logging
import os
from typing import List, Optional

import httpx
from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from apollo import Contact, enrich_contact, search_contacts_raw
from claude_email import apply_template, draft_company_email
from db import already_contacted, get_all_contacted_ids, get_available_weeks, get_leaderboard, mark_contacted
from gmail import schedule_send

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


def _token_from_header(authorization: Optional[str]) -> Optional[str]:
    if authorization and authorization.startswith("Bearer "):
        return authorization[7:]
    return None


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


# ── Step 8: Commit (Gmail scheduled send) ────────────────────────────────────

@app.post("/api/commit")
async def commit_leads(
    req: CommitRequest,
    authorization: Optional[str] = Header(None),
    user: str = Depends(require_auth),
):
    """
    Schedule one personalized email per contact via Gmail scheduled send.
    Emails appear in the Scheduled folder — not Drafts.
    Requires Authorization: Bearer <google_token> header.
    """
    google_token = _token_from_header(authorization)

    results = []
    for item in req.contacts:
        if not item.email:
            logger.warning("Skipping %s — no email", item.first_name)
            continue

        message_id = ""
        if google_token:
            try:
                message_id = schedule_send(
                    to_email=item.email,
                    subject=item.subject,
                    body=item.body,
                    google_token=google_token,
                    delivery_time=req.scheduled_time,
                )
                logger.info("Scheduled send for %s at %s (id=%s)", item.email, req.scheduled_time, message_id)
            except Exception as exc:
                logger.warning("Scheduled send failed for %s: %s", item.email, exc)
        else:
            logger.info("No Google token — skipping send for %s", item.email)

        results.append(
            {
                "email": item.email,
                "message_id": message_id,
                "scheduled_time": req.scheduled_time,
                "status": "Scheduled" if message_id else "Failed",
            }
        )

    # Record everyone successfully sent to so they're filtered in future searches
    sent = [item.dict() for item, r in zip(req.contacts, results) if r["status"] == "Scheduled"]
    if sent:
        mark_contacted(sent, sent_by=user)
        logger.info("Marked %d contacts as contacted in Supabase (sent_by=%s)", len(sent), user)

    return results


