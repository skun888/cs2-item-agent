# Market methodology

Use this baseline methodology for evidence-backed interpretation. Treat thresholds as provisional engineering rules until reviewed against market experience.

## Current quotes

- Exclude zero or missing sell prices from valid price comparisons.
- Prefer quotes updated within 24 hours; retain older positive values only as stale evidence.
- Mark a platform book as crossed when its bid exceeds its sell price. Exclude crossed bids from demand totals and highest-valid-bid conclusions.
- Treat listing and bid quantities as visible platform indicators, not unique global supply or demand.
- Keep all adapter observations separate. If sources disagree, show their adapter ids, timestamps, and difference instead of silently selecting or merging an answer.

## Historical indicators

- Calculate 24-hour, 7-day, 14-day, and 30-day returns from the closest point at or before each target time.
- Estimate daily volatility from interval log-return standard deviation and the dominant interval; mention sampling gaps.
- Calculate 30-day maximum drawdown and the latest close's percentile among 30-day closes.
- Label an uptrend only when 7-day return is at least +3% and latest close is at or above the 7-day average.
- Label a downtrend only when 7-day return is at most -3% and latest close is at or below the 7-day average.
- Otherwise label the series sideways.
- Compute relative strength as item 7-day return minus broad-market 7-day return for the same K-line type. Report unknown if either side lacks seven days.

## Price and visible quantity combinations

Use these as hypotheses, never proofs:

| Observation | Possible interpretation | Important alternative |
|---|---|---|
| Price up, listings down | visible supply absorbed | sellers withdrew listings |
| Price up, listings up | new supply follows strength | broader participation |
| Price down, listings up | visible selling pressure | stale or duplicated listings |
| Price down, listings down | thin/retreating market | bargain absorption |
| Bid rises faster than listing | demand may be strengthening | crossed or shallow book |
| Price rises without bid support | fragile markup | delayed bid updates |

Require repeated observations before calling a divergence persistent.

## Liquidity and paper gains

- Do not use price return alone as liquidity evidence.
- Prefer turnover, visible bid depth, spread, listing count, and update freshness when available.
- When real transaction volume is missing, explicitly say liquidity remains partially unknown.
- Distinguish a displayed mark-to-market gain from an executable exit after fees, balance discount, settlement rules, and the seven-day trade lock.

## Holder and supply risk

- Use CSQAQ holder results only within provider-monitored coverage and local rankings only within the user's snapshots.
- Treat Top 1/5/10 shares as concentration indicators, not proof of control or manipulation.
- Rising provider-defined survival quantity can reflect monitoring expansion or item movement as well as issuance; preserve the provider definition.
- Never substitute provider-defined nominal supply for effective circulating supply. Accept a user-confirmed effective-float estimate only with a source label, date when available, and preferably low/central/high values.
- When calculating monitored Top 10 quantity as a share of estimated effective float, label the numerator as the CSQAQ observed sample and the denominator as an expert estimate. It is not global concentration.

## Sector and dealer context

- Use `list_market_sectors` to resolve the provider id/key and current value; use `get_sector_kline` for comparable 7/15/30-day returns. A current daily change is not a 15-day sector return.
- Treat a zero/absent sector `volume` series as missing transaction volume. It does not prove that the sector had zero trades.
- Compare an item with the named same-level sector before attributing the full move to the item. Show mismatched time windows instead of silently treating 14-day and 15-day returns as identical.
- Store statements such as “大商推动” or “适合反复运作” as expert annotations unless direct inventory/order evidence exists.
- Never upgrade price shape alone into confirmed accumulation, washout, distribution, or manipulation.

## Trade-up relationships

- Use `sync_tradeup_catalog` in bounded batches to build local SQLite data, then `analyze_tradeup_relationship` for same-collection adjacent rarity tiers.
- A local collection match proves catalog structure only. Require `relationship.eligible=true` before using adjacent tiers. Use the returned `contractInputCount`: every step from Consumer through Covert uses ten inputs, while Covert-to-rare-special uses five. Never force knives/gloves or special mechanics into the ten-item formula.
- Souvenir items are eligible inputs under the Valve 2026-05-20 rule, but souvenir attributes are removed and the result is normal quality. Prefer a mapped base collection for the output pool. If `outputCatalogStatus=base_collection_required`, keep outputs and expected value unknown; never substitute souvenir output prices.
- Keep regular, StatTrak, and souvenir quality classes separate when building an outcome basket.
- Treat the analyzed item as an input, output, or both within a collection graph.
- A higher-tier basket can support lower-tier demand only when its weighted outcome value, material cost, wear constraints, fees, and executable depth make the contract attractive.
- Require output probabilities to sum to 1 before calculating expected value. Do not auto-normalize an incomplete basket.
- A static positive expected value is a possible consumption incentive, not proof that contracts are being executed or that the input must rise.

## Segment context

Do not apply one story to every segment:

- Cases depend on opening demand, drop/supply policy, and expected-value narratives.
- Collections depend on acquisition route, trade-up demand, and remaining supply.
- Stickers depend on application consumption, tournament/team/player themes, and craft demand.
- Pattern, float, souvenir, and stickered items require item-level premiums not represented by a category floor.

If event timing, game updates, drop policy, or community catalysts are not present in tool evidence, label them unknown rather than recalling them from memory.

## Decision route

Use `analyze_market_trading` for a broad market-trading decision. Present verified observations, calculations, expert annotations, support signals, risks, unknowns, and invalidation conditions separately. `analyze_item_decision` is a compatibility alias. Use `analyze_market_item` only when the user wants the technical market layer without holder/supply or expert context.
