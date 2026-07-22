export type DiyCatalogKind = "skin" | "sticker" | "other";
export type DiyStyle =
  | "minimal"
  | "monochrome"
  | "black_gold"
  | "contrast"
  | "cyberpunk"
  | "esports"
  | "anime";

export interface DiyPaletteColor {
  readonly hex: string;
  readonly weight: number;
}

export interface DiyCatalogItem {
  readonly id?: number;
  readonly provider: "csqaq";
  readonly goodId: string;
  readonly marketHashName: string;
  readonly name: string;
  readonly kind: DiyCatalogKind;
  readonly imageUrl?: string;
  readonly localImagePath?: string;
  readonly typeName?: string;
  readonly rarityName?: string;
  readonly exteriorName?: string;
  readonly defIndex?: number;
  readonly paintIndex?: number;
  readonly stickerKitId?: number;
  readonly minimumFloat?: number;
  readonly maximumFloat?: number;
  readonly buffSellPrice?: number;
  readonly yyypSellPrice?: number;
  readonly steamSellPrice?: number;
  readonly palette: readonly DiyPaletteColor[];
  readonly visualTags: readonly string[];
  readonly brightness?: number;
  readonly saturation?: number;
  readonly complexity?: number;
  readonly sourceObservedAt: string;
  readonly enrichedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DiyStickerPlacement {
  readonly slot: number;
  readonly stickerCatalogId: number;
  readonly marketHashName: string;
  readonly name: string;
  readonly imageUrl?: string;
  readonly localImagePath?: string;
  readonly estimatedPrice?: number;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface DiyRecipe {
  readonly id?: number;
  readonly skinCatalogId: number;
  readonly skinMarketHashName: string;
  readonly skinName: string;
  readonly skinImageUrl?: string;
  readonly skinLocalImagePath?: string;
  readonly style: DiyStyle;
  readonly budget?: number;
  readonly currency: "CNY";
  readonly slotCount: number;
  readonly layout: "uniform" | "accent" | "mixed";
  readonly score: number;
  readonly estimatedStickerCost?: number;
  readonly placements: readonly DiyStickerPlacement[];
  readonly reasons: readonly string[];
  readonly limitations: readonly string[];
  readonly generatedAt: string;
  readonly previewPath?: string;
  readonly inspectCode?: string;
  readonly inspectLink?: string;
}

export interface DiyInspectPreviewResult {
  readonly source: "steamdt:inspect" | "local:inspect-code";
  readonly observedAt: string;
  readonly confidence: "verified_source";
  readonly mode: "steamdt_game_render" | "steamdt_pending" | "inspect_code_only";
  readonly inspectCode: string;
  readonly inspectLink: string;
  readonly decoded: Readonly<Record<string, unknown>>;
  readonly taskId?: string;
  readonly screenshotUrls: readonly string[];
  readonly localPreviewPath?: string;
  readonly providerError?: string;
  readonly limitations: readonly string[];
}

export interface DiyPreferenceProfile {
  readonly sampleCount: number;
  readonly tagWeights: Readonly<Record<string, number>>;
  readonly styleWeights: Readonly<Partial<Record<DiyStyle, number>>>;
  readonly explanation: string;
}

export interface DiyFeedbackInput {
  readonly recipeId: number;
  readonly rating: number;
  readonly selected?: boolean;
  readonly likedTags?: readonly string[];
  readonly dislikedTags?: readonly string[];
  readonly comment?: string;
}

export const DIY_STYLES: readonly DiyStyle[] = [
  "minimal", "monochrome", "black_gold", "contrast", "cyberpunk", "esports", "anime",
];

const STYLE_TAGS: Readonly<Record<DiyStyle, readonly string[]>> = {
  minimal: ["neutral", "low_saturation", "simple", "white", "black", "gray"],
  monochrome: ["neutral", "low_saturation", "black", "white", "gray"],
  black_gold: ["black", "gold", "yellow", "warm", "dark"],
  contrast: ["high_saturation", "bright", "contrast", "red", "cyan", "purple"],
  cyberpunk: ["neon", "high_saturation", "purple", "cyan", "pink", "dark"],
  esports: ["bold", "high_saturation", "red", "blue", "white", "logo"],
  anime: ["bright", "pink", "purple", "cyan", "illustration", "high_saturation"],
};

export function classifyDiyCatalogKind(marketHashName: string): DiyCatalogKind {
  const value = marketHashName.trim().toLowerCase();
  if (value.startsWith("sticker |")) return "sticker";
  if (value.includes(" | ") && !value.startsWith("music kit |") && !value.startsWith("graffiti |") && !value.startsWith("patch |")) {
    return "skin";
  }
  return "other";
}

export function estimateStickerPrice(item: DiyCatalogItem): number | undefined {
  const prices = [item.buffSellPrice, item.yyypSellPrice, item.steamSellPrice]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return prices.length ? Math.min(...prices) : undefined;
}

export function buildDiyRecommendations(input: {
  readonly skin: DiyCatalogItem;
  readonly stickers: readonly DiyCatalogItem[];
  readonly style: DiyStyle;
  readonly budget?: number;
  readonly slotCount: number;
  readonly preferences?: DiyPreferenceProfile;
  readonly now?: Date;
}): readonly DiyRecipe[] {
  if (!input.skin.id) throw new Error("DIY skin must be stored before recommendation.");
  if (!Number.isInteger(input.slotCount) || input.slotCount < 1 || input.slotCount > 5) {
    throw new Error("DIY slot count must be between 1 and 5.");
  }
  const styleTags = STYLE_TAGS[input.style];
  const skinTags = new Set(input.skin.visualTags);
  const candidates = input.stickers
    .filter((item) => item.kind === "sticker" && item.id)
    .map((item) => {
      const price = estimateStickerPrice(item);
      const tags = new Set(item.visualTags);
      const styleMatches = styleTags.filter((tag) => tags.has(tag)).length;
      const shared = item.visualTags.filter((tag) => skinTags.has(tag)).length;
      const preferred = item.visualTags.reduce(
        (sum, tag) => sum + (input.preferences?.tagWeights[tag] ?? 0), 0,
      );
      const budgetFit = input.budget === undefined || price === undefined
        ? 0
        : price * input.slotCount <= input.budget ? 12 : -Math.min(35, (price * input.slotCount - input.budget) / Math.max(input.budget, 1) * 20);
      const complexityFit = typeof item.complexity === "number" && typeof input.skin.complexity === "number"
        ? 6 - Math.abs(item.complexity - (1 - input.skin.complexity)) * 6
        : 0;
      const score = 40 + styleMatches * 9 + shared * (input.style === "contrast" ? -2 : 3) + preferred * 4 + budgetFit + complexityFit;
      const reasons = [
        styleMatches ? `命中 ${styleMatches} 个“${input.style}”风格特征` : "主要依靠色彩关系补足风格",
        shared ? `与枪皮共享 ${shared} 个视觉标签` : "与枪皮形成差异化点缀",
        ...(price === undefined ? ["平台价格缺失，未参与预算过滤"] : [`参考最低价约 ¥${price.toFixed(2)}`]),
      ];
      return { item, price, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) return [];
  const layouts: DiyRecipe["layout"][] = ["uniform", "accent", "mixed"];
  const generatedAt = (input.now ?? new Date()).toISOString();
  return layouts.map((layout, recipeIndex): DiyRecipe => {
    const offset = Math.min(recipeIndex, Math.max(0, candidates.length - 1));
    const chosen = layout === "uniform"
      ? Array.from({ length: input.slotCount }, () => candidates[offset]!)
      : layout === "accent"
        ? Array.from({ length: input.slotCount }, (_, index) => index === Math.floor(input.slotCount / 2)
          ? candidates[offset]!
          : candidates[Math.min(offset + 1, candidates.length - 1)]!)
        : Array.from({ length: input.slotCount }, (_, index) => candidates[(offset + index) % Math.min(candidates.length, 5)]!);
    const costKnown = chosen.every((entry) => entry.price !== undefined);
    const estimatedStickerCost = costKnown ? chosen.reduce((sum, entry) => sum + (entry.price ?? 0), 0) : undefined;
    const budgetPenalty = input.budget !== undefined && estimatedStickerCost !== undefined && estimatedStickerCost > input.budget
      ? Math.min(30, (estimatedStickerCost - input.budget) / Math.max(input.budget, 1) * 20)
      : 0;
    const placements = chosen.map((entry, slot): DiyStickerPlacement => ({
      slot: slot + 1,
      stickerCatalogId: entry.item.id!,
      marketHashName: entry.item.marketHashName,
      name: entry.item.name,
      ...(entry.item.imageUrl ? { imageUrl: entry.item.imageUrl } : {}),
      ...(entry.item.localImagePath ? { localImagePath: entry.item.localImagePath } : {}),
      ...(entry.price !== undefined ? { estimatedPrice: entry.price } : {}),
      score: Math.round(entry.score * 10) / 10,
      reasons: entry.reasons,
    }));
    return {
      skinCatalogId: input.skin.id!,
      skinMarketHashName: input.skin.marketHashName,
      skinName: input.skin.name,
      ...(input.skin.imageUrl ? { skinImageUrl: input.skin.imageUrl } : {}),
      ...(input.skin.localImagePath ? { skinLocalImagePath: input.skin.localImagePath } : {}),
      style: input.style,
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      currency: "CNY",
      slotCount: input.slotCount,
      layout,
      score: Math.round((chosen.reduce((sum, entry) => sum + entry.score, 0) / chosen.length - budgetPenalty) * 10) / 10,
      ...(estimatedStickerCost !== undefined ? { estimatedStickerCost } : {}),
      placements,
      reasons: [
        `${layout} 布局：${layout === "uniform" ? "统一重复，整体性强" : layout === "accent" ? "中部主贴突出视觉焦点" : "多贴混搭，信息量更丰富"}`,
        `规则评分使用颜色、明暗、复杂度、预算与本地反馈偏好。`,
      ],
      limitations: [
        "这是基于商品图的二维审美模拟，不等同于游戏内贴纸槽位、缩放、刮痕或光照效果。",
        "价格取当前可用平台最低报价，不保证实际可成交，也不包含贴纸应用后的折价。",
        "审美评分是透明启发式规则，不是客观事实。",
      ],
      generatedAt,
    };
  }).sort((a, b) => b.score - a.score);
}
