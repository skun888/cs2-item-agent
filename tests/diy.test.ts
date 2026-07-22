import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import { buildDiyRecommendations, type DiyCatalogItem } from "../src/domain/diy.js";
import { DiyImageService } from "../src/services/diy-image-service.js";
import { AppDatabase } from "../src/storage/database.js";
import { DiyInspectService } from "../src/services/diy-inspect-service.js";
import type { SteamDtClient } from "../src/adapters/steamdt/client.js";
import { verifiedEvidence } from "../src/domain/evidence.js";

test("DIY recommendations are deterministic, budget-aware, and feedback stays local", async () => {
  const database = new AppDatabase(":memory:");
  database.migrate();
  const now = "2026-07-21T00:00:00.000Z";
  const skinId = database.upsertDiyCatalogItem(item({
    goodId: "skin-1", marketHashName: "AK-47 | Slate (Factory New)", name: "AK-47 | 墨岩（崭新出厂）",
    kind: "skin", visualTags: ["black", "dark", "simple"], complexity: 0.2,
  }, now));
  const stickerIds = [
    database.upsertDiyCatalogItem(item({ goodId: "sticker-1", marketHashName: "Sticker | Gold Test", name: "金色测试贴纸", kind: "sticker", visualTags: ["gold", "yellow", "warm"], buffSellPrice: 10, complexity: 0.7 }, now)),
    database.upsertDiyCatalogItem(item({ goodId: "sticker-2", marketHashName: "Sticker | Cyan Test", name: "青色测试贴纸", kind: "sticker", visualTags: ["cyan", "neon"], buffSellPrice: 2, complexity: 0.6 }, now)),
  ];
  const skin = database.getDiyCatalogItem(skinId)!;
  const stickers = stickerIds.map((id) => database.getDiyCatalogItem(id)!);
  const recipes = buildDiyRecommendations({ skin, stickers, style: "black_gold", budget: 50, slotCount: 4, now: new Date(now) });
  assert.equal(recipes.length, 3);
  assert.equal(recipes[0]?.placements.length, 4);
  assert.match(recipes[0]?.limitations[0] ?? "", /二维审美模拟/);
  const recipeId = database.saveDiyRecipe(recipes[0]!);
  database.saveDiyFeedback({ recipeId, rating: 5, selected: true, likedTags: ["gold"] }, new Date(now));
  const profile = database.getDiyPreferenceProfile();
  assert.equal(profile.sampleCount, 1);
  assert.ok((profile.tagWeights.gold ?? 0) > 0);
  assert.equal(database.countRows("diy_catalog_items"), 3);
  assert.equal(database.countRows("diy_recipes"), 1);
  assert.equal(database.countRows("diy_feedback"), 1);
  database.close();
});

test("DIY image analysis caches a real raster without fabricating a sticker overlay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cs2-diy-test-"));
  try {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 220, g: 30, b: 180, alpha: 1 } } }).png().toBuffer();
    const service = new DiyImageService(directory, async () => new Response(png, { status: 200, headers: { "content-type": "image/png" } }));
    const visual = await service.analyzeRemoteImage("https://example.invalid/item.png", "item-1");
    assert.ok(visual.palette.length > 0);
    assert.ok(visual.visualTags.includes("pink") || visual.visualTags.includes("red"));
    assert.match(visual.localImagePath, /diy-images/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("masked inspect code exposes real CS2 sticker offsets and wear", () => {
  const inspect = new DiyInspectService({} as SteamDtClient, {} as AppDatabase, {} as DiyImageService);
  const decoded = inspect.decode("csgo_econ_action_preview 001807208B08280438004000620F080010CC3D3D6E39ABBB456E39AB3B620F080010CC3D3D99E7E9BD4559AFC33A6214080010CC3D1D6666663F3DF98071BD4511D1C03AB74F2942");
  assert.equal(decoded.defIndex, 7);
  assert.equal(decoded.paintIndex, 1035);
  const stickers = decoded.stickers as readonly Readonly<Record<string, unknown>>[];
  assert.equal(stickers.length, 3);
  assert.equal(stickers[0]?.stickerId, 7884);
  assert.ok(Number(stickers[0]?.offsetX) < 0);
  assert.ok(Number(stickers[2]?.wear) > 0.89);
});

test("a DIY recipe with sticker kit IDs generates a real masked inspect code", () => {
  const database = new AppDatabase(":memory:");
  database.migrate();
  const now = "2026-07-21T00:00:00.000Z";
  const skinId = database.upsertDiyCatalogItem(item({
    goodId: "skin", marketHashName: "AK-47 | Slate (Factory New)", name: "AK-47 | 墨岩",
    kind: "skin", defIndex: 7, paintIndex: 1035, rarityName: "受限", minimumFloat: 0, maximumFloat: 0.07,
  }, now));
  const stickerId = database.upsertDiyCatalogItem(item({
    goodId: "sticker", marketHashName: "Sticker | Test", name: "测试贴纸", kind: "sticker", stickerKitId: 7884,
  }, now));
  const recipeId = database.saveDiyRecipe({
    skinCatalogId: skinId, skinMarketHashName: "AK-47 | Slate (Factory New)", skinName: "AK-47 | 墨岩",
    style: "black_gold", currency: "CNY", slotCount: 2, layout: "uniform", score: 80,
    placements: [0, 1].map((slot) => ({ slot: slot + 1, stickerCatalogId: stickerId, marketHashName: "Sticker | Test", name: "测试贴纸", score: 80, reasons: [] })),
    reasons: [], limitations: [], generatedAt: now,
  });
  const service = new DiyInspectService({} as SteamDtClient, database, {} as DiyImageService);
  const generated = service.generateForRecipe(database.getDiyRecipe(recipeId)!);
  assert.match(generated.inspectCode, /^00[0-9A-F]+$/);
  const decoded = service.decode(generated.inspectCode);
  assert.equal(decoded.defIndex, 7);
  assert.equal((decoded.stickers as readonly unknown[]).length, 2);
  database.close();
});

test("a completed SteamDT inspect without screenshot URLs falls back to code-only", async () => {
  const steamDt = {
    getInspectWear: async () => verifiedEvidence("steamdt:wear", new Date("2026-07-21T00:00:00.000Z"), {}),
    generateInspectPreview: async () => verifiedEvidence("steamdt:inspect", new Date("2026-07-21T00:00:01.000Z"), {
      sync: true,
      success: false,
      screenshots: { front: [], back: [], detail: [] },
    }),
  } as unknown as SteamDtClient;
  const service = new DiyInspectService(steamDt, {} as AppDatabase, {} as DiyImageService);
  const result = await service.render({ inspectCode: "001807208B08280438004000620F080010CC3D3D6E39ABBB456E39AB3B620F080010CC3D3D99E7E9BD4559AFC33A6214080010CC3D1D6666663F3DF98071BD4511D1C03AB74F2942" });
  assert.equal(result.mode, "inspect_code_only");
  assert.match(result.providerError ?? "", /without a rendered screenshot/);
});

function item(overrides: Partial<DiyCatalogItem> & Pick<DiyCatalogItem, "goodId" | "marketHashName" | "name" | "kind">, now: string): DiyCatalogItem {
  return { provider: "csqaq", palette: [], visualTags: [], sourceObservedAt: now, createdAt: now, updatedAt: now, ...overrides };
}
