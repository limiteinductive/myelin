// What the thread needs to show a unit card: its current wording. Folded from the unit events in the
// stream, so a reword (by either side) updates every card that shows the unit. Merged units point to
// the survivor. The full state with memory lives on the server; the client never needs it.
import type { MyelinEvent } from "@myelin/core";

export interface UnitView {
  id: string;
  text: string;
  kind: string;
  told: boolean;
  rests_on: string[];
  status: "active" | "retired" | "split" | "merged";
  /** For a merged unit, the unit it folded into. */
  into: string | null;
}

export function foldUnits(events: readonly MyelinEvent[], into = new Map<string, UnitView>()): Map<string, UnitView> {
  for (const e of events) {
    switch (e.type) {
      case "unit.found": {
        const p = e.payload;
        if (!into.has(p.unit_id)) into.set(p.unit_id, { id: p.unit_id, text: p.text, kind: p.kind, told: p.told, rests_on: p.rests_on, status: "active", into: null });
        break;
      }
      case "unit.reworded": {
        const u = into.get(e.payload.unit_id);
        if (!u) break;
        if (e.payload.text !== undefined) u.text = e.payload.text;
        if (e.payload.kind !== undefined) u.kind = e.payload.kind;
        break;
      }
      case "unit.linked": {
        const u = into.get(e.payload.unit_id);
        if (u) u.rests_on = e.payload.rests_on;
        break;
      }
      case "unit.split": {
        const u = into.get(e.payload.unit_id);
        if (u) u.status = "split";
        for (const part of e.payload.into) {
          into.set(part.unit_id, { id: part.unit_id, text: part.text, kind: part.kind, told: u?.told ?? false, rests_on: part.rests_on, status: "active", into: null });
        }
        break;
      }
      case "unit.merged": {
        const survivor = into.get(e.payload.unit_id);
        if (survivor && e.payload.text) survivor.text = e.payload.text;
        for (const id of e.payload.merged) {
          const u = into.get(id);
          if (u) Object.assign(u, { status: "merged", into: e.payload.unit_id });
        }
        break;
      }
      case "unit.retired": {
        const u = into.get(e.payload.unit_id);
        if (u) u.status = "retired";
        break;
      }
    }
  }
  return into;
}

/** The unit a card should show now: merged units resolve to their survivor. */
export function current(units: ReadonlyMap<string, UnitView>, id: string): UnitView | undefined {
  let u = units.get(id);
  for (let i = 0; u?.into && i < 16; i++) u = units.get(u.into) ?? u;
  return u;
}
