// Pure wording and scaling shared by the Progress rail and the full Progress view, so both
// surfaces read the same numbers the same way. No DOM, no signals.
import type { BalanceStatus, ProgressResponse, ProgressTopic } from "./drillApi.js";

export const BALANCE_ORDER: readonly BalanceStatus[] = ["practice", "balanced", "explore"];

export const BALANCE_LABEL: Record<BalanceStatus, string> = {
  practice: "Practice first",
  balanced: "Balanced",
  explore: "Room to explore",
};

export const BALANCE_SCALE = BALANCE_ORDER.map((s) => BALANCE_LABEL[s]).join(" · ");

/** A run of text; `b` marks a figure the reader should be able to pick out of the sentence. */
export type ReadPart = string | { b: string };

export function fmtMinutes(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

export function fmtWait(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return remM >= 5 ? `${h}h ${remM}m` : `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

export function fmtSeconds(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "About 29m · 4 sittings": what the due pile costs. Empty when nothing is due. */
export function effortCaption(b: ProgressResponse["backlog"]): string {
  if (b.due.total === 0) return "";
  const parts: string[] = [];
  if (b.estimated_minutes > 0) parts.push(`About ${fmtMinutes(b.estimated_minutes * 60_000)}`);
  if (b.sittings_left > 0) parts.push(plural(b.sittings_left, "sitting"));
  return parts.join(" · ");
}

/** "18 shaky · 7 review · 7 new": most urgent first, empty kinds dropped. */
export function dueSplit(due: ProgressResponse["backlog"]["due"]): string {
  return [
    { n: due.shaky, label: "shaky" },
    { n: due.review, label: "review" },
    { n: due.new, label: "new" },
  ]
    .filter((p) => p.n > 0)
    .map((p) => `${p.n} ${p.label}`)
    .join(" · ");
}

/** What stands in for the split once the pile is clear. The full view lists cleared reps on their own row. */
export function caughtUpCaption(b: ProgressResponse["backlog"], withCleared = true): string {
  const cleared = withCleared && b.cleared_today > 0 ? ` · ${b.cleared_today} cleared today` : "";
  if (b.next_due_in_ms) return `Next due in ${fmtWait(b.next_due_in_ms)}${cleared}`;
  if (b.due_later_today > 0) return `${b.due_later_today} more later today${cleared}`;
  return `All caught up${cleared}`;
}

export function weekCaption(bal: ProgressResponse["balance"]): string {
  if (bal.added_7d === 0 && bal.practiced_7d === 0) return "Nothing added or practiced this week";
  return `${bal.added_7d} added · ${bal.passed_7d} passed this week`;
}

/**
 * Bar heights as fractions of the chart height. The scale never zooms in past `floor`, so a
 * lone 1 does not read as a full bar, and it never includes today's pile, so a backlog cannot
 * flatten the days after it.
 */
export function barScale(values: readonly number[], floor = 4): number[] {
  const max = Math.max(floor, ...values);
  return values.map((v) => (v > 0 ? v / max : 0));
}

export const sum = (values: readonly number[]) => values.reduce((a, n) => a + n, 0);

/** One or two factual sentences under the Progress headline, built only from the live numbers. */
export function decisionRead(d: ProgressResponse): ReadPart[] {
  const b = d.backlog;
  const bal = d.balance;
  const out: ReadPart[] = [];
  if (b.due.total > 0) {
    out.push({ b: `${b.due.total} due now` });
    if (b.estimated_minutes > 0) {
      out.push(" is about ", { b: plural(b.estimated_minutes, "minute") });
      if (b.sittings_left > 1) out.push(` across ${b.sittings_left} sittings`);
      else if (b.sittings_left === 1) out.push(" in one sitting");
    } else if (b.sittings_left > 0) {
      out.push(b.sittings_left === 1 ? " fits in one sitting" : ` is ${b.sittings_left} sittings`);
    }
    const tail: ReadPart[][] = [];
    if (b.due.shaky > 0) tail.push([{ b: `${b.due.shaky} shaky` }]);
    if (b.due_later_today > 0) tail.push([{ b: `${b.due_later_today} more` }, " arriving later today"]);
    tail.forEach((t, i) => out.push(i === 0 ? ", with " : " and ", ...t));
    out.push(".");
  } else {
    out.push("Nothing is due right now");
    if (b.next_due_in_ms) out.push(", and the next review comes up in ", { b: fmtWait(b.next_due_in_ms) });
    else if (b.due_later_today > 0) out.push(", with ", { b: `${b.due_later_today} more` }, " arriving later today");
    out.push(".");
  }
  if (bal.added_7d > 0 || bal.passed_7d > 0) {
    out.push(
      " This week you added ",
      { b: plural(bal.added_7d, "unit") },
      " and passed ",
      { b: plural(bal.passed_7d, "rep") },
      ".",
    );
  }
  return out;
}

/** Right-hand readout of a topic row: what is due, what is coming, or that it is clear. */
export function topicReadout(t: ProgressTopic): { text: string; quiet: boolean } {
  if (t.due > 0) {
    return { text: t.shaky > 0 ? `${t.due} due · ${t.shaky} shaky` : `${t.due} due`, quiet: false };
  }
  if (t.due_later_today > 0) return { text: `${t.due_later_today} later today`, quiet: true };
  return { text: "Caught up", quiet: true };
}
