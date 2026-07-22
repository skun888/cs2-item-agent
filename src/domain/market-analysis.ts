import type { SteamDtKlinePoint, SteamDtPriceEntry } from "../adapters/steamdt/types.js";
import type { Evidence } from "./evidence.js";

export type AnalysisConfidence = "high" | "medium" | "low";
export type TrendLabel = "uptrend" | "downtrend" | "sideways" | "insufficient_data";

export interface MarketAnalysisInput {
  readonly marketHashName: string;
  readonly platform: string;
  readonly klineType: number;
  readonly prices: Evidence<readonly SteamDtPriceEntry[]>;
  readonly itemKline: Evidence<readonly SteamDtKlinePoint[]>;
  readonly previousPrices?: Evidence<readonly SteamDtPriceEntry[]>;
  readonly broadKline?: Evidence<readonly SteamDtKlinePoint[]>;
  readonly broadUnavailableReason?: string;
  readonly generatedAt: Date;
}

export interface NormalizedMarketQuote {
  readonly platform: string;
  readonly status: "current" | "stale" | "unknown_freshness" | "unavailable";
  readonly bidStatus: "usable" | "crossed" | "unavailable";
  readonly sellPrice?: number;
  readonly sellCount?: number;
  readonly biddingPrice?: number;
  readonly biddingCount?: number;
  readonly updatedAt?: string;
  readonly ageMinutes?: number;
}

export interface PeriodReturns {
  readonly hours24?: number;
  readonly days7?: number;
  readonly days14?: number;
  readonly days30?: number;
}

export interface MarketAnalysisReport {
  readonly marketHashName: string;
  readonly generatedAt: string;
  readonly query: {
    readonly platform: string;
    readonly klineType: number;
  };
  readonly currentMarket: {
    readonly quotes: readonly NormalizedMarketQuote[];
    readonly lowestListing?: { readonly platform: string; readonly price: number };
    readonly highestBid?: { readonly platform: string; readonly price: number };
    readonly medianListingPrice?: number;
    readonly crossPlatformListingRangePct?: number;
    readonly visibleListingCountSum?: number;
    readonly visibleBidCountSum?: number;
    readonly visibleDemandSupplyRatio?: number;
    readonly listingCountChangePct?: number;
    readonly bidCountChangePct?: number;
    readonly comparisonIntervalMinutes?: number;
  };
  readonly trend: {
    readonly label: TrendLabel;
    readonly latestClose?: number;
    readonly pointCount: number;
    readonly historyStart?: string;
    readonly historyEnd?: string;
    readonly dominantIntervalSeconds?: number;
    readonly returnsPct: PeriodReturns;
    readonly movingAverage7d?: number;
    readonly movingAverage30d?: number;
    readonly estimatedDailyVolatility7dPct?: number;
    readonly maxDrawdown30dPct?: number;
    readonly currentPricePercentile30d?: number;
  };
  readonly relativeMarket: {
    readonly available: boolean;
    readonly itemReturn7dPct?: number;
    readonly broadReturn7dPct?: number;
    readonly relativeStrength7dPctPoints?: number;
    readonly unavailableReason?: string;
  };
  readonly dataQuality: {
    readonly score: number;
    readonly confidence: AnalysisConfidence;
    readonly usablePricePlatforms: number;
    readonly totalPricePlatforms: number;
    readonly stalePricePlatforms: number;
    readonly unavailablePricePlatforms: number;
    readonly warnings: readonly string[];
  };
  readonly evidence: readonly {
    readonly source: string;
    readonly observedAt: string;
    readonly confidence: string;
  }[];
  readonly narrativeZh: {
    readonly conclusion: string;
    readonly keyData: readonly string[];
    readonly risks: readonly string[];
  };
}

const STALE_AFTER_MINUTES = 24 * 60;

export function analyzeMarket(input: MarketAnalysisInput): MarketAnalysisReport {
  const quotes = input.prices.data.map((entry) => normalizeQuote(entry, input.generatedAt));
  const usableQuotes = quotes.filter((quote) => quote.sellPrice !== undefined && quote.sellPrice > 0);
  const currentQuotes = usableQuotes.filter((quote) => quote.status !== "stale");
  const comparisonQuotes = currentQuotes.length > 0 ? currentQuotes : usableQuotes;
  const listings = comparisonQuotes.flatMap((quote) =>
    quote.sellPrice === undefined ? [] : [{ platform: quote.platform, price: quote.sellPrice }],
  );
  const bids = quotes.flatMap((quote) =>
    quote.bidStatus === "usable" && quote.biddingPrice !== undefined
      ? [{ platform: quote.platform, price: quote.biddingPrice }]
      : [],
  );
  const listingCounts = sumDefined(comparisonQuotes.map((quote) => quote.sellCount));
  const bidCounts = sumDefined(
    quotes
      .filter((quote) => quote.bidStatus === "usable")
      .map((quote) => quote.biddingCount),
  );
  const lowestListing = minBy(listings, (quote) => quote.price);
  const highestBid = maxBy(bids, (quote) => quote.price);
  const listingPrices = listings.map((quote) => quote.price);
  const previousComparison = input.previousPrices
    ? compareSupply(input.previousPrices, listingCounts, bidCounts, input.prices.observedAt)
    : {};

  const trend = calculateTrend(input.itemKline.data);
  const broadReturns = input.broadKline ? calculateReturns(input.broadKline.data) : {};
  const relativeMarket =
    trend.returnsPct.days7 !== undefined && broadReturns.days7 !== undefined
      ? {
          available: true as const,
          itemReturn7dPct: trend.returnsPct.days7,
          broadReturn7dPct: broadReturns.days7,
          relativeStrength7dPctPoints: round(trend.returnsPct.days7 - broadReturns.days7),
        }
      : {
          available: false as const,
          unavailableReason:
            input.broadUnavailableReason ?? "单品或大盘没有足够的七日历史数据。",
        };

  const staleCount = quotes.filter((quote) => quote.status === "stale").length;
  const unavailableCount = quotes.filter((quote) => quote.status === "unavailable").length;
  const crossedBidPlatforms = quotes
    .filter((quote) => quote.bidStatus === "crossed")
    .map((quote) => quote.platform);
  const warnings: string[] = [];
  if (unavailableCount > 0) warnings.push(`${unavailableCount} 个平台返回零值或无可用卖价，已排除。`);
  if (staleCount > 0) warnings.push(`${staleCount} 个平台行情超过 24 小时，当前最低价优先排除陈旧数据。`);
  if (crossedBidPlatforms.length > 0) {
    warnings.push(
      `${crossedBidPlatforms.join("、")} 的求购价高于同平台卖价，已作为盘口异常排除。`,
    );
  }
  if (bids.length === 0) warnings.push("没有可用求购价，需求侧判断不完整。");
  if (input.previousPrices === undefined) warnings.push("只有一个本地行情批次，暂时不能判断在售量或求购量变化。");
  if (!relativeMarket.available) warnings.push(`相对大盘不可用：${relativeMarket.unavailableReason}`);
  warnings.push("SteamDT K 线不包含真实成交量，波动和活跃度不能替代成交量。" );
  warnings.push("跨平台数量求和可能重复计算经济敞口，只能作为可见盘面指标。" );

  let qualityScore = 100;
  if (usableQuotes.length === 0) qualityScore -= 45;
  qualityScore -= Math.min(25, unavailableCount * 4);
  qualityScore -= Math.min(20, staleCount * 5);
  qualityScore -= Math.min(15, crossedBidPlatforms.length * 5);
  if (trend.returnsPct.days30 === undefined) qualityScore -= 15;
  if (bids.length === 0) qualityScore -= 10;
  if (!relativeMarket.available) qualityScore -= 10;
  const score = clamp(Math.round(qualityScore), 0, 100);
  const confidence: AnalysisConfidence = score >= 80 ? "high" : score >= 55 ? "medium" : "low";

  const currentMarket = {
    quotes,
    ...(lowestListing ? { lowestListing } : {}),
    ...(highestBid ? { highestBid } : {}),
    ...(listingPrices.length > 0 ? { medianListingPrice: round(median(listingPrices)) } : {}),
    ...(listingPrices.length > 1
      ? {
          crossPlatformListingRangePct: round(
            ((Math.max(...listingPrices) - Math.min(...listingPrices)) /
              Math.min(...listingPrices)) *
              100,
          ),
        }
      : {}),
    ...(listingCounts !== undefined ? { visibleListingCountSum: listingCounts } : {}),
    ...(bidCounts !== undefined ? { visibleBidCountSum: bidCounts } : {}),
    ...(listingCounts !== undefined && listingCounts > 0 && bidCounts !== undefined
      ? { visibleDemandSupplyRatio: round(bidCounts / listingCounts) }
      : {}),
    ...previousComparison,
  };

  const keyData: string[] = [];
  if (lowestListing) keyData.push(`当前有效最低在售价：${lowestListing.platform} ¥${lowestListing.price}。`);
  if (highestBid) keyData.push(`当前最高求购价：${highestBid.platform} ¥${highestBid.price}。`);
  if (trend.returnsPct.days7 !== undefined) keyData.push(`所选平台近 7 日价格收益：${formatPct(trend.returnsPct.days7)}。`);
  if (relativeMarket.relativeStrength7dPctPoints !== undefined) {
    keyData.push(`近 7 日相对大盘强弱：${formatPct(relativeMarket.relativeStrength7dPctPoints)}。`);
  }
  if (currentMarket.visibleDemandSupplyRatio !== undefined) {
    keyData.push(`可见求购量/在售量比：${currentMarket.visibleDemandSupplyRatio}。`);
  }

  return {
    marketHashName: input.marketHashName,
    generatedAt: input.generatedAt.toISOString(),
    query: { platform: input.platform, klineType: input.klineType },
    currentMarket,
    trend,
    relativeMarket,
    dataQuality: {
      score,
      confidence,
      usablePricePlatforms: usableQuotes.length,
      totalPricePlatforms: quotes.length,
      stalePricePlatforms: staleCount,
      unavailablePricePlatforms: unavailableCount,
      warnings,
    },
    evidence: [
      {
        source: input.prices.source,
        observedAt: input.prices.observedAt,
        confidence: input.prices.confidence,
      },
      {
        source: input.itemKline.source,
        observedAt: input.itemKline.observedAt,
        confidence: input.itemKline.confidence,
      },
      ...(input.broadKline
        ? [
            {
              source: input.broadKline.source,
              observedAt: input.broadKline.observedAt,
              confidence: input.broadKline.confidence,
            },
          ]
        : []),
    ],
    narrativeZh: {
      conclusion: describeTrend(trend.label, confidence),
      keyData,
      risks: warnings,
    },
  };
}

function normalizeQuote(entry: SteamDtPriceEntry, now: Date): NormalizedMarketQuote {
  const updatedAt = toDate(entry.updateTime);
  const ageMinutes = updatedAt
    ? Math.max(0, (now.valueOf() - updatedAt.valueOf()) / 60_000)
    : undefined;
  const hasPrice = entry.sellPrice !== undefined && entry.sellPrice > 0;
  const hasBid = entry.biddingPrice !== undefined && entry.biddingPrice > 0;
  const bidStatus = !hasBid
    ? "unavailable"
    : hasPrice && entry.biddingPrice! > entry.sellPrice!
      ? "crossed"
      : "usable";
  const status = !hasPrice
    ? "unavailable"
    : ageMinutes === undefined
      ? "unknown_freshness"
      : ageMinutes > STALE_AFTER_MINUTES
        ? "stale"
        : "current";
  return {
    platform: entry.platform,
    status,
    bidStatus,
    ...(hasPrice ? { sellPrice: entry.sellPrice } : {}),
    ...(entry.sellCount !== undefined ? { sellCount: entry.sellCount } : {}),
    ...(entry.biddingPrice !== undefined && entry.biddingPrice > 0
      ? { biddingPrice: entry.biddingPrice }
      : {}),
    ...(entry.biddingCount !== undefined ? { biddingCount: entry.biddingCount } : {}),
    ...(updatedAt ? { updatedAt: updatedAt.toISOString() } : {}),
    ...(ageMinutes !== undefined ? { ageMinutes: round(ageMinutes) } : {}),
  };
}

function calculateTrend(pointsInput: readonly SteamDtKlinePoint[]): MarketAnalysisReport["trend"] {
  const points = [...pointsInput].sort((a, b) => a.timestamp - b.timestamp);
  const latest = points.at(-1);
  if (!latest) return { label: "insufficient_data", pointCount: 0, returnsPct: {} };
  const returnsPct = calculateReturns(points);
  const sevenDayPoints = pointsSince(points, latest.timestamp - 7 * 86_400);
  const thirtyDayPoints = pointsSince(points, latest.timestamp - 30 * 86_400);
  const movingAverage7d = average(sevenDayPoints.map((point) => point.close));
  const movingAverage30d = average(thirtyDayPoints.map((point) => point.close));
  const dominantIntervalSeconds = dominantInterval(points);
  const intervalVolatility = standardDeviation(logReturns(sevenDayPoints));
  const dailyVolatility =
    intervalVolatility !== undefined && dominantIntervalSeconds !== undefined
      ? intervalVolatility * Math.sqrt(86_400 / dominantIntervalSeconds) * 100
      : undefined;
  const maxDrawdown = maxDrawdownPct(thirtyDayPoints.map((point) => point.close));
  const percentile = percentileRank(
    thirtyDayPoints.map((point) => point.close),
    latest.close,
  );
  const label = classifyTrend(returnsPct.days7, latest.close, movingAverage7d);

  return {
    label,
    latestClose: latest.close,
    pointCount: points.length,
    historyStart: new Date(points[0]!.timestamp * 1000).toISOString(),
    historyEnd: new Date(latest.timestamp * 1000).toISOString(),
    ...(dominantIntervalSeconds !== undefined ? { dominantIntervalSeconds } : {}),
    returnsPct,
    ...(movingAverage7d !== undefined ? { movingAverage7d: round(movingAverage7d) } : {}),
    ...(movingAverage30d !== undefined ? { movingAverage30d: round(movingAverage30d) } : {}),
    ...(dailyVolatility !== undefined
      ? { estimatedDailyVolatility7dPct: round(dailyVolatility) }
      : {}),
    ...(maxDrawdown !== undefined ? { maxDrawdown30dPct: round(maxDrawdown) } : {}),
    ...(percentile !== undefined ? { currentPricePercentile30d: round(percentile) } : {}),
  };
}

function calculateReturns(pointsInput: readonly SteamDtKlinePoint[]): PeriodReturns {
  const points = [...pointsInput].sort((a, b) => a.timestamp - b.timestamp);
  const latest = points.at(-1);
  if (!latest) return {};
  return {
    ...periodReturn(points, latest, 86_400, "hours24"),
    ...periodReturn(points, latest, 7 * 86_400, "days7"),
    ...periodReturn(points, latest, 14 * 86_400, "days14"),
    ...periodReturn(points, latest, 30 * 86_400, "days30"),
  };
}

function periodReturn<K extends keyof PeriodReturns>(
  points: readonly SteamDtKlinePoint[],
  latest: SteamDtKlinePoint,
  seconds: number,
  key: K,
): Partial<Pick<PeriodReturns, K>> {
  const target = latest.timestamp - seconds;
  let baseline: SteamDtKlinePoint | undefined;
  for (const point of points) {
    if (point.timestamp <= target) baseline = point;
    else break;
  }
  if (!baseline || baseline.close <= 0) return {};
  return { [key]: round(((latest.close / baseline.close) - 1) * 100) } as Partial<
    Pick<PeriodReturns, K>
  >;
}

function compareSupply(
  previous: Evidence<readonly SteamDtPriceEntry[]>,
  currentListings: number | undefined,
  currentBids: number | undefined,
  currentObservedAt: string,
): Pick<
  MarketAnalysisReport["currentMarket"],
  "listingCountChangePct" | "bidCountChangePct" | "comparisonIntervalMinutes"
> {
  const previousQuotes = previous.data.filter(
    (entry) => entry.sellPrice !== undefined && entry.sellPrice > 0,
  );
  const previousListings = sumDefined(previousQuotes.map((entry) => entry.sellCount));
  const previousBids = sumDefined(previous.data.map((entry) => entry.biddingCount));
  const intervalMinutes =
    (new Date(currentObservedAt).valueOf() - new Date(previous.observedAt).valueOf()) / 60_000;
  return {
    ...(previousListings !== undefined && previousListings > 0 && currentListings !== undefined
      ? { listingCountChangePct: round(((currentListings / previousListings) - 1) * 100) }
      : {}),
    ...(previousBids !== undefined && previousBids > 0 && currentBids !== undefined
      ? { bidCountChangePct: round(((currentBids / previousBids) - 1) * 100) }
      : {}),
    ...(Number.isFinite(intervalMinutes) && intervalMinutes > 0
      ? { comparisonIntervalMinutes: round(intervalMinutes) }
      : {}),
  };
}

function classifyTrend(
  sevenDayReturn: number | undefined,
  latestClose: number,
  movingAverage7d: number | undefined,
): TrendLabel {
  if (sevenDayReturn === undefined || movingAverage7d === undefined) return "insufficient_data";
  if (sevenDayReturn >= 3 && latestClose >= movingAverage7d) return "uptrend";
  if (sevenDayReturn <= -3 && latestClose <= movingAverage7d) return "downtrend";
  return "sideways";
}

function describeTrend(label: TrendLabel, confidence: AnalysisConfidence): string {
  const trend =
    label === "uptrend"
      ? "当前规则识别为上行趋势"
      : label === "downtrend"
        ? "当前规则识别为下行趋势"
        : label === "sideways"
          ? "当前规则识别为震荡"
          : "历史数据不足，无法识别趋势";
  return `${trend}；数据质量置信度为 ${confidence}。该结论是可解释规则结果，不是未来价格承诺。`;
}

function pointsSince(
  points: readonly SteamDtKlinePoint[],
  timestamp: number,
): readonly SteamDtKlinePoint[] {
  return points.filter((point) => point.timestamp >= timestamp);
}

function logReturns(points: readonly SteamDtKlinePoint[]): readonly number[] {
  const values: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous && current && previous.close > 0 && current.close > 0) {
      values.push(Math.log(current.close / previous.close));
    }
  }
  return values;
}

function maxDrawdownPct(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let peak = values[0]!;
  let drawdown = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) drawdown = Math.max(drawdown, ((peak - value) / peak) * 100);
  }
  return drawdown;
}

function percentileRank(values: readonly number[], current: number): number | undefined {
  if (values.length === 0) return undefined;
  return (values.filter((value) => value <= current).length / values.length) * 100;
}

function dominantInterval(points: readonly SteamDtKlinePoint[]): number | undefined {
  const counts = new Map<number, number>();
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (!previous || !current) continue;
    const interval = current.timestamp - previous.timestamp;
    if (interval > 0) counts.set(interval, (counts.get(interval) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function toDate(timestamp: number | undefined): Date | undefined {
  if (timestamp === undefined) return undefined;
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

function sumDefined(values: readonly (number | undefined)[]): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function average(values: readonly number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function standardDeviation(values: readonly number[]): number | undefined {
  const mean = average(values);
  if (mean === undefined || values.length < 2) return undefined;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function minBy<T>(values: readonly T[], selector: (value: T) => number): T | undefined {
  return values.reduce<T | undefined>(
    (best, value) => (best === undefined || selector(value) < selector(best) ? value : best),
    undefined,
  );
}

function maxBy<T>(values: readonly T[], selector: (value: T) => number): T | undefined {
  return values.reduce<T | undefined>(
    (best, value) => (best === undefined || selector(value) > selector(best) ? value : best),
    undefined,
  );
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${round(value)}%`;
}
