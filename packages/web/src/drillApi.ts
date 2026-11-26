// Typed client for Myelin v2 Drill (RWKV-Instant + Jev cascade) and Spatial Map APIs.
import type { Depth, Grade } from "@myelin/core";
import type { InlineAnnotation } from "./annotate.js";
import { SendError } from "./sync.js";

export type { InlineAnnotation };

export interface QueueUnit {
  unit_id: string;
  text: string;
  prompt?: string | null;
  kind: string;
  topic: string | null;
  depth: Depth;
  p_imm: number;
  reviews: number;
  next_in_ms: number | null;
  due: boolean;
}

export interface ActiveAttempt {
  attempt_id: string;
  unit_id: string;
  depth: Depth;
  prompt: string;
  turns: { user: string; coach: string; failed?: boolean; annotations?: InlineAnnotation[]; added?: AddedUnit[] }[];
  assistance_count: number;
  active_ms: number | null;
  updated_at: number;
}

export interface DrillQueueResponse {
  scheduler: string;
  total_units: number;
  active_ids?: string[];
  active_attempts?: ActiveAttempt[];
  items: QueueUnit[];
}

export interface AddedUnit {
  unit_id: string;
  text: string;
  kind: string;
  observe_only: boolean;
}

export interface SavedExploration {
  id: string;
  title: string;
  turns: { user: string; coach: string; question?: string; added?: AddedUnit[] }[];
  created_at: number;
  updated_at: number;
}

export interface ExploreResponse {
  message: string;
  question?: string;
  added_units: AddedUnit[];
  demonstrated_cruxes?: number[];
  frontier?: Frontier;
  exploration?: { id: string; title: string };
  sidecar_pending?: boolean;
  rep_fix_applied?: {
    changes: string[];
    grade?: Grade;
    next_in_ms?: number | null;
    reworded_unit?: string | null;
  };
  failed?: boolean;
}

export interface DrillRep {
  unit_id: string;
  text: string;
  kind: string;
  topic: string | null;
  depth: Depth;
  prompt: string;
  rests_on: string[];
  p_imm: number;
  reviews: number;
  prev_latency_ms: number | null;
  first_latency_ms: number | null;
}

export interface NextDrillResponse {
  scheduler: string;
  total_units: number;
  active_habits: { id: string; text: string }[];
  judge_enabled: boolean;
  rep: DrillRep | null;
}

export interface CheckDrillResponse {
  ok: boolean;
  grade: Grade;
  message: string;
  tier: "system1" | "system2" | "fallback";
  failed?: boolean;
  attempt_id?: string;
  annotations?: InlineAnnotation[];
  habit_observed?: string | null;
  added_units?: AddedUnit[];
  probe_id: string | null;
  latency_ms: number | null;
  prev_latency_ms: number | null;
  next_in_ms: number | null;
  scheduler: string;
  jev?: {
    model: string;
    latency_ms: number;
    demonstrated: number;
    cot_gap: number;
  };
}

export interface MapUnit {
  id: string;
  text: string;
  kind: string;
  topic: string | null;
  status: string;
  rests_on: string[];
  told: boolean;
  rebuilt_once: boolean;
  p_imm: number;
  reviews: number;
  next_in_ms: number | null;
  first_latency_ms: number | null;
  last_latency_ms: number | null;
  found_at: number;
}

export interface MapHabit {
  id: string;
  text: string;
  kind: string;
  topic: string | null;
  present: number;
  missing: number;
  found_at: number;
}

export interface MapPage {
  id: string;
  title: string;
  created_at: number;
  edited_at: number;
  rev: number;
}

export interface MapResponse {
  scheduler: string;
  units: MapUnit[];
  habits: MapHabit[];
  pages: MapPage[];
  goals: { id: string; text: string; due: number | null; topic: string | null }[];
}

export interface BriefingCrux {
  text: string;
  kind: string;
  question: string;
  source_ref?: string;
}

export interface Frontier {
  id: string;
  title: string;
  source: string;
  body: string;
  skipped_known: string[];
  cruxes: BriefingCrux[];
  demonstrated_cruxes?: number[];
  turns?: { user: string; coach: string; added?: AddedUnit[] }[];
  created_at: number;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin", ...init });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new SendError(body.error ?? `HTTP ${r.status}`, r.status);
  return body;
}

/**
 * Calls a streaming-capable endpoint with `?stream=1`, delivering partial coach prose via `onDelta`
 * while holding back the final structured payload until the SSE `done` event arrives.
 * Falls back cleanly to plain JSON when the server returns `application/json` (e.g. idempotent cache hit).
 */
