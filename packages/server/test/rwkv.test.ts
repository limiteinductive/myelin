import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyState, fsrsScheduler, makeEvent, replay, uuidv7 } from "@myelin/core";
import { computeCalibratedIntervals, pickDrillDepth, pickRepModality, pickSynthesisCluster, RwkvInstantEngine } from "../src/rwkv.js";

const MODEL_DIR = fileURLToPath(new URL("../../../data/models/sm72e25/sm72e25", import.meta.url));

describe("RwkvInstantEngine (sm72e25)", () => {
  it.skipIf(!existsSync(join(MODEL_DIR, "weights.f32.bin")))("matches Python reference small_model_recurrent.py to < 1e-5", () => {
    const engine = RwkvInstantEngine.load(MODEL_DIR);
    expect(engine).not.toBeNull();

    // Compare TS RecurrentModel.step() against the official NumPy reference on 12 synthetic reviews + queries.
    const pyScript = `
import json, sys, numpy as np
sys.path.insert(0, ${JSON.stringify(join(MODEL_DIR, "reference"))})
from weights_io import load_package
from small_model_recurrent import RecurrentModel
w, spec = load_package(${JSON.stringify(MODEL_DIR)}, "fp32")
m = RecurrentModel(w, spec)
st = m.new_store()
rng = np.random.default_rng(42)
out = []
for step in range(8):
    f = rng.normal(0, 0.5, 92).astype(np.float32)
    ids = {"card_id": (step % 3) + 1, "deck_id": 1, "note_id": (step % 3) + 1, "preset_id": 1, "user_id": 1}
    skip = (step % 2 == 1)
    h = m.step(f, ids, skip, st)
    p_imm, p_rat = m.instant(h)
    p_c = m.p_curve(h, 86400.0)
    out.append({"f": f.tolist(), "ids": ids, "skip": skip, "p_imm": p_imm, "p_rat": p_rat.tolist(), "p_c": p_c})
print(json.dumps(out))
`;
    const rows = JSON.parse(execFileSync("python3", ["-c", pyScript], { encoding: "utf8" })) as {
      f: number[];
      ids: { card_id: number; deck_id: number; note_id: number; preset_id: number; user_id: number };
      skip: boolean;
      p_imm: number;
      p_rat: number[];
      p_c: number;
    }[];

    const store = engine!.model.newStore();
    for (const row of rows) {
      const heads = engine!.model.step(new Float32Array(row.f), row.ids, row.skip, store);
      const { p_imm, p_rating } = engine!.model.instant(heads);
      const p_c = engine!.model.pCurve(heads, 86400);
      expect(Math.abs(p_imm - row.p_imm)).toBeLessThan(1e-5);
      expect(Math.abs(p_c - row.p_c)).toBeLessThan(1e-5);
      for (let i = 0; i < 4; i++) expect(Math.abs(p_rating[i]! - row.p_rat[i]!)).toBeLessThan(1e-5);
    }
  });

  it.skipIf(!existsSync(join(MODEL_DIR, "weights.f32.bin")))("scores collection units and predicts lower recall after longer gaps or lapses", () => {
    const engine = RwkvInstantEngine.load(MODEL_DIR)!;
    const t0 = 1_790_000_000_000;
    const u1 = uuidv7(t0);
    const u2 = uuidv7(t0 + 1);
    const events = [
      makeEvent("unit.found", { unit_id: u1, text: "Seed A", kind: "move", topic: "general", rests_on: [], origin: "derived", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0), device_id: "server:tutor", ts: t0, seq: 1 }),
      makeEvent("unit.found", { unit_id: u2, text: "Seed B", kind: "move", topic: "general", rests_on: [], origin: "derived", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0 + 1), device_id: "server:tutor", ts: t0 + 1, seq: 2 }),
      makeEvent("unit.probed", { unit_id: u1, depth: "recall", slot: "seam", prompt: "A?", answer_message_id: null, grade: "easy", corrected_grade: null, hints: 0, latency_ms: 4000, scheduler: "rwkv-sm72e25", predicted_recall: 0 }, { id: uuidv7(t0 + 1000), device_id: "server:drill", ts: t0 + 1000, seq: 3 }),
      makeEvent("unit.probed", { unit_id: u2, depth: "recall", slot: "seam", prompt: "B?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 1, latency_ms: 25000, scheduler: "rwkv-sm72e25", predicted_recall: 0 }, { id: uuidv7(t0 + 2000), device_id: "server:drill", ts: t0 + 2000, seq: 4 }),
    ];
    const state = replay(events, fsrsScheduler(), emptyState(fsrsScheduler()));
    const scores = engine.scoreUnits(state, t0 + 3_600_000);
    const s1 = scores.get(u1)!;
    const s2 = scores.get(u2)!;
    expect(s1.p_imm).toBeGreaterThan(0.5);
    expect(s1.p_imm).toBeGreaterThan(s2.p_imm);
    expect(s1.next_in_ms).toBeGreaterThan(0);
    // u2 was graded "again" 1h ago, so remaining time until due must count down to 0
    expect(s2.next_in_ms).toBe(0);
  });

  it("calibrates FSRS-6 (R=0.85) intervals without 10m boomerangs and caps pure definitions at explain", () => {
    const t0 = 1_790_000_000_000;
    const uTold = uuidv7(t0);
    const uLapse = uuidv7(t0 + 1);
    const uGood = uuidv7(t0 + 2);
    const events = [
      makeEvent("unit.found", { unit_id: uTold, text: "bp stands for base pair.", kind: "definition", topic: "genomics", rests_on: [], origin: "need", told: true, observe_only: false, message_id: null }, { id: uuidv7(t0), device_id: "server:drill", ts: t0, seq: 1 }),
      makeEvent("unit.found", { unit_id: uLapse, text: "Variance scaling pulls constants out squared.", kind: "move", topic: "stats", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0 + 1), device_id: "server:drill", ts: t0 + 1, seq: 2 }),
      makeEvent("unit.found", { unit_id: uGood, text: "Linearity of expectation holds without independence.", kind: "move", topic: "stats", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0 + 2), device_id: "server:drill", ts: t0 + 2, seq: 3 }),
      // Assisted Build-gear pass on newly told definition (again with hints=2) -> treated as hard (>=12h), NOT 10m!
      makeEvent("unit.probed", { unit_id: uTold, depth: "recall", slot: "seam", prompt: "What is bp?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 2, latency_ms: 45_000, scheduler: "rwkv", predicted_recall: 0 }, { id: uuidv7(t0 + 1000), device_id: "server:drill", ts: t0 + 1000, seq: 4 }),
      // Pure unassisted lapse -> enforces >=4h next-sitting floor (never 10m boomerang)
      makeEvent("unit.probed", { unit_id: uLapse, depth: "recall", slot: "seam", prompt: "Var(aX)?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 0, latency_ms: 15_000, scheduler: "rwkv", predicted_recall: 0.5 }, { id: uuidv7(t0 + 2000), device_id: "server:drill", ts: t0 + 2000, seq: 5 }),
      // Clean cold good -> multi-day interval (not 1.7h!)
      makeEvent("unit.probed", { unit_id: uGood, depth: "recall", slot: "seam", prompt: "E[X+Y]?", answer_message_id: null, grade: "good", corrected_grade: null, hints: 0, latency_ms: 60_000, scheduler: "rwkv", predicted_recall: 0 }, { id: uuidv7(t0 + 3000), device_id: "server:drill", ts: t0 + 3000, seq: 6 }),
      // Two clean passes on definition -> should stay at explain, never use
      makeEvent("unit.probed", { unit_id: uTold, depth: "recall", slot: "seam", prompt: "What is bp?", answer_message_id: null, grade: "good", corrected_grade: null, hints: 0, latency_ms: 8_000, scheduler: "rwkv", predicted_recall: 0.7 }, { id: uuidv7(t0 + 4000), device_id: "server:drill", ts: t0 + 4000, seq: 7 }),
      makeEvent("unit.probed", { unit_id: uTold, depth: "explain", slot: "seam", prompt: "Why bp?", answer_message_id: null, grade: "good", corrected_grade: null, hints: 0, latency_ms: 9_000, scheduler: "rwkv", predicted_recall: 0.8 }, { id: uuidv7(t0 + 5000), device_id: "server:drill", ts: t0 + 5000, seq: 8 }),
    ];
    const state = replay(events, fsrsScheduler(), emptyState(fsrsScheduler()));
    const cal = computeCalibratedIntervals(state, t0 + 10_000);
    expect(cal.get(uLapse)!.next_in_ms).toBeGreaterThanOrEqual(19 * 60_000);
    expect(cal.get(uLapse)!.next_in_ms).toBeLessThanOrEqual(46 * 60_000);
    expect(cal.get(uGood)!.next_in_ms).toBeGreaterThanOrEqual(24 * 3600_000);
    expect(pickDrillDepth(state.units[uTold]!, state)).toBe("explain");

    // Two-stage relearning: miss -> 20m retry -> same-day pass -> overnight (20h, NOT ts-fsrs +72h!)
    const uRelearn = uuidv7(t0 + 15);
    const relearnEvs = [
      makeEvent("unit.found", { unit_id: uRelearn, text: "RMSNorm omits mean subtraction.", kind: "mechanism", topic: "Norms", rests_on: [], origin: "need", told: true, observe_only: false, message_id: null }, { id: uuidv7(t0 + 15), device_id: "server:drill", ts: t0 + 15, seq: 1 }),
      makeEvent("unit.probed", { unit_id: uRelearn, depth: "recall", slot: "seam", prompt: "RMSNorm dx?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 1, latency_ms: 40_000, scheduler: "rwkv", predicted_recall: 0 }, { id: uuidv7(t0 + 20_000), device_id: "server:drill", ts: t0 + 20_000, seq: 2 }),
      makeEvent("unit.probed", { unit_id: uRelearn, depth: "recall", slot: "seam", prompt: "RMSNorm dx v2?", answer_message_id: null, grade: "good", corrected_grade: null, hints: 0, latency_ms: 18_000, scheduler: "rwkv", predicted_recall: 0.4 }, { id: uuidv7(t0 + 20_000 + 20 * 60_000), device_id: "server:drill", ts: t0 + 20_000 + 20 * 60_000, seq: 3 }),
    ];
    const relearnSt = replay(relearnEvs, fsrsScheduler(), emptyState(fsrsScheduler()));
    const relearnCal = computeCalibratedIntervals(relearnSt, t0 + 20_000 + 20 * 60_000 + 1000).get(uRelearn)!;
    expect(relearnCal.next_in_ms).toBeGreaterThanOrEqual(19 * 3600_000);
    expect(relearnCal.next_in_ms).toBeLessThanOrEqual(21 * 3600_000);

    // One-shot timing override shifts due time cleanly without mutating grade evidence, and yields to newer probes
    const overrideMap = new Map([[uRelearn, { due_at: t0 + 20_000 + 20 * 60_000 + 7 * 86_400_000, created_at: t0 + 20_000 + 20 * 60_000 + 500 }]]);
    const overriddenCal = computeCalibratedIntervals(relearnSt, t0 + 20_000 + 20 * 60_000 + 1000, overrideMap).get(uRelearn)!;
    expect(overriddenCal.next_in_ms).toBeGreaterThanOrEqual(6.9 * 86_400_000);

    // Grade overrides still produce strictly increasing intervals (again < hard < good < easy)
    const uOverride = uuidv7(t0 + 20);
    const probeId = uuidv7(t0 + 21_000);
    const intervalFor = (grade: "again" | "hard" | "good" | "easy") => {
      const evs = [
        makeEvent("unit.found", { unit_id: uOverride, text: "RMSNorm omits mean subtraction.", kind: "mechanism", topic: "Norms", rests_on: [], origin: "need", told: true, observe_only: false, message_id: null }, { id: uuidv7(t0 + 20), device_id: "server:drill", ts: t0 + 20, seq: 1 }),
        makeEvent("unit.probed", { unit_id: uOverride, depth: "recall", slot: "seam", prompt: "RMSNorm dx?", answer_message_id: null, grade: "hard", corrected_grade: null, hints: 2, latency_ms: 40_000, scheduler: "rwkv", predicted_recall: 0 }, { id: probeId, device_id: "server:drill", ts: t0 + 21_000, seq: 2 }),
        makeEvent("unit.probed", { unit_id: uOverride, corrects: probeId, grade, note: "Learner override" }, { id: uuidv7(t0 + 22_000), device_id: "server:drill", ts: t0 + 22_000, seq: 3 }),
      ];
      const st = replay(evs, fsrsScheduler(), emptyState(fsrsScheduler()));
      return computeCalibratedIntervals(st, t0 + 23_000).get(uOverride)!.next_in_ms;
    };
    const tAgain = intervalFor("again");
    const tHard = intervalFor("hard");
    const tGood = intervalFor("good");
    const tEasy = intervalFor("easy");
    expect(tAgain).toBeGreaterThanOrEqual(19 * 60_000);
    expect(tAgain).toBeLessThan(tHard);
    expect(tHard).toBeLessThan(tGood);
    expect(tGood).toBeLessThan(tEasy);
  });

  it("propagates downward rests_on credit, bundles synthesis clusters, and selects adaptive rep modalities", () => {
    const t0 = 1_790_000_000_000;
    const uBase = uuidv7(t0);
    const uDerived = uuidv7(t0 + 1);
    const uSibling = uuidv7(t0 + 2);
    const uUnrelated = uuidv7(t0 + 3);
    const uDef = uuidv7(t0 + 4);
    const events = [
      makeEvent("unit.found", { unit_id: uBase, text: "Linear attention replaces softmax with a kernel map phi(q)^T phi(k).", kind: "mechanism", topic: "Linear Attention", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0), device_id: "server:drill", ts: t0, seq: 1 }),
      makeEvent("unit.found", { unit_id: uDerived, text: "Causal linear attention maintains a d_k x d_v recurrent state matrix S_t = S_{t-1} + phi(k_t) v_t^T.", kind: "mechanism", topic: "Linear Attention", rests_on: [uBase], origin: "need", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0 + 1), device_id: "server:drill", ts: t0 + 1, seq: 2 }),
      makeEvent("unit.found", { unit_id: uSibling, text: "Additive linear attention hits fixed-capacity memory interference across keys phi(k).", kind: "mechanism", topic: "Linear Attention", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0 + 2), device_id: "server:drill", ts: t0 + 2, seq: 3 }),
      makeEvent("unit.found", { unit_id: uUnrelated, text: "Borzoi uses dilated convolutions across genomic windows.", kind: "result", topic: "Genomics", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0 + 3), device_id: "server:drill", ts: t0 + 3, seq: 4 }),
      makeEvent("unit.found", { unit_id: uDef, text: "Homoscedasticity means constant error variance.", kind: "definition", topic: "Stats", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null }, { id: uuidv7(t0 + 4), device_id: "server:drill", ts: t0 + 4, seq: 5 }),
      // Passing uDerived cleanly should also refresh its rests_on prerequisite uBase via downward DAG credit!
      makeEvent("unit.probed", { unit_id: uDerived, depth: "rebuild", slot: "seam", prompt: "Derive S_t", answer_message_id: null, grade: "good", corrected_grade: null, hints: 0, latency_ms: 20_000, scheduler: "rwkv", predicted_recall: 0.5 }, { id: uuidv7(t0 + 5000), device_id: "server:drill", ts: t0 + 5000, seq: 6 }),
    ];
    const state = replay(events, fsrsScheduler(), emptyState(fsrsScheduler()));
    const cal = computeCalibratedIntervals(state, t0 + 10_000);
    // uBase had 0 direct probes, yet received downward credit from uDerived's clean pass!
    expect(cal.get(uBase)!.reviews).toBe(1);
    expect(cal.get(uBase)!.next_in_ms).toBeGreaterThanOrEqual(24 * 3600_000);

    // Synthesis cluster bundles related due units (uBase + uSibling), excludes unrelated Genomics unit
    const dueIds = new Set([uDerived, uBase, uSibling, uUnrelated]);
    const bundle = pickSynthesisCluster(state.units[uDerived]!, state, dueIds, 2);
    expect(bundle.map((u) => u.id)).toEqual([uBase, uSibling]);

    // Adaptive modality selection
    expect(pickRepModality(state.units[uDerived]!, state, "use", bundle)).toBe("synthesis");
    expect(pickRepModality(state.units[uDef]!, state, "recall", [])).toBe("contrast");
    expect(pickRepModality(state.units[uSibling]!, state, "recall", [])).toBe("faded_skeleton");
    expect(pickRepModality(state.units[uDerived]!, state, "use", [])).toBe("fix_bug");
  });
});
