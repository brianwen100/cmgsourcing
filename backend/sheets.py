import os

import gspread
from google.oauth2.credentials import Credentials

from apollo import Contact


def append_lead(contact: Contact, subject: str, body: str, google_token: str) -> None:
    sheet_id = os.getenv("GOOGLE_SHEET_ID")
    if not sheet_id:
        raise ValueError("GOOGLE_SHEET_ID must be set in .env")

    creds = Credentials(token=google_token)
    gc = gspread.Client(auth=creds)
    sheet = gc.open_by_key(sheet_id).sheet1

    row = [
        contact.first_name,
        contact.last_name,
        contact.email,
        subject,
        body,
        contact.company,
        "Draft",
    ]
    sheet.append_row(row, value_input_option="RAW")
