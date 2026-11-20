// Builds the recorded fixture log: two weeks of a probability course, touching every unit and
// evidence event, corrections in turn and later, and a few events that must become anomalies.
import { deterministicUuidv7, makeEvent, type MyelinEvent } from "../src/index.js";

const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
const H = 3_600_000;
const D = 24 * H;

export function buildSession(): MyelinEvent[] {
  const out: MyelinEvent[] = [];
  let n = 0;
  const add = (at: number, device: string, e: (meta: { id: string; device_id: string; ts: number; seq: number }) => MyelinEvent) => {
    n++;
    const ev = e({ id: deterministicUuidv7(T0 + at, `fixture:${n}`), device_id: device, ts: T0 + at, seq: n });
    out.push(ev);
    return ev.id;
  };
  const phone = "dev-phone";
  const desk = "dev-desk";
  const tutor = "server:tutor";

  add(0, desk, (m) => makeEvent("message.added", { author: "learner", text: "I want to learn probability for the exam on the 20th." }, m));
  add(1000, tutor, (m) => makeEvent("goal.set", { goal_id: "g-exam", text: "Probability exam", due: T0 + 15 * D, topic: "probability", unit_ids: ["u-bayes"] }, m));
  add(2000, tutor, (m) => makeEvent("budget.set", { seconds: 1800, note: "half an hour a day" }, m));
  add(3000, tutor, (m) => makeEvent("preference.set", { key: "hints", value: "small steps" }, m));

  add(60_000, tutor, (m) => makeEvent("unit.found", { unit_id: "u-cond", text: "P(A|B) = P(A∩B)/P(B)", kind: "definition", topic: "probability", origin: "told", told: true }, m));
  add(61_000, tutor, (m) => makeEvent("unit.found", { unit_id: "u-mult", text: "P(A∩B) = P(A|B)P(B)", kind: "rule", topic: "probability", rests_on: ["u-cond"], origin: "derived" }, m));
  add(62_000, tutor, (m) => makeEvent("unit.found", { unit_id: "u-bayes", text: "Bayes' rule", kind: "theorem", topic: "probability", rests_on: ["u-mult"], origin: "told", told: true }, m));
  add(63_000, tutor, (m) => makeEvent("unit.found", { unit_id: "u-var", text: "Var(X) = E[X²] − E[X]²", kind: "identity", topic: "probability", origin: "need" }, m));
  add(64_000, tutor, (m) => makeEvent("unit.found", { unit_id: "u-check", text: "Check that probabilities sum to one", kind: "reflex", topic: "probability", origin: "observed", observe_only: true }, m));
  add(65_000, tutor, (m) => makeEvent("unit.found", { unit_id: "u-cond", text: "duplicate", kind: "definition", origin: "hint" }, m)); // anomaly

  // Day 1: greeting recall of the definition, a rebuild of the product rule, an in-turn correction.
  const p1 = add(1 * D, phone, (m) => makeEvent("unit.probed", { unit_id: "u-cond", depth: "recall", slot: "greeting", prompt: "What is P(A|B)?", grade: "good", latency_ms: 4200, scheduler: "fsrs-6", predicted_recall: 0 }, m));
  add(1 * D + 600_000, phone, (m) => makeEvent("unit.probed", { unit_id: "u-mult", depth: "rebuild", slot: "seam", prompt: "Derive P(A∩B).", grade: "hard", corrected_grade: "good", hints: 1, latency_ms: 31_000, scheduler: "fsrs-6", predicted_recall: 0 }, m));
  add(1 * D + 700_000, desk, (m) => makeEvent("unit.observed", { unit_id: "u-check", present: true, page_id: "p-1", elapsed_ms: 40_000 }, m));
  add(1 * D + 800_000, tutor, (m) => makeEvent("unit.reworded", { unit_id: "u-cond", text: "P(A|B) is the share of B where A also holds", by: "learner" }, m));

  // Day 2: a later correction ("that was lucky") of day 1's recall, and a rebuild of Bayes.
  add(2 * D, phone, (m) => makeEvent("unit.probed", { unit_id: "u-cond", corrects: p1, grade: "hard", note: "that was lucky" }, m));
  add(2 * D + 1000, phone, (m) => makeEvent("unit.probed", { unit_id: "u-bayes", depth: "rebuild", slot: "greeting", prompt: "Rebuild Bayes from the product rule.", grade: "good", latency_ms: 52_000, scheduler: "fsrs-6", predicted_recall: 0 }, m));
  add(2 * D + 2000, phone, (m) => makeEvent("unit.probed", { unit_id: "u-nope", depth: "recall", slot: "seam", prompt: "?", grade: "good", scheduler: "fsrs-6" }, m)); // anomaly
  add(2 * D + 3000, phone, (m) => makeEvent("unit.probed", { unit_id: "u-cond", corrects: "0190e0d0-0000-7000-8000-000000000000", grade: "easy" }, m)); // anomaly

  // Day 3: variance split in two; a dependent is relinked to both parts.
  add(3 * D, tutor, (m) => makeEvent("unit.found", { unit_id: "u-chebyshev", text: "Chebyshev's inequality", kind: "theorem", topic: "probability", rests_on: ["u-var"], origin: "derived" }, m));
  add(3 * D + 1000, tutor, (m) =>
    makeEvent(
      "unit.split",
      {
        unit_id: "u-var",
        into: [
          { unit_id: "u-var-def", text: "Var(X) = E[(X − μ)²]", kind: "definition", topic: "probability" },
          { unit_id: "u-var-short", text: "Var(X) = E[X²] − μ²", kind: "identity", topic: "probability", rests_on: ["u-var-def"] },
        ],
      },
      m,
    ),
  );
  add(3 * D + 2000, phone, (m) => makeEvent("unit.probed", { unit_id: "u-var-short", depth: "rebuild", slot: "in_context", prompt: "We need the shortcut here.", grade: "again", hints: 2, scheduler: "fsrs-6", predicted_recall: 0 }, m));

  // Day 4: two wordings of the same idea merged; the product rule retired; explain and use probes.
  add(4 * D, tutor, (m) => makeEvent("unit.found", { unit_id: "u-chain", text: "Chain rule of probability", kind: "rule", topic: "probability", rests_on: ["u-cond"], origin: "hint" }, m));
  add(4 * D + 1000, tutor, (m) => makeEvent("unit.linked", { unit_id: "u-bayes", rests_on: ["u-mult", "u-chain", "u-bayes"] }, m));
  add(4 * D + 2000, tutor, (m) => makeEvent("unit.merged", { unit_id: "u-mult", merged: ["u-chain"], text: "P(A∩B) = P(A|B)P(B), chained" }, m));
  add(4 * D + 3000, phone, (m) => makeEvent("unit.probed", { unit_id: "u-bayes", depth: "explain", slot: "seam", prompt: "Explain Bayes to a newcomer.", grade: "good", scheduler: "fsrs-6", predicted_recall: 0.95 }, m));
  add(4 * D + 4000, phone, (m) => makeEvent("unit.probed", { unit_id: "u-chain", depth: "use", slot: "seam", prompt: "Three cards in a row…", grade: "good", scheduler: "fsrs-6" }, m)); // resolves to u-mult
  add(4 * D + 5000, tutor, (m) => makeEvent("unit.retired", { unit_id: "u-mult", reason: "held well" }, m));
  add(4 * D + 6000, tutor, (m) => makeEvent("unit.retired", { unit_id: "u-mult", reason: "again" }, m)); // anomaly

  // Day 9: the retired unit fails and comes back; observations; a timed run.
  add(9 * D, desk, (m) => makeEvent("run.started", { run_id: "r-1", duration_ms: 20 * 60_000, conditions: "closed book" }, m));
  add(9 * D + 1000, desk, (m) => makeEvent("unit.probed", { unit_id: "u-mult", depth: "use", slot: "timed_run", prompt: "Two dice…", grade: "again", latency_ms: 140_000, scheduler: "fsrs-6", predicted_recall: 0.81 }, m));
  add(9 * D + 2000, desk, (m) => makeEvent("unit.probed", { unit_id: "u-mult", depth: "recall", slot: "timed_run", prompt: "State the product rule.", grade: "again", scheduler: "fsrs-6", predicted_recall: 0.81 }, m));
  add(9 * D + 3000, desk, (m) => makeEvent("unit.observed", { unit_id: "u-check", present: false, page_id: "p-2" }, m));
  add(9 * D + 20 * 60_000, desk, (m) => makeEvent("run.ended", { run_id: "r-1" }, m));
  add(9 * D + 21 * 60_000, tutor, (m) => makeEvent("preference.set", { key: "hints", value: { style: "small steps", max: 2 } }, m));
  add(9 * D + 22 * 60_000, tutor, (m) => makeEvent("unit.reworded", { unit_id: "u-bayes", kind: "rule", by: "tutor" }, m));

  // Day 10: a run on a page that is paused, resumed and runs out of time; a pause of no run.
  add(10 * D, tutor, (m) => makeEvent("run.started", { run_id: "r-2", duration_ms: 10 * 60_000, conditions: "interview", page_id: "p-2" }, m));
  add(10 * D + 60_000, desk, (m) => makeEvent("activity.signal", { signal: "typing" }, m));
  add(10 * D + 3 * 60_000, tutor, (m) => makeEvent("run.paused", { run_id: "r-2" }, m));
  add(10 * D + 5 * 60_000, tutor, (m) => makeEvent("run.paused", { run_id: "r-2" }, m)); // anomaly
  add(10 * D + 8 * 60_000, tutor, (m) => makeEvent("run.resumed", { run_id: "r-2" }, m));
  add(10 * D + 16 * 60_000, tutor, (m) => makeEvent("run.ended", { run_id: "r-2", reason: "time" }, m));
  add(10 * D + 17 * 60_000, tutor, (m) => makeEvent("run.paused", { run_id: "r-9" }, m)); // anomaly
  return out;
}

export { T0, D, H };
