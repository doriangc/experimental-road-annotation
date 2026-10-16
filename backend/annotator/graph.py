"""Stage 0: build junctions, segments, clusters and ports from OSM (spec.md, Stage 0)."""

from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np

from . import geo, templates
from .osm import OsmData

DEFAULT_PARAMS = {
    "d_c": 30.0,             # junctions joined by a shorter segment form one cluster
    "port_gap": 2.0,         # minimum road left between two ports on one segment
    "dead_end_radius": 3.0,  # port distance from a dead end
    "slice_length": 0.1,     # ℓ
}

# Default distance from a junction to its port, by road class (metres).
PORT_RADIUS = {
    "motorway": 25.0, "trunk": 20.0, "primary": 15.0, "secondary": 12.0, "tertiary": 10.0,
    "motorway_link": 10.0, "trunk_link": 10.0, "primary_link": 10.0,
    "secondary_link": 10.0, "tertiary_link": 10.0,
}
DEFAULT_PORT_RADIUS = 8.0


def port_radius(highway: str) -> float:
    return PORT_RADIUS.get(highway, DEFAULT_PORT_RADIUS)


class _UnionFind:
    def __init__(self, items):
        self.parent = {i: i for i in items}

    def find(self, i):
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a, b) -> bool:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        self.parent[max(ra, rb)] = min(ra, rb)
        return True


def _walk_segments(osm: OsmData):
    """Split the way network into junction-to-junction paths.

    Nodes where exactly two ways join end to end are not junctions, so those
    ways merge into one segment. Returns (paths, junction degrees, unused edges).
    """
    incidences: dict[int, list] = defaultdict(list)
    for wi, way in enumerate(osm.ways):
        for i in range(len(way.nodes) - 1):
            a, b = way.nodes[i], way.nodes[i + 1]
            incidences[a].append(((wi, i), b))
            incidences[b].append(((wi, i), a))

    degree = {n: len(inc) for n, inc in incidences.items()}
    is_junction = {n: d != 2 for n, d in degree.items()}

    used: set = set()
    paths = []
    for j in sorted(n for n in incidences if is_junction[n]):
        for key, nbr in incidences[j]:
            if key in used:
                continue
            used.add(key)
            nodes, keys, cur = [j], [key], nbr
            while not is_junction[cur]:
                nodes.append(cur)
                (k1, n1), (k2, n2) = incidences[cur]
                key, cur = (k2, n2) if k1 == keys[-1] else (k1, n1)
                used.add(key)
                keys.append(key)
            nodes.append(cur)
            paths.append((nodes, keys))

    all_keys = {key for inc in incidences.values() for key, _ in inc}
    junction_degree = {n: d for n, d in degree.items() if is_junction[n]}
    return paths, junction_degree, len(all_keys - used)


