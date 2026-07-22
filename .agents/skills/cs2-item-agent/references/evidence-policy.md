# Evidence policy

## Evidence classes

### 已验证观察

Use only for a value directly returned by a named provider or observed in a complete public Steam inventory snapshot. Always include the provider and observation time. This verifies the observation, not execution at that price or future accuracy.

Examples:

- “SteamDT 在 14:30 观察到 BUFF 最低在售价为……”
- “14:30 的公开库存快照观察到该账号持有 3 件……”

### 确定性计算

Use for formula output derived from shown inputs: returns, drawdown, visible concentration, fees, break-even values, or seven-day scenarios. State the input source and adopted parameters. A correct calculation can still rest on incomplete market data.

### 有条件解释

Use when observations support more than one plausible explanation. State the reasoning and at least one material alternative.

Example: “价格上升且可见在售量下降，可能表示买盘吸收，也可能包含撤单；缺少真实成交量，不能确认需求增强。”

### 未知

Use when data is missing, private, friends-only, stale, conflicting, rate-limited, outside coverage, or structurally unavailable. Never turn unknown into zero, unchanged, sold, safe, or irrelevant.

## Confidence

- Report confidence as evidence completeness and consistency.
- Do not translate a data-quality score into a probability of future price movement.
- Reduce confidence when sources differ materially, timestamps are far apart, history is insufficient, visible bids are crossed, or coverage is narrow.
- Preserve a tool's stated confidence and limitations; do not upgrade them in prose.

## Market boundaries

- A lowest listing is not a completed transaction.
- A visible bid is not guaranteed executable depth.
- A K-line without real transaction volume cannot prove liquidity or accumulation.
- Cross-platform listing and bid totals can contain duplicated economic exposure.
- A pre-fee spread is not profit.
- Historical behavior supports scenarios, not forecasts.
- Holder concentration inside CSQAQ coverage or local snapshots is not global concentration.

## Inventory boundaries

- Compare only complete successful public snapshots.
- A disappearance can mean transfer, listing, escrow, privacy change, data drift, or another state change; it does not prove a sale.
- `assetid` is useful within adjacent observations but is not assumed to be a permanent cross-account identifier.
- A composite fingerprint can connect observations; it cannot discover an unknown SteamID or reverse into an owner.

## Required refusals

Refuse or reframe unsupported claims such as “必涨”, “稳赚”, “已卖出”, “庄家正在出货”, “全网最大持有人”, “完整历任持有人”, or “这是同一个人”. Replace them with scoped, time-bounded statements and identify what evidence would be required.
