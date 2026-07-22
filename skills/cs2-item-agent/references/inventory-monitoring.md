# Public inventory and holder monitoring

## State handling

- `public`: a complete public inventory was observed and may become a snapshot.
- `private_or_unavailable`: privacy or access prevented a complete observation; report unknown.
- `rate_limited`: Steam rejected the request frequency; report unknown and retry later.
- `temporary_failure`: network, HTTP, pagination, or response-contract failure; report unknown.

Only compare two complete `public` snapshots. Never compare a failed check with a successful snapshot.

If Steam Community is unreachable on a restricted network, tell the user to configure their own local HTTP proxy through `STEAM_PROXY_URL`. Never request proxy credentials or print the configured proxy URL.

## Fresh observation versus local read

- Use `check_public_inventory` when the user asks about the inventory now or requests a new observation.
- Use `query_latest_inventory` when the user asks what the local database last observed or wants item details without another Steam request.
- Use `query_latest_inventory_valuation` when the user asks for the last saved inventory estimate or a high-value-change explanation without another network request.
- State the snapshot time. A local snapshot can be accurate historically while stale now.

## Change language

Translate `observed_added`, `observed_removed`, and `quantity_changed` as “在两次成功公开快照之间观察到新增/消失/数量变化”. Do not translate them as bought, sold, deposited, withdrawn, or transferred without direct transaction evidence.

`assetid` helps compare adjacent snapshots within one account. Do not assume it is a permanent cross-account item identity. Preserve wear, pattern, finish, float32 wear bits, and the derived fingerprint when present. Treat a fingerprint as a matching clue, not proof of transfer or global uniqueness.

## Two holder-ranking scopes

### CSQAQ monitored coverage

Use `get_csqaq_holder_ranking` when the user asks who holds an item across CSQAQ's monitored public-account sample. Report:

- provider coverage wording;
- returned holder count and Top 1/5/10 concentration;
- observation time and limitations;
- that it is not a complete Steam-wide census.

### User's local coverage

Use `rank_local_inventory_holders` only across SteamIDs already observed in the user's SQLite database. Report:

- exact `marketHashName`;
- latest successful snapshots covered;
- matching account count and quantities;
- snapshot time per account;
- that unmonitored, private, escrowed, and stale accounts are outside coverage.

Do not merge the two rankings as if they share a denominator. Use both only as separately scoped evidence.

## Valuation and high-value changes

- Value only complete successful public snapshots.
- The default basis is the BUFF lowest listing price for the exact `marketHashName`.
- Include all marketable inventory categories with an exact name; do not limit valuation to weapon skins.
- Missing prices remain unknown. Report `priceCoverage = priced quantity / eligible quantity` and category coverage.
- Do not estimate special pattern, extreme float, sticker, name-tag, or other instance premiums.
- Separate inventory-composition value change from market-price change. Never describe a pure price move as an item transfer.
- Base price at least ¥1,000 creates a local high-value item event, but does not by itself send a high-value notification.
- A total high-value inventory anomaly requires both an absolute inventory-composition change of at least ¥10,000 and a relative change of at least 20%, with at least 90% price coverage in both compared valuations.
- The thresholds describe deterministic alert rules, not financial risk guarantees.

## Monitoring actions

- Add a watch only when the user requests ongoing monitoring.
- Default to 30 minutes unless the user specifies another interval.
- Disabling a watch preserves history.
- Running all watches can send Enterprise WeChat when configured; require clear user intent.
- Do not claim continuous monitoring unless a local worker, NAS, computer, or server actually remains running.
