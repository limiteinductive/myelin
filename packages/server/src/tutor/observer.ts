// The quiet observer's triage: one cheap model call that decides whether anything on the page, or in
// what the learner said while working, is worth interrupting for. The full tutor runs only when it is.
import { groupAsides, lineAt, pageLines, pageText, type AnchoredMessage, type PageState } from "@myelin/core";
import type { ThreadMessage } from "./context.js";

/** How long the learner must pause after an edit before the page is looked at. */
export const OBSERVE_PAUSE_MS = 15_000;
/** A page is being worked on for this long after its last edit. Thread messages meanwhile may be thinking aloud. */
export const WORKING_MS = 10 * 60_000;

export const TRIAGE_SYSTEM = `You watch a learner work on a page for their tutor and decide, in one look, whether the tutor should interrupt. The tutor is quiet by default. It speaks only at a real flaw in the reasoning.

Raise only a real flaw: a wrong step or result, a false claim, a misread problem, or an assumption that does not hold and that later work depends on. Check the arithmetic and algebra on the changed lines yourself.

Do not raise typos, notation, style, loosely typed math, steps that are slow but correct, a line that is still being written, work that is unfinished but right so far, or anything an aside already raises. When unsure, do not raise.

If the learner also said something in the thread while working, decide whether any of it is addressed to the tutor: a question, a request, or anything that expects an answer. An answer to the tutor's last message is addressed to the tutor. Thinking aloud, such as "so I need P(+) first" or "maybe the complement is easier", is not. When unsure, call it addressed. A flaw in what they said counts like a flaw on the page.

Answer with one JSON object and nothing else:
{"raise": true or false, "line": the page line of the flaw if it is on the page, "why": "the flaw in a few words, if raising", "addressed": true or false}
Include "addressed" only when the learner said something.`;

export interface Verdict {
  raise: boolean;
  line?: number | undefined;
  why?: string | undefined;
  addressed?: boolean | undefined;
}

export interface TriageInput {
  page: PageState;
  /** The page's lines as the last look saw them, or null for a first look. */
  before: readonly string[] | null;
  /** The thread so far, for the asides on this page. */
  messages: readonly ThreadMessage[];
  pages: Readonly<Record<string, PageState>>;
  /** Un-anchored learner messages that may be thinking aloud. */
  said: readonly string[];
  /** The tutor's last message in the thread, so an answer to it is not taken for thinking aloud. */
  lastTutor?: string | null;
}

/** The line numbers whose text is new since the last look. */
export function changedLines(page: PageState, before: readonly string[] | null): number[] {
  const lines = pageLines(page).filter((l) => l.kind !== "problem" && l.text.trim() !== "");
  if (!before) return lines.map((l) => l.n);
  const left = new Map<string, number>();
  for (const t of before) left.set(t, (left.get(t) ?? 0) + 1);
  const out: number[] = [];
  for (const l of lines) {
    const k = left.get(l.text) ?? 0;
    if (k > 0) left.set(l.text, k - 1);
    else out.push(l.n);
  }
  return out;
}

export function triagePrompt(t: TriageInput): string {
  const parts = [pageText(t.page)];
  const changed = changedLines(t.page, t.before);
  if (t.before) parts.push(changed.length ? `Lines new or changed since the last look: ${changed.join(", ")}.` : "No line is new since the last look.");
  else parts.push("This is the first look at this page.");

  const anchored = t.messages.filter((m): m is ThreadMessage & { anchor: NonNullable<ThreadMessage["anchor"]> } => m.anchor?.page_id === t.page.id);
  const asides = groupAsides(
    anchored.map((m): AnchoredMessage => ({ id: m.id, author: m.author, text: m.text, ts: m.ts, anchor: m.anchor })),
    t.pages,
  );
  if (asides.length) {
    const lines = asides.map((a) => {
      const where = a.range ? `line ${lineAt(t.page, a.range.from)?.n ?? "?"}` : "a deleted passage";
      const first = a.messages[0]!;
      const last = a.messages.at(-1)!;
      const waiting = last.author === "tutor" ? "; the learner has not answered yet" : "";
      return `- at ${where}, "${a.quote}": the ${first.author} wrote "${first.text}"${waiting}`;
    });
    parts.push(`Asides already on the page:\n${lines.join("\n")}`);
  }
  if (t.said.length && t.lastTutor) parts.push(`The tutor's last message in the thread:\n"${t.lastTutor}"`);
  if (t.said.length) parts.push(`What the learner said in the thread while working:\n${t.said.map((s) => `- "${s}"`).join("\n")}`);
  return parts.join("\n\n");
}

/** The verdict in a model's answer, or null if there is none. */
export function parseVerdict(text: string): Verdict | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let v: unknown;
  try {
    v = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.raise !== "boolean") return null;
  return {
    raise: o.raise,
    line: typeof o.line === "number" && Number.isInteger(o.line) ? o.line : undefined,
    why: typeof o.why === "string" && o.why.trim() ? o.why.trim() : undefined,
    addressed: typeof o.addressed === "boolean" ? o.addressed : undefined,
  };
}

/** What the tutor is told when triage raises something. */
export function observationPrompt(page: PageState, v: Verdict, said: readonly string[]): string {
  const flagged = v.line ? `line ${v.line}${v.why ? ` (${v.why})` : ""}` : v.why ? `this: ${v.why}` : "something";
  const heard = said.length ? `While working they said in the thread:\n${said.map((s) => `"${s}"`).join("\n")}\nThat was thinking aloud, not a question to you. ` : "";
  return (
    `[app: this is an observation, not a message. The learner is working on page "${page.title}" (id ${page.id}) and paused. ${heard}` +
    `A quick check flagged ${flagged}. Look at it yourself. If it is a real flaw in the reasoning, call open_aside at that line with one question, at most 100 words, without the fix. ` +
    `If the flaw is only in what they said and not on the page, write one short question instead. If it is not a real flaw, call stay_quiet. Write nothing else.]`
  );
}
