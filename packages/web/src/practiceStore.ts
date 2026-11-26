// Account-scoped Solid 2.0 Practice Store & Context.
// Single source of truth for the queue, briefings, active stage, per-unit sessions,
// live RWKV recall evolution, and debounced per-account persistence.
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createStore,
  onSettled,
  reconcile,
  snapshot,
  type Store,
} from "solid-js";
import type { InlineAnnotation } from "./annotate.js";
import type { Citation } from "./cite.js";
import {
  abandonDrillAttempt,
  archiveExploration,
  deleteExploration,
  deleteFrontier,
  fetchDrillQueue,
  fetchExplorations,
  fetchFrontiers,
  removeUnit,
  saveExploration,
  unarchiveExploration,
  type AddedUnit,
  type CheckDrillResponse,
  type DrillRep,
  type Frontier,
  type QueueUnit,
  type SavedExploration,
} from "./drillApi.js";

export interface Beat {
  user: string;
  citations?: Citation[];
  sketch?: string | null;
  coach: string;
  /** Optional explicit forward-moving question from Explore mode (rendered in its own band). */
  question?: string;
  annotations?: InlineAnnotation[];
  added?: AddedUnit[];
  pending?: boolean;
  pendingId?: string;
  failed?: boolean;
}

export interface UnitSession {
  scheduler: string;
  attemptId?: string;
  activeMs?: number;
  rep: DrillRep | null;
  beats: Beat[];
  postBeats: Beat[];
  draft: string;
  postInput: string;
  citations: Citation[];
  passedVerdict: CheckDrillResponse | null;
  overridden: boolean;
}

export interface ExploreSession {
  beats: Beat[];
  draft: string;
  citations: Citation[];
}

export const SITTING_LIMIT = 8;

export type Stage =
  | { kind: "unit"; unitId: string }
  | { kind: "frontier"; frontierId: string }
  | { kind: "exploration"; explorationId: string }
  | { kind: "sitting-done" }
  | { kind: "explore" };

export interface PracticeState {
  queue: QueueUnit[];
  frontiers: Frontier[];
  explorations: SavedExploration[];
  archivedExplorations: SavedExploration[];
  promptMap: Record<string, string>;
  sessions: Record<string, UnitSession>;
  explore: ExploreSession;
  removedUnits: Record<string, true>;
  /** Finite committed sitting: up to SITTING_LIMIT due units locked for the current sitting. */
  sittingIds: string[];
  /** Units completed during this sitting — never boomerang back into the active sitting. */
  sittingCompletedIds: Record<string, true>;
  stage: Stage;
  /** Keeps the unit currently showing its green verdict card in "Up next" until the learner moves on. */
  justCompletedId: string | null;
  celebratingId: string | null;
  doneOpen: boolean;
  archivedOpen: boolean;
  mapOpen: boolean;
  queueLoaded: boolean;
  error: string | null;
}

export function emptyUnitSession(rep: DrillRep | null = null, scheduler = "rwkv"): UnitSession {
  return {
    scheduler,
    rep,
    beats: [],
    postBeats: [],
    draft: "",
    postInput: "",
    citations: [],
    passedVerdict: null,
    overridden: false,
  };
}

export function emptyExploreSession(): ExploreSession {
  return { beats: [], draft: "", citations: [] };
}

export function sessionKeyForStage(stage: Stage): string {
  if (stage.kind === "explore" || stage.kind === "sitting-done") return "__explore__";
  if (stage.kind === "frontier") return `briefing:${stage.frontierId}`;
  if (stage.kind === "exploration") return `explore:${stage.explorationId}`;
  return stage.unitId;
}

export function sessionHasWork(s: UnitSession | undefined): boolean {
  if (!s) return false;
  return (
    s.beats.length > 0 ||
    s.postBeats.length > 0 ||
    s.draft.trim().length > 0 ||
    s.citations.length > 0 ||
    Boolean(s.passedVerdict)
  );
}

export function exploreHasWork(s: ExploreSession): boolean {
  return s.beats.length > 0 || s.draft.trim().length > 0 || s.citations.length > 0;
}

interface PersistedPractice {
  version: 2;
  migratedLegacy?: boolean;
  stage: Stage;
  doneOpen: boolean;
  sessions: Record<string, UnitSession>;
  explore: ExploreSession;
  removedUnits: string[];
}

const STORAGE_PREFIX = "myelin:v2:state:";
const LEGACY_SESSIONS_KEY = "myelin:v2:sessions:v1";
const LEGACY_SITTING_KEY = "myelin:v2:sitting:v1";
const PERSIST_DEBOUNCE_MS = 400;

function cleanBeats(beats: Beat[], dropSketches: boolean): Beat[] {
  // Never drop an in-flight user message on refresh/unload: persist pending turns as retryable failed beats.
  const persisted = beats.map((b): Beat => {
    if (b.pending) {
      const { pending: _p, pendingId: _id, ...rest } = b;
      return {
        ...rest,
        coach: b.coach.trim() ? b.coach : "Interrupted before response finished — retry?",
        failed: true,
      };
    }
    if (b.pendingId) {
      const { pendingId: _id, ...rest } = b;
      return rest;
    }
    return b;
  });
  return dropSketches ? persisted.map(({ sketch: _drop, ...rest }) => rest) : persisted;
}

function normalizeSession(s: Partial<UnitSession> | null | undefined): UnitSession | null {
  if (!s || typeof s !== "object") return null;
  return {
    scheduler: typeof s.scheduler === "string" ? s.scheduler : "rwkv",
    ...(typeof s.attemptId === "string" && s.attemptId ? { attemptId: s.attemptId } : {}),
    ...(typeof s.activeMs === "number" && s.activeMs >= 0 ? { activeMs: s.activeMs } : {}),
    rep: s.rep && typeof s.rep.unit_id === "string" ? s.rep : null,
    beats: Array.isArray(s.beats) ? cleanBeats(s.beats, false) : [],
    postBeats: Array.isArray(s.postBeats) ? cleanBeats(s.postBeats, false) : [],
    draft: typeof s.draft === "string" ? s.draft : "",
    postInput: typeof s.postInput === "string" ? s.postInput : "",
    citations: Array.isArray(s.citations) ? s.citations : [],
    passedVerdict: s.passedVerdict ?? null,
    overridden: Boolean(s.overridden),
  };
}

