import type { SteamDtKlinePoint } from "../adapters/steamdt/types.js";

export interface SevenDayScenario {
  readonly status: "available" | "insufficient_data";
  readonly generatedFrom: "steamdt_kline";
  readonly latestPrice?: number;
  readonly dailyPointCount: number;
  readonly historyStart?: string;
  readonly historyEnd?: string;
  readonly momentum7dPct?: number;
  readonly dailyVolatility30dPct?: number;
  readonly scenarios?: {
    readonly defensive: { readonly returnPct: number; readonly price: number };
    readonly base: { readonly returnPct: number; readonly price: number };
    readonly optimistic: { readonly returnPct: number; readonly price: number };
  };
  readonly method: readonly string[];
  readonly limitations: readonly string[];
}

export function estimateSevenDayScenarios(points: readonly SteamDtKlinePoint[]): SevenDayScenario {
  const daily = dailyCloses(points);
  const latest = daily.at(-1);
  const common = {
    generatedFrom: "steamdt_kline" as const,
    dailyPointCount: daily.length,
    ...(daily[0] ? { historyStart: new Date(daily[0].timestamp * 1000).toISOString() } : {}),
    ...(latest ? { historyEnd: new Date(latest.timestamp * 1000).toISOString() } : {}),
    method: [
      "取每个 UTC 日的最后一个 K 线收盘价。",
      "基础情景 = 近 7 日动量 × 0.4，并限制在 ±12%。",
      "防守/乐观情景 = 基础情景 ± 1.28 × 日波动率 × √7，并限制在 ±50%。",
    ],
    limitations: [
      "这是透明的统计情景，不是价格预测或收益保证。",
      "K 线不包含真实成交量；七日交易保护期内供需、政策和市场情绪可能改变。",
      "特殊磨损、模板和贴纸饰品不能直接套用普通类目 K 线。",
    ],
  };
  if (!latest || daily.length < 8) return { status: "insufficient_data", ...common };

  const baseline = closestAtOrBefore(daily, latest.timestamp - 7 * 86_400);
  if (!baseline || baseline.close <= 0) return { status: "insufficient_data", ...common };
  const momentum = (latest.close / baseline.close) - 1;
  const returns = logReturns(daily.slice(-31));
  if (returns.length < 5) return { status: "insufficient_data", ...common };
  const volatility = standardDeviation(returns)!;
  const base = clamp(momentum * 0.4, -0.12, 0.12);
  const range = 1.28 * volatility * Math.sqrt(7);
  const defensive = clamp(base - range, -0.5, 0.5);
  const optimistic = clamp(base + range, -0.5, 0.5);
  return {
    status: "available",
    ...common,
    latestPrice: round(latest.close),
    momentum7dPct: pct(momentum),
    dailyVolatility30dPct: pct(volatility),
    scenarios: {
      defensive: { returnPct: pct(defensive), price: round(latest.close * (1 + defensive)) },
      base: { returnPct: pct(base), price: round(latest.close * (1 + base)) },
      optimistic: { returnPct: pct(optimistic), price: round(latest.close * (1 + optimistic)) },
    },
  };
}

function dailyCloses(points: readonly SteamDtKlinePoint[]): readonly SteamDtKlinePoint[] {
  const byDay = new Map<string, SteamDtKlinePoint>();
  for (const point of [...points].sort((a, b) => a.timestamp - b.timestamp)) {
    if (point.close <= 0) continue;
    byDay.set(new Date(point.timestamp * 1000).toISOString().slice(0, 10), point);
  }
  return [...byDay.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function closestAtOrBefore(points: readonly SteamDtKlinePoint[], timestamp: number): SteamDtKlinePoint | undefined {
  let match: SteamDtKlinePoint | undefined;
  for (const point of points) {
    if (point.timestamp <= timestamp) match = point;
    else break;
  }
  return match;
}

function logReturns(points: readonly SteamDtKlinePoint[]): readonly number[] {
  const result: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    result.push(Math.log(current.close / previous.close));
  }
  return result;
}

function standardDeviation(values: readonly number[]): number | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function pct(value: number): number {
  return round(value * 100);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
