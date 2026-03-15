from dotenv import load_dotenv
import os, httpx

load_dotenv()
key = os.getenv("APOLLO_API_KEY")
headers = {"X-Api-Key": key, "Content-Type": "application/json"}

def search(domain):
    # Mirror the fallback logic from apollo.py
    base = {"person_titles": ["Product Manager"], "page": 1, "per_page": 5}

    r = httpx.post("https://api.apollo.io/v1/mixed_people/api_search",
        headers=headers, json={**base, "q_organization_domains": domain}, timeout=30.0)
    people = r.json().get("people", [])

    if not people:
        org_name = domain.split(".")[0]
        print(f"  Domain miss — falling back to name '{org_name}'")
        r = httpx.post("https://api.apollo.io/v1/mixed_people/api_search",
            headers=headers, json={**base, "q_organization_name": org_name}, timeout=30.0)
        people = r.json().get("people", [])

    companies = set(
        (p.get("organization") or {}).get("name") or p.get("organization_name") or "unknown"
        for p in people
    )
    print(f"  {domain:<20} → {len(people)} results  {companies}")

print("Domain + fallback test:")
search("uber.com")      # should work via domain
search("tinder.com")    # should fall back to name
