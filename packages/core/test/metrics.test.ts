import { describe, expect, it } from "vitest";
import { activeByActivity, calibration, fsrsScheduler, makeEvent, metrics, replay, uuidv7, weekOf, type MyelinEvent } from "../src/index.js";

// Wednesday 18 November 2026, 09:00 UTC.
const T0 = Date.UTC(2026, 10, 18, 9);
const M = 60_000;
const D = 86_400_000;
let n = 0;
const ev = (type: MyelinEvent["type"], payload: unknown, at: number, device = "dev-desk"): MyelinEvent =>
  makeEvent(type, payload as never, { id: uuidv7(T0 + at + n++), device_id: device, ts: T0 + at }) as MyelinEvent;
const say = (at: number, anchor: unknown = null) => ev("message.added", { message_id: uuidv7(T0 + at + 7), author: "learner", text: "x", anchor }, at);
const seqd = (events: MyelinEvent[]) => events.map((e, i) => ({ ...e, seq: i + 1 }));

describe("weekOf", () => {
  it("names the Monday that starts the week, in the learner's time zone", () => {
    expect(weekOf(T0, "UTC")).toBe("2026-11-16");
    // 23:30 UTC on Sunday 22 November is already Monday 23 November in Tokyo.
    const late = Date.UTC(2026, 10, 22, 23, 30);
    expect(weekOf(late, "UTC")).toBe("2026-11-16");
    expect(weekOf(late, "Asia/Tokyo")).toBe("2026-11-23");
  });
});

describe("active time by activity", () => {
  it("credits each stretch to what ended it, and time in a run to the run", () => {
    const events = [
      say(0),
      say(2 * M),
      ev("activity.signal", { signal: "focus" }, 3 * M),
      ev("page.edited", { page_id: "p", base_rev: 0, steps: [] }, 4 * M),
      say(30 * M),
      ev("run.started", { run_id: "r", duration_ms: 20 * M, conditions: "interview" }, 31 * M, "server:tutor"),
      say(33 * M),
      ev("run.ended", { run_id: "r", reason: "time" }, 51 * M, "server:tutor"),
    ];
    const spans = activeByActivity(events, T0 + 60 * M);
    const by = (a: string) => spans.filter((s) => s.activity === a).reduce((t, s) => t + s.ms, 0);
    expect(by("thread")).toBe(3 * M);
    expect(by("page")).toBe(M);
    expect(by("timed run")).toBe(3 * M);
  });
});

describe("metrics", () => {
  const unit = uuidv7(T0 - 30 * D);
  const late = uuidv7(T0 - 2 * D);
  const probe = (unit_id: string, depth: string, grade: string, at: number, predicted_recall?: number) =>
    ev("unit.probed", { unit_id, depth, slot: "seam", prompt: "?", grade, scheduler: "fsrs-6", ...(predicted_recall === undefined ? {} : { predicted_recall }) }, at, "server:tutor");
  const log = () =>
    seqd([
      ev("unit.found", { unit_id: unit, text: "A", kind: "fact", origin: "derived" }, -30 * D, "server:tutor"),
      ev("unit.found", { unit_id: late, text: "B", kind: "fact", origin: "hint" }, -2 * D, "server:tutor"),
      ev("unit.found", { unit_id: uuidv7(T0 - 40 * D), text: "C", kind: "fact", origin: "imported" }, -2 * D, "server:tutor"),
      probe(unit, "use", "good", -3 * D),
      probe(unit, "use", "again", -D),
      probe(unit, "recall", "good", -D),
      probe(late, "use", "good", -D),
    ]);

  it("counts use probes a week or more after the unit was found", () => {
    const events = log();
    const m = metrics(events, replay(events, fsrsScheduler()), T0, "UTC");
    expect(m.use).toEqual({ probes: 2, succeeded: 1, units: 1 });
    const week = m.weeks.find((w) => w.week === "2026-11-16")!;
    expect(week.units_found).toBe(1);
    expect(week.use).toEqual({ probes: 1, succeeded: 0 });
    // Three days before a Wednesday is the Sunday of the week before.
    expect(m.weeks.find((w) => w.week === "2026-11-09")!.use).toEqual({ probes: 1, succeeded: 1 });
  });

  it("sets predicted recall against recall and rebuild outcomes, once there is a review to predict from", () => {
    const events = seqd([
      ev("unit.found", { unit_id: unit, text: "A", kind: "fact", origin: "derived" }, -30 * D, "server:tutor"),
      probe(unit, "recall", "good", -25 * D, 0),
      probe(unit, "recall", "good", -20 * D, 0.92),
      probe(unit, "recall", "again", -10 * D, 0.92),
      probe(unit, "recall", "good", -D, 0.6),
      probe(unit, "use", "again", -D, 0.6),
    ]);
    const c = calibration(replay(events, fsrsScheduler()));
    expect(c.probes).toBe(3);
    expect(c.brier).toBeCloseTo((0.08 ** 2 + 0.92 ** 2 + 0.4 ** 2) / 3);
    expect(c.bins.map((b) => [b.from, b.probes, b.actual])).toEqual([
      [0.5, 1, 1],
      [0.9, 2, 0.5],
    ]);
  });
});
