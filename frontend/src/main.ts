import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, MapMouseEvent, PointLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import proj4 from "proj4";

import * as api from "./api";
import {
  BAND_KINDS, KIND_COLORS, KIND_LABELS, LANE_DIRECTIONS, LANE_TURNS, LANE_USES, MARKINGS, MEDIAN_SURFACES,
  PARKING_ARRANGEMENTS, PARKING_SURFACES, PHYSICAL, arcLengthOf, at, bandProblem, boundaryOffsets,
  defaultAttributes, insertBand, moveBoundary, removeBand, rescaleSpans, segmentOverlay, spanIndexAt,
  stationAt, widthsAt,
} from "./crosssection";
import {
  add, angleOf, dist, largestGapMid, nearestOnPolyline, polylineLength, renderCluster, scale, shiftEnd, sub,
  unit, validTypes,
} from "./geom";
import type {
  AreaState, AreaSummary, Cluster, ClusterEdit, DeadEndParams, Edits, FreeformParams, Imagery, Port, PointParams,
  RoundaboutParams, Segment, SegmentEdit, Span, TemplateType, XY,
} from "./types";
import "./style.css";

const PORT_FALLOFF = 20; // metres of a segment that follow a moved port
const HEADING_HANDLE = 4; // metres from a port to its heading handle
const CLICK_TOLERANCE_PX = 10;
const UNDO_LIMIT = 100;
const LAST_AREA_KEY = "annotator:last-area";

const TYPE_LABELS: Record<TemplateType, string> = {
  point: "Point (T, Y, crossroads…)",
  roundabout: "Roundabout",
  dead_end: "Dead end",
  freeform: "Freeform",
};
const CLUSTER_FLAGS: [string, string][] = [["topology_error", "OSM topology error"], ["skip", "Skip"]];
const SEGMENT_FLAGS: [string, string][] = [
  ["occluded", "Occluded (trees, shadow…)"], ["ambiguous", "Ambiguous centre"], ["skip", "Skip"],
];

type Selection = { kind: "cluster" | "segment"; id: string };
type HandleKind = "core" | "theta" | "radius" | "port" | "heading" | "vertex" | "fixed" | "width";
type EditMode = "centerline" | "cross-section";

interface Handle {
  xy: XY;
  kind: HandleKind;
  anchor?: XY; // draws a guide line from the anchor to the handle
  drag?: (xy: XY) => void;
  remove?: () => void;
}

interface Snapshot {
  clusters: Record<string, Cluster>;
  segments: Record<string, Segment>;
  ports: Record<string, Port>;
}

interface Converter {
  forward(p: number[]): number[];
  inverse(p: number[]): number[];
}

let area: AreaState | null = null;
let converter: Converter | null = null;
let selection: Selection | null = null;
let handles: Handle[] = [];
let dragging: { drag: (xy: XY) => void; before: Snapshot } | null = null;
let undoStack: Snapshot[] = [];
let showOsm = true;
let showBands = true;
let editMode: EditMode = "cross-section"; // what dragging a selected segment edits
let saving: Promise<void> = Promise.resolve();
let pendingSaves = 0;
let imagerySources: Imagery[] = [];
let shownImagery: string | null = null;

maplibregl.setWorkerUrl(maplibreWorkerUrl); // v6 loads its worker as a separate file

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- map

const map = new maplibregl.Map({
  container: "map",
  style: {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": "#1b1d21" } }],
  },
  center: [5.17, 52.027], // Houten
  zoom: 16,
  maxZoom: 23,
  doubleClickZoom: false,
});
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
map.keyboard.disableRotation();

const emptyFc = (): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: [] });
const SOURCES = [
  "bbox", "xs-bands", "xs-boundaries", "xs-markings", "xs-arrows",
  "osm", "segments", "templates", "ports", "handle-links", "handles",
] as const;
const source = (id: (typeof SOURCES)[number]) => map.getSource(id) as GeoJSONSource;

function addLayers() {
  for (const id of SOURCES) map.addSource(id, { type: "geojson", data: emptyFc() });

  map.addLayer({
    id: "bbox", type: "line", source: "bbox",
    paint: { "line-color": "#ffffff", "line-width": 1.5, "line-dasharray": [4, 3], "line-opacity": 0.6 },
  });
  // Cross-section overlay (line widths in metres are set per area, see setMetricWidths).
  map.addLayer({
    id: "xs-bands", type: "fill", source: "xs-bands",
    paint: {
      "fill-color": [
        "match", ["get", "kind"], ...BAND_KINDS.flatMap((k) => [k, KIND_COLORS[k]]), "#ffffff",
      ] as unknown as maplibregl.ExpressionSpecification,
      "fill-opacity": 0.38,
    },
  });
  map.addLayer({
    id: "xs-edges", type: "line", source: "xs-boundaries",
    paint: {
      "line-color": ["match", ["get", "physical"], "kerb", "#eeeeee", "low_kerb", "#bdbdbd", "#ffffff"],
      "line-opacity": ["match", ["get", "physical"], "kerb", 0.95, "low_kerb", 0.85, 0.35],
    },
  });
  map.addLayer({
    id: "xs-markings", type: "line", source: "xs-markings",
    paint: { "line-color": "#ffffff", "line-opacity": 0.95 },
  });
  map.addLayer({
    id: "xs-arrows", type: "line", source: "xs-arrows",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "xs-hit", type: "line", source: "xs-boundaries", filter: ["==", ["get", "segment_id"], ""],
    paint: { "line-width": 14, "line-opacity": 0 },
  });
  map.addLayer({
    id: "osm", type: "line", source: "osm",
    paint: { "line-color": "#ffd54f", "line-width": 1.2, "line-dasharray": [2, 2], "line-opacity": 0.75 },
  });
  map.addLayer({
    id: "segments", type: "line", source: "segments",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["get", "selected"], "#29b6f6", ["==", ["get", "status"], "done"], "#66bb6a", "#ff7043"],
      "line-width": ["case", ["get", "selected"], 4, 2.5],
      "line-opacity": ["case", ["get", "outside"], 0.4, 0.95],
    },
  });
  map.addLayer({
    id: "segments-flagged", type: "line", source: "segments", filter: ["get", "flagged"],
    paint: { "line-color": "#ff4081", "line-width": 6, "line-dasharray": [1, 2], "line-opacity": 0.8 },
  });
  map.addLayer({
    id: "templates", type: "line", source: "templates",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["case", ["get", "selected"], "#29b6f6", ["==", ["get", "status"], "done"], "#26a69a", "#ce93d8"],
      "line-width": ["case", ["get", "selected"], 4, 2.5],
      "line-opacity": ["case", ["get", "outside"], 0.35, 0.95],
    },
  });
  map.addLayer({
    id: "ports", type: "circle", source: "ports",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 1.5, 19, 4],
      "circle-color": "#ffffff", "circle-stroke-color": "#000000", "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: "handle-links", type: "line", source: "handle-links",
    paint: { "line-color": "#ffffff", "line-width": 1, "line-dasharray": [2, 2] },
  });
  map.addLayer({
    id: "handles", type: "circle", source: "handles",
    paint: {
      "circle-radius": [
        "match", ["get", "kind"], "core", 7, "port", 6, "radius", 6, "fixed", 3.5, "vertex", 4.5, "width", 4.5, 5,
      ],
      "circle-color": [
        "match", ["get", "kind"],
        "core", "#ffeb3b", "theta", "#ff9800", "radius", "#8bc34a", "port", "#ffffff",
        "heading", "#e91e63", "vertex", "#29b6f6", "width", "#00e5ff", "#9e9e9e",
      ],
      "circle-stroke-color": "#000000",
      "circle-stroke-width": 1.5,
    },
  });
}

