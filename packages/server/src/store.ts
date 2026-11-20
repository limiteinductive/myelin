// One learner's record: an append-only events table in its own SQLite file, plus the derived state
// kept in memory and rebuilt from the log on open.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyEvent,
  applyPageEdit,
  canonicalJson,
  emptyState,
  EventError,
  newPage,
  PageEditError,
  parseEvent,
  type MyelinEvent,
  type PageState,
  type Scheduler,
  type State,
} from "@myelin/core";

export type Appended = MyelinEvent & { seq: number };
export type Listener = (events: Appended[]) => void;

export class ConflictError extends Error {}
/** A page edit made against a revision that is no longer current. The device reloads and rebases. */
export class StaleError extends Error {}

interface Row {
  seq: number;
  id: string;
  device_id: string;
  ts: number;
  type: string;
  v: number;
  payload: string;
}

const fromRow = (r: Row): Appended =>
  ({ id: r.id, device_id: r.device_id, ts: r.ts, type: r.type, v: r.v, payload: JSON.parse(r.payload), seq: r.seq }) as Appended;

export class EventStore {
  readonly db: DatabaseSync;
  readonly state: State;
  private listeners = new Set<Listener>();
  private dataVersion = 0;

  constructor(
    readonly path: string,
    readonly scheduler: Scheduler,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        device_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        v INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `);
    this.state = emptyState(scheduler);
    this.catchUp();
  }

  get head(): number {
    return this.state.seq;
  }

  close(): void {
    this.db.close();
  }

  /** Events with seq > after, in order. A negative limit means all of them. */
  read(after = 0, limit = 10_000): Appended[] {
    return (this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(after, limit) as unknown as Row[]).map(fromRow);
  }

  /**
   * Appends a batch atomically. Each event is validated first; one bad event rejects the batch.
   * An id already in the log is a retry: it returns the existing seq if the content matches and
   * throws ConflictError if it does not.
   */
  append(inputs: unknown[]): { id: string; seq: number; duplicate: boolean }[] {
    const events = inputs.map((i) => parseEvent(i));
    this.catchUp();
    const out: { id: string; seq: number; duplicate: boolean }[] = [];
    const find = this.db.prepare("SELECT * FROM events WHERE id = ?");
    const insert = this.db.prepare("INSERT INTO events (id, device_id, ts, type, v, payload) VALUES (?, ?, ?, ?, ?, ?)");
    // Page events are checked against scratch copies of the pages, so later edits in the batch see earlier ones.
    const scratch = new Map<string, PageState | null>();
    const page = (id: string) => {
      if (!scratch.has(id)) scratch.set(id, this.state.pages[id] ? structuredClone(this.state.pages[id]) : null);
      return scratch.get(id)!;
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const e of events) {
        const existing = find.get(e.id) as unknown as Row | undefined;
        if (existing) {
          const same = canonicalJson({ ...fromRow(existing), seq: undefined }) === canonicalJson({ ...e, seq: undefined });
          if (!same) throw new ConflictError(`event ${e.id} already exists with different content`);
          out.push({ id: e.id, seq: existing.seq, duplicate: true });
          continue;
        }
        if (e.type === "page.created") {
          if (page(e.payload.page_id)) throw new EventError(`page ${e.payload.page_id} already exists`);
          scratch.set(e.payload.page_id, newPage(e.payload.page_id, e.payload.title, e.payload.starter, e.ts));
        } else if (e.type === "page.edited") {
          const p = page(e.payload.page_id);
          if (!p) throw new EventError(`no page ${e.payload.page_id}`);
          try {
            applyPageEdit(p, e.payload.base_rev, e.payload.steps, e.ts);
          } catch (err) {
            if (!(err instanceof PageEditError)) throw err;
            throw err.stale ? new StaleError(err.message) : new EventError(`event ${e.id}: ${err.message}`);
          }
        }
        const r = insert.run(e.id, e.device_id, e.ts, e.type, e.v, JSON.stringify(e.payload));
        out.push({ id: e.id, seq: Number(r.lastInsertRowid), duplicate: false });
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    // Read back rather than publish the batch alone: another process may have appended just before it.
    this.dataVersion = this.readDataVersion();
    this.publish(this.read(this.state.seq, -1));
    return out;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Picks up events another process (the CLI) appended to the same file. */
  catchUp(): void {
    const v = this.readDataVersion();
    if (v === this.dataVersion && this.state.seq > 0) return;
    this.dataVersion = v;
    this.publish(this.read(this.state.seq, -1));
  }

  private readDataVersion(): number {
    return (this.db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  }

  private publish(fresh: Appended[]): void {
    if (fresh.length === 0) return;
    for (const e of fresh) applyEvent(this.state, e, this.scheduler);
    for (const fn of this.listeners) fn(fresh);
  }
}
