import base64
import os
from email.mime.text import MIMEText

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build


def create_draft(to_email: str, subject: str, body: str, google_token: str) -> str:
    """Create a Gmail draft in the signed-in user's account."""
    creds = Credentials(token=google_token)
    service = build("gmail", "v1", credentials=creds)

    message = MIMEText(body)
    message["to"] = to_email
    message["subject"] = subject
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode()

    draft = service.users().drafts().create(
        userId="me",
        body={"message": {"raw": raw}},
    ).execute()

    draft_id = draft.get("id", "")
    return f"https://mail.google.com/mail/#drafts/{draft_id}"
