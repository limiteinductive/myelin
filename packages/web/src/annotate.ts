// Grounded inline annotation helpers: locate verbatim coach quotes inside learner text,
// split text into line-anchored highlights + inline pins, and detect when an edited draft
// has modified a flagged span.

export interface InlineAnnotation {
  /** Exact verbatim substring from the learner's text that this pin anchors to. */
  quote: string;
  /** Short, surgical note displayed beneath that line. */
  note: string;
  /** "slip" = concrete crack/error; "question" = probe on an unstated step; "move" = good Thinking Move. */
  kind: "slip" | "question" | "move";
}

export interface SpanMatch {
  start: number;
  end: number;
}

export interface LineSegment {
  text: string;
  annotationIndex?: number;
  kind?: InlineAnnotation["kind"];
}

export interface AnnotatedLine {
  lineIndex: number;
  segments: LineSegment[];
  pins: { annotation: InlineAnnotation; index: number }[];
}

/**
 * Finds the character range `[start, end)` of `quote` inside `text`.
 * Tries exact substring first, then whitespace-collapsed case-insensitive matching
 * mapped back to original offsets in `text`.
 */
export function locateAnnotation(text: string, quote: string): SpanMatch | null {
  const q = quote.trim();
  if (!text || !q) return null;

  const exact = text.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };

  // Case-insensitive exact length match
  const lowerIdx = text.toLowerCase().indexOf(q.toLowerCase());
  if (lowerIdx >= 0) return { start: lowerIdx, end: lowerIdx + q.length };

  // Whitespace-collapsed match mapped back to original character positions
  const normChars: string[] = [];
  const origOffsets: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (!inSpace && normChars.length > 0) {
        normChars.push(" ");
        origOffsets.push(i);
        inSpace = true;
      }
    } else {
      normChars.push(ch.toLowerCase());
      origOffsets.push(i);
      inSpace = false;
    }
  }
  const normText = normChars.join("");
  const normQuote = q.replace(/\s+/g, " ").toLowerCase();
  const idx = normText.indexOf(normQuote);
  if (idx < 0) return null;

  const start = origOffsets[idx]!;
  const lastNormIdx = idx + normQuote.length - 1;
  const end = origOffsets[lastNormIdx]! + 1;
  return start < end ? { start, end } : null;
}

/**
 * Splits `text` into lines, highlighting matched annotation spans inline and attaching each
 * annotation pin to the line where its highlighted span ends (PR-review style).
 */
export function buildAnnotatedLines(
  text: string,
  annotations: readonly InlineAnnotation[],
): { lines: AnnotatedLine[]; matchedCount: number } {
  type Resolved = { start: number; end: number; index: number; annotation: InlineAnnotation };
  const resolved: Resolved[] = [];

  for (let i = 0; i < annotations.length; i++) {
    const ann = annotations[i]!;
    const hit = locateAnnotation(text, ann.quote);
    if (!hit) continue;
    // Skip overlapping spans so highlights stay crisp and unambiguous
    const overlaps = resolved.some((r) => hit.start < r.end && hit.end > r.start);
    if (overlaps) continue;
    resolved.push({ start: hit.start, end: hit.end, index: i, annotation: ann });
  }
  resolved.sort((a, b) => a.start - b.start);

  const rawLines = text.split("\n");
  const lines: AnnotatedLine[] = [];
  let cursor = 0;

  for (let li = 0; li < rawLines.length; li++) {
    const raw = rawLines[li]!;
    const lineStart = cursor;
    const lineEnd = lineStart + raw.length;
    cursor = lineEnd + 1; // +1 for "\n"

    const lineHits = resolved.filter((r) => r.start < lineEnd && r.end > lineStart);
    const segments: LineSegment[] = [];
    let pos = lineStart;
    for (const hit of lineHits) {
      const segStart = Math.max(lineStart, hit.start);
      const segEnd = Math.min(lineEnd, hit.end);
      if (segStart > pos) {
        segments.push({ text: text.slice(pos, segStart) });
      }
      if (segEnd > segStart) {
        segments.push({
          text: text.slice(segStart, segEnd),
          annotationIndex: hit.index,
          kind: hit.annotation.kind,
        });
        pos = segEnd;
      }
    }
    if (pos < lineEnd) {
      segments.push({ text: text.slice(pos, lineEnd) });
    }
    if (segments.length === 0) {
      segments.push({ text: "" });
    }

    // Anchor each pin directly below the line where its span ends
    const pins = resolved
      .filter((r) => r.end > lineStart && r.end <= lineEnd)
      .map((r) => ({ annotation: r.annotation, index: r.index }));

    lines.push({ lineIndex: li, segments, pins });
  }

  return { lines, matchedCount: resolved.length };
}

/** True when the learner has edited/removed the flagged substring in their living draft. */
export function isAnnotationEdited(draft: string, quote: string): boolean {
  return locateAnnotation(draft, quote) === null;
}

/** True when `coachMessage` adds nothing beyond a single matched inline annotation. */
export function isCoachMessageRedundant(coachMessage: string, annotations: readonly InlineAnnotation[]): boolean {
  if (annotations.length !== 1) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(coachMessage);
  const b = norm(annotations[0]!.note);
  if (!a || !b) return false;
  return a === b || b.includes(a) || a.includes(b);
}
