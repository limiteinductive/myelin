// Imports a study-mode memory.jsonl as events.
//
// study-mode entries carry no event id, so ids are derived from each entry's time and content.
// Importing the same file twice gives the same events, and the server's id-based dedupe makes a
// re-import a no-op.
import { makeEvent, type Depth, type Grade, type MyelinEvent } from "../events.js";
import { deterministicUuidv7 } from "../ids.js";

export const STUDY_MODE_DEVICE = "import:study-mode";

interface Entry {
  created_at: string;
  algorithm_version?: string;
  concept_id: string;
  topic: string;
  concept: string;
  summary?: string;
  evidence?: string | null;
  preferences?: string[];
  memory?: { retrievability?: number | null };
  review?: {
    recall_result: Grade;
    hints_used?: number;
    retrieval_depth: "recognition" | "recall" | "explanation" | "application" | "transfer";
  } | null;
}

const DEPTH: Record<NonNullable<Entry["review"]>["retrieval_depth"], Depth> = {
  recognition: "recall",
  recall: "recall",
  explanation: "explain",
  application: "use",
  transfer: "use",
};

export class ImportError extends Error {}

/** The unit id a study-mode concept becomes. */
export function studyModeUnitId(conceptId: string): string {
  return `study-mode:${conceptId}`;
}

/** Converts the text of a memory.jsonl into events, in file order. The events have no seq. */
export function importStudyMode(text: string): MyelinEvent[] {
  const events: MyelinEvent[] = [];
  const seenUnits = new Set<string>();
  const seenPrefs = new Set<string>();
  const lines = text.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      throw new ImportError(`line ${index + 1}: not JSON`);
    }
    const ts = Date.parse(e.created_at);
    if (!Number.isFinite(ts) || ts < 0 || !e.concept_id || !e.concept || typeof e.topic !== "string") {
      throw new ImportError(`line ${index + 1}: missing created_at, concept_id, concept or topic`);
    }
    const seed = (part: string) => `${index}:${part}:${line}`;
    const meta = (part: string) => ({ id: deterministicUuidv7(ts, seed(part)), device_id: STUDY_MODE_DEVICE, ts });
    const unitId = studyModeUnitId(e.concept_id);

    if (!seenUnits.has(unitId)) {
      seenUnits.add(unitId);
      events.push(
        makeEvent("unit.found", { unit_id: unitId, text: e.concept, kind: "concept", topic: e.topic, rests_on: [], origin: "imported" }, meta("found")),
      );
    }

    if (e.review) {
      const rv = e.memory?.retrievability;
      const r = typeof rv === "number" && rv >= 0 && rv <= 1 ? rv : null;
      events.push(
        makeEvent(
          "unit.probed",
          {
            unit_id: unitId,
            depth: DEPTH[e.review.retrieval_depth],
            slot: "imported",
            prompt: "",
            grade: e.review.recall_result,
            hints: e.review.hints_used ?? 0,
            scheduler: `study-mode:${e.algorithm_version ?? "unknown"}`,
            predicted_recall: r,
          },
          meta("probed"),
        ),
      );
    } else {
      const note = [e.summary, e.evidence].filter((x): x is string => !!x && x.trim() !== "").join("\n\n") || null;
      events.push(makeEvent("unit.observed", { unit_id: unitId, present: true, note }, meta("observed")));
    }

    for (const pref of e.preferences ?? []) {
      if (seenPrefs.has(pref)) continue;
      seenPrefs.add(pref);
      events.push(makeEvent("preference.set", { key: `study-mode:${pref}`, value: pref, lasting: true }, meta(`pref:${pref}`)));
    }
  });
  return events;
}
