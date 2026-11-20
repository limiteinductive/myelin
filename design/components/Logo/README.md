The logo is a one-colour mark, a lowercase m whose second arch climbs higher than the first, used alone, beside the name, or inside the app icon.

## Anatomy

- **Mark.** One line on a 96 unit square: three stems at 12, 48 and 84, two arches of radius 18, a 12 unit line, flat feet at 88. The first arch tops out at 38 and the second at 14. Draw it as inline SVG with `stroke="currentColor"` and `stroke-width="12"`, round joins and flat ends.
- **Lockup** (`myl-logo`). The mark, then the name "Myelin" in `font-reading` at weight 600 with -0.02em tracking. The mark is 1em square (`myl-logo__mark`) and sits 0.3em from the name. Set the size with `font-size` on the lockup.
- **App icon** (`myl-appicon`). A square with 22 percent corner radius on `ink`, with the mark in `paper` at 75 percent of its width.

## Colour

- The mark and the name are `ink`. They are never `accent`, never `butter`, and never two colours.
- The app icon is `ink` with a `paper` mark. Because both tokens swap in the dark theme, the icon reverses on its own: a light square with a dark mark.
- Place the mark only on `paper`, `surface` or the app icon. Do not place it on `unit-surface`, on a photo or on the paper grain.

## Size and space

- The 96 unit square already holds the clear space. Keep everything else outside that square, and leave at least one line width (an eighth of the square) more around a lockup.
- Smallest mark: 16px, where the line is exactly 2px. Smallest lockup: 16px type. Smallest app icon: 16px.
- Do not stretch, rotate, outline or round the ends of the mark. Do not redraw it with a different line weight for large sizes.

## Where it appears

- The favicon and the installed app icon.
- The sign-in screen and the cover of this system, as a lockup.
- Nowhere in the thread or on a page. The interface has no header, so the logo does not sit above the conversation.

## The consumer provides

The size, through `font-size` on `myl-logo` or the width and height of `myl-appicon`, and an accessible name where the logo stands alone.