/** A line width of `metres` at every zoom, for an area at latitude `lat`. */
function metricWidth(metres: number | maplibregl.ExpressionSpecification, lat: number) {
  const metresPerPixelAtZ0 = 78271.517 * Math.cos((lat * Math.PI) / 180); // 512 px tiles
  const at = (z: number) => ["*", metres, 2 ** z / metresPerPixelAtZ0];
  return ["interpolate", ["exponential", 2], ["zoom"], 10, at(10), 24, at(24)] as unknown as maplibregl.ExpressionSpecification;
}

function setMetricWidths(lat: number) {
  map.setPaintProperty("xs-edges", "line-width",
    metricWidth(["match", ["get", "physical"], "kerb", 0.25, "low_kerb", 0.15, 0.06], lat));
  map.setPaintProperty("xs-markings", "line-width", metricWidth(0.12, lat));
  map.setPaintProperty("xs-arrows", "line-width", metricWidth(0.12, lat));
}

/** Show `imagery` under the overlays. Areas are locked to the imagery they were annotated on. */
function showImagery(imagery: Imagery) {
  if (shownImagery === imagery.id) return;
  if (map.getLayer("imagery")) map.removeLayer("imagery");
  if (map.getSource("imagery")) map.removeSource("imagery");
  map.addSource("imagery", {
    type: "raster",
    tiles: [imagery.tiles],
    tileSize: 256,
    maxzoom: imagery.max_zoom,
    attribution:
      `${imagery.provider} ${imagery.year} (${imagery.license}) · Roads © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`,
  });
  map.addLayer({ id: "imagery", type: "raster", source: "imagery" }, "bbox");
  shownImagery = imagery.id;
}

// ---------------------------------------------------------------- coordinates

const toXY = (lngLat: { lng: number; lat: number }): XY => converter!.forward([lngLat.lng, lngLat.lat]) as XY;
const toLL = (xy: XY): [number, number] => converter!.inverse(xy) as [number, number];

