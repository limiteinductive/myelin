// The three measures of whether Myelin works, from one learner's log and state:
//
// 1. Success on use probes at least 7 days after the unit was found: understanding that lasts and
//    transfers, not recall of what was just said.
// 2. Predicted against actual recall: whether the scheduler's predictions can be trusted.
// 3. Active time per week by activity, set against the units gained that week.
//
// They are for the person running the server, read with `myelin metrics`. Time is never shown in
// the thread outside timed runs and debriefs.
import type { MyelinEvent } from "./events.js";
import type { Evidence, State, Unit } from "./state.js";
import { ACTIVE_GAP_MS, foldRuns, marksOf } from "./time.js";

export const USE_AFTER_MS = 7 * 86_400_000;

export type Activity = "thread" | "page" | "timed run";
export const ACTIVITIES: readonly Activity[] = ["thread", "page", "timed run"];

export interface UseMetric {
  probes: number;
  succeeded: number;
  units: number;
}

export interface CalibrationBin {
  /** Lower bound of predicted recall, inclusive. */
  from: number;
  to: number;
  probes: number;
  predicted: number;
  actual: number;
}

export interface Calibration {
  probes: number;
  /** Mean squared gap between predicted recall and the outcome (1 or 0). Lower is better. */
  brier: number | null;
  predicted: number | null;
  actual: number | null;
  bins: CalibrationBin[];
}

export interface Week {
  /** The Monday that starts the week, YYYY-MM-DD in the learner's time zone. */
  week: string;
  active_ms: Record<Activity, number>;
  units_found: number;
  use: { probes: number; succeeded: number };
}

export interface Metrics {
  use: UseMetric;
  calibration: Calibration;
  weeks: Week[];
}

const BIN_EDGES = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1.000001];

/** The Monday that starts the week holding `ms`, in `timeZone`. */
export function weekOf(ms: number, timeZone?: string): string {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms).split("-").map(Number) as [number, number, number];
  const day = Date.UTC(y, m - 1, d);
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

const succeeded = (grade: string | null) => grade !== null && grade !== "again";

function useProbes(state: State): { at: number; unit: Unit; ok: boolean }[] {
  const out: { at: number; unit: Unit; ok: boolean }[] = [];
  for (const ev of Object.values(state.evidence)) {
    if (ev.source !== "probe" || ev.depth !== "use" || ev.grade === null || ev.slot === "imported") continue;
    const unit = state.units[ev.unit_id];
    if (!unit || ev.at - unit.found_at < USE_AFTER_MS) continue;
    out.push({ at: ev.at, unit, ok: succeeded(ev.grade) });
  }
  return out;
}

/**
 * Predicted recall against the outcome. Only recall and rebuild probes feed the memory model, so only
 * they test its prediction, and only once it has a review to predict from: with none the scheduler
 * gives 0, which ranks the unit first rather than predicting anything. Imported probes carry another
 * scheduler's predictions and are left out, though they count as reviews.
 */
export function calibration(state: State): Calibration {
  const pairs: { p: number; y: number }[] = [];
  for (const u of Object.values(state.units)) {
    let reviews = 0;
    const probes = u.evidence
      .map((id) => state.evidence[id])
      .filter((ev): ev is Evidence => ev !== undefined && ev.source === "probe" && ev.grade !== null && (ev.depth === "recall" || ev.depth === "rebuild"))
      .sort((a, b) => a.seq - b.seq);
    for (const ev of probes) {
      if (reviews > 0 && ev.slot !== "imported" && ev.predicted_recall !== null) pairs.push({ p: ev.predicted_recall, y: succeeded(ev.grade) ? 1 : 0 });
      reviews++;
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const bins: CalibrationBin[] = [];
  for (let i = 1; i < BIN_EDGES.length; i++) {
    const [from, to] = [BIN_EDGES[i - 1]!, BIN_EDGES[i]!];
    const inBin = pairs.filter((x) => x.p >= from && x.p < to);
    if (inBin.length) bins.push({ from, to: Math.min(1, to), probes: inBin.length, predicted: mean(inBin.map((x) => x.p))!, actual: mean(inBin.map((x) => x.y))! });
  }
  return {
    probes: pairs.length,
    brier: mean(pairs.map((x) => (x.p - x.y) ** 2)),
    predicted: mean(pairs.map((x) => x.p)),
    actual: mean(pairs.map((x) => x.y)),
    bins,
  };
}

/**
 * Active time split by what the learner was doing. A stretch between two marks no more than the
 * gap apart counts toward the activity of the mark that ends it: a message in the thread, an edit
 * or an aside on a page. Focus and typing signals carry on whatever came before. Time inside a
 * timed run counts as the run.
 */
export function activeByActivity(events: readonly MyelinEvent[], now: number, gap = ACTIVE_GAP_MS): { at: number; ms: number; activity: Activity }[] {
  const runs = Object.values(foldRuns(events)).map((r) => [r.started_at, r.ended_at ?? now] as const);
  const marks: { at: number; on: boolean; activity: Activity | null }[] = [];
  for (const e of events) {
    let activity: Activity | null = null;
    if (e.type === "message.added") activity = e.payload.anchor ? "page" : "thread";
    else if (e.type === "page.edited") activity = "page";
    else if (e.type === "unit.reworded") activity = "thread";
    for (const m of marksOf(e)) marks.push({ ...m, activity });
  }
  marks.sort((a, b) => a.at - b.at);
  const out: { at: number; ms: number; activity: Activity }[] = [];
  let current: Activity = "thread";
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1]!;
    const m = marks[i]!;
    const doing: Activity = m.activity ?? current;
    if (prev.on && m.at - prev.at <= gap && m.at > prev.at) {
      const mid = (prev.at + m.at) / 2;
      const inRun = runs.some(([a, b]) => mid >= a && mid <= b);
      out.push({ at: prev.at, ms: m.at - prev.at, activity: inRun ? "timed run" : doing });
    }
    current = doing;
  }
  return out;
}

export function metrics(events: readonly MyelinEvent[], state: State, now: number, timeZone?: string): Metrics {
  const uses = useProbes(state);
  const weeks = new Map<string, Week>();
  const week = (ms: number) => {
    const key = weekOf(ms, timeZone);
    let w = weeks.get(key);
    if (!w) weeks.set(key, (w = { week: key, active_ms: { thread: 0, page: 0, "timed run": 0 }, units_found: 0, use: { probes: 0, succeeded: 0 } }));
    return w;
  };
  for (const s of activeByActivity(events, now)) week(s.at).active_ms[s.activity] += s.ms;
  for (const e of events) if (e.type === "unit.found" && e.payload.origin !== "imported") week(e.ts).units_found++;
  for (const u of uses) {
    const w = week(u.at);
    w.use.probes++;
    if (u.ok) w.use.succeeded++;
  }
  return {
    use: { probes: uses.length, succeeded: uses.filter((u) => u.ok).length, units: new Set(uses.map((u) => u.unit.id)).size },
    calibration: calibration(state),
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)),
  };
}
