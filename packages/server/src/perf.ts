// Passive zero-cost latency observability: appends one compact JSONL trace per live request
// and summarizes p50/p90 waterfalls, token/KV-cache hits, cold-vs-warm turns, and passive quality signals.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type PerfOp =
  | "explore"
  | "check"
  | "follow-up"
  | "next"
  | "tidy"
  | "prompt"
  | "dream"
  | "briefing"
  | "briefing-plan"
  | "audit"
  | "hint"
  | "sidecar";

export type PerfWorker = "agy" | "acp" | "prompt" | "planner" | "sidecar" | "openrouter" | "cache" | "jev";

export interface PerfRecord {
  ts: number;
  op: PerfOp;
  model?: string | undefined;
  worker?: PerfWorker | undefined;
  transport?: "acp" | "stream-json" | "openrouter" | "cache" | "jev" | undefined;
  ok: boolean;
  aborted?: boolean | undefined;
  aborted_at_ms?: number | undefined;
  background?: boolean | undefined;
  cache_hit?: boolean | undefined;
  cold_spawn?: boolean | undefined;
  session_reused?: boolean | undefined;
  turn_in_proc?: number | undefined;
  prompt_chars?: number | undefined;
  output_chars?: number | undefined;
  input_tokens?: number | undefined;
  cache_read_tokens?: number | undefined;
  thinking_tokens?: number | undefined;
  output_tokens?: number | undefined;
  tools_count?: number | undefined;
  queue_wait_ms?: number | undefined;
  spawn_ms?: number | undefined;
  init_ms?: number | undefined;
  jev_ms?: number | undefined;
  jev_pass?: boolean | undefined;
  first_event_ms?: number | undefined;
  thinking_ms?: number | undefined;
  ttft_raw_ms?: number | undefined;
  ttft_prose_ms?: number | undefined;
  prose_ms?: number | undefined;
  tail_json_ms?: number | undefined;
  llm_ms?: number | undefined;
  post_ms?: number | undefined;
  total_ms: number;
  tool_calls?: number | undefined;
  step_types?: string[] | undefined;
  error?: string | undefined;
}

/** Optional $0 organic learner-friction signals derived from existing SQLite events. */
export interface QualitySummary {
  probes: number;
  overrides: number;
  units_found: number;
  units_undone_5m: number;
}

