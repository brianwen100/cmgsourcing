import base64
from email.mime.text import MIMEText

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


def _build_raw(to_email: str, subject: str, body: str) -> str:
    message = MIMEText(body)
    message["to"] = to_email
    message["subject"] = subject
    return base64.urlsafe_b64encode(message.as_bytes()).decode()


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
