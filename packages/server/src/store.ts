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

export interface StoredInlineAnnotation {
  quote: string;
  note: string;
  kind: "slip" | "question" | "move";
}

export interface StoredAttemptTurn {
  user: string;
  coach: string;
  sketch?: string | null;
  failed?: boolean;
  annotations?: StoredInlineAnnotation[];
  added?: { unit_id: string; text: string; kind: string; observe_only: boolean }[];
}

export interface DrillAttemptRecord {
  attempt_id: string;
  unit_id: string;
  depth: string;
  prompt: string;
  first_attempt: string;
  turns: StoredAttemptTurn[];
  status: "active" | "passed" | "abandoned";
  assistance_count: number;
  active_ms: number | null;
  probe_id: string | null;
  grade: string | null;
  result: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
}

export interface StoredBriefingCrux {
  text: string;
  kind: string;
  question: string;
  source_ref?: string;
}

export interface StoredBriefingTurn {
  user: string;
  coach: string;
  added?: { unit_id: string; text: string; kind: string; observe_only: boolean }[];
}

export interface ExplorationRecord {
  id: string;
  title: string;
  turns: StoredBriefingTurn[];
  archived?: boolean;
  created_at: number;
  updated_at: number;
}

export interface AgentMemoryRecord {
  key: string;
  content: string;
  last_dream_seq: number;
  last_dream_at: number;
  dream_count: number;
  updated_at: number;
  updated_by: "dream" | "learner";
}

export interface DreamLogRecord {
  id: string;
  from_seq: number;
  to_seq: number;
  summary: string;
  promoted: string[];
  graduated: string[];
  created_at: number;
}

