import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { MIGRATIONS } from "../src/storage/migrations.js";

test("adapter-id migration preserves alert and valuation rows and accepts extension ids", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 10)) database.exec(migration.sql);
  database.exec(`
    INSERT INTO alert_rules(
      id, rule_type, enabled, market_hash_name, platform, provider, metric,
      operator, threshold, cooldown_minutes, created_at, updated_at
    ) VALUES (1, 'market_threshold', 1, 'Synthetic Skin', 'BUFF', 'steamdt',
      'sell_price', 'lt', 100, 60, '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z');
    INSERT INTO alert_evaluations(
      id, rule_id, status, condition_met, evaluated_at, evidence_json
    ) VALUES (1, 1, 'not_matched', 0, '2026-07-22T00:00:00.000Z', '{}');
    INSERT INTO alert_deliveries(
      id, rule_id, channel, status, attempt_count, created_at, attempted_at
    ) VALUES (1, 1, 'wechat', 'skipped', 1, '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z');
    INSERT INTO inventory_checks(
      id, steam_id, source, status, observed_at, page_count, complete
    ) VALUES (1, '76561198000000000', 'test', 'public', '2026-07-22T00:00:00.000Z', 1, 1);
    INSERT INTO inventory_snapshots(
      id, check_id, steam_id, source, observed_at, page_count, complete
    ) VALUES (1, 1, '76561198000000000', 'test', '2026-07-22T00:00:00.000Z', 1, 1);
    INSERT INTO inventory_valuations(
      id, snapshot_id, steam_id, provider, platform, inventory_observed_at, valued_at,
      eligible_quantity, priced_quantity, unknown_quantity, eligible_category_count,
      priced_category_count, price_coverage, category_coverage, known_subtotal,
      high_value_event_count, high_value_alert_eligible, limitations_json
    ) VALUES (1, 1, '76561198000000000', 'steamdt', 'BUFF',
      '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z',
      1, 1, 0, 1, 1, 1, 1, 100, 0, 0, '[]');
    INSERT INTO inventory_valuation_items(
      id, valuation_id, market_hash_name, quantity, unit_price, known_value
    ) VALUES (1, 1, 'Synthetic Skin', 1, 100, 100);
  `);

  const migration = MIGRATIONS.find((entry) => entry.version === 11);
  assert.ok(migration);
  database.exec(migration.sql);

  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM alert_evaluations").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM alert_deliveries").get()?.count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM inventory_valuation_items").get()?.count, 1);
  database.exec(`
    INSERT INTO alert_rules(
      rule_type, enabled, market_hash_name, platform, provider, metric,
      operator, threshold, cooldown_minutes, created_at, updated_at
    ) VALUES ('market_threshold', 1, 'Extension Skin', 'BUFF', 'buff-direct',
      'sell_price', 'lt', 100, 60, '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z');
  `);
  database.close();
});
