import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Evidence } from "../domain/evidence.js";
import type { SteamInventoryFetchResult, SteamInventoryAsset } from "../adapters/steam-inventory/types.js";
import {
  diffInventorySnapshots,
  summarizeCategoryChanges,
  type InventoryPersistenceResult,
  type InventoryHolderRankEntry,
  type InventoryWatch,
  type StoredInventorySnapshot,
} from "../domain/inventory-monitor.js";
import type { MarketAnalysisReport } from "../domain/market-analysis.js";
import type {
  HighValueInventoryEvent,
  InventoryValuationSnapshot,
} from "../domain/inventory-valuation.js";
import type { NormalizedMarketQuote } from "../domain/market-quote.js";
import type {
  CreateMarketAlertRuleInput,
  MarketAlertEvaluation,
  MarketAlertRule,
} from "../domain/alerts.js";
import type {
  CompositeAlertEvaluation,
  CompositeAlertRule,
  CompositeAlertPreview,
} from "../domain/composite-alerts.js";
import type { SteamDtPriceEntry } from "../adapters/steamdt/types.js";
import type { SteamDtKlinePoint } from "../adapters/steamdt/types.js";
import type {
  CsQaqCollection,
  CsQaqCollectionItem,
  CsQaqMarketHomeData,
  CsQaqSectorIndex,
  CsQaqSectorKlinePoint,
} from "../adapters/csqaq/types.js";
import { normalizeRarityRank } from "../domain/tradeup-catalog.js";
import type {
  DiyCatalogItem,
  DiyFeedbackInput,
  DiyPreferenceProfile,
  DiyRecipe,
  DiyStyle,
} from "../domain/diy.js";
import { MIGRATIONS } from "./migrations.js";

