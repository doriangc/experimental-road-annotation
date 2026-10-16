"""Intersection templates (spec.md, Templates).

OSM fixes the topology (which ports a cluster has); a template's parameters fix
the geometry. Arm curves inside a cut-out are cubic Béziers from the core
(tangent `theta`) to the port (tangent = port heading). The frontend mirrors
`render` in frontend/src/geom.ts; keep the two in step.

Parameters, all metric in the area CRS:

    point      {center, arms: [{port_id, theta}]}          theta = direction leaving the centre
    roundabout {center, radius, arms: [{port_id, theta}]}  theta = angle of the attachment point on the ring
    dead_end   {end, turn_radius, arms: [{port_id, theta}]} theta = direction leaving the end point
    freeform   {nodes: {id: xy}, edges: [{from, to, interior: [xy]}]}
               node ids are "j:<junction>" or "port:<port id>"; port nodes follow their port
"""

from __future__ import annotations

import math

import numpy as np

from . import geo

TYPES = ("point", "roundabout", "dead_end", "freeform")
ARM_DIRECTION_SAMPLE = 3.0  # metres along OSM used to estimate an arm's direction at a junction


def valid_types(cluster: dict) -> list[str]:
    n = len(cluster["port_ids"])
    types = []
    if n >= 2:
        types.append("point")
    if n >= 1:
        types.append("roundabout")
    if n == 1:
        types.append("dead_end")
    types.append("freeform")
    return types


def default_type(cluster: dict) -> str:
    valid = valid_types(cluster)
    if cluster["roundabout"] and "roundabout" in valid:
        return "roundabout"
    if cluster["dead_end"] and "dead_end" in valid:
        return "dead_end"
    if len(cluster["junction_ids"]) == 1 and "point" in valid:
        return "point"
    # Multi-junction clusters (staggered junctions, dual carriageway crossings)
    # wait for the `staggered` template and dual-carriageway arms.
    return "freeform"


def sort_ports(state: dict, cid: str, center: np.ndarray) -> list[str]:
    """Port ids in circular (counter-clockwise) order around `center`."""
    pids = state["clusters"][cid]["port_ids"]
    return sorted(pids, key=lambda p: geo.angle_of(np.array(state["ports"][p]["xy"]) - center))


def _junction_xy(state: dict, jid: str) -> np.ndarray:
    return np.array(state["junctions"][jid]["osm_xy"])


def _osm_arm_direction(state: dict, pid: str) -> np.ndarray:
    """Direction the port's OSM segment leaves its junction."""
    port = state["ports"][pid]
    seg = state["segments"][port["segment_id"]]
    dist = min(ARM_DIRECTION_SAMPLE, port["offset"])
    return geo.direction_from_end(seg["osm_polyline"], port["end"] == "start", dist)


def init_params(state: dict, cid: str, type_: str) -> dict:
    """Initial template parameters from OSM and the current port positions."""
    cluster = state["clusters"][cid]
    if type_ not in valid_types(cluster):
        raise ValueError(f"type {type_!r} is not valid for cluster {cid} with {len(cluster['port_ids'])} ports")
    jids = cluster["junction_ids"]
    pids = cluster["port_ids"]
    ports = state["ports"]
    centroid = np.mean([_junction_xy(state, j) for j in jids], axis=0)

    if type_ == "point":
        if len(jids) == 1:
            center = _junction_xy(state, jids[0])
            thetas = [geo.angle_of(_osm_arm_direction(state, p)) for p in pids]
        else:
            center = centroid
            thetas = [geo.angle_of(np.array(ports[p]["xy"]) - center) for p in pids]
        return {
            "center": center.tolist(),
            "arms": [{"port_id": p, "theta": t} for p, t in zip(pids, thetas)],
        }

    if type_ == "roundabout":
        ring = [
            geo.resample(state["segments"][s]["osm_polyline"], 1.0)
            for s in cluster["internal_segment_ids"]
            if state["segments"][s]["roundabout"]
        ]
        if ring:
            pts = np.vstack(ring)
            center = pts.mean(axis=0)
            radius = float(np.linalg.norm(pts - center, axis=1).mean())
        else:
            center = centroid
            radius = max(8.0, float(np.mean([np.linalg.norm(_junction_xy(state, j) - center) for j in jids])))
        arms = []
        for p in pids:
            attach = _junction_xy(state, ports[p]["junction_id"]) - center
            if np.linalg.norm(attach) < 0.5:
                attach = np.array(ports[p]["xy"]) - center
            arms.append({"port_id": p, "theta": geo.angle_of(attach)})
        return {"center": center.tolist(), "radius": radius, "arms": arms}

    if type_ == "dead_end":
        (p,) = pids
        end = _junction_xy(state, ports[p]["junction_id"])
        return {
            "end": end.tolist(),
            "turn_radius": 0.0,
            "arms": [{"port_id": p, "theta": geo.angle_of(_osm_arm_direction(state, p))}],
        }

    # freeform: the cluster's OSM geometry, editable as a small graph
    nodes = {f"j:{j}": _junction_xy(state, j).tolist() for j in jids}
    nodes.update({f"port:{p}": list(ports[p]["xy"]) for p in pids})
    edges = []
    for sid in cluster["internal_segment_ids"]:
        seg = state["segments"][sid]
        edges.append({
            "from": f"j:{seg['start_junction']}",
            "to": f"j:{seg['end_junction']}",
            "interior": seg["osm_polyline"][1:-1],
        })
    for p in pids:
        port = ports[p]
        seg = state["segments"][port["segment_id"]]
        pts = seg["osm_polyline"]
        if port["end"] == "start":
            piece = geo.sub_polyline(pts, 0.0, port["offset"])
        else:
            piece = geo.sub_polyline(pts, seg["length"] - port["offset"], seg["length"])[::-1]
        edges.append({"from": f"j:{port['junction_id']}", "to": f"port:{p}", "interior": piece[1:-1].tolist()})
    return {"nodes": nodes, "edges": edges}