def build(osm: OsmData, proj: geo.Projector, bbox, params: dict | None = None) -> dict:
    """Build the annotation state (junctions, segments, clusters, ports) for an area."""
    params = {**DEFAULT_PARAMS, **(params or {})}
    xy = {nid: proj.to_xy(*lonlat) for nid, lonlat in osm.nodes.items()}
    paths, junction_degree, unused_edges = _walk_segments(osm)

    junctions = {
        str(n): {"id": str(n), "osm_node_id": n, "osm_xy": list(xy[n]), "degree": d, "cluster_id": None}
        for n, d in junction_degree.items()
    }

    segments: dict[str, dict] = {}
    for i, (nodes, keys) in enumerate(paths):
        ways = [osm.ways[wi] for wi, _ in keys]
        dominant = Counter(w.id for w in ways).most_common(1)[0][0]
        tags = next(w.tags for w in ways if w.id == dominant)
        pts = np.array([xy[n] for n in nodes])
        roundabout = any(w.tags.get("junction") in ("roundabout", "circular") for w in ways)
        sid = f"s{i}"
        segments[sid] = {
            "id": sid,
            "start_junction": str(nodes[0]),
            "end_junction": str(nodes[-1]),
            "osm_node_ids": nodes,
            "osm_way_ids": list(dict.fromkeys(w.id for w in ways)),
            "highway": tags.get("highway"),
            "name": tags.get("name"),
            "oneway": tags.get("oneway") == "yes" or roundabout,
            "roundabout": roundabout,
            "bridge": tags.get("bridge") == "yes",
            "osm_polyline": pts.tolist(),
            "length": geo.length(pts),
            "internal": False,
            "cluster_id": None,
            "start_port": None,
            "end_port": None,
            "guide_line": None,
            "centerline": None,
            "flags": [],
            "status": "unreviewed",
            "source": "osm",
        }

    # --- Clusters -------------------------------------------------------
    uf = _UnionFind(list(junctions))
    dead = {j for j, rec in junctions.items() if rec["degree"] == 1}

    def end_radius(seg, end: str) -> float:
        j = seg[f"{end}_junction"]
        return params["dead_end_radius"] if j in dead else port_radius(seg["highway"])

    def too_short_for_ports(seg) -> bool:
        return seg["length"] < end_radius(seg, "start") + end_radius(seg, "end") + params["port_gap"]

    for seg in segments.values():
        a, b = seg["start_junction"], seg["end_junction"]
        if seg["roundabout"]:
            uf.union(a, b)
        elif a not in dead and b not in dead and seg["length"] < params["d_c"]:
            uf.union(a, b)
    # Cut-outs must not overlap: merge across segments too short to hold two ports.
    for seg in segments.values():
        if too_short_for_ports(seg) and not (seg["start_junction"] in dead and seg["end_junction"] in dead):
            uf.union(seg["start_junction"], seg["end_junction"])

    groups: dict[str, list[str]] = defaultdict(list)
    for j in junctions:
        groups[uf.find(j)].append(j)

    west, south, east, north = bbox
    clusters: dict[str, dict] = {}
    root_to_cluster = {}
    for k, root in enumerate(sorted(groups, key=lambda r: int(r))):
        cid = f"c{k}"
        jids = sorted(groups[root], key=int)
        center = np.mean([junctions[j]["osm_xy"] for j in jids], axis=0)
        lon, lat = proj.to_lonlat(*center)
        clusters[cid] = {
            "id": cid,
            "junction_ids": jids,
            "internal_segment_ids": [],
            "port_ids": [],
            "osm_center": center.tolist(),
            "roundabout": False,
            "dead_end": len(jids) == 1 and jids[0] in dead,
            "outside": not (west <= lon <= east and south <= lat <= north),
            "type": None,
            "params": None,
            "flags": [],
            "status": "unreviewed",
            "source": "osm",
        }
        root_to_cluster[root] = cid
        for j in jids:
            junctions[j]["cluster_id"] = cid

    # --- Ports ----------------------------------------------------------
    ports: dict[str, dict] = {}
    for sid, seg in segments.items():
        ca = junctions[seg["start_junction"]]["cluster_id"]
        cb = junctions[seg["end_junction"]]["cluster_id"]
        if ca == cb and (seg["roundabout"] or seg["length"] < params["d_c"] or too_short_for_ports(seg)):
            seg["internal"] = True
            seg["cluster_id"] = ca
            clusters[ca]["internal_segment_ids"].append(sid)
            if seg["roundabout"]:
                clusters[ca]["roundabout"] = True
            continue

        pts = seg["osm_polyline"]
        total = seg["length"]
        ra, rb = end_radius(seg, "start"), end_radius(seg, "end")
        if ra + rb + params["port_gap"] > total:  # e.g. a short road between two dead ends
            scale = total / (ra + rb + params["port_gap"])
            ra, rb = ra * scale, rb * scale

        for end, cid, s, offset in (("start", ca, ra, ra), ("end", cb, total - rb, rb)):
            point, tangent = geo.point_at(pts, s)
            outward = tangent if end == "start" else -tangent
            pid = f"{sid}:{end}"
            heading = geo.angle_of(outward)
            ports[pid] = {
                "id": pid,
                "cluster_id": cid,
                "segment_id": sid,
                "end": end,
                "junction_id": seg[f"{end}_junction"],
                "offset": offset,  # arc length from the junction along the OSM segment
                "xy": point.tolist(),
                "heading": heading,  # outward from the cluster, radians
                "osm_xy": point.tolist(),
                "osm_heading": heading,
            }
            seg[f"{end}_port"] = pid
            clusters[cid]["port_ids"].append(pid)

        seg["guide_line"] = geo.sub_polyline(pts, ra, total - rb).tolist()
        seg["centerline"] = [list(p) for p in seg["guide_line"]]

    state = {
        "params": params,
        "junctions": junctions,
        "segments": segments,
        "clusters": clusters,
        "ports": ports,
        "stats": {"skipped_loop_edges": unused_edges},
    }

    for cid, cluster in clusters.items():
        cluster["port_ids"] = templates.sort_ports(state, cid, np.array(cluster["osm_center"]))
        cluster["type"] = templates.default_type(cluster)
        cluster["params"] = templates.init_params(state, cid, cluster["type"])

    return state
