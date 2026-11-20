A message is one turn of text in the thread, from the tutor or from the learner.

## Anatomy

- **Tutor message** (`myl-message`). Plain text on `paper`, full column width, no ground, no border, no name. Paragraphs are `space-3` apart. When there is a question it is the last paragraph.
- **Learner message** (`myl-message myl-message--learner`). Right-aligned, at most 80 percent of the column, on `human-message-surface` with `radius-card` and padding of `space-3` by `space-4`.
- **Trace** (`myl-trace`). One line in the `trace` style and `muted`, 4px under the tutor message that closed a review. It states what happened and nothing else.
- **Day divider** (`myl-day`). A `trace` label between two `line` rules.

Messages sit in an `myl-thread` column. Add `myl-turn` to the first message of a new turn. Both speakers use the `thread-body` style. The tutor is told apart by position and ground, not by a label.

## Rules

- Never put a tutor message on a card or bubble. Only non-prose content gets a card.
- A tutor message holds at most 100 words and one question.
- Math is inline at the size of the text.
- Text streams in as it arrives. There is no typing indicator beyond the text itself.
- Messages within a turn are `space-3` apart, turns are `space-6` apart.

## The consumer provides

The text, the speaker, and an optional trace string. Cards that belong to a message (a unit, a table, a timeline) follow it as siblings.
