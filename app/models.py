"""Database tables.

We define the whole data model now (even tables used in later steps) so the
database schema stays stable while we build feature by feature.
"""

from datetime import datetime, timezone

from sqlalchemy import (
    CheckConstraint,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


def utcnow() -> datetime:
    """Current UTC time, WITHOUT a timezone marker.

    We deliberately strip the timezone info and store naive UTC values: SQLite
    has no timezone support and works cleanly with naive datetimes. Postgres
    (used later) should store these as timestamptz, which we can revisit in a
    small migration when we switch.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Stop(Base):
    """A verified transport stop / landmark shown on the public map."""

    __tablename__ = "stops"

    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False)
    landmark = Column(String(200))
    area = Column(String(120))
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    # When an admin (or a trusted confirmation) last verified this stop's data.
    last_confirmed = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    # passive_deletes=True lets the database handle ON DELETE CASCADE when a
    # stop is removed (Step 2), instead of SQLAlchemy trying to null the FKs.
    outgoing_links = relationship(
        "Link",
        foreign_keys="Link.from_stop_id",
        back_populates="from_stop",
        passive_deletes=True,
    )
    incoming_links = relationship(
        "Link",
        foreign_keys="Link.to_stop_id",
        back_populates="to_stop",
        passive_deletes=True,
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"<Stop id={self.id} name={self.name!r}>"


class Link(Base):
    """A one-directional connection from one stop to another.

    A link A -> B does NOT imply B -> A. The reverse direction is its own row,
    possibly with different fares and even a different vehicle.
    """

    __tablename__ = "links"

    id = Column(Integer, primary_key=True)
    from_stop_id = Column(
        Integer, ForeignKey("stops.id", ondelete="CASCADE"), nullable=False
    )
    to_stop_id = Column(
        Integer, ForeignKey("stops.id", ondelete="CASCADE"), nullable=False
    )
    # bus / car / keke / other
    vehicle = Column(String(20), nullable=False)
    # Fares are whole Naira amounts. Prices are ranges, never single values.
    fare_min = Column(Integer, nullable=False)
    fare_max = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_confirmed = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (
        # No two identical directed links with the same vehicle type.
        UniqueConstraint(
            "from_stop_id", "to_stop_id", "vehicle", name="uq_link_direction_vehicle"
        ),
        CheckConstraint("fare_min >= 0", name="ck_link_fare_min_non_negative"),
        CheckConstraint("fare_max >= fare_min", name="ck_link_fare_range_valid"),
    )

    from_stop = relationship(
        "Stop", foreign_keys=[from_stop_id], back_populates="outgoing_links"
    )
    to_stop = relationship(
        "Stop", foreign_keys=[to_stop_id], back_populates="incoming_links"
    )

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return (
            f"<Link {self.from_stop_id}->{self.to_stop_id} "
            f"{self.vehicle} {self.fare_min}-{self.fare_max}>"
        )


class SuggestionGroup(Base):
    """A cluster of similar user suggestions, counted by DISTINCT device ids."""

    __tablename__ = "suggestion_groups"

    id = Column(Integer, primary_key=True)
    centre_lat = Column(Float, nullable=False)
    centre_lng = Column(Float, nullable=False)
    representative_name = Column(String(200))
    # Number of distinct devices that suggested this stop. Triggers an alert.
    distinct_user_count = Column(Integer, default=0, nullable=False)
    # pending / alerted / approved / rejected / merged
    status = Column(String(20), default="pending", nullable=False)
    alerted_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    suggestions = relationship("Suggestion", back_populates="group")

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"<SuggestionGroup id={self.id} name={self.representative_name!r}>"


class Suggestion(Base):
    """A single anonymous suggestion submitted by one device."""

    __tablename__ = "suggestions"

    id = Column(Integer, primary_key=True)
    proposed_name = Column(String(200), nullable=False)
    lat = Column(Float, nullable=False)
    lng = Column(Float, nullable=False)
    # Random UUID kept in the browser. No accounts, no personal data.
    device_id = Column(String(64), nullable=False)
    group_id = Column(
        Integer, ForeignKey("suggestion_groups.id", ondelete="SET NULL"), nullable=True
    )
    # pending / alerted / approved / rejected / merged
    status = Column(String(20), default="pending", nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    group = relationship("SuggestionGroup", back_populates="suggestions")

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"<Suggestion id={self.id} name={self.proposed_name!r}>"


class Admin(Base):
    """An admin account. Passwords are stored only as bcrypt hashes."""

    __tablename__ = "admins"

    id = Column(Integer, primary_key=True)
    username = Column(String(80), unique=True, nullable=False)
    password_hash = Column(String(200), nullable=False)
    created_at = Column(DateTime(timezone=True), default=utcnow, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"<Admin id={self.id} username={self.username!r}>"


class Setting(Base):
    """Single-row table with tunable app settings (thresholds, radius, ...)."""

    __tablename__ = "settings"

    id = Column(Integer, primary_key=True)
    # How many DISTINCT devices must suggest a stop before we alert the admin.
    suggestion_threshold = Column(Integer, default=5, nullable=False)
    # How close (in metres) two suggestions must be to be grouped together.
    grouping_radius_meters = Column(Integer, default=100, nullable=False)
    # Information older than this many days is flagged "may be outdated".
    freshness_days = Column(Integer, default=90, nullable=False)

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return (
            f"<Setting threshold={self.suggestion_threshold} "
            f"radius={self.grouping_radius_meters} freshness={self.freshness_days}>"
        )
