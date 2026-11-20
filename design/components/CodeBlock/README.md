A code block is runnable code on a page or in the thread, with its output directly beneath it.

## Anatomy

- `myl-code`: a recessed block on `code-surface` with `radius-card` and no border or shadow.
- Code in the `code` style, with a `space-4` gutter. Long lines scroll sideways inside the block.
- Output in the same style, under a 1px `annotation-edge` rule.
- A foot row under another rule: a status in the `trace` style on the left, and the Run page text button on the right.

## Status wording

| State | Text | Colour |
| --- | --- | --- |
| Never run | Not run yet | `ink` |
| Ran | Ran with the page | `ink` |
| Ran in a timed run | Ran at 14:18 into the run | `ink` |
| Failed | Failed at this block | `danger` |

## Rules

- Run page runs every block on the page from the top. There is no button to run one block alone, so there is no hidden state.
- A failed run is the one place `danger` appears in normal use.
- Status text on this ground is `ink`, so it reads as part of the block and not as a caption.
- No syntax colouring in v1. Code is `ink` on `code-surface`.
- In the thread, a code block the learner sent sits right-aligned like their messages. One the tutor ran sits full width.

## The consumer provides

The code, the latest output and the status.
