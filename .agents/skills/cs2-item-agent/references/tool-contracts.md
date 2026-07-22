# MCP tool contracts

Select the narrowest tool that answers the request. A successful call can append local evidence without changing an external account.

## Setup

### `health_check`

Check database and registered adapter configuration/capabilities without exposing secrets. Use first when a required source fails or the user asks whether setup is complete. `configured=false` means unavailable locally, not that the upstream platform has no data.

## Market facts and decisions

### `get_market_prices`

Fetch current SteamDT platform quotes, visible listing/bid quantities, source time, and limitations for one exact `marketHashName`.

### `compare_market_prices`

Fetch every configured market adapter separately and compare same-platform values. Preserve adapter ids and timestamps. A failed adapter is an explicit partial failure; disagreement is evidence, not an error to hide, and sources must never be silently merged.

### `get_market_kline`

Fetch and store one provider K-line but return a compact summary. Do not claim real transaction volume.

### `analyze_market_item`

Calculate current quote summaries, prior local changes, returns, averages, volatility, drawdown, percentile, relative strength, and data quality. Use for technical analysis.

### `analyze_market_trading`

Use for 行情交易、板块强弱、有效流通盘、大商运作属性 or 汰换上下游 questions. This is the market-trading model and must not be used as a hanging verdict. Optional `expertContext` values remain attributed expert annotations; the tool calculates but does not verify them.

### `analyze_item_decision`

Compatibility alias for `analyze_market_trading`. Prefer the explicit tool name in new workflows.

## CSQAQ monitored intelligence

### `resolve_csqaq_item`

Resolve Chinese or English search text to a CSQAQ `good_id`. If ambiguous, show candidates and ask for selection.

### `get_csqaq_holder_ranking`

Return deduplicated SteamIDs and Top 1/5/10 concentration only inside CSQAQ monitored public-account coverage. Never call it “全网排行”.

### `get_csqaq_supply_trend`

Return provider-defined survival quantity and changes over available windows. The default compact result contains only recent points; request all points only when needed.

### `get_case_market_overview`

Join CSQAQ case-opening counts and provider-calculated expected ROI. ROI is an expectation, not a guaranteed return.

### `list_market_sectors`

Refresh CSQAQ sector indices and the daily Steam card price. Preserve the provider-defined name/key, observation time, and the unit “RMB per 100 USD Steam balance”.

### `get_sector_kline`

Fetch one CSQAQ sector K-line by id, key, or name. Use calculated returns only for matching time windows and label the series as a provider-defined index.

### `sync_tradeup_catalog`

Persist a bounded CSQAQ collection subset, rarity labels, reference prices, and members to local SQLite. Use `search` and `limit` to respect rate limits rather than fetching every collection unnecessarily.

### `analyze_tradeup_relationship`

Read locally synced same-tier and next-tier members for a good id or item name. Check `relationship.eligible`, `contractInputCount`, `outputQuality`, and `outputCatalogStatus` before interpreting tiers. Every step from Consumer through Covert uses ten inputs; Covert-to-rare-special uses five. Souvenir inputs lose souvenir attributes and require a normal base-collection output mapping. Equal collection-outcome probability counts distinct finishes rather than wear-specific good ids and applies only when every required input comes from that collection. Mixed-collection odds and output float need additional inputs.

## Hanging and seven-day scenarios

### `show_hanging_fee_assumptions`

Read the exact local fees, buffers, and thresholds before explaining hanging results.

### `screen_hanging_candidates`

Require a user-selected `targetBalance=steam|platform`. The routes use different entries, exits, fee formulas, card-price requirements, and ranking metrics. Never choose a default target in conversation. This is not a seven-day assessment.

### `assess_hanging_candidate`

Recalculate one candidate using the same target route/filter/page, active fee template, CSQAQ daily card price when needed, and SteamDT defensive/base/optimistic scenarios. If the item is absent or a quote fails sanity checks, report the scope failure instead of promoting it.

## Market alerts

### `add_market_alert`

