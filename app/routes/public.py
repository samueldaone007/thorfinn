"""Public routes: reading stops, links and routes, and the search/map pages.

These endpoints need NO login - they are what the public journey planner
uses. They mostly READ data; the only writes are anonymous stop
suggestions (/api/suggest), which carry no personal information.
"""

import math
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..graph import find_route
from ..models import Link, Setting, Suggestion, SuggestionGroup, Stop, utcnow
from ..security import get_csrf_token, verify_csrf
from ..templating import templates

router = APIRouter(tags=["public"])


@router.get("/api/stops")
def public_stops(db: Session = Depends(get_db)):
    """All verified stops (name + id + freshness) for the public map."""
    stops = db.query(Stop).order_by(Stop.name).all()
    return {
        "stops": [
            {
                "id": s.id,
                "name": s.name,
                "area": s.area,
                "lat": s.lat,
                "lng": s.lng,
                "last_confirmed": (
                    s.last_confirmed.isoformat() if s.last_confirmed else None
                ),
                "outdated": _is_outdated(db, s.last_confirmed),
            }
            for s in stops
        ]
    }


@router.get("/api/links")
def public_links(db: Session = Depends(get_db)):
    """All links with stop names and freshness - the public route network."""
    links = db.query(Link).order_by(Link.from_stop_id, Link.to_stop_id).all()
    stops = {s.id: s for s in db.query(Stop).all()}
    network = []
    for link in links:
        from_stop = stops.get(link.from_stop_id)
        to_stop = stops.get(link.to_stop_id)
        if from_stop is None or to_stop is None:
            continue  # stops were deleted but the link somehow survived
        network.append({
            "id": link.id,
            "from_stop_id": link.from_stop_id,
            "to_stop_id": link.to_stop_id,
            "from_name": from_stop.name,
            "to_name": to_stop.name,
            "vehicle": link.vehicle,
            "fare_min": link.fare_min,
            "fare_max": link.fare_max,
            "last_confirmed": (
                link.last_confirmed.isoformat() if link.last_confirmed else None
            ),
            "outdated": _is_outdated(db, link.last_confirmed),
        })
    return {"links": network}


