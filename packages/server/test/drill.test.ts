import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    // Learner says "i have no ideas" -> Build gear returns ground-floor question + missing prerequisite
    const checkRes = await app.request("/api/drill/check", {
      method: "POST",
      headers: authed({ "content-type": "application/json" }),
      body: JSON.stringify({ unit_id: compId, depth: "recall", prompt: "Why n - 1?", attempt: "i have no ideas" }),
    });
    expect(checkRes.status).toBe(200);
    const checkData = (await checkRes.json()) as { ok: boolean; added_units: { unit_id: string; text: string }[] };
    expect(checkData.ok).toBe(false);
    expect(checkData.added_units).toHaveLength(1);
    const prereqId = checkData.added_units[0]!.unit_id;

    // Map shows compound unit now rests_on the newly discovered prerequisite
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
});
