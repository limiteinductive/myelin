Buttons are the few things the learner presses: a text button, an icon button and the send button.

## The three kinds

| Kind | Class | Look | Used for |
| --- | --- | --- | --- |
| Text button | `myl-text-button` | `accent` text in the `control` style, no ground, `radius-control` | Reword, Run page, the link back to the thread |
| Icon button | `myl-icon-button` | An 18px stroke icon in `muted`, no ground | The plus button, closing a page |
| Send | `myl-send` | A 36px `accent` disc with an `on-accent` arrow | Sending a message. One per screen. |

## States

| State | Text button | Icon button | Send |
| --- | --- | --- | --- |
| Rest | `accent` text | `muted` icon | `accent` disc |
| Hover | `accent-wash` ground | `hover` ground, `ink` icon | No change |
| Keyboard focus | 2px `focus-ring`, offset 2px | Same | Same |
| Disabled | `muted` text | Not used | `accent-line` disc |

Hover and press take 120ms. There is no separate pressed look.

## Rules

- Every button has a hit area of at least `target-min` in both directions, whatever its visual size.
- There is no filled or outlined rectangular button. If a new action seems to need one, it should probably be something the learner says to the tutor.
- A text button's label is one or two words and says what happens.
- An icon button always carries an accessible label.
- Never place two send buttons, or a send button and another `accent` fill, in one view.

## The consumer provides

The label or icon, the accessible label for an icon, and the handler.
