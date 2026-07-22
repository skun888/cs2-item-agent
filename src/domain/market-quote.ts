import { AppError } from "../core/errors.js";
import type { SteamDtPriceEntry } from "../adapters/steamdt/types.js";

/** Stable adapter id. Built-ins are `steamdt` and `csqaq`; extensions may add ids. */
export type MarketDataProvider = string;

export interface NormalizedMarketQuote {
  readonly marketHashName: string;
  readonly platform: string;
  readonly provider: MarketDataProvider;
  readonly source: string;
  readonly observedAt: string;
  readonly currency: "CNY";
  readonly providerItemId?: string;
  readonly sellPrice?: number;
  readonly sellCount?: number;
  readonly biddingPrice?: number;
  readonly biddingCount?: number;
}

export interface ProviderQuoteComparison {
  readonly marketHashName: string;
  readonly platform: string;
  readonly quotes: readonly NormalizedMarketQuote[];
  readonly sellPriceDifferenceRate?: number;
  readonly limitation: string;
}

const CSQAQ_PERSONAL_PLATFORMS = [
  { platform: "BUFF", prefix: "buff" },
  { platform: "YYYP", prefix: "yyyp" },
  { platform: "STEAM", prefix: "steam" },
] as const;

export function normalizeSteamDtPrices(
  marketHashName: string,
  entries: readonly SteamDtPriceEntry[],
  fetchedAt: Date,
): readonly NormalizedMarketQuote[] {
  return entries.map((entry) => ({
    marketHashName: requireText(marketHashName, "marketHashName"),
    platform: normalizePlatform(entry.platform),
    provider: "steamdt",
    source: "steamdt:price-single",
    observedAt: parseProviderTimestamp(entry.updateTime, fetchedAt),
    currency: "CNY",
    ...(entry.platformItemId ? { providerItemId: entry.platformItemId } : {}),
    ...(entry.sellPrice !== undefined ? { sellPrice: entry.sellPrice } : {}),
    ...(entry.sellCount !== undefined ? { sellCount: entry.sellCount } : {}),
    ...(entry.biddingPrice !== undefined ? { biddingPrice: entry.biddingPrice } : {}),
    ...(entry.biddingCount !== undefined ? { biddingCount: entry.biddingCount } : {}),
  }));
}

export function normalizeCsQaqPersonalPriceData(
  value: unknown,
  fetchedAt: Date,
): readonly NormalizedMarketQuote[] {
  if (!isRecord(value) || !isRecord(value.success)) {
    throw new AppError("CONTRACT_ERROR", "CSQAQ batch price data is missing the success object.");
  }

  const quotes: NormalizedMarketQuote[] = [];
  for (const [requestedName, rawEntry] of Object.entries(value.success)) {
    if (!isRecord(rawEntry)) {
      throw new AppError("CONTRACT_ERROR", "CSQAQ batch price item must be an object.");
    }
    const marketHashName = optionalText(rawEntry.marketHashName) ?? requestedName;
    const providerItemId = optionalScalarText(rawEntry.goodId);

    for (const descriptor of CSQAQ_PERSONAL_PLATFORMS) {
      const sellPrice = optionalFiniteNumber(rawEntry[`${descriptor.prefix}SellPrice`]);
      const sellCount = optionalFiniteNumber(rawEntry[`${descriptor.prefix}SellNum`]);
      if (sellPrice === undefined && sellCount === undefined) continue;
      quotes.push({
        marketHashName,
        platform: descriptor.platform,
        provider: "csqaq",
        source: "csqaq:batch-prices",
        observedAt: fetchedAt.toISOString(),
        currency: "CNY",
        ...(providerItemId ? { providerItemId } : {}),
        ...(sellPrice !== undefined ? { sellPrice } : {}),
        ...(sellCount !== undefined ? { sellCount } : {}),
      });
    }
  }
  return quotes;
}

export function compareProviderQuotes(
  quotes: readonly NormalizedMarketQuote[],
): readonly ProviderQuoteComparison[] {
  const groups = new Map<string, NormalizedMarketQuote[]>();
  for (const quote of quotes) {
    const key = `${quote.marketHashName}\u0000${quote.platform}`;
    const group = groups.get(key) ?? [];
    group.push(quote);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const prices = group.flatMap((quote) =>
      quote.sellPrice !== undefined && quote.sellPrice > 0 ? [quote.sellPrice] : [],
    );
    const minimum = prices.length > 0 ? Math.min(...prices) : undefined;
    const maximum = prices.length > 0 ? Math.max(...prices) : undefined;
    const distinctProviders = new Set(group.map((quote) => quote.provider));
    const sellPriceDifferenceRate =
      prices.length >= 2 && distinctProviders.size >= 2 && minimum !== undefined && maximum !== undefined && minimum > 0
        ? (maximum - minimum) / minimum
        : undefined;
    const first = group[0];
    if (!first) throw new AppError("CONTRACT_ERROR", "Market quote group cannot be empty.");
    return {
      marketHashName: first.marketHashName,
      platform: first.platform,
      quotes: group,
      ...(sellPriceDifferenceRate !== undefined ? { sellPriceDifferenceRate } : {}),
      limitation: "Provider quotes may use different refresh times and market definitions; a difference is not proof of an executable arbitrage.",
    };
  });
}

function normalizePlatform(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized === "悠悠有品" || normalized === "YOUPIN" || normalized === "YYYP") return "YYYP";
  if (normalized === "STEAM市场" || normalized === "STEAM MARKET") return "STEAM";
  return normalized;
}

function parseProviderTimestamp(value: number | undefined, fallback: Date): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback.toISOString();
  const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? fallback.toISOString() : parsed.toISOString();
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError("CONTRACT_ERROR", "CSQAQ price fields must be numeric when present.");
  }
  return parsed;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalScalarText(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function requireText(value: string, name: string): string {
  const cleaned = value.trim();
  if (!cleaned) throw new AppError("USAGE_ERROR", `${name} cannot be empty.`);
  return cleaned;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
