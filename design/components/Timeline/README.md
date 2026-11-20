The timeline is the card in a debrief that shows where the minutes of a timed run went.

## Anatomy

- An `myl-card myl-card--padded`: a `surface` card with a `line` border, `radius-card` and a `space-4` gutter.
- One bar (`myl-timeline__bar`) split into segments whose widths are their share of the run. Segments are 8px tall and 2px apart.
- A list under the bar: one row per segment, in order, with its name on the left and its duration on the right in tabular numerals.

## Segments

| Segment | Look |
| --- | --- |
| Ordinary step | `muted` fill, 8px tall |
| The costly step | `warning` fill and 20px tall, so it stands out by shape as well as colour. Its row is `warning` and semibold. |
| Unused time | No fill, `annotation-edge` outline, 8px tall, `muted` row |

## Rules

- Exactly one segment is marked costly: the one where a different move would have saved the most. If nothing stands out, none is marked.
- The bar carries no labels. The rows carry the words, in the same order, so the picture is never the only source.
- The tutor's sentence about the costly step comes right after the card, followed by the reflex it suggests, if any.
- Durations are minutes and seconds. No percentages.
- The same card serves an exam: one bar per problem, stacked.

## The consumer provides

The segments in order: name, duration, and which one, if any, is costly.
