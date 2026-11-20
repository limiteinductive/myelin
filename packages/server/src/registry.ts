// Who may sign in: users, one-time login links and signed-in devices. This is server bookkeeping,
// not a learner's record, so unlike the event log its rows change (a link is used, a device is seen).
// Secrets are stored only as SHA-256 hashes.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface User {
  id: string;
  name: string;
  created_at: number;
}

export interface Device {
  id: string;
  user_id: string;
}

export const LINK_TTL_MS = 7 * 24 * 3_600_000;

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const shortId = (prefix: string) => `${prefix}_${randomBytes(10).toString("base64url").replace(/[-_]/g, "x").toLowerCase()}`;

export class RegistryError extends Error {}

export class Registry {
  readonly db: DatabaseSync;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "registry.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_links (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, device_id TEXT
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, user_agent TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  users(): User[] {
    return this.db.prepare("SELECT id, name, created_at FROM users ORDER BY created_at").all() as unknown as User[];
  }

  user(id: string): User | undefined {
    return this.db.prepare("SELECT id, name, created_at FROM users WHERE id = ?").get(id) as unknown as User | undefined;
  }

  userByName(name: string): User | undefined {
    return this.db.prepare("SELECT id, name, created_at FROM users WHERE name = ?").get(name) as unknown as User | undefined;
  }

  createUser(name: string, now = Date.now()): User {
    const clean = name.trim();
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u.test(clean)) throw new RegistryError(`bad user name: ${JSON.stringify(name)}`);
    if (this.userByName(clean)) throw new RegistryError(`user ${clean} already exists`);
    const u: User = { id: shortId("u"), name: clean, created_at: now };
    this.db.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").run(u.id, u.name, u.created_at);
    return u;
  }

  /** Issues a one-time login link token for a new device. */
  issueLink(userId: string, now = Date.now(), ttlMs = LINK_TTL_MS): string {
    if (!this.user(userId)) throw new RegistryError(`no user ${userId}`);
    const t = token();
    this.db.prepare("INSERT INTO login_links (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(hash(t), userId, now, now + ttlMs);
    return t;
  }

  /** Spends a login link and signs in a new device. Returns the device's long-lived token. */
  redeemLink(linkToken: string, userAgent: string | null, now = Date.now()): { user: User; device: Device; deviceToken: string } {
    const h = hash(linkToken);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const link = this.db.prepare("SELECT user_id, expires_at, used_at FROM login_links WHERE token_hash = ?").get(h) as
        | { user_id: string; expires_at: number; used_at: number | null }
        | undefined;
      if (!link || link.used_at !== null || link.expires_at < now) throw new RegistryError("this link has been used or has expired");
      const device: Device = { id: shortId("dev"), user_id: link.user_id };
      const deviceToken = token();
      this.db
        .prepare("INSERT INTO devices (id, token_hash, user_id, created_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
        .run(device.id, hash(deviceToken), device.user_id, now, now, userAgent);
      this.db.prepare("UPDATE login_links SET used_at = ?, device_id = ? WHERE token_hash = ?").run(now, device.id, h);
      this.db.exec("COMMIT");
      return { user: this.user(link.user_id)!, device, deviceToken };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  authenticate(deviceToken: string, now = Date.now()): { user: User; device: Device } | null {
    const row = this.db.prepare("SELECT id, user_id, last_seen_at FROM devices WHERE token_hash = ?").get(hash(deviceToken)) as
      | { id: string; user_id: string; last_seen_at: number }
      | undefined;
    if (!row) return null;
    if (now - row.last_seen_at > 60_000) this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, row.id);
    return { user: this.user(row.user_id)!, device: { id: row.id, user_id: row.user_id } };
  }
}
