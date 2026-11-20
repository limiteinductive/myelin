import { makeEvent, uuidv7, type EventType, type MyelinEvent } from "@myelin/core";
import { describe, expect, it } from "vitest";
import { current, foldUnits } from "../src/units.js";

const dev = uuidv7();
const ev = <T extends EventType>(type: T, payload: Parameters<typeof makeEvent<T>>[1]): MyelinEvent =>
  makeEvent(type, payload, { id: uuidv7(), device_id: dev, ts: Date.now() }) as MyelinEvent;

describe("foldUnits", () => {
  const a = uuidv7();
  const b = uuidv7();
  const found = (id: string, text: string) => ev("unit.found", { unit_id: id, text, kind: "move", origin: "hint", told: false });

  it("keeps the latest wording, from either side", () => {
    const units = foldUnits([found(a, "first"), ev("unit.reworded", { unit_id: a, text: "mine", by: "learner" }), ev("unit.reworded", { unit_id: a, kind: "fact", by: "tutor" })]);
    expect(units.get(a)).toMatchObject({ text: "mine", kind: "fact", status: "active" });
  });

  it("resolves a merged unit to the survivor, and folds incrementally", () => {
    const units = foldUnits([found(a, "one"), found(b, "two")]);
    foldUnits([ev("unit.merged", { unit_id: b, merged: [a], text: "both" })], units);
    expect(current(units, a)).toMatchObject({ id: b, text: "both" });
    expect(units.get(a)?.status).toBe("merged");
  });

  it("adds the parts of a split and marks the original", () => {
    const [p, q] = [uuidv7(), uuidv7()];
    const units = foldUnits([found(a, "x and y"), ev("unit.split", { unit_id: a, into: [{ unit_id: p, text: "x", kind: "fact" }, { unit_id: q, text: "y", kind: "fact" }] })]);
    expect(units.get(a)?.status).toBe("split");
    expect(units.get(q)?.text).toBe("y");
  });
});