function readLegacyPractice(): {
  sessions: Record<string, UnitSession>;
  explore: ExploreSession | null;
  removedUnits: string[];
  stage: Stage | null;
  doneOpen: boolean;
} | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const rawSessions = localStorage.getItem(LEGACY_SESSIONS_KEY);
    const rawSitting = localStorage.getItem(LEGACY_SITTING_KEY);
    if (!rawSessions && !rawSitting) return null;

    const sessions: Record<string, UnitSession> = {};
    let explore: ExploreSession | null = null;
    let removedUnits: string[] = [];

    if (rawSessions) {
      const parsed = JSON.parse(rawSessions) as {
        units?: Record<string, Partial<UnitSession>>;
        explore?: Partial<ExploreSession> | null;
        removed?: string[];
      };
      if (parsed.units && typeof parsed.units === "object") {
        for (const [id, raw] of Object.entries(parsed.units)) {
          const norm = normalizeSession(raw);
          if (norm) sessions[id] = norm;
        }
      }
      if (parsed.explore && typeof parsed.explore === "object") {
        explore = {
          beats: Array.isArray(parsed.explore.beats) ? parsed.explore.beats.filter((b) => !b.pending) : [],
          draft: typeof parsed.explore.draft === "string" ? parsed.explore.draft : "",
          citations: Array.isArray(parsed.explore.citations) ? parsed.explore.citations : [],
        };
      }
      if (Array.isArray(parsed.removed)) {
        removedUnits = parsed.removed.filter((x): x is string => typeof x === "string");
      }
    }

    let stage: Stage | null = null;
    let doneOpen = false;
    if (rawSitting) {
      const sit = JSON.parse(rawSitting) as {
        activeUnitId?: string | null;
        activeFrontierId?: string | null;
        exploreMode?: boolean;
        doneOpen?: boolean;
      };
      doneOpen = Boolean(sit.doneOpen);
      if (typeof sit.activeFrontierId === "string" && sit.activeFrontierId) {
        stage = { kind: "frontier", frontierId: sit.activeFrontierId };
      } else if (typeof sit.activeUnitId === "string" && sit.activeUnitId) {
        stage = { kind: "unit", unitId: sit.activeUnitId };
      } else if (sit.exploreMode) {
        stage = { kind: "explore" };
      }
    }

    return { sessions, explore, removedUnits, stage, doneOpen };
  } catch {
    return null;
  }
}

function hydratePractice(userId: string): Partial<PersistedPractice> | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    const parsed = raw ? (JSON.parse(raw) as Partial<PersistedPractice>) : null;

    const sessions: Record<string, UnitSession> = {};
    if (parsed?.sessions && typeof parsed.sessions === "object") {
      for (const [id, s] of Object.entries(parsed.sessions)) {
        const norm = normalizeSession(s);
        if (norm) sessions[id] = norm;
      }
    }

    let explore: ExploreSession =
      parsed?.explore && typeof parsed.explore === "object"
        ? {
            beats: Array.isArray(parsed.explore.beats) ? parsed.explore.beats.filter((b) => !b.pending) : [],
            draft: typeof parsed.explore.draft === "string" ? parsed.explore.draft : "",
            citations: Array.isArray(parsed.explore.citations) ? parsed.explore.citations : [],
          }
        : emptyExploreSession();

    let stage: Stage = { kind: "explore" };
    if (parsed?.stage && typeof parsed.stage === "object") {
      if (parsed.stage.kind === "unit" && typeof parsed.stage.unitId === "string") {
        stage = { kind: "unit", unitId: parsed.stage.unitId };
      } else if (parsed.stage.kind === "frontier" && typeof parsed.stage.frontierId === "string") {
        stage = { kind: "frontier", frontierId: parsed.stage.frontierId };
      } else if (parsed.stage.kind === "exploration" && typeof parsed.stage.explorationId === "string") {
        stage = { kind: "exploration", explorationId: parsed.stage.explorationId };
      }
    }

    const removedSet = new Set<string>(
      Array.isArray(parsed?.removedUnits)
        ? parsed.removedUnits.filter((x): x is string => typeof x === "string")
        : [],
    );
    let doneOpen = Boolean(parsed?.doneOpen);

    // One-time migration from pre-refactor localStorage keys so ongoing attempts are never lost on upgrade.
    if (!parsed?.migratedLegacy) {
      const legacy = readLegacyPractice();
      if (legacy) {
        let recoveredOngoingUnit: string | null = null;
        for (const [id, ls] of Object.entries(legacy.sessions)) {
          const cur = sessions[id];
          if (!cur || (!sessionHasWork(cur) && sessionHasWork(ls))) {
            sessions[id] = ls;
            if (!ls.passedVerdict?.ok && ls.beats.length > 0 && !id.startsWith("briefing:")) {
              recoveredOngoingUnit = id;
            }
          }
        }
        if (!exploreHasWork(explore) && legacy.explore && exploreHasWork(legacy.explore)) {
          explore = legacy.explore;
        }
        for (const r of legacy.removedUnits) removedSet.add(r);
        if (!parsed) {
          doneOpen = legacy.doneOpen;
          if (legacy.stage) stage = legacy.stage;
        } else if (recoveredOngoingUnit) {
          // If the user already booted once onto the new key without migrating, jump back to their recovered ongoing attempt.
          const currentWork = stage.kind === "unit" && sessionHasWork(sessions[stage.unitId]);
          if (!currentWork) stage = { kind: "unit", unitId: recoveredOngoingUnit };
        }
      }
    }

    if (!parsed && Object.keys(sessions).length === 0 && !exploreHasWork(explore) && removedSet.size === 0) {
      return null;
    }

    return {
      version: 2,
      migratedLegacy: true,
      stage,
      doneOpen,
      sessions,
      explore,
      removedUnits: [...removedSet],
    };
  } catch {
    return null;
  }
}

export interface PracticeStore {
  readonly state: Store<PracticeState>;
  readonly dueQueue: () => QueueUnit[];
  readonly doneQueue: () => QueueUnit[];
  readonly remainingCount: () => number;
  readonly backlogDueCount: () => number;
  readonly sittingDoneCount: () => number;
  readonly soonestNextMs: () => number | null;
  readonly currentFrontier: () => Frontier | null;
  readonly currentExploration: () => SavedExploration | null;
  readonly stageKey: () => string;
  readonly reloadNonce: () => number;

