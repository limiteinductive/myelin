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
  type Depth,
  type McqOutcome,
  type McqRole,
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
  kind?: "clarify" | "starter";
  sketch?: string | null;
  failed?: boolean;
  annotations?: StoredInlineAnnotation[];
  added?: { unit_id: string; text: string; kind: string; observe_only: boolean }[];
}

export interface StoredMcqChoice {
  id: string;
  source_id: string;
  text: string;
}

export interface StoredMcqProduction {
  depth: Depth;
  prompt: string;
  modality: string;
  starter?: string | null;
  expected_crux?: string | null;
}

export interface StoredMcqAttempt {
  item_id: string;
  version: number;
  role?: McqRole;
  choices: StoredMcqChoice[];
  correct_id: string;
  explanation: string;
  why_wrong: Record<string, string>;
  worked_step?: string | null;
  sitting_id?: string | null;
  assisted?: boolean;
  selected_choice_id?: string | null;
  outcome?: McqOutcome | null;
  /** Two-stage preliminary gate phase: "gate" -> "production" (on pass) or "settled" (on short-circuit). */
  phase?: "gate" | "production" | "settled";
  /** Original Stage 1 gate stem preserved when attempt transitions to Stage 2 production. */
  gate_prompt?: string | null;
  /** Paired production exercise held server-side for Stage 2 of a preliminary gate. */
  production?: StoredMcqProduction | null;
  gate_latency_ms?: number | null;
  gate_passed_at?: number | null;
  /** True when the learner missed/IDK'd a preliminary gate and opted into "Try the full problem anyway". */
  gate_continued?: boolean;
}

export interface StoredDrillExercise {
  prompt: string;
  expected_crux?: string | null;
  starter?: string | null;
  modality?: string | null;
  model?: string | null;
  policy_version?: string | null;
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
  mcq?: StoredMcqAttempt | null;
  /** Immutable exercise snapshot (prompt + expected_crux + starter + modality) captured on first contact with this attempt. */
  exercise?: StoredDrillExercise | null;
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
  question?: string;
  added?: { unit_id: string; text: string; kind: string; observe_only: boolean }[];
}