def _check_xy(value, name: str) -> None:
    if not (isinstance(value, (list, tuple)) and len(value) == 2 and all(isinstance(v, (int, float)) for v in value)):
        raise ValueError(f"{name} must be an [x, y] pair")


def validate(state: dict, cid: str, type_: str, params: dict) -> None:
    """Raise ValueError if `params` isn't a well-formed `type_` template for this cluster."""
    cluster = state["clusters"][cid]
    if type_ not in valid_types(cluster):
        raise ValueError(f"type {type_!r} is not valid for cluster {cid}")
    if type_ == "freeform":
        nodes = params.get("nodes")
        if not isinstance(nodes, dict):
            raise ValueError("freeform needs nodes")
        for nid, xy in nodes.items():
            _check_xy(xy, f"node {nid}")
        for p in cluster["port_ids"]:
            if f"port:{p}" not in nodes:
                raise ValueError(f"freeform is missing port node port:{p}")
        for e in params.get("edges", []):
            if e.get("from") not in nodes or e.get("to") not in nodes:
                raise ValueError("freeform edge refers to an unknown node")
            for xy in e.get("interior", []):
                _check_xy(xy, "edge vertex")
        return

    core_key = "end" if type_ == "dead_end" else "center"
    _check_xy(params.get(core_key), core_key)
    if type_ == "roundabout" and not (isinstance(params.get("radius"), (int, float)) and params["radius"] > 0):
        raise ValueError("roundabout radius must be positive")
    if type_ == "dead_end" and not (isinstance(params.get("turn_radius"), (int, float)) and params["turn_radius"] >= 0):
        raise ValueError("dead_end turn_radius must be >= 0")
    arm_ports = [a.get("port_id") for a in params.get("arms", [])]
    if sorted(arm_ports) != sorted(cluster["port_ids"]):
        raise ValueError("template arms must match the cluster's ports one to one")
    for a in params["arms"]:
        if not isinstance(a.get("theta"), (int, float)):
            raise ValueError("arm theta must be a number")


def bezier(p0, t0, p3, t3, spacing: float = 0.5) -> np.ndarray:
    """Cubic Bézier from p0 (leaving along unit t0) to p3 (arriving along unit t3)."""
    p0, p3 = np.asarray(p0, float), np.asarray(p3, float)
    k = np.linalg.norm(p3 - p0) / 3
    p1, p2 = p0 + k * np.asarray(t0), p3 - k * np.asarray(t3)
    n = max(8, int(3 * k / spacing) + 1)
    t = np.linspace(0.0, 1.0, n)[:, None]
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3


def circle(center, radius: float, start_angle: float = 0.0, spacing: float = 0.5) -> np.ndarray:
    n = max(16, int(2 * math.pi * radius / spacing))
    a = start_angle + np.linspace(0.0, 2 * math.pi, n + 1)
    return np.asarray(center, float) + radius * np.column_stack([np.cos(a), np.sin(a)])


def render(state: dict, cid: str, spacing: float = 0.5) -> list[dict]:
    """The template's centerlines as polylines: [{kind, port_id?, points}]."""
    cluster = state["clusters"][cid]
    type_, params = cluster["type"], cluster["params"]
    ports = state["ports"]
    curves = []

    if type_ == "freeform":
        nodes = params["nodes"]
        for e in params["edges"]:
            pts = [nodes[e["from"]], *e["interior"], nodes[e["to"]]]
            curves.append({"kind": "edge", "points": np.asarray(pts, float)})
        return curves

    if type_ == "roundabout":
        center, radius = np.asarray(params["center"]), params["radius"]
        curves.append({"kind": "ring", "points": circle(center, radius, spacing=spacing)})
    if type_ == "dead_end" and params["turn_radius"] > 0:
        curves.append({"kind": "turn", "points": circle(params["end"], params["turn_radius"], spacing=spacing)})

    for arm in params["arms"]:
        port = ports[arm["port_id"]]
        direction = geo.unit(arm["theta"])
        if type_ == "point":
            start = np.asarray(params["center"])
        elif type_ == "roundabout":
            start = np.asarray(params["center"]) + params["radius"] * direction
        else:
            start = np.asarray(params["end"])
        pts = bezier(start, direction, port["xy"], geo.unit(port["heading"]), spacing=spacing)
        curves.append({"kind": "arm", "port_id": arm["port_id"], "points": pts})
    return curves
