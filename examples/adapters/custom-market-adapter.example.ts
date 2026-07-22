import type {
  MarketAdapterDescriptor,
  MarketDataAdapter,
} from "../../src/adapters/market/contract.js";
import { verifiedEvidence } from "../../src/domain/evidence.js";
import type { NormalizedMarketQuote } from "../../src/domain/market-quote.js";

/**
 * Source-level template only. The injected reader must validate a real,
 * licensed API response before returning normalized quotes.
 */
export class CustomLicensedMarketAdapter implements MarketDataAdapter {
  readonly descriptor: MarketAdapterDescriptor = {
    id: "licensed-platform",
    displayName: "Licensed platform",
    kind: "direct_platform",
    priority: 50,
    capabilities: ["market_quotes", "batch_market_quotes"],
    platforms: ["LICENSED_PLATFORM"],
    batchPolicy: { maximumItems: 50, minimumIntervalMs: 1_000 },
  };

  readonly #read: (names: readonly string[]) => Promise<readonly NormalizedMarketQuote[]>;

  constructor(
    readValidatedQuotes: (names: readonly string[]) => Promise<readonly NormalizedMarketQuote[]>,
  ) {
    this.#read = readValidatedQuotes;
  }

  async getQuotes(marketHashName: string) {
    return this.getBatchQuotes([marketHashName]);
  }

  async getBatchQuotes(marketHashNames: readonly string[]) {
    const observedAt = new Date();
    const quotes = await this.#read(marketHashNames);
    return verifiedEvidence(
      `${this.descriptor.id}:batch-prices`,
      observedAt,
      quotes,
      ["Listing observations are not proof of completed trades or guaranteed executable prices."],
    );
  }
}
