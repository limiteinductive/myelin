// The event log: the single source of truth. Every type in the spec's "Event types" table has a
// payload schema here. Milestone 1 reduces units, evidence, memory and planning; the other types
// are validated now and reduced in later milestones.
import { z } from "zod";

export const SCHEMA_VERSION = 1;

const Id = z.string().min(1);
const Ms = z.number().int().nonnegative();

export const Grade = z.enum(["again", "hard", "good", "easy"]);
export type Grade = z.infer<typeof Grade>;

/** The evidence ladder, minus "fast", which is measured on every probe and never probed alone. */
export const Depth = z.enum(["recall", "rebuild", "explain", "use"]);
export type Depth = z.infer<typeof Depth>;

export const SlotKind = z.enum(["in_context", "greeting", "seam", "timed_run"]);
export type SlotKind = z.infer<typeof SlotKind>;

/** How a unit was found (spec: "How units are found"). */
export const Origin = z.enum(["hint", "derived", "error", "need", "told", "observed", "imported"]);
export type Origin = z.infer<typeof Origin>;

const UnitSpec = z.object({
  unit_id: Id,
  text: z.string().min(1),
  kind: z.string().min(1),
  topic: z.string().nullable().default(null),
  /** Units this one can be rebuilt from. Empty means arbitrary: memorized as it is. */
  rests_on: z.array(Id).default([]),
});

const Anchor = z.object({
  page_id: Id,
  rev: z.number().int().nonnegative(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  quote: z.string(),
});

const Timing = z.object({
  shown_at: Ms.nullable().default(null),
  input_started_at: Ms.nullable().default(null),
  sent_at: Ms.nullable().default(null),
});

const ProbeRecord = z.object({
  unit_id: Id,
  depth: Depth,
  /** "imported" marks probes carried over from study-mode, which had no slots. */
  slot: z.union([SlotKind, z.literal("imported")]),
  prompt: z.string(),
  answer_message_id: Id.nullable().default(null),
  /** The grade the tutor inferred. */
  grade: Grade,
  /** A correction the learner made in the same turn. It overrides `grade`. */
  corrected_grade: Grade.nullable().default(null),
  hints: z.number().int().nonnegative().default(0),
  latency_ms: Ms.nullable().default(null),
  scheduler: z.string(),
  predicted_recall: z.number().min(0).max(1).nullable().default(null),
});

/** A later correction ("that was lucky") is a new unit.probed event that names the probe it corrects. */
const ProbeCorrection = z.object({
  unit_id: Id,
  corrects: Id,
  grade: Grade,
  note: z.string().nullable().default(null),
});

export const payloads = {
  "message.added": z.object({
    author: z.enum(["learner", "tutor"]),
    text: z.string(),
    cards: z.array(z.looseObject({ kind: z.string() })).default([]),
    anchor: Anchor.nullable().default(null),
    timing: Timing.nullable().default(null),
  }),

  /** `probe` marks a page opened to test a unit there, such as an explanation for a newcomer. */
  "page.created": z.object({
    page_id: Id,
    title: z.string(),
    starter: z.string().nullable().default(null),
    probe: z.object({ unit_id: Id, depth: Depth }).nullable().default(null),
  }),
  "page.edited": z.looseObject({ page_id: Id, base_rev: z.number().int().nonnegative(), steps: z.array(z.unknown()) }),
  /**
   * One run of every code block on the page at `rev`, top to bottom. `blocks` holds one result per
   * block that ran; the run stops at the first that fails, so later blocks have none.
   */
  "page.ran": z.looseObject({
    page_id: Id,
    rev: z.number().int().nonnegative(),
    blocks: z.array(z.object({ output: z.string(), failed: z.boolean().default(false) })).default([]),
    timed_out: z.boolean().default(false),
    duration_ms: Ms.nullable().default(null),
  }),

  "unit.found": UnitSpec.extend({
    origin: Origin,
    /** Told rather than produced. A told unit that can be rebuilt is not probed until rebuilt once. */
    told: z.boolean().default(false),
    /** Evidence comes only from observation (reflexes). Never probed by asking. */
    observe_only: z.boolean().default(false),
    message_id: Id.nullable().default(null),
  }),
  "unit.reworded": z
    .object({ unit_id: Id, text: z.string().min(1).optional(), kind: z.string().min(1).optional(), by: z.enum(["learner", "tutor"]) })
    .refine((p) => p.text !== undefined || p.kind !== undefined, "reword needs text or kind"),
  /** Replaces what a unit rests on. */
  "unit.linked": z.object({ unit_id: Id, rests_on: z.array(Id) }),
  "unit.split": z.object({ unit_id: Id, into: z.array(UnitSpec).min(2) }),
  /** `merged` units fold into the surviving `unit_id`. */
  "unit.merged": z.object({ unit_id: Id, merged: z.array(Id).min(1), text: z.string().min(1).nullable().default(null) }),
  "unit.retired": z.object({ unit_id: Id, reason: z.string().nullable().default(null) }),

  "unit.probed": z.union([ProbeCorrection, ProbeRecord]),
  "unit.observed": z.object({
    unit_id: Id,
    /** Whether the move appeared unprompted. */
    present: z.boolean(),
    note: z.string().nullable().default(null),
    page_id: Id.nullable().default(null),
    message_id: Id.nullable().default(null),
    /** How early in the work it appeared. */
    elapsed_ms: Ms.nullable().default(null),
  }),

  "activity.signal": z.looseObject({ signal: z.enum(["focus", "blur", "typing", "away"]) }),
  /** A timed run. `page_id` is the page its work is on, if any. */
  "run.started": z.looseObject({ run_id: Id, duration_ms: z.number().int().positive(), conditions: z.string(), page_id: Id.nullable().default(null) }),
  "run.paused": z.looseObject({ run_id: Id }),
  "run.resumed": z.looseObject({ run_id: Id }),
  /** `time` when the clock ran out, `stopped` when the learner stopped it early. */
  "run.ended": z.looseObject({ run_id: Id, reason: z.enum(["time", "stopped"]).default("stopped") }),

  "goal.set": z.object({
    goal_id: Id,
    text: z.string(),
    due: Ms.nullable().default(null),
    topic: z.string().nullable().default(null),
    unit_ids: z.array(Id).default([]),
    active: z.boolean().default(true),
  }),
  "budget.set": z.object({ seconds: z.number().int().positive(), note: z.string().nullable().default(null) }),
  "preference.set": z.object({ key: z.string().min(1), value: z.json(), lasting: z.boolean().default(true) }),
  "source.added": z.object({ source_id: Id, title: z.string(), hash: z.string(), mime: z.string() }),
} as const;

export type EventType = keyof typeof payloads;
export const EVENT_TYPES = Object.keys(payloads) as EventType[];
export type Payload<T extends EventType> = z.output<(typeof payloads)[T]>;
export type ProbeRecord = z.output<typeof ProbeRecord>;
export type ProbeCorrection = z.output<typeof ProbeCorrection>;

export interface EventOf<T extends EventType> {
  id: string;
  device_id: string;
  ts: number;
  type: T;
  v: number;
  payload: Payload<T>;
  /** Assigned by the server on append. Absent on an event not yet appended. */
  seq?: number;
}
export type MyelinEvent = { [T in EventType]: EventOf<T> }[EventType];

const Envelope = z.object({
  id: z.uuid(),
  device_id: z.string().min(1),
  ts: Ms,
  type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]),
  v: z.number().int().positive(),
  payload: z.unknown(),
  seq: z.number().int().positive().optional(),
});

