The desk layout puts a page in the centre and the conversation in a margin to its right.

## Structure

- `myl-desk` centres two columns with `space-6` between them.
- `myl-page` is the text column, at most `reading-width` plus its gutters. It has no card and sits on `paper` with the grain.
- `myl-margin` is `aside-width` wide. It starts level with the page title, not the top bar.
- The margin holds, top to bottom: the thread as a card, the asides in page order, and the composer.

## Rules

- With no page open, the desk shows only the thread, centred at `reading-width`, exactly as on a phone.
- A page opens beside the conversation in 240ms. The thread does not disappear. It becomes the first card of the margin.
- The page bar holds the link back to the thread on the left and, only during a timed run, the run clock on the right. Nothing else goes in it.
- The margin scrolls with the page. An aside sits level with its passage where there is room, and stacks below the previous one where there is not.
- The composer stays at the foot of the margin and follows the selection on the page.
- Below 960px of width the margin drops under the page and the composer becomes fixed to the bottom.
- There is no sidebar, file tree, tab strip or toolbar at any width.

## The consumer provides

The page document, the asides with their anchors, and the composer.
