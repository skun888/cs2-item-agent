import type { CsQaqClient } from "../adapters/csqaq/client.js";
import {
  buildDiyRecommendations,
  classifyDiyCatalogKind,
  type DiyCatalogItem,
  type DiyFeedbackInput,
  type DiyPreferenceProfile,
  type DiyRecipe,
  type DiyStyle,
} from "../domain/diy.js";
import type { AppDatabase } from "../storage/database.js";
import type { DiyImageService } from "./diy-image-service.js";
import type { CsSchemaClient } from "../adapters/cs-schema/client.js";
import type { DiyInspectService } from "./diy-inspect-service.js";

export class DiyService {
  readonly #client: CsQaqClient;
  readonly #database: AppDatabase;
  readonly #images: DiyImageService;
  readonly #now: () => Date;
  readonly #schema: CsSchemaClient | undefined;
  readonly #inspect: DiyInspectService | undefined;

  constructor(
    client: CsQaqClient,
    database: AppDatabase,
    images: DiyImageService,
    now: () => Date = () => new Date(),
    schema?: CsSchemaClient,
    inspect?: DiyInspectService,
  ) {
    this.#client = client;
    this.#database = database;
    this.#images = images;
    this.#now = now;
    this.#schema = schema;
    this.#inspect = inspect;
  }

  async syncCatalog(search: string, pages = 1, pageSize = 50): Promise<{
    readonly imported: number;
    readonly providerTotal: number;
    readonly pagesFetched: number;
    readonly limitations: readonly string[];
  }> {
    const safePages = requireIntegerRange(pages, 1, 20, "pages");
    const safePageSize = requireIntegerRange(pageSize, 1, 100, "pageSize");
    let imported = 0;
    let providerTotal = 0;
    let pagesFetched = 0;
    for (let page = 1; page <= safePages; page += 1) {
      const evidence = await this.#client.searchItemIdentityPage(search, page, safePageSize);
      providerTotal = evidence.data.total;
      pagesFetched += 1;
      for (const identity of evidence.data.items) {
        const existing = this.#database.searchDiyCatalog({ search: identity.marketHashName, limit: 10 })
          .find((item) => item.marketHashName === identity.marketHashName);
        const now = this.#now().toISOString();
        this.#database.upsertDiyCatalogItem({
          provider: "csqaq",
          goodId: identity.goodId,
          marketHashName: identity.marketHashName,
          name: identity.name,
          kind: classifyDiyCatalogKind(identity.marketHashName),
          palette: existing?.palette ?? [],
          visualTags: existing?.visualTags ?? [],
          sourceObservedAt: evidence.observedAt,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
        imported += 1;
      }
      if (page * safePageSize >= evidence.data.total || evidence.data.items.length === 0) break;
    }
    return {
      imported,
      providerTotal,
      pagesFetched,
      limitations: ["只导入本次搜索命中的 CSQAQ 分页目录，不代表完整 CS2 商品全集。", "目录同步不证明商品当前在售。"],
    };
  }

  async enrichCatalog(input: { readonly search?: string; readonly kind?: DiyCatalogItem["kind"]; readonly limit?: number }): Promise<{
    readonly attempted: number;
    readonly enriched: number;
    readonly imageFailures: number;
    readonly items: readonly DiyCatalogItem[];
  }> {
    const requestedLimit = requireIntegerRange(input.limit ?? 20, 1, 100, "limit");
    const candidates = [...this.#database.searchDiyCatalog({
      ...(input.search ? { search: input.search } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      limit: input.search ? Math.min(1000, Math.max(50, requestedLimit * 5)) : requestedLimit,
    })].sort((a, b) => input.search
      ? exactMatchRank(a.marketHashName, input.search) - exactMatchRank(b.marketHashName, input.search)
      : 0).slice(0, requestedLimit);
    let enriched = 0;
    let imageFailures = 0;
    const items: DiyCatalogItem[] = [];
    const stickerKits = this.#schema && candidates.some((item) => item.kind === "sticker")
      ? await this.#schema.getStickerKits()
      : [];
    if (stickerKits.length) this.#database.applyDiyStickerKitCatalog(stickerKits);
    const kitByName = new Map(stickerKits.map((entry) => [entry.marketHashName.toLowerCase(), entry.stickerKitId]));
    for (const item of candidates) {
      const evidence = await this.#client.getItemDetail(item.goodId);
      const detail = evidence.data;
      let visual: Awaited<ReturnType<DiyImageService["analyzeRemoteImage"]>> | undefined;
      if (detail.imageUrl) {
        try { visual = await this.#images.analyzeRemoteImage(detail.imageUrl, detail.goodId); }
        catch { imageFailures += 1; }
      }
      const now = this.#now().toISOString();
      const updated: DiyCatalogItem = {
        ...item,
        name: detail.name,
        marketHashName: detail.marketHashName,
        kind: classifyDiyCatalogKind(detail.marketHashName),
        ...(detail.imageUrl ? { imageUrl: detail.imageUrl } : {}),
        ...(detail.typeName ? { typeName: detail.typeName } : {}),
        ...(detail.rarityName ? { rarityName: detail.rarityName } : {}),
        ...(detail.exteriorName ? { exteriorName: detail.exteriorName } : {}),
        ...(detail.defIndex !== undefined ? { defIndex: detail.defIndex } : {}),
        ...(detail.paintIndex !== undefined ? { paintIndex: detail.paintIndex } : {}),
        ...(kitByName.get(detail.marketHashName.toLowerCase()) !== undefined
          ? { stickerKitId: kitByName.get(detail.marketHashName.toLowerCase())! }
          : item.stickerKitId !== undefined ? { stickerKitId: item.stickerKitId } : {}),
        ...(detail.minimumFloat !== undefined ? { minimumFloat: detail.minimumFloat } : {}),
        ...(detail.maximumFloat !== undefined ? { maximumFloat: detail.maximumFloat } : {}),
        ...(detail.buffSellPrice !== undefined ? { buffSellPrice: detail.buffSellPrice } : {}),
        ...(detail.yyypSellPrice !== undefined ? { yyypSellPrice: detail.yyypSellPrice } : {}),
        ...(detail.steamSellPrice !== undefined ? { steamSellPrice: detail.steamSellPrice } : {}),
        ...(visual ?? { palette: item.palette, visualTags: item.visualTags }),
        sourceObservedAt: evidence.observedAt,
        enrichedAt: now,
        updatedAt: now,
      };
      const id = this.#database.upsertDiyCatalogItem(updated);
      items.push({ ...updated, id });
      enriched += 1;
    }
    return { attempted: candidates.length, enriched, imageFailures, items };
  }

