"""Projection and polyline helpers.

All geometry is metric (x, y) in the area's UTM CRS. Lon/lat only appears at I/O.
"""

from __future__ import annotations

import math

import numpy as np
from pyproj import Transformer


def utm_epsg(lon: float, lat: float) -> int:
    zone = min(int((lon + 180) // 6) + 1, 60)
    return (32600 if lat >= 0 else 32700) + zone


class Projector:
    def __init__(self, epsg: int):
        self.epsg = epsg
        self._fwd = Transformer.from_crs(4326, epsg, always_xy=True)
        self._inv = Transformer.from_crs(epsg, 4326, always_xy=True)

    def to_xy(self, lon: float, lat: float) -> tuple[float, float]:
        x, y = self._fwd.transform(lon, lat)
        return float(x), float(y)

    def to_lonlat(self, x: float, y: float) -> tuple[float, float]:
        lon, lat = self._inv.transform(x, y)
        return float(lon), float(lat)

    def to_lonlat_many(self, pts) -> list[list[float]]:
        arr = as_array(pts)
        lon, lat = self._inv.transform(arr[:, 0], arr[:, 1])
        return np.column_stack([lon, lat]).tolist()


def as_array(pts) -> np.ndarray:
    return np.asarray(pts, dtype=float).reshape(-1, 2)


def unit(angle: float) -> np.ndarray:
    return np.array([math.cos(angle), math.sin(angle)])


def angle_of(v) -> float:
    return math.atan2(v[1], v[0])


def cumulative_length(pts) -> np.ndarray:
    pts = as_array(pts)
    d = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    return np.concatenate([[0.0], np.cumsum(d)])


def length(pts) -> float:
    return float(cumulative_length(pts)[-1])


def point_at(pts, s: float) -> tuple[np.ndarray, np.ndarray]:
    """Point and unit tangent at arc length `s` (clamped to the polyline)."""
    pts = as_array(pts)
    cum = cumulative_length(pts)
    s = min(max(s, 0.0), cum[-1])
    i = int(np.searchsorted(cum, s, side="right")) - 1
    i = min(max(i, 0), len(pts) - 2)
    seg = pts[i + 1] - pts[i]
    seg_len = cum[i + 1] - cum[i]
    t = (s - cum[i]) / seg_len if seg_len > 0 else 0.0
    tangent = seg / seg_len if seg_len > 0 else np.array([1.0, 0.0])
    return pts[i] + t * seg, tangent


def sub_polyline(pts, s0: float, s1: float) -> np.ndarray:
    """The part of the polyline between arc lengths s0 < s1, keeping interior vertices."""
    pts = as_array(pts)
    cum = cumulative_length(pts)
    start, _ = point_at(pts, s0)
    end, _ = point_at(pts, s1)
    inner = pts[(cum > s0) & (cum < s1)]
    return np.vstack([start, inner, end])


def resample(pts, step: float) -> np.ndarray:
    """Points every `step` metres of arc length. The last piece covers the remainder."""
    pts = as_array(pts)
    total = length(pts)
    stations = np.arange(0.0, total, step)
    if len(stations) == 0 or total - stations[-1] > 1e-9:
        stations = np.append(stations, total)
    return np.array([point_at(pts, s)[0] for s in stations])


def direction_from_end(pts, at_start: bool, dist: float) -> np.ndarray:
    """Unit vector from one end of the polyline toward the point `dist` metres along it."""
    pts = as_array(pts)
    total = length(pts)
    dist = min(dist, total)
    if at_start:
        origin, (target, _) = pts[0], point_at(pts, dist)
    else:
        origin, (target, _) = pts[-1], point_at(pts, total - dist)
    v = target - origin
    n = np.linalg.norm(v)
    return v / n if n > 0 else np.array([1.0, 0.0])
