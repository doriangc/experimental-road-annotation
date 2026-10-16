"""Fetching and parsing OSM highways from Overpass."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import httpx

# Roads a vehicle centerline makes sense for. Footways, cycleways, paths and
# service roads (parking aisles, driveways) are left out of the first version.
ROAD_CLASSES = (
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
    "unclassified", "residential", "living_street", "road",
)

# Tried in order; the public instances are often busy.
OVERPASS_URLS = (
    os.environ.get("ANNOTATOR_OVERPASS_URL", "https://overpass-api.de/api/interpreter"),
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
USER_AGENT = "road-centerline-annotator/0.1"


@dataclass
class Way:
    id: int
    nodes: list[int]
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class OsmData:
    nodes: dict[int, tuple[float, float]]  # node id -> (lon, lat)
    ways: list[Way]


def build_query(bbox: tuple[float, float, float, float], classes=ROAD_CLASSES) -> str:
    west, south, east, north = bbox
    pattern = "|".join(classes)
    return (
        f'[out:json][timeout:90];'
        f'way["highway"~"^({pattern})$"]({south},{west},{north},{east});'
        f'out body;>;out skel qt;'
    )


def fetch(bbox: tuple[float, float, float, float], classes=ROAD_CLASSES) -> dict:
    error: httpx.HTTPError | None = None
    for url in OVERPASS_URLS:
        try:
            response = httpx.post(
                url,
                data={"data": build_query(bbox, classes)},
                headers={"User-Agent": USER_AGENT},
                timeout=120,
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPError as e:
            error = e
    raise error


def keep_way(tags: dict[str, str], classes=ROAD_CLASSES) -> bool:
    return (
        tags.get("highway") in classes
        and tags.get("tunnel") != "yes"  # tunnels are out of scope
        and tags.get("area") != "yes"
    )


def parse(raw: dict, classes=ROAD_CLASSES) -> OsmData:
    nodes = {
        el["id"]: (el["lon"], el["lat"])
        for el in raw.get("elements", [])
        if el["type"] == "node"
    }
    ways = []
    for el in raw.get("elements", []):
        if el["type"] != "way" or not keep_way(el.get("tags", {}), classes):
            continue
        ids = [n for n in el["nodes"] if n in nodes]
        ids = [n for i, n in enumerate(ids) if i == 0 or n != ids[i - 1]]
        if len(ids) >= 2:
            ways.append(Way(el["id"], ids, el.get("tags", {})))
    return OsmData(nodes, ways)
