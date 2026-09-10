<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Deimos AI LLC -->

# The mark

A crimped ferrule, seen side-on.

A crimp is the fastening you cannot undo. Two conductors go into a sleeve, a
die compresses it, and what comes out is one joint — the strands are not
recoverable. That is this product, exactly: the rule and the facts go in, the
determination is *derived* rather than asserted, and the seal is made before
the outcome is known. A monotone merge, a sealed rule, an authority-signed
carve-out: none of them can be un-made either. The mark is the semantics.

## Why this shape and not the first one

The first attempt drew the strands passing through a hex die, with the
through-line as the dominant element. Rendered at 16, 24 and 32px it read as a
**paper aeroplane**. The die — the part carrying the meaning — disappeared
first, and what survived was an arrow, which says the opposite of what this
system does.

So the hierarchy is inverted. **The pinch carries the mark.** Drop everything
else and it still reads as a crimp; drop the pinch and there is nothing left.
The converging strands inside are a detail that rewards a closer look and is
deliberately removed from the small cut rather than shrunk into mud.

## Files

| File | Use |
|---|---|
| `mark.svg` | The glyph. `currentColor`, so it inherits text colour on any ground. |
| `logo.svg` | Glyph plus wordmark, for headers and READMEs. |
| `favicon.svg` | The 16px cut: pinch only, heavier strokes, on its own dark tile. |
| `_preview.html` | Every size on both grounds. Check here before changing anything. |

## Rules

- **`currentColor` everywhere except the favicon.** The mark must survive a
  dark theme, a light theme, and a black-and-white print of a compliance pack
  without a second file existing.
- **Never re-draw the small cut by scaling the large one.** Interior detail
  below about 24px turns to mud, and mud is how a mark stops being recognised.
- **The wordmark is lowercase.** `crimp`, not `Crimp` and never `CRIMP`.
- **Do not add a colour.** There is one, and it is whatever colour the
  surrounding text is. A product whose entire argument is "no ambiguity" should
  not need a gradient to be recognised.
