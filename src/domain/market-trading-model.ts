import { AppError } from "../core/errors.js";
import type { MarketAnalysisReport, PeriodReturns } from "./market-analysis.js";
import type { HolderConcentrationSummary, SupplyTrendSummary } from "./provider-intelligence.js";

export type MarketContextSourceType = "user_expert" | "manual_provider_observation" | "provider_data";
export type DealerSuitability = "low" | "medium" | "high";
export type TradeUpRole = "input" | "output" | "both";

export interface MarketContextProvenance {
  readonly sourceType: MarketContextSourceType;
  readonly label: string;
  readonly observedAt?: string;
  readonly note?: string;
}

export interface MarketTradingContext {
  readonly sector?: {
    readonly name: string;
    readonly returnPct: number;
    readonly windowDays: number;
    readonly provenance: MarketContextProvenance;
  };
  readonly effectiveCirculatingSupply?: {
    readonly central: number;
    readonly low?: number;
    readonly high?: number;
    readonly provenance: MarketContextProvenance;
  };
  readonly dealerOperation?: {
    readonly suitability: DealerSuitability;
    readonly provenance: MarketContextProvenance;
  };
  readonly tradeUp?: {
    readonly role: TradeUpRole;
    readonly contractInputCount: number;
    readonly inputItems?: readonly string[];
    readonly outputItems?: readonly {
      readonly name: string;
      readonly probability?: number;
      readonly referencePrice?: number;
    }[];
    readonly inputUnitPrice?: number;
    readonly otherCost?: number;
    readonly provenance: MarketContextProvenance;
  };
}

export interface MarketTradingModelInput {
  readonly market: MarketAnalysisReport;
  readonly holderStatus: "available" | "not_configured" | "unavailable" | "not_requested";
  readonly holders?: HolderConcentrationSummary;
  readonly supplyStatus: "available" | "not_configured" | "unavailable" | "not_requested";
  readonly supply?: SupplyTrendSummary;
  readonly context?: MarketTradingContext;
}

export interface MarketTradingAssessment {
  readonly model: {
    readonly type: "market_trading";
    readonly version: 1;
    readonly purposeZh: string;
    readonly notForZh: string;
  };
  readonly marketHashName: string;
  readonly generatedAt: string;
  readonly phase: "constructive" | "watch" | "risk_off" | "insufficient_data";
  readonly role: "dealer_operable" | "ordinary_market_item" | "unknown";
  readonly dimensions: {
    readonly trend: {
      readonly status: MarketAnalysisReport["trend"]["label"];
      readonly returnsPct: PeriodReturns;
    };
    readonly sector: {
      readonly status: "available" | "unknown";
      readonly sectorName?: string;
      readonly sectorReturnPct?: number;
      readonly sectorWindowDays?: number;
      readonly itemComparableReturnPct?: number;
      readonly itemComparableWindowDays?: number;
      readonly relativeStrengthPctPoints?: number;
      readonly windowMismatchDays?: number;
    };
    readonly effectiveFloat: {
      readonly status: "estimated" | "nominal_only" | "unknown";
      readonly nominalSupply?: number;
      readonly estimatedCentral?: number;
      readonly estimatedLow?: number;
      readonly estimatedHigh?: number;
      readonly estimatedCirculatingRatioPct?: number;
      readonly observedTop10Quantity?: number;
      readonly observedTop10ShareOfEstimatedFloatPct?: number;
    };
    readonly holderCoverage: {
      readonly status: MarketTradingModelInput["holderStatus"];
      readonly scope: "csqaq_monitored_accounts" | "unavailable";
      readonly observedAccounts?: number;
      readonly observedQuantity?: number;
      readonly top10ShareInMonitoredSamplePct?: number;
    };
    readonly dealerOperation: {
      readonly status: "expert_annotated" | "unknown";
      readonly suitability?: DealerSuitability;
    };
    readonly tradeUp: {
      readonly status: "economics_available" | "relationship_only" | "unknown";
      readonly role?: TradeUpRole;
      readonly contractInputCount?: number;
      readonly inputCost?: number;
      readonly weightedOutputValue?: number;
      readonly expectedMarginPct?: number;
      readonly probabilitySum?: number;
      readonly pricingLimitation?: string;
    };
  };
  readonly verifiedObservations: readonly string[];
  readonly deterministicCalculations: readonly string[];
  readonly expertAnnotations: readonly string[];
  readonly supportingSignals: readonly string[];
  readonly riskSignals: readonly string[];
  readonly unknowns: readonly string[];
  readonly invalidationSignals: readonly string[];
  readonly conclusionZh: string;
  readonly limitations: readonly string[];
}

export function assessMarketTrading(input: MarketTradingModelInput): MarketTradingAssessment {
  const context = validateContext(input.context);
  const verified: string[] = [];
  const calculations: string[] = [];
  const annotations: string[] = [];
  const supporting: string[] = [];
  const risks: string[] = [];
  const unknowns: string[] = [];
  const invalidation: string[] = [];
  const market = input.market;

  if (market.currentMarket.lowestListing) {
    verified.push(`当前有效最低在售价为 ${market.currentMarket.lowestListing.platform} ¥${market.currentMarket.lowestListing.price}。`);
  }
  if (market.currentMarket.highestBid) {
    verified.push(`当前有效最高求购价为 ${market.currentMarket.highestBid.platform} ¥${market.currentMarket.highestBid.price}。`);
  }
  const sevenDay = market.trend.returnsPct.days7;
  if (sevenDay !== undefined) {
    verified.push(`所选 K 线近 7 日收益为 ${signed(sevenDay)}%。`);
    if (sevenDay >= 3) supporting.push("近 7 日价格动量为正。");
    if (sevenDay <= -3) risks.push("近 7 日价格动量为负。");
  } else {
    unknowns.push("K 线不足以计算近 7 日收益。");
  }
  const volatility = market.trend.estimatedDailyVolatility7dPct;
  if (volatility !== undefined && volatility >= 8) risks.push(`估算日波动率较高（${volatility}%）。`);
  const visibleRatio = market.currentMarket.visibleDemandSupplyRatio;
  if (visibleRatio !== undefined) {
    calculations.push(`跨平台可见求购量/在售量比为 ${visibleRatio}，但可能重复统计。`);
    if (visibleRatio < 0.5) risks.push("可见求购数量明显低于可见在售数量。");
    if (visibleRatio >= 1) supporting.push("可见求购数量不低于可见在售数量，但尚不能证明真实成交需求。");
  } else {
    unknowns.push("盘口数量不完整，无法计算可见供需比。");
  }

  const sector = buildSectorDimension(market.trend.returnsPct, context?.sector);
  if (sector.status === "available") {
    annotations.push(`${context!.sector!.provenance.label}：${sector.sectorName}近 ${sector.sectorWindowDays} 日为 ${signed(sector.sectorReturnPct!)}%。`);
    calculations.push(`单品使用近 ${sector.itemComparableWindowDays} 日收益与板块比较，相对强弱约为 ${signed(sector.relativeStrengthPctPoints!)} 个百分点。`);
    if (sector.relativeStrengthPctPoints! < -3) risks.push("单品表现明显弱于所给板块基准，板块下跌不能解释全部弱势。");
    if (sector.relativeStrengthPctPoints! > 3) supporting.push("单品表现明显强于所给板块基准。");
    if ((sector.windowMismatchDays ?? 0) > 0) unknowns.push("单品与板块窗口不完全一致，相对强弱是近似比较。");
  } else {
    unknowns.push("缺少同级板块收益，无法判断单品相对板块强弱。");
  }

  const effectiveFloat = buildEffectiveFloat(input.supply, input.holders, context?.effectiveCirculatingSupply);
  if (input.supplyStatus === "available" && input.supply?.currentQuantity !== undefined) {
    verified.push(`提供方当前名义存量统计为 ${input.supply.currentQuantity}。`);
  } else {
    unknowns.push("缺少提供方名义存量或存量趋势。");
  }
  if (effectiveFloat.status === "estimated") {
    const estimate = context!.effectiveCirculatingSupply!;
    annotations.push(`${estimate.provenance.label}：有效流通盘中心估计为 ${estimate.central}${rangeText(estimate.low, estimate.high)}。`);
    if (effectiveFloat.estimatedCirculatingRatioPct !== undefined) {
      calculations.push(`有效流通盘中心估计约为名义存量的 ${effectiveFloat.estimatedCirculatingRatioPct}%。`);
    }
    if (effectiveFloat.observedTop10ShareOfEstimatedFloatPct !== undefined) {
      calculations.push(`CSQAQ 样本 Top 10 已观察数量约占估算有效流通盘的 ${effectiveFloat.observedTop10ShareOfEstimatedFloatPct}%；这不是全网集中度。`);
    }
  } else {
    unknowns.push("缺少带日期和来源的有效流通盘估计，不能用名义存量代替真实流通盘。");
  }

  const holderCoverage = {
    status: input.holderStatus,
    scope: input.holders ? "csqaq_monitored_accounts" as const : "unavailable" as const,
    ...(input.holders ? {
      observedAccounts: input.holders.observedAccounts,
      observedQuantity: input.holders.observedQuantity,
      top10ShareInMonitoredSamplePct: input.holders.top10SharePct,
    } : {}),
  };
  if (input.holders) {
    verified.push(`CSQAQ 监控样本内 Top 10 占比为 ${input.holders.top10SharePct}%（${input.holders.observedAccounts} 个去重账号）。`);
  } else {
    unknowns.push("缺少 CSQAQ 监控范围内的持仓集中度。");
  }

  const dealerOperation = context?.dealerOperation
    ? { status: "expert_annotated" as const, suitability: context.dealerOperation.suitability }
    : { status: "unknown" as const };
  if (context?.dealerOperation) {
    annotations.push(`${context.dealerOperation.provenance.label}：大商反复运作适合度为 ${context.dealerOperation.suitability}。`);
    if (context.dealerOperation.suitability === "high") supporting.push("专家标注认为该品种具备较强的大商反复运作属性。");
    if (context.dealerOperation.suitability === "low") risks.push("专家标注认为该品种不适合大商反复运作。");
  } else {
    unknowns.push("没有经过用户确认的大商运作属性标注。");
  }

  const tradeUp = buildTradeUpDimension(context?.tradeUp);
  if (context?.tradeUp) {
    annotations.push(`${context.tradeUp.provenance.label}：该饰品的汰换角色为 ${context.tradeUp.role}，合约投入件数为 ${context.tradeUp.contractInputCount}。`);
    if (tradeUp.status === "economics_available") {
      calculations.push(`汰换投入成本 ¥${tradeUp.inputCost}，结果篮子加权价值 ¥${tradeUp.weightedOutputValue}，未计交易摩擦的期望差为 ${signed(tradeUp.expectedMarginPct!)}%。`);
      if (tradeUp.expectedMarginPct! > 0) supporting.push("所给汰换价格篮子存在正的静态期望差，可能增加材料消耗需求。");
      if (tradeUp.expectedMarginPct! < 0) risks.push("所给汰换价格篮子为负的静态期望差，暂不构成材料价格支撑。");
    } else {
      unknowns.push(tradeUp.pricingLimitation ?? "已知汰换关系，但缺少完整价格和概率，无法计算期望值。");
    }
  } else {
    unknowns.push("尚未提供当前饰品的汰换上下游关系。");
  }

  invalidation.push("板块由同步下跌转为明显走强或单品重新强于板块时，应重算阶段判断。");
  invalidation.push("在售量、求购深度、有效流通盘或大户持仓出现新快照时，应替换旧观察。");
  if (context?.tradeUp) invalidation.push("上级结果篮子或下级材料价格变化会改变汰换期望值，必须按最新价格重算。");

  const phase = classifyPhase(market, supporting.length, risks.length);
  const role = context?.dealerOperation?.suitability === "high"
    ? "dealer_operable"
    : context?.dealerOperation
      ? "ordinary_market_item"
      : "unknown";
  return {
    model: {
      type: "market_trading",
      version: 1,
      purposeZh: "判断单品、板块、有效流通盘、持仓集中度与汰换关系共同形成的行情状态。",
      notForZh: "不用于判断七日交易保护后的挂刀可执行性。",
    },
    marketHashName: market.marketHashName,
    generatedAt: market.generatedAt,
    phase,
    role,
    dimensions: {
      trend: { status: market.trend.label, returnsPct: market.trend.returnsPct },
      sector,
      effectiveFloat,
      holderCoverage,
      dealerOperation,
      tradeUp,
    },
    verifiedObservations: verified,
    deterministicCalculations: calculations,
    expertAnnotations: annotations,
    supportingSignals: supporting,
    riskSignals: risks,
    unknowns,
    invalidationSignals: invalidation,
    conclusionZh: conclusion(phase),
    limitations: [
      "本模型评估行情交易属性，不等同于挂刀、搬砖或即时成交能力。",
      "专家估算和手工录入的板块数据不是 API 已验证事实，必须保留来源与日期。",
      "持仓集中度仅覆盖 CSQAQ 监控样本；名义存量不等于有效流通盘。",
      "汰换期望值若可用也只是静态计算，未包含磨损组合、成交深度、手续费和价格冲击。",
      "不得据此确认吸筹、洗盘、出货、控盘或未来价格方向。",
    ],
  };
}

function validateContext(context: MarketTradingContext | undefined): MarketTradingContext | undefined {
  if (!context) return undefined;
  if (context.sector) {
    positive(context.sector.windowDays, "sector.windowDays");
    finite(context.sector.returnPct, "sector.returnPct");
    provenance(context.sector.provenance, "sector.provenance");
  }
  if (context.effectiveCirculatingSupply) {
    const value = context.effectiveCirculatingSupply;
    positive(value.central, "effectiveCirculatingSupply.central");
    if (value.low !== undefined) positive(value.low, "effectiveCirculatingSupply.low");
    if (value.high !== undefined) positive(value.high, "effectiveCirculatingSupply.high");
    if (value.low !== undefined && value.low > value.central) throw usage("effective circulating low cannot exceed central");
    if (value.high !== undefined && value.high < value.central) throw usage("effective circulating high cannot be below central");
    provenance(value.provenance, "effectiveCirculatingSupply.provenance");
  }
  if (context.dealerOperation) provenance(context.dealerOperation.provenance, "dealerOperation.provenance");
  if (context.tradeUp) {
    if (!Number.isInteger(context.tradeUp.contractInputCount) || context.tradeUp.contractInputCount <= 0 || context.tradeUp.contractInputCount > 10) {
      throw usage("tradeUp.contractInputCount must be an integer from 1 to 10");
    }
    if (context.tradeUp.inputUnitPrice !== undefined) positive(context.tradeUp.inputUnitPrice, "tradeUp.inputUnitPrice");
    if (context.tradeUp.otherCost !== undefined && context.tradeUp.otherCost < 0) throw usage("tradeUp.otherCost must be non-negative");
    for (const output of context.tradeUp.outputItems ?? []) {
      if (output.probability !== undefined && (output.probability < 0 || output.probability > 1)) throw usage("tradeUp output probability must be between 0 and 1");
      if (output.referencePrice !== undefined) positive(output.referencePrice, "tradeUp output referencePrice");
    }
    provenance(context.tradeUp.provenance, "tradeUp.provenance");
  }
  return context;
}

function buildSectorDimension(
  returns: PeriodReturns,
  sector: MarketTradingContext["sector"] | undefined,
): MarketTradingAssessment["dimensions"]["sector"] {
  if (!sector) return { status: "unknown" };
  const candidates: readonly (readonly [number, number | undefined])[] = [
    [1, returns.hours24],
    [7, returns.days7],
    [14, returns.days14],
    [30, returns.days30],
  ] as const;
  const match = candidates
    .filter((entry) => entry[1] !== undefined)
    .sort((a, b) => Math.abs(a[0] - sector.windowDays) - Math.abs(b[0] - sector.windowDays))[0];
  if (!match || match[1] === undefined) return { status: "unknown" };
  const itemReturn = match[1];
  return {
    status: "available",
    sectorName: sector.name,
    sectorReturnPct: round(sector.returnPct),
    sectorWindowDays: sector.windowDays,
    itemComparableReturnPct: itemReturn,
    itemComparableWindowDays: match[0],
    relativeStrengthPctPoints: round(itemReturn - sector.returnPct),
    windowMismatchDays: Math.abs(match[0] - sector.windowDays),
  };
}

function buildEffectiveFloat(
  supply: SupplyTrendSummary | undefined,
  holders: HolderConcentrationSummary | undefined,
  estimate: MarketTradingContext["effectiveCirculatingSupply"] | undefined,
): MarketTradingAssessment["dimensions"]["effectiveFloat"] {
  const nominal = supply?.currentQuantity;
  if (!estimate) return nominal !== undefined ? { status: "nominal_only", nominalSupply: nominal } : { status: "unknown" };
  return {
    status: "estimated",
    ...(nominal !== undefined ? { nominalSupply: nominal } : {}),
    estimatedCentral: estimate.central,
    ...(estimate.low !== undefined ? { estimatedLow: estimate.low } : {}),
    ...(estimate.high !== undefined ? { estimatedHigh: estimate.high } : {}),
    ...(nominal !== undefined && nominal > 0 ? { estimatedCirculatingRatioPct: round((estimate.central / nominal) * 100) } : {}),
    ...(holders ? { observedTop10Quantity: holders.top10Quantity } : {}),
    ...(holders && estimate.central > 0 ? { observedTop10ShareOfEstimatedFloatPct: round((holders.top10Quantity / estimate.central) * 100) } : {}),
  };
}