  sidebarLabel(u: QueueUnit): string;
  rememberPrompt(unitId: string, prompt: string): void;
  setMapOpen(open: boolean | ((prev: boolean) => boolean)): void;
  setDoneOpen(open: boolean | ((prev: boolean) => boolean)): void;
  setArchivedOpen(open: boolean | ((prev: boolean) => boolean)): void;
  clearError(): void;

  selectUnit(unitId: string): void;
  selectFrontier(frontierId: string): void;
  selectExploration(explorationId: string): void;
  selectExplore(): void;
  startExplorationFrom(exp: SavedExploration): void;
  addFrontier(frontier: Frontier): void;
  promoteExploreToSaved(exp: { id: string; title: string }, settledBeat: Beat): void;
  promotePostFollowUpToExploration(unitKey: string, exp: { id: string; title: string }, promotedBeats: Beat[]): void;
  updateFrontierDemonstrated(frontierId: string, demonstrated: number[]): void;
  removeFrontierById(id: string): Promise<void>;
  archiveExplorationById(id: string): Promise<void>;
  unarchiveExplorationById(id: string): Promise<void>;
  removeExplorationById(id: string): Promise<void>;

  markUnitCompleted(unitId: string, extraCreditedIds?: string[]): void;
  practiceUnitAgain(unitId: string): void;
  advanceFromUnit(fromUnitId: string | null): void;
  startNextSitting(): void;
  undoAddedUnit(unitId: string): Promise<void>;

  updateUnitSession(key: string, fn: (draft: UnitSession) => void): void;
  updateExplore(fn: (draft: ExploreSession) => void): void;
  resetExplore(): void;
  clearUnitSession(unitId: string): void;

  refreshQueue(opts?: { selectInitial?: boolean; preserveOrder?: boolean }): Promise<void>;
  refreshFrontiers(): Promise<void>;
  refreshExplorations(): Promise<void>;
}

export const PracticeContext = createContext<PracticeStore>();

