import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyState, fsrsScheduler, makeEvent, replay, uuidv7 } from "@myelin/core";
import { RwkvInstantEngine } from "../src/rwkv.js";

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
});
