# CMG Lead Gen Tool — Technical Process Document

> **Living document.** Update this file whenever the architecture or UX flow changes.
> Last meaningful revision: 2026-03-13

---

## Engineering Critique (Read First)

Before detailing the flow, here is an honest assessment of the current architecture.

### 1. The backend does too much in one call
`POST /api/leads` currently runs Apollo search → enrichment → Claude drafting → Gmail →
Sheets all in a single synchronous chain. This makes it impossible to insert approval gates
between steps. You cannot pause mid-call and ask the user if they like the contacts. The
entire pipeline must be split into discrete endpoints.

**Status:** Split into `/api/search`, `/api/enrich`, `/api/draft`, `/api/commit`.

### 2. No state machine on the frontend
The frontend has a boolean `loading` flag and a flat `leads` array. A multi-step flow
requires knowing *which step the user is on*. Without an explicit `step` enum, the UI
becomes a mess of conditional flags.

**Status:** Replaced with `step` enum + step progress bar.

### 3. Email enrichment runs automatically and silently
`people/match` is called automatically for every contact missing an email. The free Apollo
tier gives ~50 enrichments/month. With no user confirmation, a single search of 10 contacts
could consume 10 enrichments on contacts the user might reject anyway. Enrichment should
be a deliberate, opt-in step after the user reviews the raw results.

**Status:** Enrichment is now a separate `POST /api/enrich` call, triggered explicitly.

### 4. Claude runs before the user approves contacts
Currently Claude drafts an email for every contact returned, even ones the user might
discard. Each draft costs tokens. Drafting should only happen after the user approves a
final contact list.

**Status:** Draft step is now separate. Additionally, Claude is called **once per company**
(not once per contact) — the result is a template with `{first_name}` / `{title}`
placeholders that is applied per-contact at commit time.

### 5. No draft editing in the UI
Emails are shown in the results table but there is no way to edit them before committing
to Gmail. The UI needs editable draft fields.

**Status:** Draft step shows editable `<textarea>` per company.

### 6. No data persistence
All leads live in React component state. Refreshing the browser wipes everything.

**Status:** Not addressed yet. Future: localStorage or lightweight backend store.

### 7. YAMM is a dependency you do not control
The scheduled send step relies on YAMM, a Google Sheets add-on. Long-term,
Gmail's native scheduled send API is more reliable.

**Status:** Not addressed yet. YAMM is acceptable for now; see Step 9 below.

### 8. Hard-coded `GOOGLE_SHEET_ID` in .env
Every user writes to the same sheet. Fine for a shared team pipeline.

**Status:** Unchanged. Document this clearly so test runs don't pollute the shared sheet.

---

## Email Template Strategy

A single file `templates/outreach_template.txt` serves as the editable source of truth
for all outreach emails. **Edit this file directly in your text editor.**

- Supported placeholders: `{first_name}`, `{last_name}`, `{company}`, `{industry}`, `{title}`
- When `/api/draft` is called, Claude is invoked **once per unique company** to generate
  a company-tailored version of the template — the result still contains `{first_name}`
  so it can be applied to multiple contacts.
- Users review and edit the per-company draft in the UI (Step 7) before committing.

---

## Intended User Flow (Step by Step)

```
[0] Sign in with Google
      ↓
[1] Fill search form (company, domain, industry, target title, limit)
      ↓
[2] POST /api/search → Apollo mixed_people/search
      ↓
[3] Review raw contacts table — select / deselect
      ↓
[4] (Optional) Enrich emails → POST /api/enrich → Apollo people/match for contacts with no email
      ↓
[5] Approve final contact list → click "Generate Draft"
      ↓
[6] POST /api/draft → Claude generates ONE subject + body template per company
      ↓
[7] Review + edit draft inline in the UI (one editor per company)
      ↓
[8] Approve draft → POST /api/commit → Gmail drafts created + Sheets rows appended
      ↓
[9] Choose send schedule → (YAMM or Gmail scheduled send — TBD)
```

---

## Step 0 — Google Sign-In

**Who does it:** User, on first visit.
**What happens:** Google Identity Services (GIS) token client pops a consent screen.

| Scope | Why |
|---|---|
| `https://www.googleapis.com/auth/gmail.compose` | Create Gmail drafts |
| `https://www.googleapis.com/auth/spreadsheets` | Append rows to Google Sheet |
| `email` | Identify who is signed in |
| `profile` | Show name and avatar in the header |

After consent, GIS calls the callback with an `access_token`. The frontend fetches
`GET https://www.googleapis.com/oauth2/v3/userinfo` to get name/picture.

The `access_token` is stored in React state and sent as `Authorization: Bearer <token>`
on all subsequent backend calls.

