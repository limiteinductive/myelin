// `myelin deploy <host>`: sends the source to the host over SSH, builds the image there with Docker
// and starts it with the data volume and HTTPS. The deploying machine needs SSH and tar, not Docker,
// and the image is built for the host's own architecture. Model keys go to the host on SSH's stdin,
// into a file only its owner can read, never on a command line.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyEnvFor } from "@myelin/server";
import { modelSpec, providerOf } from "./commands.js";

export const CONTAINER = "myelin";
export const IMAGE = "myelin:latest";
export const VOLUME = "myelin-data";

/** What goes to the host: the source, never data, keys, dependencies or built files. */
export const CONTEXT = ["Dockerfile", ".dockerignore", "package.json", "package-lock.json", "tsconfig.base.json", "packages", "design", "prompts", "deploy"];
export const EXCLUDE = ["node_modules", "dist", "*.tsbuildinfo", ".env", ".env.*", "*.sqlite", "*.sqlite-*", ".DS_Store"];

/** Settings that mean the same on the host. Paths such as MYELIN_DATA do not. */
const FORWARD = ["MYELIN_MODEL", "MYELIN_TRIAGE_MODEL", "MYELIN_OBSERVE_PAUSE_MS", "MYELIN_RUN_TIMEOUT_MS", "MYELIN_RUN_MEMORY_MB"];

/** The capabilities the container keeps. The entrypoint gives up NET_ADMIN and SETPCAP once the sandbox's firewall rule is in. */
export const CAPS = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "KILL", "NET_BIND_SERVICE", "NET_ADMIN", "SETPCAP"];

export function repoRoot(): string {
  return fileURLToPath(new URL("../../..", import.meta.url));
}

