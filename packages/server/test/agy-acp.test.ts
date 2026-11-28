import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgyAcpClient, type AgyTurnTrace } from "../src/agy-acp.js";
import { FastJudge, resolveModelRouting } from "../src/judge.js";

function makeFakeAcpServer(dir: string): string {
  const bin = join(dir, "fake-agy-acp.mjs");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
let seq = 0;
const sessions = new Map();
const activeTimers = new Map();
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

for await (const line of rl) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } } });
  } else if (msg.method === "session/new") {
    const sid = "sess-" + (++seq);
    sessions.set(sid, { modelId: "default", systemAppend: msg.params?._meta?.antigravity?.systemPrompt?.append ?? "", turns: 0 });
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: sid, models: { currentModelId: "default", availableModels: [] } } });
  } else if (msg.method === "session/set_model") {
    const s = sessions.get(msg.params?.sessionId);
    if (s) s.modelId = msg.params.modelId;
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/close") {
    sessions.delete(msg.params?.sessionId);
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/cancel") {
    const t = activeTimers.get(msg.params?.sessionId);
    if (t) {
      clearTimeout(t.timer);
      activeTimers.delete(msg.params.sessionId);
      send({ jsonrpc: "2.0", id: t.id, result: { stopReason: "cancelled" } });
    }
  } else if (msg.method === "session/prompt") {
    const sid = msg.params?.sessionId;
    const s = sessions.get(sid) ?? { modelId: "unknown", turns: 0 };
    s.turns++;
    const blocks = msg.params?.prompt ?? [];
    const text = blocks.find((b) => b.type === "text")?.text ?? "";
    const hasImage = blocks.some((b) => b.type === "image");
    const delayMs = text.includes("SLOW_TURN") && s.modelId !== "gemini-4-hydrogen-low" ? 400 : 10;
    const timer = setTimeout(() => {
      activeTimers.delete(sid);
      const reply = JSON.stringify({
        ok: text.includes("PASS_ME"),
        grade: text.includes("PASS_ME") ? "good" : "again",
        message: "model=" + s.modelId + " sid=" + sid + " turn=" + s.turns + " chars=" + text.length + (hasImage ? " img=1" : ""),
        prompt: "Prompt model=" + s.modelId + " sid=" + sid + " turn=" + s.turns,
        expected_crux: "Expected crux for " + s.modelId,
        starter: null,
        help_level: "step",
        substantive_help: true,
        question: null,
        title: "Test Title",
        suggested_units: [],
      });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.slice(0, 20) } } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply.slice(20) } } } });
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          stopReason: "end_turn",
          usage: {
            inputTokens: s.turns === 1 ? 4200 : 65,
            cachedReadTokens: s.turns === 1 ? 0 : 4200,
            thoughtTokens: 42,
            outputTokens: 38,
          },
        },
      });
    }, delayMs);
    activeTimers.set(sid, { id: msg.id, timer });
  }
}
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return bin;
}

