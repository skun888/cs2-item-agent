import { readFileSync } from "node:fs";

import { AppError } from "../core/errors.js";

export type PurchasePlatform = "BUFF" | "YYYP";

export interface PlatformFee {
  readonly feeRate: number;
  readonly fixedFee: number;
}

export interface FeeTemplate {
  readonly schemaVersion: 2;
  readonly currency: "CNY";
  readonly steamSaleNetRate: number;
  readonly steamMarketReferenceCnyPerUsd: number;
  readonly purchase: Readonly<Record<PurchasePlatform, PlatformFee>>;
  readonly platformSale: Readonly<Record<PurchasePlatform, PlatformFee>>;
  readonly riskBufferRate: number;
  readonly selectionPolicy: {
    readonly steamBalance: {
      readonly minimumCurrentBalanceRatio: number;
      readonly minimumDefensiveBalanceRatio: number;
    };
    readonly platformBalance: {
      readonly minimumCurrentCashReturnPct: number;
      readonly minimumDefensiveCashReturnPct: number;
    };
    readonly minimumTurnover: number;
    readonly maximumBidToListingRatio: number;
  };
  readonly note: string;
}

export interface LoadedFeeTemplate {
  readonly source: "built_in_default" | "local_file";
  readonly path?: string;
  readonly template: FeeTemplate;
}

export const DEFAULT_FEE_TEMPLATE: FeeTemplate = {
  schemaVersion: 2,
  currency: "CNY",
  steamSaleNetRate: 0.869,
  steamMarketReferenceCnyPerUsd: 7.2,
  purchase: {
    BUFF: { feeRate: 0, fixedFee: 0 },
    YYYP: { feeRate: 0, fixedFee: 0 },
  },
  platformSale: {
    BUFF: { feeRate: 0.025, fixedFee: 0 },
    YYYP: { feeRate: 0.025, fixedFee: 0 },
  },
  riskBufferRate: 0,
  selectionPolicy: {
    steamBalance: { minimumCurrentBalanceRatio: 1.5, minimumDefensiveBalanceRatio: 1.35 },
    platformBalance: { minimumCurrentCashReturnPct: 0, minimumDefensiveCashReturnPct: -5 },
    minimumTurnover: 10,
    maximumBidToListingRatio: 1.25,
  },
  note: "示例参数。卡价从 CSQAQ 每日数据取得；Steam 市场人民币/美元参考汇率与平台费率可在本地模板修改，所有报告必须回显实际采用值。",
};

export function loadFeeTemplate(path?: string): LoadedFeeTemplate {
  if (!path) return { source: "built_in_default", template: DEFAULT_FEE_TEMPLATE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new AppError("CONFIG_ERROR", `Cannot read fee template: ${path}`, {
      cause: error instanceof Error ? error.message : "unknown error",
    });
  }
  return { source: "local_file", path, template: parseFeeTemplate(parsed) };
}

