// What the tutor is told at the start of a sitting. The thread is endless, so the tutor gets a
// summary built from the store, never the whole transcript.
import { isRebuildable, lineAt, mapRange, pageText, resolveUnit, type Anchor, type PageState, type Scheduler, type State, type Unit } from "@myelin/core";

export interface ThreadMessage {
  id: string;
  seq: number;
  ts: number;
  author: "learner" | "tutor";
  text: string;
  /** Set when the message belongs to an aside on a page. */
  anchor?: Anchor | null;
  /** When the learner saw the tutor's last message, started typing, and sent. Learner messages only. */
  timing?: { shown_at: number | null; input_started_at: number | null; sent_at: number | null } | null;
}

export interface SittingInput {
  name: string;
  now: number;
  state: State;
  /** Messages before this sitting's first prompt, oldest first. */
  tail: ThreadMessage[];
  timeZone?: string | undefined;
  scheduler?: Scheduler | undefined;
  /** The page the learner is working on, if any. */
  page?: PageState | null | undefined;
}

const TAIL_MESSAGES = 30;
const TAIL_CHARS = 12_000;
const UNITS = 30;

export function formatWhen(ms: number, timeZone?: string, withDay = true): string {
  const opts: Intl.DateTimeFormatOptions = withDay
    ? { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone }
    : { hour: "2-digit", minute: "2-digit", hour12: false, timeZone };
  return new Intl.DateTimeFormat("en-GB", opts).format(ms);
}

export function formatDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone }).format(ms);
}

export function formatAgo(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 2) return "just now";
  if (min < 90) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

function sameDay(a: number, b: number, timeZone?: string): boolean {
  return formatDate(a, timeZone) === formatDate(b, timeZone);
}

/** A page counts as open while it was touched this recently. */
export const OPEN_PAGE_MS = 12 * 3_600_000;

/** The page the learner is working on: the one touched last, by an edit or an aside, if recent enough. */
export function openPage(state: State, messages: readonly ThreadMessage[], now: number): PageState | null {
  const touched = new Map<string, number>();
  for (const p of Object.values(state.pages)) touched.set(p.id, Math.max(p.created_at, p.edited_at));
  for (const m of messages) {
    const id = m.anchor?.page_id;
    if (id && touched.has(id)) touched.set(id, Math.max(touched.get(id)!, m.ts));
  }
  let best: PageState | null = null;
  let at = -Infinity;
  for (const [id, t] of touched) {
    if (t > at) {
      at = t;
      best = state.pages[id]!;
    }
  }
  return best && now - at < OPEN_PAGE_MS ? best : null;
}

/** The unit a page probes, if it is an explanation for a newcomer. */
export function newcomerUnit(state: State, page: PageState): Unit | null {
  if (page.probe?.depth !== "explain") return null;
  return resolveUnit(state, page.probe.unit_id) ?? null;
}

/** What the tutor is told about a page opened for a probe: its part while they work and how to grade it. */
export function probeNote(state: State, page: PageState): string | null {
  if (!page.probe) return null;
  const u = resolveUnit(state, page.probe.unit_id);
  const which = u ? `unit ${u.id} ("${u.text}")` : `unit ${page.probe.unit_id}`;
  if (page.probe.depth !== "explain") {
    return `This page probes ${which} at depth ${page.probe.depth}. When they say it is done, grade it with record_probe at that depth.`;
  }
  return (
    `This page is an explanation of ${which} for a newcomer. While they write, you are that newcomer: someone who knows what it rests on but not the idea itself. ` +
    `Where the writing would lose you, such as a term used before it is explained, a skipped step or a claim with no reason, ask the naive question in an aside: one at a time, never a hint or the answer. ` +
    `When they say it is done, grade it with record_probe at depth explain: easy if you could follow it without asking anything, good if you could follow it once your questions were answered on the page, ` +
    `hard if it took several fixes, again if the core idea is missing or wrong. A gap that is an idea of its own becomes a unit through find_unit.`
  );
}

/** Where an anchored message sits now, for the tutor: the page, the line and the passage. */
export function anchorLabel(state: State, anchor: Anchor): string {
  const page = state.pages[anchor.page_id];
  if (!page) return `on an unknown page, at "${anchor.quote}"`;
  const range = mapRange(page, anchor.rev, anchor.from, anchor.to);
  if (!range) return `on page "${page.title}" (id ${page.id}), at a passage since deleted: "${anchor.quote}"`;
  const line = lineAt(page, range.from);
  return `on page "${page.title}" (id ${page.id}), at line ${line?.n ?? "?"}: "${anchor.quote}"`;
}

/** The newest messages that fit, oldest first. */
export function tailOf(messages: ThreadMessage[], maxMessages = TAIL_MESSAGES, maxChars = TAIL_CHARS): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0 && out.length < maxMessages; i--) {
    const m = messages[i]!;
    chars += m.text.length;
    if (chars > maxChars && out.length > 0) break;
    out.push(m);
  }
  return out.reverse();
}

