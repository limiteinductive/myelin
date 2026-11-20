// What happened in a timed run, as the tutor reads it to debrief: a chronology on the run's clock
// of what the learner wrote, sent and ran, with the quiet stretches. The tutor names the steps
// from it and show_card turns them into the timeline card.
import {
  applyPageEdit,
  applyPageRun,
  clockText,
  marksOf,
  newPage,
  pageLines,
  pageText,
  PageEditError,
  type MyelinEvent,
  type PageState,
  type Run,
} from "@myelin/core";
import { changedLines } from "./observer.js";

/** A stretch this long on the clock with no sign of the learner is reported as quiet. */
const QUIET_MS = 90_000;
/** A quiet stretch this long must be a step of its own in the timeline. */
export const LONG_QUIET_MS = 3 * 60_000;
const MAX_LINES = 8;

/** Maps wall time to the run's clock, which stands still while it is paused. */
export function runClock(run: Run, events: readonly MyelinEvent[]): (t: number) => number {
  const pauses: [number, number][] = [];
  let since: number | null = null;
  for (const e of events) {
    if (!("run_id" in e.payload) || e.payload.run_id !== run.id) continue;
    if (e.type === "run.paused" && since === null) since = e.ts;
    if ((e.type === "run.resumed" || e.type === "run.ended") && since !== null) {
      pauses.push([since, e.ts]);
      since = null;
    }
  }
  if (since !== null) pauses.push([since, Infinity]);
  return (t) => {
    let paused = 0;
    for (const [a, b] of pauses) if (t > a) paused += Math.min(t, b) - a;
    return Math.max(0, Math.min(run.duration_ms, t - run.started_at - paused));
  };
}

const quote = (s: string, n = 200) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `"${t.length > n ? `${t.slice(0, n)}…` : t}"`;
};

/** The chronology of a run, ended or not, from the whole log. */
export function runReport(run: Run, events: readonly MyelinEvent[], now: number): string {
  const end = run.ended_at ?? now;
  const clock = runClock(run, events);
  const at = (t: number) => clockText(clock(t));
  const inRun = (t: number) => t >= run.started_at && t <= end;
  const items: { t: number; text: string }[] = [];

  // Pages are rebuilt edit by edit so each stretch of writing can say what it changed.
  const pages = new Map<string, PageState>();
  let span: { page: string; from: number; to: number; before: string[] } | null = null;
  const closeSpan = () => {
    if (!span) return;
    const page = pages.get(span.page)!;
    const lines = pageLines(page);
    const changed = changedLines(page, span.before)
      .map((n) => lines.find((l) => l.n === n)!)
      .filter(Boolean);
    const shown = changed.slice(0, MAX_LINES).map((l) => `    ${l.n}: ${l.text.length > 120 ? `${l.text.slice(0, 120)}…` : l.text}`);
    if (changed.length > MAX_LINES) shown.push(`    … and ${changed.length - MAX_LINES} more lines`);
    const what = changed.length ? `, lines new or changed:\n${shown.join("\n")}` : ", nothing new left standing (deleted or rewritten back)";
    items.push({ t: span.from, text: `${at(span.from)}–${at(span.to)}  wrote on the page "${page.title}"${what}` });
    span = null;
  };

  let here = true;
  for (const e of events) {
    if (e.type === "page.created") pages.set(e.payload.page_id, newPage(e.payload.page_id, e.payload.title, e.payload.starter, e.ts, e.payload.probe));
    if (e.type === "page.ran") {
      const page = pages.get(e.payload.page_id);
      if (page) applyPageRun(page, e.payload, e.ts);
    }
    if (e.type === "page.edited") {
      const page = pages.get(e.payload.page_id);
      if (!page) continue;
      const started = (e.payload as { started_at?: unknown }).started_at;
      const from = typeof started === "number" && started <= e.ts ? started : e.ts;
      const counts = inRun(e.ts) && e.device_id !== "server:tutor";
      if (counts && span && (span.page !== page.id || from - span.to > 60_000)) closeSpan();
      if (counts && !span) span = { page: page.id, from: Math.max(from, run.started_at), to: e.ts, before: pageLines(page).map((l) => l.text) };
      try {
        applyPageEdit(page, e.payload.base_rev, e.payload.steps, e.ts);
      } catch (err) {
        if (!(err instanceof PageEditError)) throw err;
      }
      if (counts && span) span.to = e.ts;
    }
    if (!inRun(e.ts)) continue;
    // Leaving is reported once, and coming back only when nothing else shows it.
    for (const m of marksOf(e)) {
      if (!m.on && here) items.push({ t: e.ts, text: `${at(e.ts)}  left the app` });
      if (m.on && !here && e.type === "activity.signal") items.push({ t: e.ts, text: `${at(e.ts)}  back in the app` });
      here = m.on;
    }

    switch (e.type) {
      case "message.added": {
        const p = e.payload;
        if (p.author === "learner" && span) closeSpan();
        const where = p.anchor ? ` (aside on "${p.anchor.quote.slice(0, 40)}")` : "";
        items.push({ t: e.ts, text: `${at(e.ts)}  ${p.author}${where}: ${quote(p.text)}` });
        break;
      }
      case "page.ran": {
        const p = e.payload;
        const bad = p.blocks.findIndex((b) => b.failed);
        const why = bad >= 0 ? (p.blocks[bad]!.output.trim().split("\n").at(-1) ?? "") : "";
        const how = p.timed_out ? "stopped for taking too long" : bad >= 0 ? `failed at code block ${bad + 1}: ${why.slice(0, 160)}` : "ran cleanly";
        items.push({ t: e.ts, text: `${at(e.ts)}  ran the page: ${how}` });
        break;
      }
      case "run.paused":
        if (e.payload.run_id === run.id) items.push({ t: e.ts, text: `${at(e.ts)}  paused` });
        break;
      case "run.resumed":
        if (e.payload.run_id === run.id) items.push({ t: e.ts, text: `${at(e.ts)}  resumed` });
        break;
      case "unit.probed":
        if (!("corrects" in e.payload)) items.push({ t: e.ts, text: `${at(e.ts)}  probe recorded: ${e.payload.depth} of unit ${e.payload.unit_id}, ${e.payload.grade}` });
        break;
      case "unit.observed":
        items.push({ t: e.ts, text: `${at(e.ts)}  reflex ${e.payload.unit_id} ${e.payload.present ? "present" : "missing"}` });
        break;
    }
  }
  closeSpan();

  for (const [a, b] of quietStretches(run, events, now)) items.push({ t: a + 1, text: `${at(a)}–${at(b)}  nothing written, sent or run` });

  items.sort((x, y) => x.t - y.t);
  const used = clock(end);
  const length = clockText(run.duration_ms);
  const closing =
    run.end === "time" ? `${length}  time ran out` : run.end === "stopped" ? `${clockText(used)}  stopped; ${clockText(run.duration_ms - used)} of ${length} unused` : `${clockText(used)}  still running`;
  const head = `Timed run ${run.id}: ${length}, conditions: ${run.conditions || "none given"}. Times are on the run's clock (m:ss from the start).`;
  const body = [`0:00  run started`, ...items.map((i) => i.text), closing];
  const page = run.page_id ? pages.get(run.page_id) : undefined;
  const tail = page ? `\n\nThe page "${page.title}" at the end:\n${pageText(page).slice(0, 4000)}` : "";
  return `${head}\n${body.join("\n")}${tail}`;
}

