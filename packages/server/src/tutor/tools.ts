// The tutor's tools. The tool list is the safety boundary: Pi's file and shell tools are off, and
// every tool here only reads the record or appends events. No tool can edit a page: open_page
// creates one with its problem statement, and open_aside only posts a message anchored to it.
import {
  DAY_MS,
  clockText,
  currentRun,
  findPassage,
  isRebuildable,
  pageLines,
  nextProbe,
  resolveUnit,
  runElapsed,
  runLeft,
  uuidv7,
  type Depth,
  type EventOf,
  type EventType,
  type Grade,
  type MyelinEvent,
  type Payload,
  type Probe,
  type Run,
  type Scheduler,
  type SlotKind,
  type State,
  type Unit,
} from "@myelin/core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RunResult } from "../sandbox.js";
import { formatDate, openPage, type ThreadMessage } from "./context.js";
import { unitsTable, type UnitsCard } from "./cards.js";
import { LONG_QUIET_MS, quietStretches, runClock, runReport, timeline, type TimelineCard } from "./runs.js";

/** A card carried on the tutor's reply. The client draws a unit card or the grey trace line. */
export type Card = { kind: "unit"; unit_id: string; how: string; note: string | null } | { kind: "trace"; text: string } | { kind: "page"; page_id: string } | TimelineCard | UnitsCard;

/** What the tools know about the turn in progress. */
export interface TurnInfo {
  /** The id the tutor's reply will have. */
  replyId: string;
  /** The learner message this turn answers: the first one since the tutor last spoke. Null for a greeting. */
  answer: ThreadMessage | null;
  /** Cards to post with the reply. */
  cards: Card[];
}

/** A probe next_probe (or the greeting) offered, kept until it is recorded. */
export interface Offer {
  probe: Probe;
  at: number;
}