export function createPracticeStore(userId: string, opts: { autoLoad?: boolean } = {}): PracticeStore {
  const autoLoad = opts.autoLoad ?? true;
  const saved = hydratePractice(userId);
  const initialRemoved: Record<string, true> = {};
  for (const id of saved?.removedUnits ?? []) initialRemoved[id] = true;

  const [state, setState] = createStore<PracticeState>({
    queue: [],
    frontiers: [],
    explorations: [],
    archivedExplorations: [],
    promptMap: {},
    sessions: saved?.sessions ?? {},
    explore: saved?.explore ?? emptyExploreSession(),
    removedUnits: initialRemoved,
    sittingIds: [],
    sittingCompletedIds: {},
    stage: saved?.stage && saved.stage.kind !== "sitting-done" ? saved.stage : { kind: "explore" },
    justCompletedId: null,
    celebratingId: null,
    doneOpen: saved?.doneOpen ?? false,
    archivedOpen: false,
    mapOpen: false,
    queueLoaded: false,
    error: null,
  });

  // Bumped whenever the learner explicitly hits "Practice again" on the currently selected unit.
  const [reloadNonce, setReloadNonce] = createSignal(0);
  // Dirty counter for debounced localStorage writes (never runs JSON.stringify synchronously on keystrokes).
  const [persistTick, setPersistTick] = createSignal(0);
  const markDirty = () => setPersistTick((n) => n + 1);

  let disposed = false;
  let queueSeq = 0;
  let queueAbort: AbortController | null = null;
  let frontierSeq = 0;
  let frontierAbort: AbortController | null = null;
  let explorationSeq = 0;
  let explorationAbort: AbortController | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  let warmRetries = 0;
  let celebrateTimer: ReturnType<typeof setTimeout> | null = null;

  // Derived views (memoized once per change).
  // Committed Sitting: locks up to SITTING_LIMIT due cards and prevents cards completed during
  // this sitting from boomeranging back into the active sitting queue.
  const dueQueue = createMemo(() => {
    const sittingSet = state.sittingIds.length > 0 ? new Set(state.sittingIds) : null;
    return state.queue.filter((u) => {
      if (u.unit_id === state.justCompletedId) return true;
      if (!u.due) return false;
      if (state.sittingCompletedIds[u.unit_id]) return false;
      if (sittingSet && !sittingSet.has(u.unit_id)) return false;
      return true;
    });
  });
  const doneQueue = createMemo(() => {
    const activeIds = new Set(dueQueue().map((u) => u.unit_id));
    return state.queue.filter((u) => !activeIds.has(u.unit_id));
  });
  const remainingCount = createMemo(() =>
    dueQueue().filter((u) => u.unit_id !== state.justCompletedId).length,
  );
  const backlogDueCount = createMemo(() => {
    const activeIds = new Set(dueQueue().map((u) => u.unit_id));
    return state.queue.filter((u) => u.due && !activeIds.has(u.unit_id) && !state.sittingCompletedIds[u.unit_id]).length;
  });
  const sittingDoneCount = createMemo(() => Object.keys(state.sittingCompletedIds).length);
  const soonestNextMs = createMemo(() => {
    let best: number | null = null;
    for (const u of doneQueue()) {
      if (u.next_in_ms !== null && u.next_in_ms > 0 && (best === null || u.next_in_ms < best)) {
        best = u.next_in_ms;
      }
    }
    return best;
  });
  const currentFrontier = createMemo<Frontier | null>(() => {
    if (state.stage.kind !== "frontier") return null;
    const fid = state.stage.frontierId;
    return state.frontiers.find((f) => f.id === fid) ?? null;
  });
  const currentExploration = createMemo<SavedExploration | null>(() => {
    if (state.stage.kind !== "exploration") return null;
    const eid = state.stage.explorationId;
    return state.explorations.find((e) => e.id === eid) ?? null;
  });
  const stageKey = createMemo(() => sessionKeyForStage(state.stage));

  // Snapshot persistence helper (non-tracking via Solid 2.0 `snapshot`).
  const flushPersist = () => {
    if (typeof localStorage === "undefined") return;
    const snap = snapshot(state);
    const buildPayload = (dropSketches: boolean): string => {
      const cleanSessions: Record<string, UnitSession> = {};
      for (const [id, s] of Object.entries(snap.sessions)) {
        cleanSessions[id] = {
          ...s,
          beats: cleanBeats(s.beats, dropSketches),
          postBeats: cleanBeats(s.postBeats, dropSketches),
        };
      }
      const payload: PersistedPractice = {
        version: 2,
        migratedLegacy: true,
        stage: snap.stage.kind === "sitting-done" ? { kind: "explore" } : snap.stage,
        doneOpen: snap.doneOpen,
        sessions: cleanSessions,
        explore: {
          ...snap.explore,
          beats: cleanBeats(snap.explore.beats, dropSketches),
        },
        removedUnits: Object.keys(snap.removedUnits),
      };
      return JSON.stringify(payload);
    };
    const key = `${STORAGE_PREFIX}${userId}`;
    try {
      localStorage.setItem(key, buildPayload(false));
    } catch {
      try {
        localStorage.setItem(key, buildPayload(true));
      } catch {
        /* ignore quota / private mode errors */
      }
    }
  };

  // Debounced persistence effect (coalesces rapid typing into a single write every 400ms).
  createEffect(
    () => persistTick(),
    () => {
      const t = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
      return () => clearTimeout(t);
    },
    { defer: true },
  );

  const sidebarLabel = (u: QueueUnit): string => {
    const p = state.promptMap[u.unit_id] || u.prompt;
    if (p && p.trim()) return p;
    return [u.topic || u.kind, u.depth].filter(Boolean).join(" · ");
  };

  const rememberPrompt = (unitId: string, prompt: string) => {
    if (!prompt || state.promptMap[unitId] === prompt) return;
    setState((s) => {
      s.promptMap[unitId] = prompt;
    });
  };

  const setMapOpen = (open: boolean | ((prev: boolean) => boolean)) => {
    setState((s) => {
      s.mapOpen = typeof open === "function" ? open(s.mapOpen) : open;
    });
  };

  const setDoneOpen = (open: boolean | ((prev: boolean) => boolean)) => {
    setState((s) => {
      s.doneOpen = typeof open === "function" ? open(s.doneOpen) : open;
    });
    markDirty();
  };

  const setArchivedOpen = (open: boolean | ((prev: boolean) => boolean)) => {
    setState((s) => {
      s.archivedOpen = typeof open === "function" ? open(s.archivedOpen) : open;
    });
  };

  const clearError = () => {
    setState((s) => {
      s.error = null;
    });
  };

  const selectUnit = (unitId: string) => {
    setState((s) => {
      if (s.justCompletedId && s.justCompletedId !== unitId) {
        s.justCompletedId = null;
      }
      s.mapOpen = false;
      s.stage = { kind: "unit", unitId };
    });
    markDirty();
  };

  const selectFrontier = (frontierId: string) => {
    setState((s) => {
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "frontier", frontierId };
    });
    markDirty();
  };

  const selectExploration = (explorationId: string) => {
    setState((s) => {
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "exploration", explorationId };
    });
    markDirty();
  };

  const selectExplore = () => {
    setState((s) => {
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "explore" };
    });
    markDirty();
  };

  /** Opens a fresh exploration seeded with a context citation from a prior/archived exploration. */
  const startExplorationFrom = (exp: SavedExploration) => {
    const coveredUnits = exp.turns
      .flatMap((t) => t.added ?? [])
      .map((u) => u.text)
      .slice(-6);
    const lastTurn = exp.turns.at(-1);
    const summaryParts = [
      `Continuing from prior exploration "${exp.title}" (${exp.turns.length} turns).`,
      coveredUnits.length > 0 ? `Already covered:\n- ${coveredUnits.join("\n- ")}` : "",
      lastTurn?.coach ? `Where we left off: ${lastTurn.coach.slice(0, 320)}` : "",
    ].filter(Boolean);
    setState((s) => {
      s.explore = {
        beats: [],
        draft: "",
        citations: [
          {
            id: `from:${exp.id}:${Date.now()}`,
            text: summaryParts.join("\n"),
            comment: `Continue from ${exp.title}`,
          },
        ],
      };
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "explore" };
    });
    markDirty();
  };

  const addFrontier = (frontier: Frontier) => {
    setState((s) => {
      s.frontiers.push(frontier);
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "frontier", frontierId: frontier.id };
    });
    markDirty();
  };

  const promoteExploreToSaved = (exp: { id: string; title: string }, settledBeat: Beat) => {
    const now = Date.now();
    setState((s) => {
      const priorSettled = s.explore.beats.filter((b) => !b.pending);
      const beats = [...priorSettled, settledBeat];
      const key = `explore:${exp.id}`;
      const sess = emptyUnitSession();
      sess.beats = beats;
      s.sessions[key] = sess;
      s.explore = emptyExploreSession();
      const idx = s.explorations.findIndex((x) => x.id === exp.id);
      const record: SavedExploration = {
        id: exp.id,
        title: exp.title,
        turns: beats.map((b) => ({
          user: b.user,
          coach: b.coach,
          ...(b.question ? { question: b.question } : {}),
          ...(b.added ? { added: b.added } : {}),
        })),
        created_at: now,
        updated_at: now,
      };
      if (idx >= 0) s.explorations[idx] = record;
      else s.explorations.unshift(record);
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "exploration", explorationId: exp.id };
    });
    queueMicrotask(() => {
      if (!disposed) flushPersist();
    });
    markDirty();
  };

  /** Promotes a completed drill's post-pass follow-up thread into a full saved Exploration. */
  const promotePostFollowUpToExploration = (
    unitKey: string,
    exp: { id: string; title: string },
    promotedBeats: Beat[],
  ) => {
    const now = Date.now();
    setState((s) => {
      const key = `explore:${exp.id}`;
      const sess = emptyUnitSession();
      sess.beats = promotedBeats;
      s.sessions[key] = sess;
      const unitSess = s.sessions[unitKey];
      if (unitSess) {
        unitSess.postBeats = [];
        unitSess.postInput = "";
        unitSess.citations = [];
      }
      const record: SavedExploration = {
        id: exp.id,
        title: exp.title,
        turns: promotedBeats.map((b) => ({
          user: b.user,
          coach: b.coach,
          ...(b.question ? { question: b.question } : {}),
          ...(b.added && b.added.length > 0 ? { added: b.added } : {}),
        })),
        created_at: now,
        updated_at: now,
      };
      const idx = s.explorations.findIndex((x) => x.id === exp.id);
      if (idx >= 0) s.explorations[idx] = record;
      else s.explorations.unshift(record);
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "exploration", explorationId: exp.id };
    });
    queueMicrotask(() => {
      if (!disposed) flushPersist();
    });
    markDirty();
  };

  const updateFrontierDemonstrated = (frontierId: string, demonstrated: number[]) => {
    setState((s) => {
      const f = s.frontiers.find((x) => x.id === frontierId);
      if (f) f.demonstrated_cruxes = demonstrated;
    });
  };

  const removeFrontierById = async (id: string) => {
    const prevFrontiers = snapshot(state.frontiers);
    const prevStage = snapshot(state.stage);
    const wasActive = prevStage.kind === "frontier" && prevStage.frontierId === id;

    setState((s) => {
      const idx = s.frontiers.findIndex((f) => f.id === id);
      if (idx >= 0) s.frontiers.splice(idx, 1);
      delete s.sessions[`briefing:${id}`];
      s.error = null;
      if (wasActive) {
        const nextDue = s.queue.find((u) => u.due);
        s.stage = nextDue ? { kind: "unit", unitId: nextDue.unit_id } : { kind: "explore" };
      }
    });
    markDirty();

    try {
      await deleteFrontier(id);
    } catch (e) {
      if (disposed) return;
      // Roll back on server failure so UI never silently diverges.
      setState((s) => {
        reconcile(prevFrontiers, "id")(s.frontiers);
        if (wasActive) s.stage = prevStage;
        s.error = e instanceof Error ? e.message : "Could not remove briefing.";
      });
      markDirty();
    }
  };

  const archiveExplorationById = async (id: string) => {
    const prevExplorations = snapshot(state.explorations);
    const prevArchived = snapshot(state.archivedExplorations);
    const prevStage = snapshot(state.stage);
    const wasActive = prevStage.kind === "exploration" && prevStage.explorationId === id;

    setState((s) => {
      const idx = s.explorations.findIndex((e) => e.id === id);
      if (idx >= 0) {
        const [moved] = s.explorations.splice(idx, 1);
        if (moved && !s.archivedExplorations.some((a) => a.id === moved.id)) {
          s.archivedExplorations.unshift(moved);
        }
      }
      s.error = null;
      if (wasActive) {
        const nextDue = s.queue.find((u) => u.due);
        s.stage = nextDue ? { kind: "unit", unitId: nextDue.unit_id } : { kind: "explore" };
      }
    });
    markDirty();

    try {
      await archiveExploration(id);
    } catch (e) {
      if (disposed) return;
      setState((s) => {
        reconcile(prevExplorations, "id")(s.explorations);
        reconcile(prevArchived, "id")(s.archivedExplorations);
        if (wasActive) s.stage = prevStage;
        s.error = e instanceof Error ? e.message : "Could not archive exploration.";
      });
      markDirty();
    }
  };

  const unarchiveExplorationById = async (id: string) => {
    const prevExplorations = snapshot(state.explorations);
    const prevArchived = snapshot(state.archivedExplorations);

    setState((s) => {
      const idx = s.archivedExplorations.findIndex((e) => e.id === id);
      if (idx >= 0) {
        const [restored] = s.archivedExplorations.splice(idx, 1);
        if (restored) {
          if (!s.explorations.some((e) => e.id === restored.id)) s.explorations.unshift(restored);
          const eKey = `explore:${restored.id}`;
          if (!sessionHasWork(s.sessions[eKey]) && restored.turns.length > 0) {
            const sess = emptyUnitSession();
            sess.beats = restored.turns.map((t) => ({
              user: t.user,
              coach: t.coach,
              ...(t.question ? { question: t.question } : {}),
              ...(t.added && t.added.length > 0 ? { added: t.added } : {}),
            }));
            s.sessions[eKey] = sess;
          }
        }
      }
      s.justCompletedId = null;
      s.mapOpen = false;
      s.stage = { kind: "exploration", explorationId: id };
      s.error = null;
    });
    markDirty();

    try {
      await unarchiveExploration(id);
    } catch (e) {
      if (disposed) return;
      setState((s) => {
        reconcile(prevExplorations, "id")(s.explorations);
        reconcile(prevArchived, "id")(s.archivedExplorations);
        s.error = e instanceof Error ? e.message : "Could not restore exploration.";
      });
      markDirty();
    }
  };

  const removeExplorationById = async (id: string) => {
    const prevExplorations = snapshot(state.explorations);
    const prevStage = snapshot(state.stage);
    const wasActive = prevStage.kind === "exploration" && prevStage.explorationId === id;

    setState((s) => {
      const idx = s.explorations.findIndex((e) => e.id === id);
      if (idx >= 0) s.explorations.splice(idx, 1);
      delete s.sessions[`explore:${id}`];
      s.error = null;
      if (wasActive) {
        const nextDue = s.queue.find((u) => u.due);
        s.stage = nextDue ? { kind: "unit", unitId: nextDue.unit_id } : { kind: "explore" };
      }
    });
    markDirty();

    try {
      await deleteExploration(id);
    } catch (e) {
      if (disposed) return;
      setState((s) => {
        reconcile(prevExplorations, "id")(s.explorations);
        if (wasActive) s.stage = prevStage;
        s.error = e instanceof Error ? e.message : "Could not remove exploration.";
      });
      markDirty();
    }
  };

  const markUnitCompleted = (unitId: string, extraCreditedIds?: string[]) => {
    if (celebrateTimer) clearTimeout(celebrateTimer);
    setState((s) => {
      s.justCompletedId = unitId;
      s.celebratingId = unitId;
      s.sittingCompletedIds[unitId] = true;
      const item = s.queue.find((u) => u.unit_id === unitId);
      const nextIn = s.sessions[unitId]?.passedVerdict?.next_in_ms ?? null;
      if (item && (nextIn === null || nextIn > 0)) {
        item.due = false;
        if (nextIn !== null) item.next_in_ms = nextIn;
      }
      if (extraCreditedIds && extraCreditedIds.length > 0) {
        for (const cid of extraCreditedIds) {
          if (!cid || cid === unitId) continue;
          s.sittingCompletedIds[cid] = true;
          const extra = s.queue.find((u) => u.unit_id === cid);
          if (extra) extra.due = false;
        }
      }
    });
    celebrateTimer = setTimeout(() => {
      celebrateTimer = null;
      if (disposed) return;
      setState((s) => {
        if (s.celebratingId === unitId) s.celebratingId = null;
      });
    }, 650);
    // Refresh recall stats in-place via reconcile without shuffling order.
    void refreshQueue({ preserveOrder: true });
  };

  const practiceUnitAgain = (unitId: string) => {
    const prev = state.sessions[unitId];
    if (prev?.attemptId && !prev.passedVerdict?.ok) {
      void abandonDrillAttempt(prev.attemptId).catch(() => {});
    }
    setState((s) => {
      if (s.justCompletedId === unitId) s.justCompletedId = null;
      delete s.sittingCompletedIds[unitId];
      if (s.sittingIds.length > 0 && !s.sittingIds.includes(unitId)) {
        s.sittingIds.unshift(unitId);
      }
      delete s.sessions[unitId];
      s.mapOpen = false;
      s.stage = { kind: "unit", unitId };
    });
    setReloadNonce((n) => n + 1);
    markDirty();
  };

  const advanceFromUnit = (fromUnitId: string | null) => {
    const snap = snapshot(state);
    const sittingSet = snap.sittingIds.length > 0 ? new Set(snap.sittingIds) : null;
    const nextDue = snap.queue.find(
      (u) =>
        u.due &&
        u.unit_id !== fromUnitId &&
        !snap.sittingCompletedIds[u.unit_id] &&
        (!sittingSet || sittingSet.has(u.unit_id)),
    );
    const hadSittingProgress = Object.keys(snap.sittingCompletedIds).length > 0;
    setState((s) => {
      // If leaving a completed unit whose re-test cooldown already elapsed while lingering in follow-ups,
      // clear its old passed session so the next time it's opened it starts a fresh drill.
      if (fromUnitId) {
        const curItem = s.queue.find((u) => u.unit_id === fromUnitId);
        if (curItem?.due && s.sessions[fromUnitId]?.passedVerdict?.ok) {
          delete s.sessions[fromUnitId];
        }
      }
      s.justCompletedId = null;
      s.stage = nextDue
        ? { kind: "unit", unitId: nextDue.unit_id }
        : hadSittingProgress
          ? { kind: "sitting-done" }
          : { kind: "explore" };
    });
    markDirty();
  };

  const startNextSitting = () => {
    const snap = snapshot(state);
    const nextBatch = snap.queue
      .filter((u) => u.due && !snap.sittingCompletedIds[u.unit_id])
      .slice(0, SITTING_LIMIT)
      .map((u) => u.unit_id);
    const fallbackBatch =
      nextBatch.length > 0
        ? nextBatch
        : snap.queue
            .filter((u) => u.due)
            .slice(0, SITTING_LIMIT)
            .map((u) => u.unit_id);
    setState((s) => {
      s.justCompletedId = null;
      s.sittingCompletedIds = {};
      s.sittingIds = fallbackBatch;
      s.mapOpen = false;
      s.stage = fallbackBatch[0] ? { kind: "unit", unitId: fallbackBatch[0] } : { kind: "explore" };
    });
    markDirty();
  };

  const undoAddedUnit = async (unitId: string) => {
    if (state.removedUnits[unitId]) return;
    setState((s) => {
      s.removedUnits[unitId] = true;
      s.error = null;
    });
    markDirty();
    try {
      await removeUnit(unitId);
      if (disposed) return;
      void refreshQueue({ preserveOrder: true });
    } catch (e) {
      if (disposed) return;
      setState((s) => {
        delete s.removedUnits[unitId];
        s.error = e instanceof Error ? e.message : "Could not remove unit.";
      });
      markDirty();
    }
  };

  const updateUnitSession = (key: string, fn: (draft: UnitSession) => void) => {
    const prevBeats = state.sessions[key]?.beats.length ?? 0;
    const prevPost = state.sessions[key]?.postBeats.length ?? 0;
    setState((s) => {
      if (!s.sessions[key]) s.sessions[key] = emptyUnitSession();
      fn(s.sessions[key]!);
    });
    // Flush immediately on beat commits (rare, high-value); debounce rapid draft typing.
    queueMicrotask(() => {
      if (disposed) return;
      const cur = state.sessions[key];
      if (!cur || cur.beats.length !== prevBeats || cur.postBeats.length !== prevPost || cur.passedVerdict) {
        flushPersist();
      }
    });
    markDirty();
  };

  const updateExplore = (fn: (draft: ExploreSession) => void) => {
    const prevBeats = state.explore.beats.length;
    setState((s) => {
      fn(s.explore);
    });
    queueMicrotask(() => {
      if (disposed) return;
      if (state.explore.beats.length !== prevBeats) flushPersist();
    });
    markDirty();
  };

  const resetExplore = () => {
    setState((s) => {
      s.explore = emptyExploreSession();
    });
    markDirty();
  };

  const clearUnitSession = (unitId: string) => {
    if (!state.sessions[unitId]) return;
    setState((s) => {
      delete s.sessions[unitId];
    });
    markDirty();
  };

  const refreshQueue = async (opts: { selectInitial?: boolean; preserveOrder?: boolean } = {}) => {
    queueAbort?.abort();
    const ctrl = new AbortController();
    queueAbort = ctrl;
    const seq = ++queueSeq;

    try {
      const res = await fetchDrillQueue(ctrl.signal);
      if (disposed || seq !== queueSeq || ctrl.signal.aborted) return;

      const curSnap = snapshot(state);
      const hasCompleteIds = Array.isArray(res.active_ids) || res.total_units <= res.items.length;
      const validIds = new Set(res.active_ids ?? res.items.map((u) => u.unit_id));

      // Keep the sitting order stable when requested, while still updating every item's live RWKV fields.
      let orderedItems: QueueUnit[];
      if (opts.preserveOrder && curSnap.queue.length > 0) {
        const freshById = new Map(res.items.map((u) => [u.unit_id, u]));
        const existing = curSnap.queue
          .filter((old) => freshById.has(old.unit_id))
          .map((old) => freshById.get(old.unit_id)!);
        const existingIds = new Set(existing.map((u) => u.unit_id));
        const added = res.items.filter((u) => !existingIds.has(u.unit_id));
        orderedItems = [...existing, ...added];
      } else {
        orderedItems = res.items;
      }

      let missingPrompts = false;
      for (const u of orderedItems) {
        if (!u.prompt && !curSnap.promptMap[u.unit_id]) missingPrompts = true;
      }

      const itemsById = new Map(orderedItems.map((u) => [u.unit_id, u]));
      let clearedStale = false;
      setState((s) => {
        reconcile(orderedItems, "unit_id")(s.queue);
        s.queueLoaded = true;

        // Lock or top-up the finite committed sitting (up to SITTING_LIMIT due cards, excluding
        // any cards already finished during this sitting so completed cards never boomerang back).
        const validSitting = s.sittingIds.filter((id) => itemsById.has(id));
        const sittingSet = new Set(validSitting);
        if (validSitting.length < SITTING_LIMIT) {
          for (const u of orderedItems) {
            if (validSitting.length >= SITTING_LIMIT) break;
            if (u.due && !s.sittingCompletedIds[u.unit_id] && !sittingSet.has(u.unit_id)) {
              validSitting.push(u.unit_id);
              sittingSet.add(u.unit_id);
            }
          }
        }
        s.sittingIds = validSitting;

        // Sync newly warmed prompts into the per-unit keyed promptMap.
        for (const u of orderedItems) {
          if (u.prompt && !s.promptMap[u.unit_id]) {
            s.promptMap[u.unit_id] = u.prompt;
          }
          // When RWKV says a unit is due again, clear a stale passedVerdict from an earlier sitting
          // ONLY if the learner is not currently viewing it and has no active follow-up conversation on it.
          const isViewingUnit = s.stage.kind === "unit" && s.stage.unitId === u.unit_id;
          const existingSess = s.sessions[u.unit_id];
          if (
            u.due &&
            u.unit_id !== s.justCompletedId &&
            !isViewingUnit &&
            existingSess?.passedVerdict?.ok &&
            existingSess.postBeats.length === 0
          ) {
            delete s.sessions[u.unit_id];
            clearedStale = true;
          }
        }

        // Cross-device resume: hydrate unfinished server attempts into any empty local unit session.
        for (const a of res.active_attempts ?? []) {
          if (!a.turns || a.turns.length === 0) continue;
          if (!sessionHasWork(s.sessions[a.unit_id])) {
            const q = itemsById.get(a.unit_id);
            const restored = emptyUnitSession(
              {
                unit_id: a.unit_id,
                text: q?.text ?? a.prompt,
                kind: q?.kind ?? "move",
                topic: q?.topic ?? null,
                depth: a.depth,
                prompt: a.prompt,
                rests_on: [],
                p_imm: q?.p_imm ?? 0,
                reviews: q?.reviews ?? 0,
                prev_latency_ms: null,
                first_latency_ms: null,
              },
              res.scheduler,
            );
            restored.attemptId = a.attempt_id;
            if (typeof a.active_ms === "number" && a.active_ms > 0) restored.activeMs = a.active_ms;
            restored.beats = a.turns.map((t) => ({
              user: t.user,
              coach: t.coach,
              ...(t.failed ? { failed: true } : {}),
              ...(t.annotations && t.annotations.length > 0 ? { annotations: t.annotations } : {}),
              ...(t.added && t.added.length > 0 ? { added: t.added } : {}),
            }));
            s.sessions[a.unit_id] = restored;
            if (a.prompt && !s.promptMap[a.unit_id]) s.promptMap[a.unit_id] = a.prompt;
            clearedStale = true;
          }
        }

        // Prune sessions ONLY for truly retired/deleted units (keep briefing:* and explore:* sessions).
        if (hasCompleteIds) {
          for (const key of Object.keys(s.sessions)) {
            if (!key.startsWith("briefing:") && !key.startsWith("explore:") && !validIds.has(key)) {
              delete s.sessions[key];
              clearedStale = true;
            }
          }
        }

        if (hasCompleteIds && s.justCompletedId && !validIds.has(s.justCompletedId)) {
          s.justCompletedId = null;
        }

        // Initial landing selection on boot:
        if (opts.selectInitial) {
          const st = s.stage;
          const firstDue = orderedItems.find((u) => u.due);
          if (st.kind === "frontier" || st.kind === "exploration") {
            // Stay on briefing or saved exploration (validated by refreshFrontiers / refreshExplorations).
          } else if (st.kind === "unit" && validIds.has(st.unitId)) {
            const curUnit = orderedItems.find((u) => u.unit_id === st.unitId);
            // If the saved unit is no longer due and has no active work, jump to the first due recall if any.
            if (curUnit && !curUnit.due && !sessionHasWork(s.sessions[st.unitId]) && firstDue) {
              s.stage = { kind: "unit", unitId: firstDue.unit_id };
              clearedStale = true;
            }
          } else if (firstDue && !(st.kind === "explore" && exploreHasWork(s.explore))) {
            s.stage = { kind: "unit", unitId: firstDue.unit_id };
            clearedStale = true;
          } else {
            s.stage = { kind: "explore" };
          }
        }
      });

      if (clearedStale) markDirty();

      if (missingPrompts && !warmTimer && warmRetries < 3) {
        warmRetries += 1;
        warmTimer = setTimeout(() => {
          warmTimer = null;
          if (!disposed) void refreshQueue({ preserveOrder: true });
        }, 2500);
      } else if (!missingPrompts) {
        warmRetries = 0;
      }
    } catch {
      /* ignore abort / transient fetch errors */
    }
  };

  const refreshFrontiers = async () => {
    frontierAbort?.abort();
    const ctrl = new AbortController();
    frontierAbort = ctrl;
    const seq = ++frontierSeq;

    try {
      const res = await fetchFrontiers(ctrl.signal);
      if (disposed || seq !== frontierSeq || ctrl.signal.aborted) return;

      let stageChanged = false;
      setState((s) => {
        reconcile(res.frontiers, "id")(s.frontiers);
        // Cross-device resume for briefing turns stored in SQLite.
        for (const f of res.frontiers) {
          const bKey = `briefing:${f.id}`;
          if (f.turns && f.turns.length > 0 && !sessionHasWork(s.sessions[bKey])) {
            const restored = emptyUnitSession();
            restored.beats = f.turns.map((t) => ({
              user: t.user,
              coach: t.coach,
              ...(t.added && t.added.length > 0 ? { added: t.added } : {}),
            }));
            s.sessions[bKey] = restored;
            stageChanged = true;
          }
        }
        if (s.stage.kind === "frontier") {
          const fid = s.stage.frontierId;
          if (!res.frontiers.some((f) => f.id === fid)) {
            const nextDue = s.queue.find((u) => u.due);
            s.stage = nextDue ? { kind: "unit", unitId: nextDue.unit_id } : { kind: "explore" };
            stageChanged = true;
          }
        }
      });
      if (stageChanged) markDirty();
    } catch {
      /* ignore abort / transient fetch errors */
    }
  };

  const refreshExplorations = async () => {
    explorationAbort?.abort();
    const ctrl = new AbortController();
    explorationAbort = ctrl;
    const seq = ++explorationSeq;

    try {
      const res = await fetchExplorations(ctrl.signal);
      if (disposed || seq !== explorationSeq || ctrl.signal.aborted) return;

      let stageChanged = false;
      setState((s) => {
        reconcile(res.explorations, "id")(s.explorations);
        reconcile(res.archived ?? [], "id")(s.archivedExplorations);
        for (const e of res.explorations) {
          const eKey = `explore:${e.id}`;
          if (!e.turns || e.turns.length === 0) continue;
          const existing = s.sessions[eKey];
          if (!sessionHasWork(existing)) {
            const restored = emptyUnitSession();
            restored.beats = e.turns.map((t) => ({
              user: t.user,
              coach: t.coach,
              ...(t.question ? { question: t.question } : {}),
              ...(t.added && t.added.length > 0 ? { added: t.added } : {}),
            }));
            s.sessions[eKey] = restored;
            stageChanged = true;
          } else if (existing && !existing.beats.some((b) => b.pending)) {
            // Merge server-persisted turns or added-unit badges without clobbering unsent local drafts.
            if (e.turns.length > existing.beats.length) {
              existing.beats = e.turns.map((t, i) => ({
                ...(existing.beats[i] ?? {}),
                user: t.user,
                coach: t.coach,
                ...(t.question ? { question: t.question } : {}),
                ...(t.added && t.added.length > 0 ? { added: t.added } : {}),
              }));
              stageChanged = true;
            } else {
              for (let i = 0; i < e.turns.length; i++) {
                const srvTurn = e.turns[i];
                const srvAdded = srvTurn?.added;
                const localBeat = existing.beats[i];
                if (localBeat && srvAdded && srvAdded.length > (localBeat.added?.length ?? 0)) {
                  localBeat.added = srvAdded;
                  stageChanged = true;
                }
                if (localBeat && srvTurn?.question && !localBeat.question) {
                  localBeat.question = srvTurn.question;
                  stageChanged = true;
                }
              }
            }
          }
        }
        if (s.stage.kind === "exploration") {
          const eid = s.stage.explorationId;
          if (!res.explorations.some((e) => e.id === eid)) {
            const nextDue = s.queue.find((u) => u.due);
            s.stage = nextDue ? { kind: "unit", unitId: nextDue.unit_id } : { kind: "explore" };
            stageChanged = true;
          }
        }
      });

      // Lossless one-time migration of an existing localStorage Explore thread into SQLite + sidebar!
      const localExplore = snapshot(state.explore);
      const settledLocal = localExplore.beats.filter((b) => !b.pending && b.user.trim());
      if (settledLocal.length > 0 && !disposed) {
        try {
          const savedRes = await saveExploration({
            turns: settledLocal.map((b) => ({
              user: b.user,
              coach: b.coach,
              ...(b.added && b.added.length > 0 ? { added: b.added } : {}),
            })),
          });
          if (!disposed) {
            const exp = savedRes.exploration;
            setState((s) => {
              const eKey = `explore:${exp.id}`;
              const sess = emptyUnitSession();
              sess.beats = localExplore.beats.filter((b) => !b.pending);
              sess.draft = localExplore.draft;
              sess.citations = localExplore.citations;
              s.sessions[eKey] = sess;
              s.explore = emptyExploreSession();
              if (!s.explorations.some((x) => x.id === exp.id)) {
                s.explorations.unshift(exp);
              }
              if (s.stage.kind === "explore") {
                s.stage = { kind: "exploration", explorationId: exp.id };
              }
            });
            flushPersist();
            stageChanged = true;
          }
        } catch {
          /* keep local explore intact if server save transiently fails */
        }
      }

      if (stageChanged) markDirty();
    } catch {
      /* ignore abort / transient fetch errors */
    }
  };

  // Real-time RWKV recall ticker: schedules a quiet reconciled refresh right when the soonest
  // unit is due to cross 0 (e.g. ~1m for an "again" lapse), or every 60s so recall strength evolves live.
  const [liveTick, setLiveTick] = createSignal(0);
  const liveDelayMs = createMemo(() => {
    if (!state.queueLoaded || state.queue.length === 0) return null;
    const soonest = soonestNextMs();
    if (soonest !== null) {
      return Math.min(60_000, Math.max(5_000, soonest + 1_000));
    }
    return 60_000;
  });

  createEffect(
    () => [liveDelayMs(), liveTick()] as const,
    ([delay]) => {
      if (delay === null) return;
      const t = setTimeout(() => {
        if (disposed) return;
        setLiveTick((n) => n + 1);
        if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
        void refreshQueue({ preserveOrder: true });
      }, delay);
      return () => clearTimeout(t);
    },
  );

  // Initial fetch + visibility wakeup + pagehide flush + full disposal cleanup.
  onSettled(() => {
    if (autoLoad) {
      void refreshFrontiers();
      void refreshExplorations();
      void refreshQueue({ selectInitial: true });
    }

    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refreshQueue({ preserveOrder: true });
      }
    };
    const onPageHide = () => flushPersist();

    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("beforeunload", onPageHide);
    }

    return () => {
      disposed = true;
      flushPersist();
      queueAbort?.abort();
      frontierAbort?.abort();
      explorationAbort?.abort();
      if (warmTimer) clearTimeout(warmTimer);
      if (celebrateTimer) clearTimeout(celebrateTimer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("beforeunload", onPageHide);
      }
    };
  });

  return {
    state,
    dueQueue,
    doneQueue,
    remainingCount,
    backlogDueCount,
    sittingDoneCount,
    soonestNextMs,
    currentFrontier,
    currentExploration,
    stageKey,
    reloadNonce,
    sidebarLabel,
    rememberPrompt,
    setMapOpen,
    setDoneOpen,
    setArchivedOpen,
    clearError,
    selectUnit,
    selectFrontier,
    selectExploration,
    selectExplore,
    startExplorationFrom,
    addFrontier,
    promoteExploreToSaved,
    promotePostFollowUpToExploration,
    updateFrontierDemonstrated,
    removeFrontierById,
    archiveExplorationById,
    unarchiveExplorationById,
    removeExplorationById,
    markUnitCompleted,
    practiceUnitAgain,
    advanceFromUnit,
    startNextSitting,
    undoAddedUnit,
    updateUnitSession,
    updateExplore,
    resetExplore,
    clearUnitSession,
    refreshQueue,
    refreshFrontiers,
    refreshExplorations,
  };
}
