"""Admin routes: first-run setup, login, logout and the (empty) admin map.

Step 1 covers authentication and an empty map. Later steps add the map
editing endpoints (stops, links) and the suggestion review tools.
"""

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import Admin, Setting, Stop, SuggestionGroup
from ..security import (
    get_csrf_token,
    get_current_admin,
    hash_password,
    verify_csrf,
    verify_password,
)
from ..templating import templates

router = APIRouter(tags=["admin"])


def _admin_count(db: Session) -> int:
    return db.query(Admin).count()


@router.get("/admin")
def admin_home(request: Request, db: Session = Depends(get_db)):
    """Send the visitor to the right page: setup, login or the map."""
    if _admin_count(db) == 0:
        return RedirectResponse(url="/admin/setup", status_code=303)
    if get_current_admin(request, db) is None:
        return RedirectResponse(url="/admin/login", status_code=303)
    return RedirectResponse(url="/admin/map", status_code=303)


@router.get("/admin/setup", response_class=HTMLResponse)
def setup_form(request: Request, db: Session = Depends(get_db)):
    """First-run page: create the very first admin account."""
    if _admin_count(db) > 0:
        # Setup is only available while no admin exists.
        return RedirectResponse(url="/admin/login", status_code=303)

    return templates.TemplateResponse(
        request,
        "admin/setup.html",
        {
            "csrf_token": get_csrf_token(request),
            "error": None,
            "username": "",
        },
    )


@router.post("/admin/setup", response_class=HTMLResponse)
def setup_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    password_confirm: str = Form(...),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
):
    verify_csrf(request, csrf_token)

    username = username.strip()
    error = None
    if _admin_count(db) > 0:
        return RedirectResponse(url="/admin/login", status_code=303)
    elif len(username) < 3:
        error = "Username must be at least 3 characters."
    elif len(password) < 8:
        error = "Password must be at least 8 characters."
    elif password != password_confirm:
        error = "The two passwords do not match."

    if error:
        return templates.TemplateResponse(
            request,
            "admin/setup.html",
            {
                "csrf_token": get_csrf_token(request),
                "error": error,
                "username": username,
            },
            status_code=400,
        )

    admin = Admin(username=username, password_hash=hash_password(password))
    db.add(admin)
    db.commit()
    db.refresh(admin)

    # Log the new admin straight in.
    request.session["admin_id"] = admin.id
    return RedirectResponse(url="/admin/map", status_code=303)


@router.get("/admin/login", response_class=HTMLResponse)
def login_form(request: Request, db: Session = Depends(get_db)):
    if _admin_count(db) == 0:
        return RedirectResponse(url="/admin/setup", status_code=303)
    if get_current_admin(request, db) is not None:
        return RedirectResponse(url="/admin/map", status_code=303)

    return templates.TemplateResponse(
        request,
        "admin/login.html",
        {
            "csrf_token": get_csrf_token(request),
            "error": None,
            "username": "",
        },
    )


@router.post("/admin/login", response_class=HTMLResponse)
def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
):
    verify_csrf(request, csrf_token)

    username = username.strip()
    admin = db.query(Admin).filter(Admin.username == username).first()
    if admin is None or not verify_password(password, admin.password_hash):
        # Deliberately vague message (do not reveal which part was wrong).
        return templates.TemplateResponse(
            request,
            "admin/login.html",
            {
                "csrf_token": get_csrf_token(request),
                "error": "Wrong username or password.",
                "username": username,
            },
            status_code=401,
        )

    request.session["admin_id"] = admin.id
    return RedirectResponse(url="/admin/map", status_code=303)


@router.post("/admin/logout")
def logout(request: Request, csrf_token: str = Form(...)):
    verify_csrf(request, csrf_token)
    request.session.clear()
    return RedirectResponse(url="/admin/login", status_code=303)


@router.get("/admin/map", response_class=HTMLResponse)
def admin_map(request: Request, db: Session = Depends(get_db)):
    """The admin dashboard with an (initially) empty map."""
    admin = get_current_admin(request, db)
    if admin is None:
        return RedirectResponse(url="/admin/login", status_code=303)

    stop_count = db.query(Stop).count()
    pending_count = (
        db.query(SuggestionGroup)
        .filter(SuggestionGroup.status.in_(["pending", "alerted"]))
        .count()
    )
    return templates.TemplateResponse(
        request,
        "admin/map.html",
        {
            "csrf_token": get_csrf_token(request),
            "admin_username": admin.username,
            "stop_count": stop_count,
            "pending_count": pending_count,
            "center_lat": settings.abuja_lat,
            "center_lng": settings.abuja_lng,
        },
    )


@router.get("/admin/suggestions", response_class=HTMLResponse)
def suggestions_page(request: Request, db: Session = Depends(get_db)):
    """Admin review panel for public stop suggestions."""
    admin = get_current_admin(request, db)
    if admin is None:
        return RedirectResponse(url="/admin/login", status_code=303)

    pending_count = (
        db.query(SuggestionGroup)
        .filter(SuggestionGroup.status.in_(["pending", "alerted"]))
        .count()
    )
    return templates.TemplateResponse(
        request,
        "admin/suggestions.html",
        {
            "csrf_token": get_csrf_token(request),
            "admin_username": admin.username,
            "pending_count": pending_count,
        },
    )


@router.get("/admin/settings", response_class=HTMLResponse)
def settings_page(request: Request, db: Session = Depends(get_db)):
    """Admin settings: suggestion grouping / alerts / freshness window."""
    admin = get_current_admin(request, db)
    if admin is None:
        return RedirectResponse(url="/admin/login", status_code=303)

    row = db.query(Setting).order_by(Setting.id).first()
    return templates.TemplateResponse(
        request,
        "admin/settings.html",
        {
            "csrf_token": get_csrf_token(request),
            "admin_username": admin.username,
            "suggestion_threshold": row.suggestion_threshold if row else 5,
            "grouping_radius_meters": row.grouping_radius_meters if row else 100,
            "freshness_days": row.freshness_days if row else 90,
            "saved": request.query_params.get("saved") == "1",
            "error": None,
        },
    )


@router.post("/admin/settings", response_class=HTMLResponse)
def settings_submit(
    request: Request,
    suggestion_threshold: int = Form(...),
    grouping_radius_meters: int = Form(...),
    freshness_days: int = Form(...),
    csrf_token: str = Form(...),
    db: Session = Depends(get_db),
):
    admin = get_current_admin(request, db)
    if admin is None:
        return RedirectResponse(url="/admin/login", status_code=303)
    verify_csrf(request, csrf_token)

    error = None
    if not (1 <= suggestion_threshold <= 1000):
        error = "Suggestion threshold must be between 1 and 1000 devices."
    elif not (10 <= grouping_radius_meters <= 5000):
        error = "Grouping radius must be between 10 and 5000 metres."
    elif not (1 <= freshness_days <= 3650):
        error = "Freshness window must be between 1 and 3650 days."

    row = db.query(Setting).order_by(Setting.id).first()
    if error or row is None:
        current = row
        return templates.TemplateResponse(
            request,
            "admin/settings.html",
            {
                "csrf_token": get_csrf_token(request),
                "admin_username": admin.username,
                "suggestion_threshold": (
                    suggestion_threshold if not error else (current.suggestion_threshold if current else 5)
                ),
                "grouping_radius_meters": (
                    grouping_radius_meters if not error else (current.grouping_radius_meters if current else 100)
                ),
                "freshness_days": (
                    freshness_days if not error else (current.freshness_days if current else 90)
                ),
                "saved": False,
                "error": error or "Settings row could not be loaded.",
            },
            status_code=400,
        )

    row.suggestion_threshold = suggestion_threshold
    row.grouping_radius_meters = grouping_radius_meters
    row.freshness_days = freshness_days
    db.commit()
    return RedirectResponse(url="/admin/settings?saved=1", status_code=303)