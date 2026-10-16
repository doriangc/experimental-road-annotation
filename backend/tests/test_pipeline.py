import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from annotator import api, edits, export, geo, graph, imagery, osm, store, templates

ORIGIN = (5.12, 52.09)  # Utrecht
PROJ = geo.Projector(geo.utm_epsg(*ORIGIN))
OX, OY = PROJ.to_xy(*ORIGIN)
BBOX = (5.10, 52.08, 5.14, 52.10)


class Builder:
    """Synthetic OSM data, with node positions given in metres from ORIGIN."""

    def __init__(self):
        self.nodes, self.ways, self._next = {}, [], 1

    def node(self, x, y):
        nid = self._next
        self._next += 1
        self.nodes[nid] = PROJ.to_lonlat(OX + x, OY + y)
        return nid

    def way(self, node_ids, **tags):
        self.ways.append(osm.Way(len(self.ways) + 100, list(node_ids), {"highway": "residential", **tags}))

    def build(self):
        return graph.build(osm.OsmData(self.nodes, self.ways), PROJ, BBOX)


def xy(x, y):
    return np.array([OX + x, OY + y])


def crossroads(arm=50.0):
    b = Builder()
    c = b.node(0, 0)
    for dx, dy in ((1, 0), (0, 1), (-1, 0), (0, -1)):
        b.way([c, b.node(dx * arm / 2, dy * arm / 2), b.node(dx * arm, dy * arm)])
    return b.build()


def test_crossroads_has_point_cluster_with_four_ports():
    state = crossroads()
    kinds = sorted(c["type"] for c in state["clusters"].values())
    assert kinds == ["dead_end"] * 4 + ["point"]
    point = next(c for c in state["clusters"].values() if c["type"] == "point")
    assert len(point["port_ids"]) == 4
    for pid in point["port_ids"]:
        port = state["ports"][pid]
        # default residential port radius from the junction, heading outward
        assert np.linalg.norm(np.array(port["xy"]) - xy(0, 0)) == pytest.approx(graph.DEFAULT_PORT_RADIUS, abs=1e-6)
        outward = (np.array(port["xy"]) - xy(0, 0)) / graph.DEFAULT_PORT_RADIUS
        assert np.dot(outward, geo.unit(port["heading"])) == pytest.approx(1.0)
    # arms are in counter-clockwise order
    angles = [templates.geo.angle_of(np.array(state["ports"][p]["xy"]) - xy(0, 0)) for p in point["port_ids"]]
    assert angles == sorted(angles)


def test_segment_runs_port_to_port():
    state = crossroads()
    for seg in state["segments"].values():
        assert not seg["internal"]
        assert seg["centerline"][0] == state["ports"][seg["start_port"]]["xy"]
        assert seg["centerline"][-1] == state["ports"][seg["end_port"]]["xy"]
        assert geo.length(seg["centerline"]) == pytest.approx(50 - graph.DEFAULT_PORT_RADIUS - 3.0, abs=1e-6)


def test_ways_joined_end_to_end_merge_into_one_segment():
    b = Builder()
    a, m, z = b.node(0, 0), b.node(40, 0), b.node(80, 0)
    b.way([a, m])
    b.way([m, z])
    state = b.build()
    assert len(state["segments"]) == 1
    assert next(iter(state["segments"].values()))["osm_way_ids"] == [100, 101]


def test_tunnels_are_dropped():
    b = Builder()
    b.way([b.node(0, 0), b.node(50, 0)])
    b.way([b.node(0, 10), b.node(50, 10)], tunnel="yes")
    assert len(osm.parse({"elements": [
        *({"type": "node", "id": n, "lon": lo, "lat": la} for n, (lo, la) in b.nodes.items()),
        *({"type": "way", "id": w.id, "nodes": w.nodes, "tags": w.tags} for w in b.ways),
    ]}).ways) == 1


def roundabout(radius=15.0, entry=40.0):
    b = Builder()
    ring = [b.node(radius * math.cos(a), radius * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 16, endpoint=False)]
    b.way(ring + [ring[0]], junction="roundabout")
    for i in (0, 4, 8, 12):
        a = 2 * math.pi * i / 16
        b.way([ring[i], b.node((radius + entry) * math.cos(a), (radius + entry) * math.sin(a))])
    return b.build()


def test_roundabout_is_one_cluster():
    state = roundabout()
    rb = [c for c in state["clusters"].values() if c["type"] == "roundabout"]
    assert len(rb) == 1
    (cluster,) = rb
    assert len(cluster["junction_ids"]) == 4
    assert len(cluster["port_ids"]) == 4
    assert all(state["segments"][s]["roundabout"] for s in cluster["internal_segment_ids"])
    params = cluster["params"]
    assert np.linalg.norm(np.array(params["center"]) - xy(0, 0)) < 0.5
    assert params["radius"] == pytest.approx(15.0, abs=0.5)


def test_close_junctions_merge_and_default_to_freeform():
    b = Builder()
    w, j1, j2, e = b.node(-60, 0), b.node(0, 0), b.node(15, 0), b.node(75, 0)
    b.way([w, j1, j2, e])
    b.way([j1, b.node(0, 60)])
    b.way([j2, b.node(15, -60)])
    state = b.build()
    merged = [c for c in state["clusters"].values() if len(c["junction_ids"]) == 2]
    assert len(merged) == 1
    cluster = merged[0]
    assert cluster["type"] == "freeform"
    assert len(cluster["internal_segment_ids"]) == 1
    assert len(cluster["params"]["edges"]) == 1 + 4


@pytest.mark.parametrize("make", [crossroads, roundabout])
def test_arms_end_exactly_at_ports(make):
    state = make()
    for cid, cluster in state["clusters"].items():
        for curve in templates.render(state, cid):
            if curve["kind"] == "arm":
                assert curve["points"][-1] == pytest.approx(state["ports"][curve["port_id"]]["xy"])


def test_every_valid_type_initialises_and_validates():
    state = roundabout()
    for cid, cluster in state["clusters"].items():
        for type_ in templates.valid_types(cluster):
            params = templates.init_params(state, cid, type_)
            templates.validate(state, cid, type_, params)
            cluster["type"], cluster["params"] = type_, params
            templates.render(state, cid)


def test_moving_a_port_snaps_segment_and_freeform_node():
    state = roundabout()
    cid = next(c for c, cl in state["clusters"].items() if cl["type"] == "roundabout")
    cluster = state["clusters"][cid]
    free = templates.init_params(state, cid, "freeform")
    state = edits.apply(state, {"clusters": {cid: {"type": "freeform", "params": free}}})
    pid = cluster["port_ids"][0]
    target = (np.array(state["ports"][pid]["xy"]) + [1.0, 2.0]).tolist()
    new = edits.apply(state, {"ports": {pid: {"xy": target}}})
    seg = new["segments"][new["ports"][pid]["segment_id"]]
    end = 0 if new["ports"][pid]["end"] == "start" else -1
    assert seg["centerline"][end] == target
    assert new["clusters"][cid]["params"]["nodes"][f"port:{pid}"] == target
    assert seg["source"] == "human"
    # the original is untouched
    assert state["ports"][pid]["xy"] != target


def test_invalid_edits_are_rejected():
    state = crossroads()
    point = next(c for c, cl in state["clusters"].items() if cl["type"] == "point")
    with pytest.raises(edits.EditError):
        edits.apply(state, {"clusters": {point: {"type": "dead_end", "params": {}}}})
    params = state["clusters"][point]["params"]
    with pytest.raises(edits.EditError):
        edits.apply(state, {"clusters": {point: {"params": {**params, "arms": params["arms"][:2]}}}})
    with pytest.raises(edits.EditError):
        edits.apply(state, {"segments": {"s0": {"centerline": [[0, 0]]}}})
    with pytest.raises(edits.EditError):
        edits.apply(state, {"segments": {"s0": {"status": "finished"}}})


def test_export_slices_have_constant_length():
    state = crossroads()
    state.update({"id": "t", "name": "t", "bbox": list(BBOX), "epsg": PROJ.epsg, "imagery": imagery.record(imagery.DEFAULT)})
    gj = export.geojson(state, slice_length=0.1)
    seg = next(f for f in gj["features"] if f["properties"]["kind"] == "segment")
    pts = np.array([PROJ.to_xy(*c) for c in seg["geometry"]["coordinates"]])
    steps = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    assert steps[:-1] == pytest.approx(0.1, abs=1e-6)
    assert 0 < steps[-1] <= 0.1 + 1e-6


def test_api_create_edit_and_export(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    b = Builder()
    c = b.node(0, 0)
    for dx, dy in ((1, 0), (0, 1), (-1, 0)):
        b.way([c, b.node(dx * 50, dy * 50)])
    raw = {"elements": [
        *({"type": "node", "id": n, "lon": lo, "lat": la} for n, (lo, la) in b.nodes.items()),
        *({"type": "way", "id": w.id, "nodes": w.nodes, "tags": w.tags} for w in b.ways),
    ]}
    monkeypatch.setattr(osm, "fetch", lambda bbox: raw)
    client = TestClient(api.app)

    r = client.post("/api/areas", json={"name": "Test T", "bbox": [5.119, 52.0895, 5.121, 52.0905]})
    assert r.status_code == 200, r.text
    area = r.json()["id"]
    assert area == "test-t"
    assert r.json()["imagery"]["layer"] == "2026_orthoHR"  # the default, a dated layer
    assert not any(s["layer"].startswith("Actueel") for s in client.get("/api/imagery").json()["sources"])
    r2 = client.post("/api/areas", json={"name": "Old", "bbox": [5.119, 52.0895, 5.121, 52.0905], "imagery": "pdok-2023-orthoHR"})
    assert r2.json()["imagery"]["year"] == 2023
    bad = client.post("/api/areas", json={"name": "Bad", "bbox": [5.119, 52.0895, 5.121, 52.0905], "imagery": "Actueel_orthoHR"})
    assert bad.status_code == 400
    state = client.get(f"/api/areas/{area}").json()
    point = next(c for c in state["clusters"].values() if c["type"] == "point")

    r = client.post(f"/api/areas/{area}/clusters/{point['id']}/init", json={"type": "roundabout"})
    assert r.status_code == 200
    r = client.post(f"/api/areas/{area}/edits", json={"clusters": {point["id"]: {**r.json(), "status": "done"}}})
    assert r.status_code == 200, r.text
    assert r.json()["summary"]["clusters"]["done"] == 1
    assert client.get(f"/api/areas/{area}").json()["clusters"][point["id"]]["type"] == "roundabout"

    pid = point["port_ids"][0]
    moved = [state["ports"][pid]["xy"][0] + 2, state["ports"][pid]["xy"][1]]
    assert client.post(f"/api/areas/{area}/edits", json={"ports": {pid: {"xy": moved}}}).status_code == 200
    r = client.post(f"/api/areas/{area}/clusters/{point['id']}/init", json={"type": "point", "reset_ports": True})
    assert r.json()["ports"][pid]["xy"] == state["ports"][pid]["osm_xy"]
    r = client.post(f"/api/areas/{area}/clusters/{point['id']}/init", json={"type": "point"})
    assert r.json()["ports"][pid]["xy"] == moved

    r = client.post(f"/api/areas/{area}/clusters/{point['id']}/init", json={"type": "dead_end"})
    assert r.status_code == 400
    assert client.get("/api/areas/nope").status_code == 404
    assert client.get("/api/areas/../etc").status_code == 404

    gj = client.get(f"/api/areas/{area}/export?slices=true").json()
    assert {f["properties"]["kind"] for f in gj["features"]} == {"template", "segment"}
    assert gj["imagery"]["id"] == imagery.DEFAULT
