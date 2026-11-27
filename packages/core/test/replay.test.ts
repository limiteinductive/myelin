import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyEvent, calibration, canonicalJson, emptyState, fsrsScheduler, makeEvent, parseEvent, replay, ReplayError, uuidv7, type MyelinEvent, type State } from "../src/index.js";
import { buildSession } from "./session.js";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const s = fsrsScheduler();

function readLog(): MyelinEvent[] {
  return readFileSync(fixture("session.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => parseEvent(JSON.parse(l)));
}

// Regenerate the recorded log and its golden state with UPDATE_GOLDEN=1.
if (process.env.UPDATE_GOLDEN) {
  const events = buildSession();
  writeFileSync(fixture("session.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(fixture("session.state.json"), JSON.stringify(JSON.parse(canonicalJson(replay(events, s))), null, 2) + "\n");
}

describe("replay", () => {
  it("rebuilds the recorded state from the recorded log", () => {
    const golden = readFileSync(fixture("session.state.json"), "utf8");
    const state = replay(readLog(), s);
    expect(JSON.parse(canonicalJson(state))).toEqual(JSON.parse(golden));
    expect(canonicalJson(state)).toBe(canonicalJson(JSON.parse(golden)));
  });

  it("gives identical state on every replay", () => {
    const log = readLog();
    expect(canonicalJson(replay(log, s))).toBe(canonicalJson(replay(log, s)));
  });

  it("the recorded log still matches the builder", () => {
    expect(readLog()).toEqual(buildSession());
  });

  it("resumes from serialized state at any cut, any number of times", () => {
    const log = readLog();
    const full = canonicalJson(replay(log, s));
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: log.length }), { maxLength: 6 }), (cuts) => {
        let state: State = emptyState(s);
        let at = 0;
        for (const cut of [...cuts].sort((a, b) => a - b)) {
          for (; at < cut; at++) applyEvent(state, log[at]!, s);
          state = JSON.parse(JSON.stringify(state)) as State; // as if loaded from disk
        }
        for (; at < log.length; at++) applyEvent(state, log[at]!, s);
        return canonicalJson(state) === full;
      }),
      { numRuns: 200 },
    );
  });

  it("refuses an out-of-order or unappended event", () => {
    const log = readLog();
    const state = replay(log.slice(0, 5), s);
    expect(() => applyEvent(state, log[2]!, s)).toThrow(ReplayError);
    const { seq: _seq, ...unappended } = log[6]!;
    expect(() => applyEvent(state, unappended as MyelinEvent, s)).toThrow(ReplayError);
  });

  it("records anomalies instead of failing", () => {
    expect(replay(readLog(), s).anomalies.map((a) => a.reason)).toEqual([
      "unit u-cond already exists",
      "probe of unknown unit u-nope",
      "correction of unknown probe 0190e0d0-0000-7000-8000-000000000000",
      "cannot retire unit u-mult",
      "run r-2 is already paused",
      "pause of run r-9, which is not on",
    ]);
  });
});

