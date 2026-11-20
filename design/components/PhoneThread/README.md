The phone layout is the thread and nothing else: one scrolling column with the composer fixed beneath it.

## Structure

- `myl-phone` fills the viewport and stacks two regions.
- `myl-phone__scroll` holds the thread and scrolls. Its side gutters are `space-4`.
- `myl-phone__foot` holds the composer, with `space-4` at the sides and below, plus the device's bottom safe area.

## Rules

- No header, tab bar, menu button or back arrow. The first thing on screen is the latest part of the conversation.
- The thread opens scrolled to the newest message, with the tutor's greeting visible above the composer.
- A learner message is at most 80 percent of the column. A unit card and any other card take the full column.
- When the keyboard opens, the composer rides above it and the thread keeps its last message in view.
- A page opens read-only over the thread and closes with one close button. Asides on that page appear in the thread as a quoted passage followed by their messages.
- During a timed run the run clock is fixed at the top right, over the thread.
- Text never goes below 13px, and every control has a `target-min` hit area.

## The consumer provides

The thread content and the composer. Nothing in this layout is configurable.
