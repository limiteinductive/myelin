# Proposed spec changes (from milestone 1)

Places where the core code differs from `docs/spec.md`. Neither the spec nor the code was changed to hide the difference; each needs a yes or no.

1. **study-mode import keeps "its event ids".** study-mode `memory.jsonl` entries have no ids. The importer derives a UUIDv7 from each entry's `created_at` and a hash of the line and its index, so a re-import produces the same events. *Proposal:* "imports as events with ids derived from each entry, so re-importing is a no-op."
2. **`Scheduler.recall(memory, at: Date)`.** The code takes `at` in milliseconds, matching the event `ts`, and keeps unit memory as plain JSON so that state round-trips exactly. *Proposal:* `at: number` (ms).
3. **`nextProbe(slot, now)`.** The code is `nextProbe(state, slot, now: number, { scheduler, … })`, a pure function. The server's `next_probe(slot)` tool wraps it. *Proposal:* document the pure form in core.
4. **Later corrections.** "A correction by the learner overrides" the grade. An in-turn correction is `corrected_grade` on the probe. A later one ("that was lucky") is a new `unit.probed` with `corrects: <event id>`, and memory is recomputed from the unit's evidence. *Proposal:* add both forms to "What `unit.probed` records".
5. **Reflex units.** The spec says reflexes are observed, never probed, but gives no field for it. The code uses `unit.found.observe_only`, so `kind` never drives behaviour. *Proposal:* add the flag.
6. **Unranked defaults in `nextProbe`.**
   - A unit is not probed in its first 8 hours, unless the current work touches it.
   - A unit is not probed twice within 10 minutes.
   - In context, a unit is probed only when its predicted recall is below 0.97.
   - A retired unit returns only when its predicted recall falls below 0.7, or after a missed probe.
   - Ladder probes (tier 4, after the goal) start 3 days after the first successful recall or rebuild.
   - A timed run offers only use probes on units with predicted recall of at least 0.8.
   - *Proposal:* list these as tunable defaults.
7. **"A told unit that can be rebuilt is not probed until it has been rebuilt once."** Read literally, it could never be probed. The code offers it a rebuild probe only, and skips its ladder probes until a rebuild succeeds. *Proposal:* reword to "…is probed by rebuilding until it has been rebuilt once."
