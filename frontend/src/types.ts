// Mirrors the state built by backend/annotator/graph.py. All xy are metres in the area's UTM CRS.

export type XY = [number, number];
export type Status = "unreviewed" | "done";
export type TemplateType = "point" | "roundabout" | "dead_end" | "freeform";

export interface Port {
  id: string;
  cluster_id: string;
  segment_id: string;
  end: "start" | "end";
  junction_id: string;
  offset: number;
  xy: XY;
  heading: number; // radians, pointing out of the cluster
  osm_xy: XY;
  osm_heading: number;
}

export interface Arm {
  port_id: string;
  theta: number;
}

export interface PointParams {
  center: XY;
  arms: Arm[];
}

export interface RoundaboutParams {
  center: XY;
  radius: number;
  arms: Arm[]; // theta = angle of the attachment point on the ring
}

export interface DeadEndParams {
  end: XY;
  turn_radius: number;
  arms: Arm[];
}

export interface FreeformEdge {
  from: string;
  to: string;
  interior: XY[];
}

export interface FreeformParams {
  nodes: Record<string, XY>; // "j:<junction id>" or "port:<port id>"
  edges: FreeformEdge[];
}

export type TemplateParams = PointParams | RoundaboutParams | DeadEndParams | FreeformParams;

export interface Cluster {
  id: string;
  junction_ids: string[];
  internal_segment_ids: string[];
  port_ids: string[];
  osm_center: XY;
  roundabout: boolean;
  dead_end: boolean;
  outside: boolean;
  type: TemplateType;
  params: TemplateParams;
  flags: string[];
  status: Status;
  source: string;
}

export interface SegmentFlag {
  kind: string;
  s_from: number;
  s_to: number | null;
}

export type BandKind =
  | "lane" | "cycle_lane" | "cycle_track" | "parking" | "sidewalk" | "median" | "verge" | "shoulder";

export interface Band {
  kind: BandKind;
  // lane: direction, use (list), turn; parking: arrangement, surface; median: surface
  attributes: Record<string, unknown>;
}

export interface Boundary {
  physical: "flush" | "paving_change" | "low_kerb" | "kerb";
  marking: "none" | "dashed" | "solid" | "double_solid" | "dashed_solid" | "solid_dashed" | "block";
}

export interface WidthPoint {
  s: number;
  widths: number[]; // one per band
  shift: number; // carriageway middle, metres LEFT of the centerline
}

/** Bands run left to right in the segment's direction; boundaries.length = bands.length + 1. */
export interface Span {
  s_from: number;
  s_to: number;
  bands: Band[];
  boundaries: Boundary[];
  width_points: WidthPoint[];
  source: string;
}

export interface Segment {
  id: string;
  start_junction: string;
  end_junction: string;
  osm_way_ids: number[];
  highway: string | null;
  name: string | null;
  oneway: boolean;
  roundabout: boolean;
  bridge: boolean;
  osm_polyline: XY[];
  length: number;
  internal: boolean;
  cluster_id: string | null;
  start_port: string | null;
  end_port: string | null;
  guide_line: XY[] | null;
  centerline: XY[] | null;
  flags: SegmentFlag[];
  spans: Span[] | null;
  osm_tags: Record<string, string>;
  osm_reversed: boolean;
  status: Status;
  source: string;
}

export interface Junction {
  id: string;
  osm_node_id: number;
  osm_xy: XY;
  degree: number;
  cluster_id: string;
}

export interface Imagery {
  id: string;
  name: string;
  provider: string;
  layer: string;
  year: number;
  gsd: number; // native m/px
  tiles: string; // XYZ template, EPSG:3857
  max_zoom: number;
  license: string;
}

export interface AreaState {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  epsg: number;
  imagery: Imagery;
  params: Record<string, number>;
  junctions: Record<string, Junction>;
  segments: Record<string, Segment>;
  clusters: Record<string, Cluster>;
  ports: Record<string, Port>;
}

export interface Progress {
  total: number;
  done: number;
}

export interface AreaSummary {
  id: string;
  name: string;
  bbox: [number, number, number, number];
  epsg: number;
  imagery: Imagery;
  clusters: Progress;
  segments: Progress;
}

export interface ClusterEdit {
  type?: TemplateType;
  params?: TemplateParams;
  flags?: string[];
  status?: Status;
}

export interface SegmentEdit {
  centerline?: XY[];
  flags?: SegmentFlag[];
  spans?: Span[];
  status?: Status;
}

export interface PortEdit {
  xy?: XY;
  heading?: number;
}

export interface Edits {
  clusters?: Record<string, ClusterEdit>;
  segments?: Record<string, SegmentEdit>;
  ports?: Record<string, PortEdit>;
}

export interface EditResponse {
  changed: {
    clusters: Record<string, Cluster>;
    segments: Record<string, Segment>;
    ports: Record<string, Port>;
  };
  summary: AreaSummary;
}
