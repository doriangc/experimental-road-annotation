"""Applying annotator edits to an area's state, all or nothing."""

from __future__ import annotations

import copy
import math

from . import crosssection, geo, templates

STATUSES = ("unreviewed", "done")
SEGMENT_FLAGS = ("occluded", "ambiguous", "skip")
CLUSTER_FLAGS = ("topology_error", "skip")


class EditError(ValueError):
    pass


def _xy(value, name: str) -> list[float]:
    if not (isinstance(value, (list, tuple)) and len(value) == 2
            and all(isinstance(v, (int, float)) and math.isfinite(v) for v in value)):
        raise EditError(f"{name} must be a finite [x, y] pair")
    return [float(value[0]), float(value[1])]


def _status(value, name: str) -> str:
    if value not in STATUSES:
        raise EditError(f"{name}: status must be one of {STATUSES}")
    return value


def apply(state: dict, edits: dict) -> dict:
    """Return a new state with `edits` applied. Raises EditError on any invalid edit.

    `edits` = {"ports": {id: {xy, heading}},
               "clusters": {id: {type?, params?, flags?, status?}},
               "segments": {id: {centerline?, flags?, spans?, status?}}}

    Segment ends and freeform port nodes are always snapped to their port, so
    a port is the single source of truth for where a segment meets a template.
    When a centerline's length changes, positions along it (spans, width points,
    flags) are stretched to match, unless the edit sets them explicitly.
    """
    new = copy.deepcopy(state)
    touched_ports = set()
    old_lengths = {
        sid: geo.length(seg["centerline"])
        for sid, seg in state["segments"].items() if seg["centerline"]
    }

    for pid, edit in (edits.get("ports") or {}).items():
        port = new["ports"].get(pid)
        if port is None:
            raise EditError(f"unknown port {pid}")
        if "xy" in edit:
            port["xy"] = _xy(edit["xy"], f"port {pid} xy")
        if "heading" in edit:
            if not (isinstance(edit["heading"], (int, float)) and math.isfinite(edit["heading"])):
                raise EditError(f"port {pid} heading must be a finite number")
            port["heading"] = float(edit["heading"])
        touched_ports.add(pid)
        new["clusters"][port["cluster_id"]]["source"] = "human"
        new["segments"][port["segment_id"]]["source"] = "human"

    for cid, edit in (edits.get("clusters") or {}).items():
        cluster = new["clusters"].get(cid)
        if cluster is None:
            raise EditError(f"unknown cluster {cid}")
        if "type" in edit or "params" in edit:
            type_ = edit.get("type", cluster["type"])
            params = edit.get("params")
            if params is None:
                raise EditError(f"cluster {cid}: changing type needs params")
            try:
                templates.validate(new, cid, type_, params)
            except ValueError as e:
                raise EditError(f"cluster {cid}: {e}") from e
            cluster["type"], cluster["params"], cluster["source"] = type_, params, "human"
        if "flags" in edit:
            if not all(f in CLUSTER_FLAGS for f in edit["flags"]):
                raise EditError(f"cluster {cid}: flags must be from {CLUSTER_FLAGS}")
            cluster["flags"] = sorted(set(edit["flags"]))
        if "status" in edit:
            cluster["status"] = _status(edit["status"], f"cluster {cid}")
        touched_ports.update(cluster["port_ids"])

    for sid, edit in (edits.get("segments") or {}).items():
        seg = new["segments"].get(sid)
        if seg is None:
            raise EditError(f"unknown segment {sid}")
        if seg["internal"]:
            raise EditError(f"segment {sid} is internal to cluster {seg['cluster_id']}; edit the cluster instead")
        if "centerline" in edit:
            line = edit["centerline"]
            if not isinstance(line, list) or len(line) < 2:
                raise EditError(f"segment {sid}: centerline needs at least 2 points")
            seg["centerline"] = [_xy(p, f"segment {sid} vertex") for p in line]
            seg["source"] = "human"
            touched_ports.update([seg["start_port"], seg["end_port"]])
        if "flags" in edit:
            flags = []
            for f in edit["flags"]:
                if f.get("kind") not in SEGMENT_FLAGS:
                    raise EditError(f"segment {sid}: flag kind must be from {SEGMENT_FLAGS}")
                s_from, s_to = f.get("s_from", 0.0), f.get("s_to")
                if not isinstance(s_from, (int, float)) or not (s_to is None or isinstance(s_to, (int, float))):
                    raise EditError(f"segment {sid}: flag span must be numbers")
                flags.append({"kind": f["kind"], "s_from": float(s_from), "s_to": None if s_to is None else float(s_to)})
            seg["flags"] = flags
        if "status" in edit:
            seg["status"] = _status(edit["status"], f"segment {sid}")

    for pid in touched_ports:
        _sync_port(new, pid)

    segment_edits = edits.get("segments") or {}
    for sid, old_length in old_lengths.items():
        seg = new["segments"][sid]
        length = geo.length(seg["centerline"])
        edit = segment_edits.get(sid, {})
        if "spans" in edit:
            try:
                spans = crosssection.validate(edit["spans"], length)
            except crosssection.CrossSectionError as e:
                raise EditError(f"segment {sid}: {e}") from e
            # Provenance is decided here, not by the client: a span identical to the
            # OSM prefill is "osm", an unchanged span keeps its source, anything else is "human".
            old_spans = state["segments"][sid].get("spans") or []
            prefill = crosssection.default_spans(seg)
            content = lambda span: {**span, "source": None}
            for k, span in enumerate(spans):
                old = old_spans[k] if k < len(old_spans) else None
                if k < len(prefill) and content(span) == content(prefill[k]):
                    span["source"] = "osm"
                elif old is not None and content(span) == content(old):
                    span["source"] = old["source"]
                else:
                    span["source"] = "human"
            seg["spans"] = spans
        elif abs(length - old_length) > 1e-9 and seg.get("spans") and old_length > 0:
            seg["spans"] = crosssection.rescale(seg["spans"], length / old_length)
            seg["spans"][-1]["s_to"] = length
        if "flags" not in edit and abs(length - old_length) > 1e-9 and old_length > 0:
            for f in seg["flags"]:
                f["s_from"] *= length / old_length
                if f["s_to"] is not None:
                    f["s_to"] *= length / old_length
    for sid in segment_edits:
        if "spans" in segment_edits[sid] and sid not in old_lengths:
            raise EditError(f"segment {sid} has no centerline")
    return new


def _sync_port(state: dict, pid: str) -> None:
    port = state["ports"][pid]
    seg = state["segments"][port["segment_id"]]
    if seg["centerline"]:
        seg["centerline"][0 if port["end"] == "start" else -1] = list(port["xy"])
    cluster = state["clusters"][port["cluster_id"]]
    if cluster["type"] == "freeform":
        cluster["params"]["nodes"][f"port:{pid}"] = list(port["xy"])
