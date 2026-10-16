"""Imagery sources. Every area is locked to one dated layer, so its labels always
refer to the exact imagery they were annotated on (spec.md, Inputs).

Never use PDOK's `Actueel_*` layers: they are replaced with each year's new flight.
"""

from __future__ import annotations

PDOK_WMTS = "https://service.pdok.nl/hwh/luchtfotorgb/wmts/v1_0/{layer}/EPSG:3857/{{z}}/{{x}}/{{y}}.jpeg"


def _pdok(year: int) -> dict:
    layer = f"{year}_orthoHR"
    return {
        "id": f"pdok-{year}-orthoHR",
        "name": f"PDOK {year} (8 cm)",
        "provider": "PDOK Luchtfoto RGB",
        "layer": layer,
        "year": year,
        "gsd": 0.08,  # native ground sample distance, m/px
        "tiles": PDOK_WMTS.format(layer=layer),
        "max_zoom": 21,
        "license": "CC BY 4.0",
    }


SOURCES = {s["id"]: s for s in (_pdok(y) for y in range(2026, 2020, -1))}
DEFAULT = "pdok-2026-orthoHR"


def record(source_id: str) -> dict:
    """The imagery record stored with an area. Raises KeyError for unknown ids."""
    return dict(SOURCES[source_id])
