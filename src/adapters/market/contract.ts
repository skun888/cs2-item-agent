import type { Evidence } from "../../domain/evidence.js";
import type { NormalizedMarketQuote } from "../../domain/market-quote.js";

export type MarketAdapterKind = "aggregator" | "direct_platform";

export type MarketAdapterCapability =
  | "market_quotes"
  | "batch_market_quotes"
  | "item_kline"
  | "broad_kline"
  | "item_catalog"
  | "inspect_preview"
  | "holder_ranking"
  | "supply_trend"
  | "hanging_candidates"
  | "case_intelligence"
  | "diy_catalog";

export interface MarketAdapterBatchPolicy {
  readonly maximumItems: number;
  readonly minimumIntervalMs: number;
}

export interface MarketAdapterDescriptor {
  /** Stable lowercase identifier persisted with observations. */
  readonly id: string;
  readonly displayName: string;
  readonly kind: MarketAdapterKind;
  readonly priority: number;
  readonly capabilities: readonly MarketAdapterCapability[];
  /** `provider_defined` means the upstream source can add or remove covered platforms. */
  readonly platforms: readonly string[] | "provider_defined";
  readonly batchPolicy?: MarketAdapterBatchPolicy;
  readonly documentationUrl?: string;
}

export interface MarketDataAdapter {
  readonly descriptor: MarketAdapterDescriptor;
  getQuotes(marketHashName: string): Promise<Evidence<readonly NormalizedMarketQuote[]>>;
  getBatchQuotes?(
    marketHashNames: readonly string[],
  ): Promise<Evidence<readonly NormalizedMarketQuote[]>>;
}

export interface MarketAdapterHealth {
  readonly id: string;
  readonly displayName: string;
  readonly kind: MarketAdapterKind;
  readonly configured: boolean;
  readonly priority: number;
  readonly capabilities: readonly MarketAdapterCapability[];
  readonly platforms: readonly string[] | "provider_defined";
  readonly batchPolicy?: MarketAdapterBatchPolicy;
}

export interface MarketAdapterFetchStatus {
  readonly provider: string;
  readonly status: "available" | "failed" | "not_configured";
  readonly source?: string;
  readonly observedAt?: string;
  readonly quoteCount: number;
  readonly error?: string;
}

export interface MarketAdapterFetchReport {
  readonly quotes: readonly NormalizedMarketQuote[];
  readonly providers: readonly MarketAdapterFetchStatus[];
}

export interface MarketAdapterRegistration {
  readonly descriptor: MarketAdapterDescriptor;
  readonly adapter?: MarketDataAdapter;
}