function utmDefinition(epsg: number): string {
  const zone = epsg % 100;
  return `+proj=utm +zone=${zone}${epsg >= 32700 ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
}

function metresPerPixel(point: maplibregl.Point): number {
  const a = toXY(map.unproject(point));
  const b = toXY(map.unproject([point.x + 1, point.y]));
  return dist(a, b);
}

// ---------------------------------------------------------------- drawing

const lineFeature = (pts: XY[], properties: Record<string, unknown>): GeoJSON.Feature => ({
  type: "Feature", properties, geometry: { type: "LineString", coordinates: pts.map(toLL) },
});
const pointFeature = (xy: XY, properties: Record<string, unknown>): GeoJSON.Feature => ({
  type: "Feature", properties, geometry: { type: "Point", coordinates: toLL(xy) },
});

let redrawPending = false;
function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => {
    redrawPending = false;
    redraw();
  });
}

function isOutsideSegment(seg: Segment): boolean {
  if (!area || !seg.start_port || !seg.end_port) return false;
  const a = area.clusters[area.ports[seg.start_port].cluster_id];
  const b = area.clusters[area.ports[seg.end_port].cluster_id];
  return a.outside && b.outside;
}

interface OverlayFeatures {
  key: string;
  bands: GeoJSON.Feature[];
  boundaries: GeoJSON.Feature[];
  markings: GeoJSON.Feature[];
  arrows: GeoJSON.Feature[];
}
const overlayCache = new Map<string, OverlayFeatures>();

function overlayFor(seg: Segment, reuse: boolean): OverlayFeatures {
  const cached = overlayCache.get(seg.id);
  if (cached && reuse) return cached;
  const key = JSON.stringify([seg.centerline, seg.spans]);
  if (cached && cached.key === key) return cached;
  const o = segmentOverlay(seg.centerline!, seg.spans!);
  const polygon = (ring: XY[], properties: Record<string, unknown>): GeoJSON.Feature => ({
    type: "Feature", properties, geometry: { type: "Polygon", coordinates: [ring.map(toLL)] },
  });
  const features: OverlayFeatures = {
    key,
    bands: o.bands.map((b) => polygon(b.ring, { kind: b.kind, segment_id: seg.id })),
    boundaries: o.boundaries.map((b) =>
      lineFeature(b.line, { physical: b.physical, segment_id: seg.id, span: b.span, boundary: b.boundary })),
    markings: o.markings.map((m) => lineFeature(m, {})),
    arrows: o.arrows.map((a) => lineFeature(a, {})),
  };
  overlayCache.set(seg.id, features);
  return features;
}

function redrawOverlay() {
  const bands: GeoJSON.Feature[] = [], boundaries: GeoJSON.Feature[] = [];
  const markings: GeoJSON.Feature[] = [], arrows: GeoJSON.Feature[] = [];
  if (area && showBands) {
    // While dragging, only the selection's segments can change.
    const scope = dragging && selection ? new Set(relatedIds(selection).segments) : null;
    for (const seg of Object.values(area.segments)) {
      if (seg.internal || !seg.centerline || !seg.spans) continue;
      const o = overlayFor(seg, scope !== null && !scope.has(seg.id));
      bands.push(...o.bands);
      boundaries.push(...o.boundaries);
      markings.push(...o.markings);
      arrows.push(...o.arrows);
    }
  }
  source("xs-bands").setData({ type: "FeatureCollection", features: bands });
  source("xs-boundaries").setData({ type: "FeatureCollection", features: boundaries });
  source("xs-markings").setData({ type: "FeatureCollection", features: markings });
  source("xs-arrows").setData({ type: "FeatureCollection", features: arrows });
  const editable = selection?.kind === "segment" && editMode === "cross-section" ? selection.id : "";
  map.setFilter("xs-hit", ["==", ["get", "segment_id"], editable]);
}

function redraw() {
  if (!area || !converter) {
    for (const id of SOURCES) source(id).setData(emptyFc());
    handles = [];
    return;
  }
  const osm: GeoJSON.Feature[] = [];
  const segments: GeoJSON.Feature[] = [];
  const tpl: GeoJSON.Feature[] = [];
  const ports: GeoJSON.Feature[] = [];

  for (const seg of Object.values(area.segments)) {
    if (showOsm) osm.push(lineFeature(seg.osm_polyline, {}));
    if (seg.internal || !seg.centerline) continue;
    segments.push(lineFeature(seg.centerline, {
      id: seg.id,
      status: seg.status,
      selected: selection?.kind === "segment" && selection.id === seg.id,
      flagged: seg.flags.length > 0,
      outside: isOutsideSegment(seg),
    }));
  }
  for (const c of Object.values(area.clusters)) {
    const selected = selection?.kind === "cluster" && selection.id === c.id;
    for (const curve of renderCluster(area, c)) {
      tpl.push(lineFeature(curve.points, { cluster_id: c.id, status: c.status, selected, outside: c.outside }));
    }
  }
  for (const p of Object.values(area.ports)) ports.push(pointFeature(p.xy, { cluster_id: p.cluster_id }));

  handles = buildHandles();
  redrawOverlay();
  source("osm").setData({ type: "FeatureCollection", features: osm });
  source("segments").setData({ type: "FeatureCollection", features: segments });
  source("templates").setData({ type: "FeatureCollection", features: tpl });
  source("ports").setData({ type: "FeatureCollection", features: ports });
  source("handles").setData({
    type: "FeatureCollection",
    features: handles.map((h, index) => pointFeature(h.xy, { index, kind: h.kind })),
  });
  source("handle-links").setData({
    type: "FeatureCollection",
    features: [
      ...handles.filter((h) => h.anchor).map((h) => lineFeature([h.anchor!, h.xy], {})),
      ...directionMarker().map((line) => lineFeature(line, {})),
    ],
  });
}

function drawBbox() {
  if (!area) return source("bbox").setData(emptyFc());
  const [w, s, e, n] = area.bbox;
  source("bbox").setData({
    type: "Feature", properties: {},
    geometry: { type: "LineString", coordinates: [[w, s], [e, s], [e, n], [w, n], [w, s]] },
  });
}

// ---------------------------------------------------------------- handles

/** Move a port, dragging its segment's end along with a linear falloff. */
function movePort(pid: string, xy: XY) {
  const port = area!.ports[pid];
  const delta = sub(xy, port.xy);
  port.xy = xy;
  const seg = area!.segments[port.segment_id];
  if (seg.centerline) {
    const falloff = Math.min(PORT_FALLOFF, polylineLength(seg.centerline) / 2);
    seg.centerline = shiftEnd(seg.centerline, port.end === "start", delta, falloff);
  }
  const cluster = area!.clusters[port.cluster_id];
  if (cluster.type === "freeform") (cluster.params as FreeformParams).nodes[`port:${pid}`] = xy;
}

function portHandles(pid: string, withHeading: boolean): Handle[] {
  const port = area!.ports[pid];
  const hs: Handle[] = [{ xy: port.xy, kind: "port", drag: (xy) => movePort(pid, xy) }];
  if (withHeading) {
    hs.push({
      xy: add(port.xy, scale(unit(port.heading), HEADING_HANDLE)),
      anchor: port.xy,
      kind: "heading",
      drag: (xy) => {
        const p = area!.ports[pid];
        p.heading = angleOf(sub(xy, p.xy));
      },
    });
  }
  return hs;
}

function clusterHandles(cid: string): Handle[] {
  const cluster = area!.clusters[cid];
  const params = <T>() => area!.clusters[cid].params as T;
  const hs: Handle[] = [];

  if (cluster.type === "freeform") {
    const p = params<FreeformParams>();
    for (const [nid, xy] of Object.entries(p.nodes)) {
      if (nid.startsWith("port:")) {
        hs.push(...portHandles(nid.slice(5), false));
      } else {
        hs.push({ xy, kind: "core", drag: (to) => { params<FreeformParams>().nodes[nid] = to; } });
      }
    }
    p.edges.forEach((edge, e) => {
      edge.interior.forEach((xy, k) => {
        hs.push({
          xy,
          kind: "vertex",
          drag: (to) => { params<FreeformParams>().edges[e].interior[k] = to; },
          remove: () => { params<FreeformParams>().edges[e].interior.splice(k, 1); },
        });
      });
    });
    return hs;
  }

  if (cluster.type === "point" || cluster.type === "dead_end") {
    const key = cluster.type === "point" ? "center" : "end";
    const core = () => (params<Record<string, XY>>())[key];
    hs.push({ xy: core(), kind: "core", drag: (to) => { (params<Record<string, XY>>())[key] = to; } });
    (cluster.params as PointParams | DeadEndParams).arms.forEach((arm, i) => {
      const reach = Math.max(2, 0.35 * dist(area!.ports[arm.port_id].xy, core()));
      hs.push({
        xy: add(core(), scale(unit(arm.theta), reach)),
        anchor: core(),
        kind: "theta",
        drag: (to) => { params<PointParams>().arms[i].theta = angleOf(sub(to, core())); },
      });
      hs.push(...portHandles(arm.port_id, true));
    });
    return hs;
  }

  // roundabout
  const p = params<RoundaboutParams>();
  hs.push({ xy: p.center, kind: "core", drag: (to) => { params<RoundaboutParams>().center = to; } });
  const gap = largestGapMid(p.arms.map((a) => a.theta));
  hs.push({
    xy: add(p.center, scale(unit(gap), p.radius)),
    anchor: p.center,
    kind: "radius",
    drag: (to) => {
      const q = params<RoundaboutParams>();
      q.radius = Math.max(1, dist(to, q.center));
    },
  });
  p.arms.forEach((arm, i) => {
    hs.push({
      xy: add(p.center, scale(unit(arm.theta), p.radius)),
      kind: "theta",
      drag: (to) => {
        const q = params<RoundaboutParams>();
        q.arms[i].theta = angleOf(sub(to, q.center));
      },
    });
    hs.push(...portHandles(arm.port_id, true));
  });
  return hs;
}

/** Drag boundary `j` of width point `k` in span `si` of a segment. */
function widthDrag(sid: string, si: number, k: number, j: number) {
  return (xy: XY) => {
    const seg = area!.segments[sid];
    const span = seg.spans![si];
    const wp = span.width_points[k];
    const st = stationAt(seg.centerline!, wp.s);
    const v = (xy[0] - st.p[0]) * st.right[0] + (xy[1] - st.p[1]) * st.right[1];
    moveBoundary(span.bands, wp, j, v - boundaryOffsets(span.bands, wp.widths, wp.shift)[j]);
  };
}

function widthHandles(sid: string): Handle[] {
  const seg = area!.segments[sid];
  if (!seg.centerline || !seg.spans) return [];
  const hs: Handle[] = [];
  seg.spans.forEach((span, si) => {
    span.width_points.forEach((wp, k) => {
      const st = stationAt(seg.centerline!, wp.s);
      const v = boundaryOffsets(span.bands, wp.widths, wp.shift);
      v.forEach((offset, j) => {
        hs.push({
          xy: at(st, offset),
          kind: "width",
          anchor: j > 0 ? at(st, v[j - 1]) : undefined,
          drag: widthDrag(sid, si, k, j),
          remove: span.width_points.length > 1
            ? () => { area!.segments[sid].spans![si].width_points.splice(k, 1); }
            : undefined,
        });
      });
    });
  });
  return hs;
}

/** A chevron showing the selected segment's direction, which is what "left" and "right" refer to. */
function directionMarker(): XY[][] {
  if (!area || selection?.kind !== "segment") return [];
  const line = area.segments[selection.id].centerline;
  if (!line) return [];
  const st = stationAt(line, polylineLength(line) / 2);
  const tip = add(st.p, scale(st.forward, 1.5));
  const back = sub(st.p, scale(st.forward, 0.5));
  return [[add(back, scale(st.right, 1)), tip, sub(back, scale(st.right, 1))]];
}

function segmentHandles(sid: string): Handle[] {
  if (editMode === "cross-section") return widthHandles(sid);
  const seg = area!.segments[sid];
  if (!seg.centerline) return [];
  const last = seg.centerline.length - 1;
  return seg.centerline.map((xy, k): Handle =>
    k === 0 || k === last
      ? { xy, kind: "fixed" }
      : {
          xy,
          kind: "vertex",
          drag: (to) => { area!.segments[sid].centerline![k] = to; },
          remove: () => { area!.segments[sid].centerline!.splice(k, 1); },
        },
  );
}

function buildHandles(): Handle[] {
  if (!area || !selection) return [];
  return selection.kind === "cluster" ? clusterHandles(selection.id) : segmentHandles(selection.id);
}

// ---------------------------------------------------------------- edits, saving, undo

function relatedIds(sel: Selection): { clusters: string[]; segments: string[]; ports: string[] } {
  if (sel.kind === "segment") return { clusters: [], segments: [sel.id], ports: [] };
  const cluster = area!.clusters[sel.id];
  return {
    clusters: [sel.id],
    ports: [...cluster.port_ids],
    segments: cluster.port_ids.map((p) => area!.ports[p].segment_id),
  };
}

function snapshot(ids: { clusters: string[]; segments: string[]; ports: string[] }): Snapshot {
  const pick = <T>(table: Record<string, T>, keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, structuredClone(table[k])]));
  return {
    clusters: pick(area!.clusters, ids.clusters),
    segments: pick(area!.segments, ids.segments),
    ports: pick(area!.ports, ids.ports),
  };
}

const idsOf = (s: Snapshot) => ({
  clusters: Object.keys(s.clusters), segments: Object.keys(s.segments), ports: Object.keys(s.ports),
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The edits that turn `base` into `target` (both snapshots of the same entities). */
function editsFor(base: Snapshot, target: Snapshot): Edits {
  const edits = { clusters: {} as Record<string, ClusterEdit>, segments: {} as Record<string, SegmentEdit>, ports: {} as Edits["ports"] & {} };
  for (const [id, t] of Object.entries(target.clusters)) {
    const b = base.clusters[id];
    const e: ClusterEdit = {};
    if (b.type !== t.type || !same(b.params, t.params)) Object.assign(e, { type: t.type, params: t.params });
    if (!same(b.flags, t.flags)) e.flags = t.flags;
    if (b.status !== t.status) e.status = t.status;
    if (Object.keys(e).length) edits.clusters[id] = e;
  }
  for (const [id, t] of Object.entries(target.segments)) {
    const b = base.segments[id];
    const e: SegmentEdit = {};
    if (!same(b.centerline, t.centerline) && t.centerline) e.centerline = t.centerline;
    if (!same(b.flags, t.flags)) e.flags = t.flags;
    if (!same(b.spans, t.spans) && t.spans) e.spans = t.spans;
    if (b.status !== t.status) e.status = t.status;
    if (Object.keys(e).length) edits.segments[id] = e;
  }
  for (const [id, t] of Object.entries(target.ports)) {
    const b = base.ports[id];
    if (!same(b.xy, t.xy) || b.heading !== t.heading) edits.ports[id] = { xy: t.xy, heading: t.heading };
  }
  return edits;
}

const isEmpty = (e: Edits) =>
  !Object.keys(e.clusters ?? {}).length && !Object.keys(e.segments ?? {}).length && !Object.keys(e.ports ?? {}).length;

function restore(snap: Snapshot) {
  for (const [id, v] of Object.entries(snap.clusters)) area!.clusters[id] = structuredClone(v);
  for (const [id, v] of Object.entries(snap.segments)) area!.segments[id] = structuredClone(v);
  for (const [id, v] of Object.entries(snap.ports)) area!.ports[id] = structuredClone(v);
}

/** Save whatever changed in the entities captured by `before`, and make it undoable. */
function commit(before: Snapshot) {
  if (!area) return;
  // Positions along a segment (spans, width points, flags) stretch with its centerline.
  for (const [sid, old] of Object.entries(before.segments)) {
    const seg = area.segments[sid];
    if (!old.centerline || !seg.centerline) continue;
    const factor = polylineLength(seg.centerline) / polylineLength(old.centerline);
    if (!Number.isFinite(factor) || Math.abs(factor - 1) < 1e-12) continue;
    if (seg.spans && same(old.spans, seg.spans)) rescaleSpans(seg.spans, factor);
    if (same(old.flags, seg.flags)) {
      for (const f of seg.flags) {
        f.s_from *= factor;
        if (f.s_to !== null) f.s_to *= factor;
      }
    }
  }
  const edits = editsFor(before, snapshot(idsOf(before)));
  scheduleRedraw();
  renderPanel();
  if (isEmpty(edits)) return;
  undoStack.push(before);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  send(edits);
}

function send(edits: Edits) {
  const areaId = area!.id;
  pendingSaves++;
  setStatus("Saving…");
  saving = saving.then(async () => {
    try {
      const res = await api.postEdits(areaId, edits);
      pendingSaves--;
      if (area?.id !== areaId) return;
      // Only take the server's copy when no newer local edit is waiting to be saved.
      if (pendingSaves === 0 && !dragging) {
        Object.assign(area.clusters, res.changed.clusters);
        Object.assign(area.segments, res.changed.segments);
        Object.assign(area.ports, res.changed.ports);
      }
      showSummary(res.summary);
      if (pendingSaves === 0) setStatus("Saved");
    } catch (err) {
      pendingSaves--;
      setStatus(`Save failed: ${(err as Error).message}. Reloaded the area from the server.`, true);
      if (area?.id === areaId) await loadArea(areaId, false);
    }
    scheduleRedraw();
    renderPanel();
  });
}

function undo() {
  const snap = undoStack.pop();
  if (!snap || !area) return;
  const edits = editsFor(snapshot(idsOf(snap)), snap);
  restore(snap);
  scheduleRedraw();
  renderPanel();
  if (!isEmpty(edits)) send(edits);
}

/** Change the selection's entities with `mutate`, then save. */
function edit(mutate: () => void) {
  if (!area || !selection) return;
  const before = snapshot(relatedIds(selection));
  mutate();
  commit(before);
}

// ---------------------------------------------------------------- selection and navigation

function select(sel: Selection | null, fly = false) {
  selection = sel;
  history.replaceState(null, "", sel ? `#${sel.kind}=${sel.id}` : location.pathname + location.search);
  renderPanel();
  scheduleRedraw();
  if (sel && fly) flyTo(sel);
}

/** Select the item named in the URL hash (#cluster=c12 or #segment=s40), if it exists. */
function selectFromHash(): boolean {
  const m = location.hash.match(/^#(cluster|segment)=([\w:-]+)$/);
  if (!area || !m) return false;
  const [, kind, id] = m as unknown as [string, Selection["kind"], string];
  if (!(kind === "cluster" ? area.clusters[id] : area.segments[id])) return false;
  select({ kind, id }, true);
  return true;
}

function selectionPoints(sel: Selection): XY[] {
  if (sel.kind === "segment") return area!.segments[sel.id].centerline ?? [];
  const cluster = area!.clusters[sel.id];
  return [...renderCluster(area!, cluster).flatMap((c) => c.points), ...cluster.port_ids.map((p) => area!.ports[p].xy)];
}

function flyTo(sel: Selection) {
  const lls = selectionPoints(sel).map(toLL);
  if (!lls.length) return;
  const bounds = new maplibregl.LngLatBounds(lls[0], lls[0]);
  for (const ll of lls) bounds.extend(ll);
  map.fitBounds(bounds, { padding: 140, maxZoom: 20.5, duration: 400 });
}

function nextUnreviewed() {
  if (!area) return;
  const here = toXY(map.getCenter());
  const nearest = <T>(items: T[], at: (t: T) => XY) =>
    items.reduce<T | null>((best, t) => (best === null || dist(at(t), here) < dist(at(best), here) ? t : best), null);

  const isCurrent = (kind: Selection["kind"], id: string) => selection?.kind === kind && selection.id === id;
  const clusters = Object.values(area.clusters).filter(
    (c) => !c.outside && c.status === "unreviewed" && !isCurrent("cluster", c.id),
  );
  const c = nearest(clusters, (c) => c.osm_center);
  if (c) return select({ kind: "cluster", id: c.id }, true);

  const segments = Object.values(area.segments).filter(
    (s) => !s.internal && s.centerline && s.status === "unreviewed" && !isOutsideSegment(s) && !isCurrent("segment", s.id),
  );
  const s = nearest(segments, (s) => s.centerline![Math.floor(s.centerline!.length / 2)]);
  if (s) return select({ kind: "segment", id: s.id }, true);
  select(null);
  setStatus("Everything in this area has been reviewed.");
}

// ---------------------------------------------------------------- other maps

type ExternalMap = "google" | "streetview" | "osm";

/**
 * Open the current view in another map. MapLibre zoom levels are for 512 px
 * tiles; Google and OSM use 256 px tiles, so their zoom is one higher.
 */
function openExternal(target: ExternalMap) {
  const { lng, lat } = map.getCenter();
  const zoom = Math.round(map.getZoom() + 1);
  const ll = `${lat.toFixed(6)},${lng.toFixed(6)}`;
  let url: string;
  if (target === "google") {
    url = `https://www.google.com/maps/@?api=1&map_action=map&center=${ll}&zoom=${Math.min(zoom, 21)}&basemap=satellite`;
  } else if (target === "streetview") {
    url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${ll}`;
    const heading = roadHeading();
    if (heading !== null) url += `&heading=${heading.toFixed(0)}`;
  } else {
    url = `https://www.openstreetmap.org/#map=${Math.min(zoom, 19)}/${lat.toFixed(6)}/${lng.toFixed(6)}`;
  }
  window.open(url, "_blank", "noopener");
}

/** Compass heading (degrees) of the selected segment where it passes the map centre, if one is selected. */
function roadHeading(): number | null {
  if (!area || !converter || selection?.kind !== "segment") return null;
  const line = area.segments[selection.id].centerline;
  if (!line) return null;
  const st = stationAt(line, arcLengthOf(line, toXY(map.getCenter())));
  return ((Math.atan2(st.forward[0], st.forward[1]) * 180) / Math.PI + 360) % 360;
}

function setSelectionStatus(status: "done" | "unreviewed") {
  if (!selection) return;
  const sel = selection;
  edit(() => {
    if (sel.kind === "cluster") area!.clusters[sel.id].status = status;
    else area!.segments[sel.id].status = status;
  });
}

// ---------------------------------------------------------------- sidebar

function setStatus(message: string, error = false) {
  const el = $("status");
  el.textContent = message;
  el.classList.toggle("error", error);
}

function showSummary(summary: AreaSummary) {
  $("progress").textContent =
    `Intersections ${summary.clusters.done}/${summary.clusters.total} · Segments ${summary.segments.done}/${summary.segments.total}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", {}, label);
  b.addEventListener("click", onClick);
  return b;
}

function checkboxes(options: [string, string][], checked: string[], onChange: (values: string[]) => void) {
  const box = el("fieldset", {}, el("legend", {}, "Flags"));
  for (const [value, label] of options) {
    const input = el("input", { type: "checkbox", value });
    input.checked = checked.includes(value);
    input.addEventListener("change", () => {
      onChange([...box.querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value));
    });
    box.append(el("label", { class: "check" }, input, label));
  }
  return box;
}

function osmLink(kind: "node" | "way", id: number) {
  return el("a", { href: `https://www.openstreetmap.org/${kind}/${id}`, target: "_blank", rel: "noopener" }, String(id));
}

function statusRow(status: string, source: string) {
  return el("p", {}, "Status: ", el("b", {}, status), ` · geometry from ${source}`);
}

function renderPanel() {
  const panel = $("selection");
  panel.replaceChildren();
  if (!area || !selection) {
    panel.append(el("p", { class: "muted" }, area ? "Click an intersection or road, or press N." : "Choose or create an area."));
    return;
  }
  if (selection.kind === "cluster") renderClusterPanel(panel, area.clusters[selection.id]);
  else renderSegmentPanel(panel, area.segments[selection.id]);
}

function renderClusterPanel(panel: HTMLElement, cluster: Cluster) {
  const facts = [
    `${cluster.junction_ids.length} junction${cluster.junction_ids.length === 1 ? "" : "s"}`,
    `${cluster.port_ids.length} port${cluster.port_ids.length === 1 ? "" : "s"}`,
  ];
  if (cluster.roundabout) facts.push("tagged roundabout");
  if (cluster.outside) facts.push("outside the area");
  panel.append(el("h2", {}, `Intersection ${cluster.id}`), el("p", { class: "muted" }, facts.join(" · ")));

  const typeSelect = el("select");
  for (const t of validTypes(cluster)) typeSelect.append(el("option", { value: t }, TYPE_LABELS[t]));
  typeSelect.value = cluster.type;
  typeSelect.addEventListener("change", () => changeTemplate(cluster.id, typeSelect.value as TemplateType, false));
  panel.append(el("label", {}, "Template ", typeSelect));

  if (cluster.type === "dead_end") {
    const input = el("input", { type: "number", min: "0", step: "0.5" });
    input.value = String((cluster.params as DeadEndParams).turn_radius);
    input.addEventListener("change", () => {
      const r = Math.max(0, Number(input.value) || 0);
      edit(() => { (area!.clusters[cluster.id].params as DeadEndParams).turn_radius = r; });
    });
    panel.append(el("label", {}, "Turning circle radius (m) ", input));
  }

  panel.append(
    checkboxes(CLUSTER_FLAGS, cluster.flags, (flags) => edit(() => { area!.clusters[cluster.id].flags = flags; })),
    statusRow(cluster.status, cluster.source),
    el("div", { class: "buttons" },
      cluster.status === "done"
        ? button("Mark unreviewed", () => setSelectionStatus("unreviewed"))
        : button("Mark done (D)", () => { setSelectionStatus("done"); nextUnreviewed(); }),
      button("Reset to OSM", () => changeTemplate(cluster.id, cluster.type, true)),
    ),
    el("p", { class: "muted small" }, "OSM nodes: ",
      ...cluster.junction_ids.flatMap((j, i) => [i ? ", " : "", osmLink("node", area!.junctions[j].osm_node_id)])),
    el("p", { class: "muted small" }, handleLegend(cluster.type)),
  );
}

function handleLegend(type: TemplateType): string {
  if (type === "freeform") return "Drag nodes and vertices. Double-click an edge to add a vertex; right-click a vertex to delete it.";
  const core = type === "dead_end" ? "end point" : "centre";
  const theta = type === "roundabout" ? "orange = where an arm meets the ring, green = ring radius" : "orange = arm direction";
  return `Yellow = ${core}, ${theta}, white = port, pink = port heading.`;
}

function renderSegmentPanel(panel: HTMLElement, seg: Segment) {
  const facts = [seg.highway ?? "road", `${polylineLength(seg.centerline ?? []).toFixed(1)} m`];
  if (seg.name) facts.splice(1, 0, seg.name);
  if (seg.oneway) facts.push("one-way");
  if (seg.bridge) facts.push("bridge");
  panel.append(
    el("h2", {}, `Road segment ${seg.id}`),
    el("p", { class: "muted" }, facts.join(" · ")),
    checkboxes(SEGMENT_FLAGS, seg.flags.map((f) => f.kind), (kinds) =>
      edit(() => { area!.segments[seg.id].flags = kinds.map((kind) => ({ kind, s_from: 0, s_to: null })); })),
    statusRow(seg.status, seg.source),
    el("div", { class: "buttons" },
      seg.status === "done"
        ? button("Mark unreviewed", () => setSelectionStatus("unreviewed"))
        : button("Mark done (D)", () => { setSelectionStatus("done"); nextUnreviewed(); }),
      button("Reset to OSM", () => edit(() => {
        const s = area!.segments[seg.id];
        if (!s.guide_line || !s.start_port || !s.end_port) return;
        const line = structuredClone(s.guide_line);
        line[0] = area!.ports[s.start_port].xy;
        line[line.length - 1] = area!.ports[s.end_port].xy;
        s.centerline = line;
      })),
    ),
    el("p", { class: "muted small" }, "OSM ways: ",
      ...seg.osm_way_ids.flatMap((w, i) => [i ? ", " : "", osmLink("way", w)])),
    el("div", { class: "mode" },
      modeButton("cross-section", "Cross-section"),
      modeButton("centerline", "Centerline"),
      el("span", { class: "muted small" }, "X switches"),
    ),
  );
  if (editMode === "centerline") {
    panel.append(el("p", { class: "muted small" },
      "Ends are fixed to the intersections' ports; move them from the intersection. Double-click the line to add a vertex; right-click a vertex to delete it."));
  } else {
    renderCrossSectionEditor(panel, seg);
  }
}

function modeButton(mode: EditMode, label: string) {
  const b = button(label, () => setEditMode(mode));
  if (editMode === mode) b.classList.add("active");
  return b;
}

function setEditMode(mode: EditMode) {
  editMode = mode;
  renderPanel();
  scheduleRedraw();
}

/** Change one span of the selected segment, rejecting band lists the spec doesn't allow. */
function editSpan(sid: string, si: number, mutate: (span: Span) => void) {
  if (!area) return;
  const before = snapshot({ clusters: [], segments: [sid], ports: [] });
  mutate(area.segments[sid].spans![si]);
  const problem = bandProblem(area.segments[sid].spans![si].bands);
  if (problem) {
    restore(before);
    setStatus(problem, true);
    renderPanel();
    scheduleRedraw();
    return;
  }
  commit(before);
}

function selectInput(options: readonly string[], value: string, onChange: (v: string) => void, labels?: Record<string, string>) {
  const input = el("select");
  for (const o of options) input.append(el("option", { value: o }, labels?.[o] ?? o.replaceAll("_", " ")));
  input.value = value;
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

const DIRECTION_LABELS = { forward: "→ forward", backward: "← backward", both: "↔ both" };

function renderCrossSectionEditor(panel: HTMLElement, seg: Segment) {
  if (!seg.spans) return;
  const sid = seg.id;
  panel.append(
    el("h3", {}, "Cross-section"),
    el("p", { class: "muted small" },
      "Listed left to right, in the direction of the arrow on the road. Drag the cyan handles to change widths; drag any edge to add a width point there; right-click a handle to remove its width point."),
  );
  seg.spans.forEach((span, si) => {
    if (seg.spans!.length > 1) panel.append(el("p", { class: "small" }, `From ${span.s_from.toFixed(1)} m to ${span.s_to.toFixed(1)} m`));
    const list = el("div", { class: "xs-list" });
    const widthText = (i: number) => {
      const ws = span.width_points.map((wp) => wp.widths[i]);
      const lo = Math.min(...ws), hi = Math.max(...ws);
      return hi - lo < 0.05 ? `${lo.toFixed(2)} m` : `${lo.toFixed(2)}–${hi.toFixed(2)} m`;
    };
    const boundaryRow = (j: number) => {
      const b = span.boundaries[j];
      const add = el("select", { class: "add" });
      add.append(el("option", { value: "" }, "+ band"));
      for (const k of BAND_KINDS) add.append(el("option", { value: k }, KIND_LABELS[k]));
      add.addEventListener("change", () => {
        const kind = add.value as (typeof BAND_KINDS)[number];
        if (kind) editSpan(sid, si, (s) => insertBand(s, j, kind));
      });
      return el("div", { class: "xs-boundary" },
        selectInput(PHYSICAL, b.physical, (v) => editSpan(sid, si, (s) => { s.boundaries[j].physical = v as typeof b.physical; })),
        selectInput(MARKINGS, b.marking, (v) => editSpan(sid, si, (s) => { s.boundaries[j].marking = v as typeof b.marking; })),
        add,
      );
    };
    span.bands.forEach((band, i) => {
      list.append(boundaryRow(i));
      const attrs = el("div", { class: "xs-attrs" });
      const setAttr = (key: string, value: unknown) => editSpan(sid, si, (s) => { s.bands[i].attributes[key] = value; });
      if (band.kind === "lane") {
        attrs.append(
          selectInput(LANE_DIRECTIONS, band.attributes.direction as string, (v) => setAttr("direction", v), DIRECTION_LABELS),
          selectInput(LANE_TURNS, band.attributes.turn as string, (v) => setAttr("turn", v)),
        );
        const uses = el("span", { class: "uses" });
        for (const u of LANE_USES) {
          const box = el("input", { type: "checkbox" });
          box.checked = (band.attributes.use as string[]).includes(u);
          box.addEventListener("change", () => {
            const current = new Set(band.attributes.use as string[]);
            if (box.checked) current.add(u); else current.delete(u);
            if (!current.size) return renderPanel(); // a lane needs at least one use
            setAttr("use", LANE_USES.filter((x) => current.has(x)));
          });
          uses.append(el("label", { class: "check" }, box, u.replaceAll("_", " ")));
        }
        attrs.append(uses);
      } else if (band.kind === "parking") {
        attrs.append(
          selectInput(PARKING_ARRANGEMENTS, band.attributes.arrangement as string, (v) => setAttr("arrangement", v)),
          selectInput(PARKING_SURFACES, band.attributes.surface as string, (v) => setAttr("surface", v)),
        );
      } else if (band.kind === "median") {
        attrs.append(selectInput(MEDIAN_SURFACES, band.attributes.surface as string, (v) => setAttr("surface", v)));
      }
      const kind = selectInput(BAND_KINDS, band.kind, (v) => editSpan(sid, si, (s) => {
        const k = v as (typeof BAND_KINDS)[number];
        s.bands[i] = { kind: k, attributes: defaultAttributes(k) };
      }), KIND_LABELS);
      const remove = button("✕", () => editSpan(sid, si, (s) => removeBand(s, i)));
      remove.title = "Remove band";
      list.append(el("div", { class: "xs-band" },
        el("span", { class: "swatch", style: `background:${KIND_COLORS[band.kind]}` }),
        kind,
        el("span", { class: "muted small width" }, widthText(i)),
        remove,
        attrs,
      ));
    });
    list.append(boundaryRow(span.bands.length));
    panel.append(list, el("p", { class: "muted small" },
      `${span.width_points.length} width point${span.width_points.length === 1 ? "" : "s"}`));
  });
  panel.append(el("div", { class: "buttons" }, button("Reset cross-section to OSM", () => resetCrossSection(sid))));
}

async function resetCrossSection(sid: string) {
  if (!area) return;
  const areaId = area.id;
  await saving; // the server computes from the saved centerline
  try {
    const res = await api.defaultCrossSection(areaId, sid);
    if (area?.id !== areaId) return;
    const before = snapshot({ clusters: [], segments: [sid], ports: [] });
    area.segments[sid].spans = res.spans;
    commit(before);
  } catch (err) {
    setStatus((err as Error).message, true);
  }
}

async function changeTemplate(cid: string, type: TemplateType, resetPorts: boolean) {
  if (!area) return;
  const areaId = area.id;
  await saving; // the server computes from saved ports
  try {
    const res = await api.initCluster(areaId, cid, type, resetPorts);
    if (area?.id !== areaId) return;
    const before = snapshot(relatedIds({ kind: "cluster", id: cid }));
    for (const [pid, p] of Object.entries(res.ports)) {
      movePort(pid, p.xy);
      area.ports[pid].heading = p.heading;
    }
    const cluster = area.clusters[cid];
    cluster.type = res.type;
    cluster.params = res.params;
    commit(before);
  } catch (err) {
    setStatus((err as Error).message, true);
    renderPanel();
  }
}

// ---------------------------------------------------------------- areas

async function refreshAreaList(selected?: string) {
  const areas = await api.listAreas();
  const sel = $<HTMLSelectElement>("area-select");
  sel.replaceChildren(el("option", { value: "" }, "— choose an area —"));
  for (const a of areas) sel.append(el("option", { value: a.id }, a.name));
  sel.value = selected ?? "";
  return areas;
}

async function loadArea(id: string, fit = true) {
  setStatus("Loading…");
  const state = await api.getArea(id);
  area = state;
  overlayCache.clear();
  showImagery(state.imagery);
  $("area-imagery").textContent = `Imagery: ${state.imagery.name}, locked to this area`;
  converter = proj4("EPSG:4326", utmDefinition(state.epsg)) as unknown as Converter;
  setMetricWidths((state.bbox[1] + state.bbox[3]) / 2);
  if (selection && !(selection.kind === "cluster" ? state.clusters[selection.id] : state.segments[selection.id])) {
    selection = null;
  }
  if (fit) {
    selection = null;
    undoStack = [];
    if (!selectFromHash()) {
      const [w, s, e, n] = state.bbox;
      map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0 });
    }
  }
  try {
    localStorage.setItem(LAST_AREA_KEY, id);
  } catch {
    // storage unavailable; nothing to remember
  }
  const link = $<HTMLAnchorElement>("export-link");
  link.href = api.exportUrl(id);
  link.download = `${id}-centerlines.geojson`;
  link.hidden = false;
  $<HTMLSelectElement>("area-select").value = id;
  const summary = (await api.listAreas()).find((a) => a.id === id);
  if (summary) showSummary(summary);
  drawBbox();
  redraw();
  renderPanel();
  setStatus("");
}

async function newArea() {
  const b = map.getBounds();
  const name = prompt("Name for the new area:");
  if (!name) return;
  setStatus("Fetching OSM roads and building intersections…");
  try {
    const imagery = $<HTMLSelectElement>("imagery-select").value;
    const summary = await api.createArea(name, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], imagery);
    await refreshAreaList(summary.id);
    await loadArea(summary.id);
  } catch (err) {
    setStatus(`Could not create area: ${(err as Error).message}`, true);
  }
}

// ---------------------------------------------------------------- events

function handleAt(e: MapMouseEvent): number | null {
  const f = map.queryRenderedFeatures(e.point, { layers: ["handles"] })[0];
  return f ? (f.properties.index as number) : null;
}

function bindMapEvents() {
  map.on("mousedown", (e) => {
    if (e.originalEvent.button !== 0 || !selection || !area) return;
    const index = handleAt(e);
    const drag = index === null ? null : handles[index]?.drag;
    if (drag) {
      e.preventDefault(); // stops the map panning
      dragging = { drag, before: snapshot(relatedIds(selection)) };
      map.getCanvas().style.cursor = "grabbing";
      return;
    }
    // Cross-section mode: dragging an edge of the selected segment adds a width point there.
    if (selection.kind !== "segment" || editMode !== "cross-section") return;
    const hit = map.queryRenderedFeatures(e.point, { layers: ["xs-hit"] })[0];
    if (!hit) return;
    const sid = selection.id;
    const seg = area.segments[sid];
    if (!seg.centerline || !seg.spans) return;
    e.preventDefault();
    const before = snapshot(relatedIds(selection));
    const s = arcLengthOf(seg.centerline, toXY(e.lngLat));
    const si = spanIndexAt(seg.spans, s);
    const span = seg.spans[si];
    let k = span.width_points.findIndex((wp) => Math.abs(wp.s - s) < 1.5);
    if (k < 0) {
      const { widths, shift } = widthsAt(span, s);
      span.width_points.push({ s, widths, shift });
      span.width_points.sort((a, b) => a.s - b.s);
      k = span.width_points.findIndex((wp) => wp.s === s);
    }
    dragging = { drag: widthDrag(sid, si, k, hit.properties.boundary as number), before };
    map.getCanvas().style.cursor = "grabbing";
    scheduleRedraw();
  });
  map.on("mousemove", (e) => {
    if (!dragging) return;
    dragging.drag(toXY(e.lngLat));
    scheduleRedraw();
  });
  map.on("mouseup", () => {
    if (!dragging) return;
    const { before } = dragging;
    dragging = null;
    map.getCanvas().style.cursor = "";
    commit(before);
  });
  for (const layer of ["handles", "xs-hit"]) {
    map.on("mouseenter", layer, () => { if (!dragging) map.getCanvas().style.cursor = "grab"; });
    map.on("mouseleave", layer, () => { if (!dragging) map.getCanvas().style.cursor = ""; });
  }

  map.on("contextmenu", "handles", (e) => {
    const index = handleAt(e);
    const h = index === null ? null : handles[index];
    if (!h?.remove) return;
    e.preventDefault();
    edit(() => h.remove!());
  });

  map.on("click", (e) => {
    if (!area) return;
    const box: [PointLike, PointLike] = [[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]];
    const hits = map.queryRenderedFeatures(box, { layers: ["handles", "ports", "templates", "segments"] });
    if (hits.some((h) => h.layer.id === "handles")) return;
    const hit = hits[0];
    if (!hit) return select(null);
    if (hit.layer.id === "segments") select({ kind: "segment", id: hit.properties.id as string });
    else select({ kind: "cluster", id: hit.properties.cluster_id as string });
  });

  map.on("dblclick", (e) => {
    if (!area || !selection) return;
    const q = toXY(e.lngLat);
    const tolerance = metresPerPixel(e.point) * CLICK_TOLERANCE_PX;
    const sel = selection;
    if (sel.kind === "segment") {
      if (editMode !== "centerline") return;
      const line = area.segments[sel.id].centerline;
      if (!line) return;
      const near = nearestOnPolyline(line, q);
      if (near.distance <= tolerance) edit(() => { area!.segments[sel.id].centerline!.splice(near.index + 1, 0, near.point); });
      return;
    }
    const cluster = area.clusters[sel.id];
    if (cluster.type !== "freeform") return;
    const p = cluster.params as FreeformParams;
    let best: { edge: number; index: number; point: XY; distance: number } | null = null;
    p.edges.forEach((edge, i) => {
      const near = nearestOnPolyline([p.nodes[edge.from], ...edge.interior, p.nodes[edge.to]], q);
      if (!best || near.distance < best.distance) best = { edge: i, ...near };
    });
    const b = best as { edge: number; index: number; point: XY; distance: number } | null;
    if (b && b.distance <= tolerance) {
      edit(() => { (area!.clusters[sel.id].params as FreeformParams).edges[b.edge].interior.splice(b.index, 0, b.point); });
    }
  });
}

function bindKeys() {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    } else if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    } else if (e.key === "n" || e.key === "N") {
      nextUnreviewed();
    } else if (e.key === "d" || e.key === "D") {
      if (selection) {
        setSelectionStatus("done");
        nextUnreviewed();
      }
    } else if (e.key === "Escape") {
      select(null);
    } else if (e.key === "g" || e.key === "G") {
      openExternal("google");
    } else if (e.key === "v" || e.key === "V") {
      openExternal("streetview");
    } else if (e.key === "m" || e.key === "M") {
      openExternal("osm");
    } else if (e.key === "x" || e.key === "X") {
      setEditMode(editMode === "centerline" ? "cross-section" : "centerline");
    } else if (e.key === "b" || e.key === "B") {
      showBands = !showBands;
      scheduleRedraw();
    } else if (e.key === "o" || e.key === "O") {
      showOsm = !showOsm;
      scheduleRedraw();
    }
  });
}

map.on("load", async () => {
  addLayers();
  bindMapEvents();
  bindKeys();
  $("new-area").addEventListener("click", newArea);
  $<HTMLSelectElement>("area-select").addEventListener("change", (e) => {
    const id = (e.target as HTMLSelectElement).value;
    if (id) loadArea(id).catch((err) => setStatus((err as Error).message, true));
  });
  window.addEventListener("hashchange", () => selectFromHash());
  renderPanel();
  try {
    const { default: defaultImagery, sources } = await api.listImagery();
    imagerySources = sources;
    const imagerySelect = $<HTMLSelectElement>("imagery-select");
    for (const s of sources) imagerySelect.append(el("option", { value: s.id }, s.name));
    imagerySelect.value = defaultImagery;
    imagerySelect.addEventListener("change", () => {
      // Preview it only when no area is open; an open area keeps its own imagery.
      const chosen = imagerySources.find((s) => s.id === imagerySelect.value);
      if (!area && chosen) showImagery(chosen);
    });
    showImagery(sources.find((s) => s.id === defaultImagery)!);
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_AREA_KEY);
    } catch {
      // storage unavailable
    }
    const areas = await refreshAreaList();
    if (last && areas.some((a) => a.id === last)) await loadArea(last);
  } catch (err) {
    setStatus(`Backend not reachable: ${(err as Error).message}`, true);
  }
});
