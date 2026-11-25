// Persistent per-user plain-English Interactive Briefings for unfamiliar papers, chapters,
// codebases, or topics. Learners read, highlight/cite any part to unpack, and optionally
// stress-test the non-obvious cruxes so genuine insights graduate into the Map & RWKV.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface BriefingCrux {
  text: string;
  kind: string;
  question: string;
  source_ref?: string;
}

export interface Frontier {
  id: string;
  title: string;
  source: string;
  /** Jargon-free plain-English markdown briefing (sections, bullets, concrete examples). */
  body: string;
  /** Short list of concepts already solid in the learner's Map that were skipped. */
  skipped_known: string[];
  /** 2-4 genuinely non-obvious core takeaways/tradeoffs for opt-in "Test me" checks. */
  cruxes: BriefingCrux[];
  /** Indices of cruxes the learner has already demonstrated in "Test me". */
  demonstrated_cruxes?: number[];
  /** Persisted discussion turns for cross-device resume. */
  turns?: { user: string; coach: string; added?: { unit_id: string; text: string; kind: string; observe_only: boolean }[] }[];
  created_at: number;
}

export class FrontierStore {
  private readonly byUser = new Map<string, Frontier[]>();

  constructor(private readonly filePath?: string | undefined) {
    this.load();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown[]>;
      for (const [uid, list] of Object.entries(parsed)) {
        if (!Array.isArray(list)) continue;
        // Keep only briefing-format entries (cleanly drop any legacy node-only drafts)
        const valid = list.filter(
          (f): f is Frontier =>
            Boolean(f) &&
            typeof f === "object" &&
            typeof (f as Frontier).id === "string" &&
            typeof (f as Frontier).body === "string" &&
            (f as Frontier).body.trim().length > 0,
        );
        if (valid.length > 0) this.byUser.set(uid, valid);
      }
    } catch {
      /* ignore corrupt file */
    }
  }

  private save(): void {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.byUser), null, 2), "utf8");
    } catch {
      /* ignore write errors */
    }
  }

  list(userId: string): Frontier[] {
    return this.byUser.get(userId) ?? [];
  }

  get(userId: string, frontierId: string): Frontier | undefined {
    return this.list(userId).find((f) => f.id === frontierId);
  }

  add(userId: string, frontier: Frontier): Frontier {
    const list = [...this.list(userId), frontier];
    this.byUser.set(userId, list);
    this.save();
    return frontier;
  }

  remove(userId: string, frontierId: string): boolean {
    const list = this.list(userId);
    const next = list.filter((f) => f.id !== frontierId);
    if (next.length === list.length) return false;
    this.byUser.set(userId, next);
    this.save();
    return true;
  }
}
