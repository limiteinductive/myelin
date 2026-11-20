// The tutor's tools. The tool list is the safety boundary: Pi's file and shell tools are off, and
// every tool here only reads the record or appends events. No tool can edit a page.
import { uuidv7, type EventOf, type EventType, type Payload, type State } from "@myelin/core";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatDate, type ThreadMessage } from "./context.js";

export interface ToolHost {
  readonly state: State;
  messages(): ThreadMessage[];
  append<T extends EventType>(type: T, payload: Payload<T> | Record<string, unknown>): EventOf<T>;
  now(): number;
  timeZone?: string | undefined;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

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

/** Messages and units that mention the most query words, newest first among equals. */
export function searchMemory(host: ToolHost, query: string, limit = 8): string {
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
  hits.sort((a, b) => b.score - a.score || b.at - a.at);
  if (hits.length === 0) return "Nothing found.";
  return hits
    .slice(0, limit)
    .map((h) => h.line)
    .join("\n");
}

export function profile(host: ToolHost, topic?: string): string {
  const s = host.state;
  const units = Object.values(s.units).filter((u) => u.status === "active" && (!topic || u.topic === topic || u.text.toLowerCase().includes(topic.toLowerCase())));
  const lines = [`Units${topic ? ` for ${topic}` : ""}: ${units.length}`];
  for (const u of units.slice(0, 60)) {
    const rests = u.rests_on.map((id) => s.units[id]?.text ?? id);
    lines.push(`- ${u.text} (${u.kind}; ${rests.length ? `rests on ${rests.join("; ")}` : "arbitrary"}; ${u.evidence.length} evidence)`);
  }
  const prefs = Object.entries(s.preferences);
  lines.push(`Preferences: ${prefs.length ? prefs.map(([k, p]) => `${k}=${JSON.stringify(p.value)}${p.lasting ? "" : " (this sitting)"}`).join(", ") : "none"}`);
  const goals = Object.values(s.goals);
  lines.push(`Goals: ${goals.length ? goals.map((g) => `${g.text}${g.due ? ` by ${formatDate(g.due, host.timeZone)}` : ""}${g.active ? "" : " (closed)"}`).join("; ") : "none"}`);
  return lines.join("\n");
}

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
    description: "Returns the learner's units with what each rests on and its evidence, their preferences and goals. Pass a topic to narrow it.",
    parameters: Type.Object({ topic: Type.Optional(Type.String({ description: "A topic label or word" })) }),
    async execute(_id, p) {
      return ok(profile(host, p.topic));
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

  return [setGoal, setBudget, setPreference, search, getProfile, stayQuiet] as unknown as ToolDefinition[];
}
