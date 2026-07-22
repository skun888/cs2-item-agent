export type CsQaqDocumentedTier = "personal" | "enterprise" | "unclear";

export type CsQaqAuditStatus =
  | "available"
  | "authentication_failed"
  | "configuration_required"
  | "permission_denied"
  | "contract_rejected"
  | "rate_limited"
  | "provider_rejected"
  | "unavailable"
  | "network_error"
  | "not_probed";

export interface CsQaqClientOptions {
  readonly apiToken: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly minimumRequestIntervalMs?: number;
  readonly delayImpl?: (milliseconds: number) => Promise<void>;
}

export interface CsQaqItemIdentity {
  readonly goodId: string;
  readonly name: string;
  readonly marketHashName: string;
}

export interface CsQaqItemIdentityPage {
  readonly pageIndex: number;
  readonly pageSize: number;
  readonly total: number;
  readonly items: readonly CsQaqItemIdentity[];
}

export interface CsQaqItemDetail {
  readonly goodId: string;
  readonly name: string;
  readonly marketHashName: string;
  readonly imageUrl?: string;
  readonly typeName?: string;
  readonly rarityName?: string;
  readonly exteriorName?: string;
  readonly defIndex?: number;
  readonly paintIndex?: number;
  readonly minimumFloat?: number;
  readonly maximumFloat?: number;
  readonly buffSellPrice?: number;
  readonly yyypSellPrice?: number;
  readonly steamSellPrice?: number;
  readonly updatedAt?: string;
}

export interface CsQaqHolderRankEntry {
  readonly monitorId: string;
  readonly steamName: string;
  readonly steamId: string;
  readonly avatarUrl?: string;
  readonly quantity: number;
}

export interface CsQaqSupplyPoint {
  readonly quantity: number;
  readonly recordedAt: string;
}

export interface CsQaqHangingQuery {
  readonly pageIndex?: number;
  readonly targetBalance?: "steam" | "platform";
  readonly sourcePlatforms?: "BUFF" | "YYYP" | "BUFF-YYYP";
  readonly steamExit?: "listing" | "highest_bid";
  readonly steamPurchase?: "listing" | "buy_order";
  readonly platformExit?: "listing" | "highest_bid";
  readonly minimumPrice?: number;
  readonly maximumPrice?: number;
  readonly minimumTurnover?: number;
}

export interface CsQaqSectorIndex {
  readonly id: string;
  readonly name: string;
  readonly nameKey: string;
  readonly imageUrl?: string;
  readonly marketIndex: number;
  readonly changeAmount: number;
  readonly changeRatePct: number;
  readonly open: number;
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly updatedAt: string;
}

export interface CsQaqSectorKlinePoint {
  readonly timestamp: number;
  readonly open: number;
  readonly close: number;
  readonly high: number;
  readonly low: number;
  readonly volume?: number;
}

export interface CsQaqCardPricePoint {
  readonly priceCnyPer100Usd: number;
  readonly recordedAt: string;
}

export interface CsQaqMarketHomeData {
  readonly sectors: readonly CsQaqSectorIndex[];
  readonly cardPrices: readonly CsQaqCardPricePoint[];
}

export interface CsQaqCollection {
  readonly id: string;
  readonly name: string;
  readonly comment?: string;
  readonly imageUrl?: string;
  readonly createdAt?: string;
}

export interface CsQaqCollectionItem {
  readonly goodId: string;
  readonly name: string;
  readonly rarityName: string;
  readonly qualityName?: string;
  readonly referencePrice?: number;
  readonly imageUrl?: string;
}

export interface CsQaqHangingEntry {
  readonly goodId: string;
  readonly marketHashName: string;
  readonly name: string;
  readonly imageUrl?: string;
  readonly buffItemId?: string;
  readonly buffSellPrice?: number;
  readonly buffSellCount?: number;
  readonly buffBidPrice?: number;
  readonly buffBidCount?: number;
  readonly yyypItemId?: string;
  readonly yyypSellPrice?: number;
  readonly yyypSellCount?: number;
  readonly yyypBidPrice?: number;
  readonly yyypBidCount?: number;
  readonly steamSellPrice?: number;
  readonly steamSellCount?: number;
  readonly steamBidPrice?: number;
  readonly steamBidCount?: number;
  readonly providerExchangeRatio?: number;
  readonly turnoverNumber?: number;
}

export interface CsQaqCaseCountEntry {
  readonly caseId: string;
  readonly goodId: string;
  readonly name: string;
  readonly daily: number;
  readonly weekly: number;
  readonly monthly: number;
  readonly total: number;
  readonly type: number;
  readonly observedAt: string;
  readonly releasedAt?: string;
  readonly imageUrl?: string;
}

export interface CsQaqCaseRoiEntry {
  readonly id: string;
  readonly goodId: string;
  readonly name: string;
  readonly category?: string;
  readonly sampleCount: number;
  readonly price: number;
  readonly roiPercent: number;
  readonly expectedIncome: number;
  readonly updatedAt: string;
  readonly imageUrl?: string;
}

export interface CsQaqProbeSpec {
  readonly id: string;
  readonly label: string;
  readonly documentedTier: CsQaqDocumentedTier;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly note?: string;
}

export interface CsQaqDataShape {
  readonly kind: "array" | "object" | "primitive" | "null" | "missing";
  readonly rowCount?: number;
  readonly fields: readonly string[];
}

export interface CsQaqAuditProbeResult {
  readonly id: string;
  readonly label: string;
  readonly documentedTier: CsQaqDocumentedTier;
  readonly status: CsQaqAuditStatus;
  readonly requestedAt: string;
  readonly durationMs: number;
  readonly httpStatus?: number;
  readonly providerCode?: string | number;
  readonly providerMessage?: string;
  readonly dataShape: CsQaqDataShape;
  readonly note?: string;
}

export interface CsQaqPermissionAuditReport {
  readonly schemaVersion: 1;
  readonly provider: "csqaq";
  readonly auditedAt: string;
  readonly baseUrl: string;
  readonly minimumRequestIntervalMs: number;
  readonly limitations: readonly string[];
  readonly summary: Readonly<Record<CsQaqAuditStatus, number>>;
  readonly probes: readonly CsQaqAuditProbeResult[];
}
