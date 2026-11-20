// The units table, from a hand-built log.
import { fsrsScheduler, makeEvent, replay, uuidv7, type MyelinEvent } from "@myelin/core";
import { describe, expect, it } from "vitest";
import { dayWord, unitsTable, type UnitsCard } from "../src/tutor/cards.js";

// Wednesday 18 November 2026, 09:00 UTC.
const T0 = Date.UTC(2026, 10, 18, 9);
const H = 3_600_000;
const D = 24 * H;
const MOVE = uuidv7(T0 + 1);
const RESULT = uuidv7(T0 + 2);
const BASELINE = uuidv7(T0 + 3);
const TOLD = uuidv7(T0 + 4);
const REFLEX = uuidv7(T0 + 5);
let n = 100;
const ev = (type: MyelinEvent["type"], payload: unknown, at: number): MyelinEvent =>
  makeEvent(type, payload as never, { id: uuidv7(T0 + at + n++), device_id: "server:tutor", ts: T0 + at }) as MyelinEvent;
const probe = (unit_id: string, depth: string, grade: string, at: number) =>
  ev("unit.probed", { unit_id, depth, slot: "seam", prompt: "?", grade, scheduler: "fsrs-6" }, at);

function log(): MyelinEvent[] {
  return [
    ev("unit.found", { unit_id: MOVE, text: "Multiply and divide by the density", kind: "move", origin: "hint" }, -20 * D),
    ev("unit.found", { unit_id: RESULT, text: "The score-function gradient", kind: "result", origin: "derived", rests_on: [MOVE] }, -20 * D),
    ev("unit.found", { unit_id: BASELINE, text: "A baseline must not depend on the sample", kind: "distinction", origin: "error", rests_on: [RESULT] }, -2 * D),
    ev("unit.found", { unit_id: TOLD, text: "A baseline cuts the variance", kind: "fact", origin: "told", told: true, rests_on: [RESULT] }, -D),
    ev("unit.found", { unit_id: REFLEX, text: "Check the sign first", kind: "reflex", origin: "observed", observe_only: true }, -20 * D),
    probe(MOVE, "recall", "good", -19 * D),
    probe(MOVE, "use", "again", -10 * D),
    probe(MOVE, "use", "good", -5 * D),
    probe(MOVE, "explain", "good", -4 * D),
    probe(RESULT, "recall", "good", -19 * D),
    probe(RESULT, "rebuild", "hard", -15 * D),
    probe(BASELINE, "use", "again", -D),
    ev("unit.observed", { unit_id: REFLEX, present: false }, -H),
  ];
}

const state = () => replay(log().map((e, i) => ({ ...e, seq: i + 1 })), fsrsScheduler());

describe("units table", () => {
  it("shows each depth that applies as shown, not yet or missed by its last attempt", () => {
    const card = unitsTable(state(), { unit_ids: [MOVE, RESULT, BASELINE, TOLD, REFLEX] }, T0, "UTC") as UnitsCard;
    const [move, result, baseline, told, reflex] = card.rows;
    expect(move).toMatchObject({ rests_on: "nothing, memorized", found: null, told: false });
    // Explain does not apply to a memorized unit by default, but it was tested, so it shows.
    expect(move!.depths).toEqual([
      { depth: "recall", state: "shown" },
      { depth: "explain", state: "shown" },
      { depth: "use", state: "shown" },
    ]);
    expect(result!.rests_on).toBe("Multiply and divide by the density");
    expect(result!.depths.map((d) => `${d.depth} ${d.state}`)).toEqual(["recall shown", "rebuild shown", "explain not_yet", "use not_yet"]);
    expect(baseline!.found).toBe("found Monday, by a miss");
    expect(baseline!.depths.find((d) => d.depth === "use")!.state).toBe("missed");
    expect(told).toMatchObject({ told: true, found: "found yesterday, told" });
    expect(reflex!.depths).toEqual([{ depth: "use", state: "missed" }]);
  });

  it("scopes to a topic word or the ids asked for, and says what is wrong", () => {
    const byWord = unitsTable(state(), { topic: "baseline" }, T0, "UTC") as UnitsCard;
    expect(byWord.rows.map((r) => r.unit_id)).toEqual([BASELINE, TOLD]);
    expect(unitsTable(state(), { unit_ids: ["nope"] }, T0)).toMatch(/No unit with id nope/);
    expect(unitsTable(state(), { topic: "eigen" }, T0)).toMatch(/No units match/);
  });

  it("names the day in the learner's time zone", () => {
    // 23:30 UTC on Tuesday is already Wednesday in Tokyo.
    expect(dayWord(T0 - 9.5 * H, T0, "UTC")).toBe("yesterday");
    expect(dayWord(T0 - 9.5 * H, T0, "Asia/Tokyo")).toBe("today");
    expect(dayWord(T0 - 3 * D, T0, "UTC")).toBe("Sunday");
  });
});
