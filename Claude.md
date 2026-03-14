# CMG Lead Gen Tool

Internal tool for CMG Strategy Consulting to automate client sourcing and outreach.

## Commands
- `uvicorn main:app --reload` — start backend
- `npm run dev` — start frontend
- `pip install -r requirements.txt` — install deps

## Architecture
- /backend — FastAPI app + API integrations
- /frontend — React dashboard
- .env — API keys (NEVER commit this)

## Key APIs
- Apollo.io REST API for contact + email search (/api/v1/mixed_people/search)
- Claude API (claude-sonnet-4-6) for personalized email drafting
- Google Sheets API v4 for data push

## Apollo Notes
- Use mixed_people/search for discovery, people/match for email enrichment
- Apollo returns linkedin_url, title, company, and email in one payload
- Respect rate limits: free tier is ~50 enrichments/month

## Important
- YAMM requires exact columns: First Name, Email, Subject, Body
- Google Sheets credentials in /backend/credentials.json (gitignored)
- Always check that email field is not null before pushing to sheet
```

---

## Updated Prompt for Claude Code

Here's the revised spec to paste in Plan Mode:
```
Build a full-stack lead generation tool for CMG Strategy Consulting.

## Goal
Pipeline: search for leads via Apollo.io → draft personalized email via 
Claude API → push to Google Sheets in YAMM format → send via YAMM.

## Tech Stack
- Backend: Python + FastAPI
- Frontend: React (simple dashboard with search form + leads table)
- APIs: Apollo.io (contact discovery + email enrichment), 
         Claude API (email drafting), Google Sheets API v4

## Core Features
1. Search form: company name, target title (e.g. "VP of Strategy"), industry
2. Apollo people search → return name, title, company, linkedin, email
3. For each result, call Apollo people/match to reveal email if not returned
4. Call Claude API to draft a short personalized cold email per lead
5. Push all leads + drafts to Google Sheet with YAMM columns:
   First Name | Last Name | Email | Subject | Body | Company | Status

## File Structure
/backend
  main.py          # FastAPI routes
  apollo.py        # Apollo API integration
  claude_email.py  # Email drafting via Claude API
  sheets.py        # Google Sheets push logic
/frontend
  App.jsx          # Dashboard
.env.example
CLAUDE.md

## Constraints
- Never hardcode API keys — use .env
- Use async/await throughout backend
- Validate that email is non-null before pushing to sheet
- Claude email drafts should reference the person's title + company specifically