export function parseFeeTemplate(value: unknown): FeeTemplate {
  if (!isRecord(value) || value.currency !== "CNY") {
    throw new AppError("CONFIG_ERROR", "Fee template must use currency CNY.");
  }
  if (value.schemaVersion === 1) return upgradeV1(value);
  if (value.schemaVersion !== 2) throw new AppError("CONFIG_ERROR", "Fee template schemaVersion must be 1 or 2.");
  const purchase = requireRecord(value.purchase, "purchase");
  const platformSale = requireRecord(value.platformSale, "platformSale");
  const selection = requireRecord(value.selectionPolicy, "selectionPolicy");
  const steamPolicy = requireRecord(selection.steamBalance, "selectionPolicy.steamBalance");
  const platformPolicy = requireRecord(selection.platformBalance, "selectionPolicy.platformBalance");
  return {
    schemaVersion: 2,
    currency: "CNY",
    steamSaleNetRate: rate(value.steamSaleNetRate, "steamSaleNetRate", false),
    steamMarketReferenceCnyPerUsd: positive(value.steamMarketReferenceCnyPerUsd, "steamMarketReferenceCnyPerUsd"),
    purchase: { BUFF: parsePlatformFee(purchase.BUFF, "purchase.BUFF"), YYYP: parsePlatformFee(purchase.YYYP, "purchase.YYYP") },
    platformSale: { BUFF: parsePlatformFee(platformSale.BUFF, "platformSale.BUFF"), YYYP: parsePlatformFee(platformSale.YYYP, "platformSale.YYYP") },
    riskBufferRate: rate(value.riskBufferRate, "riskBufferRate", true),
    selectionPolicy: {
      steamBalance: {
        minimumCurrentBalanceRatio: nonNegative(steamPolicy.minimumCurrentBalanceRatio, "minimumCurrentBalanceRatio"),
        minimumDefensiveBalanceRatio: nonNegative(steamPolicy.minimumDefensiveBalanceRatio, "minimumDefensiveBalanceRatio"),
      },
      platformBalance: {
        minimumCurrentCashReturnPct: finite(platformPolicy.minimumCurrentCashReturnPct, "minimumCurrentCashReturnPct"),
        minimumDefensiveCashReturnPct: finite(platformPolicy.minimumDefensiveCashReturnPct, "minimumDefensiveCashReturnPct"),
      },
      minimumTurnover: nonNegative(selection.minimumTurnover, "minimumTurnover"),
      maximumBidToListingRatio: positive(selection.maximumBidToListingRatio, "maximumBidToListingRatio"),
    },
    note: typeof value.note === "string" ? value.note : "User-provided fee assumptions.",
  };
}

function upgradeV1(value: Readonly<Record<string, unknown>>): FeeTemplate {
  const purchase = requireRecord(value.purchase, "purchase");
  const selection = requireRecord(value.selectionPolicy, "selectionPolicy");
  return {
    ...DEFAULT_FEE_TEMPLATE,
    steamSaleNetRate: rate(value.steamSaleNetRate, "steamSaleNetRate", false),
    purchase: { BUFF: parsePlatformFee(purchase.BUFF, "purchase.BUFF"), YYYP: parsePlatformFee(purchase.YYYP, "purchase.YYYP") },
    riskBufferRate: rate(value.riskBufferRate, "riskBufferRate", true),
    selectionPolicy: {
      ...DEFAULT_FEE_TEMPLATE.selectionPolicy,
      steamBalance: {
        minimumCurrentBalanceRatio: nonNegative(selection.minimumCurrentBalanceRatio, "minimumCurrentBalanceRatio"),
        minimumDefensiveBalanceRatio: nonNegative(selection.minimumDefensiveBalanceRatio, "minimumDefensiveBalanceRatio"),
      },
      minimumTurnover: nonNegative(selection.minimumTurnover, "minimumTurnover"),
    },
    note: typeof value.note === "string" ? `${value.note}（已按兼容规则升级为 schemaVersion 2）` : DEFAULT_FEE_TEMPLATE.note,
  };
}

function parsePlatformFee(value: unknown, label: string): PlatformFee {
  const record = requireRecord(value, label);
  return { feeRate: rate(record.feeRate, `${label}.feeRate`, true), fixedFee: nonNegative(record.fixedFee, `${label}.fixedFee`) };
}

function finite(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new AppError("CONFIG_ERROR", `${label} must be finite.`);
  return number;
}
function nonNegative(value: unknown, label: string): number { const n = finite(value, label); if (n < 0) throw new AppError("CONFIG_ERROR", `${label} must be non-negative.`); return n; }
function positive(value: unknown, label: string): number { const n = finite(value, label); if (n <= 0) throw new AppError("CONFIG_ERROR", `${label} must be positive.`); return n; }
function rate(value: unknown, label: string, allowZero: boolean): number { const n = finite(value, label); if (n < 0 || n > 1 || (!allowZero && n === 0)) throw new AppError("CONFIG_ERROR", `${label} must be ${allowZero ? "between 0 and 1" : "greater than 0 and at most 1"}.`); return n; }
function requireRecord(value: unknown, label: string): Readonly<Record<string, unknown>> { if (!isRecord(value)) throw new AppError("CONFIG_ERROR", `${label} must be an object.`); return value; }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
