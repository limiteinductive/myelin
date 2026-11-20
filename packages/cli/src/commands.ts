// What each `myelin` command does, separate from argument parsing so tests can call it directly.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACTIVITIES, importStudyMode, metrics, type Metrics } from "@myelin/core";
import { keyEnvFor, ModelKeys, providerName, Registry, Stores, startServer, type RunningServer, type SandboxOptions, type TutorOptions, type User } from "@myelin/server";

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

export const modelSpec = (env: NodeJS.ProcessEnv = process.env) => env.MYELIN_MODEL || "google/gemini-4-neon";
export const providerOf = (spec: string) => spec.split("/")[0] ?? "";

/**
 * The tutor and whose key it runs on. The first user runs on the host's key, if it is set; everyone
 * else brings their own. Never logs a key.
 */
export async function tutorFromEnv(dir: string, registry: Registry, log: (s: string) => void): Promise<{ tutor: TutorOptions; keys: ModelKeys }> {
  const spec = modelSpec();
  const provider = providerOf(spec);
  const keyName = keyEnvFor(provider);
  const hostKey = process.env[keyName] || undefined;
  const agentDir = join(dir, "pi");
  const triage = process.env.MYELIN_TRIAGE_MODEL;
  const keys = await ModelKeys.create({
    registry,
    agentDir,
    spec,
    hostKey,
    triage: triage ? { spec: triage, hostKey: process.env[keyEnvFor(providerOf(triage))] || undefined } : undefined,
  });
  log(`The tutor is ${spec}${triage && triage !== spec ? `, with ${triage} for triage when there is a key for it` : ""}.`);
  const name = providerName(provider);
  log(hostKey ? `You run on ${keyName}. Each friend brings their own ${name} key.` : `${keyName} is not set, so every learner, you too, brings their own ${name} key.`);
  const tutor: TutorOptions = { systemPrompt: readFileSync(promptPath(), "utf8"), model: keys.model, triageModel: keys.triage, agentDir, timeZone: process.env.TZ || undefined };
  const pause = Number(process.env.MYELIN_OBSERVE_PAUSE_MS);
  if (pause > 0) tutor.observePauseMs = pause;
  return { tutor, keys };
}

/** The sandbox as the environment sets it. In the container, runs go to a user of their own. */
export function sandboxFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxOptions {
  const num = (v: string | undefined) => (v && Number(v) > 0 ? Number(v) : undefined);
  const uid = num(env.MYELIN_SANDBOX_UID);
  return {
    python: env.MYELIN_PYTHON || undefined,
    timeoutMs: num(env.MYELIN_RUN_TIMEOUT_MS),
    memoryMb: num(env.MYELIN_RUN_MEMORY_MB),
    user: uid === undefined ? undefined : { uid, gid: num(env.MYELIN_SANDBOX_GID) ?? uid },
  };
}

const linkFor = (base: string, token: string) => `${base.replace(/\/$/, "")}/login/${token}`;

/** Runs the server. On a fresh data directory it makes the first user. Prints a sign-in link for the first user. */
export async function up(opts: {
  port?: number;
  host?: string;
  data?: string;
  name?: string;
  log?: (s: string) => void;
  /** false turns the tutor off; by default it runs on keys from the environment and from friends. */
  tutor?: TutorOptions | false;
}): Promise<RunningServer & { link: string }> {
  const log = opts.log ?? console.log;
  const root = webRoot();
  const dir = dataDir(opts.data);
  const registry = new Registry(dir);
  let tutor: TutorOptions | undefined;
  let keys: ModelKeys | undefined;
  try {
    if (opts.tutor !== false) ({ tutor, keys } = opts.tutor ? { tutor: opts.tutor, keys: undefined } : await tutorFromEnv(dir, registry, log));
  } catch (e) {
    registry.close();
    throw e;
  }
  const sandbox = sandboxFromEnv();
  const srv = await startServer({ port: opts.port ?? DEFAULT_PORT, host: opts.host ?? "127.0.0.1", dataDir: dir, webRoot: root, tutor, keys, registry, sandbox });
  let owner = srv.registry.users()[0];
  if (!owner) {
    owner = srv.registry.createUser(opts.name ?? "me");
    log(`Made the first user, ${owner.name}.`);
  }
  const link = linkFor(process.env.MYELIN_URL || srv.url, srv.registry.issueLink(owner.id));
  if (!root) log("The web app is not built (npm run build -w @myelin/web). Serving the API only.");
  log(`Myelin is running at ${srv.url}`);
  log(`Sign in on this device (the link works once): ${link}`);
  log(`For another device: myelin invite ${owner.name}`);
  return { ...srv, link };
}

/**
 * Makes a user, or a new device link for an existing one. Says which provider's key they will be
 * asked for when they sign in, if any.
 */
export function invite(name: string, opts: { data?: string; url?: string }): { user: User; created: boolean; link: string; bringsKey: string | null } {
  const registry = new Registry(dataDir(opts.data));
  try {
    let user = registry.userByName(name.trim());
    const created = !user;
    user ??= registry.createUser(name);
    const base = opts.url ?? process.env.MYELIN_URL ?? `http://localhost:${DEFAULT_PORT}`;
    const provider = providerOf(modelSpec());
    const owner = registry.users()[0]?.id === user.id;
    const hasKey = registry.modelKey(user.id, provider) !== undefined || (owner && !!process.env[keyEnvFor(provider)]);
    return { user, created, link: linkFor(base, registry.issueLink(user.id)), bringsKey: hasKey ? null : providerName(provider) };
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
