A page is the sheet the learner writes on: one document of prose, math and code that they build and keep.

## Anatomy

- `myl-page`: the page has no card. Its text sits directly on `paper`, in a column of at most `reading-width`.
- The paper grain texture repeats over `paper` on a page, and only there.
- One title in the `page-title` style. Sections use `page-heading`.
- Prose in the `page-body` style.
- Displayed math at 19px, one step per line, with an optional step number in the `trace` style.
- A bar above the title (`myl-page__bar`) with one link back to the thread. During a timed run the clock sits on the same line, on the right.
- A problem statement, when the tutor set one, in a recessed `myl-problem` block on `code-surface`. It is the only text on a page the learner did not write.

## Highlights

| Highlight | Token | Meaning |
| --- | --- | --- |
| Selection | `selection` | The learner selected this passage, or started an aside on it |
| Asked | `passage-focus` | The tutor is asking a question about this passage |
| Resting | `passage-highlight` | A passage with an older aside |

Highlights have `radius-control` corners and 2px of vertical padding.

## Rules

- Only the learner writes on a page. Apart from a problem statement, nothing the tutor says appears inside it.
- The learner's text is kept as typed. Rough math is rendered, and the typed source stays recoverable.
- Reasoning typed in passing may be shown in `muted` if the learner marks it as a note. It is still their text.
- At a desk the margin of asides sits to the right at `aside-width`. On a phone the page is read-only and takes the full width with `space-4` gutters.
- Remove the grain when the device asks for more contrast or reduced transparency.

## The consumer provides

The document. In the app this is a ProseMirror view, with math rendered by KaTeX. This preview sets math in the reading face as a stand-in.
