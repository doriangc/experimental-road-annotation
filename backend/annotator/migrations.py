"""Upgrade area state saved by older versions of the tool."""

from __future__ import annotations

from . import crosssection, geo, graph, osm, store


def upgrade(state: dict) -> bool:
    """Bring `state` up to date in place. Returns True if anything changed."""
    changed = False
    segments = [s for s in state["segments"].values() if not s["internal"]]

    if any("osm_tags" not in s for s in state["segments"].values()):
        # Rebuild from the stored Overpass response. Segment ids are deterministic,
        # so the fresh build lines up with the saved one; check that before copying.
        fresh = graph.build(osm.parse(store.load_osm(state["id"])), geo.Projector(state["epsg"]), state["bbox"])
        for sid, seg in state["segments"].items():
            other = fresh["segments"].get(sid)
            if other is None or other["osm_node_ids"] != seg["osm_node_ids"]:
                raise RuntimeError(f"cannot upgrade area {state['id']}: segment {sid} no longer matches its OSM data")
            seg["osm_tags"] = other["osm_tags"]
            seg["osm_reversed"] = other["osm_reversed"]
        changed = True

    for seg in segments:
        if seg.get("spans") is None:
            seg["spans"] = crosssection.default_spans(seg)
            changed = True
    return changed
