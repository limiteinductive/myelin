import { describe, expect, it } from "vitest";
import { fsrsScheduler, importStudyMode, ImportError, parseEvent, replay, studyModeUnitId, uuidv7Time } from "../src/index.js";

const entry = (over: Record<string, unknown>) =>
  JSON.stringify({
    created_at: "2026-03-01T10:00:00Z",
    algorithm_version: "fsrs-lite-1",
    concept_id: "probability/bayes-rule",
    topic: "probability",
    concept: "Bayes' rule",
    summary: "Derived Bayes from the product rule",
    status: "learning",
    memory: { difficulty: 5, stability_days: 2, review_count: 0, lapse_count: 0, last_review_at: null, retrievability: null },
    next_review_at: "2026-03-03T10:00:00Z",
    review_after_days: 2,
    evidence: "wrote it out unaided",
    next_step: null,
    difficulty_signal: null,
    confidence: 3,
    pace: null,
    user_signal: null,
    preferences: ["small steps"],
    review: null,
    ...over,
  });

const file = [
  entry({}),
  "",
  entry({
    created_at: "2026-03-03T09:00:00Z",
    memory: { difficulty: 5, stability_days: 4, review_count: 1, lapse_count: 0, last_review_at: "2026-03-03T09:00:00Z", retrievability: 0.83 },
    review: { recall_result: "hard", answer_quality: 0.6, hints_used: 1, retrieval_depth: "explanation", misconceptions: [] },
  }),
  entry({
    created_at: "2026-03-04T09:00:00Z",
    concept_id: "probability/variance",
    concept: "Variance",
    review: { recall_result: "good", answer_quality: 0.9, hints_used: 0, retrieval_depth: "recall", misconceptions: [] },
  }),
].join("\n");

describe("study-mode import", () => {
  it("turns entries into units, probes, observations and preferences", () => {
    const events = importStudyMode(file);
    expect(events.map((e) => e.type)).toEqual(["unit.found", "unit.observed", "preference.set", "unit.probed", "unit.found", "unit.probed"]);
    const probe = events[3]!;
    expect(probe.payload).toMatchObject({ unit_id: studyModeUnitId("probability/bayes-rule"), depth: "explain", grade: "hard", hints: 1, slot: "imported", predicted_recall: 0.83 });
    expect(uuidv7Time(probe.id)).toBe(Date.parse("2026-03-03T09:00:00Z"));
    for (const e of events) expect(parseEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it("gives the same ids on every import", () => {
    expect(importStudyMode(file)).toEqual(importStudyMode(file));
    expect(new Set(importStudyMode(file).map((e) => e.id)).size).toBe(6);
  });

  it("replays into state", () => {
    const s = fsrsScheduler();
    const state = replay(importStudyMode(file).map((e, i) => ({ ...e, seq: i + 1 })), s);
    expect(state.anomalies).toEqual([]);
    expect(state.units[studyModeUnitId("probability/variance")]!.memory_reviews).toBe(1);
    expect(state.units[studyModeUnitId("probability/bayes-rule")]!.ladders.explain!.step).toBe(2);
  });

  it("names the line it cannot read", () => {
    expect(() => importStudyMode(entry({}) + "\n{oops")).toThrow(new ImportError("line 2: not JSON"));
  });
});
