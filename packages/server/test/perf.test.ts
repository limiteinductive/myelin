import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatServerTiming, PerfLog, readPerfRecords, summarizePerf, type PerfRecord } from "../src/perf.js";

describe("passive latency observability", () => {
  it("appends and reads JSONL records and formats Server-Timing headers", () => {
    const dir = mkdtempSync(join(tmpdir(), "myelin-perf-test-"));
    try {
      const file = join(dir, "perf.jsonl");
      const log = new PerfLog(file, false);
      const rec: PerfRecord = {
        ts: Date.UTC(2026, 10, 26, 8, 0, 0),
        op: "explore",
        worker: "agy",
        model: "agy/gemini-4-neon-low",
        ok: true,
        cold_spawn: true,
        turn_in_proc: 1,
        queue_wait_ms: 12,
        spawn_ms: 48,
        thinking_ms: 1800,
        ttft_prose_ms: 1950,
        prose_ms: 1200,
        tail_json_ms: 650,
        llm_ms: 3800,
        post_ms: 15,
        total_ms: 3827,
        prompt_chars: 4200,
        output_chars: 640,
        step_types: ["thinking", "agent_response"],
      };
      log.record(rec);
      const loaded = readPerfRecords(file);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toMatchObject({ op: "explore", total_ms: 3827, tail_json_ms: 650 });

      const header = formatServerTiming(rec);
      expect(header).toContain("queue;dur=12");
      expect(header).toContain("think;dur=1800");
      expect(header).toContain("ttft;dur=1950");
      expect(header).toContain("tail;dur=650");
      expect(header).toContain("total;dur=3827");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("summarizes stratified (op, model) p50/p90, KV-reused turns, cache hits, passive quality guardrails, and slowest turns", () => {
    const base = Date.UTC(2026, 10, 26, 8, 0, 0);
    const records: PerfRecord[] = [
      { ts: base, op: "explore", model: "agy/gemini-4-neon-low", worker: "acp", ok: true, cold_spawn: true, turn_in_proc: 1, spawn_ms: 30, init_ms: 2100, thinking_ms: 2100, ttft_prose_ms: 2200, tail_json_ms: 900, total_ms: 5200, prompt_chars: 3000, output_chars: 500, input_tokens: 4200, cache_read_tokens: 0, thinking_tokens: 180 },
      { ts: base + 10_000, op: "explore", model: "agy/gemini-4-neon-low", worker: "acp", ok: true, cold_spawn: false, session_reused: true, turn_in_proc: 2, thinking_ms: 1100, ttft_prose_ms: 1200, tail_json_ms: 400, total_ms: 2600, input_tokens: 80, cache_read_tokens: 4200, thinking_tokens: 90 },
      { ts: base + 20_000, op: "check", model: "agy/gemini-4-hydrogen-low", worker: "acp", ok: true, cold_spawn: false, turn_in_proc: 1, thinking_ms: 850, ttft_prose_ms: 920, tail_json_ms: 120, total_ms: 1350, input_tokens: 1100, cache_read_tokens: 9000, thinking_tokens: 45 },
      { ts: base + 30_000, op: "next", worker: "cache", ok: true, cache_hit: true, total_ms: 4 },
      { ts: base + 40_000, op: "next", worker: "prompt", ok: true, cache_hit: false, total_ms: 3400 },
    ];
    const report = summarizePerf(records, { probes: 10, overrides: 1, units_found: 8, units_undone_5m: 1 });
    expect(report).toContain("Myelin Latency Report (5 foreground, 0 background");
    expect(report).toContain("explore [gemini-4-neon-low]");
    expect(report).toContain("check [gemini-4-hydrogen-low]");
    expect(report).toContain("KV-reused turn");
    expect(report).toContain("Passive quality guardrails:");
    expect(report).toContain("grade overrides 1/10 (10%)");
    expect(report).toContain("5m unit undo 1/8 (13%)");
    expect(report).toContain("Card load (/api/drill/next): 1/2 cache hits (50%)");
    expect(report).toContain("Slowest foreground turns:");
  });
});
