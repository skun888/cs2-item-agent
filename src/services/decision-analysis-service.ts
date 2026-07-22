import { AppError } from "../core/errors.js";
import type { AnalysisConfidence, MarketAnalysisReport } from "../domain/market-analysis.js";
import {
  assessMarketTrading,
  type MarketTradingAssessment,
  type MarketTradingContext,
} from "../domain/market-trading-model.js";
import type { CsQaqHolderReport, CsQaqSupplyReport } from "./csqaq-intelligence-service.js";
import type { AnalyzeMarketRequest } from "./market-service.js";
import type { SectorService } from "./sector-service.js";
import type { TradeUpCatalogService } from "./tradeup-catalog-service.js";

export interface DecisionMarketService {
  analyze(request: AnalyzeMarketRequest): Promise<MarketAnalysisReport>;
}

export interface DecisionCsQaqService {
  analyzeHolders(search: string, limit?: number): Promise<CsQaqHolderReport>;
  analyzeSupply(search: string): Promise<CsQaqSupplyReport>;
}

export interface DecisionAnalysisRequest {
  readonly marketHashName: string;
  readonly platform?: string;
  readonly klineType?: number;
  readonly includeBroadMarket?: boolean;
  readonly includeHolderCoverage?: boolean;
  readonly includeSupplyTrend?: boolean;
  readonly expertContext?: MarketTradingContext;
  readonly sectorReference?: string;
  readonly sectorWindowDays?: number;
  readonly includeLocalTradeUp?: boolean;
}

export interface OptionalIntelligence<T> {
  readonly status: "available" | "not_configured" | "unavailable" | "not_requested";
  readonly data?: T;
  readonly reason?: string;
}

export interface ItemDecisionReport {
  readonly model: {
    readonly type: "market_trading";
    readonly version: 1;
  };
  readonly marketHashName: string;
  readonly generatedAt: string;
  readonly market: MarketAnalysisReport;
  readonly holderCoverage: OptionalIntelligence<CsQaqHolderReport>;
  readonly supplyTrend: OptionalIntelligence<Omit<CsQaqSupplyReport, "points">>;
  readonly marketTrading: MarketTradingAssessment;
  readonly decisionFrame: {
    readonly confidence: AnalysisConfidence;
    readonly conclusionZh: string;
    readonly verifiedFacts: readonly string[];
    readonly supportingSignals: readonly string[];
    readonly riskSignals: readonly string[];
    readonly unknowns: readonly string[];
    readonly prohibitedClaims: readonly string[];
  };
}

export interface DecisionReportStore {
  saveDecisionReport(input: {
    readonly reportType: string;
    readonly marketHashName?: string;
    readonly generatedAt: string;
    readonly confidence: string;
    readonly report: unknown;
  }): void;
}

export class DecisionAnalysisService {
  readonly #market: DecisionMarketService;
  readonly #csqaq: DecisionCsQaqService | undefined;
  readonly #now: () => Date;
  readonly #store: DecisionReportStore | undefined;
  readonly #sectors: SectorService | undefined;
  readonly #tradeUp: TradeUpCatalogService | undefined;

  constructor(
    market: DecisionMarketService,
    csqaq?: DecisionCsQaqService,
    now: () => Date = () => new Date(),
    store?: DecisionReportStore,
    sectors?: SectorService,
    tradeUp?: TradeUpCatalogService,
  ) {
    this.#market = market;
    this.#csqaq = csqaq;
    this.#now = now;
    this.#store = store;
    this.#sectors = sectors;
    this.#tradeUp = tradeUp;
  }

  async analyze(request: DecisionAnalysisRequest): Promise<ItemDecisionReport> {
    const name = request.marketHashName.trim();
    if (!name) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const marketPromise = this.#market.analyze({
      marketHashName: name,
      platform: request.platform ?? "STEAM",
      type: request.klineType ?? 1,
      includeBroadMarket: request.includeBroadMarket ?? true,
    });

    const holderCoverage = await this.#optionalCsQaq(
      request.includeHolderCoverage ?? true,
      () => this.#csqaq!.analyzeHolders(name, 10),
    );
    const supplyRaw = await this.#optionalCsQaq(
      request.includeSupplyTrend ?? true,
      () => this.#csqaq!.analyzeSupply(name),
    );
    const supplyTrend: ItemDecisionReport["supplyTrend"] = supplyRaw.data
      ? {
          status: "available",
          data: {
            item: supplyRaw.data.item,
            summary: supplyRaw.data.summary,
            evidence: supplyRaw.data.evidence,
          },
        }
      : supplyRaw;
    const market = await marketPromise;
    const context = await this.#buildContext(request, name);
    const marketTrading = assessMarketTrading({
      market,
      holderStatus: holderCoverage.status,
      ...(holderCoverage.data ? { holders: holderCoverage.data.concentration } : {}),
      supplyStatus: supplyTrend.status,
      ...(supplyTrend.data ? { supply: supplyTrend.data.summary } : {}),
      ...(context ? { context } : {}),
    });
    const decisionFrame = buildDecisionFrame(market, holderCoverage, supplyTrend);
    const report: ItemDecisionReport = {
      model: { type: "market_trading", version: 1 },
      marketHashName: name,
      generatedAt: this.#now().toISOString(),
      market,
      holderCoverage,
      supplyTrend,
      marketTrading,
      decisionFrame,
    };
    this.#store?.saveDecisionReport({
      reportType: "market_trading",
      marketHashName: name,
      generatedAt: report.generatedAt,
      confidence: report.decisionFrame.confidence,
      report,
    });
    return report;
  }

  async #buildContext(request: DecisionAnalysisRequest, name: string): Promise<MarketTradingContext | undefined> {
    const base = request.expertContext ?? {};
    let sector = base.sector;
    if (request.sectorReference && this.#sectors) {
      sector = await this.#sectors.context(request.sectorReference, request.sectorWindowDays ?? 15);
    }
    let tradeUp = base.tradeUp;
    if (!tradeUp && (request.includeLocalTradeUp ?? true) && this.#tradeUp) {
      try {
        const relationship = this.#tradeUp.analyze(name)[0];
        if (relationship && relationship.relationship.inputRole !== "unknown") {
          const outputFamilies = groupTradeUpOutputs(relationship.outputTier);
          tradeUp = {
            role: relationship.relationship.inputRole === "terminal" ? "output" : "input",
            contractInputCount: relationship.relationship.contractInputCount,
            inputItems: relationship.inputTier.map((item) => item.name),
            outputItems: outputFamilies.map((family) => ({
              name: family.name,
              ...(relationship.relationship.equalCollectionOutcomeProbabilityPct !== undefined
                ? { probability: relationship.relationship.equalCollectionOutcomeProbabilityPct / 100 }
                : {}),
              ...(family.referencePrice !== undefined ? { referencePrice: family.referencePrice } : {}),
            })),
            provenance: { sourceType: "provider_data", label: `本地收藏品数据库：${relationship.collection.name}` },
          };
        }
      } catch {
        // Missing local catalog is an unknown, not an analysis failure.
      }
    }
    return sector || tradeUp || Object.keys(base).length > 0 ? { ...base, ...(sector ? { sector } : {}), ...(tradeUp ? { tradeUp } : {}) } : undefined;
  }

  async #optionalCsQaq<T>(requested: boolean, action: () => Promise<T>): Promise<OptionalIntelligence<T>> {
    if (!requested) return { status: "not_requested" };
    if (!this.#csqaq) return { status: "not_configured", reason: "CSQAQ_API_TOKEN is not configured." };
    try {
      return { status: "available", data: await action() };
    } catch (error) {
      return {
        status: "unavailable",
        reason: error instanceof AppError ? `${error.code}: ${error.message}` : "CSQAQ intelligence request failed.",
      };
    }
  }
}

function groupTradeUpOutputs(
  items: readonly { readonly name: string; readonly referencePrice?: number }[],
): readonly { readonly name: string; readonly referencePrice?: number }[] {
  const groups = new Map<string, { name: string; prices: number[]; count: number }>();
  for (const item of items) {
    const key = item.name.trim().toLocaleLowerCase("zh-CN");
    const group = groups.get(key) ?? { name: item.name, prices: [], count: 0 };
    group.count += 1;
    if (item.referencePrice !== undefined) group.prices.push(item.referencePrice);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    name: group.name,
    ...(group.count === 1 && group.prices.length === 1 ? { referencePrice: group.prices[0] } : {}),
  }));
}

function buildDecisionFrame(
  market: MarketAnalysisReport,
  holders: ItemDecisionReport["holderCoverage"],
  supply: ItemDecisionReport["supplyTrend"],
): ItemDecisionReport["decisionFrame"] {
  const facts: string[] = [];
  const supporting: string[] = [];
  const risks: string[] = [];
  const unknowns: string[] = [];
  const lowest = market.currentMarket.lowestListing;
  if (lowest) facts.push(`当前有效最低在售价为 ${lowest.platform} ¥${lowest.price}。`);
  const bid = market.currentMarket.highestBid;
  if (bid) facts.push(`当前有效最高求购价为 ${bid.platform} ¥${bid.price}。`);
  const sevenDay = market.trend.returnsPct.days7;
  if (sevenDay !== undefined) {
    facts.push(`所选 K 线近 7 日收益为 ${signed(sevenDay)}%。`);
    if (sevenDay >= 3) supporting.push("近 7 日价格动量为正。");
    if (sevenDay <= -3) risks.push("近 7 日价格动量为负。");
  } else unknowns.push("K 线不足以计算近 7 日收益。");
  if (market.relativeMarket.relativeStrength7dPctPoints !== undefined) {
    const strength = market.relativeMarket.relativeStrength7dPctPoints;
    facts.push(`近 7 日相对大盘强弱为 ${signed(strength)} 个百分点。`);
    if (strength > 0) supporting.push("单品近 7 日表现强于所选大盘指数。");
    if (strength < 0) risks.push("单品近 7 日表现弱于所选大盘指数。");
  } else unknowns.push("缺少可比大盘或单品数据，无法计算相对强弱。");
  const ratio = market.currentMarket.visibleDemandSupplyRatio;
  if (ratio !== undefined) {
    facts.push(`跨平台可见求购量/在售量比为 ${ratio}。`);
    if (ratio >= 1) supporting.push("可见求购数量不低于可见在售数量，但跨平台可能重复统计。");
    if (ratio < 0.5) risks.push("可见求购数量明显低于可见在售数量。");
  } else unknowns.push("盘口数量不完整，无法计算可见供需比。");
  const volatility = market.trend.estimatedDailyVolatility7dPct;
  if (volatility !== undefined && volatility >= 8) risks.push(`估算日波动率较高（${volatility}%）。`);

  if (holders.status === "available" && holders.data) {
    const c = holders.data.concentration;
    facts.push(`CSQAQ 去重监控样本内 Top 10 持有占比为 ${c.top10SharePct}%（${c.observedAccounts} 个账号）。`);
    if (c.top10SharePct >= 50) risks.push("CSQAQ 监控样本内持仓高度集中，需关注大户转仓或抛售风险。");
  } else unknowns.push(`持有人覆盖数据${statusReason(holders)}。`);

  if (supply.status === "available" && supply.data) {
    const s = supply.data.summary;
    if (s.currentQuantity !== undefined) facts.push(`CSQAQ 当前存世量统计为 ${s.currentQuantity}。`);
    if (s.change30dPct !== undefined) {
      facts.push(`CSQAQ 存世量近 30 日变化为 ${signed(s.change30dPct)}%。`);
      if (s.change30dPct >= 1) risks.push("提供方存世量近 30 日增加，稀缺性没有增强。");
    }
  } else unknowns.push(`存世量趋势${statusReason(supply)}。`);

  unknowns.push("真实成交量、未来七日新信息和具体挂单成交概率不在本报告证据中。");
  const confidence = adjustConfidence(market.dataQuality.confidence, holders.status, supply.status);
  const conclusionZh = risks.length > supporting.length
    ? "当前风险信号多于支持信号，适合继续观察并核对流动性，不宜仅凭账面涨幅作决定。"
    : supporting.length > risks.length
      ? "当前支持信号较多，但仍需结合费率、成交深度和七日保护期情景，不构成买入建议。"
      : "当前支持与风险信号接近，证据不足以形成方向性结论。";
  return {
    confidence,
    conclusionZh,
    verifiedFacts: facts,
    supportingSignals: supporting,
    riskSignals: risks,
    unknowns,
    prohibitedClaims: [
      "不得把 CSQAQ 监控样本称为全网持有人。",
      "不得把公开库存消失称为已卖出。",
      "不得把情景评估称为准确预测、稳赚或无风险套利。",
    ],
  };
}

function adjustConfidence(
  market: AnalysisConfidence,
  holderStatus: OptionalIntelligence<unknown>["status"],
  supplyStatus: OptionalIntelligence<unknown>["status"],
): AnalysisConfidence {
  const score = { low: 0, medium: 1, high: 2 }[market]
    - (holderStatus === "unavailable" ? 1 : 0)
    - (supplyStatus === "unavailable" ? 1 : 0);
  return score >= 2 ? "high" : score >= 1 ? "medium" : "low";
}

function statusReason(value: OptionalIntelligence<unknown>): string {
  return value.status === "not_configured"
    ? "未配置"
    : value.status === "not_requested"
      ? "未请求"
      : value.status === "unavailable"
        ? `不可用（${value.reason ?? "未知原因"}）`
        : "未知";
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value}`;
}
