# Road centerline annotator

Annotation tool for the pipeline in [spec.md](spec.md): OSM roads over PDOK aerial imagery, with
intersection templates (point, roundabout, dead end, freeform) and road segments running port to port.

## Running

Needs Python ≥ 3.11 with [uv](https://docs.astral.sh/uv/), and Node ≥ 20.

```sh
# build the editor once (or after changing frontend/)
cd frontend && npm install && npm run build && cd ..

# start the server; the editor is at http://127.0.0.1:8000
cd backend && uv run uvicorn annotator.api:app --port 8000
```

For frontend development, run the backend as above and `npm run dev` in `frontend/` (Vite proxies `/api` to port 8000).

Tests: `cd backend && uv run pytest`.

## Using it

1. Pan to an area in the Netherlands, pick the imagery year, and click **New area from current view** (max 4 km²).
   The server fetches OSM roads from Overpass and builds junctions, clusters, ports and segments (spec Stage 0).
   The area is locked to that dated imagery layer (default PDOK 2026, 8 cm); the sources are in
   `backend/annotator/imagery.py`. "Current" layers such as PDOK `Actueel_*` are never used, because they change
   every year.
2. Press **N** to go to the nearest unreviewed intersection; all intersections come before segments.
3. Fix the template: pick the type, then drag its handles onto the imagery:
   - **yellow:** centre, or end point for a dead end;
   - **orange:** arm direction, or where an arm meets the ring;
   - **green:** ring radius;
   - **white:** port (the segment's end follows it over its first 20 m);
   - **pink:** port heading.
4. Press **D** to mark it done and move on. Once the intersections are done, **N** moves on to segments: drag their
   vertices, double-click to add one, right-click to delete one.
5. **Ctrl+Z** undoes, **O** toggles the OSM overlay, and `#cluster=c12` / `#segment=s40` in the URL links to an item.
6. **Export GeoJSON** writes template curves and segment centerlines resampled into 0.1 m slices.

Each area lives in `data/areas/<id>/` (`osm.json` is the raw Overpass response, `state.json` holds everything else;
coordinates are metres in the area's UTM zone). Every edit is saved immediately.

## Differences from the spec (first version)

- No road cross-sections yet (bands, widths, markings, parking, sidewalks) and no cross-section overlay.
- No `staggered` template and no dual-carriageway arms yet: each port is its own arm. Multi-junction clusters that
  aren't roundabouts default to `freeform`.
- Clusters can't be merged or split in the editor.
- Segment flags cover the whole segment (stored as spans, `s_from = 0`, `s_to = null`, so per-span flags can come
  later).
- Template fitting is initialised from OSM only; Models A and B don't exist yet.
- Only vehicle roads are loaded (no service roads, cycleways or footways); see `ROAD_CLASSES` in
  `backend/annotator/osm.py`.

## Data licences

Imagery: PDOK Luchtfoto RGB (yearly layers), CC BY 4.0. Roads: © OpenStreetMap contributors, ODbL. Annotations derived from OSM are
likely a derivative database under the ODbL, which matters if the dataset is ever published.