export interface BriefingRecord {
  id: string;
  title: string;
  source: string;
  body: string;
  skipped_known: string[];
  cruxes: StoredBriefingCrux[];
  demonstrated_cruxes: number[];
  turns: StoredBriefingTurn[];
  created_at: number;
  updated_at: number;
}

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
      CREATE TABLE IF NOT EXISTS drill_attempts (
        attempt_id TEXT PRIMARY KEY,
        unit_id TEXT NOT NULL,
        depth TEXT NOT NULL,
        prompt TEXT NOT NULL,
        first_attempt TEXT NOT NULL,
        turns_json TEXT NOT NULL,
        status TEXT NOT NULL,
        assistance_count INTEGER NOT NULL DEFAULT 0,
        active_ms INTEGER,
        probe_id TEXT,
        grade TEXT,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS drill_attempts_unit_status ON drill_attempts(unit_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS briefings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        body TEXT NOT NULL,
        skipped_known_json TEXT NOT NULL,
        cruxes_json TEXT NOT NULL,
        demonstrated_cruxes_json TEXT NOT NULL,
        turns_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS explorations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        turns_json TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_memory (
        key TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        last_dream_seq INTEGER NOT NULL DEFAULT 0,
        last_dream_at INTEGER NOT NULL DEFAULT 0,
        dream_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL DEFAULT 'dream'
      );
      CREATE TABLE IF NOT EXISTS dream_logs (
        id TEXT PRIMARY KEY,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        promoted_json TEXT NOT NULL,
        graduated_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const expCols = this.db.prepare("PRAGMA table_info(explorations)").all() as unknown as { name?: string }[];
    if (!expCols.some((c) => c.name === "archived")) {
      this.db.exec("ALTER TABLE explorations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
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
          scratch.set(e.payload.page_id, newPage(e.payload.page_id, e.payload.title, e.payload.starter, e.ts, e.payload.probe));
        } else if (e.type === "page.edited") {
          const p = page(e.payload.page_id);
          if (!p) throw new EventError(`no page ${e.payload.page_id}`);
          try {
            applyPageEdit(p, e.payload.base_rev, e.payload.steps, e.ts);
          } catch (err) {
            if (!(err instanceof PageEditError)) throw err;
            throw err.stale ? new StaleError(err.message) : new EventError(`event ${e.id}: ${err.message}`);
          }
        } else if (e.type === "page.ran") {
          if (!page(e.payload.page_id)) throw new EventError(`no page ${e.payload.page_id}`);
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

  // --- Durable per-user Drill Attempts (idempotency, active telemetry, cross-device resume) ---

  private parseAttemptRow(r: Record<string, unknown>): DrillAttemptRecord {
    return {
      attempt_id: String(r.attempt_id),
      unit_id: String(r.unit_id),
      depth: String(r.depth),
      prompt: String(r.prompt),
      first_attempt: String(r.first_attempt),
      turns: JSON.parse(String(r.turns_json || "[]")) as StoredAttemptTurn[],
      status: (r.status === "passed" || r.status === "abandoned" ? r.status : "active"),
      assistance_count: Number(r.assistance_count ?? 0),
      active_ms: typeof r.active_ms === "number" ? r.active_ms : null,
      probe_id: typeof r.probe_id === "string" ? r.probe_id : null,
      grade: typeof r.grade === "string" ? r.grade : null,
      result: typeof r.result_json === "string" && r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : null,
      created_at: Number(r.created_at ?? 0),
      updated_at: Number(r.updated_at ?? 0),
    };
  }

  getAttempt(attemptId: string): DrillAttemptRecord | null {
    const r = this.db.prepare("SELECT * FROM drill_attempts WHERE attempt_id = ?").get(attemptId) as Record<string, unknown> | undefined;
    return r ? this.parseAttemptRow(r) : null;
  }

  /** Returns the latest active (in-progress) attempt per unit for cross-device resume. */
  getActiveAttempts(): DrillAttemptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM drill_attempts WHERE status = 'active' ORDER BY updated_at DESC")
      .all() as unknown as Record<string, unknown>[];
    const seen = new Set<string>();
    const out: DrillAttemptRecord[] = [];
    for (const r of rows) {
      const rec = this.parseAttemptRow(r);
      if (seen.has(rec.unit_id)) continue;
      seen.add(rec.unit_id);
      out.push(rec);
    }
    return out;
  }

  upsertAttempt(rec: DrillAttemptRecord): void {
    this.db
      .prepare(
        `INSERT INTO drill_attempts
          (attempt_id, unit_id, depth, prompt, first_attempt, turns_json, status, assistance_count, active_ms, probe_id, grade, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET
          turns_json = excluded.turns_json,
          status = excluded.status,
          assistance_count = excluded.assistance_count,
          active_ms = excluded.active_ms,
          probe_id = COALESCE(excluded.probe_id, drill_attempts.probe_id),
          grade = COALESCE(excluded.grade, drill_attempts.grade),
          result_json = COALESCE(excluded.result_json, drill_attempts.result_json),
          updated_at = excluded.updated_at`,
      )
      .run(
        rec.attempt_id,
        rec.unit_id,
        rec.depth,
        rec.prompt,
        rec.first_attempt,
        JSON.stringify(rec.turns),
        rec.status,
        rec.assistance_count,
        rec.active_ms,
        rec.probe_id,
        rec.grade,
        rec.result ? JSON.stringify(rec.result) : null,
        rec.created_at,
        rec.updated_at,
      );
  }

  abandonActiveAttempts(unitId: string, exceptAttemptId?: string, now = Date.now()): void {
    if (exceptAttemptId) {
      this.db
        .prepare("UPDATE drill_attempts SET status = 'abandoned', updated_at = ? WHERE unit_id = ? AND status = 'active' AND attempt_id != ?")
        .run(now, unitId, exceptAttemptId);
    } else {
      this.db
        .prepare("UPDATE drill_attempts SET status = 'abandoned', updated_at = ? WHERE unit_id = ? AND status = 'active'")
        .run(now, unitId);
    }
  }

  // --- Durable per-user Briefings (atomic SQLite storage + cross-device discussion & crux progress) ---

  private parseBriefingRow(r: Record<string, unknown>): BriefingRecord {
    return {
      id: String(r.id),
      title: String(r.title),
      source: String(r.source),
      body: String(r.body),
      skipped_known: JSON.parse(String(r.skipped_known_json || "[]")) as string[],
      cruxes: JSON.parse(String(r.cruxes_json || "[]")) as StoredBriefingCrux[],
      demonstrated_cruxes: JSON.parse(String(r.demonstrated_cruxes_json || "[]")) as number[],
      turns: JSON.parse(String(r.turns_json || "[]")) as StoredBriefingTurn[],
      created_at: Number(r.created_at ?? 0),
      updated_at: Number(r.updated_at ?? 0),
    };
  }

  listBriefings(): BriefingRecord[] {
    const rows = this.db.prepare("SELECT * FROM briefings ORDER BY created_at ASC").all() as unknown as Record<string, unknown>[];
    return rows.map((r) => this.parseBriefingRow(r));
  }

  getBriefing(id: string): BriefingRecord | null {
    const r = this.db.prepare("SELECT * FROM briefings WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.parseBriefingRow(r) : null;
  }

  saveBriefing(b: BriefingRecord): void {
    this.db
      .prepare(
        `INSERT INTO briefings
          (id, title, source, body, skipped_known_json, cruxes_json, demonstrated_cruxes_json, turns_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          source = excluded.source,
          body = excluded.body,
          skipped_known_json = excluded.skipped_known_json,
          cruxes_json = excluded.cruxes_json,
          demonstrated_cruxes_json = excluded.demonstrated_cruxes_json,
          turns_json = excluded.turns_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        b.id,
        b.title,
        b.source,
        b.body,
        JSON.stringify(b.skipped_known),
        JSON.stringify(b.cruxes),
        JSON.stringify(b.demonstrated_cruxes),
        JSON.stringify(b.turns),
        b.created_at,
        b.updated_at,
      );
  }

  updateBriefingProgress(id: string, turns: StoredBriefingTurn[], demonstratedCruxes: number[], now = Date.now()): void {
    this.db
      .prepare("UPDATE briefings SET turns_json = ?, demonstrated_cruxes_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(turns), JSON.stringify(demonstratedCruxes), now, id);
  }

  deleteBriefing(id: string): boolean {
    const info = this.db.prepare("DELETE FROM briefings WHERE id = ?").run(id);
    return Number(info.changes ?? 0) > 0;
  }

  // --- Durable per-user Explorations (atomic SQLite storage + sidebar + cross-device sync) ---

  private parseExplorationRow(r: Record<string, unknown>): ExplorationRecord {
    return {
      id: String(r.id),
      title: String(r.title),
      turns: JSON.parse(String(r.turns_json || "[]")) as StoredBriefingTurn[],
      archived: Number(r.archived ?? 0) !== 0,
      created_at: Number(r.created_at ?? 0),
      updated_at: Number(r.updated_at ?? 0),
    };
  }

  listExplorations(includeArchived = false): ExplorationRecord[] {
    const sql = includeArchived
      ? "SELECT * FROM explorations ORDER BY updated_at DESC"
      : "SELECT * FROM explorations WHERE archived = 0 ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all() as unknown as Record<string, unknown>[];
    return rows.map((r) => this.parseExplorationRow(r));
  }

  getExploration(id: string): ExplorationRecord | null {
    const r = this.db.prepare("SELECT * FROM explorations WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.parseExplorationRow(r) : null;
  }

  saveExploration(e: ExplorationRecord): void {
    this.db
      .prepare(
        `INSERT INTO explorations (id, title, turns_json, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          turns_json = excluded.turns_json,
          archived = excluded.archived,
          updated_at = excluded.updated_at`,
      )
      .run(e.id, e.title, JSON.stringify(e.turns), e.archived ? 1 : 0, e.created_at, e.updated_at);
  }

  archiveExploration(id: string, archived = true, now = Date.now()): boolean {
    const info = this.db
      .prepare("UPDATE explorations SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, now, id);
    return Number(info.changes ?? 0) > 0;
  }

  deleteExploration(id: string): boolean {
    const info = this.db.prepare("DELETE FROM explorations WHERE id = ?").run(id);
    return Number(info.changes ?? 0) > 0;
  }

  /** Recent drill attempt transcripts (both passed and active) since `sinceMs` for offline Dreaming. */
  listRecentAttempts(sinceMs = 0, limit = 20): DrillAttemptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM drill_attempts WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?")
      .all(sinceMs, limit) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      attempt_id: String(r.attempt_id),
      unit_id: String(r.unit_id),
      depth: String(r.depth),
      prompt: String(r.prompt),
      first_attempt: String(r.first_attempt),
      turns: JSON.parse(String(r.turns_json || "[]")) as StoredAttemptTurn[],
      status: String(r.status) as DrillAttemptRecord["status"],
      assistance_count: Number(r.assistance_count ?? 0),
      active_ms: r.active_ms === null || r.active_ms === undefined ? null : Number(r.active_ms),
      probe_id: r.probe_id === null || r.probe_id === undefined ? null : String(r.probe_id),
      grade: r.grade === null || r.grade === undefined ? null : String(r.grade),
      result: r.result_json ? (JSON.parse(String(r.result_json)) as Record<string, unknown>) : null,
      created_at: Number(r.created_at ?? 0),
      updated_at: Number(r.updated_at ?? 0),
    }));
  }

  // --- Lean Agent Memory (learner.md) & Offline Dreaming Consolidation Logs ---

  getAgentMemory(key = "learner"): AgentMemoryRecord | null {
    const r = this.db.prepare("SELECT * FROM agent_memory WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      key: String(r.key),
      content: String(r.content ?? ""),
      last_dream_seq: Number(r.last_dream_seq ?? 0),
      last_dream_at: Number(r.last_dream_at ?? 0),
      dream_count: Number(r.dream_count ?? 0),
      updated_at: Number(r.updated_at ?? 0),
      updated_by: r.updated_by === "learner" ? "learner" : "dream",
    };
  }

  saveAgentMemory(rec: AgentMemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_memory (key, content, last_dream_seq, last_dream_at, dream_count, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
          content = excluded.content,
          last_dream_seq = excluded.last_dream_seq,
          last_dream_at = excluded.last_dream_at,
          dream_count = excluded.dream_count,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by`,
      )
      .run(
        rec.key,
        rec.content,
        rec.last_dream_seq,
        rec.last_dream_at,
        rec.dream_count,
        rec.updated_at,
        rec.updated_by,
      );
  }

  addDreamLog(log: DreamLogRecord): void {
    this.db
      .prepare(
        `INSERT INTO dream_logs (id, from_seq, to_seq, summary, promoted_json, graduated_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        log.id,
        log.from_seq,
        log.to_seq,
        log.summary,
        JSON.stringify(log.promoted),
        JSON.stringify(log.graduated),
        log.created_at,
      );
  }

  listDreamLogs(limit = 8): DreamLogRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM dream_logs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      from_seq: Number(r.from_seq ?? 0),
      to_seq: Number(r.to_seq ?? 0),
      summary: String(r.summary ?? ""),
      promoted: JSON.parse(String(r.promoted_json || "[]")) as string[],
      graduated: JSON.parse(String(r.graduated_json || "[]")) as string[],
      created_at: Number(r.created_at ?? 0),
    }));
  }
}
