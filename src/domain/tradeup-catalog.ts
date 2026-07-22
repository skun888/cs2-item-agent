export const TRADEUP_RARITIES = [
  "consumer",
  "industrial",
  "mil_spec",
  "restricted",
  "classified",
  "covert",
  "rare_special",
] as const;

export type TradeUpRarity = (typeof TRADEUP_RARITIES)[number];

const RARITY_ALIASES: readonly [TradeUpRarity, readonly string[]][] = [
  ["consumer", ["consumer", "consumer grade", "消费级", "普通级"]],
  ["industrial", ["industrial", "industrial grade", "工业级"]],
  ["mil_spec", ["mil-spec", "mil spec", "mil-spec grade", "军规级"]],
  ["restricted", ["restricted", "受限"]],
  ["classified", ["classified", "保密"]],
  ["covert", ["covert", "隐秘"]],
  ["rare_special", ["extraordinary", "rare special", "非凡"]],
];

export function normalizeRarityRank(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const index = RARITY_ALIASES.findIndex(([, aliases]) => aliases.some((alias) => normalized.includes(alias)));
  return index >= 0 ? index : undefined;
}

export function rarityAtRank(rank: number): TradeUpRarity | undefined {
  return TRADEUP_RARITIES[rank];
}

export interface TradeUpCatalogMember {
  readonly goodId: string;
  readonly name: string;
  readonly rarityName: string;
  readonly rarityRank?: number;
  readonly referencePrice?: number;
  readonly qualityClass?: "regular" | "stattrak" | "souvenir";
}

export interface TradeUpRelationshipReport {
  readonly item: TradeUpCatalogMember;
  readonly collection: { readonly id: string; readonly name: string; readonly comment?: string };
  readonly inputTier: readonly TradeUpCatalogMember[];
  readonly outputTier: readonly TradeUpCatalogMember[];
  readonly relationship: {
    readonly contractInputCount: 5 | 10;
    readonly eligible: boolean;
    readonly ineligibleReason?: string;
    readonly inputRole: "input" | "terminal" | "unknown";
    readonly outputRarity?: TradeUpRarity;
    readonly outputQuality?: "regular" | "stattrak";
    readonly outputCatalogStatus: "resolved" | "base_collection_required" | "not_applicable";
    readonly distinctOutputCount?: number;
    readonly equalCollectionOutcomeProbabilityPct?: number;
  };
  readonly limitations: readonly string[];
}
