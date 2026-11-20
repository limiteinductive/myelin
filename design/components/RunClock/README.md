The run clock is the only place the app ever shows time passing, and it exists only during a timed run.

## Anatomy

- `myl-clock`: a pill with `radius-round` on an `ink` fill, with `on-ink` text.
- The time left in the `clock` style, then "left of" and the run's length in the `trace` style.
- Tabular numerals, so the pill does not change width as digits change.

## States

| State | Look |
| --- | --- |
| Running | `ink` fill |
| Last minute | `warning` fill. The only change is colour. It does not pulse or grow. |
| Paused | No fill, `annotation-edge` outline, the word "paused" |

## Rules

- The clock sits at the top right of the page, on the line of the link back to the thread. On a phone it is fixed at the top of the thread.
- It appears when the learner starts or accepts a run and disappears when the run ends. There is no clock at any other time, including on recalls.
- The learner pauses and stops in words. The clock has no buttons.
- It counts down, never up. Elapsed time appears only in the debrief.
- No sound and no animation at zero. The tutor says the time is up in the thread.

## The consumer provides

The time left, the run length and the state.
