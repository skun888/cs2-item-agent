# Hanging and seven-day analysis

## Required sequence

1. Before calling a hanging tool, ask whether the user wants **Steam balance** or **platform balance**. Stop if unresolved; never infer it from “挂刀”.
2. Call `show_hanging_fee_assumptions` and retain its source and complete template.
3. For a list request, call `screen_hanging_candidates` with explicit `targetBalance`, price range, platform, route modes, and turnover threshold.
4. For each serious candidate, call `assess_hanging_candidate` with matching filters plus K-line platform/type.
5. Rank by evidence quality and defensive downside, not the largest displayed spread.

Keep `model.type=hanging_execution`. Do not add market-trading signals to its status. Cases are preferred and high-turnover ordinary weapon skins are eligible. Stickers, patches, knives, gloves, and unknown categories stay outside the automatic pool. An explicitly requested excluded item may be calculated, but cannot be promoted to a default candidate.

## Two independent routes

- `targetBalance=steam`: buy on BUFF/YYYP, then after the lock sell on Steam by listing or highest bid. Rank by Steam balance received per RMB purchase cost. This is not cash profit.
- `targetBalance=platform`: acquire Steam balance with a USD card, buy on Steam by listing or buy order, then after the lock sell on BUFF/YYYP by listing or highest bid. Rank by platform net proceeds versus RMB card cost.
- Never compare or merge the two route ratios. Repeat the selected route in the answer.
- Platform-balance reports must show the CSQAQ daily card price and time, configured Steam CNY/USD reference rate, destination-platform sale fee, and risk buffer.
- If the daily card price is absent or stale, keep the platform-balance result unknown. Do not borrow the Steam-balance formula or silently use an old card quote.

## Route modes

- Steam exit `highest_bid`: immediate visible highest-bid reference after the lock; conservative but future depth is not guaranteed.
- Steam exit `listing`: lowest-listing reference; adds execution time and undercut risk.
- Steam buy `listing`: acquire from a visible Steam listing.
- Steam buy `buy_order`: acquire through a Steam buy order; execution time and fill probability remain unknown.
- Platform exit `highest_bid`: sell into the visible domestic bid.
- Platform exit `listing`: list on the domestic platform; adds execution and undercut risk.

State the selected modes. Do not silently switch them to improve a result.

Reject abnormal provider quotes before ranking. A domestic bid materially above the same platform's lowest listing can be invalid, manipulated, or non-executable. If it breaches the local sanity threshold, return `insufficient_data` rather than a candidate.

## Seven-day scenarios

Defensive, base, and optimistic outputs are formula scenarios derived from historical price behavior and current inputs. They are not forecasts. Show:

- target balance and complete funds route;
- entry and exit modes and reference prices;
- all adopted fees, reference rates, and daily card price where applicable;
- defensive/base/optimistic net outcomes;
- turnover, price-sanity checks, missing real volume, and execution limitations.

Use “可考虑 / 继续观察 / 不建议 / 无法判断” based on the shown checks. Never say “七天后一定能卖到” or “稳赚”. Never execute a trade.
