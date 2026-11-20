// What each `myelin` command does, separate from argument parsing so tests can call it directly.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITIES, importStudyMode, metrics, type Metrics } from "@myelin/core";
import { hostModel, keyEnvFor, Registry, Stores, startServer, type RunningServer, type TutorOptions, type User } from "@myelin/server";

export const DEFAULT_PORT = 4317;

export function dataDir(flag?: string): string {
  return flag ?? process.env.MYELIN_DATA ?? join(homedir(), ".myelin", "data");
}

export function webRoot(): string | undefined {
  const candidates = [process.env.MYELIN_WEB, fileURLToPath(new URL("../../web/dist", import.meta.url))];
  return candidates.find((p) => p !== undefined && existsSync(join(p, "index.html")));
}

/** Reads .env from the working directory and the repository root. Variables already set win. */
export function loadEnv(): void {
  const paths = [join(process.cwd(), ".env"), fileURLToPath(new URL("../../../.env", import.meta.url))];
  for (const p of new Set(paths)) if (existsSync(p)) process.loadEnvFile(p);
}

export function promptPath(): string {
  return process.env.MYELIN_PROMPT ?? fileURLToPath(new URL("../../../prompts/tutor.md", import.meta.url));
}

/** The tutor, if the host has a key for the model in MYELIN_MODEL. Never logs the key. */
export async function tutorFromEnv(dir: string, log: (s: string) => void): Promise<TutorOptions | undefined> {
  const spec = process.env.MYELIN_MODEL || "google/gemini-4-neon";
  const keyName = keyEnvFor(spec.split("/")[0] ?? "");
  const apiKey = process.env[keyName];
  if (!apiKey) {
    log(`${keyName} is not set, so the tutor is off.`);
    return undefined;
  }
  const agentDir = join(dir, "pi");
  const model = await hostModel({ spec, apiKey, agentDir });
  log(`The tutor is ${spec}.`);
  const opts: TutorOptions = { systemPrompt: readFileSync(promptPath(), "utf8"), model, agentDir, timeZone: process.env.TZ || undefined };
  const pause = Number(process.env.MYELIN_OBSERVE_PAUSE_MS);
  if (pause > 0) opts.observePauseMs = pause;
  // The observer's triage may use a cheaper model.
  const triage = process.env.MYELIN_TRIAGE_MODEL;
  if (triage && triage !== spec) {
    const triageKeyName = keyEnvFor(triage.split("/")[0] ?? "");
    const triageKey = process.env[triageKeyName];
    if (!triageKey) log(`${triageKeyName} is not set, so triage uses ${spec}.`);
    else {
      opts.triageModel = await hostModel({ spec: triage, apiKey: triageKey, agentDir });
      log(`Triage is ${triage}.`);
    }
  }
  return opts;
}

const linkFor = (base: string, token: string) => `${base.replace(/\/$/, "")}/login/${token}`;

/** Runs the server. On a fresh data directory it makes the first user. Prints a sign-in link for the first user. */
export async function up(opts: {
  port?: number;
  host?: string;
  data?: string;
  name?: string;
  log?: (s: string) => void;
  /** false turns the tutor off; by default it is on when the host has a model key. */
  tutor?: TutorOptions | false;
}): Promise<RunningServer & { link: string }> {
  const log = opts.log ?? console.log;
  const root = webRoot();
  const dir = dataDir(opts.data);
  const tutor = opts.tutor === false ? undefined : (opts.tutor ?? (await tutorFromEnv(dir, log)));
  const timeout = Number(process.env.MYELIN_RUN_TIMEOUT_MS);
  const sandbox = { python: process.env.MYELIN_PYTHON || undefined, timeoutMs: timeout > 0 ? timeout : undefined };
  const srv = await startServer({ port: opts.port ?? DEFAULT_PORT, host: opts.host ?? "127.0.0.1", dataDir: dir, webRoot: root, tutor, sandbox });
  let owner = srv.registry.users()[0];
  if (!owner) {
    owner = srv.registry.createUser(opts.name ?? "me");
    log(`Made the first user, ${owner.name}.`);
  }
  const link = linkFor(srv.url, srv.registry.issueLink(owner.id));
  if (!root) log("The web app is not built (npm run build -w @myelin/web). Serving the API only.");
  log(`Myelin is running at ${srv.url}`);
  log(`Sign in on this device (the link works once): ${link}`);
  log(`For another device: myelin invite ${owner.name}`);
  return { ...srv, link };
}

