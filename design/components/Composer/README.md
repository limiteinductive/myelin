The composer is the single place the learner types or dictates, for the thread and for asides alike.

## Anatomy

- `myl-composer`: a `surface` card with a `line` border, `radius-card` and `elevation-card`.
- A plus button on the left for a photo, a code block or scratch work.
- A text field in the `thread-body` style. The placeholder is "Say anything", or "Type or dictate" beside a page.
- A round send button (`myl-send`) on `accent`, 36px inside a `target-min` hit area. It is dimmed to `accent-line` while the field is empty.
- An optional scope line above the field, in `accent`, when a passage is selected. It names what the message will be about and how to leave that scope.
- The same line in `muted` (`myl-composer__scope--offline`) when the app has lost its connection. It says "Not connected. Your draft is kept here." and the send button is dimmed until the connection returns.

## Rules

- A lost connection changes nothing else on screen: no banner, no dialog, no retry button. The draft stays in the field.
- There is one composer on screen. Its scope follows the selection: a selected passage aims it at an aside, no selection aims it at the thread.
- The field grows with its text up to a third of the viewport, then scrolls.
- Enter sends. Shift+Enter adds a line. On a phone the keyboard's return adds a line and the send button sends.
- The field shows no focus ring of its own. The caret is the focus. Buttons show a 2px `accent` ring on keyboard focus.
- Voice is the device's dictation into this field. The app has no microphone button.
- On a phone the composer is fixed to the bottom with `space-4` side gutters. Beside a page it sits at the foot of the margin.

## The consumer provides

The scope, if any, and handlers for send and for the plus menu.
