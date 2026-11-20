import { describe, expect, it } from "vitest";
import { deterministicUuidv7, fsrsScheduler, makeEvent, nextProbe, replay, type MyelinEvent, type State } from "../src/index.js";
import { buildSession, D, H, T0 } from "./session.js";

const s = fsrsScheduler();
const opts = { scheduler: s };

function log(build: (add: (at: number, f: (m: { id: string; device_id: string; ts: number; seq: number }) => MyelinEvent) => void) => void): State {
  const out: MyelinEvent[] = [];
  build((at, f) => out.push(f({ id: deterministicUuidv7(T0 + at, `p:${out.length}`), device_id: "d", ts: T0 + at, seq: out.length + 1 })));
  return replay(out, s);
}

const found = (id: string, extra: Record<string, unknown> = {}) => (m: { id: string; device_id: string; ts: number; seq: number }) =>
  makeEvent("unit.found", { unit_id: id, text: id, kind: "fact", origin: "hint", ...extra }, m);
const recalled = (id: string, grade: "again" | "good" = "good") => (m: { id: string; device_id: string; ts: number; seq: number }) =>
  makeEvent("unit.probed", { unit_id: id, depth: "recall", slot: "greeting", prompt: "?", grade, scheduler: "fsrs-6" }, m);

describe("nextProbe", () => {
  it("returns nothing for an empty state or a just-found unit", () => {
    expect(nextProbe(replay([], s), { kind: "greeting", seconds: 30, context: [] }, T0, opts)).toBeNull();
    const st = log((add) => add(0, found("a")));
    expect(nextProbe(st, { kind: "greeting", seconds: 30, context: [] }, T0 + H, opts)).toBeNull();
    expect(nextProbe(st, { kind: "greeting", seconds: 30, context: [] }, T0 + D, opts)?.unit_id).toBe("a");
  });

  it("prefers the unit the work touches, then the lowest recall", () => {
    const st = log((add) => {
      add(0, found("a"));
      add(0, found("b"));
      add(0, found("c"));
      add(D, recalled("a"));
      add(D, recalled("b", "again"));
      add(D, recalled("c"));
    });
    const now = T0 + 6 * D;
    const greeting = nextProbe(st, { kind: "greeting", seconds: 30, context: [] }, now, opts)!;
    expect(greeting).toMatchObject({ unit_id: "b", reason: "low_recall", depth: "recall" });
    expect(nextProbe(st, { kind: "in_context", seconds: 30, context: ["c"] }, now, opts)).toMatchObject({ unit_id: "c", reason: "context" });
    // A seam never asks about what the work is already on.
    expect(nextProbe(st, { kind: "seam", seconds: 30, context: ["b"] }, now, opts)!.unit_id).not.toBe("b");
  });

  it("skips anything too large for the slot", () => {
    const st = log((add) => {
      add(0, found("base"));
      add(0, found("r", { rests_on: ["base"] }));
    });
    const p = nextProbe(st, { kind: "greeting", seconds: 25, context: [] }, T0 + D, opts)!;
    expect(p).toMatchObject({ unit_id: "base", depth: "recall" });
    expect(nextProbe(st, { kind: "greeting", seconds: 10, context: [] }, T0 + D, opts)).toBeNull();
  });

  it("asks a told, rebuildable unit to be rebuilt and gates its ladders until then", () => {
    const st = log((add) => {
      add(0, found("base"));
      add(0, found("t", { rests_on: ["base"], told: true, origin: "told" }));
    });
    const p = nextProbe(st, { kind: "greeting", seconds: 60, context: ["t"] }, T0 + D, opts);
    expect(p).toMatchObject({ unit_id: "base" });
    expect(nextProbe(st, { kind: "in_context", seconds: 60, context: ["t"] }, T0 + D, opts)).toMatchObject({ unit_id: "t", depth: "rebuild" });
  });

  it("never asks about a reflex", () => {
    const st = log((add) => add(0, found("x", { observe_only: true })));
    expect(nextProbe(st, { kind: "in_context", seconds: 600, context: ["x"] }, T0 + D, opts)).toBeNull();
  });

  it("brings in goal units whose recall would lapse before the goal date", () => {
    const st = log((add) => {
      add(0, found("g"));
      add(0, found("other"));
      add(D, recalled("g"));
      add(D, recalled("other"));
      add(D, recalled("g"));
      add(D, recalled("other"));
      add(D, (m) => makeEvent("goal.set", { goal_id: "exam", text: "exam", due: T0 + 60 * D, unit_ids: ["g"] }, m));
    });
    expect(nextProbe(st, { kind: "seam", seconds: 30, context: [] }, T0 + D + 20 * 60_000, opts)).toMatchObject({ unit_id: "g", reason: "goal" });
  });

  it("offers ladder probes when due, and use probes in a timed run", () => {
    const st = log((add) => {
      add(0, found("a"));
      for (let i = 1; i <= 4; i++) add(i * D, recalled("a"));
    });
    const now = T0 + 4 * D + 20 * 60_000;
    expect(nextProbe(st, { kind: "seam", seconds: 300, context: [] }, now, opts)).toMatchObject({ unit_id: "a", depth: "use", reason: "ladder" });
    expect(nextProbe(st, { kind: "timed_run", seconds: 300, context: [] }, now, opts)).toMatchObject({ depth: "use", reason: "timed_run" });
  });

  it("is deterministic on the recorded session", () => {
    const st = replay(buildSession(), s);
    const slot = { kind: "greeting" as const, seconds: 60, context: [] };
    const now = T0 + 12 * D;
    expect(nextProbe(st, slot, now, opts)).toEqual(nextProbe(JSON.parse(JSON.stringify(st)) as State, slot, now, opts));
    expect(nextProbe(st, slot, now, opts)).not.toBeNull();
  });
});