/** Makes a user, or a new device link for an existing one. */
export function invite(name: string, opts: { data?: string; url?: string }): { user: User; created: boolean; link: string } {
  const registry = new Registry(dataDir(opts.data));
  try {
    let user = registry.userByName(name.trim());
    const created = !user;
    user ??= registry.createUser(name);
    const base = opts.url ?? process.env.MYELIN_URL ?? `http://localhost:${DEFAULT_PORT}`;
    return { user, created, link: linkFor(base, registry.issueLink(user.id)) };
  } finally {
    registry.close();
  }
}

/** Imports a study-mode memory.jsonl into a user's record. Re-importing the same file adds nothing. */
export function importStudyModeFile(path: string, opts: { data?: string; user?: string }): { user: User; added: number; skipped: number } {
  const dir = dataDir(opts.data);
  const registry = new Registry(dir);
  const stores = new Stores(dir);
  try {
    const users = registry.users();
    const user = opts.user ? registry.userByName(opts.user) : users.length === 1 ? users[0] : undefined;
    if (!user) throw new Error(opts.user ? `no user named ${opts.user}` : `say which user with --user (${users.map((u) => u.name).join(", ") || "none yet"})`);
    const events = importStudyMode(readFileSync(path, "utf8"));
    const results = events.length ? stores.get(user.id).append(events) : [];
    const skipped = results.filter((r) => r.duplicate).length;
    return { user, added: results.length - skipped, skipped };
  } finally {
    stores.close();
    registry.close();
  }
}

/**
 * The measures of whether Myelin works for one learner, as plain text for the person running the
 * server. Never shown in the thread.
 */
export function metricsReport(opts: { data?: string; user?: string; now?: number; timeZone?: string }): { user: User; metrics: Metrics; text: string } {
  const dir = dataDir(opts.data);
  const registry = new Registry(dir);
  const stores = new Stores(dir);
  try {
    const users = registry.users();
    const user = opts.user ? registry.userByName(opts.user) : users.length === 1 ? users[0] : undefined;
    if (!user) throw new Error(opts.user ? `no user named ${opts.user}` : `say which user (${users.map((u) => u.name).join(", ") || "none yet"})`);
    const store = stores.get(user.id);
    const events = store.read(0, -1);
    const now = opts.now ?? Date.now();
    const m = metrics(events, store.state, now, opts.timeZone ?? (process.env.TZ || undefined));
    return { user, metrics: m, text: formatMetrics(user.name, m) };
  } finally {
    stores.close();
    registry.close();
  }
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-");
const dec = (x: number | null) => (x === null ? "-" : x.toFixed(2));
function dur(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m` : `${min}m`;
}

export function formatMetrics(name: string, m: Metrics): string {
  const out: string[] = [`Metrics for ${name}`, ""];
  out.push(
    m.use.probes
      ? `Use, a week or more after finding: ${m.use.succeeded} of ${m.use.probes} probes succeeded (${pct(m.use.succeeded, m.use.probes)}), across ${m.use.units} units.`
      : "Use, a week or more after finding: no probes yet.",
  );
  const c = m.calibration;
  if (c.probes) {
    out.push(`Recall, predicted against actual: ${c.probes} probes, ${dec(c.predicted)} predicted, ${dec(c.actual)} recalled, Brier score ${dec(c.brier)}.`);
    for (const b of c.bins) out.push(`  predicted ${b.from.toFixed(2)}-${b.to.toFixed(2)}: ${b.probes} probes, ${dec(b.predicted)} predicted, ${dec(b.actual)} recalled`);
  } else out.push("Recall, predicted against actual: no graded probes with a prediction yet.");
  out.push("");
  if (!m.weeks.length) {
    out.push("No active time yet.");
    return out.join("\n");
  }
  const head = ["Week of", ...ACTIVITIES.map((a) => a[0]!.toUpperCase() + a.slice(1)), "Units gained", "Use probes"];
  const rows = m.weeks.map((w) => [w.week, ...ACTIVITIES.map((a) => dur(w.active_ms[a])), String(w.units_found), w.use.probes ? `${w.use.succeeded}/${w.use.probes}` : "-"]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  for (const r of [head, ...rows]) out.push(r.map((c, i) => (i === 0 ? c.padEnd(width[i]!) : c.padStart(width[i]!))).join("  "));
  return out.join("\n");
}