**Engineering note:** GIS tokens expire after ~1 hour. No refresh logic exists yet. If a
user leaves the tab open and submits after expiration, calls will silently fail. The token
client needs to be re-invoked before expiry, or the backend should return a 401 that
prompts the frontend to trigger a silent re-auth.

---

## Step 1 — Search Form

| Field | Type | Validation | Notes |
|---|---|---|---|
| `company_name` | string | required | Display only, not sent to Apollo |
| `industry` | string | required | Passed to Claude for context |
| `website` | string | required | Stripped to bare domain before Apollo call |
| `target_title` | string | required | Becomes `person_titles[0]` in Apollo payload |
| `limit` | integer | 1–20, default 5 | Controls how many contacts to return |

**Domain normalisation (backend, `main.py`):**
Raw `website` is lowercased, stripped of `https://`, `http://`, `www.`, and trailing `/`.

---

## Step 2 — Apollo Search (`POST /api/search`)

### Apollo API Call — `mixed_people/search`

**URL:** `https://api.apollo.io/v1/mixed_people/search`
**Auth:** Header `X-Api-Key: <APOLLO_API_KEY>`

**Request:**
```json
{
  "organization_domains": ["stripe.com"],
  "person_titles": ["VP of Strategy"],
  "page": 1,
  "per_page": 15
}
```

**Response fields used:**

| Field path | Type | Notes |
|---|---|---|
| `response["people"]` | array | Main result list |
| `person["first_name"]` | string | May be null |
| `person["last_name"]` | string | May be null |
| `person["email"]` | string \| null | Null ~40–60% on free tier |
| `person["title"]` | string | Job title |
| `person["organization"]["name"]` | string | Company name |
| `person["organization"]["website_url"]` | string | Used for enrichment |
| `person["organization_name"]` | string | Fallback |
| `person["linkedin_url"]` | string | Not currently displayed |
| `person["id"]` | string | Apollo person ID |

**Returns to frontend:** All fields above + `has_email: bool`, `enriched: false`.
Does NOT trigger enrichment or Claude.

---

## Step 3 — Contact Review & Filter

**UI:** Table with checkbox per row (default: all checked).

Columns: Checkbox | Name | Title | Company | Email (or "— needs enrichment") | LinkedIn

**User actions:**
- Uncheck contacts to discard
- Click "Enrich" for contacts showing "— needs enrichment"
- Click "Generate Draft" when satisfied

---

## Step 4 — Email Enrichment (`POST /api/enrich`)

**When it runs:** Only when the user explicitly requests enrichment for specific contacts.

**Request:**
```json
{
  "contacts": [
    { "first_name": "Jane", "last_name": "Smith", "organization_name": "Stripe", "domain": "stripe.com" }
  ]
}
```

### Apollo API Call — `people/match`

**URL:** `https://api.apollo.io/v1/people/match`
**Auth:** Header `X-Api-Key: <APOLLO_API_KEY>`

```json
{
  "first_name": "Jane",
  "last_name": "Smith",
  "organization_name": "Stripe",
  "domain": "stripe.com",
  "reveal_personal_emails": false
}
```

**Rate limit awareness:** Free Apollo tier is ~50 `people/match` calls/month.

---

## Step 5 — Contact Approval

No API call. Pure frontend state transition: `step = 'drafting'`.

---

## Step 6 — Email Drafting (`POST /api/draft`)

Claude is called **once per unique company** (not once per contact).

**Request:**
```json
{
  "industry": "Fintech",
  "contacts": [
    { "first_name": "Jane", "last_name": "Smith", "email": "jane@stripe.com",
      "title": "VP of Strategy", "company": "Stripe" }
  ]
}
```

### Claude API Call

**Model:** `claude-sonnet-4-6`
**Max tokens:** 512

**System prompt:**
```
You are a business development representative for CMG Strategy Consulting,
a UC Berkeley student consulting club. You write concise, professional, and
personalized cold outreach emails to potential clients. Your emails are warm
but direct — never more than 150 words in the body. Always return valid JSON.
```

**User prompt:** Asks Claude to draft an email to `{company}` in `{industry}`, with
`{first_name}` and `{title}` as literal placeholders to be substituted per-contact later.

**Returns per company:**
```json
{
  "company": "Stripe",
  "subject": "Strategy partnership opportunity for Stripe",
  "body": "Hi {first_name}, ..."
}
```

The body retains `{first_name}` and `{title}` as placeholders, which are substituted at
commit time.

---

## Step 7 — Draft Review & Edit

