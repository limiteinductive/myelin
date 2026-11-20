# Logo

The mark is a lowercase m drawn as one line with flat ends, whose second arch climbs higher than the first.

| File | What it is | Use it on |
| --- | --- | --- |
| `myelin-mark.svg` | The mark in `ink` (light theme value) | `paper` and `surface` in the light theme |
| `myelin-mark-light.svg` | The mark in `ink` (dark theme value) | `paper` and `surface` in the dark theme |
| `myelin-icon.svg` | App icon: a paper-coloured mark on an ink square | Favicon, home screen icon, anywhere the icon stands alone |
| `myelin-icon-reversed.svg` | App icon: a dark mark on a light square | The same places, on dark grounds |

All four share one drawing on a 96 unit square: stems at 12, 48 and 84, a 12 unit line, feet at 88. The square already includes the clear space.

Inside the app, draw the mark as inline SVG with `currentColor` (see the Logo component) so it follows the theme. Use these files where inline SVG is not possible.
