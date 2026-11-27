// Derived state: units, unit links, unit memory, evidence and planning, rebuilt from the event log.
//
// Invariants:
// - State is plain JSON. Serializing it, parsing it back and applying more events gives the same
//   result as replaying the whole log.
// - Reducers are total. An event that refers to something missing is recorded as an anomaly and
//   otherwise ignored; replay never fails on content, only on a malformed or out-of-order log.
// - Everything a unit has learned (memory, ladders, rebuilt_once) is a fold over its probe evidence,
//   so a later grade correction recomputes it exactly.
import type { Depth, EventOf, EventType, Grade, McqOutcome, McqRole, MyelinEvent, Origin, Payload, SlotKind } from "./events.js";
import { isCorrection } from "./events.js";
import { applyPageEdit, applyPageRun, newPage, PageEditError, type PageState } from "./page.js";
import type { Scheduler, UnitMemory } from "./scheduler.js";
import { applyRunEvent, type Run } from "./time.js";

export const DAY_MS = 86_400_000;
/** Explain and use probes are spaced on this fixed ladder, in days, back to the start after a miss. */
export const LADDER_DAYS = [3, 7, 21, 60] as const;

export type UnitStatus = "active" | "retired" | "split" | "merged";

export interface Wording {
  text: string;
  by: "learner" | "tutor" | "found";
  at: number;
}

/** Position on the explain/use ladder. `step` indexes LADDER_DAYS for the next success. */
export interface Ladder {
  step: number;
  due: number;
}

export interface Unit {
  id: string;
  text: string;
  kind: string;
  topic: string | null;
  rests_on: string[];
  status: UnitStatus;
  /** For split: the parts. For merged: the survivor. */
  successors: string[];
  /** Units that were split into, or merged into, this one. */
  predecessors: string[];
  origin: Origin;
  told: boolean;
  observe_only: boolean;
  found_at: number;
  found_event: string;
  retired_at: number | null;
  wordings: Wording[];
  /** Event ids of this unit's evidence, in log order. */
  evidence: string[];
  observations: { present: number; missing: number; last_at: number | null };
  // Learning state: a fold over probe evidence.
  memory: UnitMemory;
  memory_reviews: number;
  rebuilt_once: boolean;
  first_success_at: number | null;
  last_probed_at: number | null;
  ladders: { explain: Ladder | null; use: Ladder | null };
}

export interface Evidence {
  event_id: string;
  seq: number;
  unit_id: string;
  at: number;
  source: "probe" | "observation";
  depth: Depth | null;
  slot: SlotKind | "imported" | null;
  prompt: string | null;
  answer_message_id: string | null;
  inferred_grade: Grade | null;
  /** The grade that counts: the latest correction, else the in-turn correction, else the inference. */
  grade: Grade | null;
  corrected_by: string | null;
  hints: number;
  latency_ms: number | null;
  scheduler: string | null;
  predicted_recall: number | null;
  present: boolean | null;
  note: string | null;
  modality?: "mcq";
  mcq_role?: McqRole;
  mcq_item_id?: string;
  mcq_outcome?: McqOutcome;
  mcq_choice_id?: string;
}

/** True when an evidence record is an MCQ probe rather than a production probe. */
export function isRecognitionProbe(ev: Evidence | undefined | null): boolean {
  return Boolean(ev && ev.source === "probe" && ev.modality === "mcq");
}

/**
 * True when a v2 standalone MCQ probe should update conservative memory stability/reviews
 * (clean correct -> hard, wrong/idk -> again; never assisted/revealed, never legacy v1 or preliminary gates).
 */
export function isStandaloneMcqCredit(ev: Evidence | undefined | null): boolean {
  return Boolean(
    ev &&
      ev.source === "probe" &&
      ev.modality === "mcq" &&
      ev.mcq_role === "standalone" &&
      ev.grade !== null &&
      ev.mcq_outcome !== "assisted_correct" &&
      ev.mcq_outcome !== "revealed",
  );
}

