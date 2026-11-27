// Pure parser and assembler for interactive fill-in-the-blank starter cards.

export type BlankSegment =
  | { kind: "text"; text: string }
  | { kind: "blank"; index: number };

export interface BlankLine {
  marker?: string;
  segments: BlankSegment[];
}

export interface ParsedBlanks {
  blankCount: number;
  listKind: "ol" | "ul" | "plain";
  lines: BlankLine[];
}

const BLANK_RE = /(?<!\\)(_{3,})/g;

export function countStarterBlanks(starter: string | null | undefined): number {
  if (!starter) return 0;
  const matches = starter.match(BLANK_RE);
  return matches ? matches.length : 0;
}

export function parseStarterBlanks(starter: string): ParsedBlanks {
  const rawLines = starter.replace(/\r\n?/g, "\n").split("\n");
  const nonEmpty = rawLines.filter((l) => l.trim().length > 0);
  const allOrdered = nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*\d+\.\s+/.test(l));
  const allUnordered = !allOrdered && nonEmpty.length > 0 && nonEmpty.every((l) => /^\s*[-*]\s+/.test(l));
  const listKind: ParsedBlanks["listKind"] = allOrdered ? "ol" : allUnordered ? "ul" : "plain";

  let nextIdx = 0;
  const lines: BlankLine[] = [];

  for (const rawLine of rawLines) {
    if (listKind !== "plain" && !rawLine.trim()) continue;
    let marker: string | undefined;
    let content = rawLine;
    if (listKind === "ol") {
      const m = /^\s*(\d+\.)\s+(.*)$/.exec(rawLine);
      if (m) {
        marker = m[1];
        content = m[2] ?? "";
      }
    } else if (listKind === "ul") {
      const m = /^\s*([-*])\s+(.*)$/.exec(rawLine);
      if (m) {
        marker = "•";
        content = m[2] ?? "";
      }
    }

    const segments: BlankSegment[] = [];
    let last = 0;
    BLANK_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BLANK_RE.exec(content)) !== null) {
      if (match.index > last) {
        segments.push({ kind: "text", text: content.slice(last, match.index) });
      }
      segments.push({ kind: "blank", index: nextIdx++ });
      last = match.index + match[0].length;
    }
    if (last < content.length) {
      segments.push({ kind: "text", text: content.slice(last) });
    }
    lines.push({ ...(marker ? { marker } : {}), segments });
  }

  return { blankCount: nextIdx, listKind, lines };
}

/**
 * Substitutes learner-filled blank values back into the original starter string.
 * Any empty blank remains `___` so the coach sees exactly which hole(s) were left blank.
 * If the learner ONLY wrote a clarifying question (no blanks filled), returns the question directly.
 */
export function assembleFilledStarter(
  starter: string,
  values: readonly string[],
  extraNote?: string,
): string {
  const note = (extraNote ?? "").trim();
  const anyFilled = values.some((v) => v.trim().length > 0);
  if (!anyFilled && note) return note;

  let idx = 0;
  const filled = starter.replace(BLANK_RE, () => {
    const val = (values[idx++] ?? "").replace(/\s+/g, " ").trim();
    return val.length > 0 ? val : "___";
  });
  return note ? `${filled}\n\n${note}` : filled;
}
