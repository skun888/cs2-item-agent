import type { CsQaqClient } from "../adapters/csqaq/client.js";
import type { SteamDtClient } from "../adapters/steamdt/client.js";
import { createBuiltInMarketAdapterRegistry } from "../adapters/market/factory.js";
import { MarketAdapterRegistry } from "../adapters/market/registry.js";
import type { MarketAdapterFetchStatus } from "../adapters/market/contract.js";
import { AppError } from "../core/errors.js";
import {
  compareProviderQuotes,
  type NormalizedMarketQuote,
  type ProviderQuoteComparison,
} from "../domain/market-quote.js";
import type { AppDatabase } from "../storage/database.js";

export type MarketProviderStatus = MarketAdapterFetchStatus;

export interface MultiSourcePriceReport {
  readonly marketHashName: string;
  readonly generatedAt: string;
  readonly providers: readonly MarketProviderStatus[];
  readonly quotes: readonly NormalizedMarketQuote[];
  readonly comparisons: readonly ProviderQuoteComparison[];
  readonly limitations: readonly string[];
}

export class MarketCompatibilityService {
  readonly #registry: MarketAdapterRegistry;
  readonly #database: AppDatabase;
  readonly #now: () => Date;

  constructor(
    registry: MarketAdapterRegistry,
    database: AppDatabase,
    now?: () => Date,
  );
  constructor(
    steamDt: SteamDtClient | undefined,
    csQaq: CsQaqClient | undefined,
    database: AppDatabase,
    now?: () => Date,
  );
  constructor(
    registryOrSteamDt: MarketAdapterRegistry | SteamDtClient | undefined,
    databaseOrCsQaq: AppDatabase | CsQaqClient | undefined,
    nowOrDatabase?: (() => Date) | AppDatabase,
    legacyNow: () => Date = () => new Date(),
  ) {
    if (registryOrSteamDt instanceof MarketAdapterRegistry) {
      this.#registry = registryOrSteamDt;
      this.#database = databaseOrCsQaq as AppDatabase;
      this.#now = typeof nowOrDatabase === "function" ? nowOrDatabase : () => new Date();
    } else {
      const csQaq = databaseOrCsQaq as CsQaqClient | undefined;
      this.#registry = createBuiltInMarketAdapterRegistry({
        ...(registryOrSteamDt ? { steamDt: registryOrSteamDt } : {}),
        ...(csQaq ? { csQaq } : {}),
      });
      this.#database = nowOrDatabase as AppDatabase;
      this.#now = legacyNow;
    }
    if (!this.#registry.hasConfiguredAdapter()) {
      throw new AppError("CONFIG_ERROR", "At least one market provider must be configured.");
    }
  }

  async comparePrices(marketHashName: string): Promise<MultiSourcePriceReport> {
    const name = marketHashName.trim();
    if (!name) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const fetchedAt = this.#now();
    const fetched = await this.#registry.fetchAllQuotes(name);
    const quotes: readonly NormalizedMarketQuote[] = fetched.quotes;

    if (quotes.length > 0) this.#database.saveNormalizedMarketQuotes(quotes);
    return {
      marketHashName: name,
      generatedAt: fetchedAt.toISOString(),
      providers: fetched.providers,
      quotes,
      comparisons: compareProviderQuotes(quotes),
      limitations: [
        "All adapter sources are retained independently; one source never silently overwrites another.",
        "Refresh times, platform coverage, zero placeholders, and market definitions can differ.",
        "Displayed differences are observations, not guaranteed executable trades or profit.",
      ],
    };
  }
}
