// Road cross-sections (spec.md, Road cross-sections). Mirrors the vocabulary in
// backend/annotator/crosssection.py.
//
// Lateral positions here are `v`, metres to the RIGHT of the centerline in the
// segment's direction. (Width points store `shift` positive = left, like
// sideways offsets, so the carriageway's middle sits at v = -shift.)

import { add, dist, scale, sub } from "./geom";
import type { Band, BandKind, Boundary, Span, WidthPoint, XY } from "./types";

export const BAND_KINDS: BandKind[] = [
  "lane", "cycle_lane", "cycle_track", "parking", "sidewalk", "median", "verge", "shoulder",
];
export const KIND_LABELS: Record<BandKind, string> = {
  lane: "Lane", cycle_lane: "Cycle lane", cycle_track: "Cycle track", parking: "Parking",
  sidewalk: "Sidewalk", median: "Median", verge: "Verge", shoulder: "Shoulder",
};
export const KIND_COLORS: Record<BandKind, string> = {
  lane: "#78909c", cycle_lane: "#e53935", cycle_track: "#b71c1c", parking: "#1e88e5",
  sidewalk: "#fff176", median: "#ff9800", verge: "#43a047", shoulder: "#8d6e63",
};
export const DEFAULT_WIDTH: Record<BandKind, number> = {
  lane: 3.0, cycle_lane: 1.5, cycle_track: 2.0, parking: 2.0, sidewalk: 1.8, median: 1.0, verge: 1.0, shoulder: 1.5,
};
export const LANE_DIRECTIONS = ["forward", "backward", "both"] as const;
export const LANE_USES = ["general", "bus", "bicycle", "taxi", "cycle_street"] as const;
export const LANE_TURNS = ["none", "through", "left", "right", "through_left", "through_right", "left_right"] as const;
export const PARKING_ARRANGEMENTS = ["parallel", "angled", "perpendicular"] as const;
export const PARKING_SURFACES = ["carriageway", "bay", "on_sidewalk"] as const;
export const MEDIAN_SURFACES = ["painted", "kerbed", "verge"] as const;
export const PHYSICAL = ["flush", "paving_change", "low_kerb", "kerb"] as const;
export const MARKINGS = ["none", "dashed", "solid", "double_solid", "dashed_solid", "solid_dashed", "block"] as const;

export function defaultAttributes(kind: BandKind): Record<string, unknown> {
  if (kind === "lane") return { direction: "both", use: ["general"], turn: "none" };
  if (kind === "parking") return { arrangement: "parallel", surface: "carriageway" };
  if (kind === "median") return { surface: "painted" };
  return {};
}

/** Index of the first and last lane band (the carriageway). */
export function laneRange(bands: Band[]): [number, number] {
  const first = bands.findIndex((b) => b.kind === "lane");
  let last = first;
  while (last + 1 < bands.length && bands[last + 1].kind === "lane") last++;
  return [first, last];
}

/** Null if the band list is valid, otherwise why not. */
export function bandProblem(bands: Band[]): string | null {
  const lanes = bands.map((b, i) => (b.kind === "lane" ? i : -1)).filter((i) => i >= 0);
  if (!lanes.length) return "A cross-section needs at least one lane (the carriageway).";
  if (lanes[lanes.length - 1] - lanes[0] + 1 !== lanes.length) return "Lanes must be next to each other.";
  return null;
}

export function spanIndexAt(spans: Span[], s: number): number {
  for (let i = 0; i < spans.length; i++) if (s < spans[i].s_to) return i;
  return spans.length - 1;
}

/** Widths and shift at `s`, interpolated linearly between width points and held beyond them. */
export function widthsAt(span: Span, s: number): { widths: number[]; shift: number } {
  const wps = span.width_points;
  if (s <= wps[0].s) return { widths: [...wps[0].widths], shift: wps[0].shift };
  for (let k = 0; k < wps.length - 1; k++) {
    const a = wps[k], b = wps[k + 1];
    if (s <= b.s) {
      const t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
      return {
        widths: a.widths.map((w, i) => w + t * (b.widths[i] - w)),
        shift: a.shift + t * (b.shift - a.shift),
      };
    }
  }
  const last = wps[wps.length - 1];
  return { widths: [...last.widths], shift: last.shift };
}

/** Lateral position `v` (metres right of the centerline) of every boundary. */
export function boundaryOffsets(bands: Band[], widths: number[], shift: number): number[] {
  const [a, b] = laneRange(bands);
  let carriageway = 0;
  for (let i = a; i <= b; i++) carriageway += widths[i];
  const v = new Array<number>(bands.length + 1);
  v[a] = -shift - carriageway / 2;
  for (let j = a + 1; j <= bands.length; j++) v[j] = v[j - 1] + widths[j - 1];
  for (let j = a - 1; j >= 0; j--) v[j] = v[j + 1] - widths[j];
  return v;
}

/**
 * Move boundary `j` of a width point `delta` metres to the right.
 * - Between two lanes: one lane grows, the other shrinks.
 * - A carriageway edge: the edge lane grows or shrinks and the carriageway
 *   re-centres (via shift) so its other edge stays where it is.
 * - Outside the carriageway: the band on the carriageway side grows or shrinks;
 *   bands further out move with it.
 */
export function moveBoundary(bands: Band[], wp: WidthPoint, j: number, delta: number) {
  const [a, b] = laneRange(bands);
  const w = wp.widths;
  if (j > a && j <= b) {
    const d = Math.min(Math.max(delta, -w[j - 1]), w[j]);
    w[j - 1] += d;
    w[j] -= d;
  } else if (j === b + 1) {
    const d = Math.max(delta, -w[b]);
    w[b] += d;
    wp.shift -= d / 2;
  } else if (j === a) {
    const d = Math.min(delta, w[a]);
    w[a] -= d;
    wp.shift -= d / 2;
  } else if (j > b + 1) {
    w[j - 1] = Math.max(0, w[j - 1] + delta);
  } else {
    w[j] = Math.max(0, w[j] - delta);
  }
}

/**
 * Insert a band at boundary position `j` (between bands j-1 and j). The existing
 * boundary stays on the new band's outer side, so e.g. adding a band at the edge
 * of the street keeps the street's outer edge; the new inner boundary is flush.
 */
export function insertBand(span: Span, j: number, kind: BandKind) {
  const [a] = laneRange(span.bands);
  span.bands.splice(j, 0, { kind, attributes: defaultAttributes(kind) });
  span.boundaries.splice(j <= a ? j + 1 : j, 0, { physical: "flush", marking: "none" });
  for (const wp of span.width_points) wp.widths.splice(j, 0, DEFAULT_WIDTH[kind]);
}

/** Remove band `i`, keeping the boundary on its carriageway side. */
export function removeBand(span: Span, i: number) {
  const [a, b] = laneRange(span.bands);
  const outer = i < a ? i : i > b ? i + 1 : i === b ? i : i + 1;
  span.bands.splice(i, 1);
  span.boundaries.splice(outer, 1);
  for (const wp of span.width_points) wp.widths.splice(i, 1);
}

export function rescaleSpans(spans: Span[], factor: number) {
  for (const span of spans) {
    span.s_from *= factor;
    span.s_to *= factor;
    for (const wp of span.width_points) wp.s *= factor;
  }
}

// ---------------------------------------------------------------- geometry

export interface Station {
  s: number;
  p: XY;
  right: XY; // unit normal pointing right of the segment's direction
  forward: XY; // unit tangent
}

/** Points every `step` metres along a polyline, with smoothed tangents. */
export function stations(line: XY[], step = 0.5): Station[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i], line[i - 1]));
  const total = cum[cum.length - 1];
  if (total <= 0) return [];
  const pts: { s: number; p: XY }[] = [];
  const n = Math.max(1, Math.ceil(total / step));
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const s = Math.min(total, (k * total) / n);
    while (seg < line.length - 2 && cum[seg + 1] < s) seg++;
    const len = cum[seg + 1] - cum[seg];
    const t = len > 0 ? (s - cum[seg]) / len : 0;
    pts.push({ s, p: add(line[seg], scale(sub(line[seg + 1], line[seg]), t)) });
  }
  return pts.map(({ s, p }, k) => {
    const prev = pts[Math.max(0, k - 1)].p;
    const next = pts[Math.min(pts.length - 1, k + 1)].p;
    const d = sub(next, prev);
    const len = Math.hypot(d[0], d[1]) || 1;
    const forward: XY = [d[0] / len, d[1] / len];
    return { s, p, forward, right: [forward[1], -forward[0]] };
  });
}

export const at = (st: Station, v: number): XY => add(st.p, scale(st.right, v));

/** Point and direction at arc length `s` along a polyline (clamped to its ends). */
export function stationAt(line: XY[], s: number): Station {
  let i = 0, start = 0;
  while (i < line.length - 2 && start + dist(line[i], line[i + 1]) < s) {
    start += dist(line[i], line[i + 1]);
    i++;
  }
  const len = dist(line[i], line[i + 1]) || 1;
  const t = Math.min(1, Math.max(0, (s - start) / len));
  const forward = scale(sub(line[i + 1], line[i]), 1 / len);
  return { s, p: add(line[i], scale(sub(line[i + 1], line[i]), t)), forward, right: [forward[1], -forward[0]] };
}

/** Arc length along `line` of the point nearest to `q`. */
export function arcLengthOf(line: XY[], q: XY): number {
  let best = Infinity, bestS = 0, start = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], ab = sub(line[i + 1], a);
    const len2 = ab[0] ** 2 + ab[1] ** 2;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / len2)) : 0;
    const d = dist(add(a, scale(ab, t)), q);
    if (d < best) {
      best = d;
      bestS = start + t * Math.sqrt(len2);
    }
    start += Math.sqrt(len2);
  }
  return bestS;
}

export interface Overlay {
  bands: { kind: BandKind; span: number; band: number; ring: XY[] }[];
  boundaries: { physical: Boundary["physical"]; span: number; boundary: number; line: XY[] }[];
  markings: XY[][];
  arrows: XY[][];
}

const DASH = { dashed: [3, 6], block: [1, 1] } as const; // metres on, off
const DOUBLE_GAP = 0.1; // metres from a double line's middle to each line

/** The part of `line` between arc lengths s0 < s1. `cum` holds its cumulative lengths. */
function slice(line: XY[], cum: number[], s0: number, s1: number): XY[] {
  const pointAt = (s: number): XY => {
    let i = 0;
    while (i < line.length - 2 && cum[i + 1] < s) i++;
    const len = cum[i + 1] - cum[i];
    return add(line[i], scale(sub(line[i + 1], line[i]), len > 0 ? (s - cum[i]) / len : 0));
  };
  const inner = line.filter((_, i) => cum[i] > s0 && cum[i] < s1);
  return [pointAt(s0), ...inner, pointAt(s1)];
}

/** Dashes of `on` metres separated by gaps of `off` metres. */
function dashes(line: XY[], on: number, off: number): XY[][] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i], line[i - 1]));
  const total = cum[cum.length - 1];
  const out: XY[][] = [];
  for (let s = 0; s < total; s += on + off) out.push(slice(line, cum, s, Math.min(s + on, total)));
  return out;
}

/** Overlay geometry for one segment, in the area's metric CRS. */
export function segmentOverlay(centerline: XY[], spans: Span[]): Overlay {
  const out: Overlay = { bands: [], boundaries: [], markings: [], arrows: [] };
  const all = stations(centerline);
  if (!all.length || !spans.length) return out;

  spans.forEach((span, si) => {
    const last = si === spans.length - 1;
    const sts = all.filter((st) => st.s >= span.s_from - 1e-9 && (last || st.s <= span.s_to + 1e-9));
    if (sts.length < 2) return;
    const offsets = sts.map((st) => {
      const { widths, shift } = widthsAt(span, st.s);
      return boundaryOffsets(span.bands, widths, shift);
    });
    const boundaryLine = (j: number, dv = 0) => sts.map((st, k) => at(st, offsets[k][j] + dv));

    span.bands.forEach((band, i) => {
      const left = boundaryLine(i), right = boundaryLine(i + 1);
      out.bands.push({ kind: band.kind, span: si, band: i, ring: [...left, ...right.reverse(), left[0]] });
    });

    span.boundaries.forEach((boundary, j) => {
      out.boundaries.push({ physical: boundary.physical, span: si, boundary: j, line: boundaryLine(j) });
      const m = boundary.marking;
      if (m === "solid") out.markings.push(boundaryLine(j));
      if (m === "dashed" || m === "block") {
        const [on, off] = DASH[m];
        out.markings.push(...dashes(boundaryLine(j), on, off));
      }
      if (m === "double_solid") out.markings.push(boundaryLine(j, -DOUBLE_GAP), boundaryLine(j, DOUBLE_GAP));
      // dashed_solid: dashed on the left, solid on the right (in the segment's direction)
      if (m === "dashed_solid" || m === "solid_dashed") {
        const [l, r] = [boundaryLine(j, -DOUBLE_GAP), boundaryLine(j, DOUBLE_GAP)];
        out.markings.push(...(m === "dashed_solid" ? [...dashes(l, ...DASH.dashed), r] : [l, ...dashes(r, ...DASH.dashed)]));
      }
    });

    // Direction arrows on one-direction lanes, every 15 m.
    span.bands.forEach((band, i) => {
      const direction = band.attributes.direction;
      if (band.kind !== "lane" || (direction !== "forward" && direction !== "backward")) return;
      const sign = direction === "forward" ? 1 : -1;
      for (let k = 0; k < sts.length; k += 30) {
        const st = sts[k];
        if (st.s - span.s_from < 4 || span.s_to - st.s < 4) continue;
        const width = offsets[k][i + 1] - offsets[k][i];
        if (width < 0.8) continue;
        const c = at(st, (offsets[k][i] + offsets[k][i + 1]) / 2);
        const f = scale(st.forward, sign);
        const tip = add(c, scale(f, 0.9));
        const half = Math.min(0.6, width / 3);
        out.arrows.push([add(sub(c, scale(f, 0.3)), scale(st.right, half)), tip, sub(sub(c, scale(f, 0.3)), scale(st.right, half))]);
      }
    });
  });
  return out;
}
