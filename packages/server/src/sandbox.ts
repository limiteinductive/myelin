// The Python sandbox: Run page runs every code block on a page, top to bottom, in one fresh
// interpreter, so no state survives from an earlier run. Each block's printed output and the value of
// its last expression are kept per block, and the run stops at the first block that fails.
//
// What this isolates: a fresh process and working directory per run, an environment with none of the
// server's secrets, a wall-clock timeout that kills the whole process group, a CPU-time and file-size
// limit, and capped output. It does not isolate the file system or the network by itself. In the
// container (deploy/) runs go to a user of their own, which the container cuts off from the network
// and the learners' files; then a run also gets a memory and process limit, and anything it leaves
// running is killed when it ends.
import { spawn } from "node:child_process";
import { chown, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SandboxOptions {
  /** The Python to run. Default `python3`. */
  python?: string | undefined;
  /** The longest a run may take. Default 30 seconds. */
  timeoutMs?: number | undefined;
  /** Output kept per block, in characters. Default 20,000. */
  maxOutput?: number | undefined;
  /**
   * Runs as this user and group, which needs the server to be root. Nothing else may run as this
   * user: every process it owns is killed after each run.
   */
  user?: { uid: number; gid: number } | undefined;
  /** The memory a run may allocate, in megabytes. Unlimited by default. */
  memoryMb?: number | undefined;
}

export interface BlockResult {
  output: string;
  failed: boolean;
}

export interface RunResult {
  /** One per block that ran. A run stops at the first block that fails. */
  blocks: BlockResult[];
  timed_out: boolean;
  duration_ms: number;
}

const DRIVER = String.raw`
import ast, contextlib, io, json, linecache, os, sys, traceback
import resource


def limit(which, soft, hard=None):
    try:
        resource.setrlimit(which, (soft, soft if hard is None else hard))
    except Exception:
        pass


cpu = int(os.environ.get("MYELIN_CPU_S", "0"))
if cpu > 0:
    limit(resource.RLIMIT_CPU, cpu, cpu + 1)
limit(resource.RLIMIT_FSIZE, 64 << 20)
mem = int(os.environ.get("MYELIN_MEM_MB", "0"))
if mem > 0:
    limit(resource.RLIMIT_DATA, mem << 20)
nproc = int(os.environ.get("MYELIN_NPROC", "0"))
if nproc > 0:
    limit(resource.RLIMIT_NPROC, nproc)
try:
    # If memory runs short, the run goes first, not the server.
    with open("/proc/self/oom_score_adj", "w") as f:
        f.write("1000")
except Exception:
    pass

results = os.fdopen(3, "w", encoding="utf-8")
blocks = json.load(sys.stdin)
sys.stdin = io.StringIO("")
LIMIT = int(os.environ.get("MYELIN_MAX_OUTPUT", "20000"))
DRIVER = os.path.abspath(__file__)
scope = {"__name__": "__main__", "__builtins__": __builtins__}


class Capped(io.StringIO):
    def write(self, s):
        room = LIMIT + 1 - self.tell()
        if room > 0:
            super().write(s[:room])
        return len(s)


def run(i, code):
    name = "<block %d>" % (i + 1)
    linecache.cache[name] = (len(code), None, code.splitlines(True), name)
    buf = Capped()
    failed = False
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        try:
            tree = ast.parse(code, name, "exec")
            last = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = ast.Expression(tree.body.pop().value)
            exec(compile(tree, name, "exec"), scope)
            if last is not None:
                value = eval(compile(last, name, "eval"), scope)
                if value is not None:
                    print(repr(value))
        except BaseException as e:
            failed = True
            tb = e.__traceback__
            while tb is not None and os.path.abspath(tb.tb_frame.f_code.co_filename) == DRIVER:
                tb = tb.tb_next
            buf.write("".join(traceback.format_exception(type(e), e, tb)))
    sys.__stdout__.flush()
    sys.__stderr__.flush()
    out = buf.getvalue()
    if len(out) > LIMIT:
        out = out[:LIMIT] + "\n... output cut at %d characters" % LIMIT
    return out, failed


for i, code in enumerate(blocks):
    out, failed = run(i, code)
    results.write(json.dumps({"output": out, "failed": failed}) + "\n")
    results.flush()
    if failed:
        break
`;

/** Run as the sandbox's own user: kills every process that user owns, except itself. */
const SWEEP = `import os, signal
try:
    os.kill(-1, signal.SIGKILL)
except ProcessLookupError:
    pass`;

/** Processes and threads a run may have at once, when it has a user of its own. PyTorch starts a thread per core. */
const MAX_PROCS = 256;

export class Sandbox {
  readonly python: string;
  readonly timeoutMs: number;
  readonly maxOutput: number;
  readonly user: { uid: number; gid: number } | undefined;
  readonly memoryMb: number | undefined;
  /** Runs wait their turn, so one learner cannot start many at once. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: SandboxOptions = {}) {
    this.python = opts.python ?? "python3";
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxOutput = opts.maxOutput ?? 20_000;
    this.user = opts.user;
    this.memoryMb = opts.memoryMb;
  }

  /** Runs the blocks in order in one interpreter. Never throws for a failure in the code. */
  run(blocks: readonly string[]): Promise<RunResult> {
    const next = this.queue.then(() => this.runNow(blocks));
    this.queue = next.catch(() => {});
    return next;
  }

  private async runNow(blocks: readonly string[]): Promise<RunResult> {
    const started = Date.now();
    if (blocks.length === 0) return { blocks: [], timed_out: false, duration_ms: 0 };
    const dir = await mkdtemp(join(tmpdir(), "myelin-run-"));
    try {
      const driver = join(dir, ".driver.py");
      await writeFile(driver, DRIVER);
      if (this.user) await chown(dir, this.user.uid, this.user.gid);
      return await this.spawn(driver, dir, blocks, started);
    } finally {
      if (this.user) await this.sweep();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Kills whatever a run left behind, even outside its process group. Runs are one at a time, so nothing else is cut short. */
  private sweep(): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(this.python, ["-c", SWEEP], { ...this.user, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, stdio: "ignore", timeout: 10_000 });
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    });
  }

  private spawn(driver: string, dir: string, blocks: readonly string[], started: number): Promise<RunResult> {
    // Only what Python needs. HOME stays so packages installed for the user (PyTorch) are found,
    // unless the run has a user of its own: then the packages are installed for everyone.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      MPLBACKEND: "Agg",
      MYELIN_CPU_S: String(Math.ceil(this.timeoutMs / 1000) + 5),
      MYELIN_MAX_OUTPUT: String(this.maxOutput),
    };
    if (this.user) {
      env.HOME = dir;
      env.MYELIN_NPROC = String(MAX_PROCS);
    } else if (process.env.HOME) env.HOME = process.env.HOME;
    if (this.memoryMb) env.MYELIN_MEM_MB = String(this.memoryMb);

    return new Promise((resolve) => {
      const child = spawn(this.python, ["-u", "-B", driver], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe", "pipe"], detached: true, ...this.user });
      const results: BlockResult[] = [];
      let pending = "";
      let stray = "";
      let timedOut = false;
      let failedToStart: Error | null = null;
      const keep = (chunk: Buffer) => {
        if (stray.length < this.maxOutput) stray += chunk.toString("utf8");
      };
      child.stdout!.on("data", keep);
      child.stderr!.on("data", keep);
      const fd3 = child.stdio[3] as NodeJS.ReadableStream;
      fd3.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let nl: number;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          try {
            const r = JSON.parse(line) as BlockResult;
            results.push({ output: String(r.output ?? ""), failed: Boolean(r.failed) });
          } catch {
            /* not a result line */
          }
        }
      });
      const kill = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, this.timeoutMs);
      child.on("error", (e) => {
        failedToStart = e;
      });
      child.stdin!.on("error", () => {});
      child.stdin!.end(JSON.stringify(blocks));
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        kill(); // anything the code left running in the background
        const extra = stray.slice(0, this.maxOutput).trimEnd();
        const done = results.length === blocks.length || results.at(-1)?.failed;
        if (!done) {
          const why = failedToStart
            ? `The sandbox could not start ${this.python}: ${failedToStart.message}`
            : timedOut
              ? `Stopped: the page ran for more than ${Math.round(this.timeoutMs / 1000)} seconds.`
              : `The run stopped (${signal ?? `exit code ${code}`}).`;
          results.push({ output: [extra, why].filter(Boolean).join("\n"), failed: true });
        } else if (extra) {
          // Output written past Python's own streams, such as from a C extension.
          const last = results.at(-1)!;
          last.output = [last.output.trimEnd(), extra].filter(Boolean).join("\n");
        }
        resolve({ blocks: results, timed_out: timedOut, duration_ms: Date.now() - started });
      });
    });
  }
}
