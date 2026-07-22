import type { CsQaqClient } from "../csqaq/client.js";
import type { MarketAdapterDescriptor, MarketDataAdapter } from "./contract.js";

export const CSQAQ_MARKET_ADAPTER: MarketAdapterDescriptor = {
  id: "csqaq",
  displayName: "CSQAQ",
  kind: "aggregator",
  priority: 200,
  capabilities: [
    "market_quotes",
    "batch_market_quotes",
    "item_catalog",
    "holder_ranking",
    "supply_trend",
    "hanging_candidates",
    "case_intelligence",
    "diy_catalog",
  ],
  platforms: ["BUFF", "YYYP", "STEAM"],
  batchPolicy: { maximumItems: 50, minimumIntervalMs: 0 },
  documentationUrl: "https://docs.csqaq.com",
};

export class CsQaqMarketAdapter implements MarketDataAdapter {
  readonly descriptor = CSQAQ_MARKET_ADAPTER;
  readonly #client: CsQaqClient;

  constructor(client: CsQaqClient) {
    this.#client = client;
  }

  getQuotes(marketHashName: string) {
    return this.#client.getBatchPriceQuotes([marketHashName]);
  }

  getBatchQuotes(marketHashNames: readonly string[]) {
    return this.#client.getBatchPriceQuotes(marketHashNames);
  }
}
