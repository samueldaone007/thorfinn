"""Builds the FastAPI application and wires the pieces together."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .config import BASE_DIR, settings
from .database import Base, SessionLocal, engine
from .models import Setting
from .routes import admin, admin_data, public

logger = logging.getLogger("thorfinn")


def ensure_default_settings() -> None:
    """Create the single settings row on first run."""
    db = SessionLocal()
    try:
        if db.query(Setting).first() is None:
            db.add(Setting())
            db.commit()
            logger.info("Created default settings row.")
    finally:
        db.close()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Create any missing tables on startup (safe to run every time).
    Base.metadata.create_all(bind=engine)
    ensure_default_settings()

    if settings.secret_key_is_default:
        logger.warning(
            "SECRET_KEY is still the insecure default. "
            "Set a strong SECRET_KEY in your .env before deploying."
        )
    yield


app = FastAPI(title="Thorfinn", lifespan=lifespan)

# Signed cookie sessions. httponly/same_site are set by the middleware defaults;
# we explicitly pass the security-relevant options.
app.add_middleware(
    SessionMiddleware,
    secret_key=settings.secret_key,
    session_cookie="thorfinn_session",
    max_age=settings.session_max_age,
    same_site="lax",
    https_only=settings.cookie_secure,
)

# Static files (CSS, JS, images).
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Routers.
app.include_router(admin.router)
app.include_router(admin_data.router)
app.include_router(public.router)

# Serve the default favicon so browsers don't 404 on it.
@app.get("/favicon.ico")
def favicon():
    from fastapi.responses import Response
    return Response(content=b"", media_type="image/x-icon")


@app.get("/")
def root():
    # The public journey planner is the front door of the app.
    return RedirectResponse(url="/search", status_code=303)
