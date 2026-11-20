A unit card announces a unit of understanding in the thread at the moment it is found.

## Anatomy

- `myl-unit`: ground `unit-surface` with `radius-card`, a `space-4` gutter and no shadow.
- A `label` line in `unit-label`: how it was found, a middle dot, then the kind. Examples: "Found · move", "Found by this miss · distinction".
- The statement in the `unit-statement` style, in `ink`.
- An optional sub-line in the `trace` style: where it came from and what it rests on.
- A Reword text button on the right, wrapping below on a narrow column.

## Variants

| Variant | Look | When |
| --- | --- | --- |
| Found | Butter ground | The learner derived it, a hint unblocked them, or a miss revealed it |
| Noted (`myl-unit--noted`) | No ground, dashed `annotation-edge` border, `muted` label | The learner was told something that can be rebuilt. It is not tested yet. |

## Rules

- Butter appears nowhere else in the thread. If something is butter, it is a unit.
- The card appears inline, right after the message where the unit emerged. There is no wrap-up screen.
- Keep the statement to one sentence the learner could say aloud. Math is allowed.
- The sub-line on a butter ground is `ink`, not `muted`, to keep contrast.
- Reword turns the statement into an editable field in place. The learner's wording replaces the tutor's.

## The consumer provides

The label parts, the statement, the optional sub-line and the variant.