  searchCatalog(input: Parameters<AppDatabase["searchDiyCatalog"]>[0]): readonly DiyCatalogItem[] {
    return this.#database.searchDiyCatalog(input);
  }

  recommend(input: { readonly skin: string; readonly style: DiyStyle; readonly budget?: number; readonly slotCount?: number; readonly resultCount?: number }): readonly DiyRecipe[] {
    const skins = this.#database.searchDiyCatalog({ search: input.skin, kind: "skin", enrichedOnly: true, limit: 50 });
    const skin = skins.find((item) => item.marketHashName.toLowerCase() === input.skin.toLowerCase()) ?? skins[0];
    if (!skin) throw new Error("未找到已补全的枪皮目录项；请先同步并 enrich 该枪皮。");
    const stickers = this.#database.searchDiyCatalog({ kind: "sticker", enrichedOnly: true, limit: 1000 });
    if (!stickers.length) throw new Error("没有已补全的贴纸目录；请先同步并 enrich 贴纸。");
    const recipes = buildDiyRecommendations({
      skin,
      stickers,
      style: input.style,
      ...(input.budget !== undefined ? { budget: requireNonNegative(input.budget, "budget") } : {}),
      slotCount: requireIntegerRange(input.slotCount ?? 4, 1, 5, "slotCount"),
      preferences: this.#database.getDiyPreferenceProfile(),
      now: this.#now(),
    }).slice(0, requireIntegerRange(input.resultCount ?? 3, 1, 3, "resultCount"));
    return recipes.map((recipe) => ({ ...recipe, id: this.#database.saveDiyRecipe(recipe) }));
  }

  async renderPreview(recipeId: number): Promise<unknown> {
    if (!this.#inspect) throw new Error("Inspect-code preview is not configured; generic SVG overlays are not a valid DIY result.");
    return this.#inspect.render({ recipeId });
  }

  async renderInspectCode(inspectCode: string): Promise<unknown> {
    if (!this.#inspect) throw new Error("SteamDT inspect renderer is not configured.");
    return this.#inspect.render({ inspectCode });
  }

  decodeInspectCode(inspectCode: string): Readonly<Record<string, unknown>> {
    if (!this.#inspect) throw new Error("Inspect decoder is not configured.");
    return this.#inspect.decode(inspectCode);
  }

  recordFeedback(input: DiyFeedbackInput): { readonly feedbackId: number; readonly preferences: DiyPreferenceProfile } {
    requireIntegerRange(input.rating, 1, 5, "rating");
    if (!this.#database.getDiyRecipe(input.recipeId)) throw new Error(`DIY recipe ${input.recipeId} does not exist.`);
    const feedbackId = this.#database.saveDiyFeedback(input, this.#now());
    return { feedbackId, preferences: this.#database.getDiyPreferenceProfile() };
  }

  getPreferences(): DiyPreferenceProfile { return this.#database.getDiyPreferenceProfile(); }
}

function requireIntegerRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}
function requireNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number.`);
  return value;
}
function exactMatchRank(value: string, search: string): number {
  const normalizedValue = value.trim().toLowerCase();
  const normalizedSearch = search.trim().toLowerCase();
  return normalizedValue === normalizedSearch ? 0 : normalizedValue.startsWith(normalizedSearch) ? 1 : 2;
}
