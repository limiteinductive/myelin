import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@myelin/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { FastJudge } from "../src/judge.js";
import { Registry } from "../src/registry.js";
import { Stores } from "../src/stores.js";

describe("v2 drill and map API", () => {
  let dir = "";
  let registry: Registry;
  let stores: Stores;

  afterEach(() => {
    stores?.close();
    registry?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("creates units & thinking moves, serves drill reps, checks via Jev cascade, logs probes, and updates map", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-drill-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    const mockFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("/decisions")) {
        return new Response(
          JSON.stringify({
            model: "typesafe/jev-1.14",
            answers: {
              demonstrated: { type: "noul", noul: 0.95 },
              cot_gap: { type: "noul", noul: 0.1 },
              clarity: { type: "score", score: 0.9 },
              habit_applied: { type: "choice", choice: "h0", confidence: 0.91 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "Explain why X^T X + lambda I is invertible." } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const app = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", fetchFn: mockFetch }) });

    // Sign in
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (headers: Record<string, string> = {}) => ({ cookie, ...headers });

    // Add a Thinking Move (observe_only) and a Knowledge Unit
    const habitRes = await app.request("/api/units", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "Verify on a boundary case", observe_only: true }),
    });
    expect(habitRes.status).toBe(200);

    const unitRes = await app.request("/api/units", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "Left-multiply Av=0 by v^T", kind: "move" }),
    });
    expect(unitRes.status).toBe(200);
    const { unit_id } = (await unitRes.json()) as { unit_id: string };

    // Fetch next drill rep
    const nextRes = await app.request("/api/drill/next", { headers: authed() });
    expect(nextRes.status).toBe(200);
    const nextData = (await nextRes.json()) as { rep: { unit_id: string; depth: string; prompt: string } };
    expect(nextData.rep.unit_id).toBe(unit_id);

    // Queue returns the exact cached prompt so the sidebar matches the active drill 1-to-1
    const queueBefore = (await (await app.request("/api/drill/queue", { headers: authed() })).json()) as {
      items: { unit_id: string; prompt: string | null }[];
    };
    expect(queueBefore.items.find((u) => u.unit_id === unit_id)?.prompt).toBe(nextData.rep.prompt);

    // Submit an attempt -> Jev System 1 fast-pass + auto-log Thinking Move
    const checkRes = await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        unit_id,
        depth: nextData.rep.depth,
        prompt: nextData.rep.prompt,
        attempt: "Assume Av=0, multiply by v^T to get ||Xv||^2 + lambda ||v||^2 = 0 => v=0. Checked boundary lambda -> 0.",
        latency_ms: 11000,
        hints_used: 0,
      }),
    });
    expect(checkRes.status).toBe(200);
    const checkData = (await checkRes.json()) as { ok: boolean; tier: string; probe_id: string; habit_observed: string };
    expect(checkData.ok).toBe(true);
    expect(checkData.tier).toBe("system1");
    expect(checkData.probe_id).toBeTruthy();
    expect(checkData.habit_observed).toBe("Verify on a boundary case");

    // Override ("That was lucky")
    const overRes = await app.request("/api/drill/override", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ unit_id, probe_id: checkData.probe_id, grade: "again" }),
    });
    expect(overRes.status).toBe(200);

    // Map reflects both the unit (with review count) and the Thinking Move (present: 1)
    const mapRes = await app.request("/api/map", { headers: authed() });
    expect(mapRes.status).toBe(200);
    const mapData = (await mapRes.json()) as { units: { id: string; reviews: number }[]; habits: { text: string; present: number }[] };
    expect(mapData.units.find((u) => u.id === unit_id)?.reviews).toBe(1);
    expect(mapData.habits.find((h) => h.text === "Verify on a boundary case")?.present).toBe(1);

    // Removing a unit retires it and hides it from queue & map
    const rmRes = await app.request(`/api/units/${encodeURIComponent(unit_id)}/remove`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(rmRes.status).toBe(200);

    const queueAfter = (await (await app.request("/api/drill/queue", { headers: authed() })).json()) as { items: { unit_id: string }[] };
    expect(queueAfter.items.some((u) => u.unit_id === unit_id)).toBe(false);

    const mapAfter = (await (await app.request("/api/map", { headers: authed() })).json()) as { units: { id: string }[] };
    expect(mapAfter.units.some((u) => u.id === unit_id)).toBe(false);
  });

  it("auto-adds missing prerequisites, links rests_on, and ranks weak foundations ahead of compound units", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-dag-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    const mockFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("/decisions")) {
        return new Response(
          JSON.stringify({
            model: "typesafe/jev-1.14",
            answers: {
              demonstrated: { type: "noul", noul: 0.05 },
              cot_gap: { type: "noul", noul: 0.95 },
              clarity: { type: "score", score: 0.1 },
            },
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
                  ok: false,
                  grade: "again",
                  message: "Start tiny: for two numbers 2 and 6, what is their sample mean?",
                  habit_observed: null,
                  missing_prereqs: [{ text: "The sample mean is the average of the observed sample points.", kind: "definition" }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const app = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", fetchFn: mockFetch }) });
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (headers: Record<string, string> = {}) => ({ cookie, ...headers });

    // Create compound unit first (earlier found_at)
    const compRes = await app.request("/api/units", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "Sample variance divides by n - 1.", kind: "distinction" }),
    });
    const { unit_id: compId } = (await compRes.json()) as { unit_id: string };

    // Learner says "i have no ideas" -> drill check does NOT silently mutate the review queue
    const checkRes = await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ unit_id: compId, depth: "recall", prompt: "Why n - 1?", attempt: "i have no ideas" }),
    });
    expect(checkRes.status).toBe(200);
    const checkData = (await checkRes.json()) as { ok: boolean; added_units: { unit_id: string; text: string }[] };
    expect(checkData.ok).toBe(false);
    expect(checkData.added_units).toEqual([]);

    // Adding an explicit prerequisite unit and linking rests_on ranks the weak foundation ahead of the compound unit
    const prereqRes = await app.request("/api/units", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "The sample mean is the average of the observed sample points.", kind: "definition" }),
    });
    const { unit_id: prereqId } = (await prereqRes.json()) as { unit_id: string };
    stores.get(user.id).append([
      {
        id: uuidv7(),
        device_id: "test",
        ts: Date.now() + 50,
        v: 1,
        type: "unit.linked",
        payload: { unit_id: compId, rests_on: [prereqId] },
      },
    ]);

    const mapData = (await (await app.request("/api/map", { headers: authed() })).json()) as {
      units: { id: string; rests_on: string[] }[];
    };
    expect(mapData.units.find((u) => u.id === compId)?.rests_on).toContain(prereqId);

    // DAG-aware queue ranks the weak prerequisite BEFORE the compound unit even though compound was created earlier
    const queueData = (await (await app.request("/api/drill/queue", { headers: authed() })).json()) as {
      items: { unit_id: string }[];
    };
    expect(queueData.items[0]?.unit_id).toBe(prereqId);
    expect(queueData.items[1]?.unit_id).toBe(compId);
  });

  it("preserves grade='again' when a coached multi-turn followup finishes so spaced repetition brings it back soon", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-again-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ok: true,
                  grade: "again",
                  message: "You got it: Cov(X,Y) = E[(X - E[X])(Y - E[Y])].",
                  missing_prereqs: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const app = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", fetchFn: mockFetch }) });
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (headers: Record<string, string> = {}) => ({ cookie, ...headers });

    const uRes = await app.request("/api/units", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "Cov(X,Y) = E[(X - E[X])(Y - E[Y])]", kind: "definition" }),
    });
    const { unit_id } = (await uRes.json()) as { unit_id: string };

    const followRes = await app.request("/api/drill/followup", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        unit_id,
        depth: "recall",
        prompt: "How is Cov(X,Y) defined?",
        attempt: "sum_i (X - E[X])(Y - E[Y])",
        feedback: "A plain sum ignores outcome probabilities—what operator wraps it?",
        turns: [],
        question: "ow i guess E since its a variance",
      }),
    });
    expect(followRes.status).toBe(200);
    const data = (await followRes.json()) as { ok: boolean; grade: string; probe_id: string };
    expect(data.ok).toBe(true);
    expect(data.grade).toBe("again");
    expect(data.probe_id).toBeTruthy();

    // Confirmed stored in the event log as grade="again"
    const store = stores.get(user.id);
    store.catchUp();
    expect(store.state.evidence[data.probe_id]?.grade).toBe("again");
  });

  it("creates an interactive plain-English briefing, answers cited questions & Test me, graduates units, and persists", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-briefing-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    let call = 0;
    const mockFetch: typeof fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Ch. 4: KL & Variational Inference",
                    body: "### The problem\nExact Bayesian posteriors need an intractable normalizing sum.\n\n### The trick\nApproximate $p$ with a simpler family $q$ by maximizing the ELBO, which quietly minimizes $D_{KL}(q \\| p)$.",
                    skipped_known: ["Discrete expectation"],
                    cruxes: [
                      {
                        text: "Maximizing the ELBO minimizes $D_{KL}(q \\| p)$ because $\\log p(x)$ does not depend on $q$.",
                        kind: "result",
                        question: "Why does maximizing the ELBO shrink $D_{KL}(q \\| p)$ without knowing $p(x)$?",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (call === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    message: "The ELBO stands for Evidence Lower Bound—it is a computable floor underneath $\\log p(x)$.",
                    suggested_units: [],
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
                  message: "Exactly—since $\\log p(x)$ is fixed with respect to $q$, pushing the ELBO up squeezes $D_{KL}(q \\| p)$ down.",
                  suggested_units: [
                    {
                      text: "Maximizing the ELBO minimizes $D_{KL}(q \\| p)$ because $\\log p(x)$ is constant with respect to $q$.",
                      kind: "result",
                      observe_only: false,
                    },
                  ],
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

    // Create briefing
    const createRes = await app.request("/api/frontiers", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ request: "Chapter 4 Variational Inference" }),
    });
    expect(createRes.status).toBe(200);
    const { frontier } = (await createRes.json()) as {
      frontier: { id: string; title: string; body: string; cruxes: { text: string; question: string }[] };
    };
    expect(frontier.body).toContain("ELBO");
    expect(frontier.cruxes).toHaveLength(1);

    // Ask a cited clarification -> direct answer, no forced quiz
    const r1 = await app.request(`/api/frontiers/${frontier.id}/respond`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ turns: [], reply: "> ELBO\nWhat does ELBO stand for?" }),
    });
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()) as { message: string; added_units: { unit_id: string }[] };
    expect(d1.message).toContain("Evidence Lower Bound");
    expect(d1.added_units).toHaveLength(0);

    // Click "Test me" / lock in an insight -> auto-adds suggested unit into Map
    const r2 = await app.request(`/api/frontiers/${frontier.id}/respond`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ turns: [], reply: "log p(x) doesn't depend on q", test_me: true }),
    });
    expect(r2.status).toBe(200);
    const d2 = (await r2.json()) as { message: string; added_units: { unit_id: string; text: string }[] };
    expect(d2.added_units).toHaveLength(1);

    const mapData = (await (await app.request("/api/map", { headers: authed() })).json()) as {
      units: { id: string }[];
    };
    expect(mapData.units.some((u) => u.id === d2.added_units[0]!.unit_id)).toBe(true);

    // Delete briefing cleans it up
    const delRes = await app.request(`/api/frontiers/${frontier.id}`, {
      method: "DELETE",
      headers: authed({ "content-type": "application/json" }),
    });
    expect(delRes.status).toBe(200);
    const listAfter = (await (await app.request("/api/frontiers", { headers: authed() })).json()) as { frontiers: unknown[] };
    expect(listAfter.frontiers).toHaveLength(0);
  });

  it("deduplicates passed checks by attempt_id, resumes unfinished attempts in queue, streams SSE deltas, and promotes depth only on passes", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-milestone-ab-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    let checkMode: "fail" | "pass" = "fail";
    const mockFetch: typeof fetch = async (url) => {
      const u = String(url);
      if (u.includes("/decisions")) {
        return new Response(
          JSON.stringify({
            model: "typesafe/jev-1.14",
            answers: {
              demonstrated: { type: "noul", noul: checkMode === "pass" ? 0.95 : 0.2 },
              cot_gap: { type: "noul", noul: checkMode === "pass" ? 0.1 : 0.9 },
              clarity: { type: "score", score: checkMode === "pass" ? 0.9 : 0.3 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  checkMode === "pass"
                    ? { ok: true, grade: "good", message: "Cleanly derived!" }
                    : { ok: false, grade: "again", message: "Check the sign on the cross term." },
                ),
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

    const uRes = await app.request("/api/units", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "Variance bias decomposition", kind: "result" }),
    });
    const { unit_id } = (await uRes.json()) as { unit_id: string };

    // 1. Two "again" misses must NOT promote depth out of "recall"
    for (let i = 0; i < 2; i++) {
      await app.request("/api/drill/miss", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ unit_id, depth: "recall", prompt: "Decompose?", latency_ms: 4000, hints_used: 0 }),
      });
    }
    const qAfterMisses = (await (await app.request("/api/drill/queue", { headers: authed() })).json()) as {
      active_ids: string[];
      items: { unit_id: string; depth: string }[];
    };
    expect(qAfterMisses.active_ids).toContain(unit_id);
    expect(qAfterMisses.items.find((u) => u.unit_id === unit_id)?.depth).toBe("recall");

    // 2. Unfinished attempt persists to SQLite and shows up in active_attempts on /api/drill/queue
    checkMode = "fail";
    const attemptId = "att-resume-1";
    const failRes = await app.request("/api/drill/check?stream=1", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: attemptId,
        unit_id,
        depth: "recall",
        prompt: "Decompose?",
        attempt: "sum (xi - mu)^2",
        latency_ms: 8000,
        hints_used: 0,
      }),
    });
    expect(failRes.status).toBe(200);
    expect(failRes.headers.get("content-type")).toContain("text/event-stream");
    const sseText = await failRes.text();
    expect(sseText).toContain("event: done");
    expect(sseText).toContain("Check the sign on the cross term.");

    const qActive = (await (await app.request("/api/drill/queue", { headers: authed() })).json()) as {
      active_attempts: { attempt_id: string; unit_id: string; turns: { user: string; coach: string }[] }[];
    };
    expect(qActive.active_attempts).toHaveLength(1);
    expect(qActive.active_attempts[0]?.attempt_id).toBe(attemptId);
    expect(qActive.active_attempts[0]?.turns[0]?.user).toBe("sum (xi - mu)^2");

    // 3. Passing via followup completes the attempt, records assistance_count >= 1, and is idempotent on retry
    checkMode = "pass";
    const passRes1 = await app.request("/api/drill/followup", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: attemptId,
        unit_id,
        depth: "recall",
        prompt: "Decompose?",
        attempt: "sum (xi - mu)^2",
        feedback: "Check the sign on the cross term.",
        turns: [],
        question: "cross term vanishes so sum(xi-xbar)^2 + n(xbar-mu)^2",
        latency_ms: 14000,
        hints_used: 1,
      }),
    });
    const pass1 = (await passRes1.json()) as { ok: boolean; probe_id: string };
    expect(pass1.ok).toBe(true);
    expect(pass1.probe_id).toBeTruthy();

    // Retry with the exact same attempt_id returns the cached verdict and does NOT double-record a probe
    const passRes2 = await app.request("/api/drill/followup", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: attemptId,
        unit_id,
        depth: "recall",
        prompt: "Decompose?",
        attempt: "sum (xi - mu)^2",
        feedback: "Check the sign on the cross term.",
        turns: [],
        question: "cross term vanishes so sum(xi-xbar)^2 + n(xbar-mu)^2",
        latency_ms: 14000,
        hints_used: 1,
      }),
    });
    const pass2 = (await passRes2.json()) as { ok: boolean; probe_id: string };
    expect(pass2.probe_id).toBe(pass1.probe_id);

    const store = stores.get(user.id);
    store.catchUp();
    const probesForUnit = Object.values(store.state.evidence).filter((e) => e.unit_id === unit_id);
    // 2 misses + 1 pass (NOT 2 passes!)
    expect(probesForUnit).toHaveLength(3);
    expect(store.state.evidence[pass1.probe_id]?.hints).toBeGreaterThanOrEqual(1);

    // 4. After 1 passed probe, depth promotes to "explain"
    const qAfterPass1 = (await (await app.request("/api/drill/queue", { headers: authed() })).json()) as {
      active_attempts: unknown[];
      items: { unit_id: string; depth: string }[];
    };
    expect(qAfterPass1.active_attempts).toHaveLength(0);
    expect(qAfterPass1.items.find((u) => u.unit_id === unit_id)?.depth).toBe("explain");

    // 5. Second distinct pass promotes depth to "use"
    await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: "att-pass-2",
        unit_id,
        depth: "explain",
        prompt: "Why does it hold?",
        attempt: "Because sum(xi - xbar) = 0",
        latency_ms: 9000,
        hints_used: 0,
      }),
    });
    const qAfterPass2 = (await (await app.request("/api/drill/queue", { headers: authed() })).json()) as {
      items: { unit_id: string; depth: string }[];
    };
    expect(qAfterPass2.items.find((u) => u.unit_id === unit_id)?.depth).toBe("use");
  });

  it("preserves full drill history when promoting a post-verdict follow-up into a saved Exploration", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-promote-history-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: "RoPE & RMSNorm Commutation",
                  message: "Expanding $R_m^\\top \\Gamma^2 R_n$ on a 2D block produces a $(m+n)\\theta$ term.",
                  suggested_units: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const app = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", fetchFn: mockFetch }), dataDir: dir });
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (headers: Record<string, string> = {}) => ({ cookie, ...headers });

    const res = await app.request("/api/drill/explore", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        initial: "Completed practice on: Why does post-RoPE RMSNorm leak position?",
        turns: [
          { role: "user", text: "Show answer." },
          { role: "assistant", text: "Orthogonal RoPE preserves RMS(x) but per-feature gamma fails to commute." },
        ],
        reply: "show me the computation exactly",
        promote_on_unit: true,
        origin_prompt: "Why does post-RoPE RMSNorm leak position?",
        prior_post_turns: [
          { user: "", coach: "Why does post-RoPE RMSNorm leak position?" },
          { user: "Show answer.", coach: "Orthogonal RoPE preserves RMS(x) but per-feature gamma fails to commute." },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exploration?: { id: string; title: string } };
    expect(body.exploration?.id).toBeTruthy();

    const listRes = await app.request("/api/explorations", { headers: authed() });
    const listData = (await listRes.json()) as {
      explorations: { id: string; turns: { user: string; coach: string }[] }[];
    };
    const saved = listData.explorations.find((e) => e.id === body.exploration!.id)!;
    expect(saved.turns).toHaveLength(3);
    expect(saved.turns[0]).toEqual({ user: "", coach: "Why does post-RoPE RMSNorm leak position?" });
    expect(saved.turns[1]).toEqual({
      user: "Show answer.",
      coach: "Orthogonal RoPE preserves RMS(x) but per-feature gamma fails to commute.",
    });
    expect(saved.turns[2]?.user).toBe("show me the computation exactly");
    expect(saved.turns[2]?.coach).toContain("(m+n)");
  });

  it("keeps an open drill ungraded across 5 clarifying questions and defers Explore unit crystallization to settle", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-clarify-crystallize-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    const mockFetch: typeof fetch = async (_url, init) => {
      const bodyStr = String(init?.body ?? "");
      if (bodyStr.includes("answering a clarifying question while a practice prompt is still open")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    message: "Here `grad_gamma` denotes the loss gradient $\\partial L / \\partial \\gamma$.",
                    substantive_help: false,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("thread-level knowledge consolidator")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "LayerNorm backward geometry",
                    suggested_units: [
                      {
                        text: "In LayerNorm backward (with $\\epsilon \\to 0$), shift and scale invariances force $\\nabla_x L$ to project out $\\mathbf{1}$ and $\\hat{x}$ before dividing by $\\sigma$.",
                        kind: "result",
                        observe_only: false,
                        told: true,
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("Generate a crisp 2-5 word title")) {
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ title: "LayerNorm backward geometry" }) } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (bodyStr.includes("focused exploration")) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    message: "LayerNorm pins $\\hat{x}$ to mean $0$ and fixed radius $\\sqrt{D}$ (for $\\epsilon \\to 0$), so radial pushes hit a wall.",
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
                  message: "Clean reduction over the broadcast axes.",
                  ok: true,
                  grade: "good",
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

    const created = (await (
      await app.request("/api/units", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ text: "Broadcasting a tensor in the forward pass sums over broadcast axes in backward", kind: "result" }),
      })
    ).json()) as { unit_id: string };

    const attemptId = "att-clarify-5";
    const questions = [
      "why PyTorch?",
      "what does grad_gamma mean?",
      "is that standard notation?",
      "isnt d_gamma confusing?",
      "whats an adjoint?",
    ];

    const c1 = (await (
      await app.request("/api/drill/check", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          attempt_id: attemptId,
          unit_id: created.unit_id,
          depth: "recall",
          prompt: "Complete grad_gamma for a broadcast scale parameter.",
          attempt: questions[0],
          clarify: true,
          latency_ms: 4000,
          hints_used: 0,
        }),
      })
    ).json()) as { ok: boolean; probe_id: string | null };
    expect(c1.ok).toBe(false);
    expect(c1.probe_id).toBeNull();

    const prior: { role: "user" | "assistant"; text: string }[] = [];
    for (let i = 1; i < questions.length; i++) {
      const ci = (await (
        await app.request("/api/drill/followup", {
          method: "POST",
          headers: authed({ "content-type": "application/json" }),
          body: JSON.stringify({
            attempt_id: attemptId,
            unit_id: created.unit_id,
            depth: "recall",
            prompt: "Complete grad_gamma for a broadcast scale parameter.",
            attempt: questions[0],
            feedback: "Clarified.",
            turns: prior,
            question: questions[i],
            clarify: true,
            latency_ms: 5000,
            hints_used: 0,
          }),
        })
      ).json()) as { ok: boolean; probe_id: string | null };
      expect(ci.ok).toBe(false);
      expect(ci.probe_id).toBeNull();
      prior.push({ role: "user", text: questions[i]! }, { role: "assistant", text: "Clarified." });
    }

    const storedBefore = stores.get(user.id).getAttempt(attemptId);
    expect(storedBefore?.status).toBe("active");
    expect(storedBefore?.assistance_count).toBe(0);

    const graded = (await (
      await app.request("/api/drill/followup", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          attempt_id: attemptId,
          unit_id: created.unit_id,
          depth: "recall",
          prompt: "Complete grad_gamma for a broadcast scale parameter.",
          attempt: questions[0],
          feedback: "Clarified.",
          turns: prior,
          question: "grad_gamma = (grad_y * x_hat).sum((0, 1), keepdim=True)",
          latency_ms: 12000,
          hints_used: 0,
        }),
      })
    ).json()) as { ok: boolean; grade: string; probe_id: string | null };
    expect(graded.ok).toBe(true);
    expect(graded.grade).toBe("good");
    expect(graded.probe_id).toBeTruthy();

    const expRes = (await (
      await app.request("/api/drill/explore", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          mode: "explore",
          initial: "Why do we project out 1 and x_hat in LayerNorm backward?",
          turns: [],
        }),
      })
    ).json()) as { added_units: unknown[]; exploration?: { id: string } };
    expect(expRes.added_units).toEqual([]);
    const expId = expRes.exploration!.id;

    const crys1 = (await (
      await app.request(`/api/explorations/${encodeURIComponent(expId)}/crystallize`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
      })
    ).json()) as { added_units: { text: string }[]; already_up_to_date?: boolean };
    expect(crys1.added_units).toHaveLength(1);
    expect(crys1.added_units[0]?.text).toContain("LayerNorm");

    const crys2 = (await (
      await app.request(`/api/explorations/${encodeURIComponent(expId)}/crystallize`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
      })
    ).json()) as { added_units: { text: string }[]; already_up_to_date?: boolean };
    expect(crys2.added_units).toEqual([]);
    expect(crys2.already_up_to_date).toBe(true);

    // Adding a second turn after already_up_to_date MUST NOT be stuck behind a cached promise!
    const expRes2 = await app.request("/api/drill/explore", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        exploration_id: expId,
        mode: "explore",
        initial: "Why do we project out 1 and x_hat in LayerNorm backward?",
        turns: [{ role: "assistant", text: "LayerNorm pins x_hat." }],
        reply: "And why divide by std at the end?",
      }),
    });
    expect(expRes2.status).toBe(200);
    const crys3 = (await (
      await app.request(`/api/explorations/${encodeURIComponent(expId)}/crystallize`, {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
      })
    ).json()) as { already_up_to_date?: boolean; exploration?: { crystallized_turn_count?: number } };
    expect(crys3.already_up_to_date).toBeUndefined();
    expect(crys3.exploration?.crystallized_turn_count).toBe(2);

    // Provider failure on crystallize returns 502 and does NOT advance crystallized_turn_count
    let failCrystallize = true;
    const failFetch: typeof fetch = async (_url, init) => {
      const bodyStr = String(init?.body ?? "");
      if (bodyStr.includes("thread-level knowledge consolidator") && failCrystallize) {
        return new Response("upstream error", { status: 503 });
      }
      return mockFetch(_url, init);
    };
    const appFail = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", fetchFn: failFetch }), dataDir: dir });
    await appFail.request("/api/drill/explore", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        exploration_id: expId,
        mode: "explore",
        initial: "Why do we project out 1 and x_hat in LayerNorm backward?",
        turns: [],
        reply: "What about eps > 0?",
      }),
    });
    const failedCrys = await appFail.request(`/api/explorations/${encodeURIComponent(expId)}/crystallize`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
    });
    expect(failedCrys.status).toBe(502);
    expect(stores.get(user.id).getExploration(expId)?.crystallized_turn_count).toBe(2);

    failCrystallize = false;
    const retriedCrys = await appFail.request(`/api/explorations/${encodeURIComponent(expId)}/crystallize`, {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
    });
    expect(retriedCrys.status).toBe(200);
    expect(stores.get(user.id).getExploration(expId)?.crystallized_turn_count).toBe(3);

    // Late Ask arriving on an already-passed attempt must never reopen status="active"
    const lateClarify = await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({
        attempt_id: attemptId,
        unit_id: created.unit_id,
        depth: "recall",
        prompt: "Complete grad_gamma for a broadcast scale parameter.",
        attempt: "late question?",
        clarify: true,
        latency_ms: 1000,
        hints_used: 0,
      }),
    });
    expect(lateClarify.status).toBe(200);
    expect(stores.get(user.id).getAttempt(attemptId)?.status).toBe("passed");

    // GET /api/progress returns live session, backlog split, 7-day forecast, mastery, and focus without leaking unit text
    const progUnitRes = await app.request(
      `/api/progress?tz=UTC&unit=${encodeURIComponent(created.unit_id)}`,
      { headers: authed() },
    );
    expect(progUnitRes.status).toBe(200);
    const progUnit = (await progUnitRes.json()) as {
      session: { practiced: number; first_try: number };
      backlog: {
        due: { total: number; new: number; review: number; shaky: number };
        due_later_today: number;
        estimated_minutes: number;
        median_rep_ms: number;
        sittings_left: number;
        cleared_today: number;
        forecast: number[];
        forecast_days: string[];
        forecast_upcoming: number[];
        forecast_upcoming_days: string[];
      };
      balance: {
        status: "practice" | "balanced" | "explore";
        added_7d: number;
        added_24h: number;
        practiced_7d: number;
        passed_7d: number;
        first_try_7d: number;
        active_ms_7d: number;
        activity_7d: { label: string; initial: string; added: number; practiced: number; passed: number }[];
      };
      mastery: {
        total: number;
        solid: number;
        solid_pct: number;
        learning: number;
        new: number;
        at_risk: number;
        depth_counts: { recall: number; rebuild: number; explain: number; use: number };
        topics_total: number;
        topics: { topic: string; units: number; due: number; shaky: number; solid: number; learning: number; new: number; due_later_today: number }[];
      };
      focus: { kind: string; unit_id?: string; reviews?: number; text?: string } | null;
    };
    expect(progUnit.session.practiced).toBe(1);
    expect(progUnit.session.first_try).toBe(1);
    expect(progUnit.backlog.cleared_today).toBe(1);
    expect(progUnit.backlog.forecast).toHaveLength(7);
    expect(progUnit.backlog.forecast_days).toHaveLength(7);
    expect(progUnit.backlog.forecast_upcoming).toHaveLength(6);
    expect(progUnit.backlog.forecast_upcoming_days).toHaveLength(6);
    expect(progUnit.backlog.median_rep_ms).toBeGreaterThanOrEqual(30_000);
    expect(progUnit.backlog.due_later_today).toBeGreaterThanOrEqual(0);
    expect(["practice", "balanced", "explore"]).toContain(progUnit.balance.status);
    expect(progUnit.balance.activity_7d).toHaveLength(7);
    expect(progUnit.balance.practiced_7d).toBe(1);
    expect(progUnit.balance.passed_7d).toBe(1);
    expect(progUnit.balance.added_7d).toBeGreaterThanOrEqual(2);
    expect(progUnit.mastery.total).toBeGreaterThanOrEqual(2);
    expect(progUnit.mastery.solid_pct).toBeGreaterThanOrEqual(0);
    expect(progUnit.mastery.topics_total).toBe(progUnit.mastery.topics.length);
    const depthTotal =
      progUnit.mastery.depth_counts.recall +
      progUnit.mastery.depth_counts.rebuild +
      progUnit.mastery.depth_counts.explain +
      progUnit.mastery.depth_counts.use;
    expect(depthTotal).toBe(progUnit.mastery.total);
    expect(progUnit.focus?.kind).toBe("unit");
    expect(progUnit.focus?.unit_id).toBe(created.unit_id);
    expect(progUnit.focus?.reviews).toBe(1);
    expect("text" in (progUnit.focus ?? {})).toBe(false);

    const progExpRes = await app.request(
      `/api/progress?tz=UTC&exploration=${encodeURIComponent(expId)}`,
      { headers: authed() },
    );
    expect(progExpRes.status).toBe(200);
    const progExp = (await progExpRes.json()) as {
      focus: { kind: string; exploration_id?: string; turns?: number; saved_units?: number; unsaved_turns?: number } | null;
    };
    expect(progExp.focus?.kind).toBe("exploration");
    expect(progExp.focus?.exploration_id).toBe(expId);
    expect(progExp.focus?.turns).toBe(3);
    expect(progExp.focus?.saved_units).toBe(1);
    expect(progExp.focus?.unsaved_turns).toBe(0);
  });

  it("caps heavily coached reconstructions (2+ failed graded attempts) to grade=again with short relearn instead of 2d", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-coached-cap-"));
    registry = new Registry(dir);
    stores = new Stores(dir);
    const user = registry.createUser("ben");
    const link = registry.issueLink(user.id);

    const mockFetch: typeof fetch = async (_url, init) => {
      const bodyStr = String(init?.body ?? "");
      if (bodyStr.includes("FINAL_ECHO_ANSWER")) {
        // Even if the model generously returns grade="hard" when the learner echoes the final formula:
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    ok: true,
                    grade: "hard",
                    message: "Spot on—that's the O(D) RMSNorm backward pass.",
                    annotations: [],
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
                  ok: false,
                  grade: "again",
                  message: "Missing g and wrong sign/power on r.",
                  annotations: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const app = createApp({ registry, stores, judge: new FastJudge({ apiKey: "test-key", enableJev: false, fetchFn: mockFetch }), dataDir: dir });
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: link }),
    });
    const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
    const authed = (headers: Record<string, string> = {}) => ({ cookie, ...headers });

    const { unit_id } = (await (
      await app.request("/api/units", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({ text: "O(D) RMSNorm backward: (g - mean(g * x_hat) * x_hat) / r", kind: "move" }),
      })
    ).json()) as { unit_id: string };

    const attemptId = uuidv7();
    const t1 = (await (
      await app.request("/api/drill/check", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          attempt_id: attemptId,
          unit_id,
          depth: "recall",
          prompt: "Derive RMSNorm backward in O(D).",
          attempt: "1/r + mean(g*x)*x/r",
          latency_ms: 12_000,
          hints_used: 0,
        }),
      })
    ).json()) as { ok: boolean; message: string };
    expect(t1.ok).toBe(false);
    expect(stores.get(user.id).getAttempt(attemptId)?.assistance_count).toBe(1);

    const t2 = (await (
      await app.request("/api/drill/followup", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          attempt_id: attemptId,
          unit_id,
          depth: "recall",
          prompt: "Derive RMSNorm backward in O(D).",
          attempt: "1/r + mean(g*x)*x/r",
          feedback: t1.message,
          turns: [],
          question: "1/r * (1 + mean(g*x_hat)*x)",
          latency_ms: 8_000,
          hints_used: 0,
        }),
      })
    ).json()) as { ok: boolean; message: string };
    expect(t2.ok).toBe(false);
    expect(stores.get(user.id).getAttempt(attemptId)?.assistance_count).toBe(2);

    const t3 = (await (
      await app.request("/api/drill/followup", {
        method: "POST",
        headers: authed({ "content-type": "application/json" }),
        body: JSON.stringify({
          attempt_id: attemptId,
          unit_id,
          depth: "recall",
          prompt: "Derive RMSNorm backward in O(D).",
          attempt: "1/r + mean(g*x)*x/r",
          feedback: t1.message,
          turns: [
            { role: "user", text: "1/r * (1 + mean(g*x_hat)*x)" },
            { role: "assistant", text: t2.message },
          ],
          question: "FINAL_ECHO_ANSWER: 1/r * (g - mean(g * x_hat) * x_hat)",
          latency_ms: 6_000,
          hints_used: 0,
        }),
      })
    ).json()) as { ok: boolean; grade: string; next_in_ms: number; next_depth: string };
    expect(t3.ok).toBe(true);
    expect(t3.grade).toBe("again");
    expect(t3.next_in_ms).toBeLessThanOrEqual(45 * 60_000);
    expect(t3.next_depth).toBe("recall");
  });
});