export function unitLine(u: Unit, state: State, now?: number, scheduler?: Scheduler): string {
  const rests = u.rests_on.map((id) => state.units[id]?.text ?? id);
  const bits = [u.kind, `id ${u.id}`];
  bits.push(rests.length ? `rests on: ${rests.join("; ")}` : "arbitrary");
  if (u.told && !u.rebuilt_once && isRebuildable(u)) bits.push("told, not yet rebuilt");
  if (u.observe_only) bits.push("observed only");
  else if (scheduler && now !== undefined && u.memory_reviews > 0) bits.push(`predicted recall now ${Math.round(scheduler.recall(u.memory, now) * 100)}%`);
  const ev = u.evidence.length;
  bits.push(ev ? `${ev} pieces of evidence, last ${u.last_probed_at ? formatDate(u.last_probed_at) : "by observation"}` : "no evidence yet");
  return `- ${u.text} (${bits.join(", ")})`;
}

/** Units for this sitting: the active goal's topic first, then the most recently touched. */
export function relevantUnits(state: State, limit = UNITS): Unit[] {
  const topics = new Set(Object.values(state.goals).filter((g) => g.active && g.topic).map((g) => g.topic));
  const goalUnits = new Set(Object.values(state.goals).filter((g) => g.active).flatMap((g) => g.unit_ids));
  const touched = (u: Unit) => Math.max(u.found_at, u.last_probed_at ?? 0, u.observations.last_at ?? 0);
  return Object.values(state.units)
    .filter((u) => u.status === "active")
    .sort((a, b) => {
      const rank = (u: Unit) => (goalUnits.has(u.id) ? 2 : 0) + (u.topic && topics.has(u.topic) ? 1 : 0);
      return rank(b) - rank(a) || touched(b) - touched(a);
    })
    .slice(0, limit);
}

/** How many days before a goal's date the tutor starts offering timed runs. */
export const RAMP_DAYS = 14;

export function buildSittingContext({ name, now, state, tail, timeZone, scheduler, page }: SittingInput): string {
  const lines: string[] = ["# This sitting", ""];
  lines.push(`It is ${formatWhen(now, timeZone)}. The learner is ${name}.`);
  const last = tail.at(-1);
  if (last) lines.push(`The last message in the thread was ${formatAgo(now - last.ts)}.`);
  else lines.push("The thread is empty. This is their first sitting.");

  lines.push("", "## Goal and time");
  const goals = Object.values(state.goals).filter((g) => g.active);
  if (goals.length === 0) lines.push("No goal yet. Ask what they want to learn and by when, then record it with set_goal.");
  for (const g of goals) {
    const due = g.due ? `, due ${formatDate(g.due, timeZone)} (${Math.ceil((g.due - now) / 86_400_000)} days from now)` : ", no date";
    lines.push(`- ${g.text}${due}${g.topic ? `, topic ${g.topic}` : ""} (goal_id ${g.id})`);
  }
  // As a dated goal nears, practice moves toward its conditions: timed runs.
  const soon = goals.filter((g) => g.due !== null && g.due > now && g.due - now <= RAMP_DAYS * 86_400_000);
  if (soon.length > 0) {
    const lastRun = Object.values(state.runs).findLast(() => true);
    const ran = lastRun ? `The last timed run was ${formatAgo(now - lastRun.started_at)}.` : "There has been no timed run yet.";
    lines.push(`The goal date is near. ${ran} When the work allows, offer a timed run under the goal's conditions, at most once a sitting; start it only if they accept.`);
  }
  const budget = state.budget;
  if (budget && now - budget.set_at < 12 * 3600_000) {
    lines.push(`Time budget: ${Math.round(budget.seconds / 60)} minutes, set ${formatAgo(now - budget.set_at)}${budget.note ? ` (${budget.note})` : ""}.`);
  } else {
    lines.push("No time budget for this sitting.");
  }

  const prefs = Object.entries(state.preferences).filter(([, p]) => p.lasting);
  lines.push("", "## Standing preferences");
  if (prefs.length === 0) lines.push("None.");
  for (const [k, p] of prefs) lines.push(`- ${k}: ${typeof p.value === "string" ? p.value : JSON.stringify(p.value)}`);

  const units = relevantUnits(state);
  const total = Object.values(state.units).filter((u) => u.status === "active").length;
  lines.push("", `## Units (${units.length} of ${total})`);
  if (units.length === 0) lines.push("None yet.");
  for (const u of units) lines.push(unitLine(u, state, now, scheduler));

  lines.push("", "## The thread so far (oldest first)");
  if (tail.length === 0) lines.push("Nothing yet.");
  for (const m of tail) {
    const when = sameDay(m.ts, now, timeZone) ? formatWhen(m.ts, timeZone, false) : `${formatDate(m.ts, timeZone)} ${formatWhen(m.ts, timeZone, false)}`;
    const where = m.anchor ? `, in an aside ${anchorLabel(state, m.anchor)}` : "";
    lines.push(`[${m.author === "learner" ? "Learner" : "You"}, ${when}${where}] ${m.text}`);
  }
  if (page) {
    lines.push("", "## The open page", "The learner wrote this; you cannot edit it. Line numbers are for open_aside only. The learner does not see them, so never mention them; quote the words instead.", "", pageText(page));
    const note = probeNote(state, page);
    if (note) lines.push("", note);
  }
  lines.push("", "Messages from the learner follow. Use search_memory for anything older than this tail.");
  return lines.join("\n");
}