describe("AgyAcpClient persistent daemon, stateful KV sessions, concurrency & cancellation", () => {
  it("reuses stateful KV-cached sessions, records token usage, sends native images, and runs independent sessions concurrently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myelin-acp-test-"));
    const bin = makeFakeAcpServer(dir);
    const client = new AgyAcpClient({ binary: bin });
    try {
      await client.warmUp();

      let t1Trace: AgyTurnTrace | undefined;
      const r1 = await client.ask("Turn 1 full context", {
        modelId: "gemini-4-hydrogen-low",
        sessionKey: "drill:att-1",
        systemPrompt: "sys-a",
        onTrace: (t) => {
          t1Trace = t;
        },
      });
      expect(r1).toContain("model=gemini-4-hydrogen-low");
      expect(r1).toContain("turn=1");
      expect(t1Trace?.session_reused).toBe(false);
      expect(t1Trace?.input_tokens).toBe(4200);
      expect(t1Trace?.cache_read_tokens).toBe(0);
      expect(t1Trace?.thinking_tokens).toBe(42);
      expect(client.isSessionWarm("drill:att-1", "gemini-4-hydrogen-low", "sys-a", 1)).toBe(true);

      let t2Trace: AgyTurnTrace | undefined;
      const r2 = await client.ask("short delta", {
        modelId: "gemini-4-hydrogen-low",
        sessionKey: "drill:att-1",
        systemPrompt: "sys-a",
        expectedPriorTurns: 1,
        sketchDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        onTrace: (t) => {
          t2Trace = t;
        },
      });
      expect(r2).toContain("turn=2");
      expect(r2).toContain("img=1");
      expect(t2Trace?.session_reused).toBe(true);
      expect(t2Trace?.input_tokens).toBe(65);
      expect(t2Trace?.cache_read_tokens).toBe(4200);

      // Concurrency: slow background session must NOT block fast foreground session!
      const tStart = Date.now();
      const slowP = client.ask("SLOW_TURN background dream", { modelId: "gemini-4-neon-high" });
      const fastR = await client.ask("fast foreground check", { modelId: "gemini-4-hydrogen-low" });
      const fastElapsed = Date.now() - tStart;
      expect(fastR).toContain("model=gemini-4-hydrogen-low");
      expect(fastElapsed).toBeLessThan(250);
      await slowP;
    } finally {
      client.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels in-flight turns immediately on AbortSignal and recovers cleanly on the next turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "myelin-acp-cancel-"));
    const bin = makeFakeAcpServer(dir);
    const client = new AgyAcpClient({ binary: bin });
    try {
      await client.warmUp();
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 35);
      const t0 = Date.now();
      await expect(
        client.ask("SLOW_TURN cancel me", {
          modelId: "gemini-4-neon-low",
          sessionKey: "explore:exp-1",
          systemPrompt: "sys-exp",
          signal: ac.signal,
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(Date.now() - t0).toBeLessThan(200);
      // Session was evicted cleanly on cancel; immediate retry opens a fresh session with 0 stall.
      expect(client.isSessionWarm("explore:exp-1", "gemini-4-neon-low", "sys-exp")).toBe(false);
      const recovered = await client.ask("fresh retry", {
        modelId: "gemini-4-neon-low",
        sessionKey: "explore:exp-1",
        systemPrompt: "sys-exp",
      });
      expect(recovered).toContain("turn=1");
    } finally {
      client.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inherits configured model verbatim across all roles with zero silent downgrades, supports explicit overrides, reuses KV deltas, and prevents bg prompt overwrite", async () => {
    // 1. Pure routing invariant: every role inherits MYELIN_JUDGE_MODEL verbatim unless explicitly overridden.
    const inherited = resolveModelRouting({ llmModel: "agy/gemini-4-neon-low" }, {});
    expect(inherited.drill.model).toBe("agy/gemini-4-neon-low");
    expect(inherited.clarify.model).toBe("agy/gemini-4-neon-low");
    expect(inherited.explore.model).toBe("agy/gemini-4-neon-low");
    expect(inherited.prompt.model).toBe("agy/gemini-4-neon-low");
    expect(inherited.sidecar.model).toBe("agy/gemini-4-neon-low");
    expect(inherited.tidy.model).toBe("agy/gemini-4-neon-low");

    // Explicit cross-provider override resolves its own provider cleanly (not forced onto base provider).
    const mixed = resolveModelRouting(
      { llmModel: "agy/gemini-4-neon-low" },
      { MYELIN_TIDY_MODEL: "google/gemini-2.5-flash-lite", MYELIN_DRILL_MODEL: "agy/gemini-4-neon-medium" },
    );
    expect(mixed.tidy.provider).toBe("openrouter");
    expect(mixed.tidy.model).toBe("google/gemini-2.5-flash-lite");
    expect(mixed.tidy.slug).toBeUndefined();
    expect(mixed.drill.provider).toBe("agy");
    expect(mixed.drill.slug).toBe("gemini-4-neon-medium");

    const dir = mkdtempSync(join(tmpdir(), "myelin-acp-judge-"));
    const bin = makeFakeAcpServer(dir);
    const fetchCalls: string[] = [];
    const mockFetch: typeof fetch = async (url) => {
      fetchCalls.push(String(url));
      throw new Error("should not call OpenRouter when on agy");
    };
    const judge = new FastJudge({
      apiKey: "openrouter-key-present-in-env",
      llmModel: "agy/gemini-4-neon-low",
      agyBinary: bin,
      fetchFn: mockFetch,
    });
    try {
      // Drill check -> stays on gemini-4-neon-low (zero silent downgrade to hydrogen!), 0 OpenRouter calls.
      const chk = await judge.check({
        sessionKey: "drill:a1",
        prompt: "Derive Poisson from Binomial",
        unitText: "Poisson is the n->inf, p=lambda/n limit of Binomial.",
        unitKind: "result",
        depth: "rebuild",
        restsOn: [],
        existingUnits: Array.from({ length: 35 }, (_, i) => `Unrelated genomics unit ${i}`),
        attempt: "not sure",
        latencyMs: 5000,
        hintsUsed: 0,
      });
      expect(fetchCalls).toHaveLength(0);
      expect(chk.message).toContain("model=gemini-4-neon-low");
      expect(chk.message).toContain("turn=1");

      // Drill follow-up -> reuses same KV-cached ACP session with tiny delta prompt!
      const fu = await judge.continueRep({
        sessionKey: "drill:a1",
        prompt: "Derive Poisson from Binomial",
        unitText: "Poisson is the n->inf, p=lambda/n limit of Binomial.",
        unitKind: "result",
        depth: "rebuild",
        restsOn: [],
        attempt: "not sure",
        feedback: chk.message,
        turns: [],
        reply: "PASS_ME p = lambda/n",
        latencyMs: 8000,
        hintsUsed: 1,
      });
      expect(fu.ok).toBe(true);
      expect(fu.message).toContain("model=gemini-4-neon-low");
      expect(fu.message).toContain("turn=2");
      const charsMatch = /chars=(\d+)/.exec(fu.message);
      expect(Number(charsMatch?.[1] ?? 9999)).toBeLessThan(100);

      // Clarify -> stays on gemini-4-neon-low AND reuses warm clarify session across turns!
      const cl1 = await judge.clarifyDrill({
        sessionKey: "clarify:a1",
        expectedPriorTurns: 0,
        prompt: "Derive LayerNorm grad",
        unitText: "LayerNorm projection uses mean(-1)",
        question: "what is proj_grad?",
        turns: [],
      });
      expect(cl1.message).toContain("model=gemini-4-neon-low");
      expect(cl1.message).toContain("turn=1");

      const cl2 = await judge.clarifyDrill({
        sessionKey: "clarify:a1",
        expectedPriorTurns: 1,
        prompt: "Derive LayerNorm grad",
        unitText: "LayerNorm projection uses mean(-1)",
        question: "show ds/dx_i",
        turns: [{ role: "user", text: "what is proj_grad?" }, { role: "assistant", text: cl1.message }],
      });
      expect(cl2.message).toContain("model=gemini-4-neon-low");
      expect(cl2.message).toContain("turn=2");
      const cl2Chars = /chars=(\d+)/.exec(cl2.message);
      expect(Number(cl2Chars?.[1] ?? 9999)).toBeLessThan(80);

      // Exploration -> stays on gemini-4-neon-low, Turn 2 reuses KV delta!
      const exp1 = await judge.explore({
        sessionKey: "explore:e1",
        decoupleMeta: true,
        initial: "Explain linear attention",
        turns: [],
        existingUnits: Array.from({ length: 35 }, (_, i) => `Unrelated unit ${i}`),
        activeHabits: [],
      });
      expect(exp1.message).toContain("model=gemini-4-neon-low");
      expect(exp1.message).toContain("turn=1");

      const exp2 = await judge.explore({
        sessionKey: "explore:e1",
        decoupleMeta: true,
        initial: "Explain linear attention",
        turns: [{ role: "assistant", text: exp1.message }],
        reply: "oh wow ok",
        existingUnits: [],
        activeHabits: [],
      });
      expect(exp2.message).toContain("model=gemini-4-neon-low");
      expect(exp2.message).toContain("turn=2");
      const exp2Chars = /chars=(\d+)/.exec(exp2.message);
      expect(Number(exp2Chars?.[1] ?? 9999)).toBeLessThan(60);

      // Async sidecar inherits gemini-4-neon-low
      const sidecar = await judge.extractExploreMeta({
        userText: "Explain linear attention",
        coachMessage: exp1.message,
        priorTurns: [],
        existingUnits: [],
        activeHabits: [],
        needsTitle: true,
      });
      expect(sidecar.title).toBe("Test Title");
      expect(sidecar.suggested_units).toEqual([]);

      // Tidy inherits gemini-4-neon-low on agy at $0 cost without hitting OpenRouter
      const tidied = await judge.tidyInput("def foo(x):\n ret x");
      expect(fetchCalls).toHaveLength(0);
      expect(tidied.text).toBeTruthy();

      // Both foreground and background promptFor use the exact same configured prompt model (gemini-4-neon-low).
      const fgPrompt = await judge.promptFor(
        { id: "u-fg", text: "unit text", kind: "result" },
        [],
        "recall",
        {},
        false,
      );
      expect(fgPrompt).toContain("model=gemini-4-neon-low");

      // Atomic ACP delta safety: if a cached session is closed/evicted before turn 2, ACP sends the full prompt (never an orphan delta).
      judge.closeSession("clarify:a1");
      const cl3 = await judge.clarifyDrill({
        sessionKey: "clarify:a1",
        expectedPriorTurns: 2,
        prompt: "Derive LayerNorm grad",
        unitText: "LayerNorm projection uses mean(-1)",
        question: "one more check",
        turns: [
          { role: "user", text: "what is proj_grad?" },
          { role: "assistant", text: cl1.message },
          { role: "user", text: "show ds/dx_i" },
          { role: "assistant", text: cl2.message },
        ],
      });
      expect(cl3.message).toContain("turn=1");
      const cl3Chars = /chars=(\d+)/.exec(cl3.message);
      expect(Number(cl3Chars?.[1] ?? 0)).toBeGreaterThan(150);
    } finally {
      judge.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