export interface Goal {
  id: string;
  text: string;
  due: number | null;
  topic: string | null;
  unit_ids: string[];
  active: boolean;
  set_at: number;
}

export interface Preference {
  value: unknown;
  lasting: boolean;
  set_at: number;
  event_id: string;
}

export interface Anomaly {
  seq: number;
  event_id: string;
  reason: string;
}

export interface State {
  /** The last applied seq. 0 for an empty log. */
  seq: number;
  scheduler: string;
  units: Record<string, Unit>;
  evidence: Record<string, Evidence>;
  goals: Record<string, Goal>;
  preferences: Record<string, Preference>;
  budget: { seconds: number; note: string | null; set_at: number } | null;
  pages: Record<string, PageState>;
  /** Timed runs. At most one has not ended. */
  runs: Record<string, Run>;
  anomalies: Anomaly[];
}

export class ReplayError extends Error {}

export function emptyState(scheduler: Scheduler): State {
  return { seq: 0, scheduler: scheduler.name, units: {}, evidence: {}, goals: {}, preferences: {}, budget: null, pages: {}, runs: {}, anomalies: [] };
}

/** A unit can be rebuilt from others when it rests on something. Otherwise it is arbitrary. */
export function isRebuildable(u: Unit): boolean {
  return u.rests_on.length > 0;
}

/** Follows merges to the unit that now stands for `id`. */
export function resolveUnit(state: State, id: string): Unit | undefined {
  let u = state.units[id];
  for (let guard = 0; u && u.status === "merged" && guard < 64; guard++) u = state.units[u.successors[0]!];
  return u;
}

/**
 * Applies one event, mutating `state`. The event must carry a seq greater than state.seq.
 * Throws ReplayError only for an out-of-order event or a scheduler mismatch.
 */
export function applyEvent(state: State, event: MyelinEvent, scheduler: Scheduler): State {
  if (state.scheduler !== scheduler.name) {
    throw new ReplayError(`state was built with scheduler ${state.scheduler}, not ${scheduler.name}`);
  }
  if (event.seq === undefined) throw new ReplayError(`event ${event.id} has no seq; only appended events can be applied`);
  if (event.seq <= state.seq) throw new ReplayError(`event ${event.id} seq ${event.seq} is not after ${state.seq}`);
  const reducer = reducers[event.type] as Reducer<EventType> | undefined;
  if (reducer) reducer(state, event as EventOf<EventType> & { seq: number }, scheduler);
  state.seq = event.seq;
  return state;
}

/** Replays a log in seq order onto `from` (a copy is not made) or onto an empty state. */
export function replay(events: Iterable<MyelinEvent>, scheduler: Scheduler, from?: State): State {
  const state = from ?? emptyState(scheduler);
  for (const e of events) applyEvent(state, e, scheduler);
  return state;
}

// ---------------------------------------------------------------------------------------------

type Applied<T extends EventType> = EventOf<T> & { seq: number };
type Reducer<T extends EventType> = (state: State, e: Applied<T>, s: Scheduler) => void;

function anomaly(state: State, e: { seq: number; id: string }, reason: string): void {
  state.anomalies.push({ seq: e.seq, event_id: e.id, reason });
}

function cleanLinks(state: State, unitId: string, ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const r = resolveUnit(state, id)?.id ?? id;
    if (r !== unitId && !out.includes(r)) out.push(r);
  }
  return out;
}

