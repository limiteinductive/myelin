// Antigravity CLI (`agy`) tutor backend: runs one persistent `agy --input-format stream-json --output-format stream-json`
// process per sitting, connected to an in-process localhost Streamable HTTP MCP server exposing Myelin's tutor tools.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface AgyOptions {
  /** Path to the `agy` binary. Defaults to `agy` (or `~/.local/bin/agy` if present). */
  binary?: string | undefined;
  /** Optional model slug passed via `--model`, e.g. `gemini-4-neon-high`. Omit to use agy's default model. */
  model?: string | undefined;
  /** Optional reasoning effort passed via `--effort` (`low`|`medium`|`high`|`xhigh`|`max`). */
  effort?: string | undefined;
  /** Optional extra environment variables (mainly for tests). */
  env?: NodeJS.ProcessEnv | undefined;
  log?: ((msg: string) => void) | undefined;
}

export interface SittingSession {
  readonly supportsImages: boolean;
  prompt(text: string, opts?: { images?: unknown; onDelta?: (delta: string) => void; onNewMessage?: () => void }): Promise<{ text: string; error?: string }>;
  abort(): Promise<void>;
  dispose(): void;
}

/** Resolves `agy` on PATH or `~/.local/bin/agy`. */
export function resolveAgyBinary(preferred?: string): string {
  if (preferred) return preferred;
  const local = join(homedir(), ".local", "bin", "agy");
  if (existsSync(local)) return local;
  return "agy";
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Minimal loopback-only Streamable HTTP MCP server exposing Myelin's in-process tutor tools to `agy`. */
export class TutorMcpServer {
  private readonly server: Server;
  private readonly token: string;
  private readonly byName: Map<string, ToolDefinition>;
  private port = 0;

  constructor(tools: ToolDefinition[]) {
    this.token = randomBytes(24).toString("hex");
    this.byName = new Map(tools.map((t) => [t.name, t]));
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get authHeader(): string {
    return `Bearer ${this.token}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        resolve();
      });
    });
  }

  close(): void {
    this.server.close();
    this.server.closeAllConnections?.();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== "/mcp" && req.url !== "/mcp/") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== this.authHeader) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest | JsonRpcRequest[];
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      );
      return;
    }

    const isBatch = Array.isArray(body);
    const list: JsonRpcRequest[] = Array.isArray(body) ? body : [body];
    const replies: unknown[] = [];

    for (const msg of list) {
      const reply = await this.dispatch(msg);
      if (reply !== null) replies.push(reply);
    }

    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    const payload = isBatch ? replies : replies[0];
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  }

  private async dispatch(msg: JsonRpcRequest): Promise<unknown | null> {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = msg.method ?? "";
    const ok = (result: unknown) => (hasId ? { jsonrpc: "2.0", id: msg.id, result } : null);
    const err = (code: number, message: string) => (hasId ? { jsonrpc: "2.0", id: msg.id, error: { code, message } } : null);

    if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return null;
    }
    if (method === "initialize") {
      const protocolVersion = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-03-26";
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "myelin-tutor", version: "0.1.0" },
      });
    }
    if (method === "ping") return ok({});
    if (method === "tools/list") {
      const tools = [...this.byName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        // Strip TypeBox symbols so MCP clients receive pure JSON Schema.
        inputSchema: JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown>,
      }));
      return ok({ tools });
    }
    if (method === "tools/call") {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = this.byName.get(name);
      if (!tool) return err(-32602, `Unknown tool: ${name}`);
      try {
        const res = await tool.execute(String(msg.id ?? "mcp"), args as never, undefined as never, undefined as never, undefined as never);
        const content = Array.isArray(res?.content) ? res.content : [{ type: "text", text: "ok" }];
        return ok({ content, isError: false });
      } catch (e) {
        return ok({
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        });
      }
    }
    return err(-32601, `Method not found: ${method}`);
  }
}

interface AgyStreamEvent {
  event?: string;
  step_update?: {
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
  };
  result?: {
    status?: string;
    response?: string;
    error?: string;
  };
}

/** Persistent multi-turn `agy` sitting backed by `--input-format stream-json --output-format stream-json`. */
export class AgySession implements SittingSession {
  readonly supportsImages = false;
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly mcp: TutorMcpServer;
  private readonly workDir: string;
  private stderrBuf = "";
  private closed = false;
  private activeTurn: {
    text: string;
    lastStep: number | null;
    onDelta?: ((d: string) => void) | undefined;
    onNewMessage?: (() => void) | undefined;
    resolve: (r: { text: string; error?: string }) => void;
  } | null = null;

  private constructor(proc: ChildProcessWithoutNullStreams, mcp: TutorMcpServer, workDir: string) {
    this.proc = proc;
    this.mcp = mcp;
    this.workDir = workDir;

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-4000);
    });

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));

    proc.on("error", (err) => {
      this.failTurn(`Could not launch Antigravity CLI (agy): ${err.message}`);
    });
    proc.on("close", (code, signal) => {
      this.closed = true;
      if (this.activeTurn) {
        const detail = this.stderrBuf.trim() || `agy exited (${signal ?? `code ${code}`})`;
        this.failTurn(detail);
      }
    });
  }

  static async create(opts: {
    agy: AgyOptions;
    systemPrompt: string;
    context: string;
    tools: ToolDefinition[];
  }): Promise<AgySession> {
    const mcp = new TutorMcpServer(opts.tools);
    await mcp.start();

    const workDir = mkdtempSync(join(tmpdir(), "myelin-agy-"));
    mkdirSync(join(workDir, ".agents"), { recursive: true });

    const agyGuardrail = `\n\n# Runtime Boundary (Antigravity CLI)\n\nYou are running inside Myelin as the learner's tutor. Use ONLY the \`myelin\` MCP tools (\`find_unit\`, \`revise_unit\`, \`next_probe\`, \`record_probe\`, \`observe_unit\`, \`open_page\`, \`open_aside\`, \`run_code\`, \`start_run\`, \`pause_run\`, \`resume_run\`, \`end_run\`, \`show_card\`, \`stay_quiet\`, \`get_profile\`, \`search_memory\`, \`set_goal\`, \`set_budget\`, \`set_preference\`). Never use coding, filesystem, git, or shell tools.`;
    writeFileSync(join(workDir, "AGENTS.md"), `${opts.systemPrompt}${agyGuardrail}\n\n${opts.context}\n`, "utf8");
    writeFileSync(
      join(workDir, ".agents", "mcp_config.json"),
      JSON.stringify(
        {
          mcpServers: {
            myelin: {
              serverUrl: mcp.url,
              headers: { Authorization: mcp.authHeader },
              timeoutSeconds: 60,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const bin = resolveAgyBinary(opts.agy.binary);
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      "--dangerously-skip-permissions",
    ];
    if (opts.agy.model && opts.agy.model !== "default") args.push("--model", opts.agy.model);
    if (opts.agy.effort) args.push("--effort", opts.agy.effort);

    const proc = spawn(bin, args, {
      cwd: workDir,
      env: { ...process.env, ...opts.agy.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    return new AgySession(proc, mcp, workDir);
  }

  private onLine(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;
    let ev: AgyStreamEvent;
    try {
      ev = JSON.parse(trimmed) as AgyStreamEvent;
    } catch {
      return;
    }
    const turn = this.activeTurn;
    if (!turn) return;

    if (ev.event === "step_update" && ev.step_update?.step_type === "agent_response") {
      const idx = ev.step_update.step_index ?? null;
      const delta = ev.step_update.text_delta ?? "";
      if (delta) {
        if (turn.lastStep !== null && idx !== null && idx !== turn.lastStep && turn.text.length > 0) {
          turn.onNewMessage?.();
        }
        if (idx !== null) turn.lastStep = idx;
        turn.text += delta;
        turn.onDelta?.(delta);
      }
      return;
    }

    if (ev.event === "result" && ev.result) {
      this.activeTurn = null;
      const status = ev.result.status ?? "SUCCESS";
      if (status !== "SUCCESS") {
        turn.resolve({ text: turn.text, error: ev.result.error || this.stderrBuf.trim() || `agy status ${status}` });
        return;
      }
      const finalText = turn.text || ev.result.response || "";
      if (!turn.text && finalText) {
        turn.onDelta?.(finalText);
      }
      turn.resolve({ text: finalText });
    }
  }

  private failTurn(message: string): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    turn.resolve({ text: turn.text, error: message });
  }

  async prompt(text: string, opts?: { onDelta?: (delta: string) => void; onNewMessage?: () => void }): Promise<{ text: string; error?: string }> {
    if (this.closed || this.proc.killed) {
      return { text: "", error: this.stderrBuf.trim() || "Antigravity CLI session closed." };
    }
    this.stderrBuf = "";
    return new Promise((resolve) => {
      this.activeTurn = {
        text: "",
        lastStep: null,
        onDelta: opts?.onDelta,
        onNewMessage: opts?.onNewMessage,
        resolve,
      };
      const payload = JSON.stringify({ event: "user", message: { content: text } }) + "\n";
      this.proc.stdin.write(payload, (err) => {
        if (err) this.failTurn(`Could not write to agy stdin: ${err.message}`);
      });
    });
  }

  async abort(): Promise<void> {
    this.failTurn("aborted");
    if (!this.closed && !this.proc.killed) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      this.proc.kill("SIGTERM");
    }
  }

  dispose(): void {
    this.closed = true;
    this.failTurn("disposed");
    try {
      this.proc.stdin.end();
    } catch {
      /* ignore */
    }
    if (!this.proc.killed) this.proc.kill("SIGTERM");
    this.mcp.close();
    try {
      rmSync(this.workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** One-shot headless `agy` completion for quiet observer triage when no separate triage model is configured. */
export async function agyComplete(agy: AgyOptions, systemPrompt: string, userPrompt: string): Promise<string> {
  const workDir = mkdtempSync(join(tmpdir(), "myelin-agy-tri-"));
  try {
    writeFileSync(join(workDir, "AGENTS.md"), `${systemPrompt}\n\nDo not invoke any tools. Reply directly with the requested output only.\n`, "utf8");
    const bin = resolveAgyBinary(agy.binary);
    const args = ["-p", userPrompt, "--output-format", "json", "--disable-slash-commands", "--effort", "low"];
    if (agy.model && agy.model !== "default") args.push("--model", agy.model);

    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(bin, args, { cwd: workDir, env: { ...process.env, ...agy.env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", (d: string) => (out += d));
      proc.stderr.on("data", (d: string) => (err += d));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code !== 0) return reject(new Error(err.trim() || `agy exited with code ${code}`));
        try {
          const parsed = JSON.parse(out) as { status?: string; response?: string; error?: string };
          if (parsed.status && parsed.status !== "SUCCESS") return reject(new Error(parsed.error || parsed.status));
          resolve(parsed.response ?? "");
        } catch {
          resolve(out.trim());
        }
      });
    });
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
