"""Export annotated centerlines as GeoJSON (spec.md, Stage 4 resampling)."""

from __future__ import annotations

from . import geo, templates


def summary(state: dict) -> dict:
    clusters = [c for c in state["clusters"].values() if not c["outside"]]
    inside = {c["id"] for c in clusters}
    segments = [
        s for s in state["segments"].values()
        if not s["internal"]
        and (state["ports"][s["start_port"]]["cluster_id"] in inside
             or state["ports"][s["end_port"]]["cluster_id"] in inside)
    ]
    return {
        "id": state["id"],
        "name": state["name"],
        "bbox": state["bbox"],
        "epsg": state["epsg"],
        "imagery": state["imagery"],
        "clusters": {"total": len(clusters), "done": sum(c["status"] == "done" for c in clusters)},
        "segments": {"total": len(segments), "done": sum(s["status"] == "done" for s in segments)},
    }


def geojson(state: dict, slice_length: float | None = None) -> dict:
    """Template curves and segment centerlines in lon/lat.

    With `slice_length`, every curve is resampled into slices of that length
    (the last slice of each curve covers the remainder).
    """
    proj = geo.Projector(state["epsg"])
    spacing = min(0.5, slice_length) if slice_length else 0.5

    def line(pts):
        if slice_length:
            pts = geo.resample(pts, slice_length)
        return {"type": "LineString", "coordinates": proj.to_lonlat_many(pts)}

    features = []
    for cid, cluster in state["clusters"].items():
        for i, curve in enumerate(templates.render(state, cid, spacing=spacing)):
            features.append({
                "type": "Feature",
                "geometry": line(curve["points"]),
                "properties": {
                    "kind": "template", "cluster_id": cid, "template": cluster["type"],
                    "curve": curve["kind"], "curve_index": i, "port_id": curve.get("port_id"),
                    "status": cluster["status"], "source": cluster["source"], "flags": cluster["flags"],
                },
            })
    for sid, seg in state["segments"].items():
        if seg["internal"]:
            continue
        features.append({
            "type": "Feature",
            "geometry": line(seg["centerline"]),
            "properties": {
                "kind": "segment", "segment_id": sid, "osm_way_ids": seg["osm_way_ids"],
                "highway": seg["highway"], "start_port": seg["start_port"], "end_port": seg["end_port"],
                "status": seg["status"], "source": seg["source"], "flags": seg["flags"],
                # bands left to right in the segment's direction (start_port -> end_port)
                "cross_section": seg["spans"],
            },
        })
    # Labels only hold for the imagery they were annotated on.
    return {"type": "FeatureCollection", "imagery": state["imagery"], "features": features}
