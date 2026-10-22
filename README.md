# Thorfinn

A free and open-source journey planner for Abuja, Nigeria. No accounts for
visitors, honest fare ranges, and a route network that public feedback helps
keep accurate.

Built with FastAPI, SQLAlchemy, networkx and Leaflet.

## Features

- **Public route search** (`/search`) - cheapest vs fewest-changes routes
  between stops, per-leg vehicle options with fare ranges (e.g. bus ₦300-₦500).
- **Public map of stops** (`/map`) - every verified stop as a dot; tap a dot
  for its routes, or tap empty ground to **suggest a new stop**.
- **Anonymous feedback** - suggestions are grouped by location and counted by
  *distinct devices* (a random id in the browser only - no personal data).
- **Admin review** (`/admin/suggestions`) - approve a suggestion to create the
  stop, or reject it.
- **Admin map editor** (`/admin/map`) - click to add stops, click two stops to
  add a one-directional link with a fare range.
- **Verification** - every stop and link carries a `last_confirmed` date;
  "Mark map verified" re-confirms the whole map, and the public map flags
  items not re-checked within the freshness window as **may be outdated**.
- Links are strictly **one-way**: `A -> B` never implies `B -> A`.

## Quick start (development)

```bash
# 1. Create and activate a virtual environment
python -m venv .venv
.venv\Scripts\activate            # Windows
# source .venv/bin/activate       # Linux/macOS

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure the app
copy .env.example .env            # windows
# cp .env.example .env            # Linux/macOS
#   - change SECRET_KEY to a long random value
#   - leave DATABASE_URL as SQLite for development

# 4. Run it
python run.py
```

Open <http://127.0.0.1:8000>. The first admin is created at
<http://127.0.0.1:8000/admin/setup>.

## Try it with sample data

Load ~10 real Abuja stops and 10 one-way bus links that match the acceptance
tests:

```bash
python seed_demo.py           # loads only if the map is empty
python seed_demo.py --force   # wipes stops/links/suggestions first, then loads
```

Then check:

| Scenario | Expected |
| --- | --- |
| Search **Karu → Wuse** | Cheapest total **₦700 – ₦1,200** (via Nyanya, one change) |
| Search **Wuse → Karu** | "No route" (links are one-way) |
| `/map`, tap **Karu** → **Show routes here** | Red route Karu → Nyanya with arrowhead |
| `/map`, tap empty ground | "Suggest a new stop" card; approved via admin later |

## Project layout

```
app/
  main.py            FastAPI app, routers, startup
  config.py          Settings from .env
  database.py        SQLAlchemy engine / session
  models.py          Stops, Links, Suggestion groups, Admins, Settings
  graph.py           networkx route engine (cheapest / fewest changes)
  security.py        bcrypt + CSRF helpers
  routes/
    admin.py         setup / login / map / suggestions / settings pages
    admin_data.py    admin CRUD APIs (stops, links, suggestions, verify-all)
    public.py        public APIs (stops, links, routes, suggest) + pages
static/              CSS, JS (Leaflet map pages)
templates/           Jinja2 templates
seed_demo.py         sample data for acceptance tests
```

## Admin settings (`/admin/settings`)

- **Devices needed to alert** - distinct devices that must ask for the same
  stop before the admin is alerted (default 5).
- **Grouping radius (metres)** - how close two suggestions must be to count as
  the same stop (default 100 m).
- **Freshness window (days)** - stops/links not re-confirmed within this window
  are shown as "may be outdated" (default 90).

## Production notes

- Set a strong `SECRET_KEY` and `COOKIE_SECURE=true` behind HTTPS.
- SQLite is fine for evaluation. For hosting, set `DATABASE_URL` to PostgreSQL
  (see `.env.example`) - the models are portable.
- Map tiles are OpenStreetMap data subject to the
  [ODbL](https://www.openstreetmap.org/copyright).