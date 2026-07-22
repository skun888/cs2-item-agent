export type InventoryFetchStatus =
  | "public"
  | "private_or_unavailable"
  | "rate_limited"
  | "temporary_failure";

export interface SteamInventoryAsset {
  readonly assetId: string;
  readonly classId: string;
  readonly instanceId: string;
  readonly contextId: string;
  readonly amount: number;
  readonly marketHashName?: string;
  readonly displayName?: string;
  readonly itemType?: string;
  readonly tradable?: boolean;
  readonly marketable?: boolean;
  readonly commodity?: boolean;
  readonly inspectLink?: string;
  readonly iconUrl?: string;
  readonly paintSeed?: number;
  readonly paintWear?: number;
  readonly paintWearBits?: number;
  readonly paintIndex?: number;
  readonly nameTag?: string;
  readonly charmTemplate?: number;
  readonly itemCertificate?: string;
  readonly observationFingerprint?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface SteamInventoryFetchResult {
  readonly source: "steam-community:public-inventory";
  readonly steamId: string;
  readonly observedAt: string;
  readonly status: InventoryFetchStatus;
  readonly httpStatus?: number;
  readonly message?: string;
  readonly assets: readonly SteamInventoryAsset[];
  readonly totalInventoryCount?: number;
  readonly pageCount: number;
  readonly complete: boolean;
}

export interface SteamInventoryClientOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly proxyUrl?: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
}
