// The units table: the card the tutor posts when the learner asks where they stand. A snapshot of
// each unit's evidence by depth, taken when it was asked for. The statement and kind follow later
// rewordings on the client; the evidence stays as it was then.
import { isRebuildable, resolveUnit, type Depth, type Origin, type State, type Unit } from "@myelin/core";

export type ChipState = "shown" | "not_yet" | "missed";

export interface UnitsRow {
  unit_id: string;
  text: string;
  kind: string;
  /** How and when it was found, if that was in the last week, such as "found Monday, by a miss". */
  found: string | null;
  rests_on: string;
  /** Told and not yet rebuilt: shown as words, not chips. */
  told: boolean;
  depths: { depth: Depth; state: ChipState }[];
}

export interface UnitsCard {
  kind: "units";
  rows: UnitsRow[];
}

export const MAX_ROWS = 20;
const RECENT_MS = 7 * 86_400_000;

const HOW: Record<Origin, string> = {
  hint: "with a hint",
  derived: "by deriving it",
  error: "by a miss",
  need: "when it was needed",
  told: "told",
  observed: "in your work",
  imported: "imported",
};

/** The depths that apply to a unit: explain and rebuild only to what rests on something. */
export function depthsOf(u: Unit): Depth[] {
  if (u.observe_only) return ["use"];
  return isRebuildable(u) ? ["recall", "rebuild", "explain", "use"] : ["recall", "use"];
}

/**
 * Missed if the last attempt at a depth failed, shown if it succeeded, not yet if none was made.
 * The depths are those that apply to the unit and any others it was tested at.
 */
export function chips(state: State, u: Unit): { depth: Depth; state: ChipState }[] {
  const seen = new Map<Depth, { last: boolean }>();
  for (const id of u.evidence) {
    const ev = state.evidence[id];
    if (!ev) continue;
    let depth: Depth | null = ev.depth;
    let ok: boolean | null = null;
    if (ev.source === "observation") {
      depth = "use";
      ok = ev.present;
    } else if (ev.grade !== null) ok = ev.grade !== "again";
    if (depth === null || ok === null) continue;
    seen.set(depth, { last: ok });
  }
  // A depth that was tested applies, even if it would not by default.
  const order: Depth[] = ["recall", "rebuild", "explain", "use"];
  const depths = order.filter((d) => depthsOf(u).includes(d) || seen.has(d));
  return depths.map((depth) => {
    const s = seen.get(depth);
    return { depth, state: !s ? "not_yet" : s.last ? "shown" : "missed" };
  });
}

function dayKey(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

/** "today", "yesterday" or the weekday, in the learner's time zone. */
export function dayWord(at: number, now: number, timeZone?: string): string {
  const d = dayKey(at, timeZone);
  if (d === dayKey(now, timeZone)) return "today";
  if (d === dayKey(now - 86_400_000, timeZone)) return "yesterday";
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(at);
}

export function unitsRow(state: State, u: Unit, now: number, timeZone?: string): UnitsRow {
  const rests = u.rests_on.map((id) => resolveUnit(state, id)?.text ?? id);
  const recent = now - u.found_at < RECENT_MS;
  return {
    unit_id: u.id,
    text: u.text,
    kind: u.kind,
    found: recent ? `found ${dayWord(u.found_at, now, timeZone)}, ${HOW[u.origin]}` : null,
    rests_on: rests.length ? rests.join("; ") : u.observe_only ? "nothing" : "nothing, memorized",
    told: u.told && isRebuildable(u) && !u.rebuilt_once,
    depths: chips(state, u),
  };
}

/**
 * The table for the units asked about: the ids given, in that order, or those matching a topic, or
 * all of them. Returns why it cannot, as a string.
 */
export function unitsTable(state: State, sel: { unit_ids?: readonly string[] | undefined; topic?: string | undefined }, now: number, timeZone?: string): UnitsCard | string {
  let units: Unit[];
  if (sel.unit_ids?.length) {
    const unknown = sel.unit_ids.filter((id) => !resolveUnit(state, id));
    if (unknown.length) return `No unit with id ${unknown.join(", ")}. get_profile lists the ids.`;
    units = [...new Set(sel.unit_ids.map((id) => resolveUnit(state, id)!))];
  } else {
    const t = sel.topic?.trim().toLowerCase();
    units = Object.values(state.units)
      .filter((u) => u.status === "active" || u.status === "retired")
      .filter((u) => !t || u.topic?.toLowerCase() === t || u.text.toLowerCase().includes(t))
      .sort((a, b) => a.found_at - b.found_at);
  }
  if (units.length === 0) return sel.topic ? `No units match "${sel.topic}".` : "There are no units yet.";
  if (units.length > MAX_ROWS) return `${units.length} units match. A table holds at most ${MAX_ROWS}: pass the unit_ids that answer the question.`;
  return { kind: "units", rows: units.map((u) => unitsRow(state, u, now, timeZone)) };
}