/**
 * Stretches of the run, in wall time, with no mark of the learner for at least `min` on the run's
 * clock. Activity signals count as marks: being in the app with nothing on the page is still quiet
 * only if no focus or typing was seen.
 */
export function quietStretches(run: Run, events: readonly MyelinEvent[], now: number, min = QUIET_MS): [number, number][] {
  const end = run.ended_at ?? now;
  const clock = runClock(run, events);
  const marks: number[] = [];
  for (const e of events) for (const m of marksOf(e)) if (m.on && m.at >= run.started_at && m.at <= end) marks.push(m.at);
  const points = [run.started_at, ...marks.sort((a, b) => a - b), end];
  const out: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (clock(b) - clock(a) >= min) out.push([a, b]);
  }
  return out;
}

export interface TimelineSegment {
  name: string;
  ms: number;
  costly?: boolean;
  unused?: boolean;
}

/** The timeline card a debrief shows. */
export interface TimelineCard {
  kind: "timeline";
  run_id: string;
  duration_ms: number;
  segments: TimelineSegment[];
}

/** "4:05" or "245" (seconds) as milliseconds, or null. */
export function parseClock(s: string): number | null {
  const t = s.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const m = /^(?:(\d+):)?(\d{1,3}):(\d{2})$/.exec(t);
  if (!m) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000;
}

/**
 * Builds the timeline from the steps the tutor named, each ending at a time on the run's clock;
 * the last one ends where the run did. Unused time is added. `quiet` holds the long quiet stretches
 * as [from, to] on the run's clock; a step may not fold one into other work. Returns why it cannot,
 * as a string.
 */
export function timeline(
  run: Run,
  used: number,
  steps: readonly { name: string; until?: string | undefined }[],
  costly: number | undefined,
  quiet: readonly [number, number][] = [],
): TimelineCard | string {
  if (run.ended_at === null) return "The run has not ended yet. Show the timeline in the debrief.";
  if (steps.length === 0) return "Name at least one step.";
  if (steps.length > 12) return "At most 12 steps. Merge the small ones.";
  if (costly !== undefined && (!Number.isInteger(costly) || costly < 1 || costly > steps.length)) return `costly must be a step number from 1 to ${steps.length}.`;
  const segments: TimelineSegment[] = [];
  let prev = 0;
  for (const [i, s] of steps.entries()) {
    const name = s.name.trim();
    if (!name) return `Step ${i + 1} has no name.`;
    const last = i === steps.length - 1;
    let until = used;
    if (!last || s.until !== undefined) {
      if (s.until === undefined) return `Step ${i + 1} needs an end time ("until", as m:ss on the run's clock).`;
      const t = parseClock(s.until);
      if (t === null) return `Could not read "${s.until}". Use m:ss on the run's clock, such as 7:40.`;
      until = last ? used : t;
      if (!last && (t <= prev || t >= used)) return `Step ${i + 1} ends at ${s.until}, which is not between ${clockText(prev)} and ${clockText(used)}. Ends must increase.`;
    }
    segments.push({ name, ms: until - prev, ...(costly === i + 1 ? { costly: true } : {}) });
    prev = until;
  }
  let from = 0;
  for (const [i, g] of segments.entries()) {
    const to = from + g.ms;
    for (const [a, b] of quiet) {
      const overlap = Math.min(to, b) - Math.max(from, a);
      const rest = g.ms - overlap;
      if (overlap >= LONG_QUIET_MS && rest >= Math.max(60_000, overlap / 5))
        return `Step ${i + 1} ("${g.name}") folds in ${clockText(a)}–${clockText(b)}, when nothing was written, sent or run. Make that stretch a step of its own, named for what it was (such as "Nothing on the page" or "Away").`;
    }
    from = to;
  }
  if (run.duration_ms - used >= 1000) segments.push({ name: "Unused", ms: run.duration_ms - used, unused: true });
  return { kind: "timeline", run_id: run.id, duration_ms: run.duration_ms, segments };
}
