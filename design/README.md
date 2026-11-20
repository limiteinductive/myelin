Myelin is a tool for learning any subject with an AI tutor in one ongoing conversation. It is named after the coating that practice lays on nerve fibres, which makes their signals travel faster. Build its interface from the tokens in `tokens.json` and the classes in `components/bundle.css`. Every class starts with `myl-` and takes all of its colours, spacing, radii and fonts from the tokens.

## Principles

**Agentic hyperminimalism.** Put on screen only what the learner must do by hand. Let the tutor do everything else through tools.

- Allow exactly these controls: the composer, Send, the plus button, Reword on a unit, Run page on a code block, the link from a page back to the thread, and text selection.
- Do not build a settings panel, a library, a sidebar, a tab bar, a toolbar or a menu. Appearance, text size, how often the tutor quizzes, goals, deadlines, naming a page and finding old work are all asked for in words.
- Before adding a control, check that saying it to the tutor would be slower or impossible in the moment. If not, do not add it.
- Never let the tutor write on the learner's page. It asks a question at a line.

**Paper and ink.** Treat the whole app as one sheet. Set text directly on `paper`. Box only what is not prose.

**One accent, one signal.** Use `accent` for what the learner can act on and for the tutor's name in an aside. Use butter (`unit-surface`, `unit-label`) for a unit of understanding and for nothing else.

**Quiet by default.** Leave one grey line after a review. Treat the tutor's silence as a designed state. Never animate to get attention.

## Colour

- Set body text in `ink` on `paper` or `surface`. Set secondary text in `muted`.
- Never use `accent` as a ground for running text. Use `on-accent` for the icon on an `accent` fill.
- Ground a unit card in `unit-surface` and label it in `unit-label`. Text on that ground is `ink`.
- Make evidence chips differ in lightness as well as hue: shown is an `ink` fill with `on-ink` text, not yet is an `annotation-edge` outline with `muted` text, missed is `source-wash` with `warning` text and the word "missed".
- Highlight a passage the learner selected with `selection`, and one the tutor is asking about with `passage-focus`.
- Set recessed content, such as code and a problem statement, on `code-surface`, with `ink` text.
- Use `warning` for a miss and for the costly step of a debrief. Use `danger` only for a failed code run or a destructive action. A wrong answer is not an error.
- Use `butter` only on the cover or in a mark. Never set text in it or on it.
- Draw keyboard focus as a 2px `focus-ring` outline, offset by 2px.
- Support both themes from the tokens alone. Do not hard-code a colour anywhere.

## Typography

- Set every message in the thread and all prose on a page in `font-reading`, which is Literata. Load it as a variable font with its optical size axis.
- Set asides, controls, labels, traces and cards in `font-interface`, the device's own face.
- Set code and its output in `font-mono`.
- Use the named styles: `thread-body` for messages, `page-body`, `page-title`, `page-heading` and `page-math` on a page, `unit-statement` on a unit, `aside-body` in an aside, `control` on a button, `trace` for secondary lines, `label` for uppercase labels, `clock` for the run clock, `code` for code.
- Typeset math with KaTeX at the size of the surrounding text. Keep what the learner typed as the source.
- Use tabular numerals wherever digits change or line up: the clock, timings, traces.
- Never set text below 13px.

## Layout

- On a phone, show the thread only, with `space-4` side gutters and the composer fixed to the bottom. See the PhoneThread layout.
- At a desk with no page open, centre the thread in a column of at most `reading-width`.
- With a page open, give the page the centre at `reading-width` and put the margin to its right at `aside-width`, `space-6` apart. See the DeskPage layout.
- Right-align learner messages at no more than 80 percent of the column. Run tutor messages the full column with no ground.
- Space messages within a turn by `space-3` and turns by `space-6`.
- Give every interactive element a hit area of at least `target-min`.
- Use `radius-card` on cards, asides, the composer, learner messages and code blocks, `radius-control` on text buttons and highlights, and `radius-round` on the send button, chips and the clock.
- Raise only the composer and asides, with `elevation-card`. Keep everything in the thread flat.

## Motion

| Name | Value | Use |
| --- | --- | --- |
| feedback | 120ms | Hover and press |
| reveal | 220ms | A card or an aside appearing |
| navigation | 240ms, `cubic-bezier(0.22, 1, 0.36, 1)` | A page opening beside the thread |

- Stream tutor text as it arrives. Do not add a typing effect or a typing indicator.
- Remove reveal and navigation when the device asks for reduced motion.

## Voice

- Keep a tutor turn to at most 100 words and at most one question, placed last.
- Name the reasoning in feedback, not the person. Do not use praise words on their own.
- Write a trace as a plain fact in a few words: "Recalled in 4 seconds." "Rebuilt. Back in about 9 days."
- Write a unit as a statement the learner could say aloud: "A baseline must not depend on the sample."
- Write unit kinds in lowercase: move, result, distinction, reflex, word.
- Phrase an aside from the tutor as a question at the line. Never include the fix.
- Use sentence case everywhere. Do not use exclamation marks or emoji.

## Iconography

- Use three icons only: plus, send (an upward arrow) and close.
- Draw them as inline SVG at 18px with a 1.75px stroke in the current text colour.
- Give every icon-only button an accessible label. Make everything else a word.

## Assets

- `assets/Texture/paper-grain.svg` is a paper grain tile. Repeat it over `paper` on a page, and nowhere else. Remove it when the device asks for more contrast or reduced transparency.
- `assets/Logo/` holds the mark and the app icon as SVG files. Inside the app, draw the mark inline with `currentColor` instead (see the Logo component).

## Logo

- The logo is one colour: a lowercase m whose second arch climbs higher than the first. Draw it in `ink` on `paper` or `surface`.
- Write the name as Myelin, capitalised, in `font-reading` at weight 600. In a lockup the mark comes first, 1em square, 0.3em from the name (`myl-logo`).
- Use the app icon (`myl-appicon`) for the favicon and the installed app: an `ink` square with a `paper` mark.
- Never colour the mark with `accent` or `butter`, add a second colour, or change its line weight.
- Keep the logo out of the thread and off pages. Show it on the sign-in screen, the favicon and the app icon.
