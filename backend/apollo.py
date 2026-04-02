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
    # api_search returns has_email bool and last_name_obfuscated (e.g. "Ch***a")
    # even when full last name is withheld — surface both for the UI
    has_email = person.get("has_email") or bool(email)
    last_name = person.get("last_name") or person.get("last_name_obfuscated") or ""
    return Contact(
        first_name=person.get("first_name") or "",
        last_name=last_name,
        email=email,
        title=person.get("title") or "",
        company=org.get("name") or person.get("organization_name") or "",
        domain=org.get("website_url") or "",
        apollo_id=person.get("id") or "",
        has_email=has_email,
        enriched=False,
    )


async def search_contacts_raw(
    domain: str,
    target_title: str,
    limit: int,
    contacted_ids: set[str] | None = None,
) -> List[Contact]:
    """
    Apollo api_search — returns raw results with no enrichment.
    Paginates until `limit` fresh (never-contacted) contacts are found.
    Tries domain first; falls back to org name (stripped TLD) if zero results.
    Contacts may have email=None; caller decides when/if to enrich.
    """
    if contacted_ids is None:
        contacted_ids = set()

    api_key = os.getenv("APOLLO_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="APOLLO_API_KEY not configured")

    headers = {"X-Api-Key": api_key, "Content-Type": "application/json"}
    PER_PAGE = 50

    async def fetch_page(page: int, search_param: dict) -> tuple[list[dict], dict]:
        payload = {"person_titles": [target_title], "page": page, "per_page": PER_PAGE, **search_param}
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "https://api.apollo.io/v1/mixed_people/api_search",
                json=payload, headers=headers, timeout=30.0,
            )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=f"Apollo API error: {resp.text}")
        data = resp.json()
        return data.get("people", []), data.get("pagination", {})

    # Determine search param — domain first, fallback to org name
    search_param: dict = {"q_organization_domains": domain}
    people, pagination = await fetch_page(1, search_param)
    if not people:
        org_name = domain.split(".")[0]
        search_param = {"q_organization_name": org_name}
        people, pagination = await fetch_page(1, search_param)

    fresh: List[Contact] = [
        _person_to_contact(p) for p in people if p.get("id") not in contacted_ids
    ]

    page = 2
    total_pages = pagination.get("total_pages", 1)

    while len(fresh) < limit and page <= total_pages:
        people, _ = await fetch_page(page, search_param)
        if not people:
            break
        fresh += [_person_to_contact(p) for p in people if p.get("id") not in contacted_ids]
        page += 1

    return fresh[:limit]


async def enrich_contact(apollo_id: str) -> Optional[str]:
    """
    Apollo people/match by Apollo person ID.
    ID-based lookup is unambiguous — no name guessing needed.
    Costs 1 credit. Returns revealed email or None.
    This is an explicit, user-initiated action — NOT called automatically.
    """
    api_key = os.getenv("APOLLO_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="APOLLO_API_KEY not configured")

    headers = {"X-Api-Key": api_key, "Content-Type": "application/json"}

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(
                "https://api.apollo.io/v1/people/match",
                json={"id": apollo_id, "reveal_personal_emails": False},
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
        "q_organization_domains": domain,
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
