"""Road cross-sections (spec.md, Road cross-sections).

A segment's cross-section is a list of structure spans covering [0, L] along its
centerline. Each span has bands (left to right in the segment's direction),
boundaries (one more than bands) and width points. The carriageway (the run of
`lane` bands) is centred on the centerline, offset by the width point's `shift`
(positive = left, like sideways offsets).

The frontend mirrors the vocabulary in frontend/src/crosssection.ts.
"""

from __future__ import annotations

import copy
import math
import re

BAND_KINDS = ("lane", "cycle_lane", "cycle_track", "parking", "sidewalk", "median", "verge", "shoulder")
LANE_DIRECTIONS = ("forward", "backward", "both")
LANE_USES = ("general", "bus", "bicycle", "taxi", "cycle_street")
LANE_TURNS = ("none", "through", "left", "right", "through_left", "through_right", "left_right")
PARKING_ARRANGEMENTS = ("parallel", "angled", "perpendicular")
PARKING_SURFACES = ("carriageway", "bay", "on_sidewalk")
MEDIAN_SURFACES = ("painted", "kerbed", "verge")
PHYSICAL = ("flush", "paving_change", "low_kerb", "kerb")
MARKINGS = ("none", "dashed", "solid", "double_solid", "dashed_solid", "solid_dashed", "block")

# Allowed attributes per band kind, with their defaults.
ATTRIBUTES = {
    "lane": {"direction": "both", "use": ["general"], "turn": "none"},
    "parking": {"arrangement": "parallel", "surface": "carriageway"},
    "median": {"surface": "painted"},
}
_CHOICES = {
    ("lane", "direction"): LANE_DIRECTIONS,
    ("lane", "turn"): LANE_TURNS,
    ("parking", "arrangement"): PARKING_ARRANGEMENTS,
    ("parking", "surface"): PARKING_SURFACES,
    ("median", "surface"): MEDIAN_SURFACES,
}

MAX_BAND_WIDTH = 50.0
MAX_SHIFT = 10.0
END_TOLERANCE = 0.5  # metres a span list may miss the segment's end by before it's an error


class CrossSectionError(ValueError):
    pass


# ---------------------------------------------------------------- defaults from OSM tags

LANE_WIDTH = {
    "motorway": 3.5, "trunk": 3.5, "primary": 3.25, "secondary": 3.0, "tertiary": 3.0,
    "motorway_link": 3.5, "trunk_link": 3.5, "primary_link": 3.25, "secondary_link": 3.0, "tertiary_link": 3.0,
}
DEFAULT_LANE_WIDTH = 2.75
# Minor roads without lane tags are usually one shared, unmarked surface for both directions.
SHARED_SURFACE_WIDTH = {"residential": 5.0, "living_street": 4.5, "unclassified": 5.0, "road": 5.0}
EDGE_LINE_CLASSES = ("motorway", "trunk", "motorway_link", "trunk_link")

BAND_WIDTH = {"cycle_lane": 1.5, "cycle_track": 2.0, "sidewalk": 1.8}
PARKING_WIDTH = {"parallel": 2.0, "angled": 4.5, "perpendicular": 5.0}


