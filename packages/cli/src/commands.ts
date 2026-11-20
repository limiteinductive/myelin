// What each `myelin` command does, separate from argument parsing so tests can call it directly.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importStudyMode } from "@myelin/core";
import { Registry, Stores, startServer, type RunningServer, type User } from "@myelin/server";

export const DEFAULT_PORT = 4317;

export function dataDir(flag?: string): string {
  return flag ?? process.env.MYELIN_DATA ?? join(homedir(), ".myelin", "data");
}

export function webRoot(): string | undefined {
  const candidates = [process.env.MYELIN_WEB, fileURLToPath(new URL("../../web/dist", import.meta.url))];
  return candidates.find((p) => p !== undefined && existsSync(join(p, "index.html")));
}

const linkFor = (base: string, token: string) => `${base.replace(/\/$/, "")}/login/${token}`;

/** Runs the server. On a fresh data directory it makes the first user. Prints a sign-in link for the first user. */
export async function up(opts: { port?: number; host?: string; data?: string; name?: string; log?: (s: string) => void }): Promise<RunningServer & { link: string }> {
  const log = opts.log ?? console.log;
  const root = webRoot();
  const srv = await startServer({ port: opts.port ?? DEFAULT_PORT, host: opts.host ?? "127.0.0.1", dataDir: dataDir(opts.data), webRoot: root });
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