@router.get("/api/route")
def public_route(from_id: int, to_id: int, db: Session = Depends(get_db)):
    """Find routes between two stops.

    Query parameters:
      from_id  -> start stop id
      to_id    -> destination stop id

    Returns the cheapest route and the fewest-changes route, each with its
    legs, per-leg vehicle options, and fare totals. If the direction isn't
    serviced yet it returns no_route: true with a helpful message.
    """
    # FastAPI rejects bad types automatically; we just verify the ids exist.
    stop_ids = {s.id for s in db.query(Stop).all()}
    if from_id not in stop_ids:
        raise HTTPException(status_code=404, detail="Start stop not found.")
    if to_id not in stop_ids:
        raise HTTPException(status_code=404, detail="Destination stop not found.")

    try:
        return find_route(db, from_id, to_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


def _haversine_m(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    """Great-circle distance in metres between two coordinates."""
    from_rad = math.pi / 180
    d_lat = (b_lat - a_lat) * from_rad
    d_lng = (b_lng - a_lng) * from_rad
    s = (
        math.sin(d_lat / 2) ** 2
        + math.cos(a_lat * from_rad) * math.cos(b_lat * from_rad) * math.sin(d_lng / 2) ** 2
    )
    return 2 * 6371000 * math.asin(math.sqrt(s))


def _freshness_days(db: Session) -> int:
    row = db.query(Setting).order_by(Setting.id).first()
    days = row.freshness_days if row else 90
    return days if isinstance(days, int) and days > 0 else 90


def _is_outdated(db: Session, last_confirmed) -> bool:
    """True when information hasn't been re-confirmed within freshness_days."""
    if not last_confirmed:
        return True
    days = _freshness_days(db)
    return (utcnow() - last_confirmed).days > days


class SuggestIn(BaseModel):
    """One anonymous "please add a stop here" suggestion."""

    name: str | None = Field(default=None, max_length=200)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    # Random id the browser keeps for this device. No personal data.
    device_id: str | None = Field(default=None, max_length=64)


@router.post("/api/suggest")
def suggest_stop(payload: SuggestIn, request: Request, db: Session = Depends(get_db)):
    """Record a suggestion for a new stop, grouping nearby ones.

    Suggestions within ``grouping_radius_meters`` of an existing group are added
    to it (counting DISTINCT devices, not submissions). When the group reaches
    ``suggestion_threshold`` distinct devices it is flagged ``alerted`` so an
    admin knows to act on it (Step 6).
    """
    verify_csrf(request, request.headers.get("x-csrf-token"))

    name = " ".join((payload.name or "").split())[:200]
    if not name:
        name = "Unnamed stop"

    device_id = payload.device_id or ""
    if not device_id or any(not (c.isalnum() or c in "-_") for c in device_id):
        device_id = secrets.token_hex(16)

    row = db.query(Setting).order_by(Setting.id).first()
    radius = row.grouping_radius_meters if row else 100
    threshold = row.suggestion_threshold if row else 5

    # Already a verified stop within grouping distance? No suggestion needed.
    existing = None
    nearest = radius
    for stop in db.query(Stop):
        dist = _haversine_m(stop.lat, stop.lng, payload.lat, payload.lng)
        if dist <= nearest:
            nearest = dist
            existing = stop
    if existing is not None:
        return {
            "ok": True,
            "already_exists": True,
            "stop_id": existing.id,
            "stop_name": existing.name,
            "device_id": device_id,
        }

    group = None
    best = radius  # group only when strictly within the radius
    for candidate in db.query(SuggestionGroup).filter(
        SuggestionGroup.status.in_(["pending", "alerted"])
    ):
        dist = _haversine_m(
            candidate.centre_lat, candidate.centre_lng, payload.lat, payload.lng
        )
        if dist <= best:
            best = dist
            group = candidate

    alerted_new = False
    if group is None:
        group = SuggestionGroup(
            centre_lat=payload.lat,
            centre_lng=payload.lng,
            representative_name=name,
            distinct_user_count=1,
            status="pending",
        )
        db.add(group)
        db.flush()
    else:
        known = {
            did for (did,) in db.query(Suggestion.device_id).filter(
                Suggestion.group_id == group.id
            ).all()
        }
        if device_id not in known:
            group.distinct_user_count += 1
        if not group.representative_name:
            group.representative_name = name
        if group.distinct_user_count >= threshold and group.status == "pending":
            group.status = "alerted"
            group.alerted_at = utcnow()
            alerted_new = True

    suggestion = Suggestion(
        proposed_name=name,
        lat=payload.lat,
        lng=payload.lng,
        device_id=device_id,
        group_id=group.id,
        status=group.status,
    )
    db.add(suggestion)
    db.commit()
    db.refresh(group)
    db.refresh(suggestion)

    return {
        "ok": True,
        "group_id": group.id,
        "suggestion_id": suggestion.id,
        "distinct_user_count": group.distinct_user_count,
        "alerted": group.status == "alerted",
        "alerted_new": alerted_new,
        "device_id": device_id,
    }


@router.get("/search", response_class=HTMLResponse)
def search_page(request: Request):
    return templates.TemplateResponse(
        request,
        "public/search.html",
        {
            "center_lat": settings.abuja_lat,
            "center_lng": settings.abuja_lng,
        },
    )


@router.get("/map", response_class=HTMLResponse)
def map_page(request: Request):
    return templates.TemplateResponse(
        request,
        "public/map.html",
        {
            "csrf_token": get_csrf_token(request),
            "center_lat": settings.abuja_lat,
            "center_lng": settings.abuja_lng,
        },
    )