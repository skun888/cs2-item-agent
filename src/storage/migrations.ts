export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "create_market_observation_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS market_items (
        id INTEGER PRIMARY KEY,
        market_hash_name TEXT NOT NULL UNIQUE,
        display_name TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY,
        market_item_id INTEGER NOT NULL REFERENCES market_items(id),
        source TEXT NOT NULL,
        platform TEXT NOT NULL,
        sell_price REAL,
        sell_count INTEGER,
        bidding_price REAL,
        bidding_count INTEGER,
        source_updated_at TEXT,
        observed_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_market_snapshots_lookup
        ON market_snapshots(market_item_id, platform, observed_at DESC);

      CREATE TABLE IF NOT EXISTS kline_observations (
        id INTEGER PRIMARY KEY,
        market_item_id INTEGER NOT NULL REFERENCES market_items(id),
        source TEXT NOT NULL,
        platform TEXT NOT NULL,
        kline_type INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_kline_observations_lookup
        ON kline_observations(market_item_id, platform, kline_type, observed_at DESC);
    `,
  },
  {
    version: 2,
    name: "create_market_analysis_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS broad_kline_observations (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        kline_type INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_broad_kline_observations_lookup
        ON broad_kline_observations(kline_type, observed_at DESC);

      CREATE TABLE IF NOT EXISTS market_analysis_reports (
        id INTEGER PRIMARY KEY,
        market_item_id INTEGER NOT NULL REFERENCES market_items(id),
        platform TEXT NOT NULL,
        kline_type INTEGER NOT NULL,
        generated_at TEXT NOT NULL,
        confidence TEXT NOT NULL,
        report_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_market_analysis_reports_lookup
        ON market_analysis_reports(market_item_id, generated_at DESC);
    `,
  },
  {
    version: 3,
    name: "create_public_inventory_monitor_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS inventory_watches (
        steam_id TEXT PRIMARY KEY,
        label TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        interval_minutes INTEGER NOT NULL DEFAULT 30 CHECK(interval_minutes > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,
        next_check_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS inventory_checks (
        id INTEGER PRIMARY KEY,
        steam_id TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        http_status INTEGER,
        observed_at TEXT NOT NULL,
        asset_count INTEGER,
        total_inventory_count INTEGER,
        page_count INTEGER NOT NULL,
        complete INTEGER NOT NULL CHECK(complete IN (0, 1)),
        message TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_inventory_checks_lookup
        ON inventory_checks(steam_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS inventory_snapshots (
        id INTEGER PRIMARY KEY,
        check_id INTEGER NOT NULL UNIQUE REFERENCES inventory_checks(id),
        steam_id TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        total_inventory_count INTEGER,
        page_count INTEGER NOT NULL,
        complete INTEGER NOT NULL CHECK(complete IN (0, 1))
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_lookup
        ON inventory_snapshots(steam_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS inventory_assets (
        id INTEGER PRIMARY KEY,
        snapshot_id INTEGER NOT NULL REFERENCES inventory_snapshots(id),
        asset_id TEXT NOT NULL,
        class_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        market_hash_name TEXT,
        display_name TEXT,
        item_type TEXT,
        tradable INTEGER,
        marketable INTEGER,
        commodity INTEGER,
        inspect_link TEXT,
        icon_url TEXT,
        raw_json TEXT NOT NULL,
        UNIQUE(snapshot_id, asset_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_inventory_assets_item_lookup
        ON inventory_assets(market_hash_name, snapshot_id);

      CREATE TABLE IF NOT EXISTS inventory_events (
        id INTEGER PRIMARY KEY,
        steam_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        market_hash_name TEXT,
        display_name TEXT,
        quantity_before INTEGER NOT NULL,
        quantity_after INTEGER NOT NULL,
        previous_observed_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_inventory_events_lookup
        ON inventory_events(steam_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS notification_deliveries (
        id INTEGER PRIMARY KEY,
        steam_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        message TEXT
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: "add_inventory_asset_properties",
    sql: `
      ALTER TABLE inventory_assets ADD COLUMN paint_seed INTEGER;
      ALTER TABLE inventory_assets ADD COLUMN paint_wear REAL;
      ALTER TABLE inventory_assets ADD COLUMN paint_wear_bits INTEGER;
      ALTER TABLE inventory_assets ADD COLUMN paint_index INTEGER;
      ALTER TABLE inventory_assets ADD COLUMN name_tag TEXT;
      ALTER TABLE inventory_assets ADD COLUMN charm_template INTEGER;
      ALTER TABLE inventory_assets ADD COLUMN item_certificate TEXT;
      ALTER TABLE inventory_assets ADD COLUMN observation_fingerprint TEXT;

      CREATE INDEX IF NOT EXISTS idx_inventory_assets_fingerprint
        ON inventory_assets(observation_fingerprint);
    `,
  },
  {
    version: 5,
    name: "create_alert_rule_and_delivery_tables",
    sql: `
      ALTER TABLE notification_deliveries
        ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1 CHECK(attempt_count > 0);

      CREATE TABLE alert_rules (
        id INTEGER PRIMARY KEY,
        rule_type TEXT NOT NULL CHECK(rule_type = 'market_threshold'),
        name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        market_hash_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('any', 'steamdt', 'csqaq')),
        metric TEXT NOT NULL CHECK(metric IN ('sell_price', 'sell_count', 'bidding_price', 'bidding_count')),
        operator TEXT NOT NULL CHECK(operator IN ('lt', 'lte', 'gt', 'gte')),
        threshold REAL NOT NULL CHECK(threshold >= 0),
        cooldown_minutes INTEGER NOT NULL DEFAULT 60 CHECK(cooldown_minutes >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_evaluated_at TEXT,
        last_condition_met INTEGER NOT NULL DEFAULT 0 CHECK(last_condition_met IN (0, 1)),
        last_triggered_at TEXT,
        last_evidence_fingerprint TEXT
      ) STRICT;

      CREATE INDEX idx_alert_rules_enabled
        ON alert_rules(enabled, market_hash_name);

      CREATE TABLE alert_evaluations (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES alert_rules(id),
        status TEXT NOT NULL,
        condition_met INTEGER NOT NULL CHECK(condition_met IN (0, 1)),
        metric_value REAL,
        provider TEXT,
        source TEXT,
        platform TEXT,
        source_observed_at TEXT,
        evaluated_at TEXT NOT NULL,
        evidence_fingerprint TEXT,
        evidence_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_alert_evaluations_rule
        ON alert_evaluations(rule_id, evaluated_at DESC);

      CREATE TABLE alert_deliveries (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER REFERENCES alert_rules(id),
        channel TEXT NOT NULL,
        evidence_fingerprint TEXT,
        status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count > 0),
        created_at TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        sent_at TEXT,
        error_message TEXT,
        UNIQUE(rule_id, channel, evidence_fingerprint)
      ) STRICT;

      CREATE INDEX idx_alert_deliveries_rule
        ON alert_deliveries(rule_id, attempted_at DESC);
    `,
  },
  {
    version: 6,
    name: "create_provider_cache_and_decision_reports",
    sql: `
      CREATE TABLE IF NOT EXISTS provider_cache (
        cache_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        limitations_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_provider_cache_expiry
        ON provider_cache(provider, expires_at);

      CREATE TABLE IF NOT EXISTS decision_reports (
        id INTEGER PRIMARY KEY,
        report_type TEXT NOT NULL,
        market_hash_name TEXT,
        generated_at TEXT NOT NULL,
        confidence TEXT NOT NULL,
        report_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_decision_reports_lookup
        ON decision_reports(report_type, market_hash_name, generated_at DESC);
    `,
  },
  {
    version: 7,
    name: "create_diy_catalog_recipe_and_feedback_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS diy_catalog_items (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        good_id TEXT NOT NULL,
        market_hash_name TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('skin', 'sticker', 'other')),
        image_url TEXT,
        local_image_path TEXT,
        type_name TEXT,
        rarity_name TEXT,
        exterior_name TEXT,
        def_index INTEGER,
        paint_index INTEGER,
        minimum_float REAL,
        maximum_float REAL,
        buff_sell_price REAL,
        yyyp_sell_price REAL,
        steam_sell_price REAL,
        palette_json TEXT NOT NULL DEFAULT '[]',
        visual_tags_json TEXT NOT NULL DEFAULT '[]',
        brightness REAL,
        saturation REAL,
        complexity REAL,
        source_observed_at TEXT NOT NULL,
        enriched_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, good_id),
        UNIQUE(provider, market_hash_name)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_diy_catalog_lookup
        ON diy_catalog_items(kind, market_hash_name);

      CREATE TABLE IF NOT EXISTS diy_recipes (
        id INTEGER PRIMARY KEY,
        skin_catalog_id INTEGER NOT NULL REFERENCES diy_catalog_items(id),
        style TEXT NOT NULL,
        budget REAL,
        currency TEXT NOT NULL DEFAULT 'CNY',
        slot_count INTEGER NOT NULL CHECK(slot_count BETWEEN 1 AND 5),
        score REAL NOT NULL,
        generated_at TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        preview_path TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_diy_recipes_skin
        ON diy_recipes(skin_catalog_id, generated_at DESC);

      CREATE TABLE IF NOT EXISTS diy_feedback (
        id INTEGER PRIMARY KEY,
        recipe_id INTEGER NOT NULL REFERENCES diy_recipes(id),
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0, 1)),
        liked_tags_json TEXT NOT NULL DEFAULT '[]',
        disliked_tags_json TEXT NOT NULL DEFAULT '[]',
        comment TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_diy_feedback_recipe
        ON diy_feedback(recipe_id, created_at DESC);
    `,
  },
  {
    version: 8,
    name: "add_real_inspect_preview_fields",
    sql: `
      ALTER TABLE diy_catalog_items ADD COLUMN sticker_kit_id INTEGER;
      ALTER TABLE diy_recipes ADD COLUMN inspect_code TEXT;
      ALTER TABLE diy_recipes ADD COLUMN inspect_link TEXT;
      ALTER TABLE diy_recipes ADD COLUMN preview_json TEXT;

      CREATE INDEX IF NOT EXISTS idx_diy_catalog_sticker_kit
        ON diy_catalog_items(sticker_kit_id);
    `,
  },
  {
    version: 9,
    name: "create_inventory_valuation_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS inventory_valuations (
        id INTEGER PRIMARY KEY,
        snapshot_id INTEGER NOT NULL UNIQUE REFERENCES inventory_snapshots(id),
        steam_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('steamdt', 'csqaq')),
        platform TEXT NOT NULL CHECK(platform = 'BUFF'),
        inventory_observed_at TEXT NOT NULL,
        valued_at TEXT NOT NULL,
        eligible_quantity INTEGER NOT NULL CHECK(eligible_quantity >= 0),
        priced_quantity INTEGER NOT NULL CHECK(priced_quantity >= 0),
        unknown_quantity INTEGER NOT NULL CHECK(unknown_quantity >= 0),
        eligible_category_count INTEGER NOT NULL CHECK(eligible_category_count >= 0),
        priced_category_count INTEGER NOT NULL CHECK(priced_category_count >= 0),
        price_coverage REAL NOT NULL CHECK(price_coverage BETWEEN 0 AND 1),
        category_coverage REAL NOT NULL CHECK(category_coverage BETWEEN 0 AND 1),
        known_subtotal REAL NOT NULL CHECK(known_subtotal >= 0),
        previous_valuation_id INTEGER REFERENCES inventory_valuations(id),
        previous_known_subtotal REAL,
        composition_delta REAL,
        composition_delta_rate REAL,
        market_price_delta REAL,
        high_value_event_count INTEGER NOT NULL DEFAULT 0 CHECK(high_value_event_count >= 0),
        high_value_alert_eligible INTEGER NOT NULL DEFAULT 0 CHECK(high_value_alert_eligible IN (0, 1)),
        limitations_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_inventory_valuations_lookup
        ON inventory_valuations(steam_id, inventory_observed_at DESC);

      CREATE TABLE IF NOT EXISTS inventory_valuation_items (
        id INTEGER PRIMARY KEY,
        valuation_id INTEGER NOT NULL REFERENCES inventory_valuations(id),
        market_hash_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity >= 0),
        item_type TEXT,
        unit_price REAL,
        known_value REAL,
        price_observed_at TEXT,
        source TEXT,
        UNIQUE(valuation_id, market_hash_name)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_inventory_valuation_items_lookup
        ON inventory_valuation_items(valuation_id, known_value DESC);

      CREATE TABLE IF NOT EXISTS high_value_inventory_events (
        id INTEGER PRIMARY KEY,
        snapshot_id INTEGER NOT NULL REFERENCES inventory_snapshots(id),
        steam_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK(event_type IN (
          'high_value_added', 'high_value_removed', 'high_value_quantity_changed'
        )),
        asset_id TEXT NOT NULL,
        market_hash_name TEXT NOT NULL,
        quantity_before INTEGER NOT NULL,
        quantity_after INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        estimated_delta REAL NOT NULL,
        observed_at TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_high_value_inventory_events_lookup
        ON high_value_inventory_events(steam_id, observed_at DESC);
    `,
  },
  {
    version: 10,
    name: "create_composite_alert_tables",
    sql: `
      CREATE TABLE IF NOT EXISTS composite_alert_rules (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        expression_json TEXT NOT NULL,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60 CHECK(cooldown_minutes BETWEEN 0 AND 43200),
        minimum_consecutive_matches INTEGER NOT NULL DEFAULT 1 CHECK(minimum_consecutive_matches BETWEEN 1 AND 10),
        notify_on_recovery INTEGER NOT NULL DEFAULT 0 CHECK(notify_on_recovery IN (0, 1)),
        max_data_skew_minutes INTEGER NOT NULL DEFAULT 30 CHECK(max_data_skew_minutes BETWEEN 1 AND 1440),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_evaluated_at TEXT,
        last_condition_state INTEGER CHECK(last_condition_state IN (0, 1)),
        consecutive_matches INTEGER NOT NULL DEFAULT 0 CHECK(consecutive_matches >= 0),
        last_triggered_at TEXT,
        last_evidence_fingerprint TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_composite_alert_rules_enabled
        ON composite_alert_rules(enabled, created_at);

      CREATE TABLE IF NOT EXISTS composite_alert_evaluations (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES composite_alert_rules(id),
        status TEXT NOT NULL CHECK(status IN (
          'matched', 'not_matched', 'unknown', 'waiting_consecutive',
          'duplicate_active_condition', 'cooldown', 'notified',
          'recovery_notified', 'notification_unconfigured', 'notification_failed'
        )),
        condition_state INTEGER CHECK(condition_state IN (0, 1)),
        consecutive_matches INTEGER NOT NULL CHECK(consecutive_matches >= 0),
        evaluated_at TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        evaluation_json TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_composite_alert_evaluations_rule
        ON composite_alert_evaluations(rule_id, evaluated_at DESC);

      CREATE TABLE IF NOT EXISTS composite_alert_deliveries (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES composite_alert_rules(id),
        delivery_type TEXT NOT NULL CHECK(delivery_type IN ('trigger', 'recovery')),
        channel TEXT NOT NULL,
        evidence_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count > 0),
        created_at TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        sent_at TEXT,
        error_message TEXT,
        UNIQUE(rule_id, delivery_type, channel, evidence_fingerprint)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_composite_alert_deliveries_rule
        ON composite_alert_deliveries(rule_id, attempted_at DESC);
    `,
  },
  {
    version: 11,
    name: "allow_registered_market_adapter_ids",
    sql: `
      CREATE TABLE alert_rules_v2 (
        id INTEGER PRIMARY KEY,
        rule_type TEXT NOT NULL CHECK(rule_type = 'market_threshold'),
        name TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        market_hash_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        provider TEXT NOT NULL,
        metric TEXT NOT NULL CHECK(metric IN ('sell_price', 'sell_count', 'bidding_price', 'bidding_count')),
        operator TEXT NOT NULL CHECK(operator IN ('lt', 'lte', 'gt', 'gte')),
        threshold REAL NOT NULL CHECK(threshold >= 0),
        cooldown_minutes INTEGER NOT NULL DEFAULT 60 CHECK(cooldown_minutes >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_evaluated_at TEXT,
        last_condition_met INTEGER NOT NULL DEFAULT 0 CHECK(last_condition_met IN (0, 1)),
        last_triggered_at TEXT,
        last_evidence_fingerprint TEXT
      ) STRICT;

      INSERT INTO alert_rules_v2 SELECT * FROM alert_rules;

      CREATE TABLE alert_evaluations_v2 (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER NOT NULL REFERENCES alert_rules_v2(id),
        status TEXT NOT NULL,
        condition_met INTEGER NOT NULL CHECK(condition_met IN (0, 1)),
        metric_value REAL,
        provider TEXT,
        source TEXT,
        platform TEXT,
        source_observed_at TEXT,
        evaluated_at TEXT NOT NULL,
        evidence_fingerprint TEXT,
        evidence_json TEXT NOT NULL
      ) STRICT;

      INSERT INTO alert_evaluations_v2 SELECT * FROM alert_evaluations;

      CREATE TABLE alert_deliveries_v2 (
        id INTEGER PRIMARY KEY,
        rule_id INTEGER REFERENCES alert_rules_v2(id),
        channel TEXT NOT NULL,
        evidence_fingerprint TEXT,
        status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped')),
        attempt_count INTEGER NOT NULL CHECK(attempt_count > 0),
        created_at TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        sent_at TEXT,
        error_message TEXT,
        UNIQUE(rule_id, channel, evidence_fingerprint)
      ) STRICT;

      INSERT INTO alert_deliveries_v2 SELECT * FROM alert_deliveries;

      DROP TABLE alert_deliveries;
      DROP TABLE alert_evaluations;
      DROP TABLE alert_rules;
      ALTER TABLE alert_rules_v2 RENAME TO alert_rules;
      ALTER TABLE alert_evaluations_v2 RENAME TO alert_evaluations;
      ALTER TABLE alert_deliveries_v2 RENAME TO alert_deliveries;

      CREATE INDEX idx_alert_rules_enabled ON alert_rules(enabled, market_hash_name);
      CREATE INDEX idx_alert_evaluations_rule ON alert_evaluations(rule_id, evaluated_at DESC);
      CREATE INDEX idx_alert_deliveries_rule ON alert_deliveries(rule_id, attempted_at DESC);

      CREATE TABLE inventory_valuations_v2 (
        id INTEGER PRIMARY KEY,
        snapshot_id INTEGER NOT NULL UNIQUE REFERENCES inventory_snapshots(id),
        steam_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform = 'BUFF'),
        inventory_observed_at TEXT NOT NULL,
        valued_at TEXT NOT NULL,
        eligible_quantity INTEGER NOT NULL CHECK(eligible_quantity >= 0),
        priced_quantity INTEGER NOT NULL CHECK(priced_quantity >= 0),
        unknown_quantity INTEGER NOT NULL CHECK(unknown_quantity >= 0),
        eligible_category_count INTEGER NOT NULL CHECK(eligible_category_count >= 0),
        priced_category_count INTEGER NOT NULL CHECK(priced_category_count >= 0),
        price_coverage REAL NOT NULL CHECK(price_coverage BETWEEN 0 AND 1),
        category_coverage REAL NOT NULL CHECK(category_coverage BETWEEN 0 AND 1),
        known_subtotal REAL NOT NULL CHECK(known_subtotal >= 0),
        previous_valuation_id INTEGER REFERENCES inventory_valuations_v2(id),
        previous_known_subtotal REAL,
        composition_delta REAL,
        composition_delta_rate REAL,
        market_price_delta REAL,
        high_value_event_count INTEGER NOT NULL DEFAULT 0 CHECK(high_value_event_count >= 0),
        high_value_alert_eligible INTEGER NOT NULL DEFAULT 0 CHECK(high_value_alert_eligible IN (0, 1)),
        limitations_json TEXT NOT NULL
      ) STRICT;

      INSERT INTO inventory_valuations_v2 SELECT * FROM inventory_valuations;

      CREATE TABLE inventory_valuation_items_v2 (
        id INTEGER PRIMARY KEY,
        valuation_id INTEGER NOT NULL REFERENCES inventory_valuations_v2(id),
        market_hash_name TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK(quantity >= 0),
        item_type TEXT,
        unit_price REAL,
        known_value REAL,
        price_observed_at TEXT,
        source TEXT,
        UNIQUE(valuation_id, market_hash_name)
      ) STRICT;

      INSERT INTO inventory_valuation_items_v2 SELECT * FROM inventory_valuation_items;

      DROP TABLE inventory_valuation_items;
      DROP TABLE inventory_valuations;
      ALTER TABLE inventory_valuations_v2 RENAME TO inventory_valuations;
      ALTER TABLE inventory_valuation_items_v2 RENAME TO inventory_valuation_items;

      CREATE INDEX idx_inventory_valuations_lookup
        ON inventory_valuations(steam_id, inventory_observed_at DESC);
      CREATE INDEX idx_inventory_valuation_items_lookup
        ON inventory_valuation_items(valuation_id, known_value DESC);
    `,
  },
  {
    version: 12,
    name: "create_sector_card_price_and_tradeup_catalog",
    sql: `
      CREATE TABLE IF NOT EXISTS market_sectors (
        provider TEXT NOT NULL,
        provider_sector_id TEXT NOT NULL,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL,
        image_url TEXT,
        market_index REAL NOT NULL,
        change_amount REAL NOT NULL,
        change_rate_pct REAL NOT NULL,
        open REAL NOT NULL,
        close REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        source_updated_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_sector_id)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_market_sectors_key
        ON market_sectors(provider, name_key);

      CREATE TABLE IF NOT EXISTS sector_kline_observations (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_sector_id TEXT NOT NULL,
        interval TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        points_json TEXT NOT NULL,
        UNIQUE(provider, provider_sector_id, interval, observed_at)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_sector_kline_lookup
        ON sector_kline_observations(provider, provider_sector_id, interval, observed_at DESC);

      CREATE TABLE IF NOT EXISTS steam_card_prices (
        provider TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        price_cny_per_100_usd REAL NOT NULL CHECK(price_cny_per_100_usd > 0),
        observed_at TEXT NOT NULL,
        PRIMARY KEY(provider, recorded_at)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_steam_card_prices_latest
        ON steam_card_prices(provider, recorded_at DESC);

      CREATE TABLE IF NOT EXISTS item_collections (
        provider TEXT NOT NULL,
        provider_collection_id TEXT NOT NULL,
        name TEXT NOT NULL,
        comment TEXT,
        image_url TEXT,
        provider_created_at TEXT,
        synced_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_collection_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_item_collections_name
        ON item_collections(provider, name);

      CREATE TABLE IF NOT EXISTS item_collection_members (
        provider TEXT NOT NULL,
        provider_collection_id TEXT NOT NULL,
        provider_good_id TEXT NOT NULL,
        name TEXT NOT NULL,
        rarity_name TEXT NOT NULL,
        rarity_rank INTEGER,
        quality_name TEXT,
        reference_price REAL,
        image_url TEXT,
        synced_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_collection_id, provider_good_id),
        FOREIGN KEY(provider, provider_collection_id)
          REFERENCES item_collections(provider, provider_collection_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_collection_members_item
        ON item_collection_members(provider, provider_good_id);
      CREATE INDEX IF NOT EXISTS idx_collection_members_tradeup
        ON item_collection_members(provider, provider_collection_id, rarity_rank);
    `,
  },
];
