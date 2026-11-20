// A run's report and timeline, from a hand-built log.
import { foldRuns, makeEvent, pageDoc, pageSchema, newPage, uuidv7, type MyelinEvent } from "@myelin/core";
import { Transform } from "prosemirror-transform";
import { describe, expect, it } from "vitest";
import { parseClock, quietStretches, runReport, timeline } from "../src/tutor/runs.js";

const T0 = Date.UTC(2026, 10, 20, 9);
const S = 1000;
const M = 60 * S;
const P = uuidv7(T0);
const R = uuidv7(T0 + 1);
const ev = (type: MyelinEvent["type"], payload: unknown, at: number, device = "d-1"): MyelinEvent =>
  makeEvent(type, payload as never, { id: uuidv7(T0 + at), device_id: device, ts: T0 + at }) as MyelinEvent;

function edit(lines: string[]): unknown[] {
  const page = newPage(P, "Sqrt 2", null, T0);
  const tr = new Transform(pageDoc(page));
  for (const l of lines) tr.insert(tr.doc.content.size, pageSchema.node("paragraph", null, pageSchema.text(l)));
  return tr.steps.map((s) => s.toJSON());
}

function log(): MyelinEvent[] {
  return [
    ev("page.created", { page_id: P, title: "Sqrt 2", starter: null }, 0),
    ev("run.started", { run_id: R, duration_ms: 20 * M, conditions: "exam", page_id: P }, 0),
    ev("message.added", { author: "learner", text: "may I assume unique factorisation?" }, 30 * S),
    ev("message.added", { author: "tutor", text: "Yes." }, 35 * S, "server:tutor"),
    ev("page.edited", { page_id: P, base_rev: 0, steps: edit(["Suppose sqrt 2 = p/q in lowest terms.", "Then p^2 = 2 q^2."]), started_at: T0 + 60 * S }, 2 * M),
    ev("run.paused", { run_id: R }, 3 * M),
    ev("activity.signal", { signal: "blur" }, 3 * M + S),
    ev("run.resumed", { run_id: R }, 8 * M),
    ev("run.ended", { run_id: R, reason: "stopped" }, 15 * M),
  ];
}

describe("run report", () => {
  it("tells the run on its own clock, with what was written and the quiet stretches", () => {
    const events = log();
    const run = foldRuns(events)[R]!;
    const r = runReport(run, events, T0 + 15 * M);
    expect(r).toContain(`Timed run ${R}: 20:00, conditions: exam.`);
    expect(r).toContain('0:30  learner: "may I assume unique factorisation?"');
    expect(r).toContain('1:00–2:00  wrote on the page "Sqrt 2", lines new or changed:');
    expect(r).toContain("Then p^2 = 2 q^2.");
    expect(r).toContain("3:00  paused");
    // Wall time 8:00 is clock 3:00: the pause does not count.
    expect(r).toContain("3:00  resumed");
    expect(r).toContain("2:00–10:00  nothing written, sent or run");
    expect(r).toContain("10:00  stopped; 10:00 of 20:00 unused");
    expect(r).toContain('The page "Sqrt 2" at the end:');
  });

  it("says once that the learner left, and when they came back", () => {
    const R2 = uuidv7(T0 + 2);
    const events = [
      ev("run.started", { run_id: R2, duration_ms: 5 * M, conditions: "", page_id: null }, 0),
      ev("activity.signal", { signal: "focus" }, 10 * S),
      ev("activity.signal", { signal: "blur" }, M),
      ev("activity.signal", { signal: "away" }, M + 5 * S),
      ev("activity.signal", { signal: "focus" }, 2 * M),
      ev("activity.signal", { signal: "typing" }, 2 * M + 10 * S),
      ev("activity.signal", { signal: "away" }, 3 * M),
      ev("run.ended", { run_id: R2, reason: "time" }, 5 * M),
    ];
    const r = runReport(foldRuns(events)[R2]!, events, T0 + 5 * M);
    expect(r.match(/left the app/g)).toHaveLength(2);
    expect(r).toContain("1:00  left the app");
    expect(r).toContain("2:00  back in the app");
    expect(r).toContain("3:00  left the app");
    expect(r).toContain("2:10–5:00  nothing written, sent or run");
  });
});

describe("timeline", () => {
  const events = log();
  const run = foldRuns(events)[R]!;

  it("turns named steps into segments that fill the time used, then adds unused time", () => {
    const card = timeline(run, 10 * M, [{ name: "Setup", until: "2:00" }, { name: "Stuck on parity", until: "9:00" }, { name: "Wrap" }], 2);
    expect(card).toEqual({
      kind: "timeline",
      run_id: R,
      duration_ms: 20 * M,
      segments: [
        { name: "Setup", ms: 2 * M },
        { name: "Stuck on parity", ms: 7 * M, costly: true },
        { name: "Wrap", ms: M },
        { name: "Unused", ms: 10 * M, unused: true },
      ],
    });
  });

  it("says what is wrong with steps it cannot use", () => {
    expect(timeline(run, 10 * M, [], undefined)).toMatch(/at least one/);
    expect(timeline(run, 10 * M, [{ name: "A" }, { name: "B" }], undefined)).toMatch(/needs an end time/);
    expect(timeline(run, 10 * M, [{ name: "A", until: "5:00" }, { name: "B", until: "4:00" }, { name: "C" }], undefined)).toMatch(/Ends must increase/);
    expect(timeline(run, 10 * M, [{ name: "A", until: "soon" }, { name: "B" }], undefined)).toMatch(/Could not read/);
    expect(timeline(run, 10 * M, [{ name: "A" }], 3)).toMatch(/costly must be/);
    const open = foldRuns(events.slice(0, -1))[R]!;
    expect(timeline(open, 10 * M, [{ name: "A" }], undefined)).toMatch(/not ended/);
  });

  it("will not fold a long quiet stretch into other work", () => {
    const quiet = quietStretches(run, events, T0 + 15 * M, 3 * M).map(([a, b]) => [a - T0, b - T0]);
    expect(quiet).toEqual([[2 * M, 15 * M]]);
    const onClock: [number, number][] = [[4 * M, 10 * M]];
    expect(timeline(run, 10 * M, [{ name: "Setup", until: "1:00" }, { name: "Proof" }], undefined, onClock)).toMatch(/Step 2 \("Proof"\) folds in 4:00–10:00/);
    const card = timeline(run, 10 * M, [{ name: "Setup", until: "1:00" }, { name: "Proof", until: "4:00" }, { name: "Nothing on the page" }], undefined, onClock);
    expect(typeof card).toBe("object");
    // A step that is mostly the quiet stretch is fine.
    expect(typeof timeline(run, 10 * M, [{ name: "Setup", until: "3:30" }, { name: "Away" }], undefined, onClock)).toBe("object");
  });

  it("reads clock times", () => {
    expect(parseClock("4:05")).toBe(245 * S);
    expect(parseClock("1:02:00")).toBe(62 * M);
    expect(parseClock("90")).toBe(90 * S);
    expect(parseClock("4m")).toBeNull();
  });
});