async function reqStream<T>(
  url: string,
  init: RequestInit,
  onDelta?: (partialText: string) => void,
): Promise<T> {
  if (!onDelta) return req<T>(url, init);
  const sep = url.includes("?") ? "&" : "?";
  const r = await fetch(`${url}${sep}stream=1`, { credentials: "same-origin", ...init });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    throw new SendError(body.error ?? `HTTP ${r.status}`, r.status);
  }
  const ct = (r.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("text/event-stream") || !r.body) {
    return (await r.json()) as T;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let donePayload: T | undefined;

  const processFrame = (frame: string) => {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      if (rawLine.startsWith("event:")) eventName = rawLine.slice(6).trim();
      else if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const rawData = dataLines.join("\n");
    if (eventName === "delta") {
      try {
        const parsed = JSON.parse(rawData) as { text?: string };
        if (typeof parsed.text === "string") onDelta(parsed.text);
      } catch {
        /* ignore malformed delta chunk */
      }
    } else if (eventName === "done") {
      donePayload = JSON.parse(rawData) as T;
    } else if (eventName === "error") {
      let msg = "Stream failed";
      try {
        const parsed = JSON.parse(rawData) as { error?: string };
        if (typeof parsed.error === "string" && parsed.error) msg = parsed.error;
      } catch {
        /* ignore */
      }
      throw new SendError(msg, 502);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let splitIdx = buf.search(/\r?\n\r?\n/);
      while (splitIdx !== -1) {
        const frame = buf.slice(0, splitIdx);
        const delim = buf.slice(splitIdx).match(/^\r?\n\r?\n/)?.[0].length ?? 2;
        buf = buf.slice(splitIdx + delim);
        if (frame.trim()) processFrame(frame);
        splitIdx = buf.search(/\r?\n\r?\n/);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) processFrame(buf);
  } finally {
    reader.releaseLock();
  }

  if (donePayload === undefined) {
    throw new SendError("Stream ended before response completed.", 502);
  }
  return donePayload;
}

export function fetchDrillQueue(signal?: AbortSignal): Promise<DrillQueueResponse> {
  return req<DrillQueueResponse>("/api/drill/queue", signal ? { signal } : undefined);
}

export function tidyDraft(text: string, signal?: AbortSignal): Promise<{ text: string; changed: boolean }> {
  return req<{ text: string; changed: boolean }>("/api/drill/tidy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
}

export function exploreDrill(
  payload: {
    exploration_id?: string | null;
    initial: string;
    sketch_data_url?: string | null;
    turns: { role: "user" | "assistant"; text: string }[];
    reply?: string;
    promote_on_unit?: boolean;
    origin_prompt?: string;
    prior_post_turns?: { user: string; coach: string; question?: string; added?: AddedUnit[] }[];
    rep_context?: {
      unit_id: string;
      depth: Depth;
      prompt: string;
      probe_id?: string | null;
      grade: Grade;
    };
  },
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<ExploreResponse> {
  return reqStream<ExploreResponse>(
    "/api/drill/explore",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
    onDelta,
  );
}

export function fetchExplorations(
  signal?: AbortSignal,
): Promise<{ explorations: SavedExploration[]; archived?: SavedExploration[] }> {
  return req<{ explorations: SavedExploration[]; archived?: SavedExploration[] }>(
    "/api/explorations",
    signal ? { signal } : undefined,
  );
}

export function waitExplorationSidecar(
  id: string,
  signal?: AbortSignal,
): Promise<{ exploration_id: string; turn_index?: number; title?: string; added_units: AddedUnit[] }> {
  return req<{ exploration_id: string; turn_index?: number; title?: string; added_units: AddedUnit[] }>(
    `/api/explorations/${encodeURIComponent(id)}/sidecar`,
    signal ? { signal } : undefined,
  );
}

export function saveExploration(payload: {
  id?: string;
  title?: string;
  turns: { user: string; coach: string; question?: string; added?: AddedUnit[] }[];
}): Promise<{ exploration: SavedExploration }> {
  return req<{ exploration: SavedExploration }>("/api/explorations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function archiveExploration(id: string): Promise<{ ok: boolean; id: string }> {
  return req<{ ok: boolean; id: string }>(`/api/explorations/${encodeURIComponent(id)}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function unarchiveExploration(id: string): Promise<{ ok: boolean; id: string }> {
  return req<{ ok: boolean; id: string }>(`/api/explorations/${encodeURIComponent(id)}/unarchive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function deleteExploration(id: string): Promise<{ ok: boolean; id: string }> {
  return req<{ ok: boolean; id: string }>(`/api/explorations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  });
}

export function fetchNextDrill(opts: { unitId?: string | null; exclude?: string | null } = {}, signal?: AbortSignal): Promise<NextDrillResponse> {
  const qs = new URLSearchParams();
  if (opts.unitId) qs.set("unit_id", opts.unitId);
  if (opts.exclude) qs.set("exclude", opts.exclude);
  const q = qs.toString();
  return req<NextDrillResponse>(`/api/drill/next${q ? `?${q}` : ""}`, signal ? { signal } : undefined);
}

export function checkDrill(
  payload: {
    attempt_id?: string;
    unit_id: string;
    depth: Depth;
    prompt: string;
    attempt: string;
    sketch_data_url?: string | null;
    history?: { attempt: string; feedback: string }[];
    latency_ms: number | null;
    hints_used: number;
  },
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<CheckDrillResponse> {
  return reqStream<CheckDrillResponse>(
    "/api/drill/check",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
    onDelta,
  );
}

export function requestDrillHint(payload: {
  unit_id: string;
  depth: Depth;
  prompt: string;
  attempt: string;
  rung: number;
}): Promise<{ hint: string; rung: number }> {
  return req<{ hint: string; rung: number }>("/api/drill/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, hint_only: true }),
  });
}

export function askDrillFollowUp(
  payload: {
    attempt_id?: string;
    unit_id: string;
    depth: Depth;
    prompt: string;
    attempt: string;
    feedback: string;
    turns: { role: "user" | "assistant"; text: string }[];
    question: string;
    revised_attempt?: boolean;
    sketch_data_url?: string | null;
    latency_ms: number | null;
    hints_used: number;
  },
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<CheckDrillResponse> {
  return reqStream<CheckDrillResponse>(
    "/api/drill/followup",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
    onDelta,
  );
}

export function abandonDrillAttempt(attemptId: string): Promise<{ ok: boolean; attempt_id: string }> {
  return req<{ ok: boolean; attempt_id: string }>(`/api/drill/attempts/${encodeURIComponent(attemptId)}/abandon`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function recordDrillMiss(payload: {
  unit_id: string;
  depth: Depth;
  prompt: string;
  latency_ms: number | null;
  hints_used: number;
}): Promise<{ ok: boolean; probe_id: string; next_in_ms: number | null }> {
  return req<{ ok: boolean; probe_id: string; next_in_ms: number | null }>("/api/drill/miss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function overrideDrillGrade(payload: {
  unit_id: string;
  probe_id: string;
  grade: Grade;
  note?: string;
}): Promise<{ ok: boolean; grade?: Grade; next_in_ms: number | null }> {
  return req<{ ok: boolean; grade?: Grade; next_in_ms: number | null }>("/api/drill/override", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface AuditRepResponse {
  analysis: string;
  changes: string[];
  added_units: AddedUnit[];
  grade: Grade;
  next_in_ms: number | null;
  reworded_unit?: string;
  improved_prompt?: string;
}

export function auditDrillRep(payload: {
  unit_id: string;
  depth: Depth;
  prompt: string;
  probe_id: string | null;
  grade: Grade;
  beats: { user: string; coach: string }[];
}): Promise<AuditRepResponse> {
  return req<AuditRepResponse>("/api/drill/audit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function fetchMap(signal?: AbortSignal): Promise<MapResponse> {
  return req<MapResponse>("/api/map", signal ? { signal } : undefined);
}

export interface AgentMemory {
  key: string;
  content: string;
  last_dream_seq: number;
  last_dream_at: number;
  dream_count: number;
  updated_at: number;
  updated_by: "dream" | "learner";
}

export interface DreamLog {
  id: string;
  from_seq: number;
  to_seq: number;
  summary: string;
  promoted: string[];
  graduated: string[];
  created_at: number;
}

export interface MemoryResponse {
  memory: AgentMemory;
  logs: DreamLog[];
  dreaming: boolean;
  pending_events: number;
}

export function fetchAgentMemory(signal?: AbortSignal): Promise<MemoryResponse> {
  return req<MemoryResponse>("/api/memory", signal ? { signal } : undefined);
}

export function saveAgentMemory(content: string): Promise<{ memory: AgentMemory }> {
  return req<{ memory: AgentMemory }>("/api/memory", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export function triggerDream(): Promise<{ memory: AgentMemory; log: DreamLog | null; logs: DreamLog[]; skipped?: boolean }> {
  return req("/api/memory/dream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function createQuickUnit(payload: {
  text: string;
  kind?: string;
  topic?: string | null;
  observe_only?: boolean;
  told?: boolean;
}): Promise<{ unit_id: string; text: string; observe_only: boolean }> {
  return req("/api/units", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function removeUnit(unitId: string): Promise<{ ok: boolean; unit_id: string }> {
  return req(`/api/units/${encodeURIComponent(unitId)}/remove`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export function fetchFrontiers(signal?: AbortSignal): Promise<{ frontiers: Frontier[] }> {
  return req<{ frontiers: Frontier[] }>("/api/frontiers", signal ? { signal } : undefined);
}

export function createFrontier(request: string, signal?: AbortSignal): Promise<{ frontier: Frontier }> {
  return req<{ frontier: Frontier }>("/api/frontiers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request }),
    signal,
  });
}

export function deleteFrontier(id: string): Promise<{ ok: boolean; id: string }> {
  return req<{ ok: boolean; id: string }>(`/api/frontiers/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
  });
}

export function respondFrontier(
  frontierId: string,
  payload: {
    turns: { role: "user" | "assistant"; text: string }[];
    reply: string;
    test_me?: boolean;
    sketch_data_url?: string | null;
  },
  signal?: AbortSignal,
  onDelta?: (text: string) => void,
): Promise<ExploreResponse> {
  return reqStream<ExploreResponse>(
    `/api/frontiers/${encodeURIComponent(frontierId)}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
    onDelta,
  );
}
