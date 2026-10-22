"""Route planning engine built on networkx.

The `links` table is loaded into a networkx MultiDiGraph:
  - one node per stop,
  - one edge per link row, tagged with vehicle, fares and last_confirmed,
  - edge weight = average of fare_min and fare_max (used for "cheapest").

Because the data is small we don't keep a complex incremental cache. Instead
`admin_data.py` calls `invalidate()` after every stop/link change, and the
graph is rebuilt lazily on the next route request (cheap for our size).

Routing offers:
  cheapest        -> shortest path using the fare-based edge weight (Dijkstra)
  fewest changes  -> shortest path by number of legs (unweighted BFS)

Only links in their STORED direction are followed: an edge A->B never implies
B->A. When several vehicle types exist on the same directed pair, the graph
keeps one parallel edge per vehicle and the response lists them as options,
with the cheapest-average vehicle listed first.
"""

import networkx as nx
from sqlalchemy.orm import Session

from .models import Link, Stop

_graph_version = 0
_cache: dict = {
    "version": -1,   # the version _cache["graph"] was built against
    "graph": None,
    "stops": {},     # stop id -> Stop ORM object
    "leg_options": {},  # (from_id, to_id) -> list of vehicle option dicts
}


def invalidate() -> None:
    """Call after any stop or link change so the graph rebuilds lazily."""
    global _graph_version
    _graph_version += 1


def _build(db: Session) -> None:
    """(Re)build the graph from the current stop and link tables."""
    stops = db.query(Stop).all()
    links = db.query(Link).all()

    stop_map = {s.id: s for s in stops}
    graph = nx.MultiDiGraph()

    for s in stops:
        graph.add_node(s.id)

    options: dict = {}
    for link in links:
        from_id, to_id = link.from_stop_id, link.to_stop_id
        if from_id not in stop_map or to_id not in stop_map:
            continue  # defensive: skip links pointing at missing stops
        graph.add_edge(
            from_id,
            to_id,
            key=link.vehicle,
            vehicle=link.vehicle,
            fare_min=link.fare_min,
            fare_max=link.fare_max,
            last_confirmed=link.last_confirmed,
            weight=(link.fare_min + link.fare_max) / 2.0,
        )
        options.setdefault((from_id, to_id), []).append(
            {
                "vehicle": link.vehicle,
                "fare_min": link.fare_min,
                "fare_max": link.fare_max,
                "last_confirmed": (
                    link.last_confirmed.isoformat() if link.last_confirmed else None
                ),
            }
        )

    global _cache
    _cache = {
        "version": _graph_version,
        "graph": graph,
        "stops": stop_map,
        "leg_options": options,
    }


def _ensure_built(db: Session) -> None:
    # NoSql races matter here: the version counter is monotonic in this
    # process, and any mutation bumps it before a route search can run.
    if _cache["version"] != _graph_version:
        _build(db)


def _stop_dict(stop: Stop) -> dict:
    return {
        "id": stop.id,
        "name": stop.name,
        "area": stop.area,
        "lat": stop.lat,
        "lng": stop.lng,
    }


def _legs_from_path(path: list[int]) -> list[dict]:
    """Turn a node path into ['leg' dicts], each with all vehicle options.

    The primary option (what totals are computed from) is the vehicle whose
    average fare is lowest among the parallel edges on that leg.
    """
    options = _cache["leg_options"]
    stops = _cache["stops"]
    legs = []
    for i in range(len(path) - 1):
        a, b = path[i], path[i + 1]
        opts = options.get((a, b)) or []
        opts = sorted(opts, key=lambda o: (o["fare_min"] + o["fare_max"]) / 2.0)
        if not opts:
            continue
        legs.append(
            {
                "from": _stop_dict(stops[a]),
                "to": _stop_dict(stops[b]),
                "options": opts,
                "primary": opts[0],
            }
        )
    return legs


def _totals(legs: list[dict]) -> tuple[int, int]:
    total_min = sum(leg["primary"]["fare_min"] for leg in legs)
    total_max = sum(leg["primary"]["fare_max"] for leg in legs)
    return total_min, total_max


def _route_for(graph: nx.MultiDiGraph, from_id: int, to_id: int, weight: str | None):
    try:
        path = nx.shortest_path(graph, source=from_id, target=to_id, weight=weight)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return None
    if len(path) < 2:
        return None
    legs = _legs_from_path(path)
    if not legs:
        return None
    total_min, total_max = _totals(legs)
    return {
        "legs": legs,
        "total_min": total_min,
        "total_max": total_max,
        "changes": len(legs) - 1,  # number of vehicle changes between legs
    }


def find_route(db: Session, from_id: int, to_id: int) -> dict:
    """Return the cheapest and the fewest-changes route (or no_route info)."""
    _ensure_built(db)
    graph = _cache["graph"]
    stops = _cache["stops"]

    out_from = _stop_dict(stops[from_id]) if from_id in stops else None
    out_to = _stop_dict(stops[to_id]) if to_id in stops else None
    if out_from is None or out_to is None:
        raise ValueError("Unknown stop id passed to route engine.")

    if from_id == to_id:
        return {
            "from": out_from,
            "to": out_to,
            "no_route": True,
            "message": "Start and destination are the same stop.",
        }

    cheapest = _route_for(graph, from_id, to_id, weight="weight")
    fewest = _route_for(graph, from_id, to_id, weight=None)

    if cheapest is None:
        return {
            "from": out_from,
            "to": out_to,
            "no_route": True,
            "message": (
                "No route found yet in that direction. The network is built "
                "from verified one-way links, so the reverse direction may not "
                "exist yet. If you think a stop is missing, please suggest it "
                "so an admin can add it."
            ),
        }

    return {
        "from": out_from,
        "to": out_to,
        "no_route": False,
        "cheapest": cheapest,
        "fewest_changes": fewest,
    }