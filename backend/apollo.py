import os
from dataclasses import dataclass, field
from typing import List, Optional

import httpx
from fastapi import HTTPException


@dataclass
class Contact:
    first_name: str
    last_name: str
    email: Optional[str]
    title: str
    company: str
    domain: str
    apollo_id: str
    has_email: bool
    enriched: bool = False


def _extract_domain(person: dict) -> str:
    org = person.get("organization") or {}
    return org.get("website_url") or ""


def _person_to_contact(person: dict) -> Contact:
    org = person.get("organization") or {}
    email = person.get("email") or None
    return Contact(
        first_name=person.get("first_name") or "",
        last_name=person.get("last_name") or "",
        email=email,
        title=person.get("title") or "",
        company=org.get("name") or person.get("organization_name") or "",
        domain=org.get("website_url") or "",
        apollo_id=person.get("id") or "",
        has_email=bool(email),
        enriched=False,
    )


async def search_contacts_raw(domain: str, target_title: str, limit: int) -> List[Contact]:
    """
    Apollo mixed_people/search — returns raw results with no enrichment.
    Contacts may have email=None; caller decides when/if to enrich.
    """
    api_key = os.getenv("APOLLO_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="APOLLO_API_KEY not configured")

    payload = {
        "organization_domains": [domain],
        "person_titles": [target_title],
        "page": 1,
        "per_page": min(limit, 100),
    }
    headers = {"X-Api-Key": api_key, "Content-Type": "application/json"}

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.apollo.io/v1/mixed_people/api_search",
            json=payload,
            headers=headers,
            timeout=30.0,
        )

    if response.status_code != 200:
        raise HTTPException(
            status_code=response.status_code,
            detail=f"Apollo API error: {response.text}",
        )

    people = response.json().get("people", [])
    return [_person_to_contact(p) for p in people[:limit]]


async def enrich_contact(
    first_name: str,
    last_name: str,
    organization_name: str,
    domain: str,
) -> Optional[str]:
    """
    Apollo people/match for a single contact.
    Returns the revealed email or None if not found.
    This is an explicit, user-initiated action — NOT called automatically.
    """
    api_key = os.getenv("APOLLO_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="APOLLO_API_KEY not configured")

    payload = {
        "first_name": first_name,
        "last_name": last_name,
        "organization_name": organization_name,
        "domain": domain,
        "reveal_personal_emails": False,
    }
    headers = {"X-Api-Key": api_key, "Content-Type": "application/json"}

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                "https://api.apollo.io/v1/people/match",
                json=payload,
                headers=headers,
                timeout=15.0,
            )
            if resp.status_code == 200:
                return (resp.json().get("person") or {}).get("email") or None
        except Exception:
            pass
    return None


# ── Legacy helper kept for /api/leads backward compat ─────────────────────────

async def find_contacts(domain: str, target_title: str, limit: int) -> List[Contact]:
    """
    Legacy all-in-one: search + auto-enrich until `limit` contacts with emails found.
    Kept so the old /api/leads endpoint still works.
    """
    api_key = os.getenv("APOLLO_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="APOLLO_API_KEY not configured")

    payload = {
        "organization_domains": [domain],
        "person_titles": [target_title],
        "page": 1,
        "per_page": limit * 3,
    }
    headers = {"X-Api-Key": api_key, "Content-Type": "application/json"}

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://api.apollo.io/v1/mixed_people/api_search",
            json=payload,
            headers=headers,
            timeout=30.0,
        )

        if response.status_code != 200:
            raise HTTPException(
                status_code=response.status_code,
                detail=f"Apollo API error: {response.text}",
            )

        people = response.json().get("people", [])
        contacts: List[Contact] = []

        for person in people:
            if len(contacts) >= limit:
                break
            email = person.get("email")
            if not email:
                org = person.get("organization") or {}
                email = await enrich_contact(
                    person.get("first_name", ""),
                    person.get("last_name", ""),
                    org.get("name") or person.get("organization_name", ""),
                    org.get("website_url", ""),
                )
            if not email:
                continue
            c = _person_to_contact(person)
            c.email = email
            c.has_email = True
            c.enriched = True
            contacts.append(c)

    if not contacts:
        raise HTTPException(
            status_code=404,
            detail="No contacts with emails found for that domain.",
        )
    return contacts
