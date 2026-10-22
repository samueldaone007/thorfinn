"""Database engine, session factory and the declarative Base.

Switching from SQLite to PostgreSQL later only requires changing DATABASE_URL
in the .env file. The rest of the code stays the same because we always go
through SQLAlchemy.
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import settings

# SQLite needs this flag because FastAPI handles requests across threads.
connect_args = {}
if settings.database_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    future=True,
    # For SQLite we want foreign-key rules (like ON DELETE CASCADE) enforced.
    echo=False,
)

# Keep FK enforcement on for SQLite connections.
if settings.database_url.startswith("sqlite"):
    from sqlalchemy import event

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, _record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


class Base(DeclarativeBase):
    """Base class every model inherits from."""


SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
    expire_on_commit=False,
)


def get_db():
    """FastAPI dependency: yields a database session and closes it afterwards."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
