from dotenv import load_dotenv
import os, httpx, json

load_dotenv()
key = os.getenv("APOLLO_API_KEY")

# Step 1: search and grab the Apollo person ID
print("Step 1: Searching for Uber PMs...")
search_resp = httpx.post(
    "https://api.apollo.io/v1/mixed_people/api_search",
    headers={"X-Api-Key": key, "Content-Type": "application/json"},
    json={
        "q_organization_domains": "uber.com",
        "person_titles": ["Product Manager"],
        "page": 1,
        "per_page": 3,
    },
    timeout=30.0,
)

people = search_resp.json().get("people", [])
print(f"Found {len(people)} contacts")

# Print all fields Apollo actually returns so we can see what we have to work with
print("\nRaw fields on first contact:")
print(json.dumps(people[0], indent=2) if people else "none")
print()

# Step 2: try enriching by Apollo ID
print("Step 2: Enriching by Apollo person ID...")
print()

for p in people:
    apollo_id = p.get("id")
    first = p.get("first_name") or ""

    enrich_resp = httpx.post(
        "https://api.apollo.io/v1/people/match",
        headers={"X-Api-Key": key, "Content-Type": "application/json"},
        json={
            "id": apollo_id,
            "reveal_personal_emails": False,
        },
        timeout=15.0,
    )

    person = enrich_resp.json().get("person") or {}
    email = person.get("email") or "— not revealed"
    last = person.get("last_name") or "—"
    print(f"  {first} {last} (id: {apollo_id})")
    print(f"    Email: {email}")
    print(f"    Title: {person.get('title') or '—'}")
    print()