function newUnit(
  state: State,
  s: Scheduler,
  spec: { unit_id: string; text: string; kind: string; topic: string | null; rests_on: string[] },
  extra: { origin: Origin; told: boolean; observe_only: boolean; at: number; event: string },
): Unit {
  const u: Unit = {
    id: spec.unit_id,
    text: spec.text,
    kind: spec.kind,
    topic: spec.topic,
    rests_on: cleanLinks(state, spec.unit_id, spec.rests_on),
    status: "active",
    successors: [],
    predecessors: [],
    origin: extra.origin,
    told: extra.told,
    observe_only: extra.observe_only,
    found_at: extra.at,
    found_event: extra.event,
    retired_at: null,
    wordings: [{ text: spec.text, by: "found", at: extra.at }],
    evidence: [],
    observations: { present: 0, missing: 0, last_at: null },
    memory: s.init(),
    memory_reviews: 0,
    rebuilt_once: false,
    first_success_at: null,
    last_probed_at: null,
    ladders: { explain: null, use: null },
  };
  state.units[u.id] = u;
  return u;
}

/** Points every link to `from` at `to` instead (one or several units). */
function relink(state: State, from: string, to: string[]): void {
  for (const u of Object.values(state.units)) {
    if (!u.rests_on.includes(from)) continue;
    const next: string[] = [];
    for (const id of u.rests_on.flatMap((id) => (id === from ? to : [id]))) {
      if (id !== u.id && !next.includes(id)) next.push(id);
    }
    u.rests_on = next;
  }
}

function resetLearning(u: Unit, s: Scheduler): void {
  u.memory = s.init();
  u.memory_reviews = 0;
  u.rebuilt_once = false;
  u.first_success_at = null;
  u.last_probed_at = null;
  u.ladders = { explain: null, use: null };
}

/** One step of the learning fold. Recall and rebuild feed the memory model; explain and use climb a ladder. */
function learn(u: Unit, ev: Evidence, s: Scheduler): void {
  const grade = ev.grade!;
  const depth = ev.depth!;
  u.last_probed_at = u.last_probed_at === null ? ev.at : Math.max(u.last_probed_at, ev.at);
  // Legacy v1 MCQs, preliminary gates, and assisted/revealed MCQs update exposure recency only.
  // Clean v2 standalone discrimination MCQs feed conservative memory updates without promoting
  // rebuilt_once or explain/use production ladders.
  if (isRecognitionProbe(ev)) {
    if (isStandaloneMcqCredit(ev)) {
      u.memory = s.update(u.memory, { grade: grade === "again" ? "again" : "hard", at: ev.at });
      u.memory_reviews++;
    }
    return;
  }
  if (depth === "recall" || depth === "rebuild") {
    u.memory = s.update(u.memory, { grade, at: ev.at });
    u.memory_reviews++;
    if (grade !== "again") {
      if (depth === "rebuild") u.rebuilt_once = true;
      if (u.first_success_at === null) {
        u.first_success_at = ev.at;
        // The ladder starts at the first success: first explain/use probe 3 days later, then 7, 21, 60.
        const start: Ladder = { step: 1, due: ev.at + LADDER_DAYS[0] * DAY_MS };
        u.ladders = { explain: u.ladders.explain ?? { ...start }, use: u.ladders.use ?? { ...start } };
      }
    }
    return;
  }
  const prev = u.ladders[depth];
  const next: Ladder =
    grade === "again"
      ? { step: 1, due: ev.at + LADDER_DAYS[0] * DAY_MS }
      : (() => {
          const step = prev?.step ?? 1;
          return { step: Math.min(step + 1, LADDER_DAYS.length - 1), due: ev.at + LADDER_DAYS[step]! * DAY_MS };
        })();
  u.ladders = { ...u.ladders, [depth]: next };
}

function relearn(state: State, u: Unit, s: Scheduler): void {
  resetLearning(u, s);
  for (const id of u.evidence) {
    const ev = state.evidence[id]!;
    if (ev.source === "probe") learn(u, ev, s);
  }
}