One editor card per company:
- Subject line: editable `<input>`
- Body: editable `<textarea>` (with `{first_name}` visible so user understands it's a template)
- "Apply to N contacts" button

No API call. Frontend state only.

---

## Step 8 — Commit (`POST /api/commit`)

**Request:**
```json
{
  "google_token": "ya29.xxxx",
  "sheet_id": "1A2b3C...",
  "contacts": [
    { "first_name": "Jane", "last_name": "Smith", "email": "jane@stripe.com",
      "title": "VP of Strategy", "company": "Stripe",
      "subject": "...", "body": "Hi Jane, ..." }
  ]
}
```

Placeholders (`{first_name}`, `{title}`) are substituted per-contact before sending.

### Gmail API — creates draft per contact
### Google Sheets — appends row per contact

**YAMM columns (exact order):**

| Index | Column | Value |
|---|---|---|
| 0 | First Name | `contact.first_name` |
| 1 | Last Name | `contact.last_name` |
| 2 | Email | `contact.email` |
| 3 | Subject | `subject` |
| 4 | Body | `body` |
| 5 | Company | `contact.company` |
| 6 | Status | `"Draft"` |

---

## Step 9 — Schedule Send

**Current state:** Not implemented. Two options:

### Option A: YAMM (current plan)
After rows are in the Sheet, a team member opens the Sheet and runs YAMM.
- Manual; requires YAMM add-on per user
- YAMM free tier: 50 emails/day

### Option B: Gmail Scheduled Send API (recommended long-term)
`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send` with `deliveryTime`.
- No add-on; fully programmatic; requires only the existing `gmail.compose` scope.

---

## Backend Endpoints (Current)

| Endpoint | Does |
|---|---|
| `POST /api/search` | Apollo `mixed_people/search` only — returns raw contacts |
| `POST /api/enrich` | Apollo `people/match` for specified contacts |
| `POST /api/draft` | Claude email template generation — one call per unique company |
| `POST /api/commit` | Gmail draft creation + Sheets append per contact |
| `POST /api/leads` | Legacy all-in-one endpoint (kept for compatibility) |

---

## Frontend Step Enum

```javascript
type Step =
  | 'idle'        // form visible, no results
  | 'searching'   // waiting on /api/search
  | 'reviewing'   // user reviewing raw contacts
  | 'enriching'   // waiting on /api/enrich
  | 'approving'   // user approving final contact list
  | 'drafting'    // waiting on /api/draft
  | 'editing'     // user reviewing/editing drafts
  | 'committing'  // waiting on /api/commit
  | 'done'        // complete
```

---

## Data Models

### Apollo raw person (from `mixed_people/search`)
```json
{
  "id": "abc123",
  "first_name": "Jane",
  "last_name": "Smith",
  "title": "VP of Strategy",
  "email": "jane@stripe.com",
  "linkedin_url": "https://linkedin.com/in/janesmith",
  "organization": { "name": "Stripe", "website_url": "stripe.com" },
  "organization_name": "Stripe"
}
```

### `Contact` dataclass (`backend/apollo.py`)
```python
@dataclass
class Contact:
    first_name: str
    last_name: str
    email: str | None     # nullable until enriched
    title: str
    company: str
    domain: str           # for enrichment
    apollo_id: str        # for deduplication
    has_email: bool
    enriched: bool
```

### Draft object (frontend state)
```javascript
{
  company: string,
  subject: string,   // editable
  body: string,      // editable — contains {first_name} placeholder
  contacts: Contact[]
}
```

---

## Environment Variables

### Backend (`/.env`)
| Variable | Used in | Purpose |
|---|---|---|
| `APOLLO_API_KEY` | `apollo.py` | `X-Api-Key` header |
| `ANTHROPIC_API_KEY` | `claude_email.py` | `AsyncAnthropic(api_key=...)` |
| `GOOGLE_SHEET_ID` | `sheets.py` | `gc.open_by_key(sheet_id)` |
| `GOOGLE_CLIENT_ID` | docs only | Not read by backend |

### Frontend (`/frontend/.env`)
| Variable | Used in | Purpose |
|---|---|---|
| `VITE_GOOGLE_CLIENT_ID` | `App.jsx` | GIS `initTokenClient({ client_id })` |

---

## Open Questions

1. **Multi-title search:** Should the user target multiple titles in one search?
   Apollo supports `person_titles` as an array.

2. **Shared vs. per-user sheet:** Everyone writes to one team sheet right now. Make
   sheet ID a per-user setting?

3. **Draft regeneration:** Should edited drafts be manually edited only, or should there
   be a "Regenerate" button per company that re-calls Claude with the edits as context?

4. **YAMM vs. scheduled send:** Confirm whether to continue with YAMM or move to
   Gmail scheduled send API (no add-on required).

5. **Deduplication:** If the same person appears in multiple searches, block them from
   being added to the Sheet twice?

6. **Token expiry:** GIS tokens last ~1 hour. Silent re-auth vs. prompt to sign in again?

7. **Template file location:** `templates/outreach_template.txt` — should this be
   editable via the UI as well as from disk?
