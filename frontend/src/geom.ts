// Geometry helpers and template rendering. `renderCluster` mirrors
// backend/annotator/templates.py `render`; keep the two in step.

import type {
  AreaState, Cluster, DeadEndParams, FreeformParams, PointParams, RoundaboutParams, TemplateType, XY,
} from "./types";

export const add = (a: XY, b: XY): XY => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: XY, k: number): XY => [a[0] * k, a[1] * k];
export const norm = (a: XY): number => Math.hypot(a[0], a[1]);
export const dist = (a: XY, b: XY): number => norm(sub(a, b));
export const unit = (angle: number): XY => [Math.cos(angle), Math.sin(angle)];
export const angleOf = (v: XY): number => Math.atan2(v[1], v[0]);

export function bezier(p0: XY, t0: XY, p3: XY, t3: XY, spacing = 0.5): XY[] {
  const k = dist(p3, p0) / 3;
  const p1 = add(p0, scale(t0, k));
  const p2 = sub(p3, scale(t3, k));
  const n = Math.max(8, Math.floor((3 * k) / spacing) + 1);
  const pts: XY[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t ** 2, d = t ** 3;
    pts.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return pts;
}

export function circle(center: XY, radius: number, spacing = 0.5): XY[] {
  const n = Math.max(16, Math.floor((2 * Math.PI * radius) / spacing));
  const pts: XY[] = [];
  for (let i = 0; i <= n; i++) pts.push(add(center, scale(unit((2 * Math.PI * i) / n), radius)));
  return pts;
}

export interface Curve {
  kind: "arm" | "ring" | "turn" | "edge";
  portId?: string;
  edgeIndex?: number;
  points: XY[];
}

export function armStart(type: TemplateType, params: PointParams | RoundaboutParams | DeadEndParams, theta: number): XY {
  if (type === "point") return (params as PointParams).center;
  if (type === "roundabout") {
    const p = params as RoundaboutParams;
    return add(p.center, scale(unit(theta), p.radius));
  }
  return (params as DeadEndParams).end;
}

export function renderCluster(state: AreaState, cluster: Cluster): Curve[] {
  const curves: Curve[] = [];
  if (cluster.type === "freeform") {
    const p = cluster.params as FreeformParams;
    p.edges.forEach((e, i) => {
      curves.push({ kind: "edge", edgeIndex: i, points: [p.nodes[e.from], ...e.interior, p.nodes[e.to]] });
    });
    return curves;
  }
  if (cluster.type === "roundabout") {
    const p = cluster.params as RoundaboutParams;
    curves.push({ kind: "ring", points: circle(p.center, p.radius) });
  }
  if (cluster.type === "dead_end") {
    const p = cluster.params as DeadEndParams;
    if (p.turn_radius > 0) curves.push({ kind: "turn", points: circle(p.end, p.turn_radius) });
  }
  const params = cluster.params as PointParams | RoundaboutParams | DeadEndParams;
  for (const arm of params.arms) {
    const port = state.ports[arm.port_id];
    const start = armStart(cluster.type, params, arm.theta);
    curves.push({
      kind: "arm",
      portId: arm.port_id,
      points: bezier(start, unit(arm.theta), port.xy, unit(port.heading)),
    });
  }
  return curves;
}

export function validTypes(cluster: Cluster): TemplateType[] {
  const n = cluster.port_ids.length;
  const types: TemplateType[] = [];
  if (n >= 2) types.push("point");
  if (n >= 1) types.push("roundabout");
  if (n === 1) types.push("dead_end");
  types.push("freeform");
  return types;
}

export function polylineLength(pts: XY[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i], pts[i - 1]);
  return total;
}

/** Nearest point on a polyline: the index of the segment it lies on, the point and its distance. */
export function nearestOnPolyline(pts: XY[], q: XY): { index: number; point: XY; distance: number } {
  let best = { index: 0, point: pts[0], distance: Infinity };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const ab = sub(b, a);
    const len2 = ab[0] ** 2 + ab[1] ** 2;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((q[0] - a[0]) * ab[0] + (q[1] - a[1]) * ab[1]) / len2)) : 0;
    const p = add(a, scale(ab, t));
    const d = dist(p, q);
    if (d < best.distance) best = { index: i, point: p, distance: d };
  }
  return best;
}

/**
 * Move one end of a polyline by `delta`, spreading the shift into the line with a
 * linear falloff over `falloff` metres (the rubber band from the spec).
 */
export function shiftEnd(pts: XY[], atStart: boolean, delta: XY, falloff: number): XY[] {
  const line = atStart ? pts : [...pts].reverse();
  let s = 0;
  const out = line.map((p, i) => {
    if (i > 0) s += dist(line[i], line[i - 1]);
    const w = Math.max(0, 1 - s / falloff);
    return add(p, scale(delta, w));
  });
  return atStart ? out : out.reverse();
}

/** Midpoint of the largest angular gap between `angles` (radians). */
export function largestGapMid(angles: number[]): number {
  if (angles.length === 0) return 0;
  const sorted = [...angles].map((a) => (a + 2 * Math.PI) % (2 * Math.PI)).sort((a, b) => a - b);
  let bestGap = -1, mid = 0;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const b = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 2 * Math.PI;
    if (b - a > bestGap) {
      bestGap = b - a;
      mid = (a + b) / 2;
    }
  }
  return mid;
}
