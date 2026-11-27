import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgyAcpClient, type AgyTurnTrace } from "../src/agy-acp.js";
import { FastJudge } from "../src/judge.js";

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

  it("routes Drill to gemini-4-hydrogen-low, keeps Explore on gemini-4-neon-low, reuses KV deltas, and skips OpenRouter Jev on agy", async () => {
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
      // Drill check -> gemini-4-hydrogen-low, 0 OpenRouter calls!
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
      expect(chk.message).toContain("model=gemini-4-hydrogen-low");
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
      expect(fu.message).toContain("model=gemini-4-hydrogen-low");
      expect(fu.message).toContain("turn=2");
      // Delta prompt is tiny (<100 chars) instead of re-sending full context!
      const charsMatch = /chars=(\d+)/.exec(fu.message);
      expect(Number(charsMatch?.[1] ?? 9999)).toBeLessThan(100);

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

      // Async sidecar runs on gemini-4-hydrogen-medium
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

      // Tidy works on agy at $0 cost without hitting OpenRouter
      const tidied = await judge.tidyInput("def foo(x):\n ret x");
      expect(fetchCalls).toHaveLength(0);
      expect(tidied.text).toBeTruthy();

      // Foreground promptFor cache miss uses fast gemini-4-hydrogen-low and does not stall
      // behind a background gemini-4-hydrogen-medium prefetch for the same unit!
      const slowBg = judge.promptFor(
        { id: "u-slow", text: "SLOW_TURN unit text", kind: "result" },
        [],
        "recall",
        {},
        true,
      );
      const tFg = Date.now();
      const fgPrompt = await judge.promptFor(
        { id: "u-slow", text: "unit text", kind: "result" },
        [],
        "recall",
        {},
        false,
      );
      // Even when racing against an already-in-flight SLOW_TURN background prefetch on the exact same key:
      const tRace = Date.now();
      const racedPrompt = await judge.promptFor(
        { id: "u-slow", text: "SLOW_TURN unit text", kind: "result" },
        [],
        "recall",
        {},
        false,
      );
      expect(fgPrompt).toContain("model=gemini-4-hydrogen-low");
      expect(Date.now() - tFg).toBeLessThan(250);
      expect(racedPrompt).toContain("model=gemini-4-hydrogen-low");
      expect(Date.now() - tRace).toBeLessThan(250);
      const bgPrompt = await slowBg;
      expect(bgPrompt).toContain("model=gemini-4-hydrogen-medium");
    } finally {
      judge.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
