import type { SteamDtClient } from "../steamdt/client.js";
import { verifiedEvidence } from "../../domain/evidence.js";
import { normalizeSteamDtPrices } from "../../domain/market-quote.js";
import type { MarketAdapterDescriptor, MarketDataAdapter } from "./contract.js";

export const STEAMDT_MARKET_ADAPTER: MarketAdapterDescriptor = {
  id: "steamdt",
  displayName: "SteamDT",
  kind: "aggregator",
  priority: 100,
  capabilities: [
    "market_quotes",
    "batch_market_quotes",
    "item_kline",
    "broad_kline",
    "item_catalog",
    "inspect_preview",
  ],
  platforms: "provider_defined",
  batchPolicy: { maximumItems: 100, minimumIntervalMs: 60_000 },
  documentationUrl: "https://steamdt.com",
};

export class SteamDtMarketAdapter implements MarketDataAdapter {
  readonly descriptor = STEAMDT_MARKET_ADAPTER;
  readonly #client: SteamDtClient;

  constructor(client: SteamDtClient) {
    this.#client = client;
  }

  async getQuotes(marketHashName: string) {
    const evidence = await this.#client.getSinglePrice(marketHashName);
    const observedAt = new Date(evidence.observedAt);
    return verifiedEvidence(
      evidence.source,
      observedAt,
      normalizeSteamDtPrices(marketHashName, evidence.data, observedAt),
      evidence.limitations,
    );
  }

  async getBatchQuotes(marketHashNames: readonly string[]) {
    const evidence = await this.#client.getBatchPrices(marketHashNames);
    const observedAt = new Date(evidence.observedAt);
    const quotes = evidence.data.flatMap((entry) =>
      normalizeSteamDtPrices(entry.marketHashName, entry.dataList, observedAt),
    );
    return verifiedEvidence(evidence.source, observedAt, quotes, evidence.limitations);
  }
}
