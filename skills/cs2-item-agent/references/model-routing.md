# Model routing

Keep the two decision models independent. They may share observations, but never share a final score or silently substitute for one another.

## Hanging execution model

Use `show_hanging_fee_assumptions`, `screen_hanging_candidates`, and `assess_hanging_candidate` for questions about 搬砖、挂刀、Steam 余额兑换、七日交易保护 or whether an item can be exited reliably.

The model evaluates current purchase and exit references, explicit fees, turnover, category eligibility, and defensive/base/optimistic seven-day scenarios. Its conclusion concerns execution after the trade lock. It does not establish dealer interest or medium-term market value.

Default candidate policy:

- prefer cases;
- allow high-turnover ordinary weapon skins;
- exclude stickers, patches, knives, and gloves from automatic screening;
- analyze an excluded category only when the user explicitly requests it, and preserve the category warning.

## Market-trading model

Use `analyze_market_trading` for questions about 行情、板块轮动、大商运作、有效流通盘、集中度、汰换驱动、吸筹/洗盘/出货假设 or medium-term market state. `analyze_item_decision` is a compatibility alias.

The model returns `model.type=market_trading` and must keep four evidence groups separate:

1. `verifiedObservations`: API observations with provider time;
2. `deterministicCalculations`: returns, relative strength, effective-float ratios, or trade-up expected value derived from shown inputs;
3. `expertAnnotations`: user-confirmed experience or manually transcribed provider observations;
4. `unknowns`: unavailable, structurally missing, or unpriced context.

Do not convert expert annotations into verified facts. Include a short source label and observation date whenever available.

## Expert context

Pass `expertContext` only from information the user supplied or explicitly confirmed:

- `sector`: named index return and window;
- `effectiveCirculatingSupply`: low/central/high estimate;
- `dealerOperation`: low/medium/high suitability;
- `tradeUp`: analyzed item's role, input count, related inputs/outputs, and optionally a complete priced probability basket.

If item and sector windows differ, report the mismatch. Do not normalize silently. If trade-up outcome probabilities do not sum to 1 or any required price is absent, keep the relationship but report expected value as unknown.

Ordinary quality upgrades generally consume 10 same-rarity items. The current top-tier contract can consume 5 Covert items for a corresponding knife or gloves outcome; never infer which rule applies without the item's verified rarity and collection relationship.

## Combined questions

When the user asks both “适合挂刀吗” and “行情值得参与吗”, run both routes and return two separately titled conclusions. A valid combined answer may be:

> 行情交易属性较强，但不适合挂刀。

Never average the two conclusions into one score.
