# Sticker DIY guidance

## Workflow

1. Resolve the exact skin and wear variant.
2. Ask for style, budget, or reference examples only when they materially constrain the result. If budget is absent, offer clearly labelled low/mid/high price ideas instead of inventing one hard cap.
3. Search the local catalog. Sync and enrich only the bounded missing subset.
4. Recommend verified stickers with price evidence and explain palette, theme, visual rhythm, focal point, and placement logic.
5. Render or return a CS2 inspect code. Interpret the render mode exactly.
6. Record feedback only after the user explicitly rates or selects a result.

## Aesthetic principles

- Prefer intentional composition over filling every default slot.
- Allow a single-side best-view composition when it improves the design.
- Consider repeated motifs, asymmetric focal stickers, typography, negative space, and alignment with weapon geometry.
- Treat sticker cost as a user preference, not a universal ratio to skin price.
- Propose scraped/hidden-image outcomes only when the sticker's scrape state is known from verified data or a reproducible case. State the exact wear/scrape assumption.
- Free-position offsets, rotation, scale, and scrape wear materially change the result. Do not claim default slots reproduce a free-position reference.

## Evidence boundaries

- Catalog identity and provider price fields are sourced observations.
- Palette, visual tags, compatibility scores, and style names are local heuristics.
- A recommendation is subjective, not a market fact.
- `steamdt_game_render` means a provider returned a rendered screenshot; `steamdt_pending` is unfinished; `inspect_code_only` requires the user to inspect in CS2.
- Do not attach a generic overlay or catalog image as if it were the final craft.
- State that in-game lighting, model geometry, sticker edge clipping, and scrape appearance require final CS2 inspection.
