from dotenv import load_dotenv
import os, httpx, json

load_dotenv()

key = os.getenv("APOLLO_API_KEY")

resp = httpx.post(
    "https://api.apollo.io/v1/mixed_people/api_search",
    headers={"X-Api-Key": key, "Content-Type": "application/json"},
    json={
        "organization_domains": ["uber.com"],
        "person_titles": ["Product Manager"],
        "page": 1,
        "per_page": 10,
    },
    timeout=30.0,
)

print("Status:", resp.status_code)
data = resp.json()
people = data.get("people", [])
print(f"People returned: {len(people)}\n")

for p in people:
    org = p.get("organization") or {}
    org_name = org.get("name") or p.get("organization_name") or "— unknown"
    org_domain = org.get("website_url") or "— no domain"
    email = p.get("email") or "— no email"
    print(f"  {p.get('first_name')} {p.get('last_name')}")
    print(f"    Title:   {p.get('title')}")
    print(f"    Company: {org_name}")
    print(f"    Domain:  {org_domain}")
    print(f"    Email:   {email}")
    print()
