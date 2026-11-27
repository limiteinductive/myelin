// Domain-agnostic two-tier fast judge for live Micro-Production reps:
//   System 1 (Jev via OpenRouter Decisions API): ~200-700ms calibrated probabilities (demonstrated,
//     cot_gap, clarity, habit_applied). High-confidence clean attempts pass immediately without
//     waiting for prose generation.
//   System 2 (Fast generative LLM via OpenRouter): called on low-confidence attempts, reasoning
//     gaps, sketches/images, or explicit hint requests. Returns 1-2 crisp sentences: either a
//     surgical question pointing at the exact leap/flaw, or a concise confirmation.
import { createHash, randomInt } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Depth, Grade } from "@myelin/core";
import { AgyAcpClient, type AgyAcpAskOptions, type AgyTurnTrace } from "./agy-acp.js";
import { PerfLog, type PerfOp, type PerfRecord, type PerfWorker } from "./perf.js";
import type { RepModality } from "./rwkv.js";
import { resolveAgyBinary } from "./tutor/agy.js";

export type { AgyTurnTrace, RepModality };
export { AgyAcpClient };

export interface JudgeHistoryItem {
  attempt: string;
  feedback: string;
}

export interface McqChoice {
  id: string;
  text: string;
}

export interface McqSpec {
  version: 1;
  item_id: string;
  choices: [McqChoice, McqChoice, McqChoice, McqChoice];
  correct_id: string;
  explanation: string;
  why_wrong: Record<string, string>;
}

export interface PromptCacheEntry {
  prompt: string;
  crux?: string | undefined;
  modality?: RepModality | undefined;
  starter?: string | undefined;
  mcq?: McqSpec | undefined;
}

const STARTER_PROSE_LIST_RE = /^\s*(?:\d+[.)]|[-•*])\s+[A-Z][a-z]+/;
const STARTER_CODE_LINE_RE =
  /(^\s*#\s|\bdef\s|\breturn\s|\btorch\.|\bnp\.|\beinsum\b|\bdim=|\bkeepdim|\bfor\s+\w+\s+in\b|\bif\s+\w+|^[a-zA-Z_]\w*(?:\s*,\s*[a-zA-Z_]\w*)*\s*=\s*)/m;

/**
 * Returns true ONLY when a starter is genuine code (e.g. PyTorch/NumPy/Python assignments or calls)
 * rather than English prose mad-libs ("1. Logit scale grows with ___ and ___.").
 */
export function isCodeSkeletonStarter(starter: string): boolean {
  const s = starter.trim();
  if (s.length < 6) return false;
  if (STARTER_PROSE_LIST_RE.test(s)) return false;
  if (/\$[^$]+\$/.test(s)) return false;
  const nonEmptyLines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (nonEmptyLines.length === 0) return false;
  const proseLikeLines = nonEmptyLines.filter(
    (l) => !l.startsWith("#") && (/\?\s*$/.test(l) || /^[A-Z][a-z]+\s+[a-z]+\s+[a-z]+/.test(l)),
  );
  if (proseLikeLines.length > 0) return false;
  return STARTER_CODE_LINE_RE.test(s);
}

const BANNED_MCQ_PATTERNS = [
  /\ball of the above\b/i,
  /\bnone of the above\b/i,
  /\bboth\s+[a-d1-4]\s+and\s+[a-d1-4]\b/i,
  /\b(?:option|choice)\s*[a-d1-4]\b/i,
];

function normChoiceText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").replace(/[.?!,:;]+$/g, "").trim();
}

/**
 * Strictly validates a server-private MCQ spec before caching or serving:
 * - Exactly 4 unique choices with normalized distinct non-empty text
 * - `correct_id` matches one of the 4 choice IDs
 * - `why_wrong` covers EVERY distractor and NO extra/correct keys
 * - No banned meta-options ("all/none of the above", option-position references)
 * - Balanced length (key is not conspicuously >2.5x longer than median distractor)
 * - Balanced `$` math delimiters so KaTeX renders cleanly
 */
export function validateMcqSpec(raw: unknown): McqSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.choices) || o.choices.length !== 4) return null;
  const choices: McqChoice[] = [];
  const ids = new Set<string>();
  const norms = new Set<string>();
  for (const item of o.choices) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    const id = typeof c.id === "string" ? c.id.trim() : "";
    const text = typeof c.text === "string" ? c.text.trim() : "";
    if (!id || !text || text.length > 260) return null;
    if (ids.has(id)) return null;
    const norm = normChoiceText(text);
    if (!norm || norms.has(norm)) return null;
    if (BANNED_MCQ_PATTERNS.some((re) => re.test(text))) return null;
    const unescapedDollars = text.replace(/\\\$/g, "").match(/\$/g)?.length ?? 0;
    if (unescapedDollars % 2 !== 0) return null;
    ids.add(id);
    norms.add(norm);
    choices.push({ id, text });
  }
  const correctId = typeof o.correct_id === "string" ? o.correct_id.trim() : "";
  if (!correctId || !ids.has(correctId)) return null;
  const explanation = typeof o.explanation === "string" ? o.explanation.trim() : "";
  if (explanation.length < 10) return null;
  if (!o.why_wrong || typeof o.why_wrong !== "object") return null;
  const whyRaw = o.why_wrong as Record<string, unknown>;
  const whyWrong: Record<string, string> = {};
  const distractorIds = choices.filter((c) => c.id !== correctId).map((c) => c.id);
  for (const did of distractorIds) {
    const reason = typeof whyRaw[did] === "string" ? whyRaw[did]!.trim() : "";
    if (reason.length < 8) return null;
    whyWrong[did] = reason;
  }
  if (Object.keys(whyRaw).some((k) => !distractorIds.includes(k) && k !== correctId)) {
    // Drop unexpected keys rather than storing junk; reject if missing any distractor (checked above).
  }
  // Length balance guard: prevent giveaway where the correct option is vastly longer than distractors.
  const keyLen = choices.find((c) => c.id === correctId)!.text.length;
  const distLens = choices
    .filter((c) => c.id !== correctId)
    .map((c) => c.text.length)
    .sort((a, b) => a - b);
  const medianDist = distLens[1] ?? distLens[0] ?? 1;
  if (keyLen > Math.max(45, medianDist * 2.5)) return null;
  if (distLens[0]! < Math.max(4, keyLen * 0.25) && keyLen > 60) return null;

  const itemId =
    typeof o.item_id === "string" && o.item_id.trim()
      ? o.item_id.trim()
      : createHash("sha256")
          .update(choices.map((c) => `${c.id}:${c.text}`).join("|") + "|" + correctId)
          .digest("hex")
          .slice(0, 16);

  return {
    version: 1,
    item_id: itemId,
    choices: choices as [McqChoice, McqChoice, McqChoice, McqChoice],
    correct_id: correctId,
    explanation,
    why_wrong: whyWrong,
  };
}

