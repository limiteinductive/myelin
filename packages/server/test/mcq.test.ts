import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyState, fsrsScheduler, makeEvent, replay, uuidv7 } from "@myelin/core";
import { createApp } from "../src/app.js";
import { FastJudge, validateMcqSpec } from "../src/judge.js";
import { Registry } from "../src/registry.js";
import {
  computeCalibratedIntervals,
  decideMcqRole,
  hasPendingMcqProductionCheck,
  isMcqEligible,
  MCQ_CLEAN_DELAY_MS,
  MCQ_ELIGIBILITY_GAP_MS,
  MCQ_RETRY_OVERNIGHT_CAP_MS,
  MCQ_SHORT_DELAY_MS,
  pickDrillDepth,
  pickRepModality,
} from "../src/rwkv.js";
import { Stores } from "../src/stores.js";

const VALID_MCQ_RAW = {
  prompt: "Suppose $X$ and $Y$ have $\\operatorname{Cov}(X,Y) = 0$. Which conclusion always holds?",
  expected_crux: "Zero covariance implies uncorrelatedness, not independence.",
  choices: [
    { id: "opt1", text: "$X$ and $Y$ are uncorrelated, though they may still be nonlinearly dependent." },
    { id: "opt2", text: "$X$ and $Y$ are statistically independent for every joint distribution." },
    { id: "opt3", text: "Either $\\operatorname{Var}(X)=0$ or $\\operatorname{Var}(Y)=0$ must hold." },
    { id: "opt4", text: "The conditional expectation $E[Y\\mid X]$ equals $0$ everywhere." },
  ],
  correct_id: "opt1",
  explanation: "Zero covariance only rules out linear association; symmetric nonlinear dependencies still have covariance zero.",
  why_wrong: {
    opt2: "Independence requires $P(X,Y)=P(X)P(Y)$; e.g. $Y=X^2$ with symmetric $X$ has zero covariance yet is dependent.",
    opt3: "Non-degenerate variables can have zero covariance without either variance vanishing.",
    opt4: "Zero covariance implies $E[XY]=E[X]E[Y]$, not that $E[Y\\mid X]$ vanishes.",
  },
};