export interface ExplorationRecord {
  id: string;
  title: string;
  turns: StoredBriefingTurn[];
  archived?: boolean;
  total_turns?: number;
  crystallized_turn_count?: number;
  crystallized_units?: { unit_id: string; text: string; kind: string; observe_only: boolean }[];
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
      CREATE TABLE IF NOT EXISTS unit_due_overrides (
        unit_id TEXT PRIMARY KEY,
        due_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcq_issuances (
        attempt_id TEXT PRIMARY KEY,
        sitting_id TEXT NOT NULL,
        unit_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'standalone',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcq_issuances_unit_idx ON mcq_issuances(unit_id);
    `);
    const mcqCols = this.db.prepare("PRAGMA table_info(mcq_issuances)").all() as unknown as { name?: string; pk?: number }[];
    if (!mcqCols.some((c) => c.name === "role") || mcqCols.find((c) => c.name === "attempt_id")?.pk !== 1) {
      this.db.exec(`
        CREATE TABLE mcq_issuances_v2 (
          attempt_id TEXT PRIMARY KEY,
          sitting_id TEXT NOT NULL,
          unit_id TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'standalone',
          created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO mcq_issuances_v2 (attempt_id, sitting_id, unit_id, role, created_at)
        SELECT attempt_id, sitting_id, unit_id, 'standalone', created_at FROM mcq_issuances;
        DROP TABLE mcq_issuances;
        ALTER TABLE mcq_issuances_v2 RENAME TO mcq_issuances;
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS mcq_issuances_unit_idx ON mcq_issuances(unit_id);
      CREATE INDEX IF NOT EXISTS mcq_issuances_sitting_role_idx ON mcq_issuances(sitting_id, role);
      CREATE UNIQUE INDEX IF NOT EXISTS mcq_issuances_sitting_unit_idx ON mcq_issuances(sitting_id, unit_id);
    `);
    const expCols = this.db.prepare("PRAGMA table_info(explorations)").all() as unknown as { name?: string }[];
    if (!expCols.some((c) => c.name === "archived")) {
      this.db.exec("ALTER TABLE explorations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
    if (!expCols.some((c) => c.name === "crystallized_turn_count")) {
      this.db.exec("ALTER TABLE explorations ADD COLUMN crystallized_turn_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!expCols.some((c) => c.name === "crystallized_units_json")) {
      this.db.exec("ALTER TABLE explorations ADD COLUMN crystallized_units_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!expCols.some((c) => c.name === "total_turns")) {
      this.db.exec("ALTER TABLE explorations ADD COLUMN total_turns INTEGER NOT NULL DEFAULT 0");
    }
    const attemptCols = this.db.prepare("PRAGMA table_info(drill_attempts)").all() as unknown as { name?: string }[];
    if (!attemptCols.some((c) => c.name === "mcq_json")) {
      this.db.exec("ALTER TABLE drill_attempts ADD COLUMN mcq_json TEXT");
    }
    if (!attemptCols.some((c) => c.name === "exercise_json")) {
      this.db.exec("ALTER TABLE drill_attempts ADD COLUMN exercise_json TEXT");
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

  /** Events with ts >= sinceMs, in chronological seq order (used for daily active time & session stats). */
  readSinceTs(sinceMs: number): Appended[] {
    return (this.db.prepare("SELECT * FROM events WHERE ts >= ? ORDER BY seq ASC").all(sinceMs) as unknown as Row[]).map(fromRow);
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
      mcq: typeof r.mcq_json === "string" && r.mcq_json ? (JSON.parse(r.mcq_json) as StoredMcqAttempt) : null,
      exercise: typeof r.exercise_json === "string" && r.exercise_json ? (JSON.parse(r.exercise_json) as StoredDrillExercise) : null,
      created_at: Number(r.created_at ?? 0),
      updated_at: Number(r.updated_at ?? 0),
    };
  }

  getAttempt(attemptId: string): DrillAttemptRecord | null {
    const r = this.db.prepare("SELECT * FROM drill_attempts WHERE attempt_id = ?").get(attemptId) as Record<string, unknown> | undefined;
    return r ? this.parseAttemptRow(r) : null;
  }

  /** Returns the most recent attempts for a specific unit (newest first), using drill_attempts_unit_status. */
  listUnitAttempts(unitId: string, limit = 3): DrillAttemptRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM drill_attempts WHERE unit_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(unitId, Math.max(1, limit)) as unknown as Record<string, unknown>[];
    return rows.map((r) => this.parseAttemptRow(r));
  }

  /** Returns recent drill attempts across all units since `sinceTs` (newest first) for sitting-trajectory & Dreaming. */
  listRecentAttempts(sinceTs = 0, limit = 20, excludeAttemptId?: string): DrillAttemptRecord[] {
    const rows = excludeAttemptId
      ? (this.db
          .prepare("SELECT * FROM drill_attempts WHERE updated_at >= ? AND attempt_id != ? ORDER BY updated_at DESC LIMIT ?")
          .all(sinceTs, excludeAttemptId, Math.max(1, limit)) as unknown as Record<string, unknown>[])
      : (this.db
          .prepare("SELECT * FROM drill_attempts WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?")
          .all(sinceTs, Math.max(1, limit)) as unknown as Record<string, unknown>[]);
    return rows.map((r) => this.parseAttemptRow(r));
  }

  /**
   * Finds the source Exploration (if any) that crystallized `unitId`, returning its title and
   * the learner's closing/origin turn excerpt so the coach sees unresolved confusion at birth.
   */
  findUnitOriginExploration(unitId: string): {
    exploration_id: string;
    title: string;
    user_excerpt: string | null;
    last_user_excerpt: string | null;
    turns_count: number;
    created_at: number;
  } | null {
    const rows = this.db
      .prepare(
        "SELECT id, title, turns_json, crystallized_units_json, created_at FROM explorations WHERE crystallized_units_json LIKE ? OR turns_json LIKE ? ORDER BY updated_at DESC LIMIT 3",
      )
      .all(`%${unitId}%`, `%${unitId}%`) as unknown as Record<string, unknown>[];
    for (const r of rows) {
      const turns = JSON.parse(String(r.turns_json || "[]")) as StoredBriefingTurn[];
      const cryst = JSON.parse(String(r.crystallized_units_json || "[]")) as { unit_id?: string }[];
      const inCryst = cryst.some((c) => c?.unit_id === unitId);
      const matchedTurnIdx = turns.findIndex((t) => Array.isArray(t.added) && t.added.some((a) => a?.unit_id === unitId));
      if (!inCryst && matchedTurnIdx < 0) continue;
      const matchedUser = matchedTurnIdx >= 0 ? (turns[matchedTurnIdx]?.user ?? "").replace(/\s+/g, " ").trim().slice(0, 180) : null;
      const lastTurn = turns.at(-1);
      const lastUser = lastTurn?.user ? lastTurn.user.replace(/\s+/g, " ").trim().slice(0, 180) : null;
      return {
        exploration_id: String(r.id),
        title: String(r.title || "Exploration"),
        user_excerpt: matchedUser || null,
        last_user_excerpt: lastUser && lastUser !== matchedUser ? lastUser : null,
        turns_count: turns.length,
        created_at: Number(r.created_at ?? 0),
      };
    }
    return null;
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
          (attempt_id, unit_id, depth, prompt, first_attempt, turns_json, status, assistance_count, active_ms, probe_id, grade, result_json, mcq_json, exercise_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id) DO UPDATE SET
          depth = excluded.depth,
          prompt = excluded.prompt,
          first_attempt = excluded.first_attempt,
          turns_json = excluded.turns_json,
          status = excluded.status,
          assistance_count = excluded.assistance_count,
          active_ms = excluded.active_ms,
          probe_id = COALESCE(excluded.probe_id, drill_attempts.probe_id),
          grade = COALESCE(excluded.grade, drill_attempts.grade),
          result_json = COALESCE(excluded.result_json, drill_attempts.result_json),
          mcq_json = COALESCE(excluded.mcq_json, drill_attempts.mcq_json),
          exercise_json = COALESCE(drill_attempts.exercise_json, excluded.exercise_json),
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
        rec.mcq ? JSON.stringify(rec.mcq) : null,
        rec.exercise ? JSON.stringify(rec.exercise) : null,
        rec.created_at,
        rec.updated_at,
      );
  }

  /** Returns the latest MCQ issued for a given sitting (if any). */
  getMcqIssuance(sittingId: string): { sitting_id: string; unit_id: string; attempt_id: string; role: McqRole; created_at: number } | null {
    const r = this.db
      .prepare("SELECT sitting_id, unit_id, attempt_id, role, created_at FROM mcq_issuances WHERE sitting_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(sittingId) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      sitting_id: String(r.sitting_id),
      unit_id: String(r.unit_id),
      attempt_id: String(r.attempt_id),
      role: r.role === "preliminary" ? "preliminary" : "standalone",
      created_at: Number(r.created_at ?? 0),
    };
  }

  /** Counts MCQs issued in a sitting, optionally filtered by role. */
  countMcqIssuances(sittingId: string, role?: McqRole): number {
    const r = role
      ? (this.db.prepare("SELECT COUNT(*) as n FROM mcq_issuances WHERE sitting_id = ? AND role = ?").get(sittingId, role) as { n?: number } | undefined)
      : (this.db.prepare("SELECT COUNT(*) as n FROM mcq_issuances WHERE sitting_id = ?").get(sittingId) as { n?: number } | undefined);
    return Number(r?.n ?? 0);
  }

  /** True if this unit already received an MCQ in this sitting. */
  hasSittingUnitMcqIssuance(sittingId: string, unitId: string): boolean {
    const r = this.db
      .prepare("SELECT 1 FROM mcq_issuances WHERE sitting_id = ? AND unit_id = ? LIMIT 1")
      .get(sittingId, unitId);
    return Boolean(r);
  }

  /** True if this unit has ever been issued an MCQ (kept for legacy callers/tests). */
  hasUnitMcqIssuance(unitId: string): boolean {
    const r = this.db.prepare("SELECT 1 FROM mcq_issuances WHERE unit_id = ? LIMIT 1").get(unitId);
    return Boolean(r);
  }

  /**
   * Atomically reserves an MCQ slot for (sittingId, unitId) respecting the per-role sitting budget
   * and at most one MCQ issuance per unit per sitting. Returns true iff reserved by this call.
   */
  reserveMcqIssuance(
    sittingId: string,
    unitId: string,
    attemptId: string,
    now = Date.now(),
    role: McqRole = "standalone",
    maxForRole = 1,
  ): boolean {
    if (maxForRole <= 0) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existingUnit = this.db
        .prepare("SELECT 1 FROM mcq_issuances WHERE sitting_id = ? AND unit_id = ? LIMIT 1")
        .get(sittingId, unitId);
      if (existingUnit) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const row = this.db
        .prepare("SELECT COUNT(*) as n FROM mcq_issuances WHERE sitting_id = ? AND role = ?")
        .get(sittingId, role) as { n?: number } | undefined;
      if (Number(row?.n ?? 0) >= maxForRole) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const res = this.db
        .prepare("INSERT OR IGNORE INTO mcq_issuances (attempt_id, sitting_id, unit_id, role, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(attemptId, sittingId, unitId, role, now);
      this.db.exec("COMMIT");
      return Number(res.changes ?? 0) > 0;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
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
    const turns = JSON.parse(String(r.turns_json || "[]")) as StoredBriefingTurn[];
    const crystallizedUnits = JSON.parse(String(r.crystallized_units_json || "[]")) as {
      unit_id: string;
      text: string;
      kind: string;
      observe_only: boolean;
    }[];
    const totalTurns = Math.max(Number(r.total_turns ?? 0), turns.length);
    return {
      id: String(r.id),
      title: String(r.title),
      turns,
      archived: Number(r.archived ?? 0) !== 0,
      total_turns: totalTurns,
      crystallized_turn_count: Number(r.crystallized_turn_count ?? 0),
      ...(crystallizedUnits.length > 0 ? { crystallized_units: crystallizedUnits } : {}),
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
    const existing = this.getExploration(e.id);
    const archivedFlag = e.archived !== undefined ? (e.archived ? 1 : 0) : existing?.archived ? 1 : 0;
    const totalTurns = Math.max(e.total_turns ?? 0, existing?.total_turns ?? 0, e.turns.length);
    const turnCount = e.crystallized_turn_count ?? existing?.crystallized_turn_count ?? 0;
    const crystallizedUnits = e.crystallized_units ?? existing?.crystallized_units ?? [];
    this.db
      .prepare(
        `INSERT INTO explorations (id, title, turns_json, archived, total_turns, crystallized_turn_count, crystallized_units_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          turns_json = excluded.turns_json,
          archived = excluded.archived,
          total_turns = excluded.total_turns,
          crystallized_turn_count = excluded.crystallized_turn_count,
          crystallized_units_json = excluded.crystallized_units_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        e.id,
        e.title,
        JSON.stringify(e.turns),
        archivedFlag,
        totalTurns,
        turnCount,
        JSON.stringify(crystallizedUnits),
        e.created_at,
        e.updated_at,
      );
  }

  updateExplorationCrystallization(
    id: string,
    turnCount: number,
    addedUnits: { unit_id: string; text: string; kind: string; observe_only: boolean }[],
    title?: string | null,
    now = Date.now(),
  ): ExplorationRecord | null {
    const existing = this.getExploration(id);
    if (!existing) return null;
    const prev = existing.crystallized_units ?? [];
    const seen = new Set(prev.map((u) => u.unit_id));
    const merged = [...prev, ...addedUnits.filter((u) => !seen.has(u.unit_id))];
    const next: ExplorationRecord = {
      ...existing,
      ...(title && title.trim() ? { title: title.trim() } : {}),
      crystallized_turn_count: Math.max(existing.crystallized_turn_count ?? 0, turnCount),
      crystallized_units: merged,
      updated_at: now,
    };
    this.saveExploration(next);
    return next;
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

  /** Stores a one-shot learner timing preference without mutating historical probe grades. */
  setUnitDueOverride(unitId: string, dueAt: number, createdAt = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO unit_due_overrides (unit_id, due_at, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(unit_id) DO UPDATE SET
          due_at = excluded.due_at,
          created_at = excluded.created_at`,
      )
      .run(unitId, Math.round(dueAt), Math.round(createdAt));
  }

  listUnitDueOverrides(): Map<string, { due_at: number; created_at: number }> {
    const rows = this.db.prepare("SELECT unit_id, due_at, created_at FROM unit_due_overrides").all() as unknown as Record<string, unknown>[];
    const out = new Map<string, { due_at: number; created_at: number }>();
    for (const r of rows) {
      out.set(String(r.unit_id), {
        due_at: Number(r.due_at ?? 0),
        created_at: Number(r.created_at ?? 0),
      });
    }
    return out;
  }
}
