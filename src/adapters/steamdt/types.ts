export interface SteamDtPriceEntry {
  readonly platform: string;
  readonly platformItemId?: string;
  readonly sellPrice?: number;
  readonly sellCount?: number;
  readonly biddingPrice?: number;
  readonly biddingCount?: number;
  readonly updateTime?: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface SteamDtBatchPriceEntry {
  readonly marketHashName: string;
  readonly dataList: readonly SteamDtPriceEntry[];
}

export interface SteamDtApiEnvelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly errorCode?: string | number;
  readonly errorMessage?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type SteamDtRawKlinePoint = readonly [
  timestamp: string | number,
  open: number,
  close: number,
  high: number,
  low: number,
];

export interface SteamDtKlinePoint {
  readonly timestamp: number;
  readonly open: number;
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly raw: SteamDtRawKlinePoint;
}

export interface SteamDtClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface SteamDtInspectPreview {
  readonly sync: boolean;
  readonly success: boolean;
  readonly taskId?: string;
  readonly fingerprint?: string;
  readonly screenshots: {
    readonly front: readonly string[];
    readonly back: readonly string[];
    readonly detail: readonly string[];
  };
  readonly existSticker?: boolean;
  readonly protoEncodeStr?: string;
}

export interface KlineQuery {
  readonly marketHashName: string;
  readonly platform: string;
  readonly type: number;
  readonly specialStyle?: string;
}
