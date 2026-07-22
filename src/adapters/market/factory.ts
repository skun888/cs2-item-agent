import type { CsQaqClient } from "../csqaq/client.js";
import type { SteamDtClient } from "../steamdt/client.js";
import { CsQaqMarketAdapter, CSQAQ_MARKET_ADAPTER } from "./csqaq-adapter.js";
import { MarketAdapterRegistry } from "./registry.js";
import { SteamDtMarketAdapter, STEAMDT_MARKET_ADAPTER } from "./steamdt-adapter.js";

export function createBuiltInMarketAdapterRegistry(input: {
  readonly steamDt?: SteamDtClient;
  readonly csQaq?: CsQaqClient;
}): MarketAdapterRegistry {
  return new MarketAdapterRegistry([
    {
      descriptor: STEAMDT_MARKET_ADAPTER,
      ...(input.steamDt ? { adapter: new SteamDtMarketAdapter(input.steamDt) } : {}),
    },
    {
      descriptor: CSQAQ_MARKET_ADAPTER,
      ...(input.csQaq ? { adapter: new CsQaqMarketAdapter(input.csQaq) } : {}),
    },
  ]);
}