export class EventError extends Error {}

/** Validates an event and fills payload defaults. Throws EventError. */
export function parseEvent(input: unknown): MyelinEvent {
  const env = Envelope.safeParse(input);
  if (!env.success) throw new EventError(`bad event envelope: ${z.prettifyError(env.error)}`);
  const e = env.data;
  if (e.v > SCHEMA_VERSION) throw new EventError(`event ${e.id}: payload version ${e.v} is newer than ${SCHEMA_VERSION}`);
  const p = payloads[e.type].safeParse(e.payload);
  if (!p.success) throw new EventError(`event ${e.id} (${e.type}): ${z.prettifyError(p.error)}`);
  const out: Record<string, unknown> = { id: e.id, device_id: e.device_id, ts: e.ts, type: e.type, v: e.v, payload: p.data };
  if (e.seq !== undefined) out.seq = e.seq;
  return out as unknown as MyelinEvent;
}

/** Builds a valid event. Payload defaults are filled in, so the result round-trips through parseEvent. */
export function makeEvent<T extends EventType>(
  type: T,
  payload: z.input<(typeof payloads)[T]>,
  meta: { id: string; device_id: string; ts: number; seq?: number },
): EventOf<T> {
  return parseEvent({ ...meta, type, v: SCHEMA_VERSION, payload }) as EventOf<T>;
}

export function isCorrection(p: Payload<"unit.probed">): p is ProbeCorrection {
  return "corrects" in p;
}
