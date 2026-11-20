// Time: timed runs and active time, both derived from the log.
//
// A run's clock is wall time less its pauses. Active time is the time the learner was present,
// reconstructed from marks: learner messages, page edits, runs of code and the client's activity
// signals. Two marks no more than ACTIVE_GAP_MS apart are joined; a blur or away signal ends the
// span. A gap longer than that is an absence and does not count.
import type { MyelinEvent } from "./events.js";
import { STUDY_MODE_DEVICE } from "./import/study-mode.js";

export const ACTIVE_GAP_MS = 5 * 60_000;

export type RunEnd = "time" | "stopped";

export interface Run {
  id: string;
  /** The page the run's work is on, if it has one. */
  page_id: string | null;
  duration_ms: number;
  conditions: string;
  started_at: number;
  /** When the current pause began. Null while the clock runs. */
  paused_at: number | null;
  /** Time spent in earlier pauses. */
  paused_ms: number;
  ended_at: number | null;
  /** Why it ended: its time ran out, or it was stopped early. */
  end: RunEnd | null;
}

/**
 * Applies a run event to `runs`, mutating it. Returns why the event was refused, or null. Used by
 * the state reducer and by clients that fold runs from the events they hold.
 */
export function applyRunEvent(runs: Record<string, Run>, e: MyelinEvent): string | null {
  switch (e.type) {
    case "run.started": {
      const p = e.payload;
      if (runs[p.run_id]) return `run ${p.run_id} already exists`;
      const open = currentRun(runs);
      if (open) return `run ${p.run_id} started while run ${open.id} is on`;
      runs[p.run_id] = {
        id: p.run_id,
        page_id: p.page_id,
        duration_ms: p.duration_ms,
        conditions: p.conditions,
        started_at: e.ts,
        paused_at: null,
        paused_ms: 0,
        ended_at: null,
        end: null,
      };
      return null;
    }
    case "run.paused": {
      const r = runs[e.payload.run_id];
      if (!r || r.ended_at !== null) return `pause of run ${e.payload.run_id}, which is not on`;
      if (r.paused_at !== null) return `run ${r.id} is already paused`;
      r.paused_at = e.ts;
      return null;
    }
    case "run.resumed": {
      const r = runs[e.payload.run_id];
      if (!r || r.ended_at !== null) return `resume of run ${e.payload.run_id}, which is not on`;
      if (r.paused_at === null) return `run ${r.id} is not paused`;
      r.paused_ms += Math.max(0, e.ts - r.paused_at);
      r.paused_at = null;
      return null;
    }
    case "run.ended": {
      const r = runs[e.payload.run_id];
      if (!r || r.ended_at !== null) return `end of run ${e.payload.run_id}, which is not on`;
      if (r.paused_at !== null) {
        r.paused_ms += Math.max(0, e.ts - r.paused_at);
        r.paused_at = null;
      }
      // A run that ran out of time ends at its length, however late the event that says so.
      r.ended_at = e.payload.reason === "time" ? Math.min(e.ts, r.started_at + r.paused_ms + r.duration_ms) : e.ts;
      r.end = e.payload.reason;
      return null;
    }
    default:
      return null;
  }
}

/** Folds the runs out of a list of events, ignoring the ones that do not apply. */
export function foldRuns(events: Iterable<MyelinEvent>): Record<string, Run> {
  const runs: Record<string, Run> = {};
  for (const e of events) applyRunEvent(runs, e);
  return runs;
}

/** The run that is on, paused or not. At most one is. */
export function currentRun(runs: Record<string, Run>): Run | null {
  for (const r of Object.values(runs)) if (r.ended_at === null) return r;
  return null;
}

/** Clock time the run has used: wall time since it started, less its pauses. */
export function runElapsed(r: Run, now: number): number {
  const until = r.ended_at ?? now;
  const pausing = r.paused_at !== null ? Math.max(0, until - r.paused_at) : 0;
  return Math.max(0, Math.min(r.duration_ms, until - r.started_at - r.paused_ms - pausing));
}

export function runLeft(r: Run, now: number): number {
  return Math.max(0, r.duration_ms - runElapsed(r, now));
}

/** When the clock reaches zero if nothing pauses it. Null while paused or ended. */
export function runEndsAt(r: Run): number | null {
  if (r.ended_at !== null || r.paused_at !== null) return null;
  return r.started_at + r.paused_ms + r.duration_ms;
}

/** A clock reading: "4:05", or "1:02:00" past an hour. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// --- Active time --------------------------------------------------------------------------------

/** A moment the learner was there (`on`), or left (`on: false`). */
export interface Mark {
  at: number;
  on: boolean;
}

/** The presence marks an event carries. Tutor, server and imported events carry none. */
export function marksOf(e: MyelinEvent): Mark[] {
  if (e.device_id === STUDY_MODE_DEVICE || e.device_id.startsWith("server:")) return [];
  switch (e.type) {
    case "message.added": {
      if (e.payload.author !== "learner") return [];
      const t = e.payload.timing;
      const out: Mark[] = [];
      if (t?.input_started_at != null) out.push({ at: t.input_started_at, on: true });
      out.push({ at: t?.sent_at ?? e.ts, on: true });
      return out;
    }
    case "page.edited": {
      const started = (e.payload as { started_at?: unknown }).started_at;
      const out: Mark[] = [];
      if (typeof started === "number" && started <= e.ts) out.push({ at: started, on: true });
      out.push({ at: e.ts, on: true });
      return out;
    }
    case "unit.reworded":
      return e.payload.by === "learner" ? [{ at: e.ts, on: true }] : [];
    case "activity.signal":
      return [{ at: e.ts, on: e.payload.signal === "focus" || e.payload.signal === "typing" }];
    default:
      return [];
  }
}

/** Inserts a mark, keeping the list sorted by time. */
export function addMark(marks: Mark[], m: Mark): void {
  let i = marks.length;
  while (i > 0 && marks[i - 1]!.at > m.at) i--;
  marks.splice(i, 0, m);
}

/**
 * The active time within [from, to], given marks sorted by time. The span starts present unless
 * the last mark at or before `from` says the learner had left.
 */
export function activeMs(marks: readonly Mark[], from: number, to: number, gap = ACTIVE_GAP_MS): number {
  if (!(to > from)) return 0;
  let lo = 0;
  let hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid]!.at <= from) lo = mid + 1;
    else hi = mid;
  }
  let on = lo > 0 ? marks[lo - 1]!.on : true;
  let prev = from;
  let total = 0;
  for (let i = lo; i < marks.length && marks[i]!.at < to; i++) {
    const m = marks[i]!;
    if (on && m.at - prev <= gap) total += m.at - prev;
    prev = m.at;
    on = m.on;
  }
  if (on && to - prev <= gap) total += to - prev;
  return total;
}