function compactRecord(rec: PerfRecord): PerfRecord {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (v !== undefined) out[k] = v;
  }
  return out as unknown as PerfRecord;
}

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatPerfLine(rec: PerfRecord): string {
  const parts: string[] = [];
  if (rec.model) parts.push(rec.model.replace(/^agy\//, ""));
  if (rec.cache_hit) parts.push("cache=hit");
  if (rec.session_reused) parts.push("kv=reuse");
  if (rec.queue_wait_ms !== undefined && rec.queue_wait_ms > 0) parts.push(`queue=${rec.queue_wait_ms}ms`);
  if (rec.cold_spawn) parts.push(`cold=${rec.init_ms ?? rec.spawn_ms ?? 0}ms`);
  if (rec.jev_ms !== undefined && rec.jev_ms > 0) parts.push(`jev=${rec.jev_ms}ms${rec.jev_pass ? "(pass)" : ""}`);
  if (rec.first_event_ms !== undefined) parts.push(`ev1=${rec.first_event_ms}ms`);
  if (rec.thinking_ms !== undefined && rec.thinking_ms > 0) parts.push(`think=${rec.thinking_ms}ms`);
  if (rec.ttft_prose_ms !== undefined) parts.push(`ttft=${rec.ttft_prose_ms}ms`);
  else if (rec.ttft_raw_ms !== undefined) parts.push(`ttft=${rec.ttft_raw_ms}ms`);
  if (rec.prose_ms !== undefined) parts.push(`prose=${rec.prose_ms}ms`);
  if (rec.tail_json_ms !== undefined && rec.tail_json_ms > 0) parts.push(`tail=${rec.tail_json_ms}ms`);
  if (rec.post_ms !== undefined && rec.post_ms > 0) parts.push(`post=${rec.post_ms}ms`);
  if (rec.input_tokens !== undefined || rec.cache_read_tokens !== undefined) {
    const inp = rec.input_tokens ?? 0;
    const cached = rec.cache_read_tokens ?? 0;
    const thk = rec.thinking_tokens;
    const tokBit = `${fmtTok(inp)}${cached > 0 ? `+${fmtTok(cached)}C` : ""}${thk !== undefined && thk > 0 ? `/thk:${fmtTok(thk)}` : ""}`;
    parts.push(`tok=${tokBit}`);
  }
  if (rec.turn_in_proc !== undefined) parts.push(`turn=${rec.turn_in_proc}`);
  if (rec.tool_calls && rec.tool_calls > 0) parts.push(`tools=${rec.tool_calls}`);
  if (rec.aborted) parts.push(rec.aborted_at_ms !== undefined ? `aborted@${rec.aborted_at_ms}ms` : "aborted");
  if (!rec.ok && rec.error) parts.push(`err=${rec.error.slice(0, 60)}`);
  const meta = parts.length > 0 ? ` (${parts.join(" ")})` : "";
  const bg = rec.background ? "[bg] " : "";
  return `[perf] ${bg}${rec.op} ${rec.total_ms}ms${meta}`;
}

/** Builds a standard HTTP `Server-Timing` header from a completed `PerfRecord`. */
export function formatServerTiming(rec: PerfRecord): string {
  const metrics: string[] = [];
  const add = (name: string, val: number | undefined, desc?: string) => {
    if (val === undefined || !Number.isFinite(val)) return;
    const d = desc ? `;desc="${desc}"` : "";
    metrics.push(`${name};dur=${Math.max(0, Math.round(val))}${d}`);
  };
  add("queue", rec.queue_wait_ms, "Worker queue wait");
  add("init", rec.init_ms ?? rec.spawn_ms, "Worker cold start");
  add("jev", rec.jev_ms, "System 1 gate");
  add("think", rec.thinking_ms, "Reasoning before output");
  add("ttft", rec.ttft_prose_ms ?? rec.ttft_raw_ms, "Time to first prose");
  add("prose", rec.prose_ms, "Prose stream");
  add("tail", rec.tail_json_ms, "Trailing JSON fields");
  add("llm", rec.llm_ms, "Total LLM");
  add("post", rec.post_ms, "Post-LLM server work");
  add("total", rec.total_ms, "Server total");
  return metrics.join(", ");
}

export class PerfLog {
  private dirEnsured = false;

  constructor(
    readonly filePath: string | undefined,
    private readonly consoleLog = process.env.MYELIN_PERF_LOG !== "0",
  ) {}

  record(rec: PerfRecord): void {
    const clean = compactRecord(rec);
    if (this.filePath) {
      try {
        if (!this.dirEnsured) {
          mkdirSync(dirname(this.filePath), { recursive: true });
          this.dirEnsured = true;
        }
        appendFileSync(this.filePath, JSON.stringify(clean) + "\n", "utf8");
      } catch {
        /* never break live requests on log write errors */
      }
    }
    if (this.consoleLog && !clean.background && (clean.total_ms >= 250 || !clean.ok)) {
      console.log(formatPerfLine(clean));
    }
  }
}

export function readPerfRecords(filePath: string, last?: number): PerfRecord[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const slice = last && last > 0 ? lines.slice(-last) : lines;
  const out: PerfRecord[] = [];
  for (const line of slice) {
    try {
      const parsed = JSON.parse(line) as PerfRecord;
      if (parsed && typeof parsed.op === "string" && typeof parsed.total_ms === "number") {
        out.push(parsed);
      }
    } catch {
      /* ignore malformed line */
    }
  }
  return out;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function fmtSec(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function statsFor(vals: number[]): string {
  if (vals.length === 0) return "—";
  const sorted = [...vals].sort((a, b) => a - b);
  return `${fmtSec(percentile(sorted, 50))} / ${fmtSec(percentile(sorted, 90))}`;
}

function median(vals: number[]): number | undefined {
  if (vals.length === 0) return undefined;
  return percentile(
    [...vals].sort((a, b) => a - b),
    50,
  );
}

export function summarizePerf(records: readonly PerfRecord[], quality?: QualitySummary): string {
  if (records.length === 0) {
    return "No latency traces recorded yet. Use Myelin for a few turns and run `myelin perf` again.";
  }

  const fg = records.filter((r) => !r.background);
  const bg = records.filter((r) => r.background);
  const lines: string[] = [];
  const firstTs = new Date(records[0]!.ts).toISOString().slice(0, 19).replace("T", " ");
  const lastTs = new Date(records[records.length - 1]!.ts).toISOString().slice(0, 19).replace("T", " ");
  lines.push(`Myelin Latency Report (${fg.length} foreground, ${bg.length} background · ${firstTs} -> ${lastTs} UTC)`);
  lines.push("");

  // 1. Per-(op, model) p50 / p90 waterfall table (stratified so model & op mixes never distort numbers)
  const byOpModel = new Map<string, { op: PerfOp; model: string; list: PerfRecord[] }>();
  for (const r of fg) {
    const modelLabel = (r.model ?? r.worker ?? "default").replace(/^agy\//, "");
    const key = `${r.op}::${modelLabel}`;
    const entry = byOpModel.get(key) ?? { op: r.op, model: modelLabel, list: [] };
    entry.list.push(r);
    byOpModel.set(key, entry);
  }
  if (byOpModel.size > 0) {
    lines.push("Foreground ops by (op, model) (p50 / p90):");
    for (const { op, model, list } of byOpModel.values()) {
      const totals = list.map((r) => r.total_ms);
      const queues = list.map((r) => r.queue_wait_ms).filter((v): v is number => v !== undefined);
      const thinks = list.map((r) => r.thinking_ms).filter((v): v is number => v !== undefined);
      const ttfts = list.map((r) => r.ttft_prose_ms ?? r.ttft_raw_ms).filter((v): v is number => v !== undefined);
      const tails = list.map((r) => r.tail_json_ms).filter((v): v is number => v !== undefined);
      const errs = list.filter((r) => !r.ok && !r.aborted).length;
      const aborts = list.filter((r) => r.aborted).length;
      const inToks = list.map((r) => r.input_tokens).filter((v): v is number => v !== undefined);
      const cacheToks = list.map((r) => r.cache_read_tokens).filter((v): v is number => v !== undefined);
      const thkToks = list.map((r) => r.thinking_tokens).filter((v): v is number => v !== undefined);
      const tokBit =
        inToks.length > 0
          ? `  tok(p50)=${fmtTok(median(inToks)!)}${cacheToks.length > 0 ? `+${fmtTok(median(cacheToks)!)}C` : ""}${thkToks.length > 0 ? `/thk:${fmtTok(median(thkToks)!)}` : ""}`
          : "";
      const errBit = errs > 0 ? `  err=${errs}` : "";
      const abortBit = aborts > 0 ? `  abort=${aborts}` : "";
      const label = `${op} [${model}]`;
      lines.push(
        `  ${label.padEnd(32)} n=${String(list.length).padEnd(3)} total ${statsFor(totals).padEnd(15)} ttft ${statsFor(ttfts).padEnd(15)} think ${statsFor(thinks).padEnd(15)} tail ${statsFor(tails).padEnd(14)} queue ${statsFor(queues)}${tokBit}${abortBit}${errBit}`,
      );
    }
    lines.push("");
  }

  // 2. Cold vs warm vs KV-reused session turns (stratified on interactive LLM turns)
  const agyFg = fg.filter((r) => (r.worker === "agy" || r.worker === "acp") && r.turn_in_proc !== undefined);
  if (agyFg.length > 0) {
    const turn1 = agyFg.filter((r) => r.cold_spawn || r.turn_in_proc === 1);
    const reused = agyFg.filter((r) => r.session_reused);
    const turnMid = agyFg.filter((r) => !r.cold_spawn && (r.turn_in_proc ?? 0) >= 2 && (r.turn_in_proc ?? 0) <= 4);
    const turnLate = agyFg.filter((r) => !r.cold_spawn && (r.turn_in_proc ?? 0) >= 5);
    const toolsUsed = agyFg.filter((r) => (r.tool_calls ?? 0) > 0).length;
    lines.push("Interactive agy worker by turn/session state (p50 / p90 total · ttft):");
    const fmtBucket = (label: string, arr: PerfRecord[], extra = "") => {
      const t = arr.map((r) => r.total_ms);
      const ttft = arr.map((r) => r.ttft_prose_ms ?? r.ttft_raw_ms).filter((v): v is number => v !== undefined);
      lines.push(`  ${label.padEnd(18)} n=${String(arr.length).padEnd(3)}  total ${statsFor(t).padEnd(15)}  ttft ${statsFor(ttft)}${extra}`);
    };
    if (turn1.length) fmtBucket("turn 1 (cold)", turn1, `  init ${statsFor(turn1.map((r) => r.init_ms ?? r.spawn_ms ?? 0))}`);
    if (reused.length) fmtBucket("KV-reused turn", reused);
    if (turnMid.length) fmtBucket("turns 2–4", turnMid);
    if (turnLate.length) fmtBucket("turns 5–8", turnLate);
    if (toolsUsed > 0) lines.push(`  unexpected tool calls: ${toolsUsed}/${agyFg.length} turns`);
    lines.push("");
  }

  // 3. Prompt cache hit rate on `/api/drill/next`
  const nextOps = fg.filter((r) => r.op === "next");
  if (nextOps.length > 0) {
    const hits = nextOps.filter((r) => r.cache_hit);
    const misses = nextOps.filter((r) => !r.cache_hit);
    const hitPct = Math.round((hits.length / nextOps.length) * 100);
    lines.push(
      `Card load (/api/drill/next): ${hits.length}/${nextOps.length} cache hits (${hitPct}%) · hit p50=${fmtSec(median(hits.map((r) => r.total_ms)))} · miss p50=${fmtSec(median(misses.map((r) => r.total_ms)))}`,
    );
    lines.push("");
  }

  // 4. Passive $0 quality & impatience guardrails
  const llmFg = fg.filter((r) => r.op !== "next");
  const totalAborts = llmFg.filter((r) => r.aborted).length;
  if (llmFg.length > 0 || quality) {
    const qParts: string[] = [];
    if (llmFg.length > 0) {
      qParts.push(`cancel/abort ${totalAborts}/${llmFg.length} (${Math.round((100 * totalAborts) / llmFg.length)}%)`);
    }
    if (quality && quality.probes > 0) {
      qParts.push(`grade overrides ${quality.overrides}/${quality.probes} (${Math.round((100 * quality.overrides) / quality.probes)}%)`);
    }
    if (quality && quality.units_found > 0) {
      qParts.push(`5m unit undo ${quality.units_undone_5m}/${quality.units_found} (${Math.round((100 * quality.units_undone_5m) / quality.units_found)}%)`);
    }
    if (qParts.length > 0) {
      lines.push(`Passive quality guardrails: ${qParts.join(" · ")}`);
      lines.push("");
    }
  }

  // 5. Background summary (if any)
  if (bg.length > 0) {
    const byBg = new Map<PerfOp, PerfRecord[]>();
    for (const r of bg) {
      const arr = byBg.get(r.op) ?? [];
      arr.push(r);
      byBg.set(r.op, arr);
    }
    const bgBits = [...byBg.entries()].map(([op, list]) => `${op} n=${list.length} p50=${fmtSec(median(list.map((r) => r.total_ms)))}`);
    lines.push(`Background ops: ${bgBits.join(" · ")}`);
    lines.push("");
  }

  // 6. Top 5 slowest foreground turns
  const slowest = [...fg].sort((a, b) => b.total_ms - a.total_ms).slice(0, 5);
  if (slowest.length > 0) {
    lines.push("Slowest foreground turns:");
    for (const r of slowest) {
      const when = new Date(r.ts).toISOString().slice(11, 19);
      const chars = r.prompt_chars !== undefined || r.output_chars !== undefined ? `  chars=${r.prompt_chars ?? "?"}->${r.output_chars ?? "?"}` : "";
      const steps = r.step_types && r.step_types.length > 0 ? `  steps=[${r.step_types.join(",")}]` : "";
      lines.push(`  ${when}  ${formatPerfLine(r).replace(/^\[perf\]\s*/, "")}${chars}${steps}`);
    }
  }

  return lines.join("\n");
}
