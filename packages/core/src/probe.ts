// Probe selection: when a slot opens, rank units by how useful a probe would be now and return
// the best one, or none. There is no queue and no due list.
import type { Depth, SlotKind } from "./events.js";
import type { Scheduler } from "./scheduler.js";
import { isRebuildable, resolveUnit, type State, type Unit } from "./state.js";

export interface Slot {
  kind: SlotKind;
  /** How much time the slot can take. */
  seconds: number;
  /** Units the current work touches. */
  context: string[];
}

export interface Probe {
  unit_id: string;
  depth: Depth;
  slot: SlotKind;
  est_seconds: number;
  /** The scheduler's predicted recall now, recorded on the resulting unit.probed. */
  predicted_recall: number;
  scheduler: string;
  reason: "context" | "low_recall" | "goal" | "ladder" | "timed_run";
}

export interface ProbeOptions {
  scheduler: Scheduler;
  /** Probe when predicted recall falls below this. Default 0.9. */
  targetRetention?: number;
  /** A unit found less than this long ago is not probed yet. Default 8 hours. */
  newUnitDelayMs?: number;
  /** A unit probed less than this long ago is not probed again. Default 10 minutes. */
  minGapMs?: number;
  /** In context, probe only when recall is below this. Default 0.97. */
  contextCeiling?: number;
  /** A retired unit comes back only when recall drops below this. Default 0.7. */
  retiredFloor?: number;
}

/** Rough time each depth takes, in seconds. */
export const DEPTH_SECONDS: Record<Depth, number> = { recall: 20, rebuild: 30, use: 180, explain: 600 };

interface Candidate {
  tier: number;
  key: number;
  probe: Probe;
}

export function nextProbe(state: State, slot: Slot, now: number, opts: ProbeOptions): Probe | null {
  const s = opts.scheduler;
  const target = opts.targetRetention ?? 0.9;
  const newDelay = opts.newUnitDelayMs ?? 8 * 3_600_000;
  const minGap = opts.minGapMs ?? 600_000;
  const ceiling = opts.contextCeiling ?? 0.97;
  const retiredFloor = opts.retiredFloor ?? 0.7;

  const context = new Set<string>();
  for (const id of slot.context) {
    const u = resolveUnit(state, id);
    if (u) for (const leaf of leaves(state, u)) context.add(leaf.id);
  }

  const goals = Object.values(state.goals).filter((g) => g.active && g.due !== null && g.due > now);

  const out: Candidate[] = [];
  for (const u of Object.values(state.units)) {
    if (u.status === "split" || u.status === "merged" || u.observe_only) continue;
    if (now - u.found_at < newDelay && !context.has(u.id)) continue;
    if (u.last_probed_at !== null && now - u.last_probed_at < minGap) continue;

    const recall = s.recall(u.memory, now);
    const inContext = context.has(u.id);
    const make = (depth: Depth, reason: Probe["reason"]): Probe => ({
      unit_id: u.id,
      depth,
      slot: slot.kind,
      est_seconds: DEPTH_SECONDS[depth],
      predicted_recall: recall,
      scheduler: s.name,
      reason,
    });
    const push = (tier: number, key: number, p: Probe) => {
      if (p.est_seconds <= slot.seconds) out.push({ tier, key, probe: p });
    };

    // A told unit that can be rebuilt is asked to be rebuilt before anything else.
    const memoryDepth: Depth = isRebuildable(u) && !u.rebuilt_once ? "rebuild" : "recall";
    const gated = u.told && isRebuildable(u) && !u.rebuilt_once;
    if (u.status === "retired" && recall >= retiredFloor) continue;

    if (slot.kind === "timed_run") {
      // In a run, only fresh problems on units already held.
      if (!gated && u.memory_reviews > 0 && recall >= 0.8) push(0, -recall, make("use", "timed_run"));
      continue;
    }
    if (slot.kind === "in_context") {
      if (inContext && recall < ceiling) push(0, recall, make(memoryDepth, "context"));
      continue;
    }
    if (slot.kind === "seam" && inContext) continue;

    if (recall < target) {
      push(1, recall, make(memoryDepth, "low_recall"));
      continue;
    }
    const goal = goals.filter((g) => g.unit_ids.includes(u.id) || (g.topic !== null && g.topic === u.topic)).sort((a, b) => a.due! - b.due!)[0];
    if (goal && s.recall(u.memory, goal.due!) < target) {
      push(2, goal.due!, make(memoryDepth, "goal"));
      continue;
    }
    if (gated) continue;
    for (const depth of ["use", "explain"] as const) {
      const l = u.ladders[depth];
      if (!l || l.due > now) continue;
      if (depth === "explain" && !isRebuildable(u)) continue;
      push(3, l.due, make(depth, "ladder"));
    }
  }

  out.sort((a, b) => a.tier - b.tier || a.key - b.key || cmp(a.probe.unit_id, b.probe.unit_id) || cmp(a.probe.depth, b.probe.depth));
  return out[0]?.probe ?? null;
}

/** The live units a unit now stands for: itself, or the parts it was split into. */
function leaves(state: State, u: Unit, depth = 0): Unit[] {
  if (u.status !== "split" || depth > 32) return [u];
  return u.successors.flatMap((id) => {
    const next = resolveUnit(state, id);
    return next ? leaves(state, next, depth + 1) : [];
  });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
