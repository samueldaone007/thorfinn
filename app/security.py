"""Security helpers: password hashing, CSRF tokens and admin lookup."""

import secrets

import bcrypt
from fastapi import HTTPException, Request
from sqlalchemy.orm import Session

from .models import Admin


def hash_password(password: str) -> str:
    """Return a bcrypt hash (a safe one-way representation) of a password."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """Check a plain password against a stored bcrypt hash."""
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        # Malformed hash in the database - treat as a failed login.
        return False


def get_csrf_token(request: Request) -> str:
    """Return this session's CSRF token, creating it on first use.

    A CSRF token is a random value put into the page's forms. Because a hostile
    site cannot read it, it cannot forge a valid POST to our admin routes.
    """
    token = request.session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        request.session["csrf_token"] = token
    return token


def verify_csrf(request: Request, submitted_token: str | None) -> None:
    """Raise 400 if the submitted token does not match the session token."""
    expected = request.session.get("csrf_token")
    if not expected or not submitted_token or not secrets.compare_digest(
        expected, submitted_token
    ):
        raise HTTPException(status_code=400, detail="Invalid or missing CSRF token.")


def get_current_admin(request: Request, db: Session) -> Admin | None:
    """Return the logged-in admin (or None)."""
    admin_id = request.session.get("admin_id")
    if not admin_id:
        return None
    return db.get(Admin, admin_id)