/** Quotes a word for the host's shell. */
export function q(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The domain to serve at: --domain, or the host's name if it is one. */
export function domainFor(host: string, flag?: string): string {
  const d = (flag ?? host.replace(/^ssh:\/\//, "").split("@").pop()!.split(":")[0]!).trim().toLowerCase();
  if (!d.includes(".") || isIP(d) || !/^[a-z0-9.-]+$/.test(d)) {
    throw new Error(`Name the domain to serve at, one that points at the host: myelin deploy ${host} --domain myelin.example.com`);
  }
  return d;
}

/**
 * The container's environment: where it is served, and the settings and host keys from here. Returns
 * the names of the keys it carries, never their values.
 */
export function deployEnv(env: NodeJS.ProcessEnv, opts: { domain: string; name?: string | undefined }): { text: string; keys: string[]; missing: string | null } {
  const vars: [string, string][] = [
    ["MYELIN_DOMAIN", opts.domain],
    ["MYELIN_URL", `https://${opts.domain}`],
    // Days and weeks follow the deploying machine's time zone, as they do with `myelin up`.
    ["TZ", env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone],
  ];
  if (opts.name) vars.push(["MYELIN_NAME", opts.name]);
  for (const k of FORWARD) if (env[k]) vars.push([k, env[k]!]);
  const main = keyEnvFor(providerOf(modelSpec(env)));
  const triage = env.MYELIN_TRIAGE_MODEL ? keyEnvFor(providerOf(env.MYELIN_TRIAGE_MODEL)) : main;
  const keys = [...new Set([main, triage])].filter((k) => env[k]);
  for (const k of keys) vars.push([k, env[k]!]);
  for (const [k, v] of vars) if (/[\r\n]/.test(v)) throw new Error(`${k} holds a line break`);
  return { text: vars.map(([k, v]) => `${k}=${v}\n`).join(""), keys, missing: env[main] ? null : main };
}

/** `docker run` for the app: the volume, HTTPS ports, and a container the sandbox cannot write to outside /tmp. */
export function runCommand(): string {
  const args = [
    "docker", "run", "-d", "--name", CONTAINER, "--restart", "unless-stopped", "--init",
    "-p", "80:80", "-p", "443:443", "-p", "443:443/udp",
    "-v", `${VOLUME}:/data`,
    "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=1g,mode=1777",
    "--cap-drop", "ALL", ...CAPS.flatMap((c) => ["--cap-add", c]),
    "--security-opt", "no-new-privileges", "--pids-limit", "512",
  ];
  return `${args.map(q).join(" ")} --env-file "$HOME/.myelin/env" ${IMAGE}`;
}

export interface DeployOptions {
  /** Where to SSH to, as `ssh` takes it: `user@host` or a name from ~/.ssh/config. */
  host: string;
  domain?: string | undefined;
  /** The first user's name, on a fresh volume. */
  name?: string | undefined;
  env?: NodeJS.ProcessEnv;
  root?: string;
  log?: (s: string) => void;
  /** Where build output goes. By default, this terminal. */
  quiet?: boolean;
  /** The ssh program. Tests replace it. */
  ssh?: string;
  fetch?: typeof fetch;
  /** How long to wait for the server to start, and then for HTTPS. */
  startMs?: number;
  httpsMs?: number;
  pollMs?: number;
}

interface Ran {
  code: number;
  out: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deploy(opts: DeployOptions): Promise<{ url: string; link: string | null; served: boolean }> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const root = opts.root ?? repoRoot();
  const poll = opts.pollMs ?? 2_000;
  if (opts.host.startsWith("-")) throw new Error(`not a host: ${opts.host}`);
  if (!existsSync(join(root, "Dockerfile"))) throw new Error(`deploy runs from the Myelin repository; there is no Dockerfile in ${root}`);
  const domain = domainFor(opts.host, opts.domain);
  const url = `https://${domain}`;
  const { text, keys, missing } = deployEnv(env, { domain, name: opts.name });

  const ssh = (script: string, io: { stdin?: string | NodeJS.ReadableStream; show?: boolean } = {}): Promise<Ran> =>
    new Promise((resolve, reject) => {
      const show = io.show && !opts.quiet;
      const child = spawn(opts.ssh ?? "ssh", ["-o", "ConnectTimeout=20", opts.host, script], { stdio: ["pipe", show ? "inherit" : "pipe", show ? "inherit" : "pipe"] });
      let out = "";
      child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.stderr?.on("data", (b: Buffer) => (out += b.toString("utf8")));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
      child.stdin!.on("error", () => {});
      if (typeof io.stdin === "string") child.stdin!.end(io.stdin);
      else if (io.stdin) io.stdin.pipe(child.stdin!);
      else child.stdin!.end();
    });
  const must = async (what: string, r: Promise<Ran>) => {
    const { code, out } = await r;
    if (code !== 0) throw new Error(`${what} failed on ${opts.host}${out.trim() ? `:\n${out.trim().split("\n").slice(-15).join("\n")}` : "."}`);
    return out;
  };

  const version = await ssh("docker version --format '{{.Server.Version}}'");
  if (version.code !== 0) throw new Error(`Docker is not running on ${opts.host}, or this user cannot use it:\n${version.out.trim()}`);
  log(`Deploying to ${opts.host} (Docker ${version.out.trim()}), to be served at ${url}.`);
  log(keys.length ? `The tutor runs on ${keys.join(" and ")} from here for you.` : `${missing} is not set here, so every learner, you too, brings their own key.`);

  await must("Writing the settings", ssh(`umask 077 && mkdir -p "$HOME/.myelin" && cat > "$HOME/.myelin/env"`, { stdin: text }));

  log("Building the image on the host. The first build takes a few minutes.");
  const tar = spawn("tar", ["-cz", "-f", "-", ...EXCLUDE.flatMap((e) => ["--exclude", e]), "-C", root, ...CONTEXT], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tarErr = "";
  tar.stderr.on("data", (b: Buffer) => (tarErr += b.toString("utf8")));
  const tarDone = new Promise<number>((resolve) => tar.on("close", (c) => resolve(c ?? 1)));
  const built = ssh(`docker build --label app=myelin -t ${IMAGE} -`, { stdin: tar.stdout, show: true });
  if ((await tarDone) !== 0) throw new Error(`Packing the source failed: ${tarErr.trim()}`);
  await must("Building the image", built);

  await must(
    "Starting the container",
    ssh(
      [
        `docker volume create ${VOLUME} >/dev/null`,
        `{ docker rm -f ${CONTAINER} >/dev/null 2>&1 || true; }`,
        `${runCommand()} >/dev/null`,
        "docker image prune -f --filter label=app=myelin >/dev/null",
      ].join(" && "),
    ),
  );

  // The server prints the first user's sign-in link when it starts.
  let link: string | null = null;
  const startBy = Date.now() + (opts.startMs ?? 120_000);
  for (;;) {
    const r = await ssh(`docker inspect -f '{{.State.Running}}' ${CONTAINER} && docker logs ${CONTAINER} 2>&1`);
    const lines = r.out.split("\n");
    link = lines.findLast((l) => l.startsWith("Sign in on this device"))?.replace(/^.*?: /, "") ?? null;
    if (link) {
      for (const l of lines) if (/^(The tutor is|You run on|.* is not set, so|Made the first user)/.test(l)) log(l);
      break;
    }
    if (!lines[0]?.startsWith("true") || Date.now() > startBy) {
      throw new Error(`The server did not start on ${opts.host}. Its last words:\n${lines.slice(-15).join("\n").trim()}`);
    }
    await sleep(poll);
  }

  // HTTPS answers once Caddy has its certificate.
  const get = opts.fetch ?? fetch;
  const httpsBy = Date.now() + (opts.httpsMs ?? 180_000);
  let served = false;
  log(`Waiting for ${url} to answer over HTTPS.`);
  while (!served && Date.now() < httpsBy) {
    try {
      served = (await get(`${url}/`, { signal: AbortSignal.timeout(10_000) })).ok;
    } catch {
      // Not yet.
    }
    if (!served) await sleep(poll);
  }
  if (served) log(`Myelin is up at ${url}`);
  else log(`The server runs on ${opts.host}, but ${url} does not answer yet. Check that ${domain} points at the host and that ports 80 and 443 are open.`);
  return { url, link, served };
}

/** Runs a `myelin` command inside the deployed container, such as `invite Bo`. */
export function onHost(host: string, args: string[], sshProgram = "ssh"): Promise<number> {
  if (host.startsWith("-")) throw new Error(`not a host: ${host}`);
  return new Promise((resolve, reject) => {
    const child = spawn(sshProgram, ["-o", "ConnectTimeout=20", host, ["docker", "exec", CONTAINER, "myelin", ...args].map(q).join(" ")], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
