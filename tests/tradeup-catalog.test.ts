import assert from "node:assert/strict";
import test from "node:test";

import { AppDatabase } from "../src/storage/database.js";
import { TradeUpCatalogService } from "../src/services/tradeup-catalog-service.js";
import { normalizeRarityRank } from "../src/domain/tradeup-catalog.js";

test("local collection database preserves rarity tiers and deterministic trade-up relationships", () => {
  const database = new AppDatabase(":memory:");
  database.migrate();
  database.upsertCollection({ id: "275", name: "2018 核子危机收藏品" }, "2026-07-22T00:00:00Z");
  database.replaceCollectionMembers("275", [
    { goodId: "9618", name: "Glock-18 | 核子花园", rarityName: "受限", referencePrice: 100 },
    { goodId: "9619", name: "M4A4 | Synthetic", rarityName: "保密", referencePrice: 300 },
    { goodId: "9620", name: "AWP | Synthetic", rarityName: "保密", referencePrice: 500 },
  ], "2026-07-22T00:00:00Z");
  const service = new TradeUpCatalogService({} as never, database);
  const report = service.analyze("9618")[0]!;
  assert.equal(normalizeRarityRank("受限"), 3);
  assert.equal(report.relationship.inputRole, "input");
  assert.equal(report.relationship.eligible, true);
  assert.equal(report.relationship.contractInputCount, 10);
  assert.equal(report.relationship.outputCatalogStatus, "resolved");
  assert.equal(report.relationship.outputRarity, "classified");
  assert.equal(report.outputTier.length, 2);
  assert.equal(report.relationship.distinctOutputCount, 2);
  assert.equal(report.relationship.equalCollectionOutcomeProbabilityPct, 50);
  database.close();
});

test("souvenir inputs are eligible but require a normal base-collection output mapping", () => {
  const database = new AppDatabase(":memory:");
  database.migrate();
  database.upsertCollection({ id: "25", name: "卡托维兹 2019 核子危机纪念包", comment: "Major" }, "2026-07-22T00:00:00Z");
  database.replaceCollectionMembers("25", [
    { goodId: "9403", name: "格洛克 18 型（纪念品） | 核子花园", rarityName: "受限", referencePrice: 185.3 },
    { goodId: "9405", name: "M4A1 消音型（纪念品） | 控制台", rarityName: "保密", referencePrice: 1498 },
  ], "2026-07-22T00:00:00Z");
  const service = new TradeUpCatalogService({} as never, database);
  const report = service.analyze("9403")[0]!;
  assert.equal(report.relationship.eligible, true);
  assert.equal(report.relationship.inputRole, "input");
  assert.equal(report.relationship.outputQuality, "regular");
  assert.equal(report.relationship.outputCatalogStatus, "base_collection_required");
  assert.equal(report.outputTier.length, 0);
  database.close();
});

test("covert inputs use the current five-item rare-special contract", () => {
  const database = new AppDatabase(":memory:");
  database.migrate();
  database.upsertCollection({ id: "5", name: "手套武器箱" }, "2026-07-22T00:00:00Z");
  database.replaceCollectionMembers("5", [
    { goodId: "1294", name: "M4A4 | 喧嚣杀戮", rarityName: "隐秘", referencePrice: 1730 },
    { goodId: "8394", name: "运动手套（★） | 迈阿密风云", rarityName: "非凡", qualityName: "★", referencePrice: 129888 },
  ], "2026-07-22T00:00:00Z");
  const service = new TradeUpCatalogService({} as never, database);
  const report = service.analyze("1294")[0]!;
  assert.equal(report.relationship.contractInputCount, 5);
  assert.equal(report.relationship.outputRarity, "rare_special");
  assert.equal(report.relationship.outputCatalogStatus, "resolved");
  assert.equal(report.outputTier.length, 1);
  assert.equal(report.relationship.distinctOutputCount, 1);
  assert.equal(report.relationship.equalCollectionOutcomeProbabilityPct, 100);
  database.close();
});

test("trade-up probability counts distinct outcomes instead of wear-specific good ids", () => {
  const database = new AppDatabase(":memory:");
  database.migrate();
  database.upsertCollection({ id: "5", name: "Glove Case" }, "2026-07-22T00:00:00Z");
  database.replaceCollectionMembers("5", [
    { goodId: "1", name: "M4A4 | Buzz Kill", rarityName: "Covert", referencePrice: 100 },
    { goodId: "2", name: "Sport Gloves | Hedge Maze", rarityName: "Extraordinary", referencePrice: 1000 },
    { goodId: "3", name: "Sport Gloves | Hedge Maze", rarityName: "Extraordinary", referencePrice: 1200 },
    { goodId: "4", name: "Sport Gloves | Pandora's Box", rarityName: "Extraordinary", referencePrice: 2000 },
    { goodId: "5", name: "Sport Gloves | Pandora's Box", rarityName: "Extraordinary", referencePrice: 2400 },
  ], "2026-07-22T00:00:00Z");
  const service = new TradeUpCatalogService({} as never, database);
  const report = service.analyze("1")[0]!;
  assert.equal(report.outputTier.length, 4);
  assert.equal(report.relationship.distinctOutputCount, 2);
  assert.equal(report.relationship.equalCollectionOutcomeProbabilityPct, 50);
  database.close();
});
