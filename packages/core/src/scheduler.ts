// The memory model, behind the spec's Scheduler interface. v1 is FSRS via ts-fsrs.
// Memory states are plain JSON (times in ms) so derived state serializes and replays exactly.
import { fsrs, generatorParameters, createEmptyCard, Rating, type Card, type Grade as FsrsGrade } from "ts-fsrs";
import type { Grade } from "./events.js";

/** One recall or rebuild of a unit, as the memory model sees it. */
export interface Review {
  grade: Grade;
  at: number;
}

/** Opaque, JSON-serializable per-unit memory. Each scheduler defines its own shape. */
export type UnitMemory = { readonly [key: string]: number | string | null };

export interface Scheduler {
  name: string;
  init(): UnitMemory;
  update(memory: UnitMemory, review: Review): UnitMemory;
  /** Predicted probability of recall at `at` (ms). 0 for a unit never reviewed. */
  recall(memory: UnitMemory, at: number): number;
}

const RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

interface FsrsMemory {
  due: number;
  stability: number;
  difficulty: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: number | null;
}

function toCard(m: UnitMemory): Card {
  const f = m as unknown as FsrsMemory;
  return {
    due: new Date(f.due),
    stability: f.stability,
    difficulty: f.difficulty,
    scheduled_days: f.scheduled_days,
    learning_steps: f.learning_steps,
    reps: f.reps,
    lapses: f.lapses,
    state: f.state,
    ...(f.last_review === null ? {} : { last_review: new Date(f.last_review) }),
  } as Card;
}

function fromCard(c: Card): UnitMemory {
  const m: FsrsMemory = {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? c.last_review.getTime() : null,
  };
  return m as unknown as UnitMemory;
}

export interface FsrsOptions {
  /** Target probability of recall. Default 0.9. */
  requestRetention?: number;
}

/**
 * FSRS with fuzz and short-term learning steps off: probes are woven into conversation, not
 * scheduled minutes apart, and replay must be deterministic.
 */
export function fsrsScheduler(opts: FsrsOptions = {}): Scheduler {
  const f = fsrs(
    generatorParameters({
      enable_fuzz: false,
      enable_short_term: false,
      request_retention: opts.requestRetention ?? 0.9,
    }),
  );
  const empty = fromCard(createEmptyCard(new Date(0)));
  return {
    name: "fsrs-6",
    init: () => empty,
    update: (memory, review) => fromCard(f.next(toCard(memory), new Date(review.at), RATING[review.grade]).card),
    recall: (memory, at) => {
      if ((memory as unknown as FsrsMemory).reps === 0) return 0;
      return f.retrievability(toCard(memory), new Date(at));
    },
  };
}
