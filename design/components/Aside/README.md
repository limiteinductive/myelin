An aside is a short conversation anchored to a passage of a page, shown in the margin beside it.

## Anatomy

- `myl-aside`: a `surface` card with a `line` border, `radius-card`, `elevation-card` and a `space-4` gutter.
- The quoted passage at the top, in the `quote` style and `muted`, with a 2px rule on its left. The rule is `accent-line` when the learner started the aside and `source` when the tutor raised it.
- Messages in the `aside-body` style. Each has a small name above it: "You" in `muted`, "Tutor" in `accent`.
- An optional state line in the `trace` style, for example "Waiting for you".

## Rules

- An aside raised by the tutor is always a question at that line. It never contains the fix.
- Tutor messages in an aside are at most 100 words.
- The passage on the page is highlighted to match: `selection` for the learner's, `passage-focus` for the tutor's.
- Asides sit in source order down the margin, level with their passage where there is room.
- The thread itself is the first card of the margin, with the same anatomy and no quote.
- On a phone there is no margin. An aside appears in the thread as a quoted passage followed by its messages.
- Asides are not resolved, graded or closed by a button. They scroll away with the page.

## The consumer provides

The quoted text, who raised it, the messages and an optional state.
