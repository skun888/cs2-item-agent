import type { CsQaqClient } from "../adapters/csqaq/client.js";
import type { CsQaqHangingEntry, CsQaqHangingQuery } from "../adapters/csqaq/types.js";
import type { SteamDtClient } from "../adapters/steamdt/client.js";
import { AppError } from "../core/errors.js";
import type { Evidence } from "../domain/evidence.js";
import type { LoadedFeeTemplate, PurchasePlatform } from "../domain/fee-template.js";
import {
  assessHangingEntry,
  type HangingTargetBalance,
  type PlatformExitMode,
  type SteamExitMode,
  type SteamPurchaseMode,
} from "../domain/hanging-assessment.js";
import { estimateSevenDayScenarios } from "../domain/seven-day-scenario.js";
import type { AppDatabase } from "../storage/database.js";

export interface HangingServiceInput extends CsQaqHangingQuery {
  readonly targetBalance: HangingTargetBalance;
  readonly sourcePlatform?: PurchasePlatform;
  readonly steamExitMode?: SteamExitMode;
  readonly steamPurchaseMode?: SteamPurchaseMode;
  readonly platformExitMode?: PlatformExitMode;
}

export class HangingService {
  constructor(
    private readonly csqaq: CsQaqClient,
    private readonly steamdt: SteamDtClient | undefined,
    private readonly database: AppDatabase,
    private readonly fees: LoadedFeeTemplate,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async screen(input: HangingServiceInput & {
    readonly limit?: number;
    readonly includeNormallyExcluded?: boolean;
  }): Promise<unknown> {
    const evidence = await this.getCandidates(input);
    const sourcePlatform = input.sourcePlatform ?? "BUFF";
    const cardPrice = input.targetBalance === "platform" ? await this.getLatestCardPrice() : undefined;
    const all = evidence.data.map((entry) => assessHangingEntry({
      entry,
      targetBalance: input.targetBalance,
      sourcePlatform,
      steamExitMode: input.steamExitMode ?? input.steamExit ?? "highest_bid",
      steamPurchaseMode: input.steamPurchaseMode ?? input.steamPurchase ?? "listing",
      platformExitMode: input.platformExitMode ?? input.platformExit ?? "highest_bid",
      ...(cardPrice ? { cardPrice } : {}),
      fees: this.fees,
    }));
    const eligible = input.includeNormallyExcluded ? all : all.filter((item) => item.itemPolicy.defaultCandidatePoolEligible);
    const candidates = eligible
      .sort((a, b) => (b.current?.valuePerCny ?? 0) - (a.current?.valuePerCny ?? 0))
      .slice(0, normalizeLimit(input.limit ?? 20));
    const report = {
      model: { type: "hanging_execution" as const, version: 2 as const, targetBalance: input.targetBalance },
      generatedAt: this.now().toISOString(),
      query: input,
      feeAssumptions: this.fees,
      ...(cardPrice ? { cardPrice } : {}),
      candidates,
      filtering: {
        providerCandidateCount: evidence.data.length,
        eligibleCandidateCount: eligible.length,
        excludedByDefaultCount: all.length - eligible.length,
        invalidQuoteCount: eligible.filter((item) => !item.dataQuality.valid).length,
      },
      evidence: evidenceMeta(evidence),
      limitationZh: "两个余额方向使用不同资金路径和指标；初筛后仍需运行单品七日情景评估。",
    };
    this.database.saveDecisionReport({ reportType: `hanging_screen_${input.targetBalance}`, generatedAt: report.generatedAt, confidence: "medium", report });
    return report;
  }

  async assess(input: HangingServiceInput & {
    readonly marketHashName: string;
    readonly klinePlatform?: string;
    readonly klineType?: number;
  }): Promise<unknown> {
    const evidence = await this.getCandidates(input);
    const entry = evidence.data.find((candidate) => candidate.marketHashName.toLowerCase() === input.marketHashName.trim().toLowerCase());
    if (!entry) throw new AppError("USAGE_ERROR", "The item is not present in the requested CSQAQ hanging candidate page/filter.");
    if (!this.steamdt) throw new AppError("CONFIG_ERROR", "STEAMDT_API_KEY is required for a seven-day hanging assessment.");
    const sourcePlatform = input.sourcePlatform ?? "BUFF";
    const klineQuery = {
      marketHashName: entry.marketHashName,
      platform: input.klinePlatform ?? (input.targetBalance === "steam" ? "STEAM" : sourcePlatform),
      type: input.klineType ?? 1,
    };
    const kline = await this.steamdt.getKline(klineQuery);
    this.database.saveKlineEvidence(entry.marketHashName, klineQuery.platform, klineQuery.type, kline);
    const scenario = estimateSevenDayScenarios(kline.data);
    const cardPrice = input.targetBalance === "platform" ? await this.getLatestCardPrice() : undefined;
    const assessment = assessHangingEntry({
      entry,
      targetBalance: input.targetBalance,
      sourcePlatform,
      steamExitMode: input.steamExitMode ?? input.steamExit ?? "highest_bid",
      steamPurchaseMode: input.steamPurchaseMode ?? input.steamPurchase ?? "listing",
      platformExitMode: input.platformExitMode ?? input.platformExit ?? "highest_bid",
      ...(cardPrice ? { cardPrice } : {}),
      fees: this.fees,
      sevenDayScenario: scenario,
      explicitItemRequest: true,
    });
    const report = {
      model: { type: "hanging_execution" as const, version: 2 as const, targetBalance: input.targetBalance },
      generatedAt: this.now().toISOString(),
      assessment,
      sevenDayScenario: scenario,
      evidence: [evidenceMeta(evidence), evidenceMeta(kline)],
    };
    this.database.saveDecisionReport({ reportType: `hanging_assessment_${input.targetBalance}`, marketHashName: entry.marketHashName, generatedAt: report.generatedAt, confidence: scenario.status === "available" && assessment.dataQuality.valid ? "medium" : "low", report });
    return report;
  }

  private async getCandidates(query: CsQaqHangingQuery): Promise<Evidence<readonly CsQaqHangingEntry[]>> {
    const normalized: CsQaqHangingQuery = {
      pageIndex: query.pageIndex ?? 1,
      targetBalance: query.targetBalance ?? "steam",
      sourcePlatforms: query.sourcePlatforms ?? "BUFF-YYYP",
      steamExit: query.steamExit ?? "highest_bid",
      steamPurchase: query.steamPurchase ?? "listing",
      platformExit: query.platformExit ?? "highest_bid",
      minimumPrice: query.minimumPrice ?? 1,
      maximumPrice: query.maximumPrice ?? 5_000,
      minimumTurnover: query.minimumTurnover ?? 10,
    };
    const cacheKey = `csqaq:hanging:${JSON.stringify(normalized)}`;
    const cached = this.database.getProviderCache<readonly CsQaqHangingEntry[]>(cacheKey, this.now());
    if (cached) return cached;
    const evidence = await this.csqaq.getHangingCandidates(normalized);
    this.database.saveProviderCache(cacheKey, "csqaq", evidence, new Date(new Date(evidence.observedAt).valueOf() + 15 * 60_000).toISOString());
    return evidence;
  }

  private async getLatestCardPrice(): Promise<{ readonly priceCnyPer100Usd: number; readonly recordedAt: string }> {
    const home = await this.csqaq.getMarketHomeData();
    this.database.saveMarketHomeEvidence(home);
    const latest = this.database.getLatestSteamCardPrice();
    if (!latest) throw new AppError("CONTRACT_ERROR", "CSQAQ current_data did not provide a usable Steam card price.");
    return latest;
  }
}

function evidenceMeta<T>(evidence: Evidence<T>): Omit<Evidence<T>, "data"> {
  return { source: evidence.source, observedAt: evidence.observedAt, confidence: evidence.confidence, limitations: evidence.limitations };
}
function normalizeLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 100) throw new AppError("USAGE_ERROR", "limit must be an integer from 1 to 100.");
  return value;
}
