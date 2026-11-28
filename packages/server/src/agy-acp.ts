// Persistent multiplexed `agy acp` stdio daemon client:
// - One warm Language Server process for the lifetime of the server (zero 4.5s cold spawns)
// - Native `session/new` (~6ms warm) + `session/set_model` (~1ms) + `session/close`
// - Stateful LRU KV-cached sessions keyed by rep/exploration/briefing ID (Turns 2+ send only deltas)
// - Concurrent multiplexing across independent sessions (background dream/prompt/sidecar never block foreground)
// - Native `session/cancel` wired to `AbortSignal` so browser Cancel frees the learner immediately
// - Native image content blocks for hand-drawn sketches & full token/KV-cache usage telemetry
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolveAgyBinary } from "./tutor/agy.js";

export interface AgyTurnTrace {
  transport?: "acp" | "stream-json" | undefined;
  cold_spawn: boolean;
  spawn_ms: number;
  init_ms?: number | undefined;
  session_reused?: boolean | undefined;
  turn_in_proc: number;
  queue_wait_ms: number;
  first_event_ms?: number | undefined;
  thinking_ms?: number | undefined;
  ttft_raw_ms?: number | undefined;
  llm_ms: number;
  prompt_chars: number;
  output_chars: number;
  input_tokens?: number | undefined;
  cache_read_tokens?: number | undefined;
  thinking_tokens?: number | undefined;
  output_tokens?: number | undefined;
  tools_count?: number | undefined;
  tool_calls: number;
  step_types: string[];
}

export interface AgyAcpOptions {
  binary?: string | undefined;
  resourceDirs?: string[] | undefined;
  /** Relative subdir name under ~/.gemini/ to isolate Myelin's ACP sessions from personal CLI history. */
  appDataDir?: string | undefined;
  /** Max concurrent stateful sessions kept warm in LRU cache. Default 16. */
  maxCachedSessions?: number | undefined;
  /** Max turns per stateful session before rotating cleanly. Default 24. */
  maxTurnsPerSession?: number | undefined;
  /** Timeout for initial ACP `initialize` handshake. Default 6000ms. */
  initTimeoutMs?: number | undefined;
}

export interface AgyAcpAskOptions {
  /** Model ID to run this turn on (e.g. "gemini-4-neon-low", "gemini-4-neon-high"). */
  modelId?: string | undefined;
  /** Optional stable session key (e.g. "drill:<attemptId>", "explore:<expId>") for stateful KV prefix reuse. */
  sessionKey?: string | undefined;
  /** System instructions appended via `_meta.antigravity.systemPrompt.append` on session creation. */
  systemPrompt?: string | undefined;
  /** Optional lean delta prompt used atomically ONLY when `sessionKey` is still warm & matches `expectedPriorTurns` at execution time. */
  deltaPrompt?: string | undefined;
  /** Optional turn count guard: if caller's expected prior turns differs from cached session turns, rotate cleanly and send full prompt. */
  expectedPriorTurns?: number | undefined;
  /** Optional base64 data URL of a sketch image sent natively as an ACP image block. */
  sketchDataUrl?: string | null | undefined;
  /** Per-turn timeout in ms. Default 55000. */
  timeoutMs?: number | undefined;
  /** AbortSignal wired from HTTP/SSE disconnect or user Cancel button -> sends `session/cancel`. */
  signal?: AbortSignal | undefined;
  /** Streaming text chunk callback. */
  onDelta?: ((delta: string) => void) | undefined;
  /** Full per-turn timing & token usage callback. */
  onTrace?: ((trace: AgyTurnTrace) => void) | undefined;
}

interface PendingRpc {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface CachedSession {
  sessionId: string;
  modelId: string;
  systemHash: string;
  turns: number;
  lastUsedAt: number;
}

interface ActiveAcpTurn {
  sessionId: string;
  text: string;
  writtenAt: number;
  firstEventAt?: number;
  firstThinkAt?: number;
  firstDeltaAt?: number;
  toolCalls: number;
  stepTypes: Set<string>;
  onDelta?: ((delta: string) => void) | undefined;
}

interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  thoughtTokens?: number;
}