def _number(value) -> float | None:
    if value is None:
        return None
    m = re.match(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*(m)?\s*$", str(value))
    return float(m.group(1)) if m else None


def _count(value) -> int | None:
    n = _number(value)
    return int(n) if n is not None and n >= 1 and n == int(n) else None


def _per_side(tags: dict, key: str) -> dict[str, str | None]:
    """Value of `key` for each side of the way, from key:left/right/both and the bare key."""
    both = tags.get(f"{key}:both")
    plain = tags.get(key)
    out = {}
    for side in ("left", "right"):
        out[side] = tags.get(f"{key}:{side}") or both
    if plain is not None:
        if plain in ("both", "left", "right", "no", "none", "separate", "yes"):  # sidewalk=left etc.
            for side in ("left", "right"):
                if out[side] is None:
                    out[side] = "yes" if plain in ("both", "yes", side) else "no" if plain in ("left", "right") else plain
        else:
            for side in ("left", "right"):
                out[side] = out[side] or plain
    return out


def _parking(tags: dict, side: str) -> dict | None:
    """Parking band attributes for one side of the way, from either tagging scheme."""
    new = tags.get(f"parking:{side}") or tags.get("parking:both")
    if new:
        surface = {"lane": "carriageway", "street_side": "bay", "on_kerb": "on_sidewalk",
                   "half_on_kerb": "on_sidewalk", "shoulder": "carriageway"}.get(new)
        if surface is None:
            return None
        orientation = tags.get(f"parking:{side}:orientation") or tags.get("parking:both:orientation") or "parallel"
        arrangement = {"diagonal": "angled", "perpendicular": "perpendicular"}.get(orientation, "parallel")
        return {"arrangement": arrangement, "surface": surface}

    old = tags.get(f"parking:lane:{side}") or tags.get("parking:lane:both")
    if old in ("parallel", "diagonal", "perpendicular", "marked"):
        arrangement = {"diagonal": "angled", "perpendicular": "perpendicular"}.get(old, "parallel")
        position = (tags.get(f"parking:lane:{side}:{old}") or tags.get(f"parking:lane:both:{old}") or "on_street")
        surface = {"street_side": "bay", "lay_by": "bay", "on_kerb": "on_sidewalk",
                   "half_on_kerb": "on_sidewalk"}.get(position, "carriageway")
        return {"arrangement": arrangement, "surface": surface}
    return None


def _outer_bands(tags: dict, side: str) -> list[dict]:
    """Bands outside the carriageway on one side of the way, ordered outward."""
    bands = []
    cycleway = _per_side(tags, "cycleway")[side]
    if cycleway in ("lane", "shared_lane"):
        bands.append({"kind": "cycle_lane", "attributes": {}})
    parking = _parking(tags, side)
    if parking:
        bands.append({"kind": "parking", "attributes": parking})
    if cycleway == "track":
        bands.append({"kind": "cycle_track", "attributes": {}})
    # A separately mapped sidewalk still runs alongside the road, so it's part of the cross-section.
    if _per_side(tags, "sidewalk")[side] in ("yes", "both", "separate"):
        bands.append({"kind": "sidewalk", "attributes": {}})
    return bands


def _band_width(band: dict) -> float:
    if band["kind"] == "parking":
        return PARKING_WIDTH[band["attributes"]["arrangement"]]
    return BAND_WIDTH.get(band["kind"], 1.0)


def _boundary_between(inner: dict, outer: dict | None, highway: str) -> dict:
    """Boundary between a band and the next band outward (None = the cross-section's outer edge)."""
    if outer is None:
        if inner["kind"] == "lane":
            return {"physical": "kerb", "marking": "solid" if highway in EDGE_LINE_CLASSES else "none"}
        return {"physical": "paving_change" if inner["kind"] == "sidewalk" else "kerb", "marking": "none"}
    kind = outer["kind"]
    if kind == "cycle_lane":
        return {"physical": "flush", "marking": "dashed"}
    if kind == "parking":
        surface = outer["attributes"]["surface"]
        physical = {"carriageway": "flush", "bay": "paving_change", "on_sidewalk": "kerb"}[surface]
        return {"physical": physical, "marking": "none"}
    if kind == "sidewalk" and inner["kind"] == "parking" and inner["attributes"]["surface"] == "on_sidewalk":
        return {"physical": "flush", "marking": "none"}
    return {"physical": "kerb", "marking": "none"}


def default_spans(segment: dict) -> list[dict]:
    """One structure span for the whole segment, prefilled from its OSM tags."""
    tags = segment.get("osm_tags") or {}
    highway = segment.get("highway") or "road"
    reversed_ = segment.get("osm_reversed", False)
    length = segment_length(segment)

    # Lanes, in the way's own direction.
    oneway = tags.get("oneway")
    if segment.get("roundabout") or oneway in ("yes", "true", "1"):
        oneway = "forward"
    elif oneway == "-1":
        oneway = "backward"
    else:
        oneway = None
    total = _count(tags.get("lanes"))
    if oneway:
        forward, backward, shared = (total or 1, 0, False) if oneway == "forward" else (0, total or 1, False)
    else:
        f, b = _count(tags.get("lanes:forward")), _count(tags.get("lanes:backward"))
        if f or b:
            forward, backward, shared = f or 0, b or 0, False
        elif total and total >= 2:
            forward, backward, shared = math.ceil(total / 2), total // 2, False
        elif total == 1 or (highway in SHARED_SURFACE_WIDTH and "lanes" not in tags) or tags.get("lane_markings") == "no":
            forward, backward, shared = 0, 0, True
        else:
            forward, backward, shared = 1, 1, False

    # Into the segment's direction.
    if reversed_:
        forward, backward = backward, forward
    sides = {"left": "right", "right": "left"} if reversed_ else {"left": "left", "right": "right"}

    def lane(direction):
        return {"kind": "lane", "attributes": {"direction": direction, "use": ["general"], "turn": "none"}}

    if shared:
        lanes = [lane("both")]
        lane_widths = [SHARED_SURFACE_WIDTH.get(highway, 2 * DEFAULT_LANE_WIDTH)]
    else:
        # Right-hand traffic: backward lanes on the left, forward lanes on the right.
        lanes = [lane("backward") for _ in range(backward)] + [lane("forward") for _ in range(forward)]
        lane_widths = [LANE_WIDTH.get(highway, DEFAULT_LANE_WIDTH)] * len(lanes)
    carriageway = _number(tags.get("width"))
    if carriageway and 2.0 <= carriageway <= 40.0:
        lane_widths = [carriageway / len(lanes)] * len(lanes)

    unmarked = tags.get("lane_markings") == "no"
    inner_boundaries = []
    for a, b in zip(lanes, lanes[1:]):
        marking = "none" if unmarked else "dashed"
        inner_boundaries.append({"physical": "flush", "marking": marking})

    left_out = _outer_bands(tags, sides["left"])   # ordered outward
    right_out = _outer_bands(tags, sides["right"])

    def side_boundaries(outward: list[dict], carriageway_band: dict) -> list[dict]:
        chain = [carriageway_band, *outward]
        return [_boundary_between(chain[i], chain[i + 1] if i + 1 < len(chain) else None, highway)
                for i in range(len(chain))]

    left_b = side_boundaries(left_out, lanes[0])     # carriageway edge outward
    right_b = side_boundaries(right_out, lanes[-1])

    bands = [*reversed(left_out), *lanes, *right_out]
    boundaries = [*reversed(left_b), *inner_boundaries, *right_b]
    widths = [*(_band_width(b) for b in reversed(left_out)), *lane_widths, *(_band_width(b) for b in right_out)]

    return [{
        "s_from": 0.0,
        "s_to": length,
        "bands": bands,
        "boundaries": boundaries,
        "width_points": [{"s": 0.0, "widths": widths, "shift": 0.0}],
        "source": "osm",
    }]


def segment_length(segment: dict) -> float:
    from . import geo
    return geo.length(segment["centerline"]) if segment.get("centerline") else 0.0


# ---------------------------------------------------------------- validation

def _finite(value, name: str, lo: float = -math.inf, hi: float = math.inf) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise CrossSectionError(f"{name} must be a finite number")
    if not lo <= value <= hi:
        raise CrossSectionError(f"{name} must be between {lo} and {hi}")
    return float(value)


def _band(band) -> dict:
    if not isinstance(band, dict) or band.get("kind") not in BAND_KINDS:
        raise CrossSectionError(f"band kind must be one of {BAND_KINDS}")
    kind = band["kind"]
    given = band.get("attributes") or {}
    allowed = ATTRIBUTES.get(kind, {})
    unknown = set(given) - set(allowed)
    if unknown:
        raise CrossSectionError(f"{kind} bands have no attribute(s) {sorted(unknown)}")
    attributes = {}
    for key, default in allowed.items():
        value = given.get(key, copy.deepcopy(default))
        if (kind, key) == ("lane", "use"):
            if not isinstance(value, list) or not value or not all(v in LANE_USES for v in value):
                raise CrossSectionError(f"lane use must be a non-empty list from {LANE_USES}")
            value = [u for u in LANE_USES if u in value]
        elif value not in _CHOICES[(kind, key)]:
            raise CrossSectionError(f"{kind} {key} must be one of {_CHOICES[(kind, key)]}")
        attributes[key] = value
    return {"kind": kind, "attributes": attributes}


def _boundary(boundary) -> dict:
    if not isinstance(boundary, dict) or boundary.get("physical") not in PHYSICAL or boundary.get("marking") not in MARKINGS:
        raise CrossSectionError(f"boundaries need physical from {PHYSICAL} and marking from {MARKINGS}")
    return {"physical": boundary["physical"], "marking": boundary["marking"]}


def validate(spans, length: float) -> list[dict]:
    """A normalised copy of `spans`, or CrossSectionError. Spans must cover [0, length] without gaps."""
    if not isinstance(spans, list) or not spans:
        raise CrossSectionError("a segment needs at least one structure span")
    out = []
    expected_from = 0.0
    for i, span in enumerate(spans):
        name = f"span {i}"
        if not isinstance(span, dict):
            raise CrossSectionError(f"{name} must be an object")
        s_from = _finite(span.get("s_from"), f"{name} s_from")
        s_to = _finite(span.get("s_to"), f"{name} s_to")
        if abs(s_from - expected_from) > 1e-6:
            raise CrossSectionError(f"{name} starts at {s_from:.3f} m; spans must be contiguous from 0")
        s_from = expected_from
        if i == len(spans) - 1:
            if abs(s_to - length) > END_TOLERANCE:
                raise CrossSectionError(f"the last span ends at {s_to:.2f} m but the segment is {length:.2f} m long")
            s_to = length
        if s_to <= s_from:
            raise CrossSectionError(f"{name} is empty")

        bands = [_band(b) for b in span.get("bands") or []]
        lane_idx = [k for k, b in enumerate(bands) if b["kind"] == "lane"]
        if not lane_idx:
            raise CrossSectionError(f"{name} needs at least one lane band (the carriageway)")
        if lane_idx != list(range(lane_idx[0], lane_idx[-1] + 1)):
            raise CrossSectionError(f"{name}: lane bands must be next to each other")
        boundaries = [_boundary(b) for b in span.get("boundaries") or []]
        if len(boundaries) != len(bands) + 1:
            raise CrossSectionError(f"{name} needs {len(bands) + 1} boundaries for {len(bands)} bands")

        points = span.get("width_points")
        if not isinstance(points, list) or not points:
            raise CrossSectionError(f"{name} needs at least one width point")
        width_points = []
        for k, wp in enumerate(points):
            if not isinstance(wp, dict):
                raise CrossSectionError(f"{name} width point {k} must be an object")
            s = min(max(_finite(wp.get("s"), f"{name} width point {k} s"), s_from), s_to)
            widths = wp.get("widths")
            if not isinstance(widths, list) or len(widths) != len(bands):
                raise CrossSectionError(f"{name} width point {k} needs one width per band")
            widths = [_finite(w, f"{name} width", 0.0, MAX_BAND_WIDTH) for w in widths]
            shift = _finite(wp.get("shift", 0.0), f"{name} shift", -MAX_SHIFT, MAX_SHIFT)
            width_points.append({"s": s, "widths": widths, "shift": shift})
        width_points.sort(key=lambda wp: wp["s"])

        source = span.get("source", "human")
        out.append({
            "s_from": s_from, "s_to": s_to, "bands": bands, "boundaries": boundaries,
            "width_points": width_points, "source": source if source in ("osm", "model", "human") else "human",
        })
        expected_from = s_to
    return out


def rescale(spans: list[dict], factor: float) -> list[dict]:
    """Stretch span and width point positions when the centerline's length changes."""
    out = copy.deepcopy(spans)
    for span in out:
        span["s_from"] *= factor
        span["s_to"] *= factor
        for wp in span["width_points"]:
            wp["s"] *= factor
    return out
