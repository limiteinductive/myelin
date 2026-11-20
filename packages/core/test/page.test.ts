import fc from "fast-check";
import { Transform } from "prosemirror-transform";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  applyPageEdit,
  canonicalJson,
  emptyState,
  findPassage,
  fsrsScheduler,
  groupAsides,
  makeEvent,
  mapRange,
  newPage,
  PageEditError,
  pageDoc,
  pageLines,
  pageSchema,
  pageText,
  passageText,
  replay,
  type MyelinEvent,
  type PageState,
  type State,
} from "../src/index.js";

const s = fsrsScheduler();
const T0 = Date.UTC(2026, 10, 2, 9);
const S = pageSchema;

/** Steps that do `fn` to the page's current document. */
function edit(page: PageState, fn: (tr: Transform) => void): unknown[] {
  const tr = new Transform(pageDoc(page));
  fn(tr);
  return tr.steps.map((st) => st.toJSON());
}

function samplePage(): PageState {
  const page = newPage("p1", "Bayes", "A test is 99% accurate. 1% have the disease. P(sick | positive)?", T0);
  // The problem is 0..n; the empty paragraph after it holds the cursor.
  const p = pageDoc(page).child(0).nodeSize + 1;
  applyPageEdit(
    page,
    0,
    edit(page, (tr) => {
      tr.insert(p, S.text("P(sick | +) = P(+ | sick) P(sick) / P(+)"));
      tr.insert(tr.doc.content.size, S.node("paragraph", null, S.text("P(+) = 0.99 · 0.01 = 0.0099")));
      tr.insert(tr.doc.content.size, S.node("paragraph", null, S.text("so the answer is $1$")));
    }),
    T0 + 1000,
  );
  return page;
}

describe("page edits", () => {
  it("starts from the problem and an empty paragraph", () => {
    const page = newPage("p0", "Empty", null, T0);
    expect(pageDoc(page).toJSON()).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(pageLines(samplePage())[0]).toMatchObject({ n: 1, kind: "problem" });
  });

  it("counts a revision per step and keeps the text", () => {
    const page = samplePage();
    expect(page.rev).toBe(3);
    expect(page.maps).toHaveLength(3);
    expect(pageText(page)).toBe(
      [
        'Page "Bayes" (id p1, revision 3)',
        "1 (problem): A test is 99% accurate. 1% have the disease. P(sick | positive)?",
        "2: P(sick | +) = P(+ | sick) P(sick) / P(+)",
        "3: P(+) = 0.99 · 0.01 = 0.0099",
        "4: so the answer is $1$",
      ].join("\n"),
    );
  });

  it("refuses a stale edit, a bad step and an edit to the problem, changing nothing", () => {
    const page = samplePage();
    const before = canonicalJson(page);
    const steps = edit(page, (tr) => tr.insert(pageDoc(page).content.size - 1, S.text("!")));
    expect(() => applyPageEdit(page, 2, steps, T0)).toThrow(expect.objectContaining({ stale: true }));
    expect(() => applyPageEdit(page, 3, [{ stepType: "replace", from: 9999, to: 10_000 }], T0)).toThrow(PageEditError);
    expect(() => applyPageEdit(page, 3, [{ stepType: "nonsense" }], T0)).toThrow(PageEditError);
    const problem = edit(page, (tr) => tr.delete(2, 6));
    expect(() => applyPageEdit(page, 3, problem, T0)).toThrow(/problem statement/);
    // A good step before a bad one does not land either.
    expect(() => applyPageEdit(page, 3, [...steps, { stepType: "replace", from: 9999, to: 10_000 }], T0)).toThrow(PageEditError);
    expect(canonicalJson(page)).toBe(before);
    applyPageEdit(page, 3, steps, T0 + 5);
    expect(page.rev).toBe(4);
  });
});

