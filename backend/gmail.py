import base64
import os
import re
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
from typing import Tuple

import httpx

_PDF_PATH = os.path.join(os.path.dirname(__file__), "[General] Spring 2026 PitchBook.pdf")


def _build_raw(to_email: str, subject: str, body: str) -> str:
    msg = MIMEMultipart()
    msg["to"] = to_email
    msg["subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    if os.path.exists(_PDF_PATH):
        with open(_PDF_PATH, "rb") as f:
            part = MIMEBase("application", "pdf")
            part.set_payload(f.read())
            encoders.encode_base64(part)
            part.add_header(
                "Content-Disposition",
                "attachment",
                filename="CMG Strategy Consulting — Spring 2026.pdf",
            )
            msg.attach(part)

    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


def schedule_send(
    to_email: str,
    subject: str,
    body: str,
    google_token: str,
    delivery_time: str,          # ISO 8601 UTC, e.g. "2026-04-01T09:00:00Z"
) -> str:
    """
    Schedule an email via a direct Gmail REST API call.
    Using httpx instead of the Google Python client to ensure deliveryTime
    is included in the request body without being stripped by schema validation.
    Returns the Gmail message ID.
    """
    # Strip milliseconds for clean RFC 3339 (e.g. "2026-04-01T09:00:00.000Z" → "2026-04-01T09:00:00Z")
    delivery_time = re.sub(r'\.\d+Z$', 'Z', delivery_time)

    with httpx.Client(timeout=30.0) as client:
        r = client.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {google_token}"},
            json={
                "raw": _build_raw(to_email, subject, body),
                "deliveryTime": delivery_time,
            },
        )

    r.raise_for_status()
    return r.json().get("id", "")


async def refresh_access_token(
    refresh_token: str,
    client_id: str,
    client_secret: str,
) -> Tuple[str, int]:
    """Exchange a refresh token for a new access token.
    Returns (access_token, expires_in)."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": client_id,
                "client_secret": client_secret,
            },
        )
    r.raise_for_status()
    data = r.json()
    return data["access_token"], int(data.get("expires_in", 3600))


async def send_email(
    to_email: str,
    subject: str,
    body: str,
    access_token: str,
) -> str:
    """Send an email immediately via Gmail REST API. Returns the Gmail message ID."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"raw": _build_raw(to_email, subject, body)},
        )
    r.raise_for_status()
    return r.json().get("id", "")