export class AppDatabase {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON;");
    if (path !== ":memory:") this.#database.exec("PRAGMA journal_mode = WAL;");
  }

  migrate(): readonly number[] {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    const appliedRows = this.#database.prepare("SELECT version FROM schema_migrations").all();
    const applied = new Set(appliedRows.map((row) => Number(row.version)));
    const newlyApplied: number[] = [];

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.#database.exec("BEGIN IMMEDIATE;");
      try {
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)",
          )
          .run(migration.version, migration.name, new Date().toISOString());
        this.#database.exec("COMMIT;");
        newlyApplied.push(migration.version);
      } catch (error) {
        this.#database.exec("ROLLBACK;");
        throw error;
      }
    }
    return newlyApplied;
  }

  savePriceEvidence(
    marketHashName: string,
    evidence: Evidence<readonly SteamDtPriceEntry[]>,
  ): number {
    this.migrate();
    const itemId = this.#upsertMarketItem(marketHashName, evidence.observedAt);
    const insert = this.#database.prepare(`
      INSERT INTO market_snapshots(
        market_item_id, source, platform, sell_price, sell_count,
        bidding_price, bidding_count, source_updated_at, observed_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const entry of evidence.data) {
        insert.run(
          itemId,
          evidence.source,
          entry.platform,
          entry.sellPrice ?? null,
          entry.sellCount ?? null,
          entry.biddingPrice ?? null,
          entry.biddingCount ?? null,
          toIsoTimestamp(entry.updateTime),
          evidence.observedAt,
          JSON.stringify(entry.raw),
        );
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return evidence.data.length;
  }

  saveNormalizedMarketQuotes(quotes: readonly NormalizedMarketQuote[]): number {
    this.migrate();
    const insert = this.#database.prepare(`
      INSERT INTO market_snapshots(
        market_item_id, source, platform, sell_price, sell_count,
        bidding_price, bidding_count, source_updated_at, observed_at, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const quote of quotes) {
        const itemId = this.#upsertMarketItem(quote.marketHashName, quote.observedAt);
        insert.run(
          itemId,
          quote.source,
          quote.platform,
          quote.sellPrice ?? null,
          quote.sellCount ?? null,
          quote.biddingPrice ?? null,
          quote.biddingCount ?? null,
          quote.observedAt,
          quote.observedAt,
          JSON.stringify({
            provider: quote.provider,
            ...(quote.providerItemId ? { providerItemId: quote.providerItemId } : {}),
          }),
        );
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return quotes.length;
  }

  saveKlineEvidence(
    marketHashName: string,
    platform: string,
    type: number,
    evidence: Evidence<readonly SteamDtKlinePoint[]>,
  ): void {
    this.migrate();
    const itemId = this.#upsertMarketItem(marketHashName, evidence.observedAt);
    this.#database
      .prepare(`
        INSERT INTO kline_observations(
          market_item_id, source, platform, kline_type, observed_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        itemId,
        evidence.source,
        platform,
        type,
        evidence.observedAt,
        JSON.stringify(evidence.data.map((point) => point.raw)),
      );
  }

  saveBroadKlineEvidence(
    type: number,
    evidence: Evidence<readonly SteamDtKlinePoint[]>,
  ): void {
    this.migrate();
    this.#database
      .prepare(`
        INSERT INTO broad_kline_observations(source, kline_type, observed_at, raw_json)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        evidence.source,
        type,
        evidence.observedAt,
        JSON.stringify(evidence.data.map((point) => point.raw)),
      );
  }

  saveAnalysisReport(report: MarketAnalysisReport): void {
    this.migrate();
    const itemId = this.#upsertMarketItem(report.marketHashName, report.generatedAt);
    this.#database
      .prepare(`
        INSERT INTO market_analysis_reports(
          market_item_id, platform, kline_type, generated_at, confidence, report_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        itemId,
        report.query.platform,
        report.query.klineType,
        report.generatedAt,
        report.dataQuality.confidence,
        JSON.stringify(report),
      );
  }

  getLatestPriceEvidence(
    marketHashName: string,
  ): Evidence<readonly SteamDtPriceEntry[]> | undefined {
    this.migrate();
    const batch = this.#database
      .prepare(`
        SELECT MAX(ms.observed_at) AS observed_at
        FROM market_snapshots ms
        JOIN market_items mi ON mi.id = ms.market_item_id
        WHERE mi.market_hash_name = ? AND ms.source LIKE 'steamdt:%'
      `)
      .get(marketHashName) as Readonly<Record<string, unknown>> | undefined;
    if (!batch || typeof batch.observed_at !== "string") return undefined;

    const rows = this.#database
      .prepare(`
        SELECT ms.source, ms.platform, ms.sell_price, ms.sell_count,
               ms.bidding_price, ms.bidding_count, ms.source_updated_at, ms.raw_json
        FROM market_snapshots ms
        JOIN market_items mi ON mi.id = ms.market_item_id
        WHERE mi.market_hash_name = ? AND ms.observed_at = ? AND ms.source LIKE 'steamdt:%'
        ORDER BY ms.id
      `)
      .all(marketHashName, batch.observed_at);
    if (rows.length === 0) return undefined;

    const entries = rows.map((row): SteamDtPriceEntry => {
      const raw = parseRawRecord(row.raw_json);
      return {
        platform: String(row.platform),
        raw,
        ...(typeof raw.platformItemId === "string" || typeof raw.platformItemId === "number"
          ? { platformItemId: String(raw.platformItemId) }
          : {}),
        ...(typeof row.sell_price === "number" ? { sellPrice: row.sell_price } : {}),
        ...(typeof row.sell_count === "number" ? { sellCount: row.sell_count } : {}),
        ...(typeof row.bidding_price === "number" ? { biddingPrice: row.bidding_price } : {}),
        ...(typeof row.bidding_count === "number" ? { biddingCount: row.bidding_count } : {}),
        ...(typeof raw.updateTime === "number" ? { updateTime: raw.updateTime } : {}),
      };
    });
    return {
      source: typeof rows[0]?.source === "string" ? rows[0].source : "local:market-snapshot",
      observedAt: batch.observed_at,
      confidence: "verified_source",
      limitations: ["Loaded from a previous local provider snapshot for change comparison."],
      data: entries,
    };
  }

  saveInventoryFetchResult(result: SteamInventoryFetchResult): InventoryPersistenceResult {
    this.migrate();
    const previous = result.status === "public" && result.complete
      ? this.getLatestInventorySnapshot(result.steamId)
      : undefined;
    const events = previous
      ? diffInventorySnapshots(previous, result.assets, result.observedAt)
      : [];
    const categoryChanges = previous
      ? summarizeCategoryChanges(previous, result.assets)
      : [];

    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const checkRun = this.#database
        .prepare(`
          INSERT INTO inventory_checks(
            steam_id, source, status, http_status, observed_at, asset_count,
            total_inventory_count, page_count, complete, message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          result.steamId,
          result.source,
          result.status,
          result.httpStatus ?? null,
          result.observedAt,
          result.status === "public" ? result.assets.length : null,
          result.totalInventoryCount ?? null,
          result.pageCount,
          result.complete ? 1 : 0,
          result.message ?? null,
        );
      const checkId = Number(checkRun.lastInsertRowid);
      let snapshotId: number | undefined;

      if (result.status === "public" && result.complete) {
        const snapshotRun = this.#database
          .prepare(`
            INSERT INTO inventory_snapshots(
              check_id, steam_id, source, observed_at, total_inventory_count, page_count, complete
            ) VALUES (?, ?, ?, ?, ?, ?, 1)
          `)
          .run(
            checkId,
            result.steamId,
            result.source,
            result.observedAt,
            result.totalInventoryCount ?? null,
            result.pageCount,
          );
        snapshotId = Number(snapshotRun.lastInsertRowid);
        const insertAsset = this.#database.prepare(`
          INSERT INTO inventory_assets(
            snapshot_id, asset_id, class_id, instance_id, context_id, amount,
            market_hash_name, display_name, item_type, tradable, marketable,
            commodity, inspect_link, icon_url, paint_seed, paint_wear, paint_wear_bits,
            paint_index, name_tag, charm_template, item_certificate,
            observation_fingerprint, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const asset of result.assets) {
          insertAsset.run(
            snapshotId,
            asset.assetId,
            asset.classId,
            asset.instanceId,
            asset.contextId,
            asset.amount,
            asset.marketHashName ?? null,
            asset.displayName ?? null,
            asset.itemType ?? null,
            toSqlBoolean(asset.tradable),
            toSqlBoolean(asset.marketable),
            toSqlBoolean(asset.commodity),
            asset.inspectLink ?? null,
            asset.iconUrl ?? null,
            asset.paintSeed ?? null,
            asset.paintWear ?? null,
            asset.paintWearBits ?? null,
            asset.paintIndex ?? null,
            asset.nameTag ?? null,
            asset.charmTemplate ?? null,
            asset.itemCertificate ?? null,
            asset.observationFingerprint ?? null,
            JSON.stringify(asset.raw),
          );
        }

        const insertEvent = this.#database.prepare(`
          INSERT INTO inventory_events(
            steam_id, event_type, asset_id, market_hash_name, display_name,
            quantity_before, quantity_after, previous_observed_at, observed_at, evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const event of events) {
          insertEvent.run(
            result.steamId,
            event.eventType,
            event.assetId,
            event.marketHashName ?? null,
            event.displayName ?? null,
            event.quantityBefore,
            event.quantityAfter,
            event.previousObservedAt,
            event.observedAt,
            JSON.stringify({
              source: result.source,
              status: result.status,
              previousObservedAt: event.previousObservedAt,
              observedAt: event.observedAt,
              limitation: "Observed inventory change does not prove a purchase, sale, or counterparty.",
            }),
          );
        }
      }

      this.#database.exec("COMMIT;");
      return {
        checkId,
        ...(snapshotId !== undefined ? { snapshotId } : {}),
        baselineCreated: result.status === "public" && result.complete && previous === undefined,
        ...(previous ? { previousObservedAt: previous.observedAt } : {}),
        events,
        categoryChanges,
      };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  getLatestInventorySnapshot(steamId: string): StoredInventorySnapshot | undefined {
    this.migrate();
    const snapshot = this.#database
      .prepare(`
        SELECT id, steam_id, observed_at, total_inventory_count
        FROM inventory_snapshots
        WHERE steam_id = ? AND complete = 1
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      `)
      .get(steamId) as Readonly<Record<string, unknown>> | undefined;
    if (!snapshot || typeof snapshot.id !== "number" || typeof snapshot.observed_at !== "string") {
      return undefined;
    }
    const assets = this.#database
      .prepare(`
        SELECT asset_id, class_id, instance_id, context_id, amount, market_hash_name,
               display_name, item_type, tradable, marketable, commodity, inspect_link,
               icon_url, paint_seed, paint_wear, paint_wear_bits, paint_index,
               name_tag, charm_template, item_certificate, observation_fingerprint, raw_json
        FROM inventory_assets
        WHERE snapshot_id = ?
        ORDER BY id
      `)
      .all(snapshot.id)
      .map(storedAssetFromRow);
    return {
      id: snapshot.id,
      steamId,
      observedAt: snapshot.observed_at,
      ...(typeof snapshot.total_inventory_count === "number"
        ? { totalInventoryCount: snapshot.total_inventory_count }
        : {}),
      assets,
    };
  }

  rankInventoryHolders(
    marketHashName: string,
    limit: number,
  ): {
    readonly latestSuccessfulSnapshots: number;
    readonly holders: readonly InventoryHolderRankEntry[];
  } {
    this.migrate();
    const snapshotCount = this.#database
      .prepare("SELECT COUNT(DISTINCT steam_id) AS count FROM inventory_snapshots WHERE complete = 1")
      .get() as { count: number };
    const rows = this.#database
      .prepare(`
        WITH ranked_snapshots AS (
          SELECT id, steam_id, observed_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY steam_id ORDER BY observed_at DESC, id DESC
                 ) AS row_number
          FROM inventory_snapshots
          WHERE complete = 1
        ), latest AS (
          SELECT id, steam_id, observed_at
          FROM ranked_snapshots
          WHERE row_number = 1
        )
        SELECT latest.steam_id, watches.label, latest.observed_at,
               SUM(assets.amount) AS quantity, COUNT(*) AS asset_count
        FROM latest
        JOIN inventory_assets assets ON assets.snapshot_id = latest.id
        LEFT JOIN inventory_watches watches ON watches.steam_id = latest.steam_id
        WHERE LOWER(assets.market_hash_name) = LOWER(?)
        GROUP BY latest.steam_id, watches.label, latest.observed_at
        ORDER BY quantity DESC, asset_count DESC, latest.steam_id
        LIMIT ?
      `)
      .all(marketHashName, limit);
    return {
      latestSuccessfulSnapshots: snapshotCount.count,
      holders: rows.map((row): InventoryHolderRankEntry => ({
        steamId: String(row.steam_id),
        ...(typeof row.label === "string" ? { label: row.label } : {}),
        quantity: Number(row.quantity),
        assetCount: Number(row.asset_count),
        observedAt: String(row.observed_at),
      })),
    };
  }

  upsertInventoryWatch(
    steamId: string,
    options: { readonly label?: string; readonly intervalMinutes: number; readonly now: string },
  ): InventoryWatch {
    this.migrate();
    this.#database
      .prepare(`
        INSERT INTO inventory_watches(
          steam_id, label, enabled, interval_minutes, created_at, updated_at, next_check_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(steam_id) DO UPDATE SET
          label = excluded.label,
          enabled = 1,
          interval_minutes = excluded.interval_minutes,
          updated_at = excluded.updated_at,
          next_check_at = CASE
            WHEN inventory_watches.enabled = 0 THEN excluded.next_check_at
            ELSE inventory_watches.next_check_at
          END
      `)
      .run(
        steamId,
        options.label ?? null,
        options.intervalMinutes,
        options.now,
        options.now,
        options.now,
      );
    const watch = this.getInventoryWatch(steamId);
    if (!watch) throw new Error("Failed to resolve inventory watch after upsert.");
    return watch;
  }

  getInventoryWatch(steamId: string): InventoryWatch | undefined {
    this.migrate();
    const row = this.#database
      .prepare("SELECT * FROM inventory_watches WHERE steam_id = ?")
      .get(steamId) as Readonly<Record<string, unknown>> | undefined;
    return row ? inventoryWatchFromRow(row) : undefined;
  }

  listInventoryWatches(enabledOnly = false): readonly InventoryWatch[] {
    this.migrate();
    const rows = this.#database
      .prepare(`
        SELECT * FROM inventory_watches
        ${enabledOnly ? "WHERE enabled = 1" : ""}
        ORDER BY created_at, steam_id
      `)
      .all();
    return rows.map(inventoryWatchFromRow);
  }

  listDueInventoryWatches(at: string): readonly InventoryWatch[] {
    this.migrate();
    return this.#database
      .prepare(`
        SELECT * FROM inventory_watches
        WHERE enabled = 1 AND (next_check_at IS NULL OR next_check_at <= ?)
        ORDER BY COALESCE(next_check_at, created_at), steam_id
      `)
      .all(at)
      .map(inventoryWatchFromRow);
  }

  setInventoryWatchEnabled(steamId: string, enabled: boolean, now: string): boolean {
    this.migrate();
    const run = this.#database
      .prepare(`
        UPDATE inventory_watches
        SET enabled = ?, updated_at = ?, next_check_at = CASE WHEN ? = 1 THEN ? ELSE next_check_at END
        WHERE steam_id = ?
      `)
      .run(enabled ? 1 : 0, now, enabled ? 1 : 0, now, steamId);
    return run.changes > 0;
  }

  markInventoryWatchChecked(steamId: string, observedAt: string): void {
    this.migrate();
    const watch = this.getInventoryWatch(steamId);
    if (!watch) return;
    const nextCheckAt = new Date(
      new Date(observedAt).valueOf() + watch.intervalMinutes * 60_000,
    ).toISOString();
    this.#database
      .prepare(`
        UPDATE inventory_watches
        SET last_checked_at = ?, next_check_at = ?, updated_at = ?
        WHERE steam_id = ?
      `)
      .run(observedAt, nextCheckAt, observedAt, steamId);
  }

  saveNotificationDelivery(input: {
    readonly steamId: string;
    readonly channel: string;
    readonly eventCount: number;
    readonly status: "sent" | "failed";
    readonly attemptedAt: string;
    readonly attemptCount?: number;
    readonly message?: string;
  }): void {
    this.migrate();
    this.#database
      .prepare(`
        INSERT INTO notification_deliveries(
          steam_id, channel, event_count, status, attempted_at, message, attempt_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.steamId,
        input.channel,
        input.eventCount,
        input.status,
        input.attemptedAt,
        input.message ?? null,
        input.attemptCount ?? 1,
      );
  }

  saveInventoryValuation(
    valuation: InventoryValuationSnapshot,
    highValueEvents: readonly HighValueInventoryEvent[] = [],
  ): InventoryValuationSnapshot {
    this.migrate();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const run = this.#database.prepare(`
        INSERT INTO inventory_valuations(
          snapshot_id, steam_id, provider, platform, inventory_observed_at, valued_at,
          eligible_quantity, priced_quantity, unknown_quantity, eligible_category_count,
          priced_category_count, price_coverage, category_coverage, known_subtotal,
          previous_valuation_id, previous_known_subtotal, composition_delta,
          composition_delta_rate, market_price_delta, high_value_event_count,
          high_value_alert_eligible, limitations_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        valuation.snapshotId,
        valuation.steamId,
        valuation.provider,
        valuation.platform,
        valuation.inventoryObservedAt,
        valuation.valuedAt,
        valuation.eligibleQuantity,
        valuation.pricedQuantity,
        valuation.unknownQuantity,
        valuation.eligibleCategoryCount,
        valuation.pricedCategoryCount,
        valuation.priceCoverage,
        valuation.categoryCoverage,
        valuation.knownSubtotal,
        valuation.previousValuationId ?? null,
        valuation.previousKnownSubtotal ?? null,
        valuation.compositionDelta ?? null,
        valuation.compositionDeltaRate ?? null,
        valuation.marketPriceDelta ?? null,
        valuation.highValueEventCount,
        valuation.highValueAlertEligible ? 1 : 0,
        JSON.stringify(valuation.limitations),
      );
      const valuationId = Number(run.lastInsertRowid);
      const insertItem = this.#database.prepare(`
        INSERT INTO inventory_valuation_items(
          valuation_id, market_hash_name, quantity, item_type, unit_price, known_value,
          price_observed_at, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of valuation.items) {
        insertItem.run(
          valuationId,
          item.marketHashName,
          item.quantity,
          item.itemType ?? null,
          item.unitPrice ?? null,
          item.knownValue ?? null,
          item.priceObservedAt ?? null,
          item.source ?? null,
        );
      }
      const insertEvent = this.#database.prepare(`
        INSERT INTO high_value_inventory_events(
          snapshot_id, steam_id, event_type, asset_id, market_hash_name,
          quantity_before, quantity_after, unit_price, estimated_delta, observed_at, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of highValueEvents) {
        insertEvent.run(
          valuation.snapshotId,
          valuation.steamId,
          event.eventType,
          event.assetId,
          event.marketHashName,
          event.quantityBefore,
          event.quantityAfter,
          event.unitPrice,
          event.estimatedDelta,
          event.observedAt,
          JSON.stringify({
            source: valuation.provider,
            platform: valuation.platform,
            unitPrice: event.unitPrice,
            limitation: "A public inventory difference does not prove a purchase, sale, or counterparty.",
          }),
        );
      }
      this.#database.exec("COMMIT;");
      return { ...valuation, id: valuationId };
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  getLatestInventoryValuation(
    steamId: string,
    beforeSnapshotId?: number,
  ): InventoryValuationSnapshot | undefined {
    this.migrate();
    const row = this.#database.prepare(`
      SELECT * FROM inventory_valuations
      WHERE steam_id = ? AND (? IS NULL OR snapshot_id < ?)
      ORDER BY inventory_observed_at DESC, id DESC
      LIMIT 1
    `).get(steamId, beforeSnapshotId ?? null, beforeSnapshotId ?? null) as Readonly<Record<string, unknown>> | undefined;
    if (!row || typeof row.id !== "number") return undefined;
    const items = this.#database.prepare(`
      SELECT market_hash_name, quantity, item_type, unit_price, known_value,
             price_observed_at, source
      FROM inventory_valuation_items
      WHERE valuation_id = ?
      ORDER BY known_value DESC, market_hash_name
    `).all(row.id).map((item): InventoryValuationSnapshot["items"][number] => ({
      marketHashName: String(item.market_hash_name),
      quantity: Number(item.quantity),
      ...(typeof item.item_type === "string" ? { itemType: item.item_type } : {}),
      ...(typeof item.unit_price === "number" ? { unitPrice: item.unit_price } : {}),
      ...(typeof item.known_value === "number" ? { knownValue: item.known_value } : {}),
      ...(typeof item.price_observed_at === "string" ? { priceObservedAt: item.price_observed_at } : {}),
      ...(typeof item.source === "string" ? { source: item.source } : {}),
    }));
    const limitations = parseStringArray(row.limitations_json);
    return {
      id: row.id,
      snapshotId: Number(row.snapshot_id),
      steamId: String(row.steam_id),
      provider: String(row.provider) as InventoryValuationSnapshot["provider"],
      platform: "BUFF",
      inventoryObservedAt: String(row.inventory_observed_at),
      valuedAt: String(row.valued_at),
      eligibleQuantity: Number(row.eligible_quantity),
      pricedQuantity: Number(row.priced_quantity),
      unknownQuantity: Number(row.unknown_quantity),
      eligibleCategoryCount: Number(row.eligible_category_count),
      pricedCategoryCount: Number(row.priced_category_count),
      priceCoverage: Number(row.price_coverage),
      categoryCoverage: Number(row.category_coverage),
      knownSubtotal: Number(row.known_subtotal),
      ...(typeof row.previous_valuation_id === "number" ? { previousValuationId: row.previous_valuation_id } : {}),
      ...(typeof row.previous_known_subtotal === "number" ? { previousKnownSubtotal: row.previous_known_subtotal } : {}),
      ...(typeof row.composition_delta === "number" ? { compositionDelta: row.composition_delta } : {}),
      ...(typeof row.composition_delta_rate === "number" ? { compositionDeltaRate: row.composition_delta_rate } : {}),
      ...(typeof row.market_price_delta === "number" ? { marketPriceDelta: row.market_price_delta } : {}),
      highValueEventCount: Number(row.high_value_event_count),
      highValueAlertEligible: Number(row.high_value_alert_eligible) === 1,
      items,
      limitations,
    };
  }

  getLatestCompleteInventoryObservedAt(steamId: string): string | undefined {
    this.migrate();
    const row = this.#database.prepare(`
      SELECT observed_at
      FROM inventory_snapshots
      WHERE steam_id = ? AND complete = 1
      ORDER BY observed_at DESC, id DESC
      LIMIT 1
    `).get(steamId) as Readonly<Record<string, unknown>> | undefined;
    return typeof row?.observed_at === "string" ? row.observed_at : undefined;
  }

  sumInventoryEventQuantity(input: {
    readonly steamId: string;
    readonly direction: "added" | "removed";
    readonly since: string;
    readonly until: string;
    readonly marketHashName?: string;
  }): number {
    this.migrate();
    const delta = input.direction === "added"
      ? "CASE WHEN quantity_after > quantity_before THEN quantity_after - quantity_before ELSE 0 END"
      : "CASE WHEN quantity_before > quantity_after THEN quantity_before - quantity_after ELSE 0 END";
    const row = this.#database.prepare(`
      SELECT COALESCE(SUM(${delta}), 0) AS quantity
      FROM inventory_events
      WHERE steam_id = ? AND observed_at > ? AND observed_at <= ?
        AND (? IS NULL OR LOWER(market_hash_name) = LOWER(?))
    `).get(
      input.steamId,
      input.since,
      input.until,
      input.marketHashName ?? null,
      input.marketHashName ?? null,
    ) as Readonly<Record<string, unknown>>;
    return Number(row.quantity);
  }

  countHighValueInventoryEvents(input: {
    readonly steamId: string;
    readonly direction: "added" | "removed";
    readonly since: string;
    readonly until: string;
    readonly marketHashName?: string;
  }): number {
    this.migrate();
    const eventType = input.direction === "added" ? "high_value_added" : "high_value_removed";
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM high_value_inventory_events
      WHERE steam_id = ? AND event_type = ? AND observed_at > ? AND observed_at <= ?
        AND (? IS NULL OR LOWER(market_hash_name) = LOWER(?))
    `).get(
      input.steamId,
      eventType,
      input.since,
      input.until,
      input.marketHashName ?? null,
      input.marketHashName ?? null,
    ) as Readonly<Record<string, unknown>>;
    return Number(row.count);
  }

  getMarketQuoteAtOrBefore(input: {
    readonly marketHashName: string;
    readonly platform: string;
    readonly provider: string;
    readonly targetAt: string;
  }): NormalizedMarketQuote | undefined {
    this.migrate();
    const row = this.#database.prepare(`
      SELECT ms.source, ms.platform, ms.sell_price, ms.sell_count,
             ms.bidding_price, ms.bidding_count, ms.source_updated_at, ms.observed_at
      FROM market_snapshots ms
      JOIN market_items mi ON mi.id = ms.market_item_id
      WHERE LOWER(mi.market_hash_name) = LOWER(?)
        AND UPPER(ms.platform) = UPPER(?)
        AND ms.source LIKE ?
        AND ms.observed_at <= ?
      ORDER BY ms.observed_at DESC, ms.id DESC
      LIMIT 1
    `).get(
      input.marketHashName,
      input.platform,
      `${input.provider}:%`,
      input.targetAt,
    ) as Readonly<Record<string, unknown>> | undefined;
    if (!row) return undefined;
    const observedAt = typeof row.source_updated_at === "string"
      ? row.source_updated_at
      : String(row.observed_at);
    return {
      marketHashName: input.marketHashName,
      platform: String(row.platform),
      provider: input.provider,
      source: String(row.source),
      observedAt,
      currency: "CNY",
      ...(typeof row.sell_price === "number" ? { sellPrice: row.sell_price } : {}),
      ...(typeof row.sell_count === "number" ? { sellCount: row.sell_count } : {}),
      ...(typeof row.bidding_price === "number" ? { biddingPrice: row.bidding_price } : {}),
      ...(typeof row.bidding_count === "number" ? { biddingCount: row.bidding_count } : {}),
    };
  }

  createCompositeAlertRule(
    input: CompositeAlertPreview["normalized"],
    now: string,
  ): CompositeAlertRule {
    this.migrate();
    const run = this.#database.prepare(`
      INSERT INTO composite_alert_rules(
        name, enabled, expression_json, cooldown_minutes, minimum_consecutive_matches,
        notify_on_recovery, max_data_skew_minutes, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.name,
      JSON.stringify(input.expression),
      input.cooldownMinutes,
      input.minimumConsecutiveMatches,
      input.notifyOnRecovery ? 1 : 0,
      input.maxDataSkewMinutes,
      now,
      now,
    );
    const rule = this.getCompositeAlertRule(Number(run.lastInsertRowid));
    if (!rule) throw new Error("Failed to resolve composite alert rule after insert.");
    return rule;
  }

  getCompositeAlertRule(id: number): CompositeAlertRule | undefined {
    this.migrate();
    const row = this.#database.prepare("SELECT * FROM composite_alert_rules WHERE id = ?").get(id) as
      Readonly<Record<string, unknown>> | undefined;
    return row ? compositeAlertRuleFromRow(row) : undefined;
  }

  listCompositeAlertRules(enabledOnly = false): readonly CompositeAlertRule[] {
    this.migrate();
    return this.#database.prepare(`
      SELECT * FROM composite_alert_rules
      ${enabledOnly ? "WHERE enabled = 1" : ""}
      ORDER BY created_at, id
    `).all().map(compositeAlertRuleFromRow);
  }

  setCompositeAlertRuleEnabled(id: number, enabled: boolean, now: string): boolean {
    this.migrate();
    const run = this.#database.prepare(`
      UPDATE composite_alert_rules SET enabled = ?, updated_at = ? WHERE id = ?
    `).run(enabled ? 1 : 0, now, id);
    return run.changes > 0;
  }

  recordCompositeAlertEvaluation(
    rule: CompositeAlertRule,
    evaluation: CompositeAlertEvaluation,
    input: {
      readonly outcome: string;
      readonly conditionState?: boolean;
      readonly preserveConditionState?: boolean;
      readonly consecutiveMatches: number;
      readonly triggeredAt?: string;
    },
  ): void {
    this.migrate();
    const conditionState = input.preserveConditionState
      ? rule.lastConditionState
      : input.conditionState;
    const fingerprint = input.triggeredAt
      ? evaluation.evidenceFingerprint
      : conditionState ? rule.lastEvidenceFingerprint : undefined;
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare(`
        INSERT INTO composite_alert_evaluations(
          rule_id, status, condition_state, consecutive_matches, evaluated_at,
          evidence_fingerprint, evaluation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        rule.id,
        input.outcome,
        conditionState === undefined ? null : conditionState ? 1 : 0,
        input.consecutiveMatches,
        evaluation.evaluatedAt,
        evaluation.evidenceFingerprint,
        JSON.stringify(evaluation),
      );
      this.#database.prepare(`
        UPDATE composite_alert_rules
        SET last_evaluated_at = ?, last_condition_state = ?, consecutive_matches = ?,
            last_triggered_at = ?, last_evidence_fingerprint = ?, updated_at = ?
        WHERE id = ?
      `).run(
        evaluation.evaluatedAt,
        conditionState === undefined ? null : conditionState ? 1 : 0,
        input.consecutiveMatches,
        input.triggeredAt ?? rule.lastTriggeredAt ?? null,
        fingerprint ?? null,
        evaluation.evaluatedAt,
        rule.id,
      );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  saveCompositeAlertDelivery(input: {
    readonly ruleId: number;
    readonly deliveryType: "trigger" | "recovery";
    readonly channel: string;
    readonly evidenceFingerprint: string;
    readonly status: "sent" | "failed" | "skipped";
    readonly attemptCount: number;
    readonly createdAt: string;
    readonly attemptedAt: string;
    readonly sentAt?: string;
    readonly errorMessage?: string;
  }): void {
    this.migrate();
    this.#database.prepare(`
      INSERT INTO composite_alert_deliveries(
        rule_id, delivery_type, channel, evidence_fingerprint, status, attempt_count,
        created_at, attempted_at, sent_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rule_id, delivery_type, channel, evidence_fingerprint) DO UPDATE SET
        status = excluded.status, attempt_count = excluded.attempt_count,
        attempted_at = excluded.attempted_at, sent_at = excluded.sent_at,
        error_message = excluded.error_message
    `).run(
      input.ruleId,
      input.deliveryType,
      input.channel,
      input.evidenceFingerprint,
      input.status,
      input.attemptCount,
      input.createdAt,
      input.attemptedAt,
      input.sentAt ?? null,
      input.errorMessage ?? null,
    );
  }

  createMarketAlertRule(
    input: Required<Omit<CreateMarketAlertRuleInput, "name">> & { readonly name?: string },
    now: string,
  ): MarketAlertRule {
    this.migrate();
    const run = this.#database
      .prepare(`
        INSERT INTO alert_rules(
          rule_type, name, enabled, market_hash_name, platform, provider,
          metric, operator, threshold, cooldown_minutes, created_at, updated_at
        ) VALUES ('market_threshold', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.name ?? null,
        input.marketHashName,
        input.platform,
        input.provider,
        input.metric,
        input.operator,
        input.threshold,
        input.cooldownMinutes,
        now,
        now,
      );
    const rule = this.getAlertRule(Number(run.lastInsertRowid));
    if (!rule) throw new Error("Failed to resolve alert rule after insert.");
    return rule;
  }

  getAlertRule(id: number): MarketAlertRule | undefined {
    this.migrate();
    const row = this.#database
      .prepare("SELECT * FROM alert_rules WHERE id = ?")
      .get(id) as Readonly<Record<string, unknown>> | undefined;
    return row ? alertRuleFromRow(row) : undefined;
  }

  listAlertRules(enabledOnly = false): readonly MarketAlertRule[] {
    this.migrate();
    return this.#database
      .prepare(`
        SELECT * FROM alert_rules
        ${enabledOnly ? "WHERE enabled = 1" : ""}
        ORDER BY created_at, id
      `)
      .all()
      .map(alertRuleFromRow);
  }

  setAlertRuleEnabled(id: number, enabled: boolean, now: string): boolean {
    this.migrate();
    const run = this.#database
      .prepare("UPDATE alert_rules SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, now, id);
    return run.changes > 0;
  }

  recordAlertEvaluation(
    rule: MarketAlertRule,
    evaluation: MarketAlertEvaluation,
    input: {
      readonly outcome: string;
      readonly conditionState?: boolean;
      readonly triggeredAt?: string;
    },
  ): void {
    this.migrate();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database
        .prepare(`
          INSERT INTO alert_evaluations(
            rule_id, status, condition_met, metric_value, provider, source,
            platform, source_observed_at, evaluated_at, evidence_fingerprint, evidence_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          rule.id,
          input.outcome,
          evaluation.conditionMet ? 1 : 0,
          evaluation.value ?? null,
          evaluation.provider ?? null,
          evaluation.source ?? null,
          evaluation.platform ?? null,
          evaluation.observedAt ?? null,
          evaluation.evaluatedAt,
          evaluation.evidenceFingerprint ?? null,
          JSON.stringify({
            metric: evaluation.metric,
            operator: evaluation.operator,
            threshold: evaluation.threshold,
            limitation: evaluation.limitation,
          }),
        );

      const conditionState = input.conditionState ?? rule.lastConditionMet;
      const lastTriggeredAt = input.triggeredAt ?? rule.lastTriggeredAt;
      const fingerprint = conditionState
        ? (input.triggeredAt ? evaluation.evidenceFingerprint : rule.lastEvidenceFingerprint)
        : undefined;
      this.#database
        .prepare(`
          UPDATE alert_rules
          SET last_evaluated_at = ?, last_condition_met = ?, last_triggered_at = ?,
              last_evidence_fingerprint = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(
          evaluation.evaluatedAt,
          conditionState ? 1 : 0,
          lastTriggeredAt ?? null,
          fingerprint ?? null,
          evaluation.evaluatedAt,
          rule.id,
        );
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  saveAlertDelivery(input: {
    readonly ruleId?: number;
    readonly channel: string;
    readonly evidenceFingerprint?: string;
    readonly status: "sent" | "failed" | "skipped";
    readonly attemptCount: number;
    readonly createdAt: string;
    readonly attemptedAt: string;
    readonly sentAt?: string;
    readonly errorMessage?: string;
  }): void {
    this.migrate();
    this.#database
      .prepare(`
        INSERT INTO alert_deliveries(
          rule_id, channel, evidence_fingerprint, status, attempt_count,
          created_at, attempted_at, sent_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rule_id, channel, evidence_fingerprint) DO UPDATE SET
          status = excluded.status,
          attempt_count = excluded.attempt_count,
          attempted_at = excluded.attempted_at,
          sent_at = excluded.sent_at,
          error_message = excluded.error_message
      `)
      .run(
        input.ruleId ?? null,
        input.channel,
        input.evidenceFingerprint ?? null,
        input.status,
        input.attemptCount,
        input.createdAt,
        input.attemptedAt,
        input.sentAt ?? null,
        input.errorMessage ?? null,
      );
  }

  saveProviderCache<T>(
    cacheKey: string,
    provider: string,
    evidence: Evidence<T>,
    expiresAt: string,
  ): void {
    this.migrate();
    this.#database
      .prepare(`
        INSERT INTO provider_cache(
          cache_key, provider, source, observed_at, expires_at, payload_json, limitations_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_key) DO UPDATE SET
          provider = excluded.provider,
          source = excluded.source,
          observed_at = excluded.observed_at,
          expires_at = excluded.expires_at,
          payload_json = excluded.payload_json,
          limitations_json = excluded.limitations_json
      `)
      .run(
        cacheKey,
        provider,
        evidence.source,
        evidence.observedAt,
        expiresAt,
        JSON.stringify(evidence.data),
        JSON.stringify(evidence.limitations),
      );
  }

  getProviderCache<T>(cacheKey: string, now: Date = new Date()): Evidence<T> | undefined {
    this.migrate();
    const row = this.#database
      .prepare(`
        SELECT source, observed_at, expires_at, payload_json, limitations_json
        FROM provider_cache
        WHERE cache_key = ?
      `)
      .get(cacheKey) as Readonly<Record<string, unknown>> | undefined;
    if (!row || typeof row.expires_at !== "string" || row.expires_at <= now.toISOString()) {
      return undefined;
    }
    try {
      const limitations = JSON.parse(String(row.limitations_json));
      return {
        source: String(row.source),
        observedAt: String(row.observed_at),
        confidence: "verified_source",
        limitations: Array.isArray(limitations)
          ? limitations.filter((value): value is string => typeof value === "string")
          : [],
        data: JSON.parse(String(row.payload_json)) as T,
      };
    } catch {
      return undefined;
    }
  }

  saveDecisionReport(input: {
    readonly reportType: string;
    readonly marketHashName?: string;
    readonly generatedAt: string;
    readonly confidence: string;
    readonly report: unknown;
  }): void {
    this.migrate();
    this.#database
      .prepare(`
        INSERT INTO decision_reports(
          report_type, market_hash_name, generated_at, confidence, report_json
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        input.reportType,
        input.marketHashName ?? null,
        input.generatedAt,
        input.confidence,
        JSON.stringify(input.report),
      );
  }

  saveMarketHomeEvidence(evidence: Evidence<CsQaqMarketHomeData>): void {
    this.migrate();
    const sectorInsert = this.#database.prepare(`
      INSERT INTO market_sectors(
        provider, provider_sector_id, name, name_key, image_url, market_index,
        change_amount, change_rate_pct, open, close, high, low, source_updated_at, observed_at
      ) VALUES ('csqaq', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_sector_id) DO UPDATE SET
        name=excluded.name, name_key=excluded.name_key, image_url=excluded.image_url,
        market_index=excluded.market_index, change_amount=excluded.change_amount,
        change_rate_pct=excluded.change_rate_pct, open=excluded.open, close=excluded.close,
        high=excluded.high, low=excluded.low, source_updated_at=excluded.source_updated_at,
        observed_at=excluded.observed_at
    `);
    const cardInsert = this.#database.prepare(`
      INSERT INTO steam_card_prices(provider, recorded_at, price_cny_per_100_usd, observed_at)
      VALUES ('csqaq', ?, ?, ?)
      ON CONFLICT(provider, recorded_at) DO UPDATE SET
        price_cny_per_100_usd=excluded.price_cny_per_100_usd,
        observed_at=excluded.observed_at
    `);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const sector of evidence.data.sectors) {
        sectorInsert.run(
          sector.id, sector.name, sector.nameKey, sector.imageUrl ?? null,
          sector.marketIndex, sector.changeAmount, sector.changeRatePct,
          sector.open, sector.close, sector.high, sector.low, sector.updatedAt, evidence.observedAt,
        );
      }
      for (const point of evidence.data.cardPrices) {
        cardInsert.run(point.recordedAt, point.priceCnyPer100Usd, evidence.observedAt);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  saveSectorKlineEvidence(
    sectorId: string,
    interval: string,
    evidence: Evidence<readonly CsQaqSectorKlinePoint[]>,
  ): void {
    this.migrate();
    this.#database.prepare(`
      INSERT INTO sector_kline_observations(
        provider, provider_sector_id, interval, observed_at, points_json
      ) VALUES ('csqaq', ?, ?, ?, ?)
      ON CONFLICT(provider, provider_sector_id, interval, observed_at) DO UPDATE SET
        points_json=excluded.points_json
    `).run(sectorId, interval, evidence.observedAt, JSON.stringify(evidence.data));
  }

  listMarketSectors(): readonly CsQaqSectorIndex[] {
    this.migrate();
    return this.#database.prepare(`SELECT * FROM market_sectors WHERE provider='csqaq' ORDER BY name`)
      .all().map((row): CsQaqSectorIndex => ({
        id: String(row.provider_sector_id), name: String(row.name), nameKey: String(row.name_key),
        ...(typeof row.image_url === "string" ? { imageUrl: row.image_url } : {}),
        marketIndex: Number(row.market_index), changeAmount: Number(row.change_amount),
        changeRatePct: Number(row.change_rate_pct), open: Number(row.open), close: Number(row.close),
        high: Number(row.high), low: Number(row.low), updatedAt: String(row.source_updated_at),
      }));
  }

  getLatestSteamCardPrice(): { readonly priceCnyPer100Usd: number; readonly recordedAt: string } | undefined {
    this.migrate();
    const row = this.#database.prepare(`
      SELECT price_cny_per_100_usd, recorded_at FROM steam_card_prices
      WHERE provider='csqaq' ORDER BY recorded_at DESC LIMIT 1
    `).get();
    return row ? { priceCnyPer100Usd: Number(row.price_cny_per_100_usd), recordedAt: String(row.recorded_at) } : undefined;
  }

  upsertCollection(collection: CsQaqCollection, syncedAt: string): void {
    this.migrate();
    this.#database.prepare(`
      INSERT INTO item_collections(
        provider, provider_collection_id, name, comment, image_url, provider_created_at, synced_at
      ) VALUES ('csqaq', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_collection_id) DO UPDATE SET
        name=excluded.name, comment=excluded.comment, image_url=excluded.image_url,
        provider_created_at=excluded.provider_created_at, synced_at=excluded.synced_at
    `).run(collection.id, collection.name, collection.comment ?? null, collection.imageUrl ?? null,
      collection.createdAt ?? null, syncedAt);
  }

  replaceCollectionMembers(collectionId: string, members: readonly CsQaqCollectionItem[], syncedAt: string): void {
    this.migrate();
    const insert = this.#database.prepare(`
      INSERT INTO item_collection_members(
        provider, provider_collection_id, provider_good_id, name, rarity_name, rarity_rank,
        quality_name, reference_price, image_url, synced_at
      ) VALUES ('csqaq', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      this.#database.prepare(`DELETE FROM item_collection_members WHERE provider='csqaq' AND provider_collection_id=?`)
        .run(collectionId);
      for (const member of members) {
        insert.run(collectionId, member.goodId, member.name, member.rarityName,
          normalizeRarityRank(member.rarityName) ?? null, member.qualityName ?? null,
          member.referencePrice ?? null, member.imageUrl ?? null, syncedAt);
      }
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  searchCollectionMembers(search: string): readonly Readonly<Record<string, unknown>>[] {
    this.migrate();
    return this.#database.prepare(`
      SELECT m.*, c.name AS collection_name, c.comment AS collection_comment
      FROM item_collection_members m
      JOIN item_collections c ON c.provider=m.provider AND c.provider_collection_id=m.provider_collection_id
      WHERE m.provider='csqaq' AND (lower(m.name)=lower(?) OR m.name LIKE ? OR m.provider_good_id=?)
      ORDER BY
        CASE WHEN lower(m.name)=lower(?) THEN 0 ELSE 1 END,
        CASE WHEN m.name LIKE '%纪念品%' OR c.name LIKE '%纪念包%' OR lower(COALESCE(c.comment, '')) LIKE '%major%' THEN 1 ELSE 0 END,
        c.name,
        m.rarity_rank
    `).all(search, `%${search}%`, search, search);
  }

  listCollectionTier(collectionId: string, rarityRank: number): readonly Readonly<Record<string, unknown>>[] {
    this.migrate();
    return this.#database.prepare(`
      SELECT * FROM item_collection_members
      WHERE provider='csqaq' AND provider_collection_id=? AND rarity_rank=?
      ORDER BY name
    `).all(collectionId, rarityRank);
  }

  upsertDiyCatalogItem(item: DiyCatalogItem): number {
    this.migrate();
    this.#database.prepare(`
      INSERT INTO diy_catalog_items(
        provider, good_id, market_hash_name, name, kind, image_url, local_image_path,
        type_name, rarity_name, exterior_name, def_index, paint_index, sticker_kit_id, minimum_float,
        maximum_float, buff_sell_price, yyyp_sell_price, steam_sell_price, palette_json,
        visual_tags_json, brightness, saturation, complexity, source_observed_at,
        enriched_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, good_id) DO UPDATE SET
        market_hash_name = excluded.market_hash_name, name = excluded.name, kind = excluded.kind,
        image_url = COALESCE(excluded.image_url, diy_catalog_items.image_url),
        local_image_path = COALESCE(excluded.local_image_path, diy_catalog_items.local_image_path),
        type_name = COALESCE(excluded.type_name, diy_catalog_items.type_name),
        rarity_name = COALESCE(excluded.rarity_name, diy_catalog_items.rarity_name),
        exterior_name = COALESCE(excluded.exterior_name, diy_catalog_items.exterior_name),
        def_index = COALESCE(excluded.def_index, diy_catalog_items.def_index),
        paint_index = COALESCE(excluded.paint_index, diy_catalog_items.paint_index),
        sticker_kit_id = COALESCE(excluded.sticker_kit_id, diy_catalog_items.sticker_kit_id),
        minimum_float = COALESCE(excluded.minimum_float, diy_catalog_items.minimum_float),
        maximum_float = COALESCE(excluded.maximum_float, diy_catalog_items.maximum_float),
        buff_sell_price = COALESCE(excluded.buff_sell_price, diy_catalog_items.buff_sell_price),
        yyyp_sell_price = COALESCE(excluded.yyyp_sell_price, diy_catalog_items.yyyp_sell_price),
        steam_sell_price = COALESCE(excluded.steam_sell_price, diy_catalog_items.steam_sell_price),
        palette_json = CASE WHEN excluded.palette_json = '[]' THEN diy_catalog_items.palette_json ELSE excluded.palette_json END,
        visual_tags_json = CASE WHEN excluded.visual_tags_json = '[]' THEN diy_catalog_items.visual_tags_json ELSE excluded.visual_tags_json END,
        brightness = COALESCE(excluded.brightness, diy_catalog_items.brightness),
        saturation = COALESCE(excluded.saturation, diy_catalog_items.saturation),
        complexity = COALESCE(excluded.complexity, diy_catalog_items.complexity),
        source_observed_at = excluded.source_observed_at,
        enriched_at = COALESCE(excluded.enriched_at, diy_catalog_items.enriched_at),
        updated_at = excluded.updated_at
    `).run(
      item.provider, item.goodId, item.marketHashName, item.name, item.kind,
      item.imageUrl ?? null, item.localImagePath ?? null, item.typeName ?? null,
      item.rarityName ?? null, item.exteriorName ?? null, item.defIndex ?? null,
      item.paintIndex ?? null, item.stickerKitId ?? null, item.minimumFloat ?? null, item.maximumFloat ?? null,
      item.buffSellPrice ?? null, item.yyypSellPrice ?? null, item.steamSellPrice ?? null,
      JSON.stringify(item.palette), JSON.stringify(item.visualTags), item.brightness ?? null,
      item.saturation ?? null, item.complexity ?? null, item.sourceObservedAt,
      item.enrichedAt ?? null, item.createdAt, item.updatedAt,
    );
    const row = this.#database.prepare("SELECT id FROM diy_catalog_items WHERE provider = ? AND good_id = ?")
      .get(item.provider, item.goodId) as { id: number } | undefined;
    if (!row) throw new Error("Failed to resolve DIY catalog item after upsert.");
    return row.id;
  }

  searchDiyCatalog(input: { readonly search?: string; readonly kind?: DiyCatalogItem["kind"]; readonly enrichedOnly?: boolean; readonly limit?: number } = {}): readonly DiyCatalogItem[] {
    this.migrate();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (input.search) {
      clauses.push("(market_hash_name LIKE ? OR name LIKE ?)");
      params.push(`%${input.search}%`, `%${input.search}%`);
    }
    if (input.kind) { clauses.push("kind = ?"); params.push(input.kind); }
    if (input.enrichedOnly) clauses.push("enriched_at IS NOT NULL");
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(Math.min(Math.max(input.limit ?? 100, 1), 1000));
    return this.#database.prepare(`SELECT * FROM diy_catalog_items ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params).map((row) => diyCatalogItemFromRow(row));
  }

  getDiyCatalogItem(id: number): DiyCatalogItem | undefined {
    this.migrate();
    const row = this.#database.prepare("SELECT * FROM diy_catalog_items WHERE id = ?").get(id);
    return row ? diyCatalogItemFromRow(row) : undefined;
  }

  applyDiyStickerKitCatalog(entries: readonly { readonly marketHashName: string; readonly stickerKitId: number }[]): number {
    this.migrate();
    const update = this.#database.prepare(`
      UPDATE diy_catalog_items SET sticker_kit_id = ?, updated_at = ?
      WHERE kind = 'sticker' AND lower(market_hash_name) = lower(?)
    `);
    let changed = 0;
    const now = new Date().toISOString();
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      for (const entry of entries) changed += Number(update.run(entry.stickerKitId, now, entry.marketHashName).changes);
      this.#database.exec("COMMIT;");
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
    return changed;
  }

  saveDiyRecipe(recipe: DiyRecipe): number {
    this.migrate();
    const result = this.#database.prepare(`
      INSERT INTO diy_recipes(skin_catalog_id, style, budget, currency, slot_count, score, generated_at, recipe_json, preview_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(recipe.skinCatalogId, recipe.style, recipe.budget ?? null, recipe.currency, recipe.slotCount,
      recipe.score, recipe.generatedAt, JSON.stringify(recipe), recipe.previewPath ?? null);
    return Number(result.lastInsertRowid);
  }

  getDiyRecipe(id: number): DiyRecipe | undefined {
    this.migrate();
    const row = this.#database.prepare("SELECT recipe_json, preview_path, inspect_code, inspect_link FROM diy_recipes WHERE id = ?").get(id) as Readonly<Record<string, unknown>> | undefined;
    if (!row || typeof row.recipe_json !== "string") return undefined;
    const recipe = JSON.parse(row.recipe_json) as DiyRecipe;
    return {
      ...recipe,
      id,
      ...(typeof row.preview_path === "string" ? { previewPath: row.preview_path } : {}),
      ...(typeof row.inspect_code === "string" ? { inspectCode: row.inspect_code } : {}),
      ...(typeof row.inspect_link === "string" ? { inspectLink: row.inspect_link } : {}),
    };
  }

  setDiyRecipePreview(id: number, previewPath: string): void {
    this.migrate();
    this.#database.prepare("UPDATE diy_recipes SET preview_path = ? WHERE id = ?").run(previewPath, id);
  }

  setDiyRecipeInspectPreview(id: number, input: { readonly inspectCode: string; readonly inspectLink: string; readonly preview: unknown; readonly previewPath?: string }): void {
    this.migrate();
    this.#database.prepare(`
      UPDATE diy_recipes SET inspect_code = ?, inspect_link = ?, preview_json = ?, preview_path = ?
      WHERE id = ?
    `).run(input.inspectCode, input.inspectLink, JSON.stringify(input.preview), input.previewPath ?? null, id);
  }

  saveDiyFeedback(input: DiyFeedbackInput, now: Date = new Date()): number {
    this.migrate();
    const result = this.#database.prepare(`
      INSERT INTO diy_feedback(recipe_id, rating, selected, liked_tags_json, disliked_tags_json, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.recipeId, input.rating, input.selected ? 1 : 0, JSON.stringify(input.likedTags ?? []),
      JSON.stringify(input.dislikedTags ?? []), input.comment?.trim() || null, now.toISOString());
    return Number(result.lastInsertRowid);
  }

  getDiyPreferenceProfile(): DiyPreferenceProfile {
    this.migrate();
    const rows = this.#database.prepare(`
      SELECT f.rating, f.selected, f.liked_tags_json, f.disliked_tags_json, r.style
      FROM diy_feedback f JOIN diy_recipes r ON r.id = f.recipe_id ORDER BY f.id
    `).all();
    const tagWeights: Record<string, number> = {};
    const styleWeights: Partial<Record<DiyStyle, number>> = {};
    for (const row of rows) {
      const rating = Number(row.rating);
      const selectedBonus = Number(row.selected) === 1 ? 1 : 0;
      const delta = (rating - 3) / 2 + selectedBonus;
      const style = String(row.style) as DiyStyle;
      styleWeights[style] = (styleWeights[style] ?? 0) + delta;
      for (const tag of parseStringArray(row.liked_tags_json)) tagWeights[tag] = (tagWeights[tag] ?? 0) + 1 + selectedBonus;
      for (const tag of parseStringArray(row.disliked_tags_json)) tagWeights[tag] = (tagWeights[tag] ?? 0) - 1;
    }
    return {
      sampleCount: rows.length,
      tagWeights,
      styleWeights,
      explanation: rows.length
        ? "偏好来自本地评分、采纳记录和喜欢/不喜欢标签，仅影响后续规则排序。"
        : "暂无反馈样本，当前使用通用透明搭配规则。",
    };
  }

  countRows(
    table:
      | "market_items"
      | "market_snapshots"
      | "kline_observations"
      | "broad_kline_observations"
      | "market_analysis_reports"
      | "inventory_watches"
      | "inventory_checks"
      | "inventory_snapshots"
      | "inventory_assets"
      | "inventory_events"
      | "notification_deliveries"
      | "inventory_valuations"
      | "inventory_valuation_items"
      | "high_value_inventory_events"
      | "alert_rules"
      | "alert_evaluations"
      | "alert_deliveries"
      | "composite_alert_rules"
      | "composite_alert_evaluations"
      | "composite_alert_deliveries"
      | "provider_cache"
      | "decision_reports"
      | "diy_catalog_items"
      | "diy_recipes"
      | "diy_feedback"
      | "market_sectors"
      | "sector_kline_observations"
      | "steam_card_prices"
      | "item_collections"
      | "item_collection_members",
  ): number {
    const row = this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  }

  close(): void {
    this.#database.close();
  }

  #upsertMarketItem(marketHashName: string, observedAt: string): number {
    this.#database
      .prepare(`
        INSERT INTO market_items(market_hash_name, created_at)
        VALUES (?, ?)
        ON CONFLICT(market_hash_name) DO NOTHING
      `)
      .run(marketHashName, observedAt);
    const row = this.#database
      .prepare("SELECT id FROM market_items WHERE market_hash_name = ?")
      .get(marketHashName) as { id: number } | undefined;
    if (!row) throw new Error("Failed to resolve market item after upsert.");
    return row.id;
  }
}

function toIsoTimestamp(value: number | undefined): string | null {
  if (value === undefined) return null;
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function parseRawRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : {};
  } catch {
    return {};
  }
}

function diyCatalogItemFromRow(row: Readonly<Record<string, unknown>>): DiyCatalogItem {
  return {
    id: Number(row.id),
    provider: "csqaq",
    goodId: String(row.good_id),
    marketHashName: String(row.market_hash_name),
    name: String(row.name),
    kind: String(row.kind) as DiyCatalogItem["kind"],
    ...(typeof row.image_url === "string" ? { imageUrl: row.image_url } : {}),
    ...(typeof row.local_image_path === "string" ? { localImagePath: row.local_image_path } : {}),
    ...(typeof row.type_name === "string" ? { typeName: row.type_name } : {}),
    ...(typeof row.rarity_name === "string" ? { rarityName: row.rarity_name } : {}),
    ...(typeof row.exterior_name === "string" ? { exteriorName: row.exterior_name } : {}),
    ...(typeof row.def_index === "number" ? { defIndex: row.def_index } : {}),
    ...(typeof row.paint_index === "number" ? { paintIndex: row.paint_index } : {}),
    ...(typeof row.sticker_kit_id === "number" ? { stickerKitId: row.sticker_kit_id } : {}),
    ...(typeof row.minimum_float === "number" ? { minimumFloat: row.minimum_float } : {}),
    ...(typeof row.maximum_float === "number" ? { maximumFloat: row.maximum_float } : {}),
    ...(typeof row.buff_sell_price === "number" ? { buffSellPrice: row.buff_sell_price } : {}),
    ...(typeof row.yyyp_sell_price === "number" ? { yyypSellPrice: row.yyyp_sell_price } : {}),
    ...(typeof row.steam_sell_price === "number" ? { steamSellPrice: row.steam_sell_price } : {}),
    palette: parseJsonArray(row.palette_json) as DiyCatalogItem["palette"],
    visualTags: parseStringArray(row.visual_tags_json),
    ...(typeof row.brightness === "number" ? { brightness: row.brightness } : {}),
    ...(typeof row.saturation === "number" ? { saturation: row.saturation } : {}),
    ...(typeof row.complexity === "number" ? { complexity: row.complexity } : {}),
    sourceObservedAt: String(row.source_observed_at),
    ...(typeof row.enriched_at === "string" ? { enrichedAt: row.enriched_at } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseJsonArray(value: unknown): readonly unknown[] {
  if (typeof value !== "string") return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function parseStringArray(value: unknown): readonly string[] {
  return parseJsonArray(value).filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()));
}

function storedAssetFromRow(row: Readonly<Record<string, unknown>>): SteamInventoryAsset {
  return {
    assetId: String(row.asset_id),
    classId: String(row.class_id),
    instanceId: String(row.instance_id),
    contextId: String(row.context_id),
    amount: Number(row.amount),
    ...(typeof row.market_hash_name === "string" ? { marketHashName: row.market_hash_name } : {}),
    ...(typeof row.display_name === "string" ? { displayName: row.display_name } : {}),
    ...(typeof row.item_type === "string" ? { itemType: row.item_type } : {}),
    ...(typeof row.tradable === "number" ? { tradable: row.tradable === 1 } : {}),
    ...(typeof row.marketable === "number" ? { marketable: row.marketable === 1 } : {}),
    ...(typeof row.commodity === "number" ? { commodity: row.commodity === 1 } : {}),
    ...(typeof row.inspect_link === "string" ? { inspectLink: row.inspect_link } : {}),
    ...(typeof row.icon_url === "string" ? { iconUrl: row.icon_url } : {}),
    ...(typeof row.paint_seed === "number" ? { paintSeed: row.paint_seed } : {}),
    ...(typeof row.paint_wear === "number" ? { paintWear: row.paint_wear } : {}),
    ...(typeof row.paint_wear_bits === "number" ? { paintWearBits: row.paint_wear_bits } : {}),
    ...(typeof row.paint_index === "number" ? { paintIndex: row.paint_index } : {}),
    ...(typeof row.name_tag === "string" ? { nameTag: row.name_tag } : {}),
    ...(typeof row.charm_template === "number" ? { charmTemplate: row.charm_template } : {}),
    ...(typeof row.item_certificate === "string" ? { itemCertificate: row.item_certificate } : {}),
    ...(typeof row.observation_fingerprint === "string"
      ? { observationFingerprint: row.observation_fingerprint }
      : {}),
    raw: parseRawRecord(row.raw_json),
  };
}

function inventoryWatchFromRow(row: Readonly<Record<string, unknown>>): InventoryWatch {
  return {
    steamId: String(row.steam_id),
    ...(typeof row.label === "string" ? { label: row.label } : {}),
    enabled: Number(row.enabled) === 1,
    intervalMinutes: Number(row.interval_minutes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.last_checked_at === "string" ? { lastCheckedAt: row.last_checked_at } : {}),
    ...(typeof row.next_check_at === "string" ? { nextCheckAt: row.next_check_at } : {}),
  };
}

function alertRuleFromRow(row: Readonly<Record<string, unknown>>): MarketAlertRule {
  return {
    id: Number(row.id),
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    enabled: Number(row.enabled) === 1,
    marketHashName: String(row.market_hash_name),
    platform: String(row.platform),
    provider: String(row.provider) as MarketAlertRule["provider"],
    metric: String(row.metric) as MarketAlertRule["metric"],
    operator: String(row.operator) as MarketAlertRule["operator"],
    threshold: Number(row.threshold),
    cooldownMinutes: Number(row.cooldown_minutes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.last_evaluated_at === "string" ? { lastEvaluatedAt: row.last_evaluated_at } : {}),
    lastConditionMet: Number(row.last_condition_met) === 1,
    ...(typeof row.last_triggered_at === "string" ? { lastTriggeredAt: row.last_triggered_at } : {}),
    ...(typeof row.last_evidence_fingerprint === "string"
      ? { lastEvidenceFingerprint: row.last_evidence_fingerprint }
      : {}),
  };
}

function compositeAlertRuleFromRow(row: Readonly<Record<string, unknown>>): CompositeAlertRule {
  const expression = JSON.parse(String(row.expression_json)) as CompositeAlertRule["expression"];
  return {
    id: Number(row.id),
    name: String(row.name),
    enabled: Number(row.enabled) === 1,
    expression,
    cooldownMinutes: Number(row.cooldown_minutes),
    minimumConsecutiveMatches: Number(row.minimum_consecutive_matches),
    notifyOnRecovery: Number(row.notify_on_recovery) === 1,
    maxDataSkewMinutes: Number(row.max_data_skew_minutes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(typeof row.last_evaluated_at === "string" ? { lastEvaluatedAt: row.last_evaluated_at } : {}),
    ...(typeof row.last_condition_state === "number"
      ? { lastConditionState: Number(row.last_condition_state) === 1 }
      : {}),
    consecutiveMatches: Number(row.consecutive_matches),
    ...(typeof row.last_triggered_at === "string" ? { lastTriggeredAt: row.last_triggered_at } : {}),
    ...(typeof row.last_evidence_fingerprint === "string"
      ? { lastEvidenceFingerprint: row.last_evidence_fingerprint }
      : {}),
  };
}

function toSqlBoolean(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
}
