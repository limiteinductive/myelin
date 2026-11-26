// Domain-agnostic two-tier fast judge for live Micro-Production reps:
//   System 1 (Jev via OpenRouter Decisions API): ~200-700ms calibrated probabilities (demonstrated,
//     cot_gap, clarity, habit_applied). High-confidence clean attempts pass immediately without
//     waiting for prose generation.
//   System 2 (Fast generative LLM via OpenRouter): called on low-confidence attempts, reasoning
//     gaps, sketches/images, or explicit hint requests. Returns 1-2 crisp sentences: either a
//     surgical question pointing at the exact leap/flaw, or a concise confirmation.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Depth, Grade } from "@myelin/core";
import { AgyAcpClient, type AgyAcpAskOptions, type AgyTurnTrace } from "./agy-acp.js";
import { PerfLog, type PerfOp, type PerfRecord, type PerfWorker } from "./perf.js";
import { resolveAgyBinary } from "./tutor/agy.js";

export type { AgyTurnTrace };
export { AgyAcpClient };

export interface JudgeHistoryItem {
  attempt: string;
  feedback: string;
}

export interface JudgeInput {
  /** Optional stable drill attempt ID used as KV-cached ACP session key (`drill:<attemptId>`). */
  sessionKey?: string | undefined;
  prompt: string;
  unitText: string;
  unitKind: string;
  depth: Depth;
  restsOn: string[];
  attempt: string;
  /** Optional base64 data URL (PNG/JPEG) of a hand-drawn sketch or paper photo alongside the shorthand. */
  sketchDataUrl?: string | null | undefined;
  /** Prior failed attempts and feedback on this exact rep so System 2 responds to edits instead of repeating itself. */
  history?: JudgeHistoryItem[] | undefined;
  /** Active personal Thinking Moves (meta-cognitive habits) being trained by this learner. */
  activeHabits?: string[];
  /** Existing active units in the learner's Map (used for server-side dedup, not dumped into drill prompts). */
  existingUnits?: string[];
  /** Lean always-loaded learner memory profile (learner.md) built by offline Dreaming. */
  learnerMemory?: string | null | undefined;
  latencyMs: number | null;
  hintsUsed: number;
}

export interface JevSignals {
  model: string;
  latency_ms: number;
  demonstrated: number;
  cot_gap: number;
  clarity?: number | undefined;
  habit_applied?: string | undefined;
}

export interface InlineAnnotation {
  /** Exact verbatim substring copied from the learner's latest attempt/reply. */
  quote: string;
  /** Short, surgical note anchored beneath that span (max ~22 words). */
  note: string;
  /** "slip" = concrete crack/error; "question" = probe on an unstated step; "move" = good Thinking Move. */
  kind: "slip" | "question" | "move";
}

export interface JudgeResult {
  ok: boolean;
  /** Inferred grade when ok=true, or "again" if fundamentally wrong. */
  grade: Grade;
  /** Crisp single-voice response (<=12 words on pass; 1-2 tight sentences on gap). */
  message: string;
  /** Which tier handled the final response. */
  tier: "system1" | "system2" | "fallback";
  /** True when the judge could not complete the check (transient error / unreachable). */
  failed?: boolean | undefined;
  /** Optional 1-2 grounded inline annotations anchored onto verbatim substrings of the learner's text. */
  annotations?: InlineAnnotation[] | undefined;
  /** Optional Thinking Move observed in the attempt. */
  habit_observed?: string | null | undefined;
  /** Optional missing atomic prerequisite(s) uncovered while building understanding. */
  missing_prereqs?: ExploreUnitSuggestion[] | undefined;
  /** Raw System 1 Jev signals when Jev ran. */
  jev?: JevSignals | undefined;
}

export interface ExploreUnitSuggestion {
  text: string;
  kind: string;
  observe_only: boolean;
  told?: boolean | undefined;
}

export interface ExploreRepFix {
  reworded_unit?: string | null | undefined;
  improved_prompt?: string | null | undefined;
  recommended_grade?: Grade | null | undefined;
}

export interface ExploreResult {
  message: string;
  /** Optional explicit forward-moving question separated visually from the explanation. */
  question?: string | undefined;
  title?: string | undefined;
  suggested_units: ExploreUnitSuggestion[];
  /** Optional 0-based index of a briefing crux demonstrated on this turn. */
  demonstrated_crux_index?: number | null | undefined;
  /** Optional self-healing actions when a post-pass follow-up comments on the drill rep itself. */
  rep_fix?: ExploreRepFix | null | undefined;
  failed?: boolean | undefined;
}

export interface HintResult {
  hint: string;
  rung: number;
}

export interface AuditRepResult {
  analysis: string;
  improved_prompt?: string | null | undefined;
  reworded_unit?: string | null | undefined;
  recommended_grade?: Grade | null | undefined;
  missing_prereqs: ExploreUnitSuggestion[];
}

export interface DreamInput {
  currentMemory: string;
  updatedBy: "dream" | "learner";
  masteredUnits: { text: string; topic?: string | null; p_imm: number; reviews: number }[];
  shakyUnits: { text: string; topic?: string | null; p_imm: number; reviews: number }[];
  recentAttempts: {
    prompt: string;
    unitText: string;
    grade: string | null;
    status: string;
    turns: { user: string; coach: string }[];
  }[];
  recentExplorations: {
    title: string;
    turns: { user: string; coach: string; added?: { text: string }[] }[];
  }[];
  recentOverrides: { unitText: string; grade: string; note: string | null }[];
}

export interface DreamResult {
  memory: string;
  summary: string;
  promoted: string[];
  graduated: string[];
}

export interface PlannedBriefingCrux {
  text: string;
  kind: string;
  question: string;
  source_ref?: string | undefined;
}

export interface PromptContextOptions {
  variant?: number | undefined;
  priorPrompts?: string[] | undefined;
  delayedTransfer?: boolean | undefined;
  learnerMemory?: string | null | undefined;
}

export interface PlannedFrontier {
  title: string;
  body: string;
  skipped_known: string[];
  cruxes: PlannedBriefingCrux[];
}

export interface ExploreSidecarResult {
  title?: string | undefined;
  suggested_units: ExploreUnitSuggestion[];
}

export interface JudgeOptions {
  apiKey?: string | undefined;
  jevModel?: string | undefined;
  llmModel?: string | undefined;
  /** Optional dedicated fast model for Drill check/follow-up/hint/tidy (also via MYELIN_DRILL_MODEL). */
  drillModel?: string | undefined;
  /** Optional dedicated model for Explorations/Briefings (also via MYELIN_EXPLORE_MODEL). */
  exploreModel?: string | undefined;
  /** Reasoning effort for System 2 (e.g. "low" | "medium" | "high"). Default "medium". */
  llmEffort?: string | undefined;
  /** Path to `agy` binary when `llmModel` starts with `agy` (e.g. `agy/gemini-4-neon-low`). */
  agyBinary?: string | undefined;
  /** Transport for `agy`: `"acp"` (default persistent multiplexed daemon) or `"stream-json"`. */
  agyTransport?: "acp" | "stream-json" | undefined;
  /** Explicitly enable/disable OpenRouter Jev gate (defaults to off on `agy`, on for OpenRouter). */
  enableJev?: boolean | undefined;
  /** Optional local directories exposed read-only to the interactive coach (also via MYELIN_RESOURCE_DIRS). */
  resourceDirs?: string[] | undefined;
  /** Optional JSON file path to persist generated prompts across restarts. */
  cachePath?: string | undefined;
  /** Optional passive latency logger (`perf.jsonl`). */
  perf?: PerfLog | undefined;
  /** Minimum Jev P(demonstrated) to auto-pass without System 2. Default 0.88. */
  passThreshold?: number | undefined;
  /** Maximum Jev P(cot_gap) to auto-pass without System 2. Default 0.30. */
  gapCeiling?: number | undefined;
  fetchFn?: typeof fetch | undefined;
}

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_JEV = "typesafe/jev-1.14";
const DEFAULT_LLM = "google/gemini-4-neon";
const DEFAULT_EFFORT = "medium";

function parseResourceDirs(explicit?: string[]): string[] {
  const raw =
    explicit ??
    (process.env.MYELIN_RESOURCE_DIRS ?? "")
      .split(/[:,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const home = homedir();
  const out: string[] = [];
  for (const dir of raw) {
    const expanded = dir === "~" ? home : dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
    if (existsSync(expanded) && !out.includes(expanded)) out.push(expanded);
  }
  return out;
}

/**
 * Repairs LaTeX commands whose single backslash got silently interpreted as a JSON control escape
 * (`\times` -> `<TAB>imes`, `\bar` -> `<BS>ar`, `\frac` -> `<FF>rac`, `\right` -> `<CR>ight`).
 */
export function repairLatexControlChars(s: string): string {
  return s
    .replace(/\t(imes|ext|heta|au|riangle|ilde|op|o\b)/g, "\\t$1")
    .replace(/\x08(ar|eta|egin|ig|inom|oldsymbol|oxed|matrix|mod)/g, "\\b$1")
    .replace(/\x0c(rac|orall|lat)/g, "\\f$1")
    .replace(/\r(ight|ho|angle|m\b|ef)/g, "\\r$1");
}

function repairLatexDeep<T>(value: T): T {
  if (typeof value === "string") return repairLatexControlChars(value) as T;
  if (Array.isArray(value)) return value.map((v) => repairLatexDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = repairLatexDeep(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Parses a JSON object from an LLM response, repairing unescaped LaTeX backslashes
 * (e.g. `\mu`, `\sum`, `\sigma`, `\times`, `\bar{x}`, `\frac`) that break or corrupt `JSON.parse`.
 */
export function parseJudgeJson<T>(raw: string): T | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const candidate = match[0];
  try {
    return repairLatexDeep(JSON.parse(candidate) as T);
  } catch {
    const repaired = candidate.replace(/\\(.)/g, (m, next: string) => {
      if (next === '"' || next === "\\" || next === "/" || next === "n" || next === "r" || next === "t" || next === "u") {
        return m;
      }
      return `\\\\${next}`;
    });
    try {
      return repairLatexDeep(JSON.parse(repaired) as T);
    } catch {
      return null;
    }
  }
}

function safeTempBase(): string {
  const sysTmp = tmpdir();
  if (sysTmp && existsSync(sysTmp)) return sysTmp;
  const fallback = "/tmp";
  if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
  return fallback;
}

/**
 * Extracts the partial `"message": "..."` string AND whether the JSON string value has closed
 * from an in-flight JSON response stream, so callers can stream prose live and measure `tail_json_ms`.
 */
export function extractStreamingJsonMessageState(raw: string): { text: string; closed: boolean } | null {
  const keyMatch = /"message"\s*:\s*"/.exec(raw);
  if (!keyMatch) return null;
  let i = keyMatch.index + keyMatch[0].length;
  let out = "";
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') return { text: out, closed: true };
    if (ch === "\\") {
      if (i + 1 >= raw.length) break; // incomplete escape at chunk boundary
      const next = raw[i + 1]!;
      if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else if (next === "/") out += "/";
      else if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "b") out += "\b";
      else if (next === "f") out += "\f";
      else if (next === "u") {
        if (i + 5 >= raw.length) break;
        const hex = raw.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
      } else {
        out += next;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, closed: false };
}

/**
 * Extracts the partial `"message": "..."` string from an in-flight JSON response stream
 * so the UI can stream coach prose live without ever showing raw JSON or unvalidated grades.
 */
export function extractStreamingJsonMessage(raw: string): string | null {
  return extractStreamingJsonMessageState(raw)?.text ?? null;
}

function trimLearnerMemory(mem: string | null | undefined, maxChars = 1600): string {
  const clean = (mem ?? "").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).trimEnd()}…`;
}

function isAbortError(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { name?: string }).name === "AbortError");
}

function stripAgyPrefix(spec: string): string | undefined {
  if (!spec.startsWith("agy/")) return undefined;
  return spec.slice(4).trim() || undefined;
}

interface WorkerTurn {
  text: string;
  proc: ChildProcessWithoutNullStreams;
  timer: ReturnType<typeof setTimeout>;
  writtenAt: number;
  firstEventAt?: number;
  firstThinkAt?: number;
  firstDeltaAt?: number;
  initMs?: number;
  toolsCount?: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
  outputTokens?: number;
  toolCalls: number;
  stepTypes: Set<string>;
  meta: {
    cold_spawn: boolean;
    spawn_ms: number;
    turn_in_proc: number;
    queue_wait_ms: number;
    prompt_chars: number;
  };
  onDelta?: ((delta: string) => void) | undefined;
  onTrace?: ((trace: AgyTurnTrace) => void) | undefined;
  resolve: (s: string) => void;
  reject: (e: Error) => void;
}

interface SpawnedChild {
  proc: ChildProcessWithoutNullStreams;
  workDir: string;
  spawnedAt: number;
  spawnMs: number;
  initMs?: number;
  toolsCount?: number;
}

/**
 * Warm persistent `agy --input-format stream-json --output-format stream-json` worker for Drill
 * System 2 / hints / prompts using the user's Antigravity CLI subscription.
 *
 * Lifecycle-safe: every process event listener is bound to its specific child instance so rotating
 * after 8 turns never lets an old child's async `close` corrupt a newly spawned child or active turn,
 * pre-spawns a standby child at turn N-1 to hide the 4.5s cold boot, and enforces hard timeouts +
 * AbortSignal cancellation so a silent or cancelled child never wedges the serial queue.
 */
export class AgyJudgeWorker {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private workDir: string | null = null;
  private procInitMs: number | undefined;
  private procToolsCount: number | undefined;
  private standby: SpawnedChild | null = null;
  private turns = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private active: WorkerTurn | null = null;

  constructor(
    private readonly binary: string | undefined,
    private readonly modelSlug: string | undefined,
    private readonly allowLocalResources = false,
    private readonly resourceDirs: string[] = [],
    private readonly turnTimeoutMs = 55_000,
    private readonly maxTurnsPerProc = 8,
    private readonly effort?: string | undefined,
  ) {}

  /** Eagerly spawns a warm `agy` process in the background (0 LLM tokens) so Turn 1 skips cold init. */
  warmUp(): void {
    if (this.proc && !this.proc.killed) return;
    if (this.standby && !this.standby.proc.killed) return;
    try {
      this.standby = this.spawnChild();
    } catch {
      /* ignore eager warmup errors; next ask() will report clearly */
    }
  }

  private retireProc(targetProc: ChildProcessWithoutNullStreams | null, targetDir: string | null): void {
    if (targetProc) {
      if (this.proc === targetProc) this.proc = null;
      try {
        targetProc.stdin.end();
      } catch {
        /* ignore */
      }
      if (!targetProc.killed) {
        try {
          targetProc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
    if (targetDir) {
      if (this.workDir === targetDir) this.workDir = null;
      try {
        rmSync(targetDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private settleActive(turn: WorkerTurn, outcome: { ok: true; value: string } | { ok: false; error: Error }): void {
    if (this.active !== turn) return;
    this.active = null;
    clearTimeout(turn.timer);
    const now = Date.now();
    const firstEventMs = turn.firstEventAt !== undefined ? Math.max(0, turn.firstEventAt - turn.writtenAt) : undefined;
    const ttftRawMs = turn.firstDeltaAt !== undefined ? Math.max(0, turn.firstDeltaAt - turn.writtenAt) : undefined;
    const thinkingMs =
      turn.firstDeltaAt !== undefined
        ? Math.max(0, turn.firstDeltaAt - (turn.firstThinkAt ?? turn.firstEventAt ?? turn.writtenAt))
        : turn.firstThinkAt !== undefined
          ? Math.max(0, now - turn.firstThinkAt)
          : undefined;
    try {
      turn.onTrace?.({
        transport: "stream-json",
        cold_spawn: turn.meta.cold_spawn,
        spawn_ms: turn.meta.spawn_ms,
        init_ms: turn.initMs ?? this.procInitMs,
        turn_in_proc: turn.meta.turn_in_proc,
        queue_wait_ms: turn.meta.queue_wait_ms,
        first_event_ms: firstEventMs,
        thinking_ms: thinkingMs,
        ttft_raw_ms: ttftRawMs,
        llm_ms: Math.max(0, now - turn.writtenAt),
        prompt_chars: turn.meta.prompt_chars,
        output_chars: outcome.ok ? outcome.value.length : turn.text.length,
        input_tokens: turn.inputTokens,
        cache_read_tokens: turn.cacheReadTokens,
        thinking_tokens: turn.thinkingTokens,
        output_tokens: turn.outputTokens,
        tools_count: turn.toolsCount ?? this.procToolsCount,
        tool_calls: turn.toolCalls,
        step_types: Array.from(turn.stepTypes),
      });
    } catch {
      /* ignore trace subscriber errors */
    }
    if (outcome.ok) turn.resolve(outcome.value);
    else turn.reject(outcome.error);
  }

  private spawnChild(): SpawnedChild {
    const tSpawn = Date.now();
    const workDir = mkdtempSync(join(safeTempBase(), "myelin-agy-judge-"));
    const resourceNote = this.allowLocalResources
      ? [
          "Never modify, create, or delete files, and never run mutating or destructive shell commands.",
          "For normal turns, answer directly with ZERO tool calls so responses stay fast.",
          "You MAY use read-only file search/reading (or read_file on an attached sketch image) ONLY when the learner explicitly asks you to find, open, or inspect a local file, paper, note, or codebase on their machine.",
          this.resourceDirs.length > 0
            ? `Preferred local resource directories: ${this.resourceDirs.join(", ")}.`
            : `If the learner asks to find a resource without an exact path, search read-only under their home directory (${homedir()}) starting with common study folders like Documents, Downloads, Desktop, and code workspaces.`,
        ].join(" ")
      : "Do NOT run shell commands, search the filesystem, or modify files. Follow the requested output format strictly.";
    writeFileSync(
      join(workDir, "AGENTS.md"),
      `You are Myelin's fast reasoning coach. Each user message is an independent request—ignore earlier messages in this process unless explicitly listed inside the message. ${resourceNote} Follow the requested output format strictly.\n`,
      "utf8",
    );
    const bin = resolveAgyBinary(this.binary);
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--dangerously-skip-permissions",
    ];
    if (this.modelSlug && this.modelSlug !== "default") args.push("--model", this.modelSlug);
    if (this.effort && (!this.modelSlug || !/-(low|medium|high|xhigh|max)$/.test(this.modelSlug))) {
      args.push("--effort", this.effort);
    }
    if (this.allowLocalResources) {
      for (const dir of this.resourceDirs) args.push("--add-dir", dir);
    }
    const child = spawn(bin, args, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
    const entry: SpawnedChild = { proc: child, workDir, spawnedAt: tSpawn, spawnMs: Date.now() - tSpawn };
    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      childStderr = (childStderr + d).slice(-2000);
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t || !t.startsWith("{")) return;
      let ev: {
        event?: string;
        init?: { tools?: unknown[] };
        step_update?: {
          step_type?: string;
          text_delta?: string;
          usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number };
        };
        result?: {
          status?: string;
          response?: string;
          error?: string;
          usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number };
        };
      };
      try {
        ev = JSON.parse(t);
      } catch {
        return;
      }
      if (ev.event === "init") {
        entry.initMs = Date.now() - entry.spawnedAt;
        if (Array.isArray(ev.init?.tools)) entry.toolsCount = ev.init.tools.length;
        if (this.proc === child) {
          this.procInitMs = entry.initMs;
          this.procToolsCount = entry.toolsCount;
        }
        if (this.active?.proc === child) {
          this.active.initMs = entry.initMs;
          this.active.toolsCount = entry.toolsCount;
        }
        return;
      }
      // Ignore any late output from a retired child.
      if (this.proc !== child) return;
      const cur = this.active;
      if (!cur || cur.proc !== child) return;
      const nowEv = Date.now();
      if (cur.firstEventAt === undefined) cur.firstEventAt = nowEv;
      const u = ev.step_update?.usage ?? ev.result?.usage;
      if (u) {
        if (typeof u.input_tokens === "number") cur.inputTokens = u.input_tokens;
        if (typeof u.cache_read_tokens === "number") cur.cacheReadTokens = u.cache_read_tokens;
        if (typeof u.thinking_tokens === "number") cur.thinkingTokens = u.thinking_tokens;
        if (typeof u.output_tokens === "number") cur.outputTokens = u.output_tokens;
      }
      const st = ev.step_update?.step_type;
      if (st) {
        cur.stepTypes.add(st);
        if (/tool|function|call|command|search|file/i.test(st)) {
          cur.toolCalls++;
        } else if (st !== "agent_response" && cur.firstThinkAt === undefined) {
          cur.firstThinkAt = nowEv;
        }
      }
      if (ev.event === "step_update" && st === "agent_response" && ev.step_update?.text_delta) {
        if (cur.firstDeltaAt === undefined) cur.firstDeltaAt = nowEv;
        cur.text += ev.step_update.text_delta;
        try {
          cur.onDelta?.(ev.step_update.text_delta);
        } catch {
          /* ignore subscriber errors */
        }
      } else if (ev.event === "result" && ev.result) {
        if (ev.result.status && ev.result.status !== "SUCCESS") {
          this.settleActive(cur, { ok: false, error: new Error(ev.result.error || childStderr.trim() || `agy status ${ev.result.status}`) });
        } else {
          this.settleActive(cur, { ok: true, value: (cur.text || ev.result.response || "").trim() });
        }
      }
    });
    child.on("error", (err) => {
      if (this.active?.proc === child) {
        this.settleActive(this.active, { ok: false, error: err });
      }
      if (this.proc === child) this.proc = null;
      if (this.standby?.proc === child) this.standby = null;
    });
    child.on("close", (code) => {
      rl.close();
      if (this.active?.proc === child) {
        this.settleActive(this.active, { ok: false, error: new Error(childStderr.trim() || `agy exited (${code})`) });
      }
      if (this.proc === child) this.proc = null;
      if (this.standby?.proc === child) this.standby = null;
    });
    return entry;
  }

  private ensureProc(): { proc: ChildProcessWithoutNullStreams; workDir: string; coldSpawn: boolean; spawnMs: number } {
    if (this.proc && !this.proc.killed && this.workDir && this.turns < this.maxTurnsPerProc) {
      return { proc: this.proc, workDir: this.workDir, coldSpawn: false, spawnMs: 0 };
    }
    // Retire the old child cleanly without touching any future child's state.
    this.retireProc(this.proc, this.workDir);
    if (this.standby && !this.standby.proc.killed) {
      const next = this.standby;
      this.standby = null;
      this.proc = next.proc;
      this.workDir = next.workDir;
      this.procInitMs = next.initMs;
      this.procToolsCount = next.toolsCount;
      this.turns = 0;
      const prewarmedLongEnough = Date.now() - next.spawnedAt >= 3500;
      return { proc: next.proc, workDir: next.workDir, coldSpawn: !prewarmedLongEnough, spawnMs: prewarmedLongEnough ? 0 : next.spawnMs };
    }
    const fresh = this.spawnChild();
    this.proc = fresh.proc;
    this.workDir = fresh.workDir;
    this.procInitMs = fresh.initMs;
    this.procToolsCount = fresh.toolsCount;
    this.turns = 0;
    return { proc: fresh.proc, workDir: fresh.workDir, coldSpawn: true, spawnMs: fresh.spawnMs };
  }

  ask(
    prompt: string,
    sketchDataUrl?: string | null,
    onDelta?: (delta: string) => void,
    onTrace?: (trace: AgyTurnTrace) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) {
      const err = new Error("Request aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    }
    const enqueuedAt = Date.now();
    const run = async (): Promise<string> => {
      if (signal?.aborted) {
        const err = new Error("Request aborted");
        err.name = "AbortError";
        throw err;
      }
      const queueWaitMs = Math.max(0, Date.now() - enqueuedAt);
      const { proc, workDir, coldSpawn, spawnMs } = this.ensureProc();
      this.turns++;
      const turnInProc = this.turns;
      // Overlap-spawn the replacement worker on the penultimate turn so Turn N+1 never eats a 4.5s cold boot.
      if (this.turns >= this.maxTurnsPerProc - 1 && !this.standby) {
        try {
          this.standby = this.spawnChild();
        } catch {
          /* ignore standby spawn errors */
        }
      }
      let fullPrompt = prompt;
      if (sketchDataUrl) {
        const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(sketchDataUrl);
        if (m) {
          const ext = m[1] === "jpeg" ? "jpg" : "png";
          const file = join(workDir, `sketch-${this.turns}.${ext}`);
          writeFileSync(file, Buffer.from(m[2]!, "base64"));
          fullPrompt += `\n\nThe learner also drew a sketch saved at ${file}. Use read_file on that image before evaluating.`;
        }
      }
      return new Promise<string>((resolve, reject) => {
        const writtenAt = Date.now();
        const turn: WorkerTurn = {
          text: "",
          proc,
          writtenAt,
          initMs: this.procInitMs,
          toolsCount: this.procToolsCount,
          toolCalls: 0,
          stepTypes: new Set<string>(),
          meta: {
            cold_spawn: coldSpawn,
            spawn_ms: spawnMs,
            turn_in_proc: turnInProc,
            queue_wait_ms: queueWaitMs,
            prompt_chars: fullPrompt.length,
          },
          onDelta,
          onTrace,
          resolve,
          reject,
          timer: setTimeout(() => {
            if (this.active !== turn) return;
            this.settleActive(turn, { ok: false, error: new Error(`agy worker timed out after ${this.turnTimeoutMs}ms`) });
            this.retireProc(proc, workDir);
          }, this.turnTimeoutMs),
        };
        const onAbort = () => {
          if (this.active !== turn) return;
          const err = new Error("Request aborted");
          err.name = "AbortError";
          this.settleActive(turn, { ok: false, error: err });
          this.retireProc(proc, workDir);
        };
        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
          const origResolve = turn.resolve;
          const origReject = turn.reject;
          turn.resolve = (s) => {
            signal.removeEventListener("abort", onAbort);
            origResolve(s);
          };
          turn.reject = (e) => {
            signal.removeEventListener("abort", onAbort);
            origReject(e);
          };
        }
        this.active = turn;
        const payload = JSON.stringify({ event: "user", message: { content: fullPrompt } }) + "\n";
        proc.stdin.write(payload, (err) => {
          if (err && this.active === turn) {
            this.settleActive(turn, { ok: false, error: err });
            this.retireProc(proc, workDir);
          }
        });
      });
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  dispose(): void {
    if (this.active) {
      this.settleActive(this.active, { ok: false, error: new Error("disposed") });
    }
    this.retireProc(this.proc, this.workDir);
    if (this.standby) {
      this.retireProc(this.standby.proc, this.standby.workDir);
      this.standby = null;
    }
  }
}

export function inferGrade(latencyMs: number | null, hintsUsed: number, clarity?: number): Grade {
  if (hintsUsed > 0) return "hard";
  if (latencyMs !== null && latencyMs <= 18_000 && (clarity === undefined || clarity >= 0.65)) return "easy";
  if (latencyMs !== null && latencyMs >= 90_000) return "hard";
  return "good";
}

export function isLikelyNonAttempt(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t) return true;
  if (t.endsWith("?")) return true;
  const nonAttemptRe =
    /^(i\s+(have\s+)?no\s+ideas?|no\s+ideas?|i\s+don'?t\s+know|i\s+dont\s+know|idk|dunno|not\s+sure|lost|confused|help|stuck|blank|skip|pass)[\s.!?]*$/;
  if (nonAttemptRe.test(t)) return true;
  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (nonAttemptRe.test(firstLine)) return true;
  return false;
}

const DRILL_COACH_SYSTEM = `You are a sharp, domain-agnostic learning partner inside Myelin (any subject: math, coding, systems, science, languages, writing, etc.).
Your goal is genuine human understanding as fast as possible—NOT exam proctoring. Adapt smoothly between two gears:

1. CHECK GEAR (the learner wrote a real attempt and is close, made a slip, or missed one nuance):
- Accept messy shorthand, typos, unfinished thoughts, and valid alternative routes. Never be pedantic about formatting.
- NEVER pass a circular restatement/tautology, vague hand-waving, or an uncertain guess ending in "?".
- If what they wrote genuinely demonstrates understanding of the unit, pass right away: set ok=true and write a crisp confirmation (at most 10 words, no extra commentary).
- If there is a single crack, slip, or missing justification, set ok=false and point directly at that one crack with ONE short question (max 35 words).

2. BUILD GEAR (the learner says "i have no ideas", "i don't know", seems blank, or shows foundational confusion):
- STOP hinting at the high-level answer! Do NOT give a multi-concept intuition riddle or a 2-part question.
- Drop immediately to the lowest concrete ground-floor building block underneath this unit and ask ONE tiny, 15-second question (e.g. a basic definition/distinction or a tiny concrete 2-element example) so they get fast feedback and climb one atomic rung at a time.
- NEVER Socratic-quiz an arbitrary convention, symbol, or definition they clearly don't know—state it cleanly in 1 short sentence, then ask ONE tiny concrete check using it.

Follow-up & grading rules:
- ALWAYS speak directly in second person ("You..."). Never say "The learner..." or "The attempt...". Stay strictly on-topic—no tangents, no lecturing.
- ONE tiny atom and ONE question per turn (max 40 words). NEVER pack two questions or multiple unfamiliar concepts into one beat.
- NEVER TELEGRAPH THE ANSWER IN YOUR HINT: Never print the missing variable names, symbols, or answer fragment inside the very question asking for them. Point to the role or constraint instead.
- If climbing an atomic staircase (Build gear), move up ONE small rung at a time. The moment the learner lands the final rung of the target unit, finish right away (ok=true, grade="again")—NEVER tack on a forced recap or meta-summary quiz.
- Decouple ok (rep complete) from grade (cold-retrieval memory rating for spaced repetition):
  - On turn 1 clean pass: grade="good"|"easy"|"hard" (if hesitant).
  - On follow-up pass: grade="again" if turn 1 missed the core concept cold or needed Build gear / 2+ nudges; grade="hard" if turn 1 had the core idea and only fixed one minor slip on 1 quick nudge; grade="good" ONLY if turn 1 was purely a clarifying/notation question and they solved the whole unit cleanly.
  - When ok=false, set grade="again".
- annotations: OPTIONAL array of AT MOST 1–2 grounded inline pins anchored onto exact verbatim substrings of the learner's latest text (kind="slip"|"question"|"move", note max 22 words). Leave [] on short 1-line answers, "no idea" replies, or when message alone is already clear.
- missing_prereqs: ONLY when a genuinely missing, reusable atomic prerequisite underneath this unit appears; include at most 1 crisp one-sentence unit, otherwise [].
- Use $...$ for inline math only when needed. No praise fluff, no exclamation marks. Answer directly with ZERO tool calls.
- Return ONLY valid JSON with "message" FIRST so prose can stream cleanly: {"message": string, "ok": boolean, "grade": "again"|"hard"|"good"|"easy", "annotations": [{"quote": string, "note": string, "kind": "slip"|"question"|"move"}], "habit_observed": string|null, "missing_prereqs": [{"text": string, "kind": string}]}`;

const EXPLORE_HOT_SYSTEM = `You are Myelin's sharp, peer-level reasoning partner inside a focused exploration (any domain: math, coding, systems, science, papers, writing).

Role of Explore vs. Drills:
- Explore is for building a real mental model and surfacing gaps so spaced-repetition Drills can verify retention later. Do NOT turn Explore into a tedious mini-drill.
- Speak like a brilliant colleague at a whiteboard—direct, concise, zero robotic filler. NEVER open with "You're correct that...", "You've correctly identified...", "You're on the right track.", or "You're thinking about...". Start straight with the substance.
- SEPARATE EXPLANATION ("message") FROM QUESTION ("question"):
  - Put ONLY your explanation, feedback, math, or code in "message" (2-4 crisp sentences, or a tiny code/math block; use $...$ for inline math with double-escaped backslashes in JSON like \\\\times, \\\\frac; no fluff, no exclamation marks).
  - Put your single forward-moving question (when there is one) in the separate "question" field so the UI displays it distinctly above the learner's composer—NEVER duplicate the question at the end of "message".
  - Set "question": null on quick clarifications/sanity checks, when the learner flagged "[I don't understand this]" quotes and you just unpacked them without needing to re-ask a quiz, or when no question is needed.
- HANDLE "[I don't understand this]" ANNOTATIONS & BATCHED REPLIES FIRST: Address each quoted block and follow-up cleanly in order inside "message". If they skipped your previous question to ask something else, follow their new thread directly—never nag about the skipped question.
- FOLLOW THE LEARNER'S ACTIVE FOCUS: Always prioritize what the learner just asked to understand over earlier topics.
- NEVER QUIZ ON WHAT YOU ALREADY TOLD THEM: Never put "why X?" in "question" if you already gave the reason for X in "message" or an earlier turn. Either withhold the reason before asking, or ask about a genuinely new consequence, concrete case, or next design choice.
- NO VERBATIM QUESTION REPEATS: On a quick clarification or sanity check, answer cleanly in 1-2 sentences with "question": null instead of re-pasting your previous open question.
- ZERO NOTATION OR SYNTAX PEDANTRY: Accept rough shorthand and pseudocode immediately. Only flag mistakes that actually change semantics (wrong axis/shape, missing keepdim, wrong sign, missing factor).
- FIX AND KEEP MOVING (NO MINI-DRILLING): When the learner makes specific slips or says "i have no idea" / "Walk me through this directly", give the clean corrected answer/code directly in 1-3 lines inside "message", and put the next forward step in "question". NEVER quiz them on a trivial fill-in-the-blank of a fix you just explained.
- ONE STEP AT A TIME (DON'T SPRINT PAST CONFUSION): Never stack two brand-new mechanisms into one reply. If the learner asks a clarifying question or says "not sure I understand", stay on the current step until clear.
- For normal turns, answer directly with ZERO tool calls. You MAY inspect local files read-only ONLY if the learner explicitly asks you to find or read a local file, paper, note, or codebase.
- Return ONLY valid JSON with "message" FIRST so prose streams immediately: {"message": string, "question": string|null}`;

export class FastJudge {
  private readonly apiKey: string | undefined;
  private readonly jevModel: string;
  private readonly jevEnabled: boolean;
  private readonly llmModel: string;
  private readonly isAgy: boolean;
  private readonly drillModel: string;
  private readonly exploreModel: string;
  private readonly promptModel: string;
  private readonly sidecarModel: string;
  private readonly drillSlug: string | undefined;
  private readonly exploreSlug: string | undefined;
  private readonly promptSlug: string | undefined;
  private readonly sidecarSlug: string | undefined;
  private readonly llmEffort: string;
  private readonly acpClient: AgyAcpClient | null;
  private readonly agyWorker: AgyJudgeWorker | null;
  private readonly drillWorker: AgyJudgeWorker | null;
  private readonly promptWorker: AgyJudgeWorker | null;
  private readonly plannerWorker: AgyJudgeWorker | null;
  private readonly sidecarWorker: AgyJudgeWorker | null;
  private readonly cachePath: string | undefined;
  private readonly perf: PerfLog | undefined;
  private readonly passThreshold: number;
  private readonly gapCeiling: number;
  private readonly fetchFn: typeof fetch;
  private readonly promptCache = new Map<string, string>();
  private readonly inflightPrompts = new Map<string, { promise: Promise<string>; background: boolean }>();
  private activeForegroundPrompts = 0;

  constructor(opts: JudgeOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
    this.jevModel = opts.jevModel ?? process.env.MYELIN_JEV_MODEL ?? DEFAULT_JEV;
    this.llmModel = opts.llmModel ?? process.env.MYELIN_JUDGE_MODEL ?? DEFAULT_LLM;
    this.llmEffort = opts.llmEffort ?? process.env.MYELIN_JUDGE_EFFORT ?? DEFAULT_EFFORT;
    this.isAgy = this.llmModel === "agy" || this.llmModel.startsWith("agy/");
    this.jevEnabled =
      opts.enableJev ?? (process.env.MYELIN_ENABLE_JEV === "1" ? true : !this.isAgy && Boolean(this.apiKey));

    const baseSlug = this.isAgy ? stripAgyPrefix(this.llmModel) : undefined;
    // Explorations stay on a strong reasoning model (e.g. gemini-4-neon-low) unless explicitly overridden.
    this.exploreModel = opts.exploreModel ?? process.env.MYELIN_EXPLORE_MODEL?.trim() ?? this.llmModel;
    this.exploreSlug = this.isAgy ? stripAgyPrefix(this.exploreModel) ?? baseSlug : undefined;

    // Fast rubric-guided Drill checks/follow-ups/hints/tidy default to gemini-4-hydrogen-low on agy
    // (when llmModel is agy or agy/gemini-4-neon-*) while preserving explicit user overrides.
    const explicitDrill = opts.drillModel ?? process.env.MYELIN_DRILL_MODEL?.trim();
    if (explicitDrill) {
      this.drillModel = explicitDrill;
    } else if (this.isAgy && (!baseSlug || /^gemini-4-neon-/.test(baseSlug))) {
      this.drillModel = "agy/gemini-4-hydrogen-low";
    } else {
      this.drillModel = this.llmModel;
    }
    this.drillSlug = this.isAgy ? stripAgyPrefix(this.drillModel) ?? baseSlug : undefined;

    // Background prompt generation, briefings, and Dream consolidation keep high reasoning.
    const promptModelEnv = process.env.MYELIN_PROMPT_MODEL?.trim();
    const derivedPromptSlug = promptModelEnv?.startsWith("agy/")
      ? stripAgyPrefix(promptModelEnv)
      : this.exploreSlug
        ? this.exploreSlug.replace(/-(minimal|low|medium)$/, "-high")
        : undefined;
    this.promptSlug = this.isAgy ? derivedPromptSlug : undefined;
    this.promptModel = this.isAgy ? (derivedPromptSlug ? `agy/${derivedPromptSlug}` : this.exploreModel) : promptModelEnv || this.llmModel;

    // Async Explore unit-crystallization & title sidecar (runs off the hot path).
    const sidecarEnv = process.env.MYELIN_SIDECAR_MODEL?.trim();
    this.sidecarModel = sidecarEnv || (this.isAgy ? "agy/gemini-4-hydrogen-medium" : this.exploreModel);
    this.sidecarSlug = this.isAgy ? stripAgyPrefix(this.sidecarModel) ?? this.drillSlug : undefined;

    const agyBin = opts.agyBinary ?? process.env.MYELIN_AGY_BIN;
    const resourceDirs = parseResourceDirs(opts.resourceDirs);
    const transport = opts.agyTransport ?? (process.env.MYELIN_AGY_TRANSPORT === "stream-json" ? "stream-json" : "acp");

    this.acpClient = this.isAgy && transport === "acp" ? new AgyAcpClient({ binary: agyBin, resourceDirs }) : null;
    this.agyWorker = this.isAgy ? new AgyJudgeWorker(agyBin, this.exploreSlug, true, resourceDirs, 55_000, 8, this.llmEffort) : null;
    this.drillWorker =
      this.isAgy && this.drillSlug !== this.exploreSlug
        ? new AgyJudgeWorker(agyBin, this.drillSlug, true, resourceDirs, 55_000, 8, this.llmEffort)
        : this.agyWorker;
    this.promptWorker = this.isAgy ? new AgyJudgeWorker(agyBin, this.promptSlug, false, [], 55_000, 8) : null;
    this.plannerWorker = this.isAgy ? new AgyJudgeWorker(agyBin, this.promptSlug, true, resourceDirs, 120_000, 8) : null;
    this.sidecarWorker = this.isAgy ? new AgyJudgeWorker(agyBin, this.sidecarSlug, false, [], 45_000, 8) : null;

    // Eagerly pre-warm the active transport in the background (0 LLM tokens) so Turn 1 skips cold init.
    if (this.acpClient) {
      void this.acpClient.warmUp();
    } else if (this.isAgy && transport === "stream-json") {
      this.drillWorker?.warmUp();
      if (this.agyWorker && this.agyWorker !== this.drillWorker) this.agyWorker.warmUp();
    }

    this.cachePath = opts.cachePath;
    this.perf = opts.perf;
    this.passThreshold = opts.passThreshold ?? 0.88;
    this.gapCeiling = opts.gapCeiling ?? 0.3;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.loadPromptCache();
  }

  private loadPromptCache(): void {
    if (!this.cachePath || !existsSync(this.cachePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.cachePath, "utf8")) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string" && v.trim()) this.promptCache.set(k, v);
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  private savePromptCache(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(Object.fromEntries(this.promptCache), null, 2), "utf8");
    } catch {
      /* ignore write errors */
    }
  }

  get enabled(): boolean {
    return Boolean(this.apiKey || this.isAgy);
  }

  /** Closes a cached stateful ACP session (e.g. when a drill rep finishes or exploration is deleted). */
  closeSession(sessionKey: string): void {
    this.acpClient?.closeSession(sessionKey);
  }

  close(): void {
    this.acpClient?.dispose();
    this.agyWorker?.dispose();
    if (this.drillWorker && this.drillWorker !== this.agyWorker) this.drillWorker.dispose();
    this.promptWorker?.dispose();
    this.plannerWorker?.dispose();
    this.sidecarWorker?.dispose();
  }

  private buildPerf(
    t0: number,
    op: PerfOp,
    model: string,
    worker: PerfWorker,
    ok: boolean,
    opts: {
      background?: boolean | undefined;
      cacheHit?: boolean | undefined;
      jevMs?: number | undefined;
      jevPass?: boolean | undefined;
      trace?: AgyTurnTrace | undefined;
      ttftProseMs?: number | undefined;
      proseMs?: number | undefined;
      tailJsonMs?: number | undefined;
      llmStart?: number | undefined;
      outputChars?: number | undefined;
      promptChars?: number | undefined;
      error?: string | undefined;
      aborted?: boolean | undefined;
    } = {},
  ): PerfRecord {
    const tr = opts.trace;
    return {
      ts: t0,
      op,
      model,
      worker,
      transport: tr?.transport ?? (worker === "openrouter" ? "openrouter" : worker === "jev" ? "jev" : worker === "cache" ? "cache" : undefined),
      ok,
      ...(opts.aborted ? { aborted: true } : {}),
      ...(opts.background ? { background: true } : {}),
      ...(opts.cacheHit !== undefined ? { cache_hit: opts.cacheHit } : {}),
      ...(opts.jevMs !== undefined ? { jev_ms: opts.jevMs } : {}),
      ...(opts.jevPass !== undefined ? { jev_pass: opts.jevPass } : {}),
      cold_spawn: tr?.cold_spawn,
      session_reused: tr?.session_reused,
      spawn_ms: tr?.spawn_ms,
      init_ms: tr?.init_ms,
      turn_in_proc: tr?.turn_in_proc,
      queue_wait_ms: tr?.queue_wait_ms,
      first_event_ms: tr?.first_event_ms,
      thinking_ms: tr?.thinking_ms,
      ttft_raw_ms: tr?.ttft_raw_ms,
      ttft_prose_ms: opts.ttftProseMs,
      prose_ms: opts.proseMs,
      tail_json_ms: opts.tailJsonMs,
      llm_ms: tr?.llm_ms ?? (opts.llmStart !== undefined ? Date.now() - opts.llmStart : Date.now() - t0),
      prompt_chars: tr?.prompt_chars ?? opts.promptChars,
      output_chars: tr?.output_chars ?? opts.outputChars,
      input_tokens: tr?.input_tokens,
      cache_read_tokens: tr?.cache_read_tokens,
      thinking_tokens: tr?.thinking_tokens,
      output_tokens: tr?.output_tokens,
      tools_count: tr?.tools_count,
      tool_calls: tr?.tool_calls,
      step_types: tr?.step_types,
      total_ms: Date.now() - t0,
      ...(opts.error ? { error: opts.error } : {}),
    };
  }

  /**
   * Executes a turn on `agy`, preferring the persistent multiplexed `AgyAcpClient` daemon
   * (with stateful KV-cached sessions and native `session/cancel`) and transparently falling back
   * to the `stream-json` `AgyJudgeWorker` only if ACP is unsupported by the configured binary.
   */
  private async askAgy(params: {
    fallbackWorker: AgyJudgeWorker;
    fallbackWorkerName: PerfWorker;
    modelId: string | undefined;
    systemPrompt: string;
    userPrompt: string;
    /** Optional lean delta prompt used when the ACP session is already warm for `sessionKey`. */
    deltaPrompt?: string | undefined;
    sessionKey?: string | undefined;
    expectedPriorTurns?: number | undefined;
    sketchDataUrl?: string | null | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    onDelta?: ((delta: string) => void) | undefined;
    onTrace?: ((trace: AgyTurnTrace) => void) | undefined;
  }): Promise<{ raw: string; worker: PerfWorker }> {
    if (this.acpClient && !this.acpClient.isUnsupported) {
      const canDelta =
        Boolean(params.sessionKey && params.deltaPrompt) &&
        this.acpClient.isSessionWarm(params.sessionKey!, params.modelId, params.systemPrompt, params.expectedPriorTurns);
      const acpOpts: AgyAcpAskOptions = {
        modelId: params.modelId,
        sessionKey: params.sessionKey,
        systemPrompt: params.systemPrompt,
        expectedPriorTurns: canDelta ? params.expectedPriorTurns : undefined,
        sketchDataUrl: params.sketchDataUrl,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        onDelta: params.onDelta,
        onTrace: params.onTrace,
      };
      try {
        const raw = await this.acpClient.ask(canDelta ? params.deltaPrompt! : params.userPrompt, acpOpts);
        return { raw, worker: "acp" };
      } catch (err) {
        if (isAbortError(err) || !this.acpClient.isUnsupported) throw err;
        // Binary does not speak ACP (e.g. legacy stream-json fake binary); fall through cleanly.
      }
    }
    const combined = params.systemPrompt ? `${params.systemPrompt}\n\n---\n\n${params.userPrompt}` : params.userPrompt;
    const raw = await params.fallbackWorker.ask(combined, params.sketchDataUrl, params.onDelta, params.onTrace, params.signal);
    return { raw, worker: params.fallbackWorkerName };
  }

  private async askJsonWithTrace(params: {
    fallbackWorker: AgyJudgeWorker;
    fallbackWorkerName: PerfWorker;
    modelId: string | undefined;
    systemPrompt: string;
    userPrompt: string;
    deltaPrompt?: string | undefined;
    sessionKey?: string | undefined;
    expectedPriorTurns?: number | undefined;
    sketchDataUrl?: string | null | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    onText?: ((partialMessage: string) => void) | undefined;
  }): Promise<{ raw: string; trace: AgyTurnTrace | undefined; ttftProseMs?: number; proseMs?: number; tailJsonMs?: number; worker: PerfWorker }> {
    let streamed = "";
    let firstProseAt: number | undefined;
    let proseClosedAt: number | undefined;
    let trace: AgyTurnTrace | undefined;
    const tCall = Date.now();
    const { raw, worker } = await this.askAgy({
      fallbackWorker: params.fallbackWorker,
      fallbackWorkerName: params.fallbackWorkerName,
      modelId: params.modelId,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      deltaPrompt: params.deltaPrompt,
      sessionKey: params.sessionKey,
      expectedPriorTurns: params.expectedPriorTurns,
      sketchDataUrl: params.sketchDataUrl,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onDelta: (delta) => {
        streamed += delta;
        const st = extractStreamingJsonMessageState(streamed);
        if (st) {
          const now = Date.now();
          if (st.text.length > 0 && firstProseAt === undefined) firstProseAt = now;
          if (st.closed && proseClosedAt === undefined) proseClosedAt = now;
          if (st.text) params.onText?.(st.text);
        }
      },
      onTrace: (t) => {
        trace = t;
      },
    });
    const tEnd = Date.now();
    const llmStart = trace ? tEnd - trace.llm_ms : tCall;
    const ttftProseMs = firstProseAt !== undefined ? Math.max(0, firstProseAt - llmStart) : undefined;
    const proseMs =
      firstProseAt !== undefined && proseClosedAt !== undefined
        ? Math.max(0, proseClosedAt - firstProseAt)
        : firstProseAt !== undefined
          ? Math.max(0, tEnd - firstProseAt)
          : undefined;
    const tailJsonMs = proseClosedAt !== undefined ? Math.max(0, tEnd - proseClosedAt) : undefined;
    return { raw, trace, ttftProseMs, proseMs, tailJsonMs, worker };
  }

  /** System 1: ultra-fast calibrated decision call via TypeSafe Jev on OpenRouter. */
  async runJev(input: JudgeInput): Promise<JevSignals | null> {
    if (!this.apiKey) return null;
    const t0 = Date.now();
    const habits = (input.activeHabits ?? []).slice(0, 6);
    const questions: Record<string, unknown> = {
      demonstrated: {
        type: "noul",
        instructions:
          "Does the learner's attempt genuinely demonstrate mastery of the target unit? Accept rough shorthand, typos, and valid alternative routes, but reject hand-waving, missing key conditions, or wrong conclusions.",
        criteria: {
          true: "The attempt correctly produces, rebuilds, or applies the target unit with sound reasoning.",
          false: "The attempt is wrong, incomplete, vague, or skips an essential step or condition.",
        },
      },
      cot_gap: {
        type: "noul",
        instructions:
          "Is there a real flaw, slip, unstated assumption, or skipped justification in the learner's reasoning worth pointing out with a short question?",
        criteria: {
          true: "There is a real reasoning gap, slip, edge-case error, or missing justification.",
          false: "The reasoning is complete and solid for a quick active rep (ignoring minor typos or rough shorthand).",
        },
      },
      clarity: {
        type: "score",
        instructions: "How fluent and self-assured is the learner's reasoning?",
        criteria: [
          "Hesitant, fragmented, or mostly guessing",
          "Solid reasoning with minor roughness",
          "Crisp, direct, and automatic",
        ],
      },
    };
    if (habits.length > 0) {
      const criteria: Record<string, string> = { none: "None of the listed thinking moves clearly appeared." };
      habits.forEach((h, i) => {
        criteria[`h${i}`] = `The learner actively demonstrated this thinking move: ${h}`;
      });
      questions.habit_applied = {
        type: "choice",
        instructions: "Did the learner explicitly apply one of their active thinking moves in their attempt?",
        criteria,
      };
    }

    try {
      const res = await this.fetchFn(DECISIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.jevModel,
          state: {
            prompt: input.prompt,
            target_unit: input.unitText,
            unit_kind: input.unitKind,
            depth: input.depth,
            rests_on: input.restsOn,
            learner_attempt: input.attempt,
            has_attached_sketch: Boolean(input.sketchDataUrl),
          },
          questions,
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        model?: string;
        answers?: {
          demonstrated?: { noul?: number };
          cot_gap?: { noul?: number };
          clarity?: { score?: number };
          habit_applied?: { choice?: string; confidence?: number };
        };
      };
      const demonstrated = data.answers?.demonstrated?.noul;
      const cotGap = data.answers?.cot_gap?.noul;
      if (typeof demonstrated !== "number" || typeof cotGap !== "number") return null;

      let habitApplied: string | undefined;
      const hc = data.answers?.habit_applied;
      if (hc?.choice && hc.choice.startsWith("h") && (hc.confidence ?? 0) >= 0.7) {
        habitApplied = habits[Number(hc.choice.slice(1))];
      }
      return {
        model: data.model ?? this.jevModel,
        latency_ms: Date.now() - t0,
        demonstrated,
        cot_gap: cotGap,
        clarity: data.answers?.clarity?.score,
        habit_applied: habitApplied,
      };
    } catch {
      return null;
    }
  }

  private emitPerf(rec: PerfRecord, onPerf?: (rec: PerfRecord) => void): void {
    if (onPerf) onPerf(rec);
    else this.perf?.record(rec);
  }

  /** Full cascade: Jev System 1 fast-pass gate (OpenRouter only) -> System 2 LLM (ACP/agy or OpenRouter). */
  async check(
    input: JudgeInput,
    onText?: (partialMessage: string) => void,
    onPerf?: (rec: PerfRecord) => void,
    signal?: AbortSignal,
  ): Promise<JudgeResult> {
    const t0 = Date.now();
    if (!this.apiKey && !this.isAgy) {
      return {
        ok: false,
        grade: "again",
        message: "No judge configured—set OPENROUTER_API_KEY or MYELIN_JUDGE_MODEL to check answers.",
        tier: "fallback",
        failed: true,
      };
    }

    const hasSketch = Boolean(input.sketchDataUrl);
    let jev: JevSignals | null = null;
    let jevMs: number | undefined;
    if (this.jevEnabled && !hasSketch && !isLikelyNonAttempt(input.attempt)) {
      const tJev = Date.now();
      jev = await this.runJev(input);
      jevMs = jev?.latency_ms ?? Date.now() - tJev;
    }

    // System 1 fast-pass: high-confidence clean text rep with no sketch to inspect visually.
    if (jev && !hasSketch && jev.demonstrated >= this.passThreshold && jev.cot_gap <= this.gapCeiling) {
      const grade = inferGrade(input.latencyMs, input.hintsUsed, jev.clarity);
      const verb = input.depth === "rebuild" ? "Clean rebuild" : input.depth === "explain" ? "Clear explanation" : input.depth === "use" ? "Applied cleanly" : "Solid recall";
      const habitBit = jev.habit_applied ? ` · move spotted: ${jev.habit_applied}` : "";
      this.emitPerf(
        this.buildPerf(t0, "check", jev.model, "jev", true, { jevMs, jevPass: true }),
        onPerf,
      );
      return {
        ok: true,
        grade,
        message: `${verb}.${habitBit}`,
        tier: "system1",
        habit_observed: jev.habit_applied ?? null,
        jev,
      };
    }

    // System 2: fast generative LLM for surgical CoT gap questions, ambiguous passes, or sketches.
    return this.runSystem2(input, jev, jevMs, onText, onPerf, t0, signal);
  }

  private parsePrereqs(raw: unknown): ExploreUnitSuggestion[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((u): u is { text: string; kind?: string; observe_only?: boolean } => typeof u?.text === "string" && u.text.trim().length > 4)
      .slice(0, 2)
      .map((u) => ({
        text: u.text.trim(),
        kind: typeof u.kind === "string" && u.kind.trim() ? u.kind.trim() : "definition",
        observe_only: false,
      }));
  }

  private parseAnnotations(raw: unknown, learnerText: string): InlineAnnotation[] {
    if (!Array.isArray(raw) || !learnerText.trim()) return [];
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const normFull = norm(learnerText);
    const out: InlineAnnotation[] = [];
    const usedQuotes = new Set<string>();
    for (const item of raw) {
      if (out.length >= 2) break;
      const obj = item as { quote?: unknown; note?: unknown; kind?: unknown } | null;
      if (!obj || typeof obj.quote !== "string" || typeof obj.note !== "string") continue;
      const quote = obj.quote.trim();
      const note = obj.note.trim();
      if (quote.length < 3 || quote.length > 140 || note.length < 3 || note.length > 240) continue;
      const nq = norm(quote);
      if (!nq || usedQuotes.has(nq)) continue;
      // Reject quoting virtually the entire multi-line submission — pins must be surgical.
      if (normFull.length > 100 && nq.length > normFull.length * 0.85) continue;
      if (!normFull.includes(nq)) continue;
      const kind: InlineAnnotation["kind"] =
        obj.kind === "slip" || obj.kind === "question" || obj.kind === "move" ? obj.kind : "question";
      usedQuotes.add(nq);
      out.push({ quote, note, kind });
    }
    return out;
  }

  private async runSystem2(
    input: JudgeInput,
    jev: JevSignals | null,
    jevMs: number | undefined,
    onText?: (partialMessage: string) => void,
    onPerf?: (rec: PerfRecord) => void,
    t0 = Date.now(),
    signal?: AbortSignal,
  ): Promise<JudgeResult> {
    const historyBlock =
      input.history && input.history.length > 0
        ? `Earlier tries on this rep:\n${input.history
            .slice(-3)
            .map((h, i) => `Try ${i + 1}: ${h.attempt}\nFeedback ${i + 1}: ${h.feedback}`)
            .join("\n")}`
        : "";

    const mem = trimLearnerMemory(input.learnerMemory);
    const metaLines = [
      mem ? `Learner memory (calibrate framing & spot recurring blind spots; never leak answers):\n${mem}` : "",
      `Prompt asked: ${input.prompt}`,
      `Target unit (${input.unitKind}, depth ${input.depth}): ${input.unitText}`,
      input.restsOn.length ? `Rests on: ${input.restsOn.join("; ")}` : "Rests on: nothing (arbitrary/seed)",
      input.activeHabits?.length ? `Active thinking moves being trained: ${input.activeHabits.join("; ")}` : "",
      jev ? `System-1 quick check: P(demonstrated)=${jev.demonstrated.toFixed(2)}, P(cot_gap)=${jev.cot_gap.toFixed(2)}` : "",
      historyBlock,
      `Current learner attempt:\n${input.attempt.trim() || "(see attached sketch)"}`,
    ].filter(Boolean);

    const userText = metaLines.join("\n");
    const userContent: unknown = input.sketchDataUrl
      ? [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: input.sketchDataUrl } },
        ]
      : userText;

    const tLlmStart = Date.now();
    let agyTrace: AgyTurnTrace | undefined;
    let ttftProseMs: number | undefined;
    let proseMs: number | undefined;
    let tailJsonMs: number | undefined;
    let workerKind: PerfWorker = "openrouter";
    try {
      let raw = "";
      if (this.drillWorker) {
        const out = await this.askJsonWithTrace({
          fallbackWorker: this.drillWorker,
          fallbackWorkerName: "agy",
          modelId: this.drillSlug,
          systemPrompt: DRILL_COACH_SYSTEM,
          userPrompt: userText,
          sessionKey: input.sessionKey,
          sketchDataUrl: input.sketchDataUrl,
          signal,
          onText,
        });
        raw = out.raw;
        agyTrace = out.trace;
        ttftProseMs = out.ttftProseMs;
        proseMs = out.proseMs;
        tailJsonMs = out.tailJsonMs;
        workerKind = out.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.drillModel,
            reasoning: { effort: this.llmEffort },
            temperature: 0.1,
            max_tokens: 1600,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: DRILL_COACH_SYSTEM },
              { role: "user", content: userContent },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
      }
      const parsed = parseJudgeJson<{
        ok?: boolean;
        grade?: Grade;
        message?: string;
        diagnosis?: string | null;
        next?: string | null;
        annotations?: unknown;
        habit_observed?: string | null;
        missing_prereqs?: unknown;
      }>(raw);
      const directMsg = typeof parsed?.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
      const combined = directMsg || [parsed?.diagnosis, parsed?.next].filter((x): x is string => typeof x === "string" && x.trim().length > 0).join(" ");
      if (!parsed || typeof parsed.ok !== "boolean" || !combined) {
        throw new Error(`invalid JSON verdict (raw=${raw.slice(0, 180)})`);
      }
      const grade: Grade = parsed.ok
        ? parsed.grade && ["hard", "good", "easy"].includes(parsed.grade)
          ? parsed.grade
          : inferGrade(input.latencyMs, input.hintsUsed, jev?.clarity)
        : "again";
      const missingPrereqs = this.parsePrereqs(parsed.missing_prereqs);
      const annotations = this.parseAnnotations(parsed.annotations, input.attempt);
      if (parsed.ok && input.sessionKey) this.closeSession(input.sessionKey);
      this.emitPerf(
        this.buildPerf(t0, "check", this.drillModel, workerKind, true, {
          jevMs,
          jevPass: jevMs !== undefined ? false : undefined,
          trace: agyTrace,
          ttftProseMs,
          proseMs,
          tailJsonMs,
          llmStart: tLlmStart,
          outputChars: raw.length,
          promptChars: userText.length,
        }),
        onPerf,
      );
      return {
        ok: parsed.ok,
        grade,
        message: combined,
        tier: "system2",
        ...(annotations.length > 0 ? { annotations } : {}),
        habit_observed: parsed.habit_observed ?? jev?.habit_applied ?? null,
        ...(missingPrereqs.length > 0 ? { missing_prereqs: missingPrereqs } : {}),
        jev: jev ?? undefined,
      };
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        this.emitPerf(
          this.buildPerf(t0, "check", this.drillModel, workerKind, false, {
            jevMs,
            jevPass: jevMs !== undefined ? false : undefined,
            trace: agyTrace,
            aborted: true,
            error: "aborted",
          }),
          onPerf,
        );
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[judge] runSystem2 failed:", msg);
      this.emitPerf(
        this.buildPerf(t0, "check", this.drillModel, workerKind, false, {
          jevMs,
          jevPass: jevMs !== undefined ? false : undefined,
          trace: agyTrace,
          error: msg,
        }),
        onPerf,
      );
      // Honest ungraded outcome on System 2 outage—never silently relax Jev thresholds into a fake pass.
      return {
        ok: false,
        grade: "again",
        message: "Could not reach the judge just now.",
        tier: "fallback",
        failed: true,
        jev: jev ?? undefined,
      };
    }
  }

  /**
   * Evaluates an inline reply right inside Drill. Reuses the warm KV-cached ACP session from `check()`
   * so follow-up beats send only the new learner reply (~30-100 tokens instead of ~4.5k tokens).
   */
  async continueRep(
    input: {
      sessionKey?: string | undefined;
      prompt: string;
      unitText: string;
      unitKind: string;
      depth: Depth;
      restsOn: string[];
      existingUnits?: string[];
      activeHabits?: string[];
      learnerMemory?: string | null | undefined;
      attempt: string;
      feedback: string;
      turns: { role: "user" | "assistant"; text: string }[];
      reply: string;
      revisedAttempt?: boolean;
      sketchDataUrl?: string | null | undefined;
      latencyMs: number | null;
      hintsUsed: number;
    },
    onText?: (partialMessage: string) => void,
    onPerf?: (rec: PerfRecord) => void,
    signal?: AbortSignal,
  ): Promise<JudgeResult> {
    const t0 = Date.now();
    if (!this.apiKey && !this.isAgy) {
      return {
        ok: false,
        grade: "again",
        message: "Configure OPENROUTER_API_KEY or MYELIN_JUDGE_MODEL=agy/gemini-4-neon-low for inline replies.",
        tier: "fallback",
        failed: true,
      };
    }

    const thread = input.turns
      .slice(-20)
      .map((t) => `${t.role === "user" ? "Learner" : "Coach"}: ${t.text}`)
      .join("\n");
    const mem = trimLearnerMemory(input.learnerMemory);
    const fullUser = [
      mem ? `Learner memory (calibrate framing & spot recurring blind spots; never leak answers):\n${mem}` : "",
      `Prompt asked: ${input.prompt}`,
      `Target unit (${input.unitKind}, depth ${input.depth}): ${input.unitText}`,
      input.restsOn.length ? `Rests on: ${input.restsOn.join("; ")}` : "",
      input.activeHabits?.length ? `Active thinking moves being trained: ${input.activeHabits.join("; ")}` : "",
      `Learner initial beat:\n${input.attempt.trim() || "(empty)"}`,
      `Initial coach response: ${input.feedback}`,
      thread ? `Exchange so far:\n${thread}` : "",
      `${input.revisedAttempt ? "Learner revised full derivation in place" : "Learner latest beat"}:\n${input.reply.trim() || "(see attached sketch)"}`,
    ]
      .filter(Boolean)
      .join("\n");

    const deltaUser = `${input.revisedAttempt ? "Learner revised full derivation in place" : "Learner latest beat"}:\n${input.reply.trim() || "(see attached sketch)"}`;
    const expectedPriorTurns = 1 + Math.floor(input.turns.length / 2);

    const userContent: unknown = input.sketchDataUrl
      ? [
          { type: "text", text: fullUser },
          { type: "image_url", image_url: { url: input.sketchDataUrl } },
        ]
      : fullUser;

    let agyTrace: AgyTurnTrace | undefined;
    let ttftProseMs: number | undefined;
    let proseMs: number | undefined;
    let tailJsonMs: number | undefined;
    let workerKind: PerfWorker = "openrouter";
    try {
      let raw = "";
      if (this.drillWorker) {
        const out = await this.askJsonWithTrace({
          fallbackWorker: this.drillWorker,
          fallbackWorkerName: "agy",
          modelId: this.drillSlug,
          systemPrompt: DRILL_COACH_SYSTEM,
          userPrompt: fullUser,
          deltaPrompt: deltaUser,
          sessionKey: input.sessionKey,
          expectedPriorTurns,
          sketchDataUrl: input.sketchDataUrl,
          signal,
          onText,
        });
        raw = out.raw;
        agyTrace = out.trace;
        ttftProseMs = out.ttftProseMs;
        proseMs = out.proseMs;
        tailJsonMs = out.tailJsonMs;
        workerKind = out.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.drillModel,
            reasoning: { effort: this.llmEffort },
            temperature: 0.1,
            max_tokens: 1400,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: DRILL_COACH_SYSTEM },
              { role: "user", content: userContent },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
      }
      const parsed = parseJudgeJson<{
        ok?: boolean;
        grade?: Grade;
        message?: string;
        annotations?: unknown;
        habit_observed?: string | null;
        missing_prereqs?: unknown;
      }>(raw);
      if (parsed && typeof parsed.ok === "boolean" && typeof parsed.message === "string" && parsed.message.trim()) {
        const trimmedReply = input.reply.trim();
        const tentativeGuess = trimmedReply.endsWith("?") && trimmedReply.length <= 40;
        let grade: Grade = parsed.ok
          ? parsed.grade && ["again", "hard", "good", "easy"].includes(parsed.grade)
            ? parsed.grade
            : "again"
          : "again";
        if (parsed.ok && tentativeGuess && input.hintsUsed >= 2) {
          grade = "again";
        }
        const missingPrereqs = this.parsePrereqs(parsed.missing_prereqs);
        const annotations = this.parseAnnotations(parsed.annotations, input.reply);
        if (parsed.ok && input.sessionKey) this.closeSession(input.sessionKey);
        this.emitPerf(
          this.buildPerf(t0, "follow-up", this.drillModel, workerKind, true, {
            trace: agyTrace,
            ttftProseMs,
            proseMs,
            tailJsonMs,
            outputChars: raw.length,
            promptChars: fullUser.length,
          }),
          onPerf,
        );
        return {
          ok: parsed.ok,
          grade,
          message: parsed.message.trim(),
          tier: "system2",
          ...(annotations.length > 0 ? { annotations } : {}),
          ...(parsed.habit_observed ? { habit_observed: parsed.habit_observed } : {}),
          ...(missingPrereqs.length > 0 ? { missing_prereqs: missingPrereqs } : {}),
        };
      }
      console.error("[judge] continueRep invalid JSON:", raw.slice(0, 180));
      this.emitPerf(this.buildPerf(t0, "follow-up", this.drillModel, workerKind, false, { trace: agyTrace, error: "invalid JSON" }), onPerf);
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        this.emitPerf(this.buildPerf(t0, "follow-up", this.drillModel, workerKind, false, { trace: agyTrace, aborted: true, error: "aborted" }), onPerf);
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[judge] continueRep failed:", msg);
      this.emitPerf(this.buildPerf(t0, "follow-up", this.drillModel, workerKind, false, { trace: agyTrace, error: msg }), onPerf);
    }
    return {
      ok: false,
      grade: "again",
      message: "Could not check that reply just now.",
      tier: "fallback",
      failed: true,
    };
  }

  /**
   * Ephemeral blank-drill ("+") exploration coach: helps the learner actively work through a new
   * idea or problem in place on a strong reasoning model (`exploreModel`, e.g. gemini-4-neon-low).
   * For standalone explorations (`decoupleMeta: true`), keeps the hot path laser-focused on
   * streaming `"message"` + `"question"` with stateful KV-cached sessions (Turns 2+ send only the
   * learner's new reply), while `extractExploreMeta()` crystallizes units & titles asynchronously.
   */
  async explore(
    input: {
      sessionKey?: string | undefined;
      /** When true (and no repContext), omits unit-crystallization & title rules from the hot path. */
      decoupleMeta?: boolean | undefined;
      initial: string;
      sketchDataUrl?: string | null | undefined;
      turns: { role: "user" | "assistant"; text: string }[];
      reply?: string | undefined;
      existingUnits: string[];
      activeHabits: string[];
      learnerMemory?: string | null | undefined;
      repContext?: { unitText: string; depth: Depth; prompt: string; grade: Grade } | undefined;
    },
    onText?: (partialMessage: string) => void,
    onPerf?: (rec: PerfRecord) => void,
    signal?: AbortSignal,
  ): Promise<ExploreResult> {
    const t0 = Date.now();
    if (!this.apiKey && !this.isAgy) {
      return {
        message: "Configure OPENROUTER_API_KEY or MYELIN_JUDGE_MODEL=agy/gemini-4-neon-low to run explorations.",
        suggested_units: [],
        failed: true,
      };
    }

    const hotOnly = Boolean(input.decoupleMeta) && !input.repContext;

    const repMetaRule = input.repContext
      ? `\n\nMETA-FEEDBACK ON THE COMPLETED REP (self-healing):
- This follow-up sits directly below a completed drill rep (Unit: "${input.repContext.unitText}" | Prompt: "${input.repContext.prompt}" | Depth: ${input.repContext.depth} | Grade: ${input.repContext.grade}).
- If the learner is commenting on the drill itself—e.g. an ambiguous/poorly worded prompt, a bad map unit, a hint that spoiled the answer, or a grade/interval that felt too generous or too harsh—acknowledge candidly in "message" AND emit "rep_fix" with any fixes that are warranted:
  - "reworded_unit": cleaner standalone map-unit statement, or null.
  - "improved_prompt": sharper, unambiguous drill prompt for next review (names the starting setup clearly, hides only the trick), or null.
  - "recommended_grade": "again" | "hard" | "good" | "easy" if the schedule should change, or null.
- On normal conceptual follow-up questions, leave "rep_fix": null.`
      : "";

    const jsonShape = input.repContext
      ? `{"message": string, "question": string|null, "title": string|null, "suggested_units": [{"text": string, "kind": string, "observe_only": boolean, "told": boolean}], "rep_fix": {"reworded_unit": string|null, "improved_prompt": string|null, "recommended_grade": "again"|"hard"|"good"|"easy"|null}|null}`
      : `{"message": string, "question": string|null, "title": string|null, "suggested_units": [{"text": string, "kind": string, "observe_only": boolean, "told": boolean}]}`;

    const fullSys = `${EXPLORE_HOT_SYSTEM.replace(
      'Return ONLY valid JSON with "message" FIRST so prose streams immediately: {"message": string, "question": string|null}',
      `Unit crystallization ("suggested_units") — CALIBRATED & ANTI-SPOILER:
- HARD ANTI-SPOILER RULE: NEVER emit a unit that reveals the answer to the open "question" you are asking on this turn.
- NEVER ADD WHAT THEY ALREADY KNEW COLD: If the learner answers your question cleanly and directly because they already know the concept, emit "suggested_units": [].
- ONLY CRYSTALLIZE WHAT WAS ACTUALLY NEW OR SHAKY (1-2 max when earned; [] on already-known answers, broad overviews, quick sanity checks, or stalls): emit a unit ONLY when (a) you just taught/explained a genuinely new concept/term they didn't know ("told": true), (b) you just fixed a concrete mistake ("told": true), or (c) they worked through a genuinely non-obvious new synthesis ("told": false).
- DURABLE CONCEPTS ONLY (NO PAPER TRIVIA): Write each unit "text" as one crisp, standalone, self-contained statement (1-2 sentences). Set observe_only=true ONLY for a meta-cognitive Thinking Move; false for knowledge/skill units.
- "title": on the opening turn or whenever emitting suggested_units during a post-practice follow-up, include a crisp 2-5 word title; otherwise null.${repMetaRule}
- Return ONLY valid JSON with "message" FIRST so prose streams immediately: ${jsonShape}`,
    )}`;

    const sys = hotOnly ? EXPLORE_HOT_SYSTEM : fullSys;

    const thread = input.turns
      .slice(-20)
      .map((t) => `${t.role === "user" ? "Learner" : "Coach"}: ${t.text}`)
      .join("\n");

    const mem = trimLearnerMemory(input.learnerMemory);
    const lines = [
      mem ? `Learner memory (use this to calibrate level, pacing, analogies, and blind spots):\n${mem}` : "",
      input.activeHabits.length ? `Active thinking moves:\n- ${input.activeHabits.slice(0, 8).join("\n- ")}` : "",
      `Learner opening prompt/attempt:\n${input.initial.trim() || "(see attached sketch)"}`,
      thread ? `Exchange so far:\n${thread}` : "",
      input.reply?.trim() ? `Learner latest reply:\n${input.reply.trim()}` : "",
    ].filter(Boolean);

    const fullUser = lines.join("\n\n");
    const deltaUser = input.reply?.trim()
      ? `Learner latest reply:\n${input.reply.trim()}`
      : `Learner latest reply:\n${input.initial.trim() || "(see attached sketch)"}`;
    const expectedPriorTurns = Math.ceil(input.turns.length / 2);

    const userContent: unknown = input.sketchDataUrl
      ? [
          { type: "text", text: fullUser },
          { type: "image_url", image_url: { url: input.sketchDataUrl } },
        ]
      : fullUser;

    let agyTrace: AgyTurnTrace | undefined;
    let ttftProseMs: number | undefined;
    let proseMs: number | undefined;
    let tailJsonMs: number | undefined;
    let workerKind: PerfWorker = "openrouter";
    try {
      let raw = "";
      if (this.agyWorker) {
        const out = await this.askJsonWithTrace({
          fallbackWorker: this.agyWorker,
          fallbackWorkerName: "agy",
          modelId: this.exploreSlug,
          systemPrompt: sys,
          userPrompt: fullUser,
          deltaPrompt: input.turns.length > 0 ? deltaUser : undefined,
          sessionKey: input.sessionKey,
          expectedPriorTurns: input.turns.length > 0 ? expectedPriorTurns : undefined,
          sketchDataUrl: input.sketchDataUrl,
          signal,
          onText,
        });
        raw = out.raw;
        agyTrace = out.trace;
        ttftProseMs = out.ttftProseMs;
        proseMs = out.proseMs;
        tailJsonMs = out.tailJsonMs;
        workerKind = out.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.exploreModel,
            reasoning: { effort: this.llmEffort },
            temperature: 0.2,
            max_tokens: 1800,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: userContent },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
      }
      const parsed = parseJudgeJson<{
        message?: string;
        question?: string | null;
        title?: string | null;
        suggested_units?: { text?: string; kind?: string; observe_only?: boolean; told?: boolean }[];
        rep_fix?: { reworded_unit?: string | null; improved_prompt?: string | null; recommended_grade?: string | null } | null;
      }>(raw);
      if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
        const suggested =
          !hotOnly && Array.isArray(parsed.suggested_units)
            ? parsed.suggested_units
                .filter(
                  (u): u is { text: string; kind?: string; observe_only?: boolean; told?: boolean } =>
                    typeof u?.text === "string" && u.text.trim().length > 4,
                )
                .slice(0, 2)
                .map((u) => ({
                  text: u.text.trim(),
                  kind: typeof u.kind === "string" && u.kind.trim() ? u.kind.trim() : u.observe_only ? "thinking move" : "move",
                  observe_only: Boolean(u.observe_only),
                  told: Boolean(u.told),
                }))
            : [];
        const title = !hotOnly && typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : undefined;
        const question =
          typeof parsed.question === "string" && parsed.question.trim().length > 3 ? parsed.question.trim() : undefined;
        let rep_fix: ExploreRepFix | undefined;
        if (input.repContext && parsed.rep_fix && typeof parsed.rep_fix === "object") {
          const reworded =
            typeof parsed.rep_fix.reworded_unit === "string" && parsed.rep_fix.reworded_unit.trim().length > 6
              ? parsed.rep_fix.reworded_unit.trim()
              : null;
          const improved =
            typeof parsed.rep_fix.improved_prompt === "string" && parsed.rep_fix.improved_prompt.trim().length > 10
              ? parsed.rep_fix.improved_prompt.trim()
              : null;
          const recGrade =
            parsed.rep_fix.recommended_grade && ["again", "hard", "good", "easy"].includes(parsed.rep_fix.recommended_grade)
              ? (parsed.rep_fix.recommended_grade as Grade)
              : null;
          if (reworded || improved || recGrade) {
            rep_fix = {
              ...(reworded ? { reworded_unit: reworded } : {}),
              ...(improved ? { improved_prompt: improved } : {}),
              ...(recGrade ? { recommended_grade: recGrade } : {}),
            };
          }
        }
        this.emitPerf(
          this.buildPerf(t0, "explore", this.exploreModel, workerKind, true, {
            trace: agyTrace,
            ttftProseMs,
            proseMs,
            tailJsonMs,
            outputChars: raw.length,
            promptChars: fullUser.length,
          }),
          onPerf,
        );
        return {
          message: parsed.message.trim(),
          ...(question ? { question } : {}),
          ...(title ? { title } : {}),
          suggested_units: suggested,
          ...(rep_fix ? { rep_fix } : {}),
        };
      }
      if (raw.trim()) {
        this.emitPerf(
          this.buildPerf(t0, "explore", this.exploreModel, workerKind, true, {
            trace: agyTrace,
            outputChars: raw.length,
            promptChars: fullUser.length,
          }),
          onPerf,
        );
        return { message: raw.trim(), suggested_units: [] };
      }
      this.emitPerf(this.buildPerf(t0, "explore", this.exploreModel, workerKind, false, { trace: agyTrace, error: "empty response" }), onPerf);
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        this.emitPerf(this.buildPerf(t0, "explore", this.exploreModel, workerKind, false, { trace: agyTrace, aborted: true, error: "aborted" }), onPerf);
        throw err;
      }
      this.emitPerf(
        this.buildPerf(t0, "explore", this.exploreModel, workerKind, false, {
          trace: agyTrace,
          error: err instanceof Error ? err.message : String(err),
        }),
        onPerf,
      );
    }
    return { message: "Could not reach the coach just now.", suggested_units: [], failed: true };
  }

  /**
   * Non-blocking post-turn Explore sidecar: runs off the hot path after coach prose + question have
   * already streamed to the UI, extracting calibrated anti-spoiler `suggested_units` and a crisp
   * Turn-1 `title` without adding a single millisecond to foreground TTFT.
   */
  async extractExploreMeta(input: {
    userText: string;
    coachMessage: string;
    coachQuestion?: string | undefined;
    priorTurns: { role: "user" | "assistant"; text: string }[];
    existingUnits: string[];
    activeHabits: string[];
    needsTitle: boolean;
  }): Promise<ExploreSidecarResult> {
    const t0 = Date.now();
    if (!this.apiKey && !this.isAgy) return { suggested_units: [] };

    const sys = `You are Myelin's calibrated knowledge-crystallization sidecar. You receive ONE just-completed Exploration exchange and extract ONLY high-signal durable units (and a crisp 2-5 word title when requested).

Unit crystallization ("suggested_units") — CALIBRATED & ANTI-SPOILER:
- HARD ANTI-SPOILER RULE: NEVER emit a unit that reveals the answer to the Coach's open question on this turn.
- NEVER ADD WHAT THEY ALREADY KNEW COLD: If the learner answered cleanly and directly because they already know the concept, emit "suggested_units": [].
- ONLY CRYSTALLIZE WHAT WAS ACTUALLY NEW OR SHAKY (1-2 max when earned; [] on already-known answers, broad overviews, quick sanity checks, or stalls): emit a unit ONLY when (a) Coach just taught/explained a genuinely new concept, mechanism, or term the learner asked about or didn't know ("told": true), (b) Coach just fixed a concrete mistake/slip ("told": true), or (c) the learner just worked through a genuinely non-obvious new synthesis/derivation they had NOT known beforehand ("told": false).
- DURABLE CONCEPTS ONLY (NO PAPER TRIVIA): Skip duplicates of Existing units. Write each unit "text" as one crisp, standalone, self-contained statement (1-2 sentences, with TeX math or short code if helpful).
- Set observe_only=true ONLY for a meta-cognitive Thinking Move / reasoning reflex; false for knowledge/skill units to drill.
- "title": ${input.needsTitle ? 'Return a crisp 2-5 word title for this exploration (e.g. "Linear attention & KDA", "Poisson limit derivation").' : "Set to null."}
- Answer directly with ZERO tool calls. Return ONLY valid JSON:
{"title": string|null, "suggested_units": [{"text": string, "kind": string, "observe_only": boolean, "told": boolean}]}`;

    const recent = input.priorTurns
      .slice(-4)
      .map((t) => `${t.role === "user" ? "Learner" : "Coach"}: ${t.text.slice(0, 320)}`)
      .join("\n");
    const user = [
      input.existingUnits.length > 0 ? `Existing units (do not duplicate):\n- ${input.existingUnits.slice(0, 35).join("\n- ")}` : "",
      input.activeHabits.length > 0 ? `Active thinking moves:\n- ${input.activeHabits.slice(0, 8).join("\n- ")}` : "",
      recent ? `Recent context:\n${recent}` : "",
      `Latest turn:\nLearner: ${input.userText}\nCoach: ${input.coachMessage}${input.coachQuestion ? `\nCoach open question (DO NOT SPOIL): ${input.coachQuestion}` : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    let agyTrace: AgyTurnTrace | undefined;
    let workerKind: PerfWorker = "openrouter";
    try {
      let raw = "";
      if (this.sidecarWorker) {
        const res = await this.askAgy({
          fallbackWorker: this.sidecarWorker,
          fallbackWorkerName: "sidecar",
          modelId: this.sidecarSlug,
          systemPrompt: sys,
          userPrompt: user,
          timeoutMs: 35_000,
          onTrace: (t) => {
            agyTrace = t;
          },
        });
        raw = res.raw;
        workerKind = res.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.sidecarModel,
            reasoning: { effort: "low" },
            temperature: 0.1,
            max_tokens: 900,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
      }
      const parsed = parseJudgeJson<{
        title?: string | null;
        suggested_units?: { text?: string; kind?: string; observe_only?: boolean; told?: boolean }[];
      }>(raw);
      const suggested = Array.isArray(parsed?.suggested_units)
        ? parsed.suggested_units
            .filter(
              (u): u is { text: string; kind?: string; observe_only?: boolean; told?: boolean } =>
                typeof u?.text === "string" && u.text.trim().length > 4,
            )
            .slice(0, 2)
            .map((u) => ({
              text: u.text.trim(),
              kind: typeof u.kind === "string" && u.kind.trim() ? u.kind.trim() : u.observe_only ? "thinking move" : "move",
              observe_only: Boolean(u.observe_only),
              told: Boolean(u.told),
            }))
        : [];
      const title =
        input.needsTitle && typeof parsed?.title === "string" && parsed.title.trim() ? parsed.title.trim().slice(0, 60) : undefined;
      this.perf?.record(
        this.buildPerf(t0, "sidecar", this.sidecarModel, workerKind, true, {
          background: true,
          trace: agyTrace,
          outputChars: raw.length,
          promptChars: user.length,
        }),
      );
      return { ...(title ? { title } : {}), suggested_units: suggested };
    } catch (err) {
      this.perf?.record(
        this.buildPerf(t0, "sidecar", this.sidecarModel, workerKind, false, {
          background: true,
          trace: agyTrace,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return { suggested_units: [] };
    }
  }

  /** One escalating hint rung without spoiling the answer. */
  async hint(
    input: { prompt: string; unitText: string; restsOn: string[]; attempt: string; rung: number },
    onPerf?: (rec: PerfRecord) => void,
  ): Promise<HintResult> {
    const t0 = Date.now();
    const rung = Math.max(1, Math.min(3, input.rung));
    if (!this.apiKey && !this.isAgy) {
      const seed = input.restsOn[0];
      return {
        rung,
        hint: seed ? `Start from what this rests on: ${seed}.` : "Try writing down the definition or first step in rough shorthand.",
      };
    }
    const rungInstruction =
      rung === 1
        ? "Give the smallest nudge: point at what to look at or which starting perspective to take (max 20 words). Do not state the answer."
        : rung === 2
          ? "Ask one narrower guiding question that points directly at the key move (max 24 words). Do not state the full answer."
          : "Give only the first partial step so the learner still completes the rest (max 28 words).";

    const hintSys = `You give brief Socratic nudges in plain sentence case. No exclamation marks, no praise. Answer directly with ZERO tool calls. ${rungInstruction}`;
    const hintUser = `Prompt: ${input.prompt}\nTarget unit: ${input.unitText}\nRests on: ${input.restsOn.join("; ") || "nothing"}\nLearner so far: ${input.attempt.trim() || "(empty)"}`;

    let agyTrace: AgyTurnTrace | undefined;
    let workerKind: PerfWorker = "openrouter";
    try {
      let text: string | undefined;
      if (this.drillWorker) {
        const res = await this.askAgy({
          fallbackWorker: this.drillWorker,
          fallbackWorkerName: "agy",
          modelId: this.drillSlug,
          systemPrompt: hintSys,
          userPrompt: hintUser,
          onTrace: (t) => {
            agyTrace = t;
          },
        });
        text = res.raw.trim();
        workerKind = res.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.drillModel,
            reasoning: { effort: "low" },
            temperature: 0.2,
            max_tokens: 1200,
            messages: [
              { role: "system", content: hintSys },
              { role: "user", content: hintUser },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        text = data.choices?.[0]?.message?.content?.trim();
      }
      if (text) {
        this.emitPerf(
          this.buildPerf(t0, "hint", this.drillModel, workerKind, true, {
            trace: agyTrace,
            outputChars: text.length,
            promptChars: hintUser.length,
          }),
          onPerf,
        );
        return { rung, hint: text };
      }
    } catch (err) {
      this.emitPerf(
        this.buildPerf(t0, "hint", this.drillModel, workerKind, false, {
          trace: agyTrace,
          error: err instanceof Error ? err.message : String(err),
        }),
        onPerf,
      );
    }
    const seed = input.restsOn[0];
    return {
      rung,
      hint: seed ? `Anchor on: ${seed}.` : "Start from the simplest case or definition.",
    };
  }

  /**
   * Strictly cosmetic draft formatter (like Black/Prettier + spellcheck) powered by a fast model
   * (uses `agy` fast tier at $0 cost when on `agy`, or OpenRouter flash-lite otherwise).
   * Tidies indentation, spacing, brackets, and obvious typos while explicitly NEVER solving the task
   * or altering semantic choices (e.g. axis, keepdim, signs, missing arguments).
   */
  async tidyInput(text: string, onPerf?: (rec: PerfRecord) => void): Promise<{ text: string; changed: boolean }> {
    const t0 = Date.now();
    const raw = text;
    if (!raw.trim()) return { text: raw, changed: false };
    if (!this.apiKey && !this.isAgy) {
      throw new Error("Configure MYELIN_JUDGE_MODEL=agy/... or OPENROUTER_API_KEY to use fast draft formatting.");
    }
    const sys = `You are a strictly cosmetic code & notation formatter (like Black/Prettier + spellcheck).
Your ONLY job is to tidy the user's rough draft (which may be incomplete or mid-thought) WITHOUT changing its meaning, logic, or solving anything.

STRICT RULES:
- Fix indentation, spacing, alignment, line breaks, and obvious spelling/keyword typos (e.g. "keedim" -> "keepdim", "ret " -> "return ", "tru" -> "True").
- NEVER complete unfinished code, NEVER add missing arguments/steps (e.g. do NOT add keepdim=True, do NOT fix a wrong axis/dim, do NOT fix a math sign or factor, do NOT add missing imports or return statements the user didn't write).
- Preserve all user logic, variable names, rough structure, ASCII operators (keep "->", "!=", "<=", ">=" as ASCII), and any semantic bugs untouched—only clean syntax/formatting/typos.
- Keep prose as prose and code as code. Do NOT wrap the output in markdown fences unless the input already had them. No explanations or commentary. Answer directly with ZERO tool calls.
- Return ONLY the tidied text verbatim.`;

    let out: string | undefined;
    let modelUsed = this.drillModel;
    let workerKind: PerfWorker = "openrouter";
    let agyTrace: AgyTurnTrace | undefined;

    if (this.drillWorker) {
      const res = await this.askAgy({
        fallbackWorker: this.drillWorker,
        fallbackWorkerName: "agy",
        modelId: this.drillSlug,
        systemPrompt: sys,
        userPrompt: raw,
        timeoutMs: 25_000,
        onTrace: (t) => {
          agyTrace = t;
        },
      });
      out = res.raw;
      workerKind = res.worker;
    } else {
      const tidyModel = process.env.MYELIN_TIDY_MODEL?.trim() || "google/gemini-2.5-flash-lite";
      modelUsed = tidyModel;
      const res = await this.fetchFn(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: tidyModel,
          temperature: 0,
          max_tokens: 1400,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: raw },
          ],
        }),
      });
      if (!res.ok) throw new Error(`Formatter failed (HTTP ${res.status})`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      out = data.choices?.[0]?.message?.content;
    }

    if (typeof out !== "string" || !out.trim()) {
      return { text: raw, changed: false };
    }
    // Strip accidental markdown fence wrapper if the user's input didn't have one
    if (!raw.includes("```")) {
      const fenced = out.trim().match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/);
      if (fenced && fenced[1] !== undefined) out = fenced[1];
    }
    // Preserve whether the user had trailing whitespace/newline minimally
    out = out.replace(/^\r?\n+|\r?\n+$/g, "");
    this.emitPerf(
      this.buildPerf(t0, "tidy", modelUsed, workerKind, true, {
        trace: agyTrace,
        promptChars: raw.length,
        outputChars: out.length,
      }),
      onPerf,
    );
    return { text: out, changed: out !== raw };
  }

  /**
   * Neutral post-rep auditor: inspects a completed drill transcript to spot vague prompts,
   * poorly phrased map units, unfair grades, or missing prereqs, and returns concrete fixes
   * plus a concise learner-facing analysis.
   */
  async auditRep(
    input: {
      unitText: string;
      unitKind: string;
      depth: Depth;
      prompt: string;
      grade: Grade;
      beats: { user: string; coach: string }[];
      existingUnits: string[];
      learnerMemory?: string | null | undefined;
    },
    onPerf?: (rec: PerfRecord) => void,
  ): Promise<AuditRepResult> {
    const t0 = Date.now();
    if (!this.apiKey && !this.isAgy) {
      throw new Error("Configure OPENROUTER_API_KEY or MYELIN_JUDGE_MODEL to audit reps.");
    }
    const sys = `You are Myelin's neutral session auditor. The learner just completed a drill rep and asked you to review whether the prompt, map unit, and grade were fair and high-signal.

Be candid, concise, and surgical (zero fluff, zero defensive excuses):
1. Prompt check: Was the prompt vague/over-riddled, a spoiler, or mismatched with the unit? If clearly flawed, provide a crisp "improved_prompt" (1-2 sentences, names the concrete setup clearly, hides only the solution/trick). Otherwise null.
2. Map unit check: Is the stored unit text unclear, too broad, or awkward? If clearly worth sharpening, provide "reworded_unit" (one clean, self-contained statement). Otherwise null.
3. Grade check: Was the assigned grade ("again"|"hard"|"good"|"easy") clearly unfair (e.g. passed a lucky "?" guess or heavily hinted rep as "hard"/"good", OR penalized a genuinely solid answer)? If clearly off, set "recommended_grade". Otherwise null.
4. Missing prereqs: ONLY if this exchange exposed a genuinely missing reusable prerequisite, include at most 1 item in "missing_prereqs"; otherwise [].
5. Analysis: Write 2-4 crisp sentences or short bullets summarizing what worked, what felt off (if anything), and why you made (or skipped) each adjustment.
Answer directly with ZERO tool calls.

Return ONLY valid JSON:
{"analysis": string, "improved_prompt": string|null, "reworded_unit": string|null, "recommended_grade": "again"|"hard"|"good"|"easy"|null, "missing_prereqs": [{"text": string, "kind": string}]}`;

    const transcript = input.beats
      .slice(-10)
      .map((b, i) => `Turn ${i + 1}\nLearner: ${b.user}\nCoach: ${b.coach}`)
      .join("\n\n");
    const mem = trimLearnerMemory(input.learnerMemory);
    const user = [
      mem ? `Learner memory:\n${mem}` : "",
      `Stored map unit (${input.unitKind}, depth ${input.depth}): ${input.unitText}`,
      `Prompt shown: ${input.prompt}`,
      `Assigned grade: ${input.grade}`,
      `Transcript:\n${transcript}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    let agyTrace: AgyTurnTrace | undefined;
    let workerKind: PerfWorker = "openrouter";
    let raw = "";
    try {
      if (this.agyWorker) {
        const res = await this.askAgy({
          fallbackWorker: this.agyWorker,
          fallbackWorkerName: "agy",
          modelId: this.exploreSlug,
          systemPrompt: sys,
          userPrompt: user,
          onTrace: (t) => {
            agyTrace = t;
          },
        });
        raw = res.raw;
        workerKind = res.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.exploreModel,
            reasoning: { effort: this.llmEffort },
            temperature: 0.1,
            max_tokens: 1400,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
      }

      const parsed = parseJudgeJson<{
        analysis?: string;
        improved_prompt?: string | null;
        reworded_unit?: string | null;
        recommended_grade?: string | null;
        missing_prereqs?: unknown;
      }>(raw);
      if (!parsed || typeof parsed.analysis !== "string" || !parsed.analysis.trim()) {
        throw new Error("Could not parse rep audit.");
      }
      const recGrade =
        parsed.recommended_grade && ["again", "hard", "good", "easy"].includes(parsed.recommended_grade)
          ? (parsed.recommended_grade as Grade)
          : null;
      this.emitPerf(
        this.buildPerf(t0, "audit", this.exploreModel, workerKind, true, {
          trace: agyTrace,
          outputChars: raw.length,
          promptChars: user.length,
        }),
        onPerf,
      );
      return {
        analysis: parsed.analysis.trim(),
        improved_prompt: typeof parsed.improved_prompt === "string" && parsed.improved_prompt.trim().length > 8 ? parsed.improved_prompt.trim() : null,
        reworded_unit: typeof parsed.reworded_unit === "string" && parsed.reworded_unit.trim().length > 8 ? parsed.reworded_unit.trim() : null,
        recommended_grade: recGrade,
        missing_prereqs: this.parsePrereqs(parsed.missing_prereqs).slice(0, 1),
      };
    } catch (err) {
      this.emitPerf(
        this.buildPerf(t0, "audit", this.exploreModel, workerKind, false, {
          trace: agyTrace,
          error: err instanceof Error ? err.message : String(err),
        }),
        onPerf,
      );
      throw err;
    }
  }

  /** Overrides a cached prompt for a specific unit/depth/variant and persists the cache. */
  overrideCachedPrompt(
    unit: { id: string; text: string },
    depth: Depth,
    restsOn: string[],
    variant: number,
    prompt: string,
  ): void {
    const clean = prompt.trim();
    if (!clean) return;
    this.promptCache.set(this.promptKey(unit, depth, restsOn, variant), clean);
    this.savePromptCache();
  }

  /**
   * Offline "Dream" consolidation pass (inspired by Anthropic's Components of Agent Memory):
   * Reviews recent drills, explorations, overrides, and mastery evidence to produce a ruthlessly
   * lean, always-loaded learner.md (~<=350 words), promoting recurring patterns and graduating
   * resolved blind spots so the agent's model of the learner grows with them.
   */
  async dream(input: DreamInput): Promise<DreamResult> {
    if (!this.apiKey && !this.plannerWorker && !this.agyWorker) {
      throw new Error("Configure OPENROUTER_API_KEY or MYELIN_JUDGE_MODEL to run Dream consolidation.");
    }

    const sys = `You are Myelin's offline memory consolidation ("Dream") pass.
Your job is to distill raw recent learning sessions into ONE ruthlessly lean, always-loaded Markdown file ("learner.md", STRICT MAX 320 WORDS) that predicts what future Myelin turns (drills, prompts, explorations, briefings) will need to accelerate this specific human's understanding.

CORE PRINCIPLES (Salience & Pruning beat Hoarding):
1. NEVER list individual facts/units—the Knowledge Map already stores all units. Store ONLY high-salience cognitive patterns about *how this learner thinks and learns*:
   - ## Baseline & Horizons — what they already hold cold (so the coach stops over-explaining basics) + active long-term learning arcs.
   - ## What Clicks & Style — concrete preferences and explanation formats that clearly work for them (e.g. shape traces, short code snippets, direct whiteboard fixes vs Socratic quizzing).
   - ## Active Blind Spots — ONLY genuine recurring error modes or conceptual friction seen across multiple turns/reps (NEVER one-off typos). Tie each to concrete signal.
   - ## Recent Breakthroughs — 1–3 fresh mental models they just consolidated that future prompts/explorations can build on.
2. GRADUATE RESOLVED BLIND SPOTS: Check Mastered units (high P_imm across reviews). If an old blind spot in Current memory has clearly been mastered, REMOVE it from Active Blind Spots and record it in "graduated".
3. RESPECT HUMAN EDITS: If Current memory was edited by the learner (updated_by="learner"), preserve their explicit preferences/notes unless directly superseded.
4. STAY STRICTLY UNDER 320 WORDS. Prune stale/low-salience lines aggressively; less is more.

Return ONLY valid JSON:
{"memory": string, "summary": string, "promoted": string[], "graduated": string[]}`;

    const masteredBlock =
      input.masteredUnits.length > 0
        ? input.masteredUnits
            .slice(0, 25)
            .map((u) => `- ${u.text} (P=${Math.round(u.p_imm * 100)}%, ${u.reviews} reviews${u.topic ? `, ${u.topic}` : ""})`)
            .join("\n")
        : "(none yet)";

    const shakyBlock =
      input.shakyUnits.length > 0
        ? input.shakyUnits
            .slice(0, 20)
            .map((u) => `- ${u.text} (P=${Math.round(u.p_imm * 100)}%, ${u.reviews} reviews${u.topic ? `, ${u.topic}` : ""})`)
            .join("\n")
        : "(none yet)";

    const attemptsBlock =
      input.recentAttempts.length > 0
        ? input.recentAttempts
            .slice(0, 12)
            .map((a, i) => {
              const turnLines = a.turns
                .slice(-4)
                .map((t) => `  Learner: ${t.user.slice(0, 260)}\n  Coach: ${t.coach.slice(0, 220)}`)
                .join("\n");
              return `Rep ${i + 1} [${a.status}, grade=${a.grade ?? "?"}] Unit: ${a.unitText.slice(0, 160)}\nPrompt: ${a.prompt.slice(0, 180)}\n${turnLines}`;
            })
            .join("\n\n")
        : "(no recent drill transcripts)";

    const expBlock =
      input.recentExplorations.length > 0
        ? input.recentExplorations
            .slice(0, 6)
            .map((e) => {
              const sample = e.turns
                .slice(-8)
                .map((t) => `  L: ${t.user.slice(0, 200)}\n  C: ${t.coach.slice(0, 200)}`)
                .join("\n");
              return `Exploration "${e.title}" (${e.turns.length} turns):\n${sample}`;
            })
            .join("\n\n")
        : "(no recent explorations)";

    const overridesBlock =
      input.recentOverrides.length > 0
        ? input.recentOverrides
            .slice(0, 12)
            .map((o) => `- ${o.unitText.slice(0, 120)} -> ${o.grade}${o.note ? ` (${o.note})` : ""}`)
            .join("\n")
        : "(none)";

    const user = [
      `Current memory (updated_by=${input.updatedBy}):\n${input.currentMemory.trim() || "(empty — first dream pass)"}`,
      `Mastered units (graduate any matching old blind spots!):\n${masteredBlock}`,
      `Shaky / active friction units:\n${shakyBlock}`,
      `Manual schedule overrides & audit adjustments:\n${overridesBlock}`,
      `Recent drill transcripts:\n${attemptsBlock}`,
      `Recent explorations:\n${expBlock}`,
    ].join("\n\n---\n\n");

    const t0 = Date.now();
    let agyTrace: AgyTurnTrace | undefined;
    let workerKind: PerfWorker = "openrouter";
    let raw = "";
    const worker = this.plannerWorker ?? this.agyWorker;
    if (worker) {
      const res = await this.askAgy({
        fallbackWorker: worker,
        fallbackWorkerName: this.plannerWorker ? "planner" : "agy",
        modelId: this.promptSlug,
        systemPrompt: sys,
        userPrompt: user,
        timeoutMs: 120_000,
        onTrace: (t) => {
          agyTrace = t;
        },
      });
      raw = res.raw;
      workerKind = res.worker;
    } else {
      const res = await this.fetchFn(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.promptModel,
          reasoning: { effort: "high" },
          temperature: 0.2,
          max_tokens: 2200,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      raw = data.choices?.[0]?.message?.content ?? "";
    }

    const parsed = parseJudgeJson<{
      memory?: string;
      summary?: string;
      promoted?: unknown;
      graduated?: unknown;
    }>(raw);
    if (!parsed || typeof parsed.memory !== "string" || !parsed.memory.trim()) {
      throw new Error("Dream pass did not return a valid memory update.");
    }
    const toList = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, 6)
        : [];
    this.perf?.record(
      this.buildPerf(t0, "dream", this.promptModel, workerKind, true, {
        background: true,
        trace: agyTrace,
        outputChars: raw.length,
        promptChars: user.length,
      }),
    );
    return {
      memory: parsed.memory.trim().slice(0, 1800),
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "Consolidated recent learning patterns.",
      promoted: toList(parsed.promoted),
      graduated: toList(parsed.graduated),
    };
  }

  private promptKey(unit: { id: string; text: string }, depth: Depth, restsOn: string[] = [], variant = 0): string {
    const depSig = restsOn.length > 0 ? restsOn.map((r) => r.slice(0, 24)).join("|") : "";
    return `v5:${unit.id}:${depth}:v${variant}:${depSig}:${unit.text}`;
  }

  /** Returns a cached prompt synchronously if already warmed, or null. */
  peekPrompt(unit: { id: string; text: string }, depth: Depth, restsOn: string[] = [], variant = 0): string | null {
    return this.promptCache.get(this.promptKey(unit, depth, restsOn, variant)) ?? null;
  }

  /** Prefetches uncached prompts in the background (runs up to 2 concurrent ACP sessions; yields to foreground misses). */
  warmPrompts(
    items: {
      unit: { id: string; text: string; kind: string; topic?: string | null };
      restsOn: string[];
      depth: Depth;
      variant?: number;
      priorPrompts?: string[];
      delayedTransfer?: boolean;
    }[],
  ): void {
    if (!this.apiKey && !this.promptWorker) return;
    const queue = items.filter((item) => {
      const key = this.promptKey(item.unit, item.depth, item.restsOn, item.variant ?? 0);
      return !this.promptCache.has(key) && !this.inflightPrompts.has(key);
    });
    if (queue.length === 0) return;
    const concurrency = this.acpClient && !this.acpClient.isUnsupported ? Math.min(2, queue.length) : 1;
    let cursor = 0;
    const runWorker = async () => {
      while (cursor < queue.length) {
        if (this.activeForegroundPrompts > 0) break;
        const item = queue[cursor++]!;
        const key = this.promptKey(item.unit, item.depth, item.restsOn, item.variant ?? 0);
        if (this.promptCache.has(key) || this.inflightPrompts.has(key)) continue;
        try {
          await this.promptFor(
            item.unit,
            item.restsOn,
            item.depth,
            {
              variant: item.variant,
              priorPrompts: item.priorPrompts,
              delayedTransfer: item.delayedTransfer,
            },
            true,
          );
        } catch {
          /* ignore background prefetch errors */
        }
      }
    };
    for (let i = 0; i < concurrency; i++) void runWorker();
  }

  /**
   * Generates a crisp, self-contained single-beat prompt without giving away the answer (cached per variant).
   * Background prefetch (`background=true`) uses high-reasoning `promptModel` (`gemini-4-neon-high`);
   * synchronous foreground cache misses (`background=false`) use fast `sidecarModel` (`gemini-4-hydrogen-medium`)
   * with a tight 20s ceiling so card loads never stall 35–110s waiting on a background prefetch.
   */
  async promptFor(
    unit: { id: string; text: string; kind: string; topic?: string | null },
    restsOn: string[],
    depth: Depth,
    opts: PromptContextOptions = {},
    background = false,
  ): Promise<string> {
    const variant = opts.variant ?? 0;
    const key = this.promptKey(unit, depth, restsOn, variant);
    const cached = this.promptCache.get(key);
    if (cached) return cached;
    const inflight = this.inflightPrompts.get(key);
    if (inflight && (background || !inflight.background)) return inflight.promise;

    if (!this.apiKey && !this.promptWorker) {
      const fallback = defaultPrompt(unit.text, unit.kind, restsOn, depth);
      this.promptCache.set(key, fallback);
      return fallback;
    }

    const goalByDepth: Record<Depth, string> = {
      recall:
        "Pose ONE motivating, self-contained question that puts the learner in the concrete problem or comparison where this unit matters—without naming the trick, decomposition pieces, or answer.",
      rebuild:
        "Pose ONE motivating problem or claim and ask the learner to derive or justify it from first principles, without hinting at the intermediate trick or naming the pieces of the result.",
      explain:
        "Present ONE concrete situation or surprising contrast and ask why it holds in 1-2 sentences, without spoiling the mechanism.",
      use: opts.delayedTransfer
        ? "HELD-OUT TRANSFER CHECK: Place this idea inside an unfamiliar, concrete situation where the learner must recognize THAT this idea applies and use it unaided—do NOT name the concept, trick, or theorem."
        : "Pose ONE concrete mini-scenario where the learner must choose and apply this idea themselves, without naming the concept, trick, or theorem.",
    };

    const promptSys = `Write ONE crisp, motivating, self-contained practice question (1-2 short sentences, max 34 words).
Rules:
- MOTIVATE, DON'T WORKSHEET: Frame a real problem, comparison, or curiosity trigger where the brain actually needs this idea—NEVER a disembodied textbook command ("Decompose X into A and B", "State formula Y", "What identity does trick Z use?").
- ZERO SPOILERS, ZERO RIDDLES: Name the starting setup/object clearly (e.g. standard attention $\\text{softmax}(QK^T)V$, a database write path, a sample mean $\\bar{x}$)—hide ONLY the solution, trick, or intermediate pivot, NEVER obfuscate the premise into a vague riddle ("interactions between all pairs of elements").
  - Bad (spoils & unmotivated): "How do you decompose $\\sum(x_i - \\mu)^2$ into spread around $\\bar{x}$ and the mean's offset from $\\mu$?"
  - Bad (vague riddle): "A model computes interactions between all pairs of elements—how do you avoid $O(L^2)$?"
  - Good (concrete setup, zero spoiler): "Standard attention computes $\\text{softmax}(QK^T)V$ in $O(L^2)$ time—how can you avoid forming the $L\\times L$ matrix for long sequences?"
  - Good (real trigger, zero spoiler): "For data $x_1,\\dots,x_n$ with sample mean $\\bar{x}$ and true mean $\\mu$, how much smaller is $\\sum(x_i - \\bar{x})^2$ than $\\sum(x_i - \\mu)^2$?"
  - Bad (spoils architecture): "How do you combine a write-ahead log with an in-memory buffer for fast durable writes?"
  - Good (real trigger): "A database must survive power loss without flushing random disk pages on every write—how do you keep writes both fast and durable?"
- NO SURFACE-CUE REPETITION: If Previously asked prompts are listed below, DO NOT reuse the same cover story, numbers, or phrasing—change what the learner must recognize or decide (a genuinely new context, boundary condition, or numerical regime).
- 100% SELF-CONTAINED COLD: Explicitly define every symbol or variable used (e.g. "a distribution $p_\\theta(x)$ parameterized by $\\theta$", never a bare undefined "$\\nabla p$").
- ONE SINGLE TASK: Never stack two separate demands ("...and also explain..."). Plain text, TeX in $…$ only when genuinely helpful, no meta-commentary.`;
    const prior = (opts.priorPrompts ?? []).filter(Boolean).slice(-3);
    const mem = trimLearnerMemory(opts.learnerMemory);
    const promptUser = [
      goalByDepth[depth],
      mem
        ? `Learner memory (use ONLY to match background level, preferred style, and target active blind spots—NEVER spoil the answer):\n${mem}`
        : "",
      unit.topic ? `Topic: ${unit.topic}` : "",
      `Unit (${unit.kind}): ${unit.text}`,
      `Rests on: ${restsOn.join("; ") || "nothing"}`,
      prior.length > 0 ? `Previously asked (MUST invent a fresh scenario/numbers/decision point, never repeat these):\n- ${prior.join("\n- ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const useFastFg = !background && this.isAgy;
    const modelForCall = useFastFg ? this.sidecarModel : this.promptModel;
    const slugForCall = useFastFg ? this.sidecarSlug : this.promptSlug;
    const fallbackWorkerForCall = useFastFg ? (this.sidecarWorker ?? this.promptWorker) : this.promptWorker;
    const timeoutMs = background ? 65_000 : 20_000;

    if (!background) this.activeForegroundPrompts++;
    const t0 = Date.now();
    const p = (async () => {
      let agyTrace: AgyTurnTrace | undefined;
      let workerKind: PerfWorker = "openrouter";
      try {
        let text: string | undefined;
        if (fallbackWorkerForCall) {
          const res = await this.askAgy({
            fallbackWorker: fallbackWorkerForCall,
            fallbackWorkerName: "prompt",
            modelId: slugForCall,
            systemPrompt: `${promptSys}\nAnswer directly with ZERO tool calls.`,
            userPrompt: promptUser,
            timeoutMs,
            onTrace: (t) => {
              agyTrace = t;
            },
          });
          workerKind = res.worker;
          text = res.raw.trim().replace(/^["']|["']$/g, "");
        } else {
          const res = await this.fetchFn(CHAT_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: modelForCall,
              reasoning: { effort: background ? "high" : "low" },
              temperature: 0.3,
              max_tokens: 2000,
              messages: [
                { role: "system", content: promptSys },
                { role: "user", content: promptUser },
              ],
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
            text = data.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, "");
          }
        }
        if (text) {
          this.promptCache.set(key, text);
          this.savePromptCache();
          this.perf?.record(
            this.buildPerf(t0, "prompt", modelForCall, workerKind, true, {
              background,
              cacheHit: false,
              trace: agyTrace,
              outputChars: text.length,
              promptChars: promptUser.length,
            }),
          );
          return text;
        }
      } catch (err) {
        console.error("[judge] promptFor failed:", err instanceof Error ? err.message : err);
        this.perf?.record(
          this.buildPerf(t0, "prompt", modelForCall, workerKind, false, {
            background,
            cacheHit: false,
            trace: agyTrace,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
      // Never cache a transient fallback in promptCache so the next load retries cleanly.
      return defaultPrompt(unit.text, unit.kind, restsOn, depth);
    })().finally(() => {
      if (this.inflightPrompts.get(key)?.promise === p) {
        this.inflightPrompts.delete(key);
      }
      if (!background) this.activeForegroundPrompts = Math.max(0, this.activeForegroundPrompts - 1);
    });

    this.inflightPrompts.set(key, { promise: p, background });
    // If a slow background neon-high prefetch was already running when a foreground user asked for
    // this exact card, race both so the learner gets whichever finishes first (typically ~2.5s)!
    if (!background && inflight?.background) {
      return Promise.race([p, inflight.promise]);
    }
    return p;
  }

  /**
   * Generates a plain-English, jargon-free Interactive Briefing for an unfamiliar paper, chapter,
   * codebase, or topic (diffed against the learner's existing Map) so they can read in ~2 minutes,
   * highlight/cite anything confusing or intriguing, and optionally stress-test the non-obvious cruxes.
   */
  async planFrontier(
    input: {
      request: string;
      existingUnits: { text: string; p_imm: number; reviews: number }[];
      learnerMemory?: string | null | undefined;
    },
    onPerf?: (rec: PerfRecord) => void,
    signal?: AbortSignal,
  ): Promise<PlannedFrontier> {
    const t0 = Date.now();
    if (!this.apiKey && !this.isAgy) {
      return {
        title: input.request.slice(0, 48).trim() || "New briefing",
        body: `### Overview\n\nConfigure \`OPENROUTER_API_KEY\` or \`MYELIN_JUDGE_MODEL=agy/...\` to generate plain-English briefings from local files or topics.`,
        skipped_known: [],
        cruxes: [],
      };
    }

    const sys = `You write extraordinarily clear, plain-English technical briefings that maximize human understanding per minute (for any domain: papers, book chapters, codebases, systems, math, science, etc.).

CRITICAL WRITING RULES:
- Write like a brilliant colleague explaining this at a whiteboard—NEVER like a compressed arXiv abstract or textbook blurb.
- ZERO UNINTRODUCED JARGON: Every domain-specific acronym, symbol, or term MUST be translated into plain, concrete English the VERY FIRST time it appears (e.g. "base pair (bp) — a single A/C/G/T letter in DNA"; "Hi-C — an experiment showing which distant parts of a DNA strand fold close together in 3D"). Never stack 3 acronyms in one sentence.
- If the learner names a local file, PDF, paper, book chapter, or codebase, inspect it read-only first so every claim, number, and mechanism is grounded in the real source.
- Diff against Existing Map units: don't re-explain basics the learner already owns solidly (p_imm >= 0.80); list 0-3 short skipped topics in "skipped_known".
- Format "body" as clean, scannable Markdown (roughly 250-450 words, readable in ~90-120 seconds):
  - Use 3-4 short \`###\` sections adapted to the source (e.g. \`### The problem\`, \`### The core idea\`, \`### How the pieces fit\`, \`### What actually proved it\`).
  - Short paragraphs (2-3 sentences max) and crisp bullets where helpful.
  - Anchor abstract ideas in concrete numbers or tiny intuitive examples (e.g. "1 million DNA letters" instead of just "$L_{\\text{bp}}$").
  - Use \`$...$\` for math only when it genuinely clarifies (define every symbol inline!).
- Also extract 2-4 "cruxes": ONLY genuinely non-obvious load-bearing insights/tradeoffs (NEVER trivial facts like "a sliding conv crosses boundaries"):
  - "text": 1 crisp self-contained unit statement suitable for spaced repetition.
  - "kind": "definition" | "move" | "distinction" | "result".
  - "source_ref": short location/anchor in the source (e.g. "Section 2.3", "Figure 1", "store.ts append()"), or "" if general topic.
  - "question": 1 sharp, consequential, source-grounded task (predict what breaks if an assumption flips, trace a changed input, or weigh a concrete design tradeoff—plain English, zero undefined jargon).
- Return ONLY valid JSON:
  {"title": string, "body": string, "skipped_known": string[], "cruxes": [{"text": string, "kind": string, "source_ref": string, "question": string}]}`;

    const knownLines = input.existingUnits
      .slice(0, 40)
      .map((u) => `- ${u.text} (${u.reviews > 0 ? `P=${Math.round(u.p_imm * 100)}%` : "untested"})`)
      .join("\n");

    const mem = trimLearnerMemory(input.learnerMemory);
    const user = [
      mem ? `Learner memory (calibrate assumed background & explanation style):\n${mem}` : "",
      `Learner wants to understand: ${input.request.trim()}`,
      knownLines ? `Existing Map units (skip re-explaining what is already solid):\n${knownLines}` : "Existing Map units: none yet.",
    ]
      .filter(Boolean)
      .join("\n\n");

    let agyTrace: AgyTurnTrace | undefined;
    let workerKind: PerfWorker = "openrouter";
    let raw = "";
    try {
      if (this.plannerWorker) {
        const res = await this.askAgy({
          fallbackWorker: this.plannerWorker,
          fallbackWorkerName: "planner",
          modelId: this.promptSlug,
          systemPrompt: sys,
          userPrompt: user,
          timeoutMs: 120_000,
          signal,
          onTrace: (t) => {
            agyTrace = t;
          },
        });
        raw = res.raw;
        workerKind = res.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.promptModel,
            reasoning: { effort: "high" },
            temperature: 0.2,
            max_tokens: 3200,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
      }

      const parsed = parseJudgeJson<{
        title?: string;
        body?: string;
        skipped_known?: unknown;
        cruxes?: unknown;
      }>(raw);

      if (!parsed || typeof parsed.body !== "string" || !parsed.body.trim()) {
        throw new Error("Could not build a briefing from that request—try naming a specific file, paper, chapter, or topic.");
      }

      const cruxes: PlannedBriefingCrux[] = Array.isArray(parsed.cruxes)
        ? parsed.cruxes
            .filter(
              (c): c is { text: string; kind?: string; source_ref?: string; question: string } =>
                typeof c?.text === "string" && c.text.trim().length > 4 && typeof c?.question === "string" && c.question.trim().length > 4,
            )
            .slice(0, 4)
            .map((c) => ({
              text: c.text.trim(),
              kind: typeof c.kind === "string" && c.kind.trim() ? c.kind.trim() : "result",
              question: c.question.trim(),
              ...(typeof c.source_ref === "string" && c.source_ref.trim() ? { source_ref: c.source_ref.trim() } : {}),
            }))
        : [];

      this.emitPerf(
        this.buildPerf(t0, "briefing-plan", this.promptModel, workerKind, true, {
          trace: agyTrace,
          outputChars: raw.length,
          promptChars: user.length,
        }),
        onPerf,
      );
      return {
        title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : input.request.slice(0, 48).trim(),
        body: parsed.body.trim(),
        skipped_known: Array.isArray(parsed.skipped_known)
          ? parsed.skipped_known.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 4)
          : [],
        cruxes,
      };
    } catch (err) {
      this.emitPerf(
        this.buildPerf(t0, "briefing-plan", this.promptModel, workerKind, false, {
          trace: agyTrace,
          aborted: isAbortError(err) || signal?.aborted,
          error: err instanceof Error ? err.message : String(err),
        }),
        onPerf,
      );
      throw err;
    }
  }

  /**
   * Fast live partner for an Interactive Briefing: answers cited questions cleanly in plain English
   * (looking back at the local source file read-only if needed), or runs opt-in "Test me" checks on
   * the genuinely non-obvious cruxes and crystallizes real insights into the learner's Map.
   */
  async discussBriefing(
    input: {
      sessionKey?: string | undefined;
      title: string;
      source: string;
      body: string;
      cruxes: PlannedBriefingCrux[];
      demonstratedCruxes?: number[] | undefined;
      turns: { role: "user" | "assistant"; text: string }[];
      reply: string;
      testMe?: boolean | undefined;
      sketchDataUrl?: string | null | undefined;
      existingUnits: string[];
      activeHabits: string[];
      learnerMemory?: string | null | undefined;
    },
    onText?: (partialMessage: string) => void,
    onPerf?: (rec: PerfRecord) => void,
    signal?: AbortSignal,
  ): Promise<ExploreResult> {
    const t0 = Date.now();
    if (!this.apiKey && !this.isAgy) {
      return {
        message: "Configure OPENROUTER_API_KEY or MYELIN_JUDGE_MODEL=agy/... for live discussion.",
        suggested_units: [],
        failed: true,
      };
    }

    const sys = `You are Myelin's sharp, plain-English research & learning partner discussing "${input.title}" (source: ${input.source}).

Rules:
- ALWAYS speak directly in second person ("You..."). Keep replies clear, concrete, and jargon-free (2-4 crisp sentences or short steps; define any new term inline in plain English). No praise fluff, no exclamation marks, no textbook walls.
- If the learner cites a passage or asks a clarifying/deepening question ("what is X?", "why does Y happen?", "derive Z"):
  - Answer directly and clearly first—do NOT force a quiz question onto a simple clarification! Only leave a short follow-up question when it genuinely sharpens an intuition they're actively exploring.
  - If they ask about a detail, equation, table, or code snippet from the source that isn't in the briefing summary, you MAY inspect the local source file read-only to give an exact, grounded answer.
- If the learner asks to be tested ("Test me" or "quiz me"):
  - Pick ONE untested crux below and ask ONE consequential, source-grounded task (predict what breaks under a changed assumption, trace an edge case, or explain a core tradeoff in plain English). If they get stuck, show one concrete worked step and let them finish the next.
  - When the learner genuinely demonstrates a crux in their own words, set "demonstrated_crux_index" to its 0-based index (otherwise null), confirm cleanly, and move to the next untested crux (or wrap up naturally once all are covered).
- suggested_units: ONLY when a genuinely reusable, concrete unit of understanding clearly crystallizes from what the learner just demonstrated or unpacked, include 1 (at most 2) crisp self-contained one-sentence unit(s). Most clarification turns should return []. Set observe_only=true ONLY for a meta-cognitive Thinking Move; false for knowledge/skill units.
- Return ONLY valid JSON with "message" FIRST: {"message": string, "demonstrated_crux_index": number|null, "suggested_units": [{"text": string, "kind": string, "observe_only": boolean}]}`;

    const thread = input.turns
      .slice(-20)
      .map((t) => `${t.role === "user" ? "Learner" : "Coach"}: ${t.text}`)
      .join("\n");

    const doneSet = new Set(input.demonstratedCruxes ?? []);
    const cruxLines = input.cruxes
      .map((c, i) => `${i}. [${c.kind}${doneSet.has(i) ? ", already demonstrated" : ""}${c.source_ref ? ` · ${c.source_ref}` : ""}] ${c.text}\n   Task: ${c.question}`)
      .join("\n");

    const mem = trimLearnerMemory(input.learnerMemory);
    const latestLine = input.testMe
      ? `Learner clicked "Test me" (already demonstrated cruxes: [${[...doneSet].join(",")}]): ${input.reply.trim() || "Pose one consequential, source-grounded task on the next untested crux."}`
      : `Learner latest message:\n${input.reply.trim() || "(see attached sketch)"}`;

    const lines = [
      mem ? `Learner memory:\n${mem}` : "",
      `Briefing shown to learner:\n${input.body}`,
      cruxLines ? `Core non-obvious cruxes (0-indexed, for "Test me" mode):\n${cruxLines}` : "",
      input.activeHabits.length ? `Active thinking moves:\n- ${input.activeHabits.slice(0, 8).join("\n- ")}` : "",
      thread ? `Discussion so far:\n${thread}` : "",
      latestLine,
    ].filter(Boolean);

    const fullUser = lines.join("\n\n");
    const expectedPriorTurns = Math.floor(input.turns.length / 2);

    const userContent: unknown = input.sketchDataUrl
      ? [
          { type: "text", text: fullUser },
          { type: "image_url", image_url: { url: input.sketchDataUrl } },
        ]
      : fullUser;

    let agyTrace: AgyTurnTrace | undefined;
    let ttftProseMs: number | undefined;
    let proseMs: number | undefined;
    let tailJsonMs: number | undefined;
    let workerKind: PerfWorker = "openrouter";
    try {
      let raw = "";
      if (this.agyWorker) {
        const out = await this.askJsonWithTrace({
          fallbackWorker: this.agyWorker,
          fallbackWorkerName: "agy",
          modelId: this.exploreSlug,
          systemPrompt: sys,
          userPrompt: fullUser,
          deltaPrompt: input.turns.length > 0 ? latestLine : undefined,
          sessionKey: input.sessionKey,
          expectedPriorTurns: input.turns.length > 0 ? expectedPriorTurns : undefined,
          sketchDataUrl: input.sketchDataUrl,
          signal,
          onText,
        });
        raw = out.raw;
        agyTrace = out.trace;
        ttftProseMs = out.ttftProseMs;
        proseMs = out.proseMs;
        tailJsonMs = out.tailJsonMs;
        workerKind = out.worker;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            model: this.exploreModel,
            reasoning: { effort: this.llmEffort },
            temperature: 0.2,
            max_tokens: 1800,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: userContent },
            ],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        raw = data.choices?.[0]?.message?.content ?? "";
      }
      const parsed = parseJudgeJson<{
        message?: string;
        demonstrated_crux_index?: number | null;
        suggested_units?: { text?: string; kind?: string; observe_only?: boolean }[];
      }>(raw);
      if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
        const suggested = Array.isArray(parsed.suggested_units)
          ? parsed.suggested_units
              .filter((u): u is { text: string; kind?: string; observe_only?: boolean } => typeof u?.text === "string" && u.text.trim().length > 4)
              .slice(0, 2)
              .map((u) => ({
                text: u.text.trim(),
                kind: typeof u.kind === "string" && u.kind.trim() ? u.kind.trim() : u.observe_only ? "thinking move" : "result",
                observe_only: Boolean(u.observe_only),
              }))
          : [];
        const demoIdx =
          typeof parsed.demonstrated_crux_index === "number" &&
          Number.isInteger(parsed.demonstrated_crux_index) &&
          parsed.demonstrated_crux_index >= 0 &&
          parsed.demonstrated_crux_index < input.cruxes.length
            ? parsed.demonstrated_crux_index
            : null;
        this.emitPerf(
          this.buildPerf(t0, "briefing", this.exploreModel, workerKind, true, {
            trace: agyTrace,
            ttftProseMs,
            proseMs,
            tailJsonMs,
            outputChars: raw.length,
            promptChars: fullUser.length,
          }),
          onPerf,
        );
        return {
          message: parsed.message.trim(),
          suggested_units: suggested,
          ...(demoIdx !== null ? { demonstrated_crux_index: demoIdx } : {}),
        };
      }
      if (raw.trim()) {
        this.emitPerf(
          this.buildPerf(t0, "briefing", this.exploreModel, workerKind, true, {
            trace: agyTrace,
            outputChars: raw.length,
            promptChars: fullUser.length,
          }),
          onPerf,
        );
        return { message: raw.trim(), suggested_units: [] };
      }
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) {
        this.emitPerf(this.buildPerf(t0, "briefing", this.exploreModel, workerKind, false, { trace: agyTrace, aborted: true, error: "aborted" }), onPerf);
        throw err;
      }
      this.emitPerf(
        this.buildPerf(t0, "briefing", this.exploreModel, workerKind, false, {
          trace: agyTrace,
          error: err instanceof Error ? err.message : String(err),
        }),
        onPerf,
      );
    }
    return { message: "Could not reach the coach just now.", suggested_units: [], failed: true };
  }
}

function defaultPrompt(text: string, kind: string, restsOn: string[], depth: Depth): string {
  if (depth === "rebuild") {
    return restsOn.length
      ? `Rebuild this ${kind} from ${restsOn[0]}: ${shortCue(text)}`
      : `Rebuild this ${kind} from scratch: ${shortCue(text)}`;
  }
  if (depth === "explain") return `Explain this clearly to a newcomer: ${shortCue(text)}`;
  if (depth === "use") return `Apply this ${kind} to a concrete example of your own: ${shortCue(text)}`;
  return `Recall this ${kind}: ${shortCue(text)}`;
}

function shortCue(text: string): string {
  const idx = text.indexOf(":");
  if (idx > 3 && idx < 45) return text.slice(0, idx).trim();
  if (text.length <= 72) return text;
  const cut = text.slice(0, 72);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
