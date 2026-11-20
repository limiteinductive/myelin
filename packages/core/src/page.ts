// A page: one ProseMirror document per page, rebuilt from its `page.edited` steps. The server and
// the client share this code, so both agree on the document, its revision and where an aside's
// passage is now. The document is plain text in blocks; math is typed as `$…$` and rendered by the
// view, so the learner's text stays as typed.
import { Node as PMNode, Schema } from "prosemirror-model";
import { Mapping, Step, StepMap } from "prosemirror-transform";

export const pageSchema = new Schema({
  nodes: {
    doc: { content: "problem? block+" },
    /** The problem statement the tutor set. The only text on a page the learner did not write. */
    problem: {
      content: "text*",
      marks: "",
      defining: true,
      isolating: true,
      parseDOM: [{ tag: "div.myl-problem" }],
      toDOM: () => ["div", { class: "myl-problem" }, ["span", { class: "myl-label", contenteditable: "false" }, "Problem"], ["div", 0]],
    },
    paragraph: { group: "block", content: "inline*", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
    heading: { group: "block", content: "inline*", defining: true, parseDOM: [{ tag: "h2" }], toDOM: () => ["h2", 0] },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      code: true,
      defining: true,
      attrs: { lang: { default: "python" } },
      parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
      toDOM: () => ["div", { class: "myl-code" }, ["pre", 0]],
    },
    text: { group: "inline" },
    hard_break: { inline: true, group: "inline", selectable: false, parseDOM: [{ tag: "br" }], toDOM: () => ["br"] },
  },
  marks: {},
});

export interface PageState {
  id: string;
  title: string;
  starter: string | null;
  created_at: number;
  edited_at: number;
  /** The number of steps applied. An edit names the revision it was made against. */
  rev: number;
  doc: unknown;
  /** One step map per step, as [start, oldSize, newSize, …], to carry positions forward. */
  maps: number[][];
}

export interface Anchor {
  page_id: string;
  rev: number;
  from: number;
  to: number;
  quote: string;
}

export class PageEditError extends Error {
  constructor(
    message: string,
    readonly stale: boolean,
  ) {
    super(message);
  }
}

export function starterDoc(starter: string | null): PMNode {
  const s = pageSchema;
  const blocks = [s.node("paragraph")];
  if (starter?.trim()) blocks.unshift(s.node("problem", null, s.text(starter.trim())));
  return s.node("doc", null, blocks);
}

export function newPage(id: string, title: string, starter: string | null, at: number): PageState {
  return { id, title, starter, created_at: at, edited_at: at, rev: 0, doc: starterDoc(starter).toJSON(), maps: [] };
}

const docs = new WeakMap<PageState, { rev: number; node: PMNode }>();

/** The page's current document. */
export function pageDoc(page: PageState): PMNode {
  const hit = docs.get(page);
  if (hit && hit.rev === page.rev) return hit.node;
  const node = PMNode.fromJSON(pageSchema, page.doc);
  docs.set(page, { rev: page.rev, node });
  return node;
}

function problemEnd(doc: PMNode): number {
  return doc.firstChild?.type === pageSchema.nodes.problem ? doc.firstChild.nodeSize : 0;
}

/**
 * Applies a batch of steps made against `baseRev`, or throws a PageEditError. The page is only
 * changed if every step applies. Steps may not touch the problem statement.
 */
export function applyPageEdit(page: PageState, baseRev: number, stepsJson: readonly unknown[], at: number): void {
  if (baseRev !== page.rev) throw new PageEditError(`page ${page.id} is at revision ${page.rev}, not ${baseRev}`, true);
  let doc = pageDoc(page);
  const maps: number[][] = [];
  for (const json of stepsJson) {
    let step: Step;
    try {
      step = Step.fromJSON(pageSchema, json);
    } catch (e) {
      throw new PageEditError(`bad step: ${(e as Error).message}`, false);
    }
    const guard = problemEnd(doc);
    if (guard > 0) {
      let touches = false;
      step.getMap().forEach((from) => {
        if (from < guard) touches = true;
      });
      if (touches) throw new PageEditError("the problem statement cannot be edited", false);
    }
    let result: ReturnType<Step["apply"]>;
    try {
      result = step.apply(doc);
    } catch (e) {
      throw new PageEditError(`step does not apply: ${(e as Error).message}`, false);
    }
    if (result.failed || !result.doc) throw new PageEditError(`step does not apply: ${result.failed}`, false);
    doc = result.doc;
    maps.push(mapRanges(step.getMap()));
  }
  page.doc = doc.toJSON();
  page.maps.push(...maps);
  page.rev += maps.length;
  page.edited_at = at;
  docs.set(page, { rev: page.rev, node: doc });
}

function mapRanges(map: StepMap): number[] {
  const out: number[] = [];
  map.forEach((oldStart, oldEnd, newStart, newEnd) => out.push(oldStart, oldEnd - oldStart, newEnd - newStart));
  return out;
}

