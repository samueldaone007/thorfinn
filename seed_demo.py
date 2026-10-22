"""Load a small realistic network so the acceptance tests run.

This is DEV/TEST data only - it inserts stops and links directly into the
database, bypassing the admin UI.

  python seed_demo.py          # load only if the map is empty
  python seed_demo.py --force  # wipe existing stops/links/suggestions first

The demo network matches the acceptance criteria:
  Karu -> Nyanya           Bus  N300-N500
  Nyanya -> Wuse           Bus  N400-N700
  Karu -> Wuse             cheapest total N700-N1200 (via Nyanya)
  Wuse -> Karu             no route (links are one-way, this way only)
"""

import sys

from app.database import SessionLocal
from app.models import Link, Stop, Suggestion, SuggestionGroup

# (name, area, lat, lng)
STOPS = [
    ("Karu", "Karu / Iddo", 8.9837, 7.5732),
    ("Nyanya", "Nyanya", 8.9936, 7.5189),
    ("Jabi", "Jabi", 9.0778, 7.4634),
    ("Utako", "Utako", 9.0816, 7.4410),
    ("Central Area", "Central Area", 9.0540, 7.4920),
    ("Asokoro", "Asokoro", 9.0416, 7.4994),
    ("Garki", "Garki", 9.0074, 7.4407),
    ("Wuse", "Wuse", 9.0800, 7.4922),
    ("Maitama", "Maitama", 9.0954, 7.5181),
    ("Apo", "Apo", 8.9867, 7.5145),
]

# (from, to, vehicle, fare_min, fare_max)
LINKS = [
    ("Karu", "Nyanya", "bus", 300, 500),
    ("Nyanya", "Wuse", "bus", 400, 700),
    ("Wuse", "Central Area", "bus", 250, 400),
    ("Central Area", "Asokoro", "bus", 200, 300),
    ("Central Area", "Garki", "bus", 150, 250),
    ("Apo", "Garki", "bus", 200, 300),
    ("Garki", "Wuse", "bus", 150, 250),
    ("Jabi", "Utako", "bus", 250, 350),
    ("Utako", "Wuse", "bus", 200, 300),
    ("Maitama", "Wuse", "bus", 200, 300),
]


def main() -> None:
    force = "--force" in sys.argv

    db = SessionLocal()
    try:
        stop_count = db.query(Stop).count()
        if stop_count:
            if not force:
                print(f"Map already has {stop_count} stop(s) - nothing to do.")
                print("Use:  python seed_demo.py --force   to wipe and reload.")
                return
            db.query(Suggestion).delete(synchronize_session=False)
            db.query(SuggestionGroup).delete(synchronize_session=False)
            db.query(Link).delete(synchronize_session=False)
            db.query(Stop).delete(synchronize_session=False)

        by_name = {}
        for name, area, lat, lng in STOPS:
            stop = Stop(name=name, area=area, lat=lat, lng=lng)
            db.add(stop)
            db.flush()
            by_name[name] = stop

        created_links = 0
        for frm, to, vehicle, fmin, fmax in LINKS:
            if frm not in by_name or to not in by_name:
                print(f"Skipping link {frm}->{to}: a stop is missing.")
                continue
            db.add(
                Link(
                    from_stop_id=by_name[frm].id,
                    to_stop_id=by_name[to].id,
                    vehicle=vehicle,
                    fare_min=fmin,
                    fare_max=fmax,
                )
            )
            created_links += 1

        db.commit()
        print(f"Loaded {len(STOPS)} stops and {created_links} links.")
        print("Try: Karu -> Wuse  (expect N700-N1200),  Wuse -> Karu  (no route).")
    finally:
        db.close()


if __name__ == "__main__":
    main()