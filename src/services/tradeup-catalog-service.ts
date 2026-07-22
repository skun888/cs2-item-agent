import type { CsQaqClient } from "../adapters/csqaq/client.js";
import { AppError } from "../core/errors.js";
import { rarityAtRank, type TradeUpCatalogMember, type TradeUpRelationshipReport } from "../domain/tradeup-catalog.js";
import type { AppDatabase } from "../storage/database.js";

export class TradeUpCatalogService {
  constructor(
    private readonly client: CsQaqClient,
    private readonly database: AppDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async sync(input: { readonly search?: string; readonly limit?: number } = {}): Promise<unknown> {
    const collections = await this.client.getCollections();
    const filter = input.search?.trim().toLowerCase();
    const selected = collections.data
      .filter((collection) => !filter || collection.name.toLowerCase().includes(filter) || collection.comment?.toLowerCase().includes(filter))
      .sort((left, right) => Number(isSouvenirCollection(left)) - Number(isSouvenirCollection(right)))
      .slice(0, Math.min(Math.max(input.limit ?? 20, 1), 100));
    const failures: { id: string; name: string; reason: string; details?: Readonly<Record<string, unknown>> }[] = [];
    let memberCount = 0;
    for (const collection of selected) {
      this.database.upsertCollection(collection, collections.observedAt);
      try {
        const members = await this.client.getCollectionItems(collection.id);
        this.database.replaceCollectionMembers(collection.id, members.data, members.observedAt);
        memberCount += members.data.length;
      } catch (error) {
        failures.push({
          id: collection.id,
          name: collection.name,
          reason: error instanceof Error ? error.message : "unknown error",
          ...(error instanceof AppError && error.details ? { details: error.details } : {}),
        });
      }
    }
    return {
      generatedAt: this.now().toISOString(),
      providerCollectionCount: collections.data.length,
      selectedCollectionCount: selected.length,
      syncedCollections: selected.map((collection) => ({ id: collection.id, name: collection.name, comment: collection.comment })),
      syncedMemberCount: memberCount,
      failures,
      limitations: ["同步受 CSQAQ 速率限制；可用 --search 和 --limit 分批建立本地目录。"],
    };
  }

  analyze(search: string): readonly TradeUpRelationshipReport[] {
    const rows = this.database.searchCollectionMembers(search);
    if (rows.length === 0) throw new AppError("USAGE_ERROR", "本地收藏品数据库没有该饰品，请先运行 collection sync。", { search });
    return rows.map((row) => this.buildRelationship(row));
  }

  private buildRelationship(row: Readonly<Record<string, unknown>>): TradeUpRelationshipReport {
    const rank = row.rarity_rank === null || row.rarity_rank === undefined ? undefined : Number(row.rarity_rank);
    const collectionId = String(row.provider_collection_id);
    const qualityClass = classifyQuality(row);
    const terminal = rank !== undefined && rank >= 6;
    const eligible = rank !== undefined && !terminal;
    const contractInputCount = rank === 5 ? 5 : 10;
    const inputTier = rank === undefined
      ? []
      : this.database.listCollectionTier(collectionId, rank).filter((member) => classifyQuality(member) === qualityClass).map(memberFromRow);
    const outputQuality = qualityClass === "stattrak" ? "stattrak" : "regular";
    const outputNeedsBaseCollection = qualityClass === "souvenir" && eligible;
    const outputTier = !eligible || outputNeedsBaseCollection
      ? []
      : this.database.listCollectionTier(collectionId, rank + 1)
        .filter((member) => classifyQuality(member) === outputQuality)
        .map(memberFromRow);
    const distinctOutputCount = new Set(outputTier.map((member) => normalizeOutcomeName(member.name))).size;
    return {
      item: memberFromRow(row),
      collection: {
        id: collectionId,
        name: String(row.collection_name),
        ...(typeof row.collection_comment === "string" ? { comment: row.collection_comment } : {}),
      },
      inputTier,
      outputTier,
      relationship: {
        contractInputCount,
        eligible,
        ...(terminal ? { ineligibleReason: "稀有特殊物品是当前汰换终点。" } : {}),
        ...(rank === undefined ? { ineligibleReason: "无法识别该饰品的稀有度。" } : {}),
        inputRole: rank === undefined ? "unknown" : terminal ? "terminal" : "input",
        ...(eligible ? { outputRarity: rarityAtRank(rank + 1)!, outputQuality } : {}),
        outputCatalogStatus: outputNeedsBaseCollection ? "base_collection_required" : eligible ? "resolved" : "not_applicable",
        ...(distinctOutputCount > 0
          ? {
              distinctOutputCount,
              equalCollectionOutcomeProbabilityPct: round(100 / distinctOutputCount),
            }
          : {}),
      },
      limitations: [
        "这里只证明同收藏品相邻稀有度关系；实际汰换概率还取决于所需输入物品的收藏品构成。",
        "尚未按具体磨损区间计算产出磨损，也未把参考价当作可成交价。",
        "普通隐秘以下通常为十件合同；隐秘到稀有特殊物品使用五件合同，两者不得混用。",
        "纪念品自 2026-05-20 起可参与合同，但纪念属性会移除并产出普通品质；未映射基础收藏品时不生成输出价格篮子。",
      ],
    };
  }
}

function isSouvenirCollection(collection: { readonly name: string; readonly comment?: string }): boolean {
  return /纪念|souvenir|major|纪念包/i.test(`${collection.name} ${collection.comment ?? ""}`);
}

function classifyQuality(row: Readonly<Record<string, unknown>>): "regular" | "stattrak" | "souvenir" {
  const text = `${String(row.name ?? "")} ${String(row.quality_name ?? "")}`;
  if (/纪念品|souvenir/i.test(text)) return "souvenir";
  if (/stattrak/i.test(text)) return "stattrak";
  return "regular";
}

function memberFromRow(row: Readonly<Record<string, unknown>>): TradeUpCatalogMember {
  return {
    goodId: String(row.provider_good_id),
    name: String(row.name),
    rarityName: String(row.rarity_name),
    ...(row.rarity_rank !== null && row.rarity_rank !== undefined ? { rarityRank: Number(row.rarity_rank) } : {}),
    ...(row.reference_price !== null && row.reference_price !== undefined ? { referencePrice: Number(row.reference_price) } : {}),
    qualityClass: classifyQuality(row),
  };
}

function round(value: number): number { return Math.round(value * 10_000) / 10_000; }

function normalizeOutcomeName(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}
