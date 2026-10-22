"""Admin data API: create / edit / delete stops and links.

These endpoints power the admin map. Every endpoint:
  - requires a logged-in admin (session cookie),
  - requires a CSRF token (the client sends it as the X-CSRF-Token header,
    which is how we protect JSON calls that can't carry a form field),
  - returns JSON.

All input is validated and sanitised here. Fares are whole Naira amounts with
fare_min <= fare_max and both positive. Links are one-directional and the same
directed link with the same vehicle cannot exist twice.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..graph import invalidate as invalidate_graph
from ..models import Admin, Link, Suggestion, SuggestionGroup, Stop, utcnow
from ..security import get_current_admin, verify_csrf

router = APIRouter(tags=["admin-data"])

VEHICLES = {"bus", "car", "keke", "other"}
MAX_NAME_LEN = 200
MAX_FARE = 1_000_000  # sanity limit: nothing in Abuja costs more than this


# ---------------------------------------------------------------------------
# Request bodies (pydantic only checks types and basic ranges; the _check_*
# helpers below enforce the business rules and produce clear error messages).
# ---------------------------------------------------------------------------
class StopIn(BaseModel):
    name: str
    landmark: str | None = None
    area: str | None = None
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class StopPatch(BaseModel):
    name: str | None = None
    landmark: str | None = None
    area: str | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class LinkIn(BaseModel):
    from_stop_id: int
    to_stop_id: int
    vehicle: str
    fare_min: int
    fare_max: int
    reverse: bool = False
    reverse_fare_min: int | None = None
    reverse_fare_max: int | None = None


class LinkPatch(BaseModel):
    vehicle: str | None = None
    fare_min: int | None = None
    fare_max: int | None = None


# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------
def _require_admin(request: Request, db: Session = Depends(get_db)) -> Admin:
    """FastAPI dependency: rejects the request unless an admin is logged in."""
    admin = get_current_admin(request, db)
    if admin is None:
        raise HTTPException(status_code=401, detail="Not logged in.")
    return admin


def _check_csrf(request: Request) -> None:
    token = request.headers.get("x-csrf-token")
    verify_csrf(request, token)


def _clean_name(value: str) -> str:
    """Lower-level cleaning: collapse whitespace, require something real."""
    value = " ".join(value.split())
    if not value:
        raise HTTPException(status_code=400, detail="Name is required.")
    if len(value) > MAX_NAME_LEN:
        raise HTTPException(status_code=400, detail=f"Name is too long (max {MAX_NAME_LEN}).")
    return value


def _clean_optional(value: str | None) -> str | None:
    value = (value or "").strip()
    if not value:
        return None
    if len(value) > MAX_NAME_LEN:
        raise HTTPException(status_code=400, detail="Text is too long.")
    return value


def _check_vehicle(vehicle: str) -> str:
    value = (vehicle or "").strip().lower()
    if value not in VEHICLES:
        raise HTTPException(
            status_code=400,
            detail="Vehicle must be one of: bus, car, keke, other.",
        )
    return value


def _check_fares(fare_min: int | None, fare_max: int | None) -> None:
    if fare_min is None or fare_max is None:
        raise HTTPException(status_code=400, detail="Minimum and maximum fare are required.")
    if fare_min < 1:
        raise HTTPException(status_code=400, detail="Minimum fare must be positive.")
    if fare_max < fare_min:
        raise HTTPException(
            status_code=400, detail="Maximum fare cannot be less than minimum fare."
        )
    if fare_max > MAX_FARE:
        raise HTTPException(status_code=400, detail="That fare looks far too large.")


def _stop_json(stop: Stop) -> dict:
    return {
        "id": stop.id,
        "name": stop.name,
        "landmark": stop.landmark,
        "area": stop.area,
        "lat": stop.lat,
        "lng": stop.lng,
        "last_confirmed": stop.last_confirmed.isoformat() if stop.last_confirmed else None,
    }


def _link_json(link: Link) -> dict:
    return {
        "id": link.id,
        "from_stop_id": link.from_stop_id,
        "to_stop_id": link.to_stop_id,
        "vehicle": link.vehicle,
        "fare_min": link.fare_min,
        "fare_max": link.fare_max,
        "last_confirmed": (
            link.last_confirmed.isoformat() if link.last_confirmed else None
        ),
    }


def _link_exists(db: Session, from_id: int, to_id: int, vehicle: str) -> Link | None:
    return (
        db.query(Link)
        .filter(
            Link.from_stop_id == from_id,
            Link.to_stop_id == to_id,
            Link.vehicle == vehicle,
        )
        .first()
    )


# ---------------------------------------------------------------------------
# Stops
# ---------------------------------------------------------------------------
@router.get("/admin/api/stops")
def all_stops(
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    """All stops and all links - the whole admin map in one request."""
    _check_csrf(request)
    stops = db.query(Stop).order_by(Stop.name).all()
    links = db.query(Link).all()
    return {"stops": [_stop_json(s) for s in stops], "links": [_link_json(l) for l in links]}


@router.post("/admin/api/stops")
def create_stop(
    payload: StopIn,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    _check_csrf(request)
    stop = Stop(
        name=_clean_name(payload.name),
        landmark=_clean_optional(payload.landmark),
        area=_clean_optional(payload.area),
        lat=payload.lat,
        lng=payload.lng,
    )
    db.add(stop)
    db.commit()
    db.refresh(stop)
    invalidate_graph()
    return _stop_json(stop)


@router.patch("/admin/api/stops/{stop_id}")
def update_stop(
    stop_id: int,
    payload: StopPatch,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    _check_csrf(request)
    stop = db.get(Stop, stop_id)
    if stop is None:
        raise HTTPException(status_code=404, detail="Stop not found.")

    if payload.name is not None:
        stop.name = _clean_name(payload.name)
    if payload.landmark is not None:
        stop.landmark = _clean_optional(payload.landmark)
    if payload.area is not None:
        stop.area = _clean_optional(payload.area)
    if payload.lat is not None:
        stop.lat = payload.lat
    if payload.lng is not None:
        stop.lng = payload.lng

    # A close look at the data also re-confirms it.
    stop.last_confirmed = utcnow()

    db.commit()
    invalidate_graph()
    return _stop_json(stop)


@router.delete("/admin/api/stops/{stop_id}")
def delete_stop(
    stop_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    """Delete a stop and every link touching it (in either direction)."""
    _check_csrf(request)
    stop = db.get(Stop, stop_id)
    if stop is None:
        raise HTTPException(status_code=404, detail="Stop not found.")

    # Remove links explicitly so we don't depend on database cascade quirks.
    removed = (
        db.query(Link)
        .filter(or_(Link.from_stop_id == stop_id, Link.to_stop_id == stop_id))
        .delete(synchronize_session=False)
    )
    db.delete(stop)
    db.commit()
    invalidate_graph()
    return {"ok": True, "removed_links": removed}


# ---------------------------------------------------------------------------
# Links
# ---------------------------------------------------------------------------
@router.post("/admin/api/links")
def create_link(
    payload: LinkIn,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    _check_csrf(request)

    if payload.from_stop_id == payload.to_stop_id:
        raise HTTPException(status_code=400, detail="A link must connect two different stops.")

    from_stop = db.get(Stop, payload.from_stop_id)
    to_stop = db.get(Stop, payload.to_stop_id)
    if from_stop is None or to_stop is None:
        raise HTTPException(status_code=404, detail="One of the stops does not exist.")

    vehicle = _check_vehicle(payload.vehicle)
    _check_fares(payload.fare_min, payload.fare_max)

    if _link_exists(db, payload.from_stop_id, payload.to_stop_id, vehicle):
        raise HTTPException(
            status_code=409,
            detail="This link (same direction, same vehicle) already exists.",
        )

    link = Link(
        from_stop_id=payload.from_stop_id,
        to_stop_id=payload.to_stop_id,
        vehicle=vehicle,
        fare_min=payload.fare_min,
        fare_max=payload.fare_max,
    )
    db.add(link)
    created = [link]

    # Optional reverse: its own row (from B to A) with its own fares.
    reverse_link = None
    if payload.reverse:
        if payload.reverse_fare_min is None or payload.reverse_fare_max is None:
            raise HTTPException(
                status_code=400, detail="Provide fares for the reverse direction too."
            )
        _check_fares(payload.reverse_fare_min, payload.reverse_fare_max)
        if _link_exists(db, payload.to_stop_id, payload.from_stop_id, vehicle):
            raise HTTPException(
                status_code=409,
                detail="The reverse link already exists for this vehicle.",
            )
        reverse_link = Link(
            from_stop_id=payload.to_stop_id,
            to_stop_id=payload.from_stop_id,
            vehicle=vehicle,
            fare_min=payload.reverse_fare_min,
            fare_max=payload.reverse_fare_max,
        )
        db.add(reverse_link)
        created.append(reverse_link)

    db.commit()
    for item in created:
        db.refresh(item)
    invalidate_graph()
    return {
        "links": [_link_json(link), _link_json(reverse_link)] if reverse_link else [_link_json(link)]
    }


@router.patch("/admin/api/links/{link_id}")
def update_link(
    link_id: int,
    payload: LinkPatch,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    _check_csrf(request)
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Link not found.")

    vehicle = link.vehicle
    if payload.vehicle is not None:
        vehicle = _check_vehicle(payload.vehicle)
    fare_min = link.fare_min
    if payload.fare_min is not None:
        fare_min = payload.fare_min
    fare_max = link.fare_max
    if payload.fare_max is not None:
        fare_max = payload.fare_max
    _check_fares(fare_min, fare_max)

    # Changing the vehicle could collide with an existing directed link.
    if (vehicle != link.vehicle) and _link_exists(db, link.from_stop_id, link.to_stop_id, vehicle):
        raise HTTPException(
            status_code=409,
            detail="A link with that vehicle and direction already exists.",
        )

    link.vehicle = vehicle
    link.fare_min = fare_min
    link.fare_max = fare_max
    # Editing a link is also an implicit re-confirmation of it.
    link.last_confirmed = utcnow()
    db.commit()
    invalidate_graph()
    return _link_json(link)


@router.delete("/admin/api/links/{link_id}")
def delete_link(
    link_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    _check_csrf(request)
    link = db.get(Link, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="Link not found.")
    db.delete(link)
    db.commit()
    invalidate_graph()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Public suggestions (reviewed by the admin)
# ---------------------------------------------------------------------------
class SuggestionApproveIn(BaseModel):
    # Stop name used when approving. Blank = use the representative name.
    name: str | None = None


@router.get("/admin/api/suggestions")
def list_suggestions(
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    """Every suggestion group, newest first, for the review panel."""
    _check_csrf(request)
    groups = db.query(SuggestionGroup).order_by(SuggestionGroup.created_at.desc()).all()
    payload = []
    for group in groups:
        submissions = (
            db.query(Suggestion).filter(Suggestion.group_id == group.id).count()
        )
        payload.append({
            "id": group.id,
            "representative_name": group.representative_name,
            "centre_lat": group.centre_lat,
            "centre_lng": group.centre_lng,
            "distinct_user_count": group.distinct_user_count,
            "submission_count": submissions,
            "status": group.status,
            "created_at": (
                group.created_at.isoformat() if group.created_at else None
            ),
            "alerted_at": group.alerted_at.isoformat() if group.alerted_at else None,
        })
    return {"groups": payload}


@router.post("/admin/api/suggestions/{group_id}/approve")
def approve_suggestion(
    group_id: int,
    payload: SuggestionApproveIn,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    """Approve a suggestion group: create a real Stop at its centre."""
    _check_csrf(request)
    group = db.get(SuggestionGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Suggestion group not found.")
    if group.status not in ("pending", "alerted"):
        raise HTTPException(
            status_code=409, detail="This suggestion was already handled."
        )

    name = _clean_name((payload.name or "").strip() or group.representative_name or "")
    stop = Stop(name=name, lat=group.centre_lat, lng=group.centre_lng)
    db.add(stop)

    group.status = "approved"
    for suggestion in db.query(Suggestion).filter(Suggestion.group_id == group.id):
        suggestion.status = "approved"

    db.commit()
    db.refresh(stop)
    return _stop_json(stop)


@router.post("/admin/api/suggestions/{group_id}/reject")
def reject_suggestion(
    group_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    """Reject a suggestion group."""
    _check_csrf(request)
    group = db.get(SuggestionGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Suggestion group not found.")
    if group.status not in ("pending", "alerted"):
        raise HTTPException(
            status_code=409, detail="This suggestion was already handled."
        )

    group.status = "rejected"
    for suggestion in db.query(Suggestion).filter(Suggestion.group_id == group.id):
        suggestion.status = "rejected"

    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Verification (Step 7): mark the whole map as checked today
# ---------------------------------------------------------------------------
@router.post("/admin/api/verify-all")
def verify_all(
    request: Request,
    db: Session = Depends(get_db),
    _admin: Admin = Depends(_require_admin),
):
    """Re-confirm every stop and link as of right now."""
    _check_csrf(request)
    stops = db.query(Stop).all()
    links = db.query(Link).all()
    now = utcnow()
    for stop in stops:
        stop.last_confirmed = now
    for link in links:
        link.last_confirmed = now
    db.commit()
    invalidate_graph()
    return {"ok": True, "stops_verified": len(stops), "links_verified": len(links)}