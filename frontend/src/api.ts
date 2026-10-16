import type { AreaState, AreaSummary, EditResponse, Edits, Imagery, Span, TemplateParams, TemplateType, XY } from "./types";

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data.detail) message = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail);
    } catch {
      // keep the status line
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const listImagery = () => request<{ default: string; sources: Imagery[] }>("GET", "/api/imagery");

export const listAreas = () => request<AreaSummary[]>("GET", "/api/areas");

export const createArea = (name: string, bbox: [number, number, number, number], imagery: string) =>
  request<AreaSummary>("POST", "/api/areas", { name, bbox, imagery });

export const getArea = (id: string) => request<AreaState>("GET", `/api/areas/${encodeURIComponent(id)}`);

export const postEdits = (id: string, edits: Edits) =>
  request<EditResponse>("POST", `/api/areas/${encodeURIComponent(id)}/edits`, edits);

export const initCluster = (id: string, clusterId: string, type: TemplateType, resetPorts = false) =>
  request<{ type: TemplateType; params: TemplateParams; ports: Record<string, { xy: XY; heading: number }> }>(
    "POST",
    `/api/areas/${encodeURIComponent(id)}/clusters/${encodeURIComponent(clusterId)}/init`,
    { type, reset_ports: resetPorts },
  );

export const defaultCrossSection = (id: string, segmentId: string) =>
  request<{ spans: Span[] }>(
    "POST",
    `/api/areas/${encodeURIComponent(id)}/segments/${encodeURIComponent(segmentId)}/default-cross-section`,
  );

export const exportUrl = (id: string) => `/api/areas/${encodeURIComponent(id)}/export?slices=true`;