function safeTempBase(): string {
  const sysTmp = tmpdir();
  if (sysTmp && existsSync(sysTmp)) return sysTmp;
  const fallback = "/tmp";
  if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
  return fallback;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function makeAbortError(): Error {
  const err = new Error("Request aborted");
  err.name = "AbortError";
  return err;
}

export class AgyAcpClient {
  private readonly binary: string | undefined;
  private readonly resourceDirs: string[];
  private readonly appDataDir: string;
  private readonly maxCachedSessions: number;
  private readonly maxTurnsPerSession: number;
  private readonly initTimeoutMs: number;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private workDir: string | null = null;
  private readyPromise: Promise<void> | null = null;
  private initializedAt: number | null = null;
  private bootInitMs = 0;
  private nextId = 1;
  private disposed = false;
  private unsupported = false;

  private readonly pendingRpcs = new Map<number, PendingRpc>();
  private readonly activeTurns = new Map<string, ActiveAcpTurn>();
  private readonly sessions = new Map<string, CachedSession>();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();

  constructor(opts: AgyAcpOptions = {}) {
    this.binary = opts.binary;
    this.resourceDirs = opts.resourceDirs ?? [];
    this.appDataDir = opts.appDataDir ?? "myelin-acp";
    this.maxCachedSessions = opts.maxCachedSessions ?? 16;
    this.maxTurnsPerSession = opts.maxTurnsPerSession ?? 24;
    this.initTimeoutMs = opts.initTimeoutMs ?? 6_000;
  }

  /** True if `agy acp` previously failed to initialize as an ACP server (e.g. non-ACP fake binary in tests). */
  get isUnsupported(): boolean {
    return this.unsupported;
  }

  /**
   * Returns true if a warm stateful KV-cached session already exists for `sessionKey` matching
   * `modelId`, `systemPrompt`, and (optionally) `expectedPriorTurns`, so the caller can send
   * ONLY the new learner delta instead of re-sending full context & transcript.
   */
  isSessionWarm(sessionKey: string, modelId?: string, systemPrompt = "", expectedPriorTurns?: number): boolean {
    if (!this.proc || this.proc.killed || this.disposed) return false;
    const cached = this.sessions.get(sessionKey);
    if (!cached) return false;
    if (cached.turns >= this.maxTurnsPerSession) return false;
    if (modelId && cached.modelId !== modelId) return false;
    if (cached.systemHash !== shortHash(systemPrompt)) return false;
    if (expectedPriorTurns !== undefined && cached.turns !== expectedPriorTurns) return false;
    return true;
  }

  /** Drops and closes a cached stateful session (e.g. after a drill rep passes or exploration is deleted). */
  closeSession(sessionKey: string): void {
    const cached = this.sessions.get(sessionKey);
    if (!cached) return;
    this.sessions.delete(sessionKey);
    void this.sendSessionClose(cached.sessionId);
  }

  /**
   * Eagerly spawns the persistent `agy acp` daemon and warms its Language Server + OAuth/model caches
   * in the background (0 LLM tokens) so the very first user turn skips the ~2.5–4.5s cold boot.
   */
  warmUp(): Promise<void> {
    if (this.disposed || this.unsupported) return Promise.resolve();
    return this.ensureReady().catch(() => {
      /* caller handles fallback on real ask() */
    });
  }

  private cleanupProcess(targetProc: ChildProcessWithoutNullStreams | null, targetDir: string | null, reason?: string): void {
    if (targetProc && this.proc === targetProc) {
      this.proc = null;
      this.readyPromise = null;
      this.initializedAt = null;
      this.sessions.clear();
      const err = new Error(reason || "agy acp daemon exited");
      for (const [id, p] of this.pendingRpcs) {
        clearTimeout(p.timer);
        this.pendingRpcs.delete(id);
        p.reject(err);
      }
      this.activeTurns.clear();
    }
    if (targetProc) {
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

  private rpc(proc: ChildProcessWithoutNullStreams, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingRpcs.has(id)) return;
        this.pendingRpcs.delete(id);
        reject(new Error(`agy acp ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRpcs.set(id, { method, timer, resolve, reject });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      proc.stdin.write(payload, (err) => {
        if (err) {
          const pending = this.pendingRpcs.get(id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRpcs.delete(id);
            pending.reject(err);
          }
        }
      });
    });
  }

  private notify(proc: ChildProcessWithoutNullStreams, method: string, params: Record<string, unknown>): void {
    if (proc.killed) return;
    try {
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      /* ignore write error on closing daemon */
    }
  }

  private async sendSessionClose(sessionId: string): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.killed) return;
    try {
      await this.rpc(proc, "session/close", { sessionId }, 4_000);
    } catch {
      /* best-effort cleanup */
    }
  }

  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AgyAcpClient disposed"));
    if (this.unsupported) return Promise.reject(new Error("agy acp unsupported by configured binary"));
    if (this.readyPromise && this.proc && !this.proc.killed) return this.readyPromise;

    const p = this.bootDaemon();
    this.readyPromise = p;
    p.catch(() => {
      if (this.readyPromise === p) this.readyPromise = null;
    });
    return p;
  }

  private async bootDaemon(): Promise<void> {
    const t0 = Date.now();
    this.cleanupProcess(this.proc, this.workDir, "restarting daemon");
    const workDir = mkdtempSync(join(safeTempBase(), "myelin-agy-acp-"));
    writeFileSync(
      join(workDir, "AGENTS.md"),
      "You are Myelin's fast learning coach. Follow the session instructions and output format strictly. Never modify, create, or delete files, and never run mutating shell commands.\n",
      "utf8",
    );

    const bin = resolveAgyBinary(this.binary);
    const args = [
      "acp",
      "--stdio",
      "--app-data-dir",
      this.appDataDir,
      "--include-default-customizations=false",
      "--dangerously-skip-permissions",
      "--disable-telemetry",
    ];
    for (const dir of this.resourceDirs) args.push("--add-dir", dir);

    const child = spawn(bin, args, { cwd: workDir, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = child;
    this.workDir = workDir;

    let childStderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => {
      childStderr = (childStderr + d).slice(-2000);
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (this.proc !== child) return;
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) return;
      let msg: {
        jsonrpc?: string;
        id?: number;
        method?: string;
        result?: unknown;
        error?: { code?: number; message?: string };
        params?: {
          sessionId?: string;
          update?: {
            sessionUpdate?: string;
            content?: { type?: string; text?: string };
            delta?: string;
            text?: string;
          };
        };
      };
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }

      // Fast-detect non-ACP stream-json binaries (e.g. unit test fake-agy.mjs) within <10ms!
      if (msg.jsonrpc !== "2.0" && this.initializedAt === null) {
        this.unsupported = true;
        this.cleanupProcess(child, workDir, "ACP unsupported (non-JSON-RPC output)");
        return;
      }

      if (typeof msg.id === "number") {
        const pending = this.pendingRpcs.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRpcs.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || `ACP error ${msg.error.code ?? "unknown"}`));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }

      if (msg.method === "session/update" && msg.params?.sessionId && msg.params.update) {
        const turn = this.activeTurns.get(msg.params.sessionId);
        if (!turn) return;
        const now = Date.now();
        if (turn.firstEventAt === undefined) turn.firstEventAt = now;
        const u = msg.params.update;
        const kind = u.sessionUpdate;
        if (kind) {
          turn.stepTypes.add(kind);
          if (/tool_call/i.test(kind)) {
            if (kind === "tool_call") turn.toolCalls++;
          } else if (kind.includes("thought") && turn.firstThinkAt === undefined) {
            turn.firstThinkAt = now;
          }
        }
        if (kind === "agent_message_chunk") {
          const delta = u.content?.text ?? u.delta ?? u.text ?? "";
          if (delta) {
            if (turn.firstDeltaAt === undefined) turn.firstDeltaAt = now;
            turn.text += delta;
            try {
              turn.onDelta?.(delta);
            } catch {
              /* ignore subscriber errors */
            }
          }
        }
      }
    });

    child.on("error", (err) => {
      if (this.initializedAt === null) this.unsupported = true;
      this.cleanupProcess(child, workDir, err.message);
    });
    child.on("close", (code) => {
      rl.close();
      if (this.initializedAt === null) this.unsupported = true;
      this.cleanupProcess(child, workDir, childStderr.trim() || `agy acp exited (${code})`);
    });

    try {
      await this.rpc(child, "initialize", { protocolVersion: 1, clientCapabilities: {} }, this.initTimeoutMs);
      // Perform one 0-token warm session/new + close so the Go Language Server + OAuth + model
      // list finish initializing in the background before the first real learner prompt arrives.
      const warmRes = (await this.rpc(child, "session/new", { cwd: workDir, mcpServers: [] }, 15_000)) as { sessionId?: string };
      if (warmRes?.sessionId) {
        void this.sendSessionClose(warmRes.sessionId);
      }
      this.initializedAt = Date.now();
      this.bootInitMs = this.initializedAt - t0;
    } catch (err) {
      this.cleanupProcess(child, workDir, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private evictIfFull(): void {
    while (this.sessions.size >= this.maxCachedSessions) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, v] of this.sessions) {
        if (!this.activeTurns.has(v.sessionId) && v.lastUsedAt < oldestAt) {
          oldestAt = v.lastUsedAt;
          oldestKey = k;
        }
      }
      if (!oldestKey) break;
      const victim = this.sessions.get(oldestKey);
      this.sessions.delete(oldestKey);
      if (victim) void this.sendSessionClose(victim.sessionId);
    }
  }

  private async openSession(proc: ChildProcessWithoutNullStreams, modelId?: string, systemPrompt?: string): Promise<string> {
    const params: Record<string, unknown> = {
      cwd: this.workDir ?? safeTempBase(),
      mcpServers: [],
    };
    if (systemPrompt?.trim()) {
      params._meta = { antigravity: { systemPrompt: { append: systemPrompt.trim() } } };
    }
    const created = (await this.rpc(proc, "session/new", params, 15_000)) as {
      sessionId?: string;
      models?: { currentModelId?: string };
    };
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error("agy acp session/new returned no sessionId");
    if (modelId && modelId !== "default" && created.models?.currentModelId !== modelId) {
      await this.rpc(proc, "session/set_model", { sessionId, modelId }, 5_000);
    }
    return sessionId;
  }

  async ask(prompt: string, opts: AgyAcpAskOptions = {}): Promise<string> {
    if (opts.signal?.aborted) throw makeAbortError();
    const enqueuedAt = Date.now();

    const run = async (): Promise<string> => {
      if (opts.signal?.aborted) throw makeAbortError();

      const wasCold = !this.proc || this.proc.killed || this.initializedAt === null;
      const tReady = Date.now();
      await this.ensureReady();
      const readyWaitMs = Date.now() - tReady;
      const proc = this.proc;
      if (!proc || proc.killed) throw new Error("agy acp daemon not running");
      if (opts.signal?.aborted) throw makeAbortError();

      const modelId = opts.modelId && opts.modelId !== "default" ? opts.modelId : "";
      const sysPrompt = opts.systemPrompt ?? "";
      const sysHash = shortHash(sysPrompt);
      const sessionKey = opts.sessionKey;

      let sessionId: string;
      let sessionReused = false;
      let turnInSession = 1;
      let cachedEntry: CachedSession | undefined;

      if (sessionKey) {
        const existing = this.sessions.get(sessionKey);
        const matches =
          existing &&
          existing.turns < this.maxTurnsPerSession &&
          (!modelId || existing.modelId === modelId) &&
          existing.systemHash === sysHash &&
          (opts.expectedPriorTurns === undefined || existing.turns === opts.expectedPriorTurns);
        if (matches && existing) {
          sessionId = existing.sessionId;
          sessionReused = true;
          turnInSession = existing.turns + 1;
          cachedEntry = existing;
        } else {
          if (existing) {
            this.sessions.delete(sessionKey);
            void this.sendSessionClose(existing.sessionId);
          }
          this.evictIfFull();
          sessionId = await this.openSession(proc, modelId || undefined, sysPrompt);
          cachedEntry = {
            sessionId,
            modelId,
            systemHash: sysHash,
            turns: 0,
            lastUsedAt: Date.now(),
          };
          this.sessions.set(sessionKey, cachedEntry);
        }
      } else {
        sessionId = await this.openSession(proc, modelId || undefined, sysPrompt);
      }

      if (opts.signal?.aborted) {
        if (sessionKey) this.sessions.delete(sessionKey);
        void this.sendSessionClose(sessionId);
        throw makeAbortError();
      }

      // Atomic payload selection: send deltaPrompt ONLY when this queued turn actually reused the matching warm session.
      const activePrompt = sessionReused && opts.deltaPrompt ? opts.deltaPrompt : prompt;
      const contentBlocks: Record<string, unknown>[] = [{ type: "text", text: activePrompt }];
      if (opts.sketchDataUrl) {
        const m = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/.exec(opts.sketchDataUrl);
        if (m && m[1] && m[2]) {
          contentBlocks.push({
            type: "image",
            mimeType: `image/${m[1] === "jpg" ? "jpeg" : m[1]}`,
            data: m[2],
          });
        }
      }

      const writtenAt = Date.now();
      const queueWaitMs = Math.max(0, tReady - enqueuedAt);
      const turn: ActiveAcpTurn = {
        sessionId,
        text: "",
        writtenAt,
        toolCalls: 0,
        stepTypes: new Set<string>(),
        onDelta: opts.onDelta,
      };
      this.activeTurns.set(sessionId, turn);

      let aborted = false;
      const onAbort = () => {
        aborted = true;
        this.notify(proc, "session/cancel", { sessionId });
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const timeoutMs = opts.timeoutMs ?? 55_000;
        const rpcPromise = this.rpc(proc, "session/prompt", { sessionId, prompt: contentBlocks }, timeoutMs) as Promise<{
          stopReason?: string;
          usage?: AcpUsage;
        }>;
        const result = opts.signal
          ? await Promise.race([
              rpcPromise,
              new Promise<never>((_, reject) => {
                if (opts.signal!.aborted) reject(makeAbortError());
                else opts.signal!.addEventListener("abort", () => reject(makeAbortError()), { once: true });
              }),
            ])
          : await rpcPromise;

        // Suppress unhandled rejection on the raced rpcPromise if aborted earlier
        void rpcPromise.catch(() => {});

        const now = Date.now();
        if (cachedEntry) {
          cachedEntry.turns = turnInSession;
          cachedEntry.lastUsedAt = now;
        }

        const firstEventMs = turn.firstEventAt !== undefined ? Math.max(0, turn.firstEventAt - writtenAt) : undefined;
        const ttftRawMs = turn.firstDeltaAt !== undefined ? Math.max(0, turn.firstDeltaAt - writtenAt) : undefined;
        const thinkingMs =
          turn.firstDeltaAt !== undefined
            ? Math.max(0, turn.firstDeltaAt - (turn.firstThinkAt ?? writtenAt))
            : turn.firstThinkAt !== undefined
              ? Math.max(0, now - turn.firstThinkAt)
              : undefined;

        const usage = result?.usage;
        try {
          opts.onTrace?.({
            transport: "acp",
            cold_spawn: wasCold,
            spawn_ms: wasCold ? readyWaitMs : 0,
            init_ms: wasCold ? this.bootInitMs || readyWaitMs : undefined,
            session_reused: sessionReused,
            turn_in_proc: turnInSession,
            queue_wait_ms: queueWaitMs,
            first_event_ms: firstEventMs,
            thinking_ms: thinkingMs,
            ttft_raw_ms: ttftRawMs,
            llm_ms: Math.max(0, now - writtenAt),
            prompt_chars: activePrompt.length,
            output_chars: turn.text.length,
            input_tokens: usage?.inputTokens,
            cache_read_tokens: usage?.cachedReadTokens,
            thinking_tokens: usage?.thoughtTokens,
            output_tokens: usage?.outputTokens,
            tool_calls: turn.toolCalls,
            step_types: Array.from(turn.stepTypes),
          });
        } catch {
          /* ignore trace subscriber errors */
        }

        return turn.text.trim();
      } catch (err) {
        // Evict/close dirty or cancelled session so the next turn always starts clean with zero stall.
        if (sessionKey) this.sessions.delete(sessionKey);
        void this.sendSessionClose(sessionId);
        if (aborted || opts.signal?.aborted) throw makeAbortError();
        throw err;
      } finally {
        opts.signal?.removeEventListener("abort", onAbort);
        this.activeTurns.delete(sessionId);
        if (!sessionKey) {
          void this.sendSessionClose(sessionId);
        }
      }
    };

    // Serialize ONLY calls targeting the exact same stateful sessionKey; independent sessions run in parallel!
    if (opts.sessionKey) {
      const prev = this.sessionQueues.get(opts.sessionKey) ?? Promise.resolve();
      const p = prev.then(run, run);
      const cleanup = p.catch(() => {}).finally(() => {
        if (this.sessionQueues.get(opts.sessionKey!) === cleanup) {
          this.sessionQueues.delete(opts.sessionKey!);
        }
      });
      this.sessionQueues.set(opts.sessionKey, cleanup);
      return p;
    }

    return run();
  }

  dispose(): void {
    this.disposed = true;
    this.cleanupProcess(this.proc, this.workDir, "disposed");
  }
}
