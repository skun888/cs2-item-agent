import { decodeHex, decodeLink, generateHex, generateLink } from "@csfloat/cs2-inspect-serializer";

import type { SteamDtClient } from "../adapters/steamdt/client.js";
import type { DiyCatalogItem, DiyInspectPreviewResult, DiyRecipe } from "../domain/diy.js";
import type { AppDatabase } from "../storage/database.js";
import type { DiyImageService } from "./diy-image-service.js";

export class DiyInspectService {
  readonly #steamDt: SteamDtClient;
  readonly #database: AppDatabase;
  readonly #images: DiyImageService;

  constructor(
    steamDt: SteamDtClient,
    database: AppDatabase,
    images: DiyImageService,
  ) {
    this.#steamDt = steamDt;
    this.#database = database;
    this.#images = images;
  }

  decode(input: string): Readonly<Record<string, unknown>> {
    return toPlainInspect(decodeInspect(input));
  }

  generateForRecipe(recipe: DiyRecipe): { readonly inspectCode: string; readonly inspectLink: string; readonly decoded: Readonly<Record<string, unknown>> } {
    const skin = this.#database.getDiyCatalogItem(recipe.skinCatalogId);
    if (!skin?.defIndex || skin.paintIndex === undefined) {
      throw new Error("枪皮缺少 defIndex/paintIndex，无法生成真实检视代码；请先补全目录详情。");
    }
    const stickers = recipe.placements.map((placement, index) => {
      const sticker = this.#database.getDiyCatalogItem(placement.stickerCatalogId);
      if (!sticker?.stickerKitId) {
        throw new Error(`贴纸“${placement.name}”缺少 sticker kit ID；请重新补全贴纸目录。`);
      }
      return { slot: index, stickerId: sticker.stickerKitId };
    });
    const paintwear = chooseWear(skin);
    const props = {
      defindex: skin.defIndex,
      paintindex: skin.paintIndex,
      rarity: rarityValue(skin.rarityName),
      paintwear,
      paintseed: 0,
      stickers,
      keychains: [],
      variations: [],
    };
    const inspectCode = generateHex(props);
    return { inspectCode, inspectLink: generateLink(props), decoded: toPlainInspect(decodeHex(inspectCode)) };
  }

  async render(input: { readonly recipeId?: number; readonly inspectCode?: string }): Promise<DiyInspectPreviewResult> {
    let recipe: DiyRecipe | undefined;
    let generated: { readonly inspectCode: string; readonly inspectLink: string; readonly decoded: Readonly<Record<string, unknown>> };
    if (input.inspectCode?.trim()) {
      const decoded = decodeInspect(input.inspectCode);
      const inspectCode = normalizeInspectCode(input.inspectCode);
      generated = {
        inspectCode,
        inspectLink: input.inspectCode.includes("steam://") ? input.inspectCode.trim() : `steam://rungame/730/76561202255233023/+csgo_econ_action_preview ${inspectCode}`,
        decoded: toPlainInspect(decoded),
      };
    } else {
      if (!input.recipeId) throw new Error("recipeId 或 inspectCode 至少需要一个。");
      recipe = this.#database.getDiyRecipe(input.recipeId);
      if (!recipe) throw new Error(`DIY recipe ${input.recipeId} does not exist.`);
      generated = this.generateForRecipe(recipe);
    }
    let evidence: Awaited<ReturnType<SteamDtClient["generateInspectPreview"]>> | undefined;
    let providerError: string | undefined;
    try {
      await this.#steamDt.getInspectWear(generated.inspectLink);
      evidence = await this.#steamDt.generateInspectPreview(generated.inspectLink);
    } catch (error) {
      providerError = error instanceof Error ? error.message : "SteamDT inspect renderer unavailable.";
    }
    const preview = evidence?.data;
    const emptyScreenshots = { front: [] as readonly string[], back: [] as readonly string[], detail: [] as readonly string[] };
    const screenshots = preview?.screenshots ?? emptyScreenshots;
    const screenshotUrls = [...screenshots.front, ...screenshots.detail, ...screenshots.back];
    const pending = Boolean(preview && !preview.sync && preview.taskId);
    if (preview && !pending && screenshotUrls.length === 0) {
      providerError = preview.success
        ? "SteamDT inspect completed but returned no screenshot URLs."
        : "SteamDT inspect completed without a rendered screenshot.";
    }
    const localPreviewPath = screenshotUrls[0]
      ? await this.#images.cacheRenderedPreview(screenshotUrls[0], recipe?.id ? `recipe-${recipe.id}` : `inspect-${Date.now()}`)
      : undefined;
    const result: DiyInspectPreviewResult = {
      source: evidence ? "steamdt:inspect" : "local:inspect-code",
      observedAt: evidence?.observedAt ?? new Date().toISOString(),
      confidence: "verified_source",
      mode: screenshotUrls.length ? "steamdt_game_render" : pending ? "steamdt_pending" : "inspect_code_only",
      inspectCode: generated.inspectCode,
      inspectLink: generated.inspectLink,
      decoded: generated.decoded,
      ...(preview?.taskId ? { taskId: preview.taskId } : {}),
      screenshotUrls,
      ...(localPreviewPath ? { localPreviewPath } : {}),
      ...(providerError ? { providerError } : {}),
      limitations: [
        ...(evidence?.limitations ?? ["SteamDT 开放接口未返回自定义 DIY 游戏截图；检视代码仍可复制到 CS2 中查看真实效果。"]),
        "检视代码中的贴纸槽位、磨损、缩放、旋转和偏移才决定游戏渲染位置；商品图坐标不参与真实渲染。",
        "新自由贴纸位置需要显式 offset/scale/rotation；缺少这些参数时使用 CS2 默认槽位。",
      ],
    };
    if (recipe?.id) this.#database.setDiyRecipeInspectPreview(recipe.id, {
      inspectCode: generated.inspectCode,
      inspectLink: generated.inspectLink,
      preview: result,
      ...(localPreviewPath ? { previewPath: localPreviewPath } : {}),
    });
    return result;
  }
}