/** Carries a range made at `rev` forward to the current revision. Null if the passage was deleted. */
export function mapRange(page: PageState, rev: number, from: number, to: number): { from: number; to: number } | null {
  if (rev > page.rev) return null;
  const mapping = new Mapping(page.maps.slice(rev).map((r) => new StepMap(r)));
  const a = mapping.mapResult(from, 1);
  const b = mapping.mapResult(to, -1);
  if (b.pos <= a.pos || (a.deletedAfter && b.deletedBefore)) return null;
  return { from: a.pos, to: b.pos };
}

export interface PageLine {
  n: number;
  kind: "problem" | "heading" | "text" | "code";
  text: string;
  from: number;
  to: number;
}

/** The page as numbered lines: one per block, and one per line inside a code block. */
export function pageLines(page: PageState): PageLine[] {
  const doc = pageDoc(page);
  const out: PageLine[] = [];
  doc.forEach((node, offset) => {
    const start = offset + 1;
    const kind = node.type.name === "problem" ? "problem" : node.type.name === "heading" ? "heading" : node.type.name === "code_block" ? "code" : "text";
    const text = blockText(node);
    if (kind === "code") {
      let at = 0;
      for (const line of text.split("\n")) {
        out.push({ n: out.length + 1, kind, text: line, from: start + at, to: start + at + line.length });
        at += line.length + 1;
      }
    } else out.push({ n: out.length + 1, kind, text, from: start, to: start + text.length });
  });
  return out;
}

/** A textblock's text, one character per position: a hard break is a newline. */
function blockText(node: PMNode): string {
  let s = "";
  node.forEach((child) => {
    s += child.isText ? child.text! : "\n";
  });
  return s;
}

/** The line that holds a position. */
export function lineAt(page: PageState, pos: number): PageLine | undefined {
  const lines = pageLines(page);
  return lines.find((l) => pos >= l.from && pos <= l.to) ?? lines.findLast((l) => l.from <= pos);
}

/** The page for the tutor: its title and numbered lines. */
export function pageText(page: PageState): string {
  const lines = pageLines(page).map((l) => `${l.n}${l.kind === "text" ? "" : ` (${l.kind})`}: ${l.text}`);
  return `Page "${page.title}" (id ${page.id}, revision ${page.rev})\n${lines.join("\n")}`;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Finds a quoted passage on the page, exactly or ignoring case and spacing. With a line number, that
 * line is searched first. Returns the passage's current range and its text as written.
 */
export function findPassage(page: PageState, quote: string, line?: number): { from: number; to: number; quote: string } | null {
  const want = quote.trim();
  if (!want) return null;
  const lines = pageLines(page);
  const order = line ? [...lines.filter((l) => l.n === line), ...lines.filter((l) => l.n !== line)] : lines;
  for (const l of order) {
    const i = l.text.indexOf(want);
    if (i >= 0) return { from: l.from + i, to: l.from + i + want.length, quote: want };
  }
  const target = squash(want);
  for (const l of order) {
    // Map each character of the squashed line back to its offset in the line.
    let squashed = "";
    const back: number[] = [];
    let space = false;
    for (let i = 0; i < l.text.length; i++) {
      const ch = l.text[i]!;
      if (/\s/.test(ch)) {
        space = squashed.length > 0;
        continue;
      }
      if (space) {
        squashed += " ";
        back.push(i);
        space = false;
      }
      squashed += ch.toLowerCase();
      back.push(i);
    }
    const j = squashed.indexOf(target);
    if (j >= 0) {
      const a = back[j]!;
      const b = back[j + target.length - 1]! + 1;
      return { from: l.from + a, to: l.from + b, quote: l.text.slice(a, b) };
    }
  }
  return null;
}

/** The text of a range in the current document. */
export function passageText(page: PageState, from: number, to: number): string {
  return pageDoc(page).textBetween(from, to, "\n", "\n");
}

export interface AnchoredMessage {
  id: string;
  author: "learner" | "tutor";
  text: string;
  ts: number;
  anchor: Anchor;
}

export interface Aside {
  /** The id of the message that opened it. */
  id: string;
  page_id: string;
  /** The passage now, or null if it was deleted. The aside then stays readable in the thread. */
  range: { from: number; to: number } | null;
  quote: string;
  raised_by: "learner" | "tutor";
  messages: AnchoredMessage[];
}

/**
 * Groups anchored messages into asides. A message joins the latest aside on the same page whose
 * passage, carried to the current revision, overlaps its own; otherwise it opens a new aside.
 */
export function groupAsides(messages: Iterable<AnchoredMessage>, pages: Readonly<Record<string, PageState>>): Aside[] {
  const out: Aside[] = [];
  for (const m of messages) {
    const page = pages[m.anchor.page_id];
    const range = page ? mapRange(page, m.anchor.rev, m.anchor.from, m.anchor.to) : null;
    const join = out.findLast((a) =>
      a.page_id === m.anchor.page_id && (range && a.range ? a.range.from < range.to && range.from < a.range.to : !range && !a.range && a.quote === m.anchor.quote),
    );
    if (join) join.messages.push(m);
    else out.push({ id: m.id, page_id: m.anchor.page_id, range, quote: m.anchor.quote, raised_by: m.author, messages: [m] });
  }
  return out;
}
