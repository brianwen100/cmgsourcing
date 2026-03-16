import base64
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

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
    Schedule an email to send at delivery_time via Gmail API.
    The email appears in the Scheduled folder — NOT in Drafts.
    Returns the Gmail message ID.
    """
    creds = Credentials(token=google_token)
    service = build("gmail", "v1", credentials=creds)

    result = service.users().messages().send(
        userId="me",
        body={
            "raw": _build_raw(to_email, subject, body),
            "deliveryTime": delivery_time,
        },
    ).execute()

    return result.get("id", "")