const reducers: { [T in EventType]?: Reducer<T> } = {
  "unit.found": (state, e, s) => {
    const p = e.payload;
    if (state.units[p.unit_id]) return anomaly(state, e, `unit ${p.unit_id} already exists`);
    newUnit(state, s, p, { origin: p.origin, told: p.told, observe_only: p.observe_only, at: e.ts, event: e.id });
  },

  "unit.reworded": (state, e) => {
    const u = resolveUnit(state, e.payload.unit_id);
    if (!u) return anomaly(state, e, `reword of unknown unit ${e.payload.unit_id}`);
    if (e.payload.text !== undefined && e.payload.text !== u.text) {
      u.text = e.payload.text;
      u.wordings.push({ text: e.payload.text, by: e.payload.by, at: e.ts });
    }
    if (e.payload.kind !== undefined) u.kind = e.payload.kind;
  },

  "unit.linked": (state, e) => {
    const u = resolveUnit(state, e.payload.unit_id);
    if (!u) return anomaly(state, e, `link of unknown unit ${e.payload.unit_id}`);
    u.rests_on = cleanLinks(state, u.id, e.payload.rests_on);
  },

  "unit.split": (state, e, s) => {
    const p = e.payload;
    const u = state.units[p.unit_id];
    if (!u || (u.status !== "active" && u.status !== "retired")) {
      return anomaly(state, e, `split of ${u ? u.status : "unknown"} unit ${p.unit_id}`);
    }
    const parts = p.into.filter((spec) => {
      if (!state.units[spec.unit_id] && spec.unit_id !== u.id) return true;
      anomaly(state, e, `split part ${spec.unit_id} already exists`);
      return false;
    });
    if (parts.length === 0) return;
    for (const spec of parts) {
      const part = newUnit(state, s, spec, { origin: u.origin, told: u.told, observe_only: u.observe_only, at: e.ts, event: e.id });
      part.predecessors.push(u.id);
    }
    u.status = "split";
    u.successors = parts.map((p) => p.unit_id);
    relink(state, u.id, u.successors);
  },

  "unit.merged": (state, e) => {
    const p = e.payload;
    const survivor = resolveUnit(state, p.unit_id);
    if (!survivor || (survivor.status !== "active" && survivor.status !== "retired")) {
      return anomaly(state, e, `merge into unusable unit ${p.unit_id}`);
    }
    for (const id of p.merged) {
      const m = state.units[id];
      if (!m || m.id === survivor.id || (m.status !== "active" && m.status !== "retired")) {
        anomaly(state, e, `cannot merge ${id} into ${survivor.id}`);
        continue;
      }
      m.status = "merged";
      m.successors = [survivor.id];
      survivor.predecessors.push(m.id);
      relink(state, m.id, [survivor.id]);
    }
    if (p.text !== null && p.text !== survivor.text) {
      survivor.text = p.text;
      survivor.wordings.push({ text: p.text, by: "tutor", at: e.ts });
    }
  },

  "unit.retired": (state, e) => {
    const u = resolveUnit(state, e.payload.unit_id);
    if (!u || u.status !== "active") return anomaly(state, e, `cannot retire unit ${e.payload.unit_id}`);
    u.status = "retired";
    u.retired_at = e.ts;
  },

  "unit.probed": (state, e, s) => {
    const p = e.payload;
    if (isCorrection(p)) {
      const target = state.evidence[p.corrects];
      if (!target || target.source !== "probe") return anomaly(state, e, `correction of unknown probe ${p.corrects}`);
      target.grade = p.grade;
      target.corrected_by = e.id;
      relearn(state, state.units[target.unit_id]!, s);
      return;
    }
    const u = resolveUnit(state, p.unit_id);
    if (!u) return anomaly(state, e, `probe of unknown unit ${p.unit_id}`);
    const ev: Evidence = {
      event_id: e.id,
      seq: e.seq,
      unit_id: u.id,
      at: e.ts,
      source: "probe",
      depth: p.depth,
      slot: p.slot,
      prompt: p.prompt,
      answer_message_id: p.answer_message_id,
      inferred_grade: p.grade,
      grade: p.corrected_grade ?? p.grade,
      corrected_by: null,
      hints: p.hints,
      latency_ms: p.latency_ms,
      scheduler: p.scheduler,
      predicted_recall: p.predicted_recall,
      present: null,
      note: null,
      ...(p.modality ? { modality: p.modality } : {}),
      ...(p.mcq_role ? { mcq_role: p.mcq_role } : {}),
      ...(p.mcq_item_id ? { mcq_item_id: p.mcq_item_id } : {}),
      ...(p.mcq_outcome ? { mcq_outcome: p.mcq_outcome } : {}),
      ...(p.mcq_choice_id ? { mcq_choice_id: p.mcq_choice_id } : {}),
    };
    state.evidence[e.id] = ev;
    u.evidence.push(e.id);
    learn(u, ev, s);
    // A retired unit that fails is back in play.
    if (u.status === "retired" && ev.grade === "again") {
      u.status = "active";
      u.retired_at = null;
    }
  },

  "unit.observed": (state, e) => {
    const p = e.payload;
    const u = resolveUnit(state, p.unit_id);
    if (!u) return anomaly(state, e, `observation of unknown unit ${p.unit_id}`);
    state.evidence[e.id] = {
      event_id: e.id,
      seq: e.seq,
      unit_id: u.id,
      at: e.ts,
      source: "observation",
      depth: null,
      slot: null,
      prompt: null,
      answer_message_id: p.message_id,
      inferred_grade: null,
      grade: null,
      corrected_by: null,
      hints: 0,
      latency_ms: p.elapsed_ms,
      scheduler: null,
      predicted_recall: null,
      present: p.present,
      note: p.note,
    };
    u.evidence.push(e.id);
    if (p.present) u.observations.present++;
    else u.observations.missing++;
    u.observations.last_at = e.ts;
  },

  "page.created": (state, e) => {
    const p = e.payload;
    if (state.pages[p.page_id]) return anomaly(state, e, `page ${p.page_id} already exists`);
    state.pages[p.page_id] = newPage(p.page_id, p.title, p.starter, e.ts, p.probe);
  },

  "page.ran": (state, e) => {
    const p = e.payload;
    const page = state.pages[p.page_id];
    if (!page) return anomaly(state, e, `run of unknown page ${p.page_id}`);
    applyPageRun(page, p, e.ts);
  },

  "page.edited": (state, e) => {
    const p = e.payload;
    const page = state.pages[p.page_id];
    if (!page) return anomaly(state, e, `edit of unknown page ${p.page_id}`);
    try {
      applyPageEdit(page, p.base_rev, p.steps, e.ts);
    } catch (err) {
      if (!(err instanceof PageEditError)) throw err;
      anomaly(state, e, `edit of page ${p.page_id} refused: ${err.message}`);
    }
  },

  "run.started": runReducer,
  "run.paused": runReducer,
  "run.resumed": runReducer,
  "run.ended": runReducer,

  "goal.set": (state, e) => {
    const p = e.payload;
    state.goals[p.goal_id] = { id: p.goal_id, text: p.text, due: p.due, topic: p.topic, unit_ids: p.unit_ids, active: p.active, set_at: e.ts };
  },

  "budget.set": (state, e) => {
    state.budget = { seconds: e.payload.seconds, note: e.payload.note, set_at: e.ts };
  },

  "preference.set": (state, e) => {
    const p = e.payload as Payload<"preference.set">;
    state.preferences[p.key] = { value: p.value, lasting: p.lasting, set_at: e.ts, event_id: e.id };
  },
};

function runReducer(state: State, e: Applied<"run.started" | "run.paused" | "run.resumed" | "run.ended">): void {
  const refused = applyRunEvent(state.runs, e as MyelinEvent);
  if (refused) anomaly(state, e, refused);
}

/** JSON with object keys sorted at every level, for comparing states byte for byte. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
    }
    return v;
  });
}
