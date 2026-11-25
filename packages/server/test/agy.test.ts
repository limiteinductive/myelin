import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeEvent, uuidv7 } from "@myelin/core";
import { Stores } from "../src/stores.js";
import { formatTutorError, Tutor, type Draft } from "../src/tutor/tutor.js";

describe("Antigravity CLI (agy) tutor backend", () => {
  let dir = "";

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("streams text deltas, executes Myelin MCP tools in-process, and records units", async () => {
    dir = mkdtempSync(join(tmpdir(), "myelin-agy-test-"));
    const fakeBin = join(dir, "fake-agy.mjs");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const cfg = JSON.parse(readFileSync(".agents/mcp_config.json", "utf8"));
const server = cfg.mcpServers.myelin;

async function rpc(method, params, id) {
  const res = await fetch(server.serverUrl, {
    method: "POST",
    headers: { "content-type": "application/json", ...server.headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return res.json();
}

const init = await rpc("initialize", { protocolVersion: "2025-03-26" }, 1);
const list = await rpc("tools/list", {}, 2);
if (!init.result?.serverInfo?.name || !list.result?.tools?.some((t) => t.name === "find_unit")) {
  process.stderr.write("MCP tools missing\\n");
  process.exit(1);
}

process.stdout.write(JSON.stringify({ event: "init", conversation_id: "c1", init: { cwd: process.cwd(), tools: ["find_unit"] } }) + "\\n");

const rl = createInterface({ input: process.stdin });
let turn = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  turn++;
  await rpc("tools/call", {
    name: "find_unit",
    arguments: { text: "Linearity of expectation holds even for dependent variables.", kind: "result", origin: "derived" },
  }, 10 + turn);
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Spot " } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "on." } }) + "\\n");
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Spot on.", num_turns: turn } }) + "\\n");
}
`,
      "utf8",
    );
    chmodSync(fakeBin, 0o755);

    const stores = new Stores(dir);
    try {
      const store = stores.get("u_test");
      const tutor = new Tutor("u_test", () => "Ben", store, {
        systemPrompt: "You are Myelin.",
        agentDir: join(dir, "pi"),
        agy: { binary: fakeBin, model: "gemini-4-neon-high" },
      });

      const drafts: Draft[] = [];
      tutor.onDraft((d) => drafts.push(d));

      const ts = Date.now();
      store.append([
        makeEvent(
          "message.added",
          { author: "learner", text: "Help me understand linearity of expectation", cards: [], anchor: null, timing: null },
          { id: uuidv7(ts), device_id: "d1", ts },
        ),
      ]);

      await tutor.idle();
      tutor.close();

      expect(drafts.some((d) => !d.done && d.text === "Spot ")).toBe(true);
      expect(drafts.at(-1)?.done).toBe(true);
      expect(drafts.at(-1)?.text).toBe("Spot on.");
      expect(drafts.at(-1)?.error).toBeUndefined();

      const units = Object.values(store.state.units);
      expect(units).toHaveLength(1);
      expect(units[0]?.text).toContain("Linearity of expectation");
    } finally {
      stores.close();
    }
  });

  it("formats nested provider quota errors cleanly for the UI", () => {
    const raw =
      '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 402,\\n    \\"message\\": \\"Your prepayment credits are depleted.\\",\\n    \\"status\\": \\"RESOURCE_EXHAUSTED\\"\\n  }\\n}\\n","code":402,"status":""}}';
    const msg = formatTutorError(raw);
    expect(msg).toContain("402");
    expect(msg).toContain("prepayment credits are depleted");
  });
});