Create a local edge-triggered rule for sell price/count or bid price/count. Confirm exact item, platform, operator, threshold, adapter id (or `any`), and cooldown from user intent.

### `list_alert_rules`

Read local rules and last evaluation state without exposing secrets.

### `set_alert_rule_enabled`

Enable or disable a rule without deleting history. Use only at the user's request.

### `preview_composite_alert_rule`

Validate and normalize an `all`/`any` expression without saving it. Use for natural-language combinations of current market values, local window change rates, public-inventory changes, valuation, coverage, or high-value events. Show the complete preview and ask for confirmation. Unknown required evidence must remain unknown.

### `add_composite_alert_rule`

Save and enable only a rule the user has confirmed after preview. Never silently change the normalized expression. Percentage thresholds are decimal rates (`-0.2` means down 20%); windows are 30–10080 minutes.

### `list_composite_alert_rules`

Read normalized expressions, scheduling options, consecutive-match state, and last tri-state evaluation. Do not treat `unknown` as false.

### `set_composite_alert_rule_enabled`

Enable or disable one composite rule without deleting its expression, evaluations, or delivery history. Use only at the user's request.

### `run_alert_rules_once`

Fetch configured providers, evaluate enabled single and composite rules, and potentially send Enterprise WeChat on a new threshold crossing or an explicitly enabled recovery. This can cause an external message. Composite rules reject a trigger when required evidence timestamps exceed their configured skew.

### `test_enterprise_wechat`

Send one labelled test message. Require explicit user intent because this is an external side effect.

## Public Steam inventory

### `check_public_inventory`

Fetch one 17-digit SteamID64, append a complete public snapshot, and compare only with the previous successful complete snapshot. The first success is a baseline. Notification is disabled unless explicitly requested.

### `query_latest_inventory`

Read the latest successful local snapshot without a new Steam request. Include snapshot time and mention when returned rows are limited.

### `query_latest_inventory_valuation`

Read the latest saved BUFF base-category valuation without a new Steam or market request. Report inventory snapshot time, price observation time, price and category coverage, known subtotal, inventory-composition delta, market-price delta, and limitations. Never treat unknown prices as zero or include unverified float, pattern, sticker, or name-tag premiums.

### `rank_local_inventory_holders`

Rank an exact item across each locally monitored SteamID's latest successful snapshot. Always state account/snapshot coverage.

### `add_inventory_watch`

Add or re-enable local monitoring. Confirm SteamID, optional label, and interval; default is 30 minutes.

### `list_inventory_watches`

Read local scheduling state.

### `disable_inventory_watch`

Stop future checks without deleting snapshots or events. Use only at the user's request.

### `run_inventory_watches_once`

Check every enabled watch and potentially send Enterprise WeChat for observed changes. This can make network requests and send external messages.

## DIY catalog and recommendations

### `sync_diy_catalog`

Import a bounded CSQAQ catalog search subset. This persists local catalog identities and does not prove listing or ownership.

### `enrich_diy_catalog`

Fetch item details and cache/analyze provider images. Provider fields are observations; color and visual tags are local heuristics.

### `search_diy_catalog`

Read local skins and stickers. Use before recommendation to confirm the requested items exist locally.

### `recommend_diy_loadouts`

Generate transparent rule-based layouts from verified catalog items, style, optional budget, and local explicit feedback. Results are aesthetic proposals.

### `render_diy_preview`

Generate or accept a masked inspect code and ask SteamDT for a rendered result. Interpret the returned mode exactly: `steamdt_game_render`, `steamdt_pending`, or `inspect_code_only`.

### `record_diy_feedback`

Persist only explicit ratings, selection, liked/disliked tags, and comments. Never infer a rating from silence.

### `get_diy_preferences`

Read locally aggregated aesthetic preferences. This is not remote model training or telemetry.

## Failure handling

- If a tool returns `isError`, explain its safe error message and do not synthesize values.
- Use `health_check` when configuration may be missing.
- Do not retry rate-limited calls aggressively.
- Do not replace an unavailable tool with web memory or an unrelated provider without telling the user.