function decodeInspect(input: string) {
  const value = input.trim();
  if (!value) throw new Error("inspectCode cannot be empty.");
  return value.includes("steam://") ? decodeLink(value) : decodeHex(normalizeInspectCode(value));
}

function normalizeInspectCode(input: string): string {
  let value = input.trim();
  const marker = "csgo_econ_action_preview";
  const markerIndex = value.indexOf(marker);
  if (markerIndex >= 0) value = value.slice(markerIndex + marker.length);
  value = value.replace(/^%20/i, "").trim();
  if (value.startsWith("A") && /^[A-Fa-f0-9]+$/.test(value.slice(1))) value = value.slice(1);
  if (!/^[A-Fa-f0-9]+$/.test(value) || value.length < 10) throw new Error("无效的 masked inspect 十六进制代码。");
  return value.toUpperCase();
}

function toPlainInspect(value: ReturnType<typeof decodeHex>): Readonly<Record<string, unknown>> {
  return {
    ...(value.defindex !== undefined ? { defIndex: value.defindex } : {}),
    ...(value.paintindex !== undefined ? { paintIndex: value.paintindex } : {}),
    ...(value.rarity !== undefined ? { rarity: value.rarity } : {}),
    ...(value.quality !== undefined ? { quality: value.quality } : {}),
    ...(value.paintwear !== undefined ? { paintWear: value.paintwear } : {}),
    ...(value.paintseed !== undefined ? { paintSeed: value.paintseed } : {}),
    stickers: value.stickers.map((sticker) => ({
      ...(sticker.slot !== undefined ? { slot: sticker.slot } : {}),
      ...(sticker.stickerId !== undefined ? { stickerId: sticker.stickerId } : {}),
      ...(sticker.wear !== undefined ? { wear: sticker.wear } : {}),
      ...(sticker.scale !== undefined ? { scale: sticker.scale } : {}),
      ...(sticker.rotation !== undefined ? { rotation: sticker.rotation } : {}),
      ...(sticker.offsetX !== undefined ? { offsetX: sticker.offsetX } : {}),
      ...(sticker.offsetY !== undefined ? { offsetY: sticker.offsetY } : {}),
      ...(sticker.offsetZ !== undefined ? { offsetZ: sticker.offsetZ } : {}),
    })),
  };
}

function chooseWear(skin: DiyCatalogItem): number {
  const minimum = skin.minimumFloat ?? 0;
  const maximum = skin.maximumFloat ?? Math.max(0.07, minimum);
  return Math.min(maximum, minimum + Math.min(0.001, Math.max(0, maximum - minimum) / 10));
}

function rarityValue(name: string | undefined): number {
  const value = name?.toLowerCase() ?? "";
  if (value.includes("违禁") || value.includes("contraband")) return 7;
  if (value.includes("隐秘") || value.includes("covert")) return 6;
  if (value.includes("保密") || value.includes("classified")) return 5;
  if (value.includes("受限") || value.includes("restricted")) return 4;
  if (value.includes("军规") || value.includes("mil-spec")) return 3;
  if (value.includes("工业") || value.includes("industrial")) return 2;
  return 1;
}