describe("anchors", () => {
  it("finds a passage exactly or loosely, preferring the named line", () => {
    const page = samplePage();
    const exact = findPassage(page, "0.99 · 0.01")!;
    expect(passageText(page, exact.from, exact.to)).toBe("0.99 · 0.01");
    const loose = findPassage(page, "  p(+)  =  0.99")!;
    expect(loose.quote).toBe("P(+) = 0.99");
    expect(findPassage(page, "P(+)", 3)!.from).toBe(pageLines(page)[2]!.from);
    expect(findPassage(page, "not on the page")).toBeNull();
  });

  it("carries a passage forward through edits above it, and drops it when deleted", () => {
    const page = samplePage();
    const at = findPassage(page, "0.0099")!;
    const rev = page.rev;
    const line2 = pageLines(page)[1]!;
    applyPageEdit(page, page.rev, edit(page, (tr) => tr.insert(line2.from, S.text("By Bayes: "))), T0 + 2000);
    const moved = mapRange(page, rev, at.from, at.to)!;
    expect(passageText(page, moved.from, moved.to)).toBe("0.0099");
    // Typing inside the passage keeps it; deleting all of it drops the anchor.
    applyPageEdit(page, page.rev, edit(page, (tr) => tr.insert(moved.from + 2, S.text("0"))), T0 + 3000);
    const grown = mapRange(page, rev, at.from, at.to)!;
    expect(passageText(page, grown.from, grown.to)).toBe("0.00099");
    applyPageEdit(page, page.rev, edit(page, (tr) => tr.delete(grown.from - 3, grown.to)), T0 + 4000);
    expect(mapRange(page, rev, at.from, at.to)).toBeNull();
  });

  it("groups messages on overlapping passages into one aside", () => {
    const page = samplePage();
    const a = findPassage(page, "0.99 · 0.01")!;
    const b = findPassage(page, "0.01 = 0.0099")!;
    const c = findPassage(page, "the answer")!;
    const msg = (id: string, author: "learner" | "tutor", r: { from: number; to: number; quote: string }) => ({
      id,
      author,
      text: id,
      ts: T0,
      anchor: { page_id: "p1", rev: page.rev, ...r },
    });
    const asides = groupAsides([msg("m1", "tutor", a), msg("m2", "learner", c), msg("m3", "learner", b), msg("m4", "tutor", a)], { p1: page });
    expect(asides.map((x) => [x.id, x.raised_by, x.messages.map((m) => m.id)])).toEqual([
      ["m1", "tutor", ["m1", "m3", "m4"]],
      ["m2", "learner", ["m2"]],
    ]);
  });
});

describe("pages in the log", () => {
  function pageLog(): MyelinEvent[] {
    const out: MyelinEvent[] = [];
    let n = 0;
    const meta = () => ({ id: `0190e0d0-0000-7000-8000-${String(++n).padStart(12, "0")}`, device_id: "dev", ts: T0 + n * 1000, seq: n });
    const shadow = newPage("p1", "Bayes", "Find P(sick | +).", T0);
    out.push(makeEvent("page.created", { page_id: "p1", title: "Bayes", starter: "Find P(sick | +)." }, meta()));
    for (let i = 0; i < 12; i++) {
      const steps = edit(shadow, (tr) => tr.insert(tr.doc.content.size - 1, S.text(`line ${i} `)));
      const base = shadow.rev;
      applyPageEdit(shadow, base, steps, 0);
      out.push(makeEvent("page.edited", { page_id: "p1", base_rev: base, steps, started_at: T0, ended_at: T0 + 1 }, meta()));
    }
    out.push(makeEvent("page.edited", { page_id: "p1", base_rev: 0, steps: [] }, meta())); // stale: an anomaly
    out.push(makeEvent("page.edited", { page_id: "nope", base_rev: 0, steps: [] }, meta())); // unknown: an anomaly
    out.push(makeEvent("page.created", { page_id: "p1", title: "again" }, meta())); // duplicate: an anomaly
    return out;
  }

  it("rebuilds the page from its edits and records bad ones as anomalies", () => {
    const state = replay(pageLog(), s);
    expect(state.pages.p1!.rev).toBe(12);
    expect(pageLines(state.pages.p1!)[1]!.text).toBe(Array.from({ length: 12 }, (_, i) => `line ${i} `).join(""));
    expect(state.anomalies.map((a) => a.reason)).toEqual([
      "edit of page p1 refused: page p1 is at revision 12, not 0",
      "edit of unknown page nope",
      "page p1 already exists",
    ]);
  });

  it("resumes from serialized state at any cut", () => {
    const log = pageLog();
    const full = canonicalJson(replay(log, s));
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: log.length }), { maxLength: 5 }), (cuts) => {
        let state: State = emptyState(s);
        let at = 0;
        for (const cut of [...cuts].sort((a, b) => a - b)) {
          for (; at < cut; at++) applyEvent(state, log[at]!, s);
          state = JSON.parse(JSON.stringify(state)) as State;
        }
        for (; at < log.length; at++) applyEvent(state, log[at]!, s);
        return canonicalJson(state) === full;
      }),
      { numRuns: 100 },
    );
  });
});