export interface JudgeInput {
  /** Optional stable drill attempt ID used as KV-cached ACP session key (`drill:<attemptId>`). */
  sessionKey?: string | undefined;
  prompt: string;
  /** Prompt-scoped single claim needed to pass THIS prompt (prevents grading unasked unit clauses). */
  expectedCrux?: string | undefined;
  /** True when this is a newly told unit's first active production (acquisition, not a memory lapse). */
  firstContact?: boolean | undefined;
  /** True when the learner clicked "Show pivot" to reveal the key move directly and close the rep. */
  showPivot?: boolean | undefined;
  /** Optional companion unit texts covered jointly in a multi-unit synthesis rep. */
  bundledUnits?: string[] | undefined;
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

export interface DreamMergeProposal {
  keep_id: string;
  merge_ids: string[];
  text?: string | undefined;
}

export interface DreamLinkProposal {
  unit_id: string;
  rests_on: string[];
}

export interface DreamInput {
  currentMemory: string;
  updatedBy: "dream" | "learner";
  masteredUnits: { text: string; topic?: string | null; p_imm: number; reviews: number }[];
  shakyUnits: { text: string; topic?: string | null; p_imm: number; reviews: number }[];
  /** Full active unit catalog (compact) so Dream can compact duplicates, link prereqs, and retire baseline trivia. */
  allUnits?: {
    id: string;
    text: string;
    kind: string;
    topic?: string | null;
    rests_on: string[];
    p_imm: number;
    reviews: number;
  }[];
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
  merges?: DreamMergeProposal[] | undefined;
  retire_ids?: string[] | undefined;
  links?: DreamLinkProposal[] | undefined;
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
  modality?: RepModality | undefined;
  bundledUnits?: { id: string; text: string; kind: string }[] | undefined;
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

function trimLearnerMemory(mem: string | null | undefined, maxChars = 3200): string {
  const clean = (mem ?? "").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  const slice = clean.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  if (lastNewline >= maxChars * 0.7) return slice.slice(0, lastNewline).trimEnd();
  const lastPeriod = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(".\n"));
  if (lastPeriod >= maxChars * 0.7) return slice.slice(0, lastPeriod + 1).trimEnd();
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace >= maxChars * 0.7 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`;
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
  const nonAttemptRe =
    /^(i\s+(have\s+)?no\s+ideas?|no\s+ideas?|i\s+don'?t\s+know|i\s+dont\s+know|idk|dunno|not\s+sure|lost|confused|help|stuck|blank|skip|pass)[\s.!?]*$/;
  if (nonAttemptRe.test(t)) return true;
  const firstLine = t.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (nonAttemptRe.test(firstLine)) return true;
  // Only treat trailing "?" as a non-attempt when it's actually an interrogative question
  // (e.g. "what is p here?"), NOT a substantive answer with a casual "?" (e.g. "sigma**2/n?").
  if (t.endsWith("?") && /^(what|why|how|when|where|which|who|is|are|do|does|did|can|could|should|wait|clarify)\b/.test(firstLine)) {
    return true;
  }
  return false;
}

const DRILL_COACH_SYSTEM = `You are a sharp, domain-agnostic learning partner inside Myelin (any subject: math, coding, systems, science, languages, writing, etc.).
Your goal is maximum genuine human understanding per minute—NOT exam proctoring or tedious multi-turn Socratic interrogation.

1. PROMPT-SCOPED GRADING (NO GOALPOST MOVING):
- Grade STRICTLY against what "Prompt asked" (and "Expected crux for this prompt", when given) actually asked for.
- NEVER reject a correct answer just because "Target unit" mentions an extra unasked clause, paper constant, or side detail.
- Accept messy shorthand, typos, unfinished formatting, and valid alternative routes.
- CASUAL "?" ON A RIGHT ANSWER: If the learner writes the right core answer ending in "?" (e.g. "$\\sigma^2/n?$"), PASS it right away (ok=true, grade="hard") with a crisp 1-line confirmation instead of rejecting it and forcing a 90s proof! Only ask a follow-up if the guess is actually wrong, circular, or missing a load-bearing piece.

2. TARGET-SCOPED TURN LOOP (GRADE THE CRUX, NEVER RAW TURN COUNT):
- Clarifying questions & partial sub-step checks (e.g. asking about notation/shapes/axes, or sanity-checking one intermediate piece like \`dbeta\` while main blanks like \`dx_ln\`/\`dx_rms\` remain unattempted):
  - Answer or confirm ONLY that specific point in 1-2 crisp sentences.
  - NEVER reveal or spoil the remaining unattempted blanks/crux!
  - Keep the rep open (ok=false, grade="again"). Clarifying questions and partial progress do NOT count as failed crux attempts.
- Substantive attempt at the full crux (or explicit stuckness like "idk"):
  - If they landed what the prompt asked: set ok=true with a crisp confirmation (<=10 words).
  - On the 1st crux miss/slip or stall: set ok=false, grade="again", and give ONE surgical nudge (max 35 words) pointing at the missing pivot without telegraphing the exact symbol/answer.
  - On a 2nd failed attempt at the SAME crux, explicit give-up, clicking "Show answer" (SHOW_ANSWER), or HARD_TURN_CAP: STOP quizzing! State the clean answer in 1-3 whiteboard sentences and CLOSE THE REP with ok=true AND grade="again" (never mark a revealed/missed rep as "hard" or "good").
- Decouple ok (rep closed) from grade (spaced-repetition consolidation rating):
  - Clean unassisted production (including after ONLY neutral prompt/setup clarifications): grade="good" or "easy" (or "hard" if tentative/slow).
  - Learner landed the crux themselves after a sub-step explanation or 1 surgical slip nudge: grade="hard".
  - Coach revealed the answer (2nd crux miss, give-up, SHOW_ANSWER, or HARD_TURN_CAP miss): ok=true, grade="again".
  - When ok=false: grade="again".

General rules:
- ALWAYS speak directly in second person ("You..."). Never say "The learner..." or "The attempt...". Stay crisp and strictly on-topic.
- annotations: OPTIONAL array of AT MOST 1–2 grounded inline pins anchored onto exact verbatim substrings of the learner's latest text (kind="slip"|"question"|"move", note max 22 words). Leave [] on short 1-line answers, "no idea" replies, or when message alone is already clear.
- missing_prereqs: ONLY when a genuinely missing, reusable atomic prerequisite underneath this unit appears; include at most 1 crisp one-sentence unit, otherwise [].
- Put mathematical variables, dimensions, and tensor shapes (e.g. $Q$, $T=1$, $(B, H, T, D)$) in $...$; reserve backticks ONLY for literal code identifiers or strings (like \`torch.einsum\`, \`keepdim=True\`), and put any code expression over ~40 chars in a fenced \`\`\` block. No praise fluff, no exclamation marks. Answer directly with ZERO tool calls.
- Return ONLY valid JSON with "message" FIRST so prose can stream cleanly: {"message": string, "ok": boolean, "grade": "again"|"hard"|"good"|"easy", "annotations": [{"quote": string, "note": string, "kind": "slip"|"question"|"move"}], "habit_observed": string|null, "missing_prereqs": [{"text": string, "kind": string}]}`;

const EXPLORE_HOT_SYSTEM = `You are Myelin's sharp, peer-level reasoning partner inside a focused exploration (any domain: math, coding, systems, science, papers, writing).

Role of Explore vs. Drills:
- Explore is for building a real mental model and surfacing gaps so spaced-repetition Drills can verify retention later. Do NOT turn Explore into a tedious mini-drill.
- Speak like a brilliant colleague at a whiteboard—direct, concise, zero robotic filler. NEVER open with "You're correct that...", "You've correctly identified...", "You're on the right track.", or "You're thinking about...". Start straight with the substance.
- SEPARATE EXPLANATION ("message") FROM QUESTION ("question"):
  - Put ONLY your explanation, feedback, math, or code in "message" (2-4 crisp sentences, or a tiny code/math block; put math variables/shapes like $Q$, $(B, H, T, D)$ in $...$ with double-escaped backslashes in JSON like \\\\times, \\\\frac; reserve backticks strictly for literal code identifiers/strings and use fenced blocks for expressions over ~40 chars; no fluff, no exclamation marks).
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
  private readonly promptCache = new Map<string, PromptCacheEntry>();
  private readonly inflightPrompts = new Map<string, { promise: Promise<PromptCacheEntry>; background: boolean }>();
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
      const data = JSON.parse(readFileSync(this.cachePath, "utf8")) as Record<
        string,
        string | { prompt?: string; crux?: string; modality?: RepModality; starter?: string; mcq?: unknown }
      >;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string" && v.trim()) {
          this.promptCache.set(k, { prompt: v.trim() });
        } else if (v && typeof v === "object" && typeof v.prompt === "string" && v.prompt.trim()) {
          const crux = typeof v.crux === "string" && v.crux.trim() ? v.crux.trim() : undefined;
          const starter = typeof v.starter === "string" && v.starter.trim() ? v.starter.trim() : undefined;
          const modality =
            v.modality === "direct" ||
            v.modality === "fix_bug" ||
            v.modality === "faded_skeleton" ||
            v.modality === "contrast" ||
            v.modality === "synthesis" ||
            v.modality === "mcq"
              ? v.modality
              : undefined;
          if (modality === "mcq") {
            const validMcq = validateMcqSpec(v.mcq);
            if (!validMcq) continue;
            this.promptCache.set(k, {
              prompt: v.prompt.trim(),
              ...(crux ? { crux } : {}),
              modality: "mcq",
              mcq: validMcq,
            });
            continue;
          }
          // Evict legacy prose mad-lib starters on synthesis/faded_skeleton so they regenerate as clean open prompts.
          if (
            starter &&
            (modality === "synthesis" || modality === "faded_skeleton") &&
            !isCodeSkeletonStarter(starter)
          ) {
            continue;
          }
          this.promptCache.set(k, {
            prompt: v.prompt.trim(),
            ...(crux ? { crux } : {}),
            ...(modality ? { modality } : {}),
            ...(starter ? { starter } : {}),
          });
        }
      }
    } catch {
      /* ignore corrupt cache */
    }
  }

  private savePromptCache(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const obj: Record<string, string | PromptCacheEntry> = {};
      for (const [k, v] of this.promptCache) {
        obj[k] = v.crux || v.starter || (v.modality && v.modality !== "direct") ? v : v.prompt;
      }
      writeFileSync(this.cachePath, JSON.stringify(obj, null, 2), "utf8");
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
    if (this.jevEnabled && !hasSketch && !input.showPivot && !isLikelyNonAttempt(input.attempt)) {
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
      input.expectedCrux?.trim() ? `Expected crux for this prompt (grade STRICTLY against this; do NOT require unasked unit clauses): ${input.expectedCrux.trim()}` : "",
      `Target unit (${input.unitKind}, depth ${input.depth}): ${input.unitText}`,
      input.bundledUnits?.length ? `Also covered in this synthesis rep: ${input.bundledUnits.join(" | ")}` : "",
      input.restsOn.length ? `Rests on: ${input.restsOn.join("; ")}` : "Rests on: nothing (arbitrary/seed)",
      `First contact (newly told): ${input.firstContact ? "yes" : "no"}`,
      input.showPivot ? 'Resolution mode: SHOW_ANSWER (learner clicked Show answer — state the clean answer in 1-3 whiteboard sentences and close the rep with ok=true, grade="again").' : "",
      input.activeHabits?.length ? `Active thinking moves being trained: ${input.activeHabits.join("; ")}` : "",
      jev ? `System-1 quick check: P(demonstrated)=${jev.demonstrated.toFixed(2)}, P(cot_gap)=${jev.cot_gap.toFixed(2)}` : "",
      historyBlock,
      input.showPivot
        ? `Current learner attempt:\n${input.attempt.trim() || "(requested direct pivot)"}`
        : `Current learner attempt:\n${input.attempt.trim() || "(see attached sketch)"}`,
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
      const finalOk = input.showPivot ? true : parsed.ok;
      const grade: Grade = finalOk
        ? input.showPivot
          ? "again"
          : parsed.grade && ["again", "hard", "good", "easy"].includes(parsed.grade)
            ? parsed.grade
            : inferGrade(input.latencyMs, input.hintsUsed, jev?.clarity)
        : "again";
      const missingPrereqs = this.parsePrereqs(parsed.missing_prereqs);
      const annotations = this.parseAnnotations(parsed.annotations, input.attempt);
      if (finalOk && input.sessionKey) this.closeSession(input.sessionKey);
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
        ok: finalOk,
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
      expectedCrux?: string | undefined;
      firstContact?: boolean | undefined;
      showPivot?: boolean | undefined;
      bundledUnits?: string[] | undefined;
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
    const forceDirectPivot = Boolean(input.showPivot) || input.turns.length >= 6;
    const resolutionNote = input.showPivot
      ? 'Resolution mode: SHOW_ANSWER (learner clicked Show answer — state the clean answer in 1-3 whiteboard sentences and close the rep with ok=true, grade="again").'
      : forceDirectPivot
        ? 'Resolution mode: HARD_TURN_CAP (turn cap reached — if they landed the crux themselves, confirm crisply with ok=true, grade="hard"; if they still missed, state the clean answer in 1-3 whiteboard sentences and close the rep with ok=true, grade="again").'
        : "";
    const fullUser = [
      mem ? `Learner memory (calibrate framing & spot recurring blind spots; never leak answers):\n${mem}` : "",
      `Prompt asked: ${input.prompt}`,
      input.expectedCrux?.trim() ? `Expected crux for this prompt (grade STRICTLY against this; do NOT require unasked unit clauses): ${input.expectedCrux.trim()}` : "",
      `Target unit (${input.unitKind}, depth ${input.depth}): ${input.unitText}`,
      input.bundledUnits?.length ? `Also covered in this synthesis rep: ${input.bundledUnits.join(" | ")}` : "",
      input.restsOn.length ? `Rests on: ${input.restsOn.join("; ")}` : "",
      `First contact (newly told): ${input.firstContact ? "yes" : "no"}`,
      resolutionNote,
      input.activeHabits?.length ? `Active thinking moves being trained: ${input.activeHabits.join("; ")}` : "",
      `Learner initial beat:\n${input.attempt.trim() || "(empty)"}`,
      `Initial coach response: ${input.feedback}`,
      thread ? `Exchange so far:\n${thread}` : "",
      `${input.revisedAttempt ? "Learner revised full derivation in place" : "Learner latest beat"}:\n${input.reply.trim() || (input.showPivot ? "(requested direct pivot)" : "(see attached sketch)")}`,
    ]
      .filter(Boolean)
      .join("\n");

    const deltaUser = [
      resolutionNote,
      `${input.revisedAttempt ? "Learner revised full derivation in place" : "Learner latest beat"}:\n${input.reply.trim() || (input.showPivot ? "(requested direct pivot)" : "(see attached sketch)")}`,
    ]
      .filter(Boolean)
      .join("\n");
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
        const finalOk = forceDirectPivot ? true : parsed.ok;
        const missedAtCap = forceDirectPivot && !parsed.ok;
        const grade: Grade = finalOk
          ? input.showPivot || missedAtCap
            ? "again"
            : parsed.grade && ["again", "hard", "good", "easy"].includes(parsed.grade)
              ? parsed.grade
              : "hard"
          : "again";
        const missingPrereqs = this.parsePrereqs(parsed.missing_prereqs);
        const annotations = this.parseAnnotations(parsed.annotations, input.reply);
        if (finalOk && input.sessionKey) this.closeSession(input.sessionKey);
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
          ok: finalOk,
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
    crux?: string,
  ): void {
    const clean = prompt.trim();
    if (!clean) return;
    this.promptCache.set(this.promptKey(unit, depth, restsOn, variant), {
      prompt: clean,
      ...(crux?.trim() ? { crux: crux.trim() } : {}),
    });
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
5. CONSERVATIVE MAP COMPACTION (optional — only when Active unit catalog is provided):
   - "merges" (max 3): ONLY merge genuine duplicates or near-identical restatements (e.g. two formulas differing only by variable name). Set "keep_id" to the unit with more reviews/stronger wording, "merge_ids" to redundant duplicate IDs, and optional cleaner "text". Never merge distinct concepts.
   - "retire_ids" (max 3): ONLY retire trivially mastered baseline facts/vocabulary that already have reviews >= 3 and P >= 90% and are clearly automatic.
   - "links" (max 5): ONLY add missing direct prerequisite edges ("unit_id" directly builds on "rests_on" IDs) where both IDs exist in the catalog (no cycles).
   - If nothing clearly warrants compaction, return empty arrays [].

Return ONLY valid JSON:
{"memory": string, "summary": string, "promoted": string[], "graduated": string[], "merges": [{"keep_id": string, "merge_ids": string[], "text": string|null}], "retire_ids": string[], "links": [{"unit_id": string, "rests_on": string[]}]}`;

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

    const catalogBlock =
      input.allUnits && input.allUnits.length > 0
        ? input.allUnits
            .slice(0, 80)
            .map(
              (u) =>
                `- [${u.id}] (${u.kind}, P=${Math.round(u.p_imm * 100)}%, ${u.reviews} rev${u.topic ? `, topic="${u.topic}"` : ""}${u.rests_on.length ? `, rests_on=[${u.rests_on.join(",")}]` : ""}) ${u.text.slice(0, 180)}`,
            )
            .join("\n")
        : "";

    const user = [
      `Current memory (updated_by=${input.updatedBy}):\n${input.currentMemory.trim() || "(empty — first dream pass)"}`,
      `Mastered units (graduate any matching old blind spots!):\n${masteredBlock}`,
      `Shaky / active friction units:\n${shakyBlock}`,
      catalogBlock ? `Active unit catalog (use IDs verbatim for merges / retire_ids / links):\n${catalogBlock}` : "",
      `Manual schedule overrides & audit adjustments:\n${overridesBlock}`,
      `Recent drill transcripts:\n${attemptsBlock}`,
      `Recent explorations:\n${expBlock}`,
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

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
      merges?: unknown;
      retire_ids?: unknown;
      links?: unknown;
    }>(raw);
    if (!parsed || typeof parsed.memory !== "string" || !parsed.memory.trim()) {
      throw new Error("Dream pass did not return a valid memory update.");
    }
    const toList = (v: unknown) =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()).slice(0, 6)
        : [];
    const merges: DreamMergeProposal[] = Array.isArray(parsed.merges)
      ? parsed.merges
          .filter(
            (m): m is { keep_id: string; merge_ids: unknown[]; text?: string | null } =>
              Boolean(m && typeof m === "object" && typeof (m as { keep_id?: unknown }).keep_id === "string" && Array.isArray((m as { merge_ids?: unknown }).merge_ids)),
          )
          .map((m) => ({
            keep_id: m.keep_id.trim(),
            merge_ids: m.merge_ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()),
            ...(typeof m.text === "string" && m.text.trim().length > 4 ? { text: m.text.trim() } : {}),
          }))
          .filter((m) => m.keep_id && m.merge_ids.length > 0)
          .slice(0, 3)
      : [];
    const retire_ids = toList(parsed.retire_ids).slice(0, 3);
    const links: DreamLinkProposal[] = Array.isArray(parsed.links)
      ? parsed.links
          .filter(
            (l): l is { unit_id: string; rests_on: unknown[] } =>
              Boolean(l && typeof l === "object" && typeof (l as { unit_id?: unknown }).unit_id === "string" && Array.isArray((l as { rests_on?: unknown }).rests_on)),
          )
          .map((l) => ({
            unit_id: l.unit_id.trim(),
            rests_on: l.rests_on.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim()),
          }))
          .filter((l) => l.unit_id && l.rests_on.length > 0)
          .slice(0, 5)
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
      memory: trimLearnerMemory(parsed.memory, 3200),
      summary: typeof parsed.summary === "string" && parsed.summary.trim() ? parsed.summary.trim() : "Consolidated recent learning patterns.",
      promoted: toList(parsed.promoted),
      graduated: toList(parsed.graduated),
      ...(merges.length > 0 ? { merges } : {}),
      ...(retire_ids.length > 0 ? { retire_ids } : {}),
      ...(links.length > 0 ? { links } : {}),
    };
  }

  private promptKey(
    unit: { id: string; text: string },
    depth: Depth,
    restsOn: string[] = [],
    variant = 0,
    modality: RepModality = "direct",
    bundledIds: readonly string[] = [],
  ): string {
    const depSig = restsOn.length > 0 ? restsOn.map((r) => r.slice(0, 24)).join("|") : "";
    const modSig = modality !== "direct" ? `:m=${modality}` : "";
    const bundleSig = bundledIds.length > 0 ? `:b=${[...bundledIds].sort().join(",")}` : "";
    return `v5:${unit.id}:${depth}:v${variant}${modSig}${bundleSig}:${depSig}:${unit.text}`;
  }

  /** Returns a cached prompt + expected crux (+ optional starter) synchronously if already warmed, or null. */
  peekPromptEntry(
    unit: { id: string; text: string },
    depth: Depth,
    restsOn: string[] = [],
    variant = 0,
    modality: RepModality = "direct",
    bundledIds: readonly string[] = [],
  ): PromptCacheEntry | null {
    return this.promptCache.get(this.promptKey(unit, depth, restsOn, variant, modality, bundledIds)) ?? null;
  }

  /** Returns a cached prompt synchronously if already warmed, or null. */
  peekPrompt(
    unit: { id: string; text: string },
    depth: Depth,
    restsOn: string[] = [],
    variant = 0,
    modality: RepModality = "direct",
    bundledIds: readonly string[] = [],
  ): string | null {
    return this.peekPromptEntry(unit, depth, restsOn, variant, modality, bundledIds)?.prompt ?? null;
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
      modality?: RepModality;
      bundledUnits?: { id: string; text: string; kind: string }[];
    }[],
  ): void {
    if (!this.apiKey && !this.promptWorker) return;
    const queue = items.filter((item) => {
      const bIds = (item.bundledUnits ?? []).map((b) => b.id);
      const key = this.promptKey(item.unit, item.depth, item.restsOn, item.variant ?? 0, item.modality ?? "direct", bIds);
      return !this.promptCache.has(key) && !this.inflightPrompts.has(key);
    });
    if (queue.length === 0) return;
    const concurrency = this.acpClient && !this.acpClient.isUnsupported ? Math.min(3, queue.length) : 1;
    let cursor = 0;
    const runWorker = async () => {
      while (cursor < queue.length) {
        if (this.activeForegroundPrompts > 0) break;
        const item = queue[cursor++]!;
        const bIds = (item.bundledUnits ?? []).map((b) => b.id);
        const key = this.promptKey(item.unit, item.depth, item.restsOn, item.variant ?? 0, item.modality ?? "direct", bIds);
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
              modality: item.modality,
              bundledUnits: item.bundledUnits,
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
   * Generates a crisp, self-contained single-beat prompt + its prompt-scoped `expected_crux`
   * + optional adaptive `starter` (for `fix_bug` / `faded_skeleton` / `synthesis` modalities).
   */
  async promptEntryFor(
    unit: { id: string; text: string; kind: string; topic?: string | null },
    restsOn: string[],
    depth: Depth,
    opts: PromptContextOptions = {},
    background = false,
  ): Promise<PromptCacheEntry> {
    const variant = opts.variant ?? 0;
    const modality: RepModality = opts.modality ?? "direct";
    const bundled = opts.bundledUnits ?? [];
    const bundledIds = bundled.map((b) => b.id);
    const key = this.promptKey(unit, depth, restsOn, variant, modality, bundledIds);
    const cached = this.promptCache.get(key);
    if (cached) return cached;
    const inflight = this.inflightPrompts.get(key);
    if (inflight && (background || !inflight.background)) return inflight.promise;

    if (!this.apiKey && !this.promptWorker) {
      const fallback: PromptCacheEntry = { prompt: defaultPrompt(unit.text, unit.kind, restsOn, depth), modality };
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

    const modalityGuide: Record<RepModality, string> = {
      direct: `Modality: DIRECT. Set "starter" to null.`,
      contrast: `Modality: SHARP CONTRAST (1-line high-signal boundary check). Ask ONE crisp contrast or edge-case question answerable in 1-2 sentences (e.g. "What breaks if X is swapped for Y?"). Set "starter" to null.`,
      faded_skeleton: `Modality: FADED CODE SKELETON (skip boilerplate, test the exact pivot in ~30s).
- "prompt": 1 crisp sentence naming the goal and telling the learner to complete the code/expression below.
- "starter": ONLY for code or pure symbolic assignments (e.g. PyTorch/NumPy/Python): a clean 2-5 line plain-ASCII code snippet with 1-2 short pivot holes marked \`___\` (no markdown fences, NO English prose mad-libs like "grows with ___ and ___", NO numbered prose sentences). If the unit is conceptual prose rather than code, set "starter" to null.`,
      fix_bug: `Modality: FIX THE BUG (spot & repair ONE planted flaw in ~25s).
- "prompt": 1 crisp sentence saying the snippet/claim has one subtle bug and asking them to fix it.
- "starter": ONLY for code tasks: a realistic 3-6 line plain-ASCII code snippet containing ONE subtle bug right at this unit's core pivot (no hint comments, no markdown fences, NO raw LaTeX/TeX). For non-code conceptual/math units, put the flawed claim directly in "prompt" and set "starter" to null.`,
      synthesis: `Modality: MULTI-UNIT SYNTHESIS (clear the primary unit AND the bundled companion unit(s) in ONE compact ~45s task).
- "prompt": 1-2 crisp sentences posing ONE unified concrete scenario/task that naturally exercises the primary unit AND every bundled unit together without stacking two unrelated sub-questions.
- "starter": Default to null (open response). ONLY set a 2-4 line plain-ASCII code skeleton with 1-2 \`___\` holes when the task is explicitly writing code (e.g. PyTorch/NumPy/Python); NEVER emit prose fill-in-the-blank sentences or numbered mad-libs.`,
      mcq: `Modality: SHARP CONTRAST. Set "starter" to null.`,
    };

    const promptSys = `Write ONE crisp, motivating, self-contained practice question (1-2 short sentences, max 34 words), its exact single-claim grading rubric ("expected_crux", max 32 words), and an optional pre-filled editor "starter" matching the requested Modality.
Rules:
- MOTIVATE, DON'T WORKSHEET: Frame a real problem, comparison, or concrete setup directly and plainly—NEVER a disembodied textbook command ("State formula Y"), AND NEVER forced faux-ownership or roleplay ("Your PyTorch LayerNorm...", "A teammate argues...").
- CLEAN MATH TYPOGRAPHY: In "prompt", render equations, variables, and tensor shapes in KaTeX (\`$y = \\gamma \\hat{x} + \\beta$\`, \`$(B, T, D)$\`), NOT backticks! Reserve backticks strictly for actual code tokens/flags (like \`dim=-1\` or \`gradcheck\`, at most 2–3 in a prompt).
- ZERO SPOILERS, ZERO RIDDLES: Name the starting setup/object clearly (e.g. standard attention $\\text{softmax}(QK^T)V$, a database write path, a sample mean $\\bar{x}$)—hide ONLY the solution, trick, or intermediate pivot, NEVER obfuscate the premise into a vague riddle.
- NO SURFACE-CUE REPETITION: If Previously asked prompts are listed below, DO NOT reuse the same cover story, numbers, or phrasing—change what the learner must recognize or decide.
- 100% SELF-CONTAINED COLD: Explicitly define every symbol or variable used.
- ONE SINGLE TASK: Never stack two separate unrelated demands.
- "expected_crux": State the exact claim/fix/expression needed to pass THIS prompt cleanly (so the judge never nitpicks unasked unit clauses).
- ${modalityGuide[modality]}
- Return ONLY valid JSON: {"prompt": string, "expected_crux": string, "starter": string|null}`;
    const prior = (opts.priorPrompts ?? []).filter(Boolean).slice(-3);
    const mem = trimLearnerMemory(opts.learnerMemory);
    const promptUser = [
      goalByDepth[depth],
      mem
        ? `Learner memory (use ONLY to match background level, preferred style, and target active blind spots—NEVER spoil the answer):\n${mem}`
        : "",
      unit.topic ? `Topic: ${unit.topic}` : "",
      `Primary unit (${unit.kind}): ${unit.text}`,
      bundled.length > 0
        ? `Bundled companion unit(s) to weave into the same compact task:\n${bundled.map((b) => `- (${b.kind}) ${b.text}`).join("\n")}`
        : "",
      `Rests on: ${restsOn.join("; ") || "nothing"}`,
      prior.length > 0 ? `Previously asked (MUST invent a fresh scenario/numbers/decision point, never repeat these):\n- ${prior.join("\n- ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const explicitPromptEnv = Boolean(process.env.MYELIN_PROMPT_MODEL?.trim());
    const modelForCall = this.isAgy
      ? background
        ? explicitPromptEnv
          ? this.promptModel
          : this.sidecarModel
        : this.drillModel
      : this.promptModel;
    const slugForCall = this.isAgy
      ? background
        ? explicitPromptEnv
          ? this.promptSlug
          : this.sidecarSlug
        : this.drillSlug
      : this.promptSlug;
    const fallbackWorkerForCall = this.isAgy
      ? background
        ? explicitPromptEnv
          ? this.promptWorker
          : (this.sidecarWorker ?? this.promptWorker)
        : (this.drillWorker ?? this.sidecarWorker ?? this.promptWorker)
      : this.promptWorker;
    const timeoutMs = background ? 45_000 : 18_000;

    if (!background) this.activeForegroundPrompts++;
    const t0 = Date.now();
    const p = (async (): Promise<PromptCacheEntry> => {
      let agyTrace: AgyTurnTrace | undefined;
      let workerKind: PerfWorker = "openrouter";
      try {
        let raw: string | undefined;
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
          raw = res.raw.trim();
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
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: promptSys },
                { role: "user", content: promptUser },
              ],
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
            raw = data.choices?.[0]?.message?.content?.trim();
          }
        }
        if (raw) {
          const parsed = parseJudgeJson<{ prompt?: string; expected_crux?: string; starter?: string | null }>(raw);
          const promptText =
            typeof parsed?.prompt === "string" && parsed.prompt.trim().length > 6
              ? parsed.prompt.trim()
              : raw.replace(/^["']|["']$/g, "").trim();
          const cruxText =
            typeof parsed?.expected_crux === "string" && parsed.expected_crux.trim().length > 4
              ? parsed.expected_crux.trim()
              : undefined;
          const rawStarter = typeof parsed?.starter === "string" ? parsed.starter.trim() : "";
          const cleanedStarter = rawStarter
            ? rawStarter.replace(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/, "$1").trim()
            : "";
          const starterText =
            cleanedStarter.length >= 6 &&
            (modality === "fix_bug" ||
              ((modality === "faded_skeleton" || modality === "synthesis") && isCodeSkeletonStarter(cleanedStarter)))
              ? cleanedStarter
              : undefined;
          if (promptText) {
            const entry: PromptCacheEntry = {
              prompt: promptText,
              ...(cruxText ? { crux: cruxText } : {}),
              modality,
              ...(starterText ? { starter: starterText } : {}),
            };
            this.promptCache.set(key, entry);
            this.savePromptCache();
            this.perf?.record(
              this.buildPerf(t0, "prompt", modelForCall, workerKind, true, {
                background,
                cacheHit: false,
                trace: agyTrace,
                outputChars: promptText.length,
                promptChars: promptUser.length,
              }),
            );
            return entry;
          }
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
      return { prompt: defaultPrompt(unit.text, unit.kind, restsOn, depth) };
    })().finally(() => {
      if (this.inflightPrompts.get(key)?.promise === p) {
        this.inflightPrompts.delete(key);
      }
      if (!background) this.activeForegroundPrompts = Math.max(0, this.activeForegroundPrompts - 1);
    });

    this.inflightPrompts.set(key, { promise: p, background });
    if (!background && inflight?.background) {
      return Promise.race([p, inflight.promise]);
    }
    return p;
  }

  /**
   * Generates and blind-verifies a strict server-private 4-choice diagnostic MCQ entry.
   * Never falls back to raw model output (which could leak the private key); returns null on
   * any validation, ambiguity, or verifier disagreement so callers serve ordinary open contrast.
   */
  async generateMcqEntry(
    unit: { id: string; text: string; kind: string; topic?: string | null },
    restsOn: string[],
    opts: PromptContextOptions = {},
  ): Promise<PromptCacheEntry | null> {
    const variant = opts.variant ?? 0;
    const key = this.promptKey(unit, "recall", restsOn, variant, "mcq", []);
    const cached = this.promptCache.get(key);
    if (cached?.modality === "mcq" && cached.mcq) return cached;
    if (!this.enabled) return null;

    const genSys = `Write ONE sharp diagnostic 4-choice MCQ testing a single boundary condition or distinction for the target unit.
Strict rules:
- Frame ONE concrete scenario where all assumptions (dimensions, scalar vs per-coordinate parameters, operations) are stated explicitly so ONLY ONE option is uniquely defensible.
- Write 4 parallel options ("a","b","c","d") with comparable length, notation, and specificity—never make the correct answer conspicuously longer or more hedged.
- Three distractors must represent distinct, plausible mistakes. BAN "all of the above", "none of the above", position references ("Option A"), or joke answers.
- Put math variables/formulas in $...$ with balanced delimiters (double-escape LaTeX backslashes in JSON).
- Return ONLY valid JSON:
  {"prompt": string, "expected_crux": string, "choices": [{"id":"a","text":string},{"id":"b","text":string},{"id":"c","text":string},{"id":"d","text":string}], "correct_id": "a"|"b"|"c"|"d", "explanation": string, "why_wrong": { [distractorId]: string }}`;

    const genUser = [
      `Target unit (${unit.kind}): ${unit.text}`,
      unit.topic ? `Topic: ${unit.topic}` : null,
      restsOn.length ? `Rests on: ${restsOn.join("; ")}` : null,
      opts.priorPrompts?.length
        ? `Previously asked prompts (use a fresh boundary scenario):\n${opts.priorPrompts.map((x) => `- ${x}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const callModel = async (sys: string, usr: string): Promise<string | null> => {
      const worker = this.promptWorker ?? this.drillWorker;
      if (worker) {
        const res = await this.askAgy({
          fallbackWorker: worker,
          fallbackWorkerName: "prompt",
          modelId: this.promptWorker ? this.promptSlug : this.drillSlug,
          systemPrompt: `${sys}\nAnswer directly with ZERO tool calls.`,
          userPrompt: usr,
        });
        return res.raw.trim() || null;
      }
      const res = await this.fetchFn(CHAT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.promptModel,
          reasoning: { effort: "low" },
          temperature: 0.2,
          max_tokens: 1800,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys },
            { role: "user", content: usr },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    };

    try {
      const raw = await callModel(genSys, genUser);
      if (!raw) return null;
      const parsed = parseJudgeJson<{
        prompt?: string;
        expected_crux?: string;
        choices?: unknown;
        correct_id?: string;
        explanation?: string;
        why_wrong?: Record<string, string>;
      }>(raw);
      if (!parsed || typeof parsed.prompt !== "string" || parsed.prompt.trim().length < 12) return null;
      const promptText = parsed.prompt.trim();
      const spec = validateMcqSpec(parsed);
      if (!spec) return null;

      // Blind verifier: solve stem + shuffled choices + source premise WITHOUT knowing proposed correct_id.
      const shuffled = [...spec.choices];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const verifySys = `You are a strict blind verifier auditing a 4-choice diagnostic MCQ for ambiguity.
Given the source concept, question stem, and 4 choices, determine whether EXACTLY ONE choice is uniquely defensible under the stated premises.
Return ONLY valid JSON: {"chosen_id": string | "AMBIGUOUS", "reason": string}`;
      const verifyUser = [
        `Source concept: ${unit.text}`,
        `Question: ${promptText}`,
        `Choices:\n${shuffled.map((c) => `- [${c.id}] ${c.text}`).join("\n")}`,
      ].join("\n\n");
      const vRaw = await callModel(verifySys, verifyUser);
      if (!vRaw) return null;
      const vParsed = parseJudgeJson<{ chosen_id?: string; reason?: string }>(vRaw);
      if (!vParsed || vParsed.chosen_id?.trim() !== spec.correct_id) return null;

      const crux =
        typeof parsed.expected_crux === "string" && parsed.expected_crux.trim().length >= 4
          ? parsed.expected_crux.trim()
          : undefined;
      const entry: PromptCacheEntry = {
        prompt: promptText,
        ...(crux ? { crux } : {}),
        modality: "mcq",
        mcq: spec,
      };
      this.promptCache.set(key, entry);
      this.savePromptCache();
      return entry;
    } catch (err) {
      console.error("[judge] generateMcqEntry failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * Answers an ungraded clarifying question on an active MCQ without selecting or eliminating any option.
   * Marks `substantive_help: true` if explanation went beyond neutral notation/setup clarification, and
   * `revealed_answer: true` only if the reply disclosed the deciding answer.
   */
  async clarifyMcq(opts: {
    prompt: string;
    choices: { id: string; text: string }[];
    unitText: string;
    question: string;
    turns: { role: "user" | "assistant"; text: string }[];
  }): Promise<{ message: string; substantive_help: boolean; revealed_answer: boolean }> {
    if (!this.enabled) {
      return {
        message: "Select an option to check your understanding, or choose I'm not sure · Show answer.",
        substantive_help: false,
        revealed_answer: false,
      };
    }
    const sys = `You are Myelin's learning partner answering a clarifying question on an active 4-choice MCQ.
Rules:
- Answer ONLY setup, notation, or terminology questions in 1-2 crisp sentences.
- NEVER select, hint at, or eliminate any of the 4 choices!
- If the learner asks which option is right, direct them to choose "I'm not sure · Show answer" instead of revealing it.
- Set substantive_help=true ONLY if you had to explain an underlying domain concept (not neutral notation/wording).
- Set revealed_answer=true ONLY if you accidentally disclosed the deciding answer.
- Return ONLY valid JSON: {"message": string, "substantive_help": boolean, "revealed_answer": boolean}`;
    const userMsg = [
      `Question: ${opts.prompt}`,
      `Options:\n${opts.choices.map((c, i) => `${i + 1}. ${c.text}`).join("\n")}`,
      opts.turns.length
        ? `Prior clarification:\n${opts.turns.map((t) => `${t.role === "user" ? "Learner" : "Coach"}: ${t.text}`).join("\n")}`
        : null,
      `Learner question: ${opts.question}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      let raw: string | null = null;
      if (this.drillWorker) {
        const res = await this.askAgy({
          fallbackWorker: this.drillWorker,
          fallbackWorkerName: "agy",
          modelId: this.drillSlug,
          systemPrompt: `${sys}\nAnswer directly with ZERO tool calls.`,
          userPrompt: userMsg,
        });
        raw = res.raw.trim() || null;
      } else {
        const res = await this.fetchFn(CHAT_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.llmModel,
            temperature: 0.2,
            max_tokens: 500,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: userMsg },
            ],
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
          raw = data.choices?.[0]?.message?.content?.trim() ?? null;
        }
      }
      const parsed = raw
        ? parseJudgeJson<{ message?: string; substantive_help?: boolean; revealed_answer?: boolean }>(raw)
        : null;
      if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
        return {
          message: parsed.message.trim(),
          substantive_help: Boolean(parsed.substantive_help),
          revealed_answer: Boolean(parsed.revealed_answer),
        };
      }
    } catch (err) {
      console.error("[judge] clarifyMcq failed:", err instanceof Error ? err.message : err);
    }
    return {
      message: "Choose the option that matches the stated premises, or select I'm not sure · Show answer.",
      substantive_help: false,
      revealed_answer: false,
    };
  }

  /** Generates a crisp, self-contained single-beat prompt without giving away the answer (cached per variant). */
  async promptFor(
    unit: { id: string; text: string; kind: string; topic?: string | null },
    restsOn: string[],
    depth: Depth,
    opts: PromptContextOptions = {},
    background = false,
  ): Promise<string> {
    const entry = await this.promptEntryFor(unit, restsOn, depth, opts, background);
    return entry.prompt;
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
