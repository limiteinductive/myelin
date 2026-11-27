import { createRoot, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPracticeStore, type PracticeStore } from "../src/practiceStore.js";

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe("PracticeStore (Solid 2.0)", () => {
  const origFetch = globalThis.fetch;
  const origStorage = (globalThis as { localStorage?: Storage }).localStorage;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: makeStorage(), configurable: true });
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origStorage) {
      Object.defineProperty(globalThis, "localStorage", { value: origStorage, configurable: true });
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
    vi.restoreAllMocks();
  });

  it("splits Up next vs Done from RWKV due truth, reconciles row identity, and clears stale verdicts when newly due", async () => {
    let queueCall = 0;
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/frontiers")) {
        return new Response(JSON.stringify({ frontiers: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      queueCall++;
      const items =
        queueCall === 1
          ? [
              { unit_id: "u1", text: "Seed 1", prompt: "Q1?", kind: "move", topic: null, depth: "recall", p_imm: 0.72, reviews: 1, next_in_ms: 0, due: true },
              { unit_id: "u2", text: "Seed 2", prompt: "Q2?", kind: "move", topic: null, depth: "recall", p_imm: 0.92, reviews: 2, next_in_ms: 60_000, due: false },
            ]
          : [
              // u1 was just completed (now due: false); u2's 1m timer hit 0 (now due: true!)
              { unit_id: "u1", text: "Seed 1", prompt: "Q1?", kind: "move", topic: null, depth: "recall", p_imm: 0.91, reviews: 2, next_in_ms: 86_400_000, due: false },
              { unit_id: "u2", text: "Seed 2", prompt: "Q2?", kind: "move", topic: null, depth: "recall", p_imm: 0.81, reviews: 2, next_in_ms: 0, due: true },
            ];
      return new Response(JSON.stringify({ scheduler: "rwkv", total_units: 2, items }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let store!: PracticeStore;
    const dispose = createRoot((d) => {
      store = createPracticeStore("user_a", { autoLoad: false });
      return d;
    });

    try {
      await store.refreshQueue({ selectInitial: true });
      flush();

      expect(store.dueQueue().map((u) => u.unit_id)).toEqual(["u1"]);
      expect(store.doneQueue().map((u) => u.unit_id)).toEqual(["u2"]);
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u1" });
      expect(store.soonestNextMs()).toBe(60_000);

      // Capture u2 proxy identity before reconcile + plant a stale passedVerdict on u2
      const u2RefBefore = store.state.queue[1];
      store.updateUnitSession("u2", (d) => {
        d.passedVerdict = {
          ok: true,
          grade: "again",
          message: "old verdict",
          tier: "system1",
          probe_id: "p1",
          latency_ms: 1000,
          prev_latency_ms: null,
          next_in_ms: 60_000,
          scheduler: "rwkv",
        };
      });
      flush();

      // Mark u1 completed: stays visible in dueQueue until advanceFromUnit, while u2 flips due: true
      store.markUnitCompleted("u1");
      await vi.waitFor(() => {
        flush();
        expect(store.state.queue[1]!.due).toBe(true);
      });

      // Reconcile preserved proxy identity for u2 while updating its live RWKV fields
      expect(store.state.queue[1]).toBe(u2RefBefore);
      // Stale passedVerdict on u2 was automatically cleared when u2 became due again
      expect(store.state.sessions["u2"]).toBeUndefined();
      // Frozen sitting promise: u2 flipping due mid-sitting stays in backlog rather than enlarging this 1-card sitting
      expect(store.dueQueue().map((u) => u.unit_id)).toEqual(["u1"]);
      expect(store.backlogDueCount()).toBe(1);

      // Clicking Next finishes the committed 1-card sitting cleanly onto Done for now; starting next sitting opens u2
      store.advanceFromUnit("u1");
      flush();
      expect(store.dueQueue()).toEqual([]);
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
      store.startNextSitting();
      flush();
      expect(store.dueQueue().map((u) => u.unit_id)).toEqual(["u2"]);
      expect(store.doneQueue().map((u) => u.unit_id)).toEqual(["u1"]);
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u2" });
    } finally {
      dispose();
    }
  });

  it("isolates persisted state by account and rolls back failed frontier deletion", async () => {
    let deleteFails = true;
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/frontiers/") && init?.method === "DELETE") {
        return new Response(JSON.stringify({ error: "server down" }), { status: deleteFails ? 500 : 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ frontiers: [], scheduler: "rwkv", total_units: 0, items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let storeA!: PracticeStore;
    const disposeA = createRoot((d) => {
      storeA = createPracticeStore("user_alpha", { autoLoad: false });
      return d;
    });

    storeA.updateExplore((d) => {
      d.draft = "secret draft for alpha";
    });
    storeA.addFrontier({
      id: "f1",
      title: "Sauron",
      source: "sauron.pdf",
      body: "Plain English briefing",
      skipped_known: [],
      cruxes: [],
      created_at: 1,
    });
    flush();

    // Failed delete rolls back the frontier and surfaces error
    await storeA.removeFrontierById("f1");
    flush();
    expect(storeA.state.frontiers.map((f) => f.id)).toEqual(["f1"]);
    expect(storeA.state.stage).toEqual({ kind: "frontier", frontierId: "f1" });
    expect(storeA.state.error).toContain("server down");

    // Disposal flushes persistence for user_alpha
    disposeA();

    // A different account in the same browser starts completely clean
    let storeB!: PracticeStore;
    const disposeB = createRoot((d) => {
      storeB = createPracticeStore("user_beta", { autoLoad: false });
      return d;
    });
    expect(storeB.state.explore.draft).toBe("");
    disposeB();
  });

  it("migrates an ongoing unfinished attempt from legacy myelin:v2:sessions:v1 storage on upgrade", () => {
    localStorage.setItem(
      "myelin:v2:sessions:v1",
      JSON.stringify({
        units: {
          u_sample: {
            scheduler: "rwkv",
            rep: { unit_id: "u_sample", text: "Sample variance", kind: "distinction", topic: null, depth: "recall", prompt: "Why n-1?", rests_on: [], p_imm: 0.7, reviews: 2, prev_latency_ms: null, first_latency_ms: null },
            beats: [{ user: "sum (xi - mu)^2 = ...", coach: "Could not check that reply just now—try sending again." }],
            postBeats: [],
            draft: "",
            postInput: "",
            citations: [],
            passedVerdict: null,
            overridden: false,
          },
        },
        explore: null,
        removed: [],
      }),
    );
    // Even if the user already booted once onto the new key without migratedLegacy, recover the ongoing attempt!
    localStorage.setItem(
      "myelin:v2:state:user_ben",
      JSON.stringify({ version: 2, stage: { kind: "explore" }, doneOpen: false, sessions: {}, explore: { beats: [], draft: "", citations: [] }, removedUnits: [] }),
    );

    let store!: PracticeStore;
    const dispose = createRoot((d) => {
      store = createPracticeStore("user_ben", { autoLoad: false });
      return d;
    });
    expect(store.state.stage).toEqual({ kind: "unit", unitId: "u_sample" });
    expect(store.state.sessions["u_sample"]?.beats).toHaveLength(1);
    expect(store.state.sessions["u_sample"]?.beats[0]?.user).toContain("sum (xi - mu)^2");
    dispose();
  });

  it("never prunes unfinished sessions beyond the top-100 queue page and hydrates cross-device active_attempts", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.startsWith("/api/frontiers")) {
        return new Response(JSON.stringify({ frontiers: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          scheduler: "rwkv",
          total_units: 120,
          active_ids: ["u1", "u105"],
          active_attempts: [
            {
              attempt_id: "att-cross-1",
              unit_id: "u1",
              depth: "explain",
              prompt: "Why does the cross term vanish?",
              turns: [{ user: "because sum(xi - xbar) = 0", coach: "Keep going — how does that factor out?" }],
              assistance_count: 0,
              active_ms: 12000,
              updated_at: Date.now(),
            },
          ],
          items: [
            { unit_id: "u1", text: "Variance split", prompt: "Why does the cross term vanish?", kind: "move", topic: null, depth: "explain", p_imm: 0.6, reviews: 1, next_in_ms: 0, due: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    let store!: PracticeStore;
    const dispose = createRoot((d) => {
      store = createPracticeStore("user_big", { autoLoad: false });
      return d;
    });

    try {
      // Plant an active local session for u105 (ranked outside top 100 items, but present in active_ids)
      // plus an in-flight pending beat to verify pending beats survive persistence as retryable failed beats.
      store.updateUnitSession("u105", (d) => {
        d.beats.push({ user: "my derivation in progress", coach: "", pending: true, pendingId: "p-1" });
      });
      flush();

      await store.refreshQueue({ selectInitial: true });
      flush();

      // u105 survived queue refresh even though it was outside items[]!
      expect(store.state.sessions["u105"]?.beats).toHaveLength(1);
      // u1 hydrated seamlessly from server active_attempts for cross-device resume!
      expect(store.state.sessions["u1"]?.attemptId).toBe("att-cross-1");
      expect(store.state.sessions["u1"]?.activeMs).toBe(12000);
      expect(store.state.sessions["u1"]?.beats[0]?.user).toContain("sum(xi - xbar)");
    } finally {
      dispose();
    }

    // Re-mounting after reload recovers the interrupted pending beat on u105 as a retryable failed beat
    let reloaded!: PracticeStore;
    const dispose2 = createRoot((d) => {
      reloaded = createPracticeStore("user_big", { autoLoad: false });
      return d;
    });
    expect(reloaded.state.sessions["u105"]?.beats).toHaveLength(1);
    expect(reloaded.state.sessions["u105"]?.beats[0]?.user).toBe("my derivation in progress");
    expect(reloaded.state.sessions["u105"]?.beats[0]?.failed).toBe(true);
    expect(reloaded.state.sessions["u105"]?.beats[0]?.pending).toBeUndefined();
    dispose2();
  });

  it("moves a completed drill to Done immediately on Next, and resets stale passed session if cooldown already elapsed", async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      // Call 1: initial queue (u1 due). Call 2: after pass (u1 not due for 10m). Call 3: later refresh (u1 due again).
      const u1Due = call !== 2;
      return new Response(
        JSON.stringify({
          scheduler: "rwkv",
          total_units: 2,
          items: [
            { unit_id: "u1", text: "Linear attention capacity", prompt: "What limits retrieval?", kind: "mechanism", topic: null, depth: "recall", p_imm: 0.4, reviews: 1, next_in_ms: u1Due ? 0 : 600_000, due: u1Due },
            { unit_id: "u2", text: "Delta rule", prompt: "How does delta rule overwrite?", kind: "mechanism", topic: null, depth: "recall", p_imm: 0.5, reviews: 0, next_in_ms: 0, due: true },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    let store!: PracticeStore;
    const dispose = createRoot((d) => {
      store = createPracticeStore("user_next_done", { autoLoad: false });
      return d;
    });

    try {
      await store.refreshQueue({ selectInitial: true });
      flush();

      // Complete u1 with a 10m re-test interval + post-pass follow-up
      store.updateUnitSession("u1", (s) => {
        s.passedVerdict = {
          ok: true,
          grade: "again",
          message: "Right—at most d_k orthogonal keys.",
          tier: "system2",
          probe_id: "p1",
          latency_ms: 56_000,
          prev_latency_ms: null,
          next_in_ms: 600_000,
          scheduler: "rwkv",
        };
        s.postBeats.push({ user: "follow up?", coach: "here is why" });
      });
      flush();

      // Immediately optimistic before network refresh settles
      store.markUnitCompleted("u1");
      flush();
      expect(store.state.queue.find((u) => u.unit_id === "u1")?.due).toBe(false);

      // Clicking Next moves u1 cleanly into Done and advances to u2
      store.advanceFromUnit("u1");
      flush();
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u2" });
      expect(store.dueQueue().map((u) => u.unit_id)).toEqual(["u2"]);
      expect(store.doneQueue().map((u) => u.unit_id)).toEqual(["u1"]);

      // Now simulate lingering past cooldown until u1 becomes due again while still viewing u1
      store.selectUnit("u1");
      flush();
      await store.refreshQueue({ preserveOrder: true });
      flush();
      expect(store.state.sessions["u1"]?.passedVerdict?.ok).toBe(true); // preserved while viewing
      store.advanceFromUnit("u1");
      flush();
      // Leaving via Next clears stale passed session so u1 opens fresh on re-test
      expect(store.state.sessions["u1"]).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("caps a committed sitting at 8 due cards, prevents mid-sitting boomerang, and lands on sitting-done", async () => {
    const items = Array.from({ length: 11 }, (_, i) => ({
      unit_id: `u${i + 1}`,
      text: `Unit ${i + 1}`,
      prompt: `Q${i + 1}?`,
      kind: "move",
      topic: null,
      depth: "recall" as const,
      p_imm: 0.5,
      reviews: 1,
      next_in_ms: 0,
      due: true,
    }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/frontiers") || url.startsWith("/api/explorations")) {
        return new Response(JSON.stringify({ frontiers: [], explorations: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ scheduler: "rwkv+fsrs85", total_units: items.length, items }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let store!: PracticeStore;
    const dispose = createRoot((d) => {
      store = createPracticeStore("user_sitting", { autoLoad: false });
      return d;
    });

    try {
      await store.refreshQueue({ selectInitial: true });
      flush();

      // Locked at 8 cards in this sitting, 3 waiting in backlog
      expect(store.dueQueue()).toHaveLength(8);
      expect(store.backlogDueCount()).toBe(3);

      // Complete all 8 cards; even though mock server still says due:true, none boomerang back!
      for (let i = 1; i <= 8; i++) {
        store.markUnitCompleted(`u${i}`);
        flush();
        store.advanceFromUnit(`u${i}`);
        flush();
      }
      expect(store.dueQueue()).toHaveLength(0);
      expect(store.sittingDoneCount()).toBe(8);
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
      expect(store.backlogDueCount()).toBe(3);

      // Starting next sitting loads the remaining 3 due cards cleanly
      store.startNextSitting();
      flush();
      expect(store.dueQueue().map((u) => u.unit_id)).toEqual(["u9", "u10", "u11"]);
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u9" });

      // Synthesis rep crediting u9 + companion u10 + u11 clears all 3 cards in one pass!
      store.markUnitCompleted("u9", ["u10", "u11"]);
      flush();
      store.advanceFromUnit("u9");
      flush();
      expect(store.dueQueue()).toHaveLength(0);
      expect(store.sittingDoneCount()).toBe(3);
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
    } finally {
      dispose();
    }
  });

  it("re-queues a missed card once at the tail of the sitting when >=2 other cards remain, and lets syncDueOverride supersede it", async () => {
    const items = ["u1", "u2", "u3", "u4"].map((unit_id, i) => ({
      unit_id,
      text: `Unit ${i + 1}`,
      prompt: `Q${i + 1}?`,
      kind: "move",
      topic: null,
      depth: "recall" as const,
      p_imm: 0.5,
      reviews: 1,
      next_in_ms: 0,
      due: true,
    }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/frontiers") || url.startsWith("/api/explorations")) {
        return new Response(JSON.stringify({ frontiers: [], explorations: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ scheduler: "rwkv+fsrs85", total_units: items.length, items }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let store!: PracticeStore;
    const dispose = createRoot((d) => {
      store = createPracticeStore("user_relearn", { autoLoad: false });
      return d;
    });

    try {
      await store.refreshQueue({ selectInitial: true });
      flush();

      // Miss u1 while u2, u3, u4 remain (>= 2 others): schedules one tail-of-sitting retry.
      store.updateUnitSession("u1", (d) => {
        d.passedVerdict = {
          ok: true,
          grade: "again",
          message: "Answer shown.",
          tier: "system2",
          probe_id: "p1",
          latency_ms: 5000,
          prev_latency_ms: null,
          next_in_ms: 20 * 60_000,
          scheduler: "rwkv+fsrs85",
        };
      });
      store.markUnitCompleted("u1");
      flush();
      expect(store.state.sittingRetryIds["u1"]).toBe(true);
      // Tick positions in sittingIds stay fixed while the work queue sittingOrder moves u1 to the tail!
      expect(store.state.sittingIds).toEqual(["u1", "u2", "u3", "u4"]);
      expect(store.state.sittingOrder).toEqual(["u2", "u3", "u4", "u1"]);
      expect(store.sittingSlots().map((s) => s.status)).toEqual(["retry", "pending", "pending", "pending"]);

      // Advancing from u1 clears its old session so the tail retry loads fresh and moves to u2.
      store.advanceFromUnit("u1");
      flush();
      expect(store.state.sessions["u1"]).toBeUndefined();
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u2" });

      // Miss u2, then explicitly apply a learner timing override via syncDueOverride -> cancels tail retry.
      store.updateUnitSession("u2", (d) => {
        d.passedVerdict = {
          ok: true,
          grade: "again",
          message: "Answer shown.",
          tier: "system2",
          probe_id: "p2",
          latency_ms: 4000,
          prev_latency_ms: null,
          next_in_ms: 20 * 60_000,
          scheduler: "rwkv+fsrs85",
        };
      });
      store.markUnitCompleted("u2");
      flush();
      expect(store.state.sittingRetryIds["u2"]).toBe(true);
      store.syncDueOverride("u2", 4 * 3_600_000);
      flush();
      expect(store.state.sittingRetryIds["u2"]).toBeUndefined();
      expect(store.state.sittingCompletedIds["u2"]).toBe(true);
      expect(store.state.queue.find((u) => u.unit_id === "u2")?.next_in_ms).toBe(4 * 3_600_000);

      // Finish u2 -> u3 -> u4 -> lands on u1 for its single retry.
      store.advanceFromUnit("u2");
      store.markUnitCompleted("u3");
      store.advanceFromUnit("u3");
      store.markUnitCompleted("u4");
      store.advanceFromUnit("u4");
      flush();
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u1" });

      // Missing u1 a SECOND time must NOT re-queue it again (bounded 1 retry per sitting).
      store.updateUnitSession("u1", (d) => {
        d.passedVerdict = {
          ok: true,
          grade: "again",
          message: "Still missed.",
          tier: "system2",
          probe_id: "p3",
          latency_ms: 6000,
          prev_latency_ms: null,
          next_in_ms: 45 * 60_000,
          scheduler: "rwkv+fsrs85",
        };
      });
      store.markUnitCompleted("u1");
      flush();
      expect(store.state.sittingRetryIds["u1"]).toBeUndefined();
      expect(store.state.sittingCompletedIds["u1"]).toBe(true);

      store.advanceFromUnit("u1");
      flush();
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
      expect(store.sittingPracticedCount()).toBe(4);
      expect(store.sittingRescheduledCount()).toBe(0);
    } finally {
      dispose();
    }
  });

  it("freezes a 3-card sitting across discovery, refresh, leave, and reload, and separates practiced vs rescheduled counts", async () => {
    const mk = (i: number, due = true) => ({
      unit_id: `u${i}`,
      text: `Concept ${i}`,
      prompt: `Q${i}?`,
      kind: "move",
      topic: null,
      depth: "recall" as const,
      p_imm: 0.4,
      reviews: 1,
      next_in_ms: due ? 0 : 86_400_000,
      due,
    });
    let discovered = false;
    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.startsWith("/api/frontiers") || url.startsWith("/api/explorations")) {
        return new Response(JSON.stringify({ frontiers: [], explorations: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const items = discovered
        ? Array.from({ length: 13 }, (_, idx) => mk(idx + 1, true))
        : [mk(1, true), mk(2, true), mk(3, true)];
      return new Response(
        JSON.stringify({
          scheduler: "rwkv+fsrs85",
          total_units: items.length,
          total_due: items.length,
          earliest_next_in_ms: null,
          active_ids: items.map((x) => x.unit_id),
          items,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    let store!: PracticeStore;
    let dispose = createRoot((d) => {
      store = createPracticeStore("user_frozen3", { autoLoad: false });
      return d;
    });

    await store.refreshQueue({ selectInitial: true });
    flush();
    expect(store.state.sittingIds).toEqual(["u1", "u2", "u3"]);

    // Discover 10 new due units, refresh, leave to Explore, and reload!
    discovered = true;
    await store.refreshQueue({ preserveOrder: true });
    store.selectExplore();
    flush();
    expect(store.state.sittingIds).toEqual(["u1", "u2", "u3"]);
    expect(seenUrls.some((u) => u.includes("include=u1%2Cu2%2Cu3"))).toBe(true);
    dispose();

    // Re-hydrate from persisted storage: exact same 3 fixed positions remain.
    dispose = createRoot((d) => {
      store = createPracticeStore("user_frozen3", { autoLoad: false });
      return d;
    });
    try {
      await store.refreshQueue({ selectInitial: true });
      flush();
      expect(store.state.sittingIds).toEqual(["u1", "u2", "u3"]);

      // Pass u1 which also credits u2 (in sitting) and u9 (NOT in sitting):
      store.selectUnit("u1");
      store.markUnitCompleted("u1", ["u2", "u9"]);
      flush();
      expect(store.sittingPracticedCount()).toBe(1);
      expect(store.sittingRescheduledCount()).toBe(1);
      expect(store.sittingSlots().map((s) => s.status)).toEqual(["pass", "rescheduled", "pending"]);

      // Finish u3 -> lands on sitting-done and persists across reload!
      store.advanceFromUnit("u1");
      store.markUnitCompleted("u3");
      store.advanceFromUnit("u3");
      flush();
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
      expect(store.sittingPracticedCount()).toBe(2);
      expect(store.sittingRescheduledCount()).toBe(1);
      expect(store.sittingFinished()).toBe(true);
    } finally {
      dispose();
    }

    // Reload while on sitting-done -> stays on sitting-done!
    const dispose2 = createRoot((d) => {
      store = createPracticeStore("user_frozen3", { autoLoad: false });
      return d;
    });
    try {
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
      await store.refreshQueue({ selectInitial: true });
      flush();
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
    } finally {
      dispose2();
    }
  });

  it("mints sittingId, preserves untouched active MCQ attempts, and drops MCQ tail retries if 2-card separation is lost", async () => {
    const mk = (i: number) => ({
      unit_id: `u${i}`,
      text: `Concept ${i}`,
      prompt: `Q${i}?`,
      kind: "distinction",
      topic: null,
      depth: "recall" as const,
      p_imm: 0.4,
      reviews: 1,
      next_in_ms: 0,
      due: true,
    });
    const items = [mk(1), mk(2), mk(3), mk(4), mk(5)];
    let activeAttempts: unknown[] = [
      {
        attempt_id: "att-mcq-1",
        unit_id: "u3",
        depth: "recall",
        prompt: "Which statement holds when Cov(X,Y)=0?",
        modality: "mcq",
        mcq: {
          choices: [
            { id: "c1", text: "Choice 1" },
            { id: "c2", text: "Choice 2" },
            { id: "c3", text: "Choice 3" },
            { id: "c4", text: "Choice 4" },
          ],
        },
        turns: [],
        assistance_count: 0,
        active_ms: null,
        updated_at: Date.now(),
      },
    ];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/frontiers") || url.startsWith("/api/explorations")) {
        return new Response(JSON.stringify({ frontiers: [], explorations: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({
          scheduler: "rwkv+fsrs85",
          total_units: items.length,
          total_due: items.length,
          active_ids: items.map((x) => x.unit_id),
          active_attempts: activeAttempts,
          items,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    let store!: PracticeStore;
    const dispose = createRoot((d) => {
      store = createPracticeStore("user_mcq_store", { autoLoad: false });
      return d;
    });

    try {
      await store.refreshQueue({ selectInitial: true });
      flush();
      const firstSittingId = store.state.sittingId;
      expect(firstSittingId).toBeTruthy();

      // Untouched active MCQ attempt hydrated with 0 turns and frozen choice order!
      expect(store.state.sessions["u3"]?.attemptId).toBe("att-mcq-1");
      expect(store.state.sessions["u3"]?.rep?.modality).toBe("mcq");
      expect(store.state.sessions["u3"]?.rep?.mcq?.choices).toHaveLength(4);

      // Complete 2 direct production cards -> directDone becomes 2
      store.markUnitCompleted("u1");
      store.advanceFromUnit("u1");
      store.markUnitCompleted("u2");
      store.advanceFromUnit("u2");
      flush();
      expect(store.sittingDirectDoneCount()).toBe(2);
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u3" });

      // Miss the MCQ on u3 while u4 and u5 remain (2 other cards left -> tail retry queued with minCompletions=4)
      activeAttempts = [];
      store.updateUnitSession("u3", (d) => {
        d.passedVerdict = {
          ok: true,
          grade: "again",
          message: "Not quite.",
          tier: "system1",
          probe_id: "p-mcq",
          latency_ms: 5000,
          prev_latency_ms: null,
          next_in_ms: 20 * 60_000,
          scheduler: "rwkv+fsrs85",
          mcq_result: {
            outcome: "wrong",
            selected_choice_id: "c2",
            correct_id: "c1",
            explanation: "Zero covariance does not imply independence.",
            why_wrong_selected: "Nonlinear dependence can have zero covariance.",
          },
        };
      });
      store.markUnitCompleted("u3");
      flush();
      expect(store.state.sittingRetryIds["u3"]).toBe(true);
      expect(store.state.sittingRetryMinCompletions["u3"]).toBe(4);
      // MCQ completion itself does NOT increment direct production count
      expect(store.sittingDirectDoneCount()).toBe(2);

      // Advance to u4; suppose u4 also indirectly reschedules u5 -> separation is LOST (only 1 intervening card)!
      store.advanceFromUnit("u3");
      flush();
      expect(store.state.stage).toEqual({ kind: "unit", unitId: "u4" });
      store.markUnitCompleted("u4", ["u5"]);
      flush();
      // u3's tail retry is dropped cleanly to fall back to the 20m timed retry!
      expect(store.state.sittingRetryIds["u3"]).toBeUndefined();
      expect(store.state.sittingCompletedIds["u3"]).toBe(true);
      expect(store.state.sittingOutcomes["u3"]).toBe("missed");
      store.advanceFromUnit("u4");
      flush();
      expect(store.state.stage).toEqual({ kind: "sitting-done" });
    } finally {
      dispose();
    }
  });
});
