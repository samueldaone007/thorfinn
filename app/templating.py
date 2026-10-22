"""Shared Jinja2 template engine.

`templates` is imported by every router that renders HTML pages.
"""

from fastapi.templating import Jinja2Templates

from .config import BASE_DIR

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
