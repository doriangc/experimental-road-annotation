"""HTTP API. Run with: uv run uvicorn annotator.api:app --reload"""

from __future__ import annotations

import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import crosssection, edits, export, geo, graph, imagery, migrations, osm, store, templates

MAX_AREA_KM2 = 4.0

app = FastAPI(title="Road centerline annotator")


class AreaCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    bbox: tuple[float, float, float, float]  # west, south, east, north (WGS84)
    imagery: str = imagery.DEFAULT


class InitRequest(BaseModel):
    type: str
    reset_ports: bool = False  # compute from the OSM port positions instead of the current ones


def _load(area_id: str) -> dict:
    try:
        state = store.load(area_id)
    except KeyError:
        raise HTTPException(404, f"no area {area_id!r}")
    if migrations.upgrade(state):
        with store.lock(area_id):
            store.save(state)
    return state


@app.get("/api/imagery")
def list_imagery():
    return {"default": imagery.DEFAULT, "sources": list(imagery.SOURCES.values())}


@app.get("/api/areas")
def list_areas():
    return [export.summary(_load(a)) for a in store.list_ids()]


@app.post("/api/areas")
def create_area(body: AreaCreate):
    west, south, east, north = body.bbox
    if not (west < east and south < north):
        raise HTTPException(400, "bbox must be [west, south, east, north]")
    if body.imagery not in imagery.SOURCES:
        raise HTTPException(400, f"unknown imagery {body.imagery!r}")
    epsg = geo.utm_epsg((west + east) / 2, (south + north) / 2)
    proj = geo.Projector(epsg)
    x0, y0 = proj.to_xy(west, south)
    x1, y1 = proj.to_xy(east, north)
    if (x1 - x0) * (y1 - y0) / 1e6 > MAX_AREA_KM2:
        raise HTTPException(400, f"area is larger than {MAX_AREA_KM2} km²; zoom in")

    try:
        raw = osm.fetch(body.bbox)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Overpass request failed: {e}")
    data = osm.parse(raw)
    if not data.ways:
        raise HTTPException(400, "no roads found in this area")

    state = graph.build(data, proj, body.bbox)
    area_id = store.new_area_id(body.name)
    state.update({
        "id": area_id, "name": body.name, "bbox": list(body.bbox), "epsg": epsg, "created": time.time(),
        "imagery": imagery.record(body.imagery),
    })
    with store.lock(area_id):
        store.save_osm(area_id, raw)
        store.save(state)
    return export.summary(state)


@app.get("/api/areas/{area_id}")
def get_area(area_id: str):
    return _load(area_id)


@app.post("/api/areas/{area_id}/edits")
def post_edits(area_id: str, body: dict):
    with store.lock(area_id):
        state = _load(area_id)
        try:
            new = edits.apply(state, body)
        except edits.EditError as e:
            raise HTTPException(400, str(e))
        store.save(new)
    changed = {
        "clusters": {c: new["clusters"][c] for c in body.get("clusters") or {}},
        "segments": {s: new["segments"][s] for s in body.get("segments") or {}},
        "ports": {p: new["ports"][p] for p in body.get("ports") or {}},
    }
    # Port moves also change their segment and cluster; return those too.
    for p in body.get("ports") or {}:
        port = new["ports"][p]
        changed["segments"][port["segment_id"]] = new["segments"][port["segment_id"]]
        changed["clusters"][port["cluster_id"]] = new["clusters"][port["cluster_id"]]
    return {"changed": changed, "summary": export.summary(new)}


@app.post("/api/areas/{area_id}/clusters/{cluster_id}/init")
def init_cluster(area_id: str, cluster_id: str, body: InitRequest):
    """Initial parameters for a template type, from OSM and the ports. Not saved."""
    state = _load(area_id)
    if cluster_id not in state["clusters"]:
        raise HTTPException(404, f"no cluster {cluster_id!r}")
    ports = {p: state["ports"][p] for p in state["clusters"][cluster_id]["port_ids"]}
    if body.reset_ports:
        for port in ports.values():
            port["xy"], port["heading"] = list(port["osm_xy"]), port["osm_heading"]
    try:
        params = templates.init_params(state, cluster_id, body.type)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {
        "type": body.type,
        "params": params,
        "ports": {p: {"xy": port["xy"], "heading": port["heading"]} for p, port in ports.items()},
    }


@app.post("/api/areas/{area_id}/segments/{segment_id}/default-cross-section")
def default_cross_section(area_id: str, segment_id: str):
    """The cross-section prefilled from OSM tags for the segment's current centerline. Not saved."""
    state = _load(area_id)
    seg = state["segments"].get(segment_id)
    if seg is None or seg["internal"]:
        raise HTTPException(404, f"no editable segment {segment_id!r}")
    return {"spans": crosssection.default_spans(seg)}


@app.get("/api/areas/{area_id}/export")
def export_area(area_id: str, slices: bool = False):
    state = _load(area_id)
    return export.geojson(state, state["params"]["slice_length"] if slices else None)


_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=_dist, html=True), name="frontend")