describe("reducers", () => {
  const state = replay(readLog(), s);
  const u = state.units;

  it("applies a later correction by recomputing memory", () => {
    const p = Object.values(state.evidence).find((e) => e.unit_id === "u-cond" && e.source === "probe")!;
    expect(p.inferred_grade).toBe("good");
    expect(p.grade).toBe("hard");
    expect(p.corrected_by).not.toBeNull();
    const fresh = s.update(s.init(), { grade: "hard", at: p.at });
    expect(u["u-cond"]!.memory).toEqual(fresh);
  });

  it("takes the in-turn correction over the inferred grade", () => {
    const p = Object.values(state.evidence).find((e) => e.unit_id === "u-mult" && e.depth === "rebuild")!;
    expect([p.inferred_grade, p.grade]).toEqual(["hard", "good"]);
    expect(u["u-mult"]!.rebuilt_once).toBe(true);
  });

  it("splits and merges, keeping links pointed at live units", () => {
    expect(u["u-var"]!.status).toBe("split");
    expect(u["u-chebyshev"]!.rests_on).toEqual(["u-var-def", "u-var-short"]);
    expect(u["u-chain"]!.status).toBe("merged");
    expect(u["u-bayes"]!.rests_on).toEqual(["u-mult"]);
    expect(u["u-mult"]!.text).toBe("P(A∩B) = P(A|B)P(B), chained");
    expect(u["u-mult"]!.evidence.map((id) => state.evidence[id]!.depth)).toEqual(["rebuild", "use", "use", "recall"]);
  });

  it("brings a retired unit back after a miss, and resets the ladder", () => {
    expect(u["u-mult"]!.status).toBe("active");
    expect(u["u-mult"]!.ladders.use!.step).toBe(1);
  });

  it("keeps explain and use out of the memory model", () => {
    expect(u["u-bayes"]!.memory_reviews).toBe(1);
    expect(u["u-bayes"]!.ladders.explain!.step).toBe(2);
    expect(u["u-bayes"]!.kind).toBe("rule");
  });

  it("counts observations of reflexes", () => {
    expect(u["u-check"]!.observations).toMatchObject({ present: 1, missing: 1 });
    expect(u["u-check"]!.memory_reviews).toBe(0);
  });

  it("keeps the latest preference and the goal", () => {
    expect(state.preferences.hints!.value).toEqual({ style: "small steps", max: 2 });
    expect(state.goals["g-exam"]!.unit_ids).toEqual(["u-bayes"]);
    expect(state.budget!.seconds).toBe(1800);
  });

  it("keeps MCQ recognition probes out of production memory, ladders, first_success_at, and calibration", () => {
    const t0 = 1_790_000_000_000;
    const uid = uuidv7(t0);
    const prodId = uuidv7(t0 + 1000);
    const mcqId = uuidv7(t0 + 20_000_000);
    const base = replay(
      [
        makeEvent(
          "unit.found",
          { unit_id: uid, text: "Cov(X,Y)=0 does not imply independence.", kind: "distinction", topic: "Prob", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
          { id: uuidv7(t0), device_id: "server:drill", ts: t0, seq: 1 },
        ),
        makeEvent(
          "unit.probed",
          { unit_id: uid, depth: "recall", slot: "seam", prompt: "Cov=0?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 0, latency_ms: 8000, scheduler: "fsrs", predicted_recall: 0.6 },
          { id: prodId, device_id: "server:drill", ts: t0 + 1000, seq: 2 },
        ),
      ],
      s,
    );
    const withMcq = replay(
      [
        makeEvent(
          "unit.found",
          { unit_id: uid, text: "Cov(X,Y)=0 does not imply independence.", kind: "distinction", topic: "Prob", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
          { id: uuidv7(t0), device_id: "server:drill", ts: t0, seq: 1 },
        ),
        makeEvent(
          "unit.probed",
          { unit_id: uid, depth: "recall", slot: "seam", prompt: "Cov=0?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 0, latency_ms: 8000, scheduler: "fsrs", predicted_recall: 0.6 },
          { id: prodId, device_id: "server:drill", ts: t0 + 1000, seq: 2 },
        ),
        makeEvent(
          "unit.probed",
          { unit_id: uid, depth: "recall", slot: "seam", prompt: "Which holds?", answer_message_id: null, grade: "hard", corrected_grade: null, hints: 0, latency_ms: 5000, scheduler: "fsrs", predicted_recall: 0.9, modality: "mcq", mcq_item_id: "item-1", mcq_outcome: "correct", mcq_choice_id: "c1" },
          { id: mcqId, device_id: "server:drill", ts: t0 + 20_000_000, seq: 3 },
        ),
        makeEvent(
          "unit.probed",
          { unit_id: uid, corrects: mcqId, grade: "again", note: "Guessed" },
          { id: uuidv7(t0 + 20_001_000), device_id: "server:drill", ts: t0 + 20_001_000, seq: 4 },
        ),
      ],
      s,
    );
    const uBase = base.units[uid]!;
    const uMcq = withMcq.units[uid]!;
    expect(uMcq.memory).toEqual(uBase.memory);
    expect(uMcq.memory_reviews).toBe(uBase.memory_reviews);
    expect(uMcq.first_success_at).toBe(uBase.first_success_at);
    expect(uMcq.rebuilt_once).toBe(uBase.rebuilt_once);
    expect(uMcq.ladders).toEqual(uBase.ladders);
    expect(uMcq.last_probed_at).toBe(t0 + 20_000_000);
    expect(withMcq.evidence[mcqId]?.modality).toBe("mcq");
    expect(withMcq.evidence[mcqId]?.grade).toBe("again");
    expect(calibration(withMcq)).toEqual(calibration(base));
  });
});
