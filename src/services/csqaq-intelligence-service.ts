import type { CsQaqClient } from "../adapters/csqaq/client.js";
import type {
  CsQaqCaseCountEntry,
  CsQaqCaseRoiEntry,
  CsQaqHolderRankEntry,
  CsQaqItemIdentity,
  CsQaqSupplyPoint,
} from "../adapters/csqaq/types.js";
import { AppError } from "../core/errors.js";
import type { Evidence } from "../domain/evidence.js";
import {
  joinCaseOverview,
  deduplicateHolderRanking,
  summarizeHolderConcentration,
  summarizeSupplyTrend,
} from "../domain/provider-intelligence.js";
import type { AppDatabase } from "../storage/database.js";

export interface CsQaqHolderReport {
  readonly item: CsQaqItemIdentity;
  readonly coverage: {
    readonly scope: "csqaq_monitored_accounts";
    readonly statementZh: string;
    readonly rawRows: number;
    readonly deduplicatedAccounts: number;
    readonly deduplication: string;
  };
  readonly concentration: ReturnType<typeof summarizeHolderConcentration>;
  readonly ranking: readonly CsQaqHolderRankEntry[];
  readonly evidence: Omit<Evidence<readonly CsQaqHolderRankEntry[]>, "data">;
}

export interface CsQaqSupplyReport {
  readonly item: CsQaqItemIdentity;
  readonly summary: ReturnType<typeof summarizeSupplyTrend>;
  readonly points: readonly CsQaqSupplyPoint[];
  readonly evidence: Omit<Evidence<readonly CsQaqSupplyPoint[]>, "data">;
}

export interface CsQaqCaseOverviewReport {
  readonly items: ReturnType<typeof joinCaseOverview>;
  readonly evidence: readonly Omit<Evidence<unknown>, "data">[];
  readonly limitationZh: string;
}

const CACHE_MINUTES = {
  identity: 30 * 24 * 60,
  holders: 10,
  supply: 25,
  cases: 20,
} as const;

export class CsQaqIntelligenceService {
  readonly #client: CsQaqClient;
  readonly #database: AppDatabase;
  readonly #now: () => Date;

  constructor(client: CsQaqClient, database: AppDatabase, now: () => Date = () => new Date()) {
    this.#client = client;
    this.#database = database;
    this.#now = now;
  }

  async resolveItem(search: string): Promise<CsQaqItemIdentity> {
    const key = `csqaq:identity:${search.trim().toLowerCase()}`;
    const evidence = await this.#cached(key, CACHE_MINUTES.identity, () => this.#client.searchItemIdentities(search));
    const exactHash = evidence.data.find(
      (entry) => entry.marketHashName.toLowerCase() === search.trim().toLowerCase(),
    );
    if (exactHash) return exactHash;
    const exactName = evidence.data.filter((entry) => entry.name === search.trim());
    if (exactName.length === 1) return exactName[0]!;
    if (evidence.data.length === 1) return evidence.data[0]!;
    if (evidence.data.length === 0) {
      throw new AppError("PROVIDER_ERROR", `CSQAQ catalog did not find an item matching: ${search}`);
    }
    throw new AppError("USAGE_ERROR", "Item search is ambiguous; use the exact market_hash_name.", {
      candidates: evidence.data.slice(0, 10).map((entry) => ({
        goodId: entry.goodId,
        name: entry.name,
        marketHashName: entry.marketHashName,
      })),
    });
  }

  async analyzeHolders(search: string, limit = 20): Promise<CsQaqHolderReport> {
    const item = await this.resolveItem(search);
    const evidence = await this.#cached<readonly CsQaqHolderRankEntry[]>(
      `csqaq:holders:${item.goodId}`,
      CACHE_MINUTES.holders,
      () => this.#client.getHolderRanking(item.goodId),
    );
    const ranking = deduplicateHolderRanking(evidence.data);
    return {
      item,
      coverage: {
        scope: "csqaq_monitored_accounts",
        statementZh: "仅代表 CSQAQ 已监控且可观测的公开库存账号，不是全网持有人排行。",
        rawRows: evidence.data.length,
        deduplicatedAccounts: ranking.length,
        deduplication: "同一 SteamID 出现多个监控记录时仅保留最大持有量，避免重复计数。",
      },
      concentration: summarizeHolderConcentration(ranking),
      ranking: ranking.slice(0, normalizeLimit(limit)),
      evidence: evidenceMeta(evidence),
    };
  }

  async analyzeSupply(search: string): Promise<CsQaqSupplyReport> {
    const item = await this.resolveItem(search);
    const evidence = await this.#cached<readonly CsQaqSupplyPoint[]>(
      `csqaq:supply:${item.goodId}`,
      CACHE_MINUTES.supply,
      () => this.#client.getSupplyTrend(item.goodId),
    );
    return {
      item,
      summary: summarizeSupplyTrend(evidence.data),
      points: evidence.data,
      evidence: evidenceMeta(evidence),
    };
  }

  async getCaseOverview(limit = 50): Promise<CsQaqCaseOverviewReport> {
    const counts = await this.#cached<readonly CsQaqCaseCountEntry[]>(
      "csqaq:cases:counts",
      CACHE_MINUTES.cases,
      () => this.#client.getCaseCounts(),
    );
    const roi = await this.#cached<readonly CsQaqCaseRoiEntry[]>(
      "csqaq:cases:roi",
      CACHE_MINUTES.cases,
      () => this.#client.getCaseRoi(),
    );
    const items = [...joinCaseOverview(counts.data, roi.data)]
      .sort((a, b) => (b.openingCounts?.daily ?? 0) - (a.openingCounts?.daily ?? 0))
      .slice(0, normalizeLimit(limit));
    return {
      items,
      evidence: [evidenceMeta(counts), evidenceMeta(roi)],
      limitationZh: "开箱量与回报率均采用 CSQAQ 的统计口径；缺少 good_id 的回报率记录无法关联会被排除，回报率是期望值，不代表单次结果。",
    };
  }

  async #cached<T>(
    key: string,
    ttlMinutes: number,
    load: () => Promise<Evidence<T>>,
  ): Promise<Evidence<T>> {
    const cached = this.#database.getProviderCache<T>(key, this.#now());
    if (cached) return cached;
    const evidence = await load();
    const expiresAt = new Date(new Date(evidence.observedAt).valueOf() + ttlMinutes * 60_000).toISOString();
    this.#database.saveProviderCache(key, "csqaq", evidence, expiresAt);
    return evidence;
  }
}

function evidenceMeta<T>(evidence: Evidence<T>): Omit<Evidence<T>, "data"> {
  return {
    source: evidence.source,
    observedAt: evidence.observedAt,
    confidence: evidence.confidence,
    limitations: evidence.limitations,
  };
}

function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 500) {
    throw new AppError("USAGE_ERROR", "limit must be an integer from 1 to 500.");
  }
  return value;
}