export interface ToolHost {
  readonly state: State;
  readonly scheduler: Scheduler;
  messages(): ThreadMessage[];
  append<T extends EventType>(type: T, payload: Payload<T> | Record<string, unknown>): EventOf<T>;
  now(): number;
  timeZone?: string | undefined;
  turn(): TurnInfo;
  readonly offers: Map<string, Offer>;
  /** Runs Python in the sandbox. Absent when code does not run on this server. */
  run?: ((code: string) => Promise<RunResult>) | undefined;
  /** The whole log, for a run's report. */
  events(): readonly MyelinEvent[];
  /** The learner's active time between two moments, with absences left out. */
  activeMs(from: number, to: number): number;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/** An offer older than this no longer says how the probe was asked. */
const OFFER_TTL_MS = 6 * 3_600_000;
const SLOT_SECONDS: Record<"in_context" | "greeting" | "seam", number> = { in_context: 30, greeting: 30, seam: 180 };

/** What the tutor does when a run ends, after its report. */
export const DEBRIEF =
  "Debrief now. Open with one short line, then a blank line: the card goes after your first paragraph. Call show_card with kind timeline: name the steps of the run in order, each with the time on the run's clock it ended (until, m:ss), " +
  "and mark as costly the one step that cost the most avoidable time, if one did. A quiet stretch of a few minutes or more, or time away, is a step of its own, " +
  "named for what it was, not folded into the work around it. The app adds any unused time. Then, in a few short lines after that first one: " +
  "the one move that would have saved the most time, which units cost the most (against their own earlier speed if get_profile shows it), " +
  "and any reflex that was missing (record each with observe_unit). Record use probes with record_probe for the units the run tested. End with one question.";

/** A run that ended this long ago still owns the probes recorded in its debrief. */
const DEBRIEF_MS = 30 * 60_000;

/** The run on now, as the tutor is told it each turn. */
export function runNote(r: Run, now: number): string {
  const left = clockText(runLeft(r, now));
  const state = r.paused_at !== null ? `paused with ${left} left` : `${left} left`;
  return (
    `[app: a timed run is on (run_id ${r.id}): ${state} of ${clockText(r.duration_ms)}. Conditions: ${r.conditions || "none given"}. ` +
    "Answer clarifying questions only, in a line, as an interviewer would: no hints, no probes, no asides, no comment on the work. " +
    "If they ask to pause, resume or stop, use pause_run, resume_run or end_run. Never mention the time left; the clock shows it.]"
  );
}

/** "2026-12-01" as the end of that day, server time. */
export function parseDue(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function words(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
const pct = (r: number) => `${Math.round(r * 100)}%`;

/** Messages and units that mention the most query words, newest first among equals. */
export function searchMemory(host: Pick<ToolHost, "state" | "messages" | "timeZone">, query: string, limit = 8): string {
  const terms = words(query);
  if (terms.length === 0) return "Give some words to search for.";
  const score = (text: string) => {
    const t = text.toLowerCase();
    return terms.filter((w) => t.includes(w)).length;
  };
  const hits: { score: number; at: number; line: string }[] = [];
  for (const m of host.messages()) {
    const s = score(m.text);
    if (s > 0) hits.push({ score: s, at: m.ts, line: `[${m.author === "learner" ? "Learner" : "You"}, ${formatDate(m.ts, host.timeZone)}] ${m.text.slice(0, 400)}` });
  }
  for (const u of Object.values(host.state.units)) {
    if (u.status !== "active") continue;
    const s = score(`${u.text} ${u.kind} ${u.topic ?? ""}`);
    if (s > 0) hits.push({ score: s + 0.5, at: u.found_at, line: `[unit ${u.id}, ${u.kind}] ${u.text}` });
  }
  for (const page of Object.values(host.state.pages)) {
    const t = score(page.title);
    if (t > 0) hits.push({ score: t + 0.5, at: page.edited_at, line: `[page "${page.title}", id ${page.id}, ${formatDate(page.created_at, host.timeZone)}]` });
    for (const l of pageLines(page)) {
      const s = score(l.text);
      if (s > 0) hits.push({ score: s, at: page.edited_at, line: `[page "${page.title}", id ${page.id}, line ${l.n}] ${l.text.slice(0, 400)}` });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.at - a.at);
  if (hits.length === 0) return "Nothing found.";
  return hits
    .slice(0, limit)
    .map((h) => h.line)
    .join("\n");
}

/** The unit's newest probe that is not a correction, for correcting it later. */
function lastProbe(state: State, u: Unit): { id: string; grade: string; at: number } | null {
  for (let i = u.evidence.length - 1; i >= 0; i--) {
    const ev = state.evidence[u.evidence[i]!];
    if (ev?.source === "probe") return { id: ev.event_id, grade: ev.grade ?? "?", at: ev.at };
  }
  return null;
}

export function profile(host: Pick<ToolHost, "state" | "scheduler" | "now" | "timeZone">, topic?: string): string {
  const s = host.state;
  const now = host.now();
  const units = Object.values(s.units).filter((u) => u.status === "active" && (!topic || u.topic === topic || u.text.toLowerCase().includes(topic.toLowerCase())));
  const lines = [`Units${topic ? ` for ${topic}` : ""}: ${units.length}`];
  for (const u of units.slice(0, 60)) {
    const rests = u.rests_on.map((id) => s.units[id]?.text ?? id);
    const bits = [u.kind, `id ${u.id}`, rests.length ? `rests on ${rests.join("; ")}` : "arbitrary"];
    if (u.told && !u.rebuilt_once && isRebuildable(u)) bits.push("told, not yet rebuilt");
    if (u.observe_only) bits.push(`observed only: present ${u.observations.present}, missing ${u.observations.missing}`);
    else if (u.memory_reviews > 0) bits.push(`predicted recall now ${pct(host.scheduler.recall(u.memory, now))}`);
    const last = lastProbe(s, u);
    bits.push(last ? `${u.evidence.length} evidence, last probe ${last.id} graded ${last.grade} on ${formatDate(last.at, host.timeZone)}` : `${u.evidence.length} evidence`);
    lines.push(`- ${u.text} (${bits.join("; ")})`);
  }
  const prefs = Object.entries(s.preferences);
  lines.push(`Preferences: ${prefs.length ? prefs.map(([k, p]) => `${k}=${JSON.stringify(p.value)}${p.lasting ? "" : " (this sitting)"}`).join(", ") : "none"}`);
  const goals = Object.values(s.goals);
  lines.push(`Goals: ${goals.length ? goals.map((g) => `${g.text}${g.due ? ` by ${formatDate(g.due, host.timeZone)}` : ""}${g.active ? "" : " (closed)"}`).join("; ") : "none"}`);
  return lines.join("\n");
}

/** How to put a probe of this depth, for the tutor. */
export function probeHint(u: Unit, depth: Depth, state: State): string {
  switch (depth) {
    case "recall":
      return "Ask for it in one short question that does not give it away.";
    case "rebuild": {
      const rests = u.rests_on.map((id) => state.units[id]?.text ?? id).join("; ");
      return `Ask them to rebuild it from what it rests on (${rests}) in about 30 seconds. Do not state it.`;
    }
    case "use":
      return "Pose one small fresh problem that needs it without naming it.";
    case "explain":
      return `An explanation needs a page: call open_page with unit_id ${u.id} and depth explain, and a starter that says what to explain and to whom (a newcomer who knows what it rests on, not the idea itself), never the explanation. While they write you play that newcomer.`;
  }
}

export function describeProbe(p: Probe, state: State): string {
  const u = state.units[p.unit_id]!;
  return (
    `Probe unit ${u.id} at depth ${p.depth}: "${u.text}" (${u.kind}). Predicted recall ${pct(p.predicted_recall)}. ` +
    `${probeHint(u, p.depth, state)}${p.depth === "explain" ? " Offer it in one line first." : " Ask it as one ordinary question."} When they answer, grade it with record_probe ` +
    `(unit_id ${u.id}, depth ${p.depth}). If they say "not now", drop it without comment.`
  );
}

/** Registers what was offered so record_probe can record the slot and the recall predicted when it was asked. */
export function offerProbe(host: Pick<ToolHost, "state" | "scheduler" | "offers">, slot: { kind: SlotKind; seconds: number; context: string[] }, now: number): Probe | null {
  const probe = nextProbe(host.state, slot, now, { scheduler: host.scheduler });
  if (probe) host.offers.set(probe.unit_id, { probe, at: now });
  return probe;
}

const VERB: Record<Depth, string> = { recall: "recalled", rebuild: "rebuilt", use: "used", explain: "explained" };
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  return `${m} minutes`;
}

export function backIn(ms: number): string {
  const days = Math.round(ms / DAY_MS);
  if (days <= 0) return "Back later today.";
  if (days === 1) return "Back tomorrow.";
  return `Back in about ${days} days.`;
}

/** The one grey line under the reply that closed a review. */
export function traceText(depth: Depth, grade: Grade, latencyMs: number | null, nextInMs: number | null): string {
  if (grade === "again") return `Not ${VERB[depth]} this time.`;
  if (latencyMs !== null) return `${cap(VERB[depth])} in ${duration(latencyMs)}.`;
  return nextInMs !== null ? `${cap(VERB[depth])}. ${backIn(nextInMs)}` : `${cap(VERB[depth])}.`;
}

/** When this depth is next due for the unit, from its memory or its ladder. */
function nextDue(u: Unit, depth: Depth): number | null {
  if (depth === "use" || depth === "explain") return u.ladders[depth]?.due ?? null;
  const due = u.memory.due;
  return typeof due === "number" ? due : null;
}

function activeUnit(state: State, id: string): Unit | string {
  const u = resolveUnit(state, id);
  if (!u) return `No unit with id ${id}.`;
  if (u.status === "split") return `Unit ${id} was split into ${u.successors.join(", ")}. Use one of those.`;
  return u;
}

/** Ids that resolve to live units, or the first one that does not. */
function resolveIds(state: State, ids: string[]): string[] | string {
  const out: string[] = [];
  for (const id of ids) {
    const u = activeUnit(state, id);
    if (typeof u === "string") return u;
    if (!out.includes(u.id)) out.push(u.id);
  }
  return out;
}

function duplicateOf(state: State, text: string): Unit | undefined {
  const t = norm(text);
  return Object.values(state.units).find((u) => (u.status === "active" || u.status === "retired") && norm(u.text) === t);
}

/** The card's sub-line: where the unit came from, then what it rests on. */
export function unitNote(state: State, u: { rests_on: string[]; told: boolean }, note: string | undefined): string {
  let rests: string;
  if (u.rests_on.length === 0) rests = "It rests on nothing, so it is one to memorize.";
  else if (u.told) rests = "It can be rebuilt, so I will not test it until you have rebuilt it once.";
  else rests = `It rests on ${u.rests_on.map((id) => state.units[id]?.text ?? id).join("; ")}.`;
  const lead = note?.trim();
  return lead ? `${/[.!?]$/.test(lead) ? lead : `${lead}.`} ${rests}` : rests;
}

/** A plain string enum ({type, enum}), which Gemini accepts where anyOf/const is refused. */
const StringEnum = <const T extends readonly string[]>(values: T, opts: { description: string }) =>
  Type.Unsafe<T[number]>({ type: "string", enum: [...values], description: opts.description });

const ORIGINS = ["hint", "derived", "error", "need", "told", "observed"] as const;
const GRADES = ["again", "hard", "good", "easy"] as const;
const DEPTHS = ["recall", "rebuild", "explain", "use"] as const;

export function tutorTools(host: ToolHost): ToolDefinition[] {
  const setGoal = defineTool({
    name: "set_goal",
    label: "Set goal",
    description: "Records a goal the learner stated, with its date if they gave one. To change or close an existing goal, pass its goal_id.",
    parameters: Type.Object({
      text: Type.String({ description: "The goal as one sentence in the learner's words" }),
      due: Type.Optional(Type.String({ description: "The date as YYYY-MM-DD, only if the learner gave one" })),
      topic: Type.Optional(Type.String({ description: "A short lowercase topic label, such as 'linear algebra'" })),
      goal_id: Type.Optional(Type.String({ description: "The id of an existing goal to change" })),
      closed: Type.Optional(Type.Boolean({ description: "True when the goal is met or dropped" })),
    }),
    async execute(_id, p) {
      const existing = p.goal_id ? host.state.goals[p.goal_id] : undefined;
      if (p.goal_id && !existing) return ok(`No goal with id ${p.goal_id}.`);
      const due = p.due !== undefined ? parseDue(p.due) : (existing?.due ?? null);
      if (p.due && due === null) return ok(`Could not read the date ${p.due}. Use YYYY-MM-DD.`);
      const goal_id = existing?.id ?? uuidv7(host.now());
      host.append("goal.set", { goal_id, text: p.text, due, topic: p.topic ?? existing?.topic ?? null, unit_ids: existing?.unit_ids ?? [], active: !p.closed });
      return ok(`Goal recorded (goal_id ${goal_id}${due ? `, due ${formatDate(due, host.timeZone)}` : ""}).`);
    },
  });

  const setBudget = defineTool({
    name: "set_budget",
    label: "Set budget",
    description: "Records how much time the learner has for this sitting, when they say so.",
    parameters: Type.Object({
      minutes: Type.Number({ description: "Minutes available" }),
      note: Type.Optional(Type.String({ description: "Anything they said about it" })),
    }),
    async execute(_id, p) {
      const seconds = Math.round(p.minutes * 60);
      if (!(seconds > 0)) return ok("The budget must be more than zero minutes.");
      host.append("budget.set", { seconds, note: p.note ?? null });
      return ok(`Budget recorded: ${Math.round(seconds / 60)} minutes.`);
    },
  });

  const setPreference = defineTool({
    name: "set_preference",
    label: "Set preference",
    description: "Records how the learner wants to work. Call it only when they say it should last beyond this sitting.",
    parameters: Type.Object({
      key: Type.String({ description: "A short lowercase name, such as 'language' or 'probe frequency while deriving'" }),
      value: Type.String({ description: "What they want, in a few words" }),
    }),
    async execute(_id, p) {
      host.append("preference.set", { key: p.key.trim().toLowerCase(), value: p.value, lasting: true });
      return ok(`Preference recorded: ${p.key} = ${p.value}.`);
    },
  });

  const search = defineTool({
    name: "search_memory",
    label: "Search memory",
    description: "Searches past messages and units for words. Use it for anything older than the thread tail you were given.",
    parameters: Type.Object({ query: Type.String({ description: "Words to look for" }) }),
    async execute(_id, p) {
      return ok(searchMemory(host, p.query));
    },
  });

  const getProfile = defineTool({
    name: "get_profile",
    label: "Get profile",
    description: "Returns the learner's units with their ids, what each rests on, predicted recall and the last probe, plus preferences and goals. Pass a topic to narrow it.",
    parameters: Type.Object({ topic: Type.Optional(Type.String({ description: "A topic label or word" })) }),
    async execute(_id, p) {
      return ok(profile(host, p.topic));
    },
  });

  const findUnit = defineTool({
    name: "find_unit",
    label: "Find unit",
    description:
      "Records a new unit of understanding: the smallest piece of knowledge that changes what the learner can do. " +
      "The app shows it as a card under your reply, so do not restate it in your text. One sentence the learner could say aloud.",
    parameters: Type.Object({
      text: Type.String({ description: "The unit as one sentence, in the learner's words where possible" }),
      kind: Type.String({ description: "A free short label, such as move, result, definition, word, distinction, reflex" }),
      origin: StringEnum(ORIGINS, {
        description: "hint: a hint unblocked them. derived: they derived or explained it. error: a miss revealed it. need: the work needed it and they lacked it. told: they were told it. observed: a habit seen in their work",
      }),
      rests_on: Type.Optional(Type.Array(Type.String(), { description: "Ids of units it can be rebuilt from. Leave empty if it is arbitrary" })),
      topic: Type.Optional(Type.String({ description: "A short lowercase topic label. Defaults to the active goal's topic" })),
      told: Type.Optional(Type.Boolean({ description: "True when they were told it rather than producing it" })),
      observe_only: Type.Optional(Type.Boolean({ description: "True for a reflex: evidence only from watching their work, never asked" })),
      note: Type.Optional(Type.String({ description: "Where it came from, in a few words for the card, such as 'The nudge that unblocked you'" })),
    }),
    async execute(_id, p) {
      const s = host.state;
      const text = p.text.trim();
      if (!text) return ok("A unit needs text.");
      const dup = duplicateOf(s, text);
      if (dup) return ok(`That is already unit ${dup.id} (${dup.kind}): ${dup.text}. Use revise_unit to change it.`);
      const rests = resolveIds(s, p.rests_on ?? []);
      if (typeof rests === "string") return ok(rests);
      const goals = Object.values(s.goals).filter((g) => g.active && g.topic);
      const topic = p.topic?.trim().toLowerCase() || (goals.length === 1 ? goals[0]!.topic : null);
      const told = p.told ?? p.origin === "told";
      const observe_only = p.observe_only ?? false;
      const unit_id = uuidv7(host.now());
      const turn = host.turn();
      host.append("unit.found", { unit_id, text, kind: p.kind.trim() || "unit", topic, rests_on: rests, origin: p.origin, told, observe_only, message_id: turn.replyId });
      // A reflex is raised in a debrief, not announced mid-work.
      if (!observe_only) {
        const how = told && rests.length > 0 ? "Noted" : p.origin === "error" ? "Found by this miss" : "Found";
        turn.cards.push({ kind: "unit", unit_id, how, note: unitNote(s, { rests_on: rests, told }, p.note) });
      }
      const gate = told && rests.length > 0 ? " It is told and rebuildable, so it is probed only by rebuilding until rebuilt once." : "";
      return ok(`Unit recorded (unit_id ${unit_id}).${observe_only ? " It is observe-only and gets no card." : " The card is shown under your reply."}${gate}`);
    },
  });

  const reviseUnit = defineTool({
    name: "revise_unit",
    label: "Revise unit",
    description:
      "Changes a unit: reword it (text and/or kind), link it (replace what it rests on), split it into parts that fail differently, merge others into it, or retire it. " +
      "Use it when the learner asks, or when the evidence shows the unit was the wrong size.",
    parameters: Type.Object({
      unit_id: Type.String({ description: "The unit to change" }),
      action: StringEnum(["reword", "link", "split", "merge", "retire"] as const, { description: "What to do" }),
      text: Type.Optional(Type.String({ description: "reword: the new sentence. merge: the merged unit's sentence, if it changes" })),
      kind: Type.Optional(Type.String({ description: "reword: a new kind label" })),
      rests_on: Type.Optional(Type.Array(Type.String(), { description: "link: the ids it rests on now (replaces the old list)" })),
      parts: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String({ description: "One part as a sentence" }),
            kind: Type.String({ description: "Its kind" }),
            rests_on: Type.Optional(Type.Array(Type.String(), { description: "Ids it rests on" })),
          }),
          { description: "split: two or more parts" },
        ),
      ),
      merge_ids: Type.Optional(Type.Array(Type.String(), { description: "merge: ids of units folded into this one" })),
      reason: Type.Optional(Type.String({ description: "retire: why" })),
    }),
    async execute(_id, p) {
      const s = host.state;
      const u = activeUnit(s, p.unit_id);
      if (typeof u === "string") return ok(u);
      switch (p.action) {
        case "reword": {
          const text = p.text?.trim() || undefined;
          const kind = p.kind?.trim() || undefined;
          if (!text && !kind) return ok("Give text or kind to reword.");
          host.append("unit.reworded", { unit_id: u.id, ...(text ? { text } : {}), ...(kind ? { kind } : {}), by: "tutor" });
          return ok(`Unit ${u.id} reworded.`);
        }
        case "link": {
          const rests = resolveIds(s, p.rests_on ?? []);
          if (typeof rests === "string") return ok(rests);
          if (rests.includes(u.id)) return ok("A unit cannot rest on itself.");
          host.append("unit.linked", { unit_id: u.id, rests_on: rests });
          return ok(rests.length ? `Unit ${u.id} now rests on ${rests.join(", ")}.` : `Unit ${u.id} is now arbitrary.`);
        }
        case "split": {
          const parts = p.parts ?? [];
          if (parts.length < 2) return ok("A split needs at least two parts.");
          const into = [];
          for (const part of parts) {
            const rests = resolveIds(s, part.rests_on ?? []);
            if (typeof rests === "string") return ok(rests);
            into.push({ unit_id: uuidv7(host.now()), text: part.text.trim(), kind: part.kind.trim() || u.kind, topic: u.topic, rests_on: rests });
          }
          host.append("unit.split", { unit_id: u.id, into });
          return ok(`Unit ${u.id} split into ${into.map((x) => `${x.unit_id} (${x.text})`).join("; ")}.`);
        }
        case "merge": {
          const ids = resolveIds(s, p.merge_ids ?? []);
          if (typeof ids === "string") return ok(ids);
          const merged = ids.filter((id) => id !== u.id);
          if (merged.length === 0) return ok("Name at least one other unit to merge in.");
          host.append("unit.merged", { unit_id: u.id, merged, text: p.text?.trim() || null });
          return ok(`Merged ${merged.join(", ")} into ${u.id}.`);
        }
        case "retire": {
          if (u.status === "retired") return ok(`Unit ${u.id} is already retired.`);
          host.append("unit.retired", { unit_id: u.id, reason: p.reason ?? null });
          return ok(`Unit ${u.id} retired. It comes back only if recall drops well below target.`);
        }
      }
      return ok(`Unknown action ${String(p.action)}.`);
    },
  });

  const nextProbeTool = defineTool({
    name: "next_probe",
    label: "Next probe",
    description:
      "Asks the scheduler for the best probe for a slot. in_context: the current work needs older units (pass their ids as context). " +
      "seam: a natural break, such as a derivation ending or the learner saying 'next'. May return nothing; then ask nothing.",
    parameters: Type.Object({
      slot: StringEnum(["in_context", "seam"] as const, { description: "Which slot is open" }),
      context: Type.Optional(Type.Array(Type.String(), { description: "Ids of units the current work touches" })),
      seconds: Type.Optional(Type.Number({ description: "How long the slot can take. Defaults: in_context 30, seam 180" })),
    }),
    async execute(_id, p) {
      const now = host.now();
      if (currentRun(host.state.runs)) return ok("A timed run is on. Ask nothing until it ends.");
      const context = (p.context ?? []).filter((id) => resolveUnit(host.state, id));
      const probe = offerProbe(host, { kind: p.slot, seconds: p.seconds ?? SLOT_SECONDS[p.slot], context }, now);
      if (!probe) return ok("No probe is worth asking now. Ask nothing.");
      return ok(describeProbe(probe, host.state));
    },
  });

  const recordProbe = defineTool({
    name: "record_probe",
    label: "Record probe",
    description:
      "Records how a probe went, after the learner answered. Infer the grade from correctness, hints and speed: again (missed), hard (got it with effort or a hint), good, easy (instant). " +
      "The app measures the time and shows one grey line under your reply. To correct an earlier probe later ('that was lucky'), pass corrects with that probe's id.",
    parameters: Type.Object({
      unit_id: Type.String({ description: "The unit probed" }),
      depth: StringEnum(DEPTHS, { description: "What was tested" }),
      grade: StringEnum(GRADES, { description: "The grade you infer, or for a correction the grade that should count" }),
      prompt: Type.Optional(Type.String({ description: "The question as you asked it. Defaults to your last message" })),
      hints: Type.Optional(Type.Number({ description: "Hints given before the answer" })),
      corrected_grade: Type.Optional(StringEnum(GRADES, { description: "The grade the learner claimed in the same answer, if they corrected you" })),
      corrects: Type.Optional(Type.String({ description: "The id of an earlier probe this corrects" })),
      note: Type.Optional(Type.String({ description: "For a correction: what the learner said" })),
      away: Type.Optional(Type.Boolean({ description: "True if the learner said they were away while answering, so the time does not count" })),
    }),
    async execute(_id, p) {
      const s = host.state;
      const u = activeUnit(s, p.unit_id);
      if (typeof u === "string") return ok(u);

      if (p.corrects) {
        const ev = s.evidence[p.corrects];
        if (!ev || ev.source !== "probe" || resolveUnit(s, ev.unit_id)?.id !== u.id) return ok(`No probe ${p.corrects} on unit ${u.id}. get_profile lists each unit's last probe.`);
        host.append("unit.probed", { unit_id: ev.unit_id, corrects: p.corrects, grade: p.grade, note: p.note ?? null });
        return ok(`Correction recorded: probe ${p.corrects} now counts as ${p.grade}.`);
      }

      const now = host.now();
      const turn = host.turn();
      const answer = turn.answer;
      const offered = host.offers.get(u.id);
      const offer = offered && now - offered.at < OFFER_TTL_MS && offered.probe.depth === p.depth ? offered : undefined;
      // A probe done on a page was answered there, not by the message that says it is finished. Its
      // time is the page's, which the time accounting measures; the message's latency would mislead.
      const open = openPage(s, host.messages(), now);
      const onPage = open?.probe && resolveUnit(s, open.probe.unit_id)?.id === u.id && open.probe.depth === p.depth ? open : null;
      const t = onPage ? null : answer?.timing;
      // Time is active time, so a break in the middle does not count. A page probe is timed by the
      // work on the page, from its opening to its last edit.
      let latency: number | null = null;
      if (onPage && onPage.rev > 0) latency = host.activeMs(onPage.created_at, onPage.edited_at);
      else if (t && t.sent_at !== null && t.shown_at !== null && t.sent_at >= t.shown_at) latency = host.activeMs(t.shown_at, t.sent_at);
      if (p.away) latency = null;
      const run = Object.values(s.runs).findLast((r) => r.ended_at === null || now - r.ended_at < DEBRIEF_MS);
      const asked = answer ? host.messages().findLast((m) => m.author === "tutor" && m.seq < answer.seq) : undefined;
      const pagePrompt = onPage ? `On page "${onPage.title}"${onPage.starter ? `: ${onPage.starter}` : ""}` : "";
      const prompt = p.prompt?.trim() || pagePrompt.slice(0, 1000) || asked?.text.slice(0, 1000) || "";
      const e = host.append("unit.probed", {
        unit_id: u.id,
        depth: p.depth,
        slot: offer?.probe.slot ?? (run ? "timed_run" : "in_context"),
        prompt,
        answer_message_id: answer?.id ?? null,
        grade: p.grade,
        corrected_grade: p.corrected_grade ?? null,
        hints: Math.max(0, Math.round(p.hints ?? 0)),
        latency_ms: latency,
        scheduler: host.scheduler.name,
        predicted_recall: offer?.probe.predicted_recall ?? host.scheduler.recall(u.memory, t?.shown_at ?? now),
      });
      host.offers.delete(u.id);

      const after = host.state.units[u.id] ?? u;
      const due = nextDue(after, p.depth);
      const nextIn = due !== null ? due - now : null;
      const counted = p.corrected_grade ?? p.grade;
      const line = traceText(p.depth, counted, latency, nextIn);
      if (!turn.cards.some((c) => c.kind === "trace")) turn.cards.push({ kind: "trace", text: line });
      const next = nextIn !== null ? ` Next probe ${backIn(nextIn).replace(/^Back /, "").replace(/\.$/, "")}.` : "";
      // The trace states the recall time when it is known; the tutor states the consequence. Without a
      // time the trace carries the consequence itself, so the tutor need not say it.
      const say = latency !== null ? " Say the consequence in one short line; leave the seconds to the app." : " Do not repeat it.";
      return ok(`Probe recorded (probe id ${e.id}, ${counted}).${next} The app shows "${line}" under your reply.${say}`);
    },
  });

  const observeUnit = defineTool({
    name: "observe_unit",
    label: "Observe unit",
    description: "Records whether a move appeared unprompted in the learner's work, for reflexes and other observed units. Raise it in a debrief, not mid-work.",
    parameters: Type.Object({
      unit_id: Type.String({ description: "The unit observed" }),
      present: Type.Boolean({ description: "True if the move appeared unprompted, false if it was missing where it was needed" }),
      note: Type.Optional(Type.String({ description: "What you saw, briefly" })),
    }),
    async execute(_id, p) {
      const u = activeUnit(host.state, p.unit_id);
      if (typeof u === "string") return ok(u);
      host.append("unit.observed", { unit_id: u.id, present: p.present, note: p.note ?? null, page_id: null, message_id: host.turn().answer?.id ?? null, elapsed_ms: null });
      return ok(`Observation recorded on ${u.id}: ${p.present ? "present" : "missing"}.`);
    },
  });

  const openPageTool = defineTool({
    name: "open_page",
    label: "Open page",
    description:
      "Opens a page beside the thread for work that needs room: a derivation, a proof, code, an explanation. The learner writes on it; you never can. " +
      "The starter is the problem statement shown at the top, never a solution or a hint. The app puts a link to the page under your reply. " +
      "For a probe done on the page, such as an explanation for a newcomer, pass the unit and depth.",
    parameters: Type.Object({
      title: Type.String({ description: "A short title, such as 'Bayes with a rare disease'" }),
      starter: Type.Optional(Type.String({ description: "The problem statement, if there is one. Never part of a solution" })),
      unit_id: Type.Optional(Type.String({ description: "The unit this page probes, if it is for a probe" })),
      depth: Type.Optional(StringEnum(DEPTHS, { description: "The depth the page probes. explain for an explanation" })),
    }),
    async execute(_id, p) {
      const title = p.title.trim();
      if (!title) return ok("A page needs a title.");
      let probe: { unit_id: string; depth: Depth } | null = null;
      if (p.unit_id || p.depth) {
        if (!p.unit_id || !p.depth) return ok("A probe page needs both unit_id and depth.");
        const u = activeUnit(host.state, p.unit_id);
        if (typeof u === "string") return ok(u);
        probe = { unit_id: u.id, depth: p.depth };
      }
      const page_id = uuidv7(host.now());
      host.append("page.created", { page_id, title, starter: p.starter?.trim() || null, probe });
      host.turn().cards.push({ kind: "page", page_id });
      const after = probe?.depth === "explain" ? " While they write you are the newcomer: ask only naive questions, as asides." : "";
      return ok(`Page opened (page_id ${page_id}). The link is shown under your reply. Tell them what to do on it in one line, then stay quiet while they work.${after}`);
    },
  });

  const openAside = defineTool({
    name: "open_aside",
    label: "Open aside",
    description:
      "Posts a message anchored to a passage on a page, shown beside that passage. Use it at a real flaw in the reasoning: a question at the line, never the fix. " +
      "Quote the passage exactly as it is written on the page, a few words to one line.",
    parameters: Type.Object({
      passage: Type.String({ description: "The words on the page the aside is about, copied exactly" }),
      text: Type.String({ description: "The aside: one question, at most 100 words, without the fix" }),
      line: Type.Optional(Type.Number({ description: "The line number the passage is on, from the page text" })),
      page_id: Type.Optional(Type.String({ description: "The page. Defaults to the open page" })),
    }),
    async execute(_id, p) {
      const s = host.state;
      if (currentRun(s.runs)) return ok("A timed run is on: no asides until it ends. Keep what you saw for the debrief.");
      const page = p.page_id ? s.pages[p.page_id] : openPage(s, host.messages(), host.now());
      if (!page) return ok(p.page_id ? `No page with id ${p.page_id}.` : "No page is open. Pass page_id.");
      const text = p.text.trim();
      if (!text) return ok("An aside needs text.");
      const n = text.split(/\s+/).length;
      if (n > 100) return ok(`That is ${n} words. Keep an aside to 100 words or fewer: one question.`);
      const found = findPassage(page, p.passage, p.line);
      if (!found) return ok(`Could not find "${p.passage}" on page ${page.id}. Quote a few words exactly as they are written.`);
      host.append("message.added", {
        author: "tutor",
        text,
        cards: [],
        anchor: { page_id: page.id, rev: page.rev, from: found.from, to: found.to, quote: found.quote },
        timing: null,
      });
      return ok(`Aside posted at "${found.quote}". It is shown beside the passage, so do not repeat it in your reply. Write nothing else unless they asked something else in the thread.`);
    },
  });

  const runCode = defineTool({
    name: "run_code",
    label: "Run code",
    description:
      "Runs Python in a fresh sandbox and returns what it printed and the value of its last line. The learner does not see it. " +
      "Use it to check a numeric or algebraic result before you state it, or to see what the learner's code does. numpy, sympy and PyTorch may be installed. " +
      "If the learner should see the code or its output, put them in your reply as fenced blocks.",
    parameters: Type.Object({ code: Type.String({ description: "The Python to run" }) }),
    async execute(_id, p) {
      if (!host.run) return ok("Code does not run on this server.");
      const r = await host.run(p.code);
      const b = r.blocks[0];
      if (!b) return ok("Nothing ran.");
      const output = b.output.trimEnd() || "(nothing printed)";
      return ok(`${b.failed ? (r.timed_out ? "Stopped" : "Failed") : "Ran"} in ${duration(r.duration_ms)}. Output:\n${output}`);
    },
  });

  const startRun = defineTool({
    name: "start_run",
    label: "Start run",
    description:
      "Starts a timed run, only when the learner asks for one or accepts your offer. The app shows a clock counting down and ends the run when it reaches zero, then asks you to debrief. " +
      "Set the problem in your reply right after; for work that needs room, open a page with open_page first and pass its page_id. During the run, answer clarifying questions only.",
    parameters: Type.Object({
      minutes: Type.Number({ description: "The run's length in minutes" }),
      conditions: Type.String({ description: "The conditions in a few words, such as 'interview: clarifying questions only' or 'exam, closed book'" }),
      page_id: Type.Optional(Type.String({ description: "The page the work is on, if any" })),
    }),
    async execute(_id, p) {
      const s = host.state;
      const now = host.now();
      const on = currentRun(s.runs);
      if (on) return ok(`A run is already on (run_id ${on.id}, ${clockText(runLeft(on, now))} left). End it with end_run first.`);
      const duration_ms = Math.round(p.minutes * 60_000);
      if (!(duration_ms >= 1000) || duration_ms > 4 * 3_600_000) return ok("A run lasts from a few seconds to four hours. Pass minutes.");
      if (p.page_id && !s.pages[p.page_id]) return ok(`No page with id ${p.page_id}.`);
      const run_id = uuidv7(now);
      host.append("run.started", { run_id, duration_ms, conditions: p.conditions.trim(), page_id: p.page_id ?? null });
      const probe = p.page_id ? null : offerProbe(host, { kind: "timed_run", seconds: duration_ms / 1000, context: [] }, now);
      const hint = probe ? ` If it fits what they asked for, a use probe worth setting: ${describeProbe(probe, s)}` : "";
      return ok(
        `Run started (run_id ${run_id}): ${clockText(duration_ms)} on the clock, which the learner now sees. Set the problem now in one message and say nothing else; do not mention the clock.${hint}`,
      );
    },
  });

  const pauseRun = defineTool({
    name: "pause_run",
    label: "Pause run",
    description: "Stops the run's clock when the learner asks to pause.",
    parameters: Type.Object({}),
    async execute() {
      const r = currentRun(host.state.runs);
      if (!r) return ok("No run is on.");
      if (r.paused_at !== null) return ok("The run is already paused.");
      host.append("run.paused", { run_id: r.id });
      return ok(`Paused with ${clockText(runLeft(r, host.now()))} left. Say so in a few words; the clock resumes when they say so.`);
    },
  });

  const resumeRun = defineTool({
    name: "resume_run",
    label: "Resume run",
    description: "Restarts a paused run's clock when the learner says to go on.",
    parameters: Type.Object({}),
    async execute() {
      const r = currentRun(host.state.runs);
      if (!r) return ok("No run is on.");
      if (r.paused_at === null) return ok("The run is not paused.");
      host.append("run.resumed", { run_id: r.id });
      return ok(`Resumed with ${clockText(runLeft(r, host.now()))} left. Say nothing else, or one word.`);
    },
  });

  const endRun = defineTool({
    name: "end_run",
    label: "End run",
    description: "Ends the run early, when the learner says stop or that they are done. Returns what happened in the run, for the debrief.",
    parameters: Type.Object({}),
    async execute() {
      const r = currentRun(host.state.runs);
      if (!r) return ok("No run is on. When the clock runs out, the app ends the run itself.");
      host.append("run.ended", { run_id: r.id, reason: "stopped" });
      const ended = host.state.runs[r.id]!;
      return ok(`Run ended.\n\n${runReport(ended, host.events(), host.now())}\n\n${DEBRIEF}`);
    },
  });

  const showCard = defineTool({
    name: "show_card",
    label: "Show card",
    description:
      "Posts a card in your reply, after its first paragraph: write one sentence, a blank line, then the rest, so the card has a sentence above and below it. " +
      "kind units: a table of units with what each rests on and the depths shown, not yet shown or missed, only when the learner asks where they stand; " +
      "pass the unit_ids that answer the question (from get_profile), or a topic. At most 20 rows. " +
      "kind timeline: the debrief of the last timed run, as named steps in order, each ending at a time on the run's clock. " +
      "The bar shows each step's share; durations are worked out by the app, which adds unused time.",
    parameters: Type.Object({
      kind: StringEnum(["units", "timeline"] as const, { description: "The card" }),
      unit_ids: Type.Optional(Type.Array(Type.String(), { description: "units: the units to show, in the order to show them" })),
      topic: Type.Optional(Type.String({ description: "units: a topic label or word, instead of unit_ids" })),
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String({ description: "What the step was, in a few words, such as 'Sign of the update, three variants tried'" }),
            until: Type.Optional(Type.String({ description: "When the step ended on the run's clock, m:ss. The last step may leave it out" })),
          }),
          { description: "timeline: the steps of the run in order" },
        ),
      ),
      costly: Type.Optional(Type.Number({ description: "timeline: the number (from 1) of the one step that cost the most avoidable time, if one did" })),
      run_id: Type.Optional(Type.String({ description: "timeline: the run. Defaults to the last one" })),
    }),
    async execute(_id, p) {
      const s = host.state;
      const turn = host.turn();
      const place = (card: Card) => {
        const i = turn.cards.findIndex((c) => c.kind === card.kind);
        if (i >= 0) turn.cards.splice(i, 1, card);
        else turn.cards.push(card);
      };
      if (p.kind === "units") {
        const card = unitsTable(s, { unit_ids: p.unit_ids, topic: p.topic }, host.now(), host.timeZone);
        if (typeof card === "string") return ok(card);
        place(card);
        return ok(`Units table shown after your first paragraph, ${card.rows.length} row${card.rows.length === 1 ? "" : "s"}. Do not list the units again; say in one sentence what the table means for them.`);
      }
      const r = p.run_id ? s.runs[p.run_id] : Object.values(s.runs).findLast(() => true);
      if (!r) return ok(p.run_id ? `No run with id ${p.run_id}.` : "There has been no timed run.");
      const events = host.events();
      const clock = runClock(r, events);
      const quiet = quietStretches(r, events, host.now(), LONG_QUIET_MS).map(([a, b]): [number, number] => [clock(a), clock(b)]);
      const card = timeline(r, runElapsed(r, host.now()), p.steps ?? [], p.costly, quiet);
      if (typeof card === "string") return ok(card);
      place(card);
      const rows = card.segments.map((g) => `${g.name} ${clockText(g.ms)}${g.costly ? " (costly)" : ""}`).join("; ");
      return ok(`Timeline shown after your first paragraph: ${rows}. Do not repeat the times; say what they mean.`);
    },
  });

  const stayQuiet = defineTool({
    name: "stay_quiet",
    label: "Stay quiet",
    description: "The explicit answer to an observation that needs no comment. Say nothing else after calling it.",
    parameters: Type.Object({ reason: Type.String({ description: "Why nothing needs saying, for the log" }) }),
    async execute() {
      return ok("Staying quiet.");
    },
  });

  return [
    setGoal,
    setBudget,
    setPreference,
    search,
    getProfile,
    findUnit,
    reviseUnit,
    nextProbeTool,
    recordProbe,
    observeUnit,
    openPageTool,
    openAside,
    runCode,
    startRun,
    pauseRun,
    resumeRun,
    endRun,
    showCard,
    stayQuiet,
  ] as unknown as ToolDefinition[];
}
