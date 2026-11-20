The units table is the card the tutor posts when the learner asks where they stand.

## Anatomy

- An `myl-card` holding an `myl-table`: a `surface` card with a `line` border and `radius-card`. No shadow: it is part of the thread.
- Column heads in the `label` style and `muted`.
- Three columns: the unit, what it rests on, and its evidence.
- The unit statement is set in the reading face at 17px, with its kind beneath in the `trace` style. If the unit was found recently, the kind line says how and turns `warning`.
- "Rests on" is `muted` interface text.
- Evidence is a row of chips, one per depth tested.

## Evidence chips

| Chip | Look | Meaning |
| --- | --- | --- |
| Shown | `ink` fill, `on-ink` text | The learner has shown this depth |
| Not yet | 1px `annotation-edge` outline, `muted` text | Applies to this unit, not shown yet |
| Missed | `source-wash` fill, `warning` text, the word "missed" | Missed at the last attempt |

The three differ in lightness as well as hue, and the missed chip also says so in words. Depths that do not apply to a unit are left out. Speed is never a chip.

## Rules

- This card replaces a map screen. It appears only when asked for, scoped to what was asked.
- The tutor always adds one sentence above it and one below it. The card never stands alone.
- Rows are separated by `line-soft`. There is no zebra striping.
- On a narrow column the table scrolls sideways inside the card.
- A unit that is only told shows the plain text "Told, not rebuilt" in place of chips.

## The consumer provides

The rows: statement, kind, found note, what it rests on, and the state of each applicable depth.
