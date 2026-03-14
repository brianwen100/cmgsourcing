import json
import os
import re
from pathlib import Path

import anthropic

from apollo import Contact

TEMPLATE_PATH = Path(__file__).parent.parent / "templates" / "outreach_template.txt"

SYSTEM_PROMPT = (
    "You are a business development representative for CMG Strategy Consulting, "
    "a UC Berkeley student consulting club. You write concise, professional, and "
    "personalized cold outreach emails to potential clients. Your emails are warm "
    "but direct — never more than 150 words in the body. Always return valid JSON."
)


def _read_template() -> str:
    """Return the outreach template with comment lines stripped."""
    if not TEMPLATE_PATH.exists():
        return ""
    lines = TEMPLATE_PATH.read_text().splitlines()
    return "\n".join(l for l in lines if not l.startswith("#")).strip()


def _parse_template(raw: str) -> tuple[str, str]:
    """Split template text into (subject, body)."""
    subject = ""
    body_lines: list[str] = []
    in_body = False

    for line in raw.splitlines():
        if line.upper().startswith("SUBJECT:"):
            subject = line[len("SUBJECT:"):].strip()
        elif line.upper().startswith("BODY:"):
            in_body = True
        elif in_body:
            body_lines.append(line)

    return subject, "\n".join(body_lines).strip()


def _substitute(text: str, contact: Contact, industry: str) -> str:
    return (
        text
        .replace("{first_name}", contact.first_name)
        .replace("{last_name}", contact.last_name)
        .replace("{company}", contact.company)
        .replace("{industry}", industry)
        .replace("{title}", contact.title)
    )


async def draft_company_email(company: str, industry: str, target_title: str) -> dict:
    """
    Call Claude ONCE for a company.

    Returns {"subject": str, "body": str} where the body retains
    {first_name} and {title} as per-contact substitution placeholders.

    If templates/outreach_template.txt contains a [COMPANY_CONTEXT] marker,
    Claude fills only that section. Otherwise Claude writes the entire email.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not configured")

    template_raw = _read_template()
    has_context_marker = "[COMPANY_CONTEXT]" in template_raw

    if has_context_marker:
        subj_tmpl, body_tmpl = _parse_template(template_raw)
        user_prompt = f"""Write a 2–3 sentence company-specific paragraph for the [COMPANY_CONTEXT] section of a cold outreach email targeting {company} in the {industry} industry. The paragraph should:
- Reference something specific and credible about {company}'s work in {industry}
- Connect it naturally to what CMG Strategy Consulting (a UC Berkeley student club) can offer: market research, go-to-market strategy, or competitive analysis

Return ONLY a JSON object:
{{
  "company_context": "<2-3 sentence paragraph, plain text>"
}}"""

        client = anthropic.AsyncAnthropic(api_key=api_key)
        message = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=256,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        raw = _strip_fences(message.content[0].text)
        parsed = json.loads(raw)
        context_paragraph = parsed["company_context"]

        filled_body = body_tmpl.replace("[COMPANY_CONTEXT]", context_paragraph)
        filled_subject = subj_tmpl.replace("{company}", company)
        return {"subject": filled_subject, "body": filled_body}

    else:
        # No template marker — Claude writes the full email with placeholders
        user_prompt = f"""Draft a cold outreach email on behalf of CMG Strategy Consulting (a UC Berkeley student consulting club) targeting {target_title}s at {company}, which operates in the {industry} industry.

Requirements:
- Open with a personalized line about {company} and {industry}
- Introduce CMG and our value: market research, go-to-market strategy, competitive analysis
- CTA: 20-minute intro call
- Use {{first_name}} as the literal placeholder for the recipient's first name
- Use {{title}} as the literal placeholder for the recipient's job title
- Keep body under 150 words

Return ONLY:
{{
  "subject": "<subject line mentioning {company}>",
  "body": "<email body with {{{{first_name}}}} and {{{{title}}}} placeholders, plain text>"
}}"""

        client = anthropic.AsyncAnthropic(api_key=api_key)
        message = await client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=512,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_prompt}],
        )
        raw = _strip_fences(message.content[0].text)
        parsed = json.loads(raw)
        return {"subject": parsed["subject"], "body": parsed["body"]}


def apply_template(subject_tmpl: str, body_tmpl: str, contact: Contact, industry: str) -> dict:
    """Substitute per-contact placeholders into a company-level draft template."""
    return {
        "subject": _substitute(subject_tmpl, contact, industry),
        "body": _substitute(body_tmpl, contact, industry),
    }


def _strip_fences(text: str) -> str:
    text = text.strip()
    text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
    text = re.sub(r"\n?```$", "", text)
    return text.strip()


# ── Legacy helper kept for /api/leads backward compat ─────────────────────────

async def draft_email(contact: Contact, industry: str) -> dict:
    """Legacy: generate one email per contact via Claude. Kept for /api/leads."""
    result = await draft_company_email(contact.company, industry, contact.title)
    return apply_template(result["subject"], result["body"], contact, industry)