describe("MCQ validation, scheduling isolation, and HTTP lifecycle", () => {
  let dir = "";
  let registry: Registry | null = null;
  let stores: Stores | null = null;

  afterEach(() => {
    stores?.close();
    registry?.close();
    stores = null;
    registry = null;
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = "";
    }
  });

  it("validates MCQ specs strictly and rejects meta-options, missing rationales, and unbalanced TeX", () => {
    const valid = validateMcqSpec(VALID_MCQ_RAW);
    expect(valid).not.toBeNull();
    expect(valid!.choices).toHaveLength(4);
    expect(valid!.correct_id).toBe("opt1");

    // Accepts 3 substantive options (when a 4th would be filler) plus optional worked_step
    const valid3 = validateMcqSpec({
      choices: VALID_MCQ_RAW.choices.slice(0, 3),
      correct_id: "opt1",
      explanation: VALID_MCQ_RAW.explanation,
      why_wrong: { opt2: VALID_MCQ_RAW.why_wrong.opt2, opt3: VALID_MCQ_RAW.why_wrong.opt3 },
      worked_step: "Check $Y = X^2$ with symmetric $X \\sim \\mathcal{N}(0,1)$: $E[XY] = E[X^3] = 0$.",
    });
    expect(valid3).not.toBeNull();
    expect(valid3!.choices).toHaveLength(3);
    expect(valid3!.worked_step).toContain("Y = X^2");

    // Rejects "all of the above" meta-option
    expect(
      validateMcqSpec({
        ...VALID_MCQ_RAW,
        choices: [
          ...VALID_MCQ_RAW.choices.slice(0, 3),
          { id: "opt4", text: "All of the above hold when finite variance exists." },
        ],
      }),
    ).toBeNull();

    // Rejects missing distractor explanation
    expect(
      validateMcqSpec({
        ...VALID_MCQ_RAW,
        why_wrong: { opt2: VALID_MCQ_RAW.why_wrong.opt2, opt3: VALID_MCQ_RAW.why_wrong.opt3 },
      }),
    ).toBeNull();

    // Rejects unbalanced $ TeX delimiters
    expect(
      validateMcqSpec({
        ...VALID_MCQ_RAW,
        choices: [
          { id: "opt1", text: "$X$ and $Y are uncorrelated with zero covariance." },
          ...VALID_MCQ_RAW.choices.slice(1),
        ],
      }),
    ).toBeNull();
  });

  it("enforces narrow eligibility, isolates FSRS/DAG credit, anchors 4h/20m pending checks, and caps same-day retries at 14h", () => {
    const t0 = 1_790_000_000_000;
    const uDist = uuidv7(t0);
    const uMove = uuidv7(t0 + 1);
    const uDerived = uuidv7(t0 + 2);

    const baseEvents = [
      makeEvent(
        "unit.found",
        {
          unit_id: uDist,
          text: "Zero covariance does not imply independence.",
          kind: "distinction",
          topic: "Probability",
          rests_on: [],
          origin: "need",
          told: false,
          observe_only: false,
          message_id: null,
        },
        { id: uuidv7(t0), device_id: "server:drill", ts: t0, seq: 1 },
      ),
      makeEvent(
        "unit.found",
        {
          unit_id: uMove,
          text: "Complete the square to integrate a Gaussian.",
          kind: "move",
          topic: "Probability",
          rests_on: [],
          origin: "need",
          told: false,
          observe_only: false,
          message_id: null,
        },
        { id: uuidv7(t0 + 1), device_id: "server:drill", ts: t0 + 1, seq: 2 },
      ),
      makeEvent(
        "unit.found",
        {
          unit_id: uDerived,
          text: "Gaussian joint normality upgrades zero covariance to independence.",
          kind: "result",
          topic: "Probability",
          rests_on: [uDist],
          origin: "need",
          told: false,
          observe_only: false,
          message_id: null,
        },
        { id: uuidv7(t0 + 2), device_id: "server:drill", ts: t0 + 2, seq: 3 },
      ),
      makeEvent(
        "unit.probed",
        {
          unit_id: uDist,
          depth: "recall",
          slot: "seam",
          prompt: "Does Cov(X,Y)=0 imply independence?",
          answer_message_id: null,
          grade: "again",
          corrected_grade: null,
          hints: 0,
          latency_ms: 14_000,
          scheduler: "rwkv",
          predicted_recall: 0.4,
        },
        { id: uuidv7(t0 + 10_000), device_id: "server:drill", ts: t0 + 10_000, seq: 4 },
      ),
      makeEvent(
        "unit.probed",
        {
          unit_id: uMove,
          depth: "recall",
          slot: "seam",
          prompt: "Complete the square",
          answer_message_id: null,
          grade: "again",
          corrected_grade: null,
          hints: 0,
          latency_ms: 14_000,
          scheduler: "rwkv",
          predicted_recall: 0.4,
        },
        { id: uuidv7(t0 + 11_000), device_id: "server:drill", ts: t0 + 11_000, seq: 5 },
      ),
    ];

    const stBeforeGap = replay(baseEvents, fsrsScheduler(), emptyState(fsrsScheduler()));
    const distUnit = stBeforeGap.units[uDist]!;
    const moveUnit = stBeforeGap.units[uMove]!;
    expect(pickDrillDepth(distUnit, stBeforeGap)).toBe("recall");
    expect(pickRepModality(distUnit, stBeforeGap, "recall", [])).toBe("contrast");

    // Too soon (< 4h gap) -> NOT eligible yet
    expect(isMcqEligible(distUnit, stBeforeGap, "recall", "contrast", t0 + 10_000 + 3_600_000)).toBe(false);
    // After >= 4h gap -> eligible for distinction/contrast/recall, rejected for move
    const tEligible = t0 + 10_000 + MCQ_ELIGIBILITY_GAP_MS + 1000;
    expect(isMcqEligible(distUnit, stBeforeGap, "recall", "contrast", tEligible)).toBe(true);
    expect(isMcqEligible(moveUnit, stBeforeGap, "recall", "contrast", tEligible)).toBe(false);
    expect(isMcqEligible(distUnit, stBeforeGap, "explain", "contrast", tEligible)).toBe(false);

    // Clean MCQ hit anchors a 4h pending production check, never advances depth, and cannot be cleared by DAG credit!
    const tMcq = tEligible + 5_000;
    const withCleanMcq = replay(
      [
        ...baseEvents,
        makeEvent(
          "unit.probed",
          {
            unit_id: uDist,
            depth: "recall",
            slot: "seam",
            prompt: VALID_MCQ_RAW.prompt,
            answer_message_id: null,
            grade: "hard",
            corrected_grade: null,
            hints: 0,
            latency_ms: 8_000,
            scheduler: "rwkv",
            predicted_recall: 0.4,
            modality: "mcq",
            mcq_item_id: "item-1",
            mcq_outcome: "correct",
            mcq_choice_id: "c1",
          },
          { id: uuidv7(tMcq), device_id: "server:drill", ts: tMcq, seq: 6 },
        ),
        // Dependent unit passes cleanly right after: DAG credit MUST NOT postpone uDist's pending MCQ production check!
        makeEvent(
          "unit.probed",
          {
            unit_id: uDerived,
            depth: "recall",
            slot: "seam",
            prompt: "Joint Gaussian?",
            answer_message_id: null,
            grade: "good",
            corrected_grade: null,
            hints: 0,
            latency_ms: 9_000,
            scheduler: "rwkv",
            predicted_recall: 0.5,
          },
          { id: uuidv7(tMcq + 5_000), device_id: "server:drill", ts: tMcq + 5_000, seq: 7 },
        ),
      ],
      fsrsScheduler(),
      emptyState(fsrsScheduler()),
    );

    const uDistAfterMcq = withCleanMcq.units[uDist]!;
    expect(hasPendingMcqProductionCheck(uDistAfterMcq, withCleanMcq)).toBe(true);
    expect(pickDrillDepth(uDistAfterMcq, withCleanMcq)).toBe("recall");
    expect(uDistAfterMcq.memory_reviews).toBe(1); // untouched by MCQ
    expect(isMcqEligible(uDistAfterMcq, withCleanMcq, "recall", "contrast", tMcq + 86_400_000)).toBe(false); // max 1 lifetime MCQ

    const calClean = computeCalibratedIntervals(withCleanMcq, tMcq + 10_000).get(uDist)!;
    expect(calClean.next_in_ms).toBeGreaterThanOrEqual(MCQ_CLEAN_DELAY_MS - 15_000);
    expect(calClean.next_in_ms).toBeLessThanOrEqual(MCQ_CLEAN_DELAY_MS);

    // Assisted MCQ hit or wrong MCQ anchors a 20m pending production check; same-day production reconstruction caps at 14h.
    const withWrongMcqAndRetry = replay(
      [
        ...baseEvents,
        makeEvent(
          "unit.probed",
          {
            unit_id: uDist,
            depth: "recall",
            slot: "seam",
            prompt: VALID_MCQ_RAW.prompt,
            answer_message_id: null,
            grade: "again",
            corrected_grade: null,
            hints: 0,
            latency_ms: 9_000,
            scheduler: "rwkv",
            predicted_recall: 0.4,
            modality: "mcq",
            mcq_item_id: "item-1",
            mcq_outcome: "wrong",
            mcq_choice_id: "c2",
          },
          { id: uuidv7(tMcq), device_id: "server:drill", ts: tMcq, seq: 6 },
        ),
      ],
      fsrsScheduler(),
      emptyState(fsrsScheduler()),
    );
    const calWrong = computeCalibratedIntervals(withWrongMcqAndRetry, tMcq + 1_000).get(uDist)!;
    expect(calWrong.next_in_ms).toBeGreaterThanOrEqual(MCQ_SHORT_DELAY_MS - 5_000);
    expect(calWrong.next_in_ms).toBeLessThanOrEqual(MCQ_SHORT_DELAY_MS);

    // Reconstruct cleanly 25m later via production -> capped at 14h overnight!
    const tRetryPass = tMcq + 25 * 60_000;
    const afterRetryPass = replay(
      [
        ...baseEvents,
        makeEvent(
          "unit.probed",
          {
            unit_id: uDist,
            depth: "recall",
            slot: "seam",
            prompt: VALID_MCQ_RAW.prompt,
            answer_message_id: null,
            grade: "again",
            corrected_grade: null,
            hints: 0,
            latency_ms: 9_000,
            scheduler: "rwkv",
            predicted_recall: 0.4,
            modality: "mcq",
            mcq_item_id: "item-1",
            mcq_outcome: "wrong",
            mcq_choice_id: "c2",
          },
          { id: uuidv7(tMcq), device_id: "server:drill", ts: tMcq, seq: 6 },
        ),
        makeEvent(
          "unit.probed",
          {
            unit_id: uDist,
            depth: "recall",
            slot: "seam",
            prompt: "Explain why Cov(X,Y)=0 doesn't imply independence.",
            answer_message_id: null,
            grade: "good",
            corrected_grade: null,
            hints: 0,
            latency_ms: 12_000,
            scheduler: "rwkv",
            predicted_recall: 0.5,
          },
          { id: uuidv7(tRetryPass), device_id: "server:drill", ts: tRetryPass, seq: 7 },
        ),
      ],
      fsrsScheduler(),
      emptyState(fsrsScheduler()),
    );
    expect(hasPendingMcqProductionCheck(afterRetryPass.units[uDist]!, afterRetryPass)).toBe(false);
    const calAfterRetry = computeCalibratedIntervals(afterRetryPass, tRetryPass + 1_000).get(uDist)!;
    expect(calAfterRetry.next_in_ms).toBeLessThanOrEqual(MCQ_RETRY_OVERNIGHT_CAP_MS);
  });

  it("enforces sitting caps, freezes attempt order, hides answers, clarifies ungraded, and grades deterministically with idempotency", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-mcq-http-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    let llmCalls = 0;
    const mockFetch: typeof fetch = async (_url, init) => {
      llmCalls++;
      const bodyStr = String(init?.body ?? "");
      if (bodyStr.includes("blind verifier")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ chosen_id: "opt1", reason: "Uniquely true." }) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("clarifying question on an active 4-choice MCQ")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    message: "Covariance only measures linear co-movement, whereas independence is about the full joint distribution.",
                    substantive_help: true,
                    revealed_answer: false,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("competitive 3- or 4-choice MCQ")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_MCQ_RAW) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ prompt: "Contrast zero covariance and independence." }) } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const app = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", fetchFn: mockFetch }), dataDir: dir });
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (headers: Record<string, string> = {}) => ({ cookie, ...headers });

    // Seed two eligible distinction units that failed once 6 hours ago.
    const store = stores.get(user.id);
    const sixHoursAgo = Date.now() - 6 * 3_600_000;
    const u1 = uuidv7(sixHoursAgo - 2000);
    const u2 = uuidv7(sixHoursAgo - 1000);
    store.append([
      makeEvent(
        "unit.found",
        { unit_id: u1, text: "Zero covariance does not imply independence.", kind: "distinction", topic: "Covariance", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
        { id: uuidv7(sixHoursAgo - 2000), device_id: "server:drill", ts: sixHoursAgo - 2000 },
      ),
      makeEvent(
        "unit.found",
        { unit_id: u2, text: "Uncorrelated Gaussians are independent only when jointly Gaussian.", kind: "distinction", topic: "Gaussians", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
        { id: uuidv7(sixHoursAgo - 1000), device_id: "server:drill", ts: sixHoursAgo - 1000 },
      ),
      makeEvent(
        "unit.probed",
        { unit_id: u1, depth: "recall", slot: "seam", prompt: "Cov=0 => indep?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 0, latency_ms: 10_000, scheduler: "rwkv", predicted_recall: 0.4 },
        { id: uuidv7(sixHoursAgo), device_id: "server:drill", ts: sixHoursAgo },
      ),
      makeEvent(
        "unit.probed",
        { unit_id: u2, depth: "recall", slot: "seam", prompt: "Marginal Gaussian?", answer_message_id: null, grade: "again", corrected_grade: null, hints: 0, latency_ms: 10_000, scheduler: "rwkv", predicted_recall: 0.4 },
        { id: uuidv7(sixHoursAgo + 500), device_id: "server:drill", ts: sixHoursAgo + 500 },
      ),
    ]);

    const sittingId = uuidv7();
    // Gate check: manual=1 and retry=1 always stay on open contrast!
    for (const qs of [
      `unit_id=${u1}&sitting_id=${sittingId}&sitting_size=8&direct_done=2&manual=1`,
      `unit_id=${u1}&sitting_id=${sittingId}&sitting_size=8&direct_done=2&retry=1`,
    ]) {
      const r = await app.request(`/api/drill/next?${qs}`, { headers: authed() });
      const d = (await r.json()) as { rep: { modality: string; mcq?: unknown } };
      expect(d.rep.modality).toBe("contrast");
      expect(d.rep.mcq).toBeUndefined();
    }

    // Eligible request (even in slot 1, direct_done=0!) issues standalone MCQ with opaque IDs and ZERO secret answer fields!
    const mcqRes1 = await app.request(
      `/api/drill/next?unit_id=${u1}&sitting_id=${sittingId}&sitting_size=8&direct_done=0`,
      { headers: authed() },
    );
    expect(mcqRes1.status).toBe(200);
    const mcq1 = (await mcqRes1.json()) as {
      rep: {
        attempt_id: string;
        modality: string;
        prompt: string;
        mcq: { role?: string; choices: { id: string; text: string }[]; correct_id?: unknown; why_wrong?: unknown };
      };
    };
    expect(mcq1.rep.modality).toBe("mcq");
    expect(mcq1.rep.mcq.role).toBe("standalone");
    expect(mcq1.rep.attempt_id).toBeTruthy();
    expect(mcq1.rep.mcq.choices).toHaveLength(4);
    expect(mcq1.rep.mcq.correct_id).toBeUndefined();
    expect(mcq1.rep.mcq.why_wrong).toBeUndefined();

    // Second eligible unit in an 8-slot desktop sitting gets the 2nd standalone slot (budget = 2)!
    const u2Res = await app.request(
      `/api/drill/next?unit_id=${u2}&sitting_id=${sittingId}&sitting_size=8&direct_done=0`,
      { headers: authed() },
    );
    const u2Data = (await u2Res.json()) as { rep: { modality: string; mcq?: { role?: string } } };
    expect(u2Data.rep.modality).toBe("mcq");
    expect(u2Data.rep.mcq?.role).toBe("standalone");

    // A 3rd eligible unit in the same desktop sitting respects the 2-standalone desktop budget and falls back to contrast!
    const u3 = uuidv7(sixHoursAgo - 500);
    store.append([
      makeEvent(
        "unit.found",
        { unit_id: u3, text: "Orthogonality vs uncorrelatedness when means are non-zero.", kind: "concept", topic: "Covariance", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
        { id: uuidv7(sixHoursAgo - 500), device_id: "server:drill", ts: sixHoursAgo - 500 },
      ),
    ]);
    const u3Res = await app.request(
      `/api/drill/next?unit_id=${u3}&sitting_id=${sittingId}&sitting_size=8&direct_done=0`,
      { headers: authed() },
    );
    const u3Data = (await u3Res.json()) as { rep: { modality: string; mcq?: unknown } };
    expect(u3Data.rep.modality).not.toBe("mcq");
    expect(u3Data.rep.mcq).toBeUndefined();

    // Reloading u1 returns the EXACT frozen attempt_id and option order with ZERO extra LLM calls!
    const callsBeforeReload = llmCalls;
    const mcqResReload = await app.request(
      `/api/drill/next?unit_id=${u1}&sitting_id=${sittingId}&sitting_size=8&direct_done=2`,
      { headers: authed() },
    );
    const mcqReload = (await mcqResReload.json()) as typeof mcq1;
    expect(mcqReload.rep.attempt_id).toBe(mcq1.rep.attempt_id);
    expect(mcqReload.rep.mcq.choices).toEqual(mcq1.rep.mcq.choices);
    expect(llmCalls).toBe(callsBeforeReload);

    // Active MCQ shows up in /api/drill/queue active_attempts without leaking correct_id
    const qRes = await app.request("/api/drill/queue", { headers: authed() });
    const qData = (await qRes.json()) as {
      active_attempts: { attempt_id: string; modality?: string; mcq?: { choices: unknown[]; correct_id?: unknown } }[];
    };
    const activeMcq = qData.active_attempts.find((a) => a.attempt_id === mcq1.rep.attempt_id);
    expect(activeMcq?.modality).toBe("mcq");
    expect(activeMcq?.mcq?.choices).toHaveLength(4);
    expect(activeMcq?.mcq?.correct_id).toBeUndefined();

    // Ungraded clarification via /api/drill/followup keeps the MCQ open and marks assisted=true
    const clarifyRes = await app.request("/api/drill/followup", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: mcq1.rep.attempt_id,
        unit_id: u1,
        depth: "recall",
        prompt: mcq1.rep.prompt,
        attempt: "",
        feedback: "",
        turns: [],
        question: "Wait, what's the difference between covariance and independence?",
      }),
    });
    expect(clarifyRes.status).toBe(200);
    const clarifyData = (await clarifyRes.json()) as { ok: boolean; probe_id: string | null; message: string };
    expect(clarifyData.ok).toBe(false);
    expect(clarifyData.probe_id).toBeNull();
    expect(clarifyData.message).toContain("linear");

    // Now pick the right choice -> deterministic grading (ZERO LLM calls!), downgraded to assisted_correct (20m)!
    const correctChoice = mcq1.rep.mcq.choices.find((c) => c.text.includes("uncorrelated"))!;
    const wrongChoice = mcq1.rep.mcq.choices.find((c) => !c.text.includes("uncorrelated"))!;
    const callsBeforeGrade = llmCalls;
    const gradeRes = await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: mcq1.rep.attempt_id,
        unit_id: u1,
        choice_id: correctChoice.id,
        latency_ms: 9500,
      }),
    });
    expect(gradeRes.status).toBe(200);
    expect(llmCalls).toBe(callsBeforeGrade); // 100% deterministic, zero LLM calls!
    const gradeData = (await gradeRes.json()) as {
      ok: boolean;
      grade: string;
      probe_id: string;
      next_in_ms: number;
      mcq_result: { outcome: string; selected_choice_id: string; correct_id: string; explanation: string };
    };
    expect(gradeData.ok).toBe(true);
    expect(gradeData.mcq_result.outcome).toBe("assisted_correct");
    expect(gradeData.mcq_result.correct_id).toBe(correctChoice.id);
    expect(gradeData.next_in_ms).toBeGreaterThanOrEqual(MCQ_SHORT_DELAY_MS - 5_000);
    expect(gradeData.next_in_ms).toBeLessThanOrEqual(MCQ_SHORT_DELAY_MS);

    // Idempotent replay of the exact same choice returns the same probe_id
    const replayRes = await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: mcq1.rep.attempt_id,
        unit_id: u1,
        choice_id: correctChoice.id,
        latency_ms: 9500,
      }),
    });
    expect(replayRes.status).toBe(200);
    const replayData = (await replayRes.json()) as { probe_id: string };
    expect(replayData.probe_id).toBe(gradeData.probe_id);

    // Conflicting choice on the already-settled attempt returns 409!
    const conflictRes = await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: mcq1.rep.attempt_id,
        unit_id: u1,
        choice_id: wrongChoice.id,
        latency_ms: 9500,
      }),
    });
    expect(conflictRes.status).toBe(409);

    // Exactly 1 MCQ probe recorded on top of the 1 prior production probe
    store.catchUp();
    const u1Evidence = Object.values(store.state.evidence).filter((e) => e.unit_id === u1);
    expect(u1Evidence).toHaveLength(2);
    const mcqEv = store.state.evidence[gradeData.probe_id]!;
    expect(mcqEv.modality).toBe("mcq");
    expect(mcqEv.mcq_role).toBe("standalone");
    expect(mcqEv.mcq_outcome).toBe("assisted_correct");
    expect(store.state.units[u1]!.memory_reviews).toBe(1);
  });

  it("supports v2 standalone FSRS credit, explicit IDK, and two-stage preliminary gate pass/miss/resume/anti-spoiler", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-mcq-v2-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    let leakMode = false;
    const mockFetch: typeof fetch = async (_url, init) => {
      const bodyStr = String(init?.body ?? "");
      if (bodyStr.includes("preliminary MCQ gate before a production problem")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    chosen_id: "g1",
                    leaks_production: leakMode,
                    reason: leakMode ? "Leaks max-shift formula" : "Clean prerequisite check",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("PRELIMINARY CHECK")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "For a 3x4 logit matrix, computing row-wise log-sum-exp at row 2 depends on which entries?",
                    expected_crux: "Only the 4 entries in row 2 contribute to row 2's reduction.",
                    choices: [
                      { id: "g1", text: "All 4 entries in row 2 along dim=-1." },
                      { id: "g2", text: "All 3 entries in column 2 along dim=0." },
                      { id: "g3", text: "Every entry across all 3 rows and 4 columns." },
                    ],
                    correct_id: "g1",
                    explanation: "Row-wise reduction aggregates across columns (dim=-1) independently for each row.",
                    why_wrong: {
                      g2: "Reducing along dim=0 mixes different rows instead of normalizing a single row.",
                      g3: "Global reduction collapses the entire matrix into a single scalar.",
                    },
                    worked_step: "For row 2, extract $z_{2,0}, z_{2,1}, z_{2,2}, z_{2,3}$ and reduce along `dim=-1`.",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("blind verifier")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ chosen_id: "opt1", reason: "Unique." }) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("competitive 3- or 4-choice MCQ")) {
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_MCQ_RAW) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Production prompt or production grader
      if (bodyStr.includes("Write ONE concise") || bodyStr.includes("micro-production prompt") || bodyStr.includes("starter")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    prompt: "Implement numerically stable row-wise log-sum-exp in PyTorch.",
                    expected_crux: "Subtract row max with keepdim=True before exp, sum along dim=-1, log, add max back.",
                    starter: "def logsumexp_rows(x):\n    m = x.max(dim=-1, keepdim=True).values\n    return ___",
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ok: true,
                  grade: "good",
                  message: "Clean max-shift implementation.",
                  annotations: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const app = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", fetchFn: mockFetch }), dataDir: dir });
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (headers: Record<string, string> = {}) => ({ cookie, ...headers });

    const store = stores.get(user.id);
    const now = Date.now();
    const uConcept = uuidv7(now - 4000);
    const uCodeLeak = uuidv7(now - 3000);
    store.append([
      makeEvent(
        "unit.found",
        { unit_id: uConcept, text: "Zero covariance does not imply statistical independence.", kind: "concept", topic: "Probability", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
        { id: uuidv7(now - 4000), device_id: "server:drill", ts: now - 4000 },
      ),
      makeEvent(
        "unit.found",
        { unit_id: uCodeLeak, text: "Implement stable row-wise log-softmax in torch using dim=-1 and keepdim=True.", kind: "move", topic: "Numerical", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
        { id: uuidv7(now - 3000), device_id: "server:drill", ts: now - 3000 },
      ),
    ]);

    // 1. Standalone MCQ on a `concept` unit works immediately, and clean correct advances FSRS conservatively!
    const sitting1 = uuidv7();
    const cRes = await app.request(`/api/drill/next?unit_id=${uConcept}&sitting_id=${sitting1}&sitting_size=4`, { headers: authed() });
    const cData = (await cRes.json()) as { rep: { attempt_id: string; modality: string; mcq: { role: string; choices: { id: string; text: string }[] } } };
    expect(cData.rep.modality).toBe("mcq");
    expect(cData.rep.mcq.role).toBe("standalone");
    const cRight = cData.rep.mcq.choices.find((ch) => ch.text.includes("uncorrelated"))!;
    const cGrade = await (
      await app.request("/api/drill/check", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ attempt_id: cData.rep.attempt_id, unit_id: uConcept, choice_id: cRight.id, latency_ms: 4200 }),
      })
    ).json() as { ok: boolean; grade: string; next_in_ms: number; mcq_result: { outcome: string; role: string; next_review_mode: string } };
    expect(cGrade.ok).toBe(true);
    expect(cGrade.grade).toBe("hard");
    expect(cGrade.mcq_result.outcome).toBe("correct");
    expect(cGrade.mcq_result.role).toBe("standalone");
    expect(cGrade.mcq_result.next_review_mode).toBe("any");
    expect(cGrade.next_in_ms).toBeGreaterThanOrEqual(11 * 3_600_000); // real FSRS review interval, not 4h v1 pending check!
    store.catchUp();
    expect(store.state.units[uConcept]!.memory_reviews).toBe(1);
    // Back-to-back MCQ guard: next review on uConcept must require cold production!
    expect(decideMcqRole(store.state.units[uConcept]!, store.state, "recall", "direct", { sittingSize: 8, standaloneUsed: 0, preliminaryUsed: 0 }).role).toBe("none");

    // 2. Anti-spoiler verifier rejects leaking preliminary gate -> falls back cleanly to ordinary production!
    leakMode = true;
    const leakRes = await (
      await app.request(`/api/drill/next?unit_id=${uCodeLeak}&sitting_id=${sitting1}&sitting_size=8`, { headers: authed() })
    ).json() as { rep: { modality: string; mcq?: unknown } };
    expect(leakRes.rep.modality).not.toBe("mcq");
    expect(leakRes.rep.mcq).toBeUndefined();

    // 3. Clean preliminary gate -> Pass Stage 1 -> zero probe emitted yet -> atomic Stage 2 resume -> Stage 2 settle emits 1 probe!
    leakMode = false;
    const uCode = uuidv7(now - 2000);
    store.append([
      makeEvent(
        "unit.found",
        { unit_id: uCode, text: "Implement stable row-wise logsumexp in torch using dim=-1 and keepdim=True.", kind: "move", topic: "Numerical", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
        { id: uuidv7(now - 2000), device_id: "server:drill", ts: now - 2000 },
      ),
    ]);
    const sitting2 = uuidv7();
    const gRes = await (
      await app.request(`/api/drill/next?unit_id=${uCode}&sitting_id=${sitting2}&sitting_size=8`, { headers: authed() })
    ).json() as { rep: { attempt_id: string; modality: string; mcq: { role: string; choices: { id: string; text: string }[] } } };
    expect(gRes.rep.modality).toBe("mcq");
    expect(gRes.rep.mcq.role).toBe("preliminary");
    expect(gRes.rep.mcq.choices).toHaveLength(3);
    const gRight = gRes.rep.mcq.choices.find((ch) => ch.text.includes("row 2"))!;
    const gPass = await (
      await app.request("/api/drill/check", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ attempt_id: gRes.rep.attempt_id, unit_id: uCode, choice_id: gRight.id, latency_ms: 3500 }),
      })
    ).json() as { ok: boolean; gate_passed: boolean; next_stage: { attempt_id: string; prompt: string; gate_summary: { chosen_text: string } } };
    expect(gPass.ok).toBe(true);
    expect(gPass.gate_passed).toBe(true);
    expect(gPass.next_stage.attempt_id).toBe(gRes.rep.attempt_id);
    expect(gPass.next_stage.prompt).toContain("log-sum-exp");
    expect(gPass.next_stage.gate_summary.chosen_text).toContain("row 2");

    // Zero probe events emitted on gate pass (paired rep counts ONCE when Stage 2 finishes!)
    store.catchUp();
    expect(Object.values(store.state.evidence).filter((e) => e.unit_id === uCode)).toHaveLength(0);

    // Reloading or resuming on another device restores Stage 2 directly with collapsed gate_summary!
    const resumeRes = await (
      await app.request(`/api/drill/next?unit_id=${uCode}&sitting_id=${sitting2}&sitting_size=8`, { headers: authed() })
    ).json() as { rep: { attempt_id: string; modality: string; prompt: string; gate_summary?: { chosen_text: string } } };
    expect(resumeRes.rep.attempt_id).toBe(gRes.rep.attempt_id);
    expect(resumeRes.rep.modality).not.toBe("mcq");
    expect(resumeRes.rep.prompt).toContain("log-sum-exp");
    expect(resumeRes.rep.gate_summary?.chosen_text).toContain("row 2");

    // 4. Explicit IDK on a preliminary gate short-circuits cleanly & allows "Try the full problem anyway"!
    const uCode2 = uuidv7(now - 1000);
    store.append([
      makeEvent(
        "unit.found",
        { unit_id: uCode2, text: "Implement stable softmax backward in torch along dim=-1.", kind: "move", topic: "Numerical", rests_on: [], origin: "need", told: false, observe_only: false, message_id: null },
        { id: uuidv7(now - 1000), device_id: "server:drill", ts: now - 1000 },
      ),
    ]);
    const sitting3 = uuidv7();
    const g2Res = await (
      await app.request(`/api/drill/next?unit_id=${uCode2}&sitting_id=${sitting3}&sitting_size=8`, { headers: authed() })
    ).json() as { rep: { attempt_id: string; modality: string; mcq: { role: string } } };
    expect(g2Res.rep.modality).toBe("mcq");
    expect(g2Res.rep.mcq.role).toBe("preliminary");
    const idkRes = await (
      await app.request("/api/drill/check", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ attempt_id: g2Res.rep.attempt_id, unit_id: uCode2, idk: true, latency_ms: 2100 }),
      })
    ).json() as { ok: boolean; grade: string; probe_id: string; mcq_result: { outcome: string; role: string; worked_step: string | null; can_continue_production: boolean } };
    expect(idkRes.ok).toBe(true);
    expect(idkRes.grade).toBe("again");
    expect(idkRes.mcq_result.outcome).toBe("idk");
    expect(idkRes.mcq_result.role).toBe("preliminary");
    expect(idkRes.mcq_result.worked_step).toContain("dim=-1");
    expect(idkRes.mcq_result.can_continue_production).toBe(true);

    // "Try the full problem anyway" spawns a fresh guided Stage 2 attempt without mutating Stage 1's settled attempt!
    const contRes = await (
      await app.request("/api/drill/check", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ attempt_id: g2Res.rep.attempt_id, unit_id: uCode2, continue_to_production: true }),
      })
    ).json() as { ok: boolean; gate_transition: string; attempt_id: string; next_stage: { attempt_id: string; gate_summary: { continued_after_miss: boolean } } };
    expect(contRes.ok).toBe(true);
    expect(contRes.gate_transition).toBe("production");
    expect(contRes.attempt_id).not.toBe(g2Res.rep.attempt_id);
    expect(contRes.next_stage.gate_summary.continued_after_miss).toBe(true);
  });
});