function buildTradeUpDimension(
  tradeUp: MarketTradingContext["tradeUp"] | undefined,
): MarketTradingAssessment["dimensions"]["tradeUp"] {
  if (!tradeUp) return { status: "unknown" };
  const outputs = tradeUp.outputItems ?? [];
  const complete = tradeUp.inputUnitPrice !== undefined
    && outputs.length > 0
    && outputs.every((output) => output.probability !== undefined && output.referencePrice !== undefined);
  if (!complete) {
    return {
      status: "relationship_only",
      role: tradeUp.role,
      contractInputCount: tradeUp.contractInputCount,
      pricingLimitation: "已记录汰换关系，但缺少完整材料价格、结果概率或结果价格，不能计算期望值。",
    };
  }
  const probabilitySum = outputs.reduce((sum, output) => sum + output.probability!, 0);
  if (Math.abs(probabilitySum - 1) > 0.001) {
    return {
      status: "relationship_only",
      role: tradeUp.role,
      contractInputCount: tradeUp.contractInputCount,
      probabilitySum: round(probabilitySum),
      pricingLimitation: "结果概率合计不等于 1，未自动归一化，不能计算期望值。",
    };
  }
  const inputCost = tradeUp.inputUnitPrice! * tradeUp.contractInputCount + (tradeUp.otherCost ?? 0);
  const weightedOutputValue = outputs.reduce((sum, output) => sum + output.probability! * output.referencePrice!, 0);
  return {
    status: "economics_available",
    role: tradeUp.role,
    contractInputCount: tradeUp.contractInputCount,
    inputCost: round(inputCost),
    weightedOutputValue: round(weightedOutputValue),
    expectedMarginPct: round(((weightedOutputValue / inputCost) - 1) * 100),
    probabilitySum: round(probabilitySum),
  };
}

function classifyPhase(market: MarketAnalysisReport, supportCount: number, riskCount: number): MarketTradingAssessment["phase"] {
  if (market.trend.label === "insufficient_data" || market.dataQuality.confidence === "low") return "insufficient_data";
  if (riskCount >= supportCount + 2 || market.trend.label === "downtrend") return "risk_off";
  if (supportCount >= riskCount + 2 && market.trend.label === "uptrend") return "constructive";
  return "watch";
}

function conclusion(phase: MarketTradingAssessment["phase"]): string {
  if (phase === "constructive") return "当前行情支持信号较多，但仍需等待盘口、板块和流通盘继续验证。";
  if (phase === "risk_off") return "当前处于风险优先阶段，不应仅凭跌幅、汰换题材或大商属性判断已经见底。";
  if (phase === "watch") return "当前支持与风险信号接近，适合继续观察触发条件，而不是形成单向确定结论。";
  return "关键证据不足，当前无法形成可靠的行情交易阶段判断。";
}

function provenance(value: MarketContextProvenance, label: string): void {
  if (!value.label.trim()) throw usage(`${label}.label is required`);
  if (value.observedAt !== undefined && Number.isNaN(new Date(value.observedAt).valueOf())) throw usage(`${label}.observedAt must be ISO date-time`);
}

function positive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw usage(`${label} must be positive`);
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw usage(`${label} must be finite`);
}

function usage(message: string): AppError {
  return new AppError("USAGE_ERROR", message);
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${round(value)}`;
}

function rangeText(low: number | undefined, high: number | undefined): string {
  return low !== undefined || high !== undefined ? `（区间 ${low ?? "未知"}–${high ?? "未知"}）` : "";
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
