"""Per-area storage: data/areas/<id>/{osm.json, state.json}."""

from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

DATA_DIR = Path(os.environ.get("ANNOTATOR_DATA", Path(__file__).resolve().parents[2] / "data"))

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def lock(area_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(area_id, threading.Lock())


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "area"


def area_dir(area_id: str) -> Path:
    if not re.fullmatch(r"[a-z0-9-]+", area_id):
        raise KeyError(area_id)
    return DATA_DIR / "areas" / area_id


def new_area_id(name: str) -> str:
    base = slugify(name)
    candidate, n = base, 2
    while (DATA_DIR / "areas" / candidate).exists():
        candidate, n = f"{base}-{n}", n + 1
    return candidate


def _write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data))
    os.replace(tmp, path)


def save_osm(area_id: str, raw: dict) -> None:
    _write_json(area_dir(area_id) / "osm.json", raw)


def save(state: dict) -> None:
    _write_json(area_dir(state["id"]) / "state.json", state)


def load(area_id: str) -> dict:
    path = area_dir(area_id) / "state.json"
    if not path.exists():
        raise KeyError(area_id)
    return json.loads(path.read_text())


def list_ids() -> list[str]:
    root = DATA_DIR / "areas"
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "state.json").exists())
