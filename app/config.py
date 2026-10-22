"""Application settings.

All values come from environment variables, optionally provided via a `.env`
file in the project root. This keeps secrets out of the source code.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Project root = the folder that contains the "app" package.
BASE_DIR = Path(__file__).resolve().parent.parent

# Load variables from .env into os.environ (does nothing if the file is absent).
load_dotenv(BASE_DIR / ".env")


def _as_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Settings:
    def __init__(self) -> None:
        # Database. SQLAlchemy connection string. SQLite by default.
        self.database_url: str = os.getenv("DATABASE_URL", "sqlite:///./thorfinn.db")

        # Security.
        self.secret_key: str = os.getenv("SECRET_KEY", "dev-insecure-change-me")
        self.cookie_secure: bool = _as_bool(os.getenv("COOKIE_SECURE", "false"))
        self.session_max_age: int = int(os.getenv("SESSION_MAX_AGE", str(60 * 60 * 24 * 7)))

        # Map defaults (Abuja city centre).
        self.abuja_lat: float = float(os.getenv("ABUJA_LAT", "9.0579"))
        self.abuja_lng: float = float(os.getenv("ABUJA_LNG", "7.4951"))

    @property
    def secret_key_is_default(self) -> bool:
        """True if the operator forgot to change SECRET_KEY (we warn about it)."""
        return self.secret_key == "dev-insecure-change-me"


settings = Settings()
