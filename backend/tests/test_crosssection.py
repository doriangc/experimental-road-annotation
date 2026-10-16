import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from annotator import api, crosssection, edits, geo, osm, store
from test_pipeline import Builder, crossroads


def segment(tags, highway="residential", reversed_=False, length=40.0, roundabout=False):
    return {
        "osm_tags": {"highway": highway, **tags}, "highway": highway, "osm_reversed": reversed_,
        "roundabout": roundabout, "centerline": [[0.0, 0.0], [length, 0.0]],
    }


def kinds(span):
    return [b["kind"] for b in span["bands"]]


def lane_directions(span):
    return [b["attributes"]["direction"] for b in span["bands"] if b["kind"] == "lane"]


def test_plain_residential_street_is_one_shared_lane():
    (span,) = crosssection.default_spans(segment({}))
    assert kinds(span) == ["lane"]
    assert lane_directions(span) == ["both"]
    assert span["width_points"] == [{"s": 0.0, "widths": [5.0], "shift": 0.0}]
    assert span["s_from"] == 0.0 and span["s_to"] == 40.0
    assert [b["physical"] for b in span["boundaries"]] == ["kerb", "kerb"]


def test_lanes_cycle_lanes_parking_and_sidewalks():
    tags = {"lanes": "2", "cycleway:both": "lane", "parking:right": "street_side",
            "parking:right:orientation": "perpendicular", "sidewalk": "both"}
    (span,) = crosssection.default_spans(segment(tags, highway="tertiary"))
    assert kinds(span) == ["sidewalk", "cycle_lane", "lane", "lane", "cycle_lane", "parking", "sidewalk"]
    assert lane_directions(span) == ["backward", "forward"]  # right-hand traffic
    assert span["bands"][5]["attributes"] == {"arrangement": "perpendicular", "surface": "bay"}
    widths = span["width_points"][0]["widths"]
    assert widths == [1.8, 1.5, 3.0, 3.0, 1.5, 5.0, 1.8]
    markings = [b["marking"] for b in span["boundaries"]]
    assert markings[2:5] == ["dashed", "dashed", "dashed"]  # cycle lane, centre line, cycle lane
    assert len(span["boundaries"]) == len(span["bands"]) + 1


def test_reversed_segment_swaps_sides_and_directions():
    tags = {"lanes:forward": "2", "lanes:backward": "1", "sidewalk": "right"}
    (forward,) = crosssection.default_spans(segment(tags, highway="primary"))
    (backward,) = crosssection.default_spans(segment(tags, highway="primary", reversed_=True))
    assert kinds(forward) == ["lane", "lane", "lane", "sidewalk"]
    assert lane_directions(forward) == ["backward", "forward", "forward"]
    assert kinds(backward) == ["sidewalk", "lane", "lane", "lane"]
    assert lane_directions(backward) == ["backward", "backward", "forward"]


def test_oneway_against_segment_direction():
    (span,) = crosssection.default_spans(segment({"oneway": "yes"}, reversed_=True))
    assert lane_directions(span) == ["backward"]
    (span,) = crosssection.default_spans(segment({}, roundabout=True))
    assert lane_directions(span) == ["forward"]


def test_separately_mapped_sidewalks_are_still_bands():
    (span,) = crosssection.default_spans(segment({"sidewalk:left": "separate", "sidewalk:right": "no"}))
    assert kinds(span) == ["sidewalk", "lane"]


def test_width_tag_is_split_over_lanes():
    (span,) = crosssection.default_spans(segment({"lanes": "2", "width": "7 m"}, highway="secondary"))
    assert span["width_points"][0]["widths"] == [3.5, 3.5]


def test_old_parking_scheme_on_kerb():
    (span,) = crosssection.default_spans(segment({"parking:lane:left": "parallel", "parking:lane:left:parallel": "half_on_kerb", "sidewalk": "left"}))
    assert kinds(span) == ["sidewalk", "parking", "lane"]
    assert span["bands"][1]["attributes"] == {"arrangement": "parallel", "surface": "on_sidewalk"}
    assert span["boundaries"][1] == {"physical": "flush", "marking": "none"}  # parking onto its sidewalk


def valid_span(length=40.0, **overrides):
    span = crosssection.default_spans(segment({"sidewalk": "both"}, length=length))[0]
    span.update(overrides)
    return span


@pytest.mark.parametrize("change, message", [
    (lambda s: s.update(bands=[{"kind": "sidewalk"}], boundaries=s["boundaries"][:2],
                        width_points=[{"s": 0, "widths": [1.0], "shift": 0}]), "lane band"),
    (lambda s: s.update(bands=[{"kind": "lane"}, {"kind": "verge"}, {"kind": "lane"}]), "next to each other"),
    (lambda s: s["boundaries"].pop(), "boundaries"),
    (lambda s: s["width_points"][0]["widths"].pop(), "one width per band"),
    (lambda s: s["width_points"][0]["widths"].__setitem__(0, -1), "between"),
    (lambda s: s.update(width_points=[]), "width point"),
    (lambda s: s["bands"][1]["attributes"].update(use=["horses"]), "lane use"),
    (lambda s: s["bands"][1]["attributes"].update(colour="red"), "no attribute"),
    (lambda s: s.update(s_to=30.0), "segment is"),
])
def test_invalid_cross_sections_are_rejected(change, message):
    span = valid_span()
    change(span)
    with pytest.raises(crosssection.CrossSectionError, match=message):
        crosssection.validate([span], 40.0)


def test_validate_fills_attribute_defaults_and_sorts_width_points():
    span = valid_span()
    span["bands"][1] = {"kind": "lane"}
    span["width_points"] = [{"s": 30.0, "widths": [2, 5, 2], "shift": 0}, {"s": 5.0, "widths": [2, 4, 2]}]
    (out,) = crosssection.validate([span], 40.2)
    assert out["bands"][1]["attributes"] == {"direction": "both", "use": ["general"], "turn": "none"}
    assert [wp["s"] for wp in out["width_points"]] == [5.0, 30.0]
    assert out["s_to"] == 40.2  # snapped to the segment's length


def test_spans_must_be_contiguous():
    a, b = valid_span(s_to=20.0), valid_span(s_from=21.0)
    with pytest.raises(crosssection.CrossSectionError, match="contiguous"):
        crosssection.validate([a, b], 40.0)
    b["s_from"] = 20.0
    assert len(crosssection.validate([a, b], 40.0)) == 2


def test_graph_prefills_every_segment():
    state = crossroads()
    for seg in state["segments"].values():
        assert seg["spans"][0]["s_to"] == pytest.approx(geo.length(seg["centerline"]))


def test_centerline_edits_stretch_spans_and_flags():
    state = crossroads()
    sid = next(iter(state["segments"]))
    seg = state["segments"][sid]
    seg["spans"][0]["width_points"].append({"s": seg["spans"][0]["s_to"], "widths": [6.0], "shift": 0.0})
    seg["flags"] = [{"kind": "occluded", "s_from": 10.0, "s_to": 20.0}]
    old = geo.length(seg["centerline"])
    a, b = np.array(seg["centerline"][0]), np.array(seg["centerline"][-1])
    bowed = [a.tolist(), ((a + b) / 2 + [0.0, 0.0] + 5 * np.array([-(b - a)[1], (b - a)[0]]) / np.linalg.norm(b - a)).tolist(), b.tolist()]
    new = edits.apply(state, {"segments": {sid: {"centerline": bowed}}})
    span = new["segments"][sid]["spans"][0]
    length = geo.length(new["segments"][sid]["centerline"])
    assert length > old
    assert span["s_to"] == pytest.approx(length)
    assert span["width_points"][-1]["s"] == pytest.approx(length)
    assert new["segments"][sid]["flags"][0]["s_to"] == pytest.approx(20.0 * length / old)


def test_span_edits_are_validated():
    state = crossroads()
    sid = next(iter(state["segments"]))
    spans = state["segments"][sid]["spans"]
    spans[0]["width_points"][0]["widths"] = [4.2]
    new = edits.apply(state, {"segments": {sid: {"spans": spans}}})
    assert new["segments"][sid]["spans"][0]["width_points"][0]["widths"] == [4.2]
    spans[0]["boundaries"] = []
    with pytest.raises(edits.EditError, match="boundaries"):
        edits.apply(state, {"segments": {sid: {"spans": spans}}})


def test_old_areas_are_upgraded_on_load(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    b = Builder()
    c = b.node(0, 0)
    for dx, dy in ((1, 0), (0, 1), (-1, 0)):
        b.way([c, b.node(dx * 50, dy * 50)])
    b.ways[0].tags.update({"sidewalk": "both", "lanes": "2"})
    raw = {"elements": [
        *({"type": "node", "id": n, "lon": lo, "lat": la} for n, (lo, la) in b.nodes.items()),
        *({"type": "way", "id": w.id, "nodes": w.nodes, "tags": w.tags} for w in b.ways),
    ]}
    monkeypatch.setattr(osm, "fetch", lambda bbox: raw)
    client = TestClient(api.app)
    area = client.post("/api/areas", json={"name": "Old", "bbox": [5.119, 52.0895, 5.121, 52.0905]}).json()["id"]

    # Strip what older versions didn't store.
    path = tmp_path / "areas" / area / "state.json"
    state = json.loads(path.read_text())
    for seg in state["segments"].values():
        seg.pop("osm_tags"), seg.pop("osm_reversed"), seg.pop("spans")
    path.write_text(json.dumps(state))

    upgraded = client.get(f"/api/areas/{area}").json()
    with_sidewalks = [s for s in upgraded["segments"].values() if s["osm_tags"].get("sidewalk") == "both"]
    assert len(with_sidewalks) == 1
    assert kinds(with_sidewalks[0]["spans"][0]) == ["sidewalk", "lane", "lane", "sidewalk"]
    assert "spans" in json.loads(path.read_text())["segments"][with_sidewalks[0]["id"]]  # saved

    sid = with_sidewalks[0]["id"]
    r = client.post(f"/api/areas/{area}/segments/{sid}/default-cross-section")
    assert r.status_code == 200 and kinds(r.json()["spans"][0]) == ["sidewalk", "lane", "lane", "sidewalk"]
    gj = client.get(f"/api/areas/{area}/export").json()
    assert all("cross_section" in f["properties"] for f in gj["features"] if f["properties"]["kind"] == "segment")
