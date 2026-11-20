import { describe, expect, it } from "vitest";
import {
  activeMs,
  addMark,
  clockText,
  currentRun,
  foldRuns,
  makeEvent,
  marksOf,
  runElapsed,
  runEndsAt,
  runLeft,
  uuidv7,
  type Mark,
  type MyelinEvent,
} from "../src/index.js";

const T = Date.UTC(2026, 10, 2, 9, 0, 0);
const M = 60_000;
const ev = <E extends MyelinEvent>(make: (meta: { id: string; device_id: string; ts: number }) => E, at: number, device = "dev-desk"): E =>
  make({ id: uuidv7(T + at), device_id: device, ts: T + at });

describe("runs", () => {
  const started = ev((m) => makeEvent("run.started", { run_id: "r", duration_ms: 20 * M, conditions: "interview" }, m), 0, "server:tutor");

  it("counts down in wall time, less pauses", () => {
    const runs = foldRuns([
      started,
      ev((m) => makeEvent("run.paused", { run_id: "r" }, m), 5 * M),
      ev((m) => makeEvent("run.resumed", { run_id: "r" }, m), 9 * M),
    ]);
    const r = currentRun(runs)!;
    expect(r.paused_ms).toBe(4 * M);
    expect(runElapsed(r, T + 10 * M)).toBe(6 * M);
    expect(runLeft(r, T + 10 * M)).toBe(14 * M);
    expect(runEndsAt(r)).toBe(T + 24 * M);
  });

  it("holds the clock while paused", () => {
    const runs = foldRuns([started, ev((m) => makeEvent("run.paused", { run_id: "r" }, m), 5 * M)]);
    const r = runs.r!;
    expect(runLeft(r, T + 7 * M)).toBe(15 * M);
    expect(runLeft(r, T + 70 * M)).toBe(15 * M);
    expect(runEndsAt(r)).toBeNull();
  });

  it("ends at its length when the time ran out, however late the end is written", () => {
    const runs = foldRuns([started, ev((m) => makeEvent("run.ended", { run_id: "r", reason: "time" }, m), 23 * M)]);
    expect(runs.r!.ended_at).toBe(T + 20 * M);
    expect(runs.r!.end).toBe("time");
    expect(currentRun(runs)).toBeNull();
    expect(runElapsed(runs.r!, T + 99 * M)).toBe(20 * M);
  });

  it("keeps the unused time of a run stopped early", () => {
    const runs = foldRuns([started, ev((m) => makeEvent("run.ended", { run_id: "r" }, m), 12 * M)]);
    expect(runs.r!.end).toBe("stopped");
    expect(runLeft(runs.r!, T + 30 * M)).toBe(8 * M);
  });

  it("refuses a second run while one is on", () => {
    const runs = foldRuns([started, ev((m) => makeEvent("run.started", { run_id: "r2", duration_ms: M, conditions: "" }, m), M)]);
    expect(Object.keys(runs)).toEqual(["r"]);
  });

  it("reads like a clock", () => {
    expect(clockText(20 * M)).toBe("20:00");
    expect(clockText(48_400)).toBe("0:48");
    expect(clockText(62 * M)).toBe("1:02:00");
  });
});

describe("active time", () => {
  const marks = (...ms: [number, boolean][]): Mark[] => ms.map(([at, on]) => ({ at: T + at, on }));

  it("joins marks within the gap and drops longer absences", () => {
    const m = marks([0, true], [2 * M, true], [20 * M, true], [21 * M, true]);
    expect(activeMs(m, T, T + 21 * M)).toBe(3 * M);
  });

  it("stops counting at a blur until the learner is back", () => {
    const m = marks([0, true], [M, false], [3 * M, true], [4 * M, true]);
    expect(activeMs(m, T, T + 4 * M)).toBe(2 * M);
  });

  it("starts absent when the window opens after a blur", () => {
    const m = marks([0, false], [2 * M, true], [3 * M, true]);
    expect(activeMs(m, T + M, T + 3 * M)).toBe(M);
    expect(activeMs(m, T + M, T + M)).toBe(0);
  });

  it("counts a quick answer with no marks in between in full", () => {
    expect(activeMs([], T, T + 20_000)).toBe(20_000);
    expect(activeMs([], T, T + 20 * M)).toBe(0);
  });

  it("takes marks from the learner's events only", () => {
    const sent = ev((m) => makeEvent("message.added", { author: "learner", text: "hi", timing: { shown_at: T, input_started_at: T + 5000, sent_at: T + 9000 } }, m), 9000);
    const tutor = ev((m) => makeEvent("message.added", { author: "tutor", text: "hello" }, m), 10_000, "server:tutor");
    const edit = ev((m) => makeEvent("page.edited", { page_id: "p", base_rev: 0, steps: [], started_at: T + 11_000 }, m), 14_000);
    const blur = ev((m) => makeEvent("activity.signal", { signal: "blur" }, m), 15_000);
    const imported = ev((m) => makeEvent("message.added", { author: "learner", text: "old" }, m), 16_000, "import:study-mode");
    const all: Mark[] = [];
    for (const e of [blur, edit, imported, tutor, sent]) for (const k of marksOf(e)) addMark(all, k);
    expect(all.map((k) => [k.at - T, k.on])).toEqual([
      [5000, true],
      [9000, true],
      [11_000, true],
      [14_000, true],
      [15_000, false],
    ]);
  });
});
