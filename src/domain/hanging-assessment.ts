import type { CsQaqHangingEntry } from "../adapters/csqaq/types.js";
import type { FeeTemplate, LoadedFeeTemplate, PurchasePlatform } from "./fee-template.js";
import type { SevenDayScenario } from "./seven-day-scenario.js";

export type HangingTargetBalance = "steam" | "platform";
export type SteamExitMode = "highest_bid" | "listing";
export type SteamPurchaseMode = "listing" | "buy_order";
export type PlatformExitMode = "highest_bid" | "listing";
export type HangingItemCategory = "case" | "weapon_skin" | "sticker" | "knife" | "gloves" | "other";

export interface HangingItemPolicy {
  readonly category: HangingItemCategory;
  readonly defaultCandidatePoolEligible: boolean;
  readonly treatment: "preferred" | "eligible" | "excluded_default" | "unknown";
  readonly reasonZh: string;
}

export interface HangingScenarioResult {
  readonly targetBalance: HangingTargetBalance;
  readonly scenarioReturnPct: number;
  readonly effectivePurchaseCostCny: number;
  readonly grossExitValue: number;
  readonly netExitValue: number;
  readonly valuePerCny: number;
  readonly returnPct?: number;
  readonly steamGrossPrice?: number;
  readonly steamBalanceAfterFee?: number;
  readonly effectivePurchaseCost?: number;
  readonly steamBalancePerCny?: number;
  readonly steamFaceValueUsd?: number;
  readonly cardCostCny?: number;
  readonly platformNetProceedsCny?: number;
}

export interface HangingAssessment {
  readonly model: { readonly type: "hanging_execution"; readonly version: 2; readonly purposeZh: string; readonly notForZh: string };
  readonly targetBalance: HangingTargetBalance;
  readonly marketHashName: string;
  readonly sourcePlatform: PurchasePlatform;
  readonly steamExitMode?: SteamExitMode;
  readonly steamPurchaseMode?: SteamPurchaseMode;
  readonly platformExitMode?: PlatformExitMode;
  readonly cardPrice?: { readonly priceCnyPer100Usd: number; readonly recordedAt: string };
  readonly status: "candidate" | "caution" | "avoid" | "insufficient_data";
  readonly input: Readonly<Record<string, number | string | undefined>>;
  readonly feeAssumptions: LoadedFeeTemplate;
  readonly itemPolicy: HangingItemPolicy;
  readonly current?: HangingScenarioResult;
  readonly sevenDay?: { readonly defensive: HangingScenarioResult; readonly base: HangingScenarioResult; readonly optimistic: HangingScenarioResult };
  readonly policyChecks: readonly { readonly name: string; readonly actual?: number; readonly threshold: number; readonly passed: boolean }[];
  readonly dataQuality: { readonly valid: boolean; readonly warnings: readonly string[] };
  readonly explanationZh: readonly string[];
  readonly limitations: readonly string[];
}

export function assessHangingEntry(input: {
  readonly entry: CsQaqHangingEntry;
  readonly targetBalance?: HangingTargetBalance;
  readonly sourcePlatform: PurchasePlatform;
  readonly steamExitMode?: SteamExitMode;
  readonly steamPurchaseMode?: SteamPurchaseMode;
  readonly platformExitMode?: PlatformExitMode;
  readonly cardPrice?: { readonly priceCnyPer100Usd: number; readonly recordedAt: string };
  readonly fees: LoadedFeeTemplate;
  readonly sevenDayScenario?: SevenDayScenario;
  readonly explicitItemRequest?: boolean;
}): HangingAssessment {
  const targetBalance = input.targetBalance ?? "steam";
  const steamExitMode = input.steamExitMode ?? "highest_bid";
  const steamPurchaseMode = input.steamPurchaseMode ?? "listing";
  const platformExitMode = input.platformExitMode ?? "highest_bid";
  const itemPolicy = classifyHangingItem(input.entry.marketHashName);
  const purchasePrice = targetBalance === "steam"
    ? platformListing(input.entry, input.sourcePlatform)
    : steamPurchaseMode === "buy_order" ? input.entry.steamBidPrice : input.entry.steamSellPrice;
  const exitPrice = targetBalance === "steam"
    ? steamExitMode === "highest_bid" ? input.entry.steamBidPrice : input.entry.steamSellPrice
    : platformExit(input.entry, input.sourcePlatform, platformExitMode);
  const qualityWarnings = priceSanityWarnings(input.entry, input.sourcePlatform, input.fees.template);
  const cardMissing = targetBalance === "platform" && !input.cardPrice;
  const common = {
    model: {
      type: "hanging_execution" as const,
      version: 2 as const,
      purposeZh: targetBalance === "steam"
        ? "评估从国内平台买入、七日后在 Steam 退出以获得 Steam 余额。"
        : "评估用美金卡取得 Steam 余额、在 Steam 买入并于七日后在国内平台退出以获得平台余额。",
      notForZh: "不用于判断大商运作、控盘或中长期投资价值。",
    },
    targetBalance,
    marketHashName: input.entry.marketHashName,
    sourcePlatform: input.sourcePlatform,
    ...(targetBalance === "steam" ? { steamExitMode } : { steamPurchaseMode, platformExitMode }),
    ...(input.cardPrice ? { cardPrice: input.cardPrice } : {}),
    input: {
      purchasePrice,
      exitPrice,
      turnoverNumber: input.entry.turnoverNumber,
      providerExchangeRatio: input.entry.providerExchangeRatio,
    },
    feeAssumptions: input.fees,
    itemPolicy,
    dataQuality: { valid: qualityWarnings.length === 0, warnings: qualityWarnings },
    limitations: [
      "Steam 余额、平台余额和人民币现金不是同一种资产，两个方向的排行不可混用。",
      "七日结果是价格情景，不是预测；不包含排队、下架、冻结、限额和实际成交概率。",
      ...(targetBalance === "platform"
        ? ["Steam 人民币展示价先按模板中的参考汇率折算美元面值，再按 CSQAQ 每日卡价计算人民币资金成本；两项假设均在报告中回显。"]
        : []),
      ...(!itemPolicy.defaultCandidatePoolEligible ? [`${itemPolicy.reasonZh}；仅在用户明确指定时保留数值评估。`] : []),
    ],
  };
  if (!isPositive(purchasePrice) || !isPositive(exitPrice) || cardMissing || qualityWarnings.length > 0) {
    return {
      ...common,
      status: "insufficient_data",
      policyChecks: [],
      explanationZh: [
        cardMissing ? "缺少当日 Steam 卡价，不能计算获得平台余额的真实人民币资金成本。" : "价格字段缺失或未通过合理性检查，拒绝生成可交易结论。",
      ],
    };
  }

  const current = calculateScenario(targetBalance, purchasePrice, exitPrice, 0, input.sourcePlatform, input.fees.template, input.cardPrice);
  const sevenDay = scenarioResults(targetBalance, purchasePrice, exitPrice, input.sourcePlatform, input.fees.template, input.cardPrice, input.sevenDayScenario);
  const policy = input.fees.template.selectionPolicy;
  const checks = targetBalance === "steam"
    ? [
        check("current_steam_balance_ratio", current.valuePerCny, policy.steamBalance.minimumCurrentBalanceRatio),
        check("defensive_steam_balance_ratio", sevenDay?.defensive.valuePerCny, policy.steamBalance.minimumDefensiveBalanceRatio),
        check("turnover", input.entry.turnoverNumber, policy.minimumTurnover),
      ]
    : [
        check("current_platform_cash_return_pct", current.returnPct, policy.platformBalance.minimumCurrentCashReturnPct),
        check("defensive_platform_cash_return_pct", sevenDay?.defensive.returnPct, policy.platformBalance.minimumDefensiveCashReturnPct),
        check("turnover", input.entry.turnoverNumber, policy.minimumTurnover),
      ];
  const passed = checks.filter((item) => item.passed).length;
  const calculated = !sevenDay ? "caution" : passed === checks.length ? "candidate" : passed === 0 ? "avoid" : "caution";
  const status = !itemPolicy.defaultCandidatePoolEligible && input.explicitItemRequest && calculated === "candidate" ? "caution" : calculated;
  return {
    ...common,
    status,
    current,
    ...(sevenDay ? { sevenDay } : {}),
    policyChecks: checks,
    explanationZh: targetBalance === "steam"
      ? [
          `当前每 1 元人民币买入成本可得到约 ${current.valuePerCny} 元 Steam 余额。`,
          `Steam 出售到手系数采用 ${input.fees.template.steamSaleNetRate}。`,
          itemPolicy.reasonZh,
        ]
      : [
          `当日卡价采用 ¥${input.cardPrice!.priceCnyPer100Usd}/100 USD，当前估算平台净回款/人民币资金成本为 ${current.valuePerCny}。`,
          `当前现金口径收益率约 ${current.returnPct}%，Steam 人民币/美元参考汇率采用 ${input.fees.template.steamMarketReferenceCnyPerUsd}。`,
          itemPolicy.reasonZh,
        ],
  };
}

export function classifyHangingItem(marketHashName: string): HangingItemPolicy {
  const normalized = marketHashName.trim().toLowerCase();
  if (normalized.startsWith("sticker |") || normalized.startsWith("patch |")) return { category: "sticker", defaultCandidatePoolEligible: false, treatment: "excluded_default", reasonZh: "贴纸/布章默认不进入挂刀池：高比例不等于高流动性。" };
  if (normalized.includes("gloves |") || normalized.includes("hand wraps |")) return { category: "gloves", defaultCandidatePoolEligible: false, treatment: "excluded_default", reasonZh: "手套个体差异和自用属性较强，默认排除。" };
  if (normalized.startsWith("★") || normalized.startsWith("鈽")) return { category: "knife", defaultCandidatePoolEligible: false, treatment: "excluded_default", reasonZh: "刀具资金占用和个体差异较大，默认排除。" };
  if (normalized.endsWith(" case") || normalized.includes("weapon case")) return { category: "case", defaultCandidatePoolEligible: true, treatment: "preferred", reasonZh: "武器箱通常标准化且流动性较好，但仍需通过七日防守情景。" };
  if (normalized.includes(" | ")) return { category: "weapon_skin", defaultCandidatePoolEligible: true, treatment: "eligible", reasonZh: "枪皮可进入候选池，优先选择高流通的中低价标准品。" };
  return { category: "other", defaultCandidatePoolEligible: false, treatment: "unknown", reasonZh: "无法可靠识别品类，默认不进入自动候选池。" };
}

function calculateScenario(target: HangingTargetBalance, purchasePrice: number, exitPrice: number, scenarioReturnPct: number, platform: PurchasePlatform, fees: FeeTemplate, card?: { priceCnyPer100Usd: number }): HangingScenarioResult {
  if (target === "steam") {
    const purchase = fees.purchase[platform];
    const effectiveCost = purchasePrice * (1 + purchase.feeRate + fees.riskBufferRate) + purchase.fixedFee;
    const gross = exitPrice * (1 + scenarioReturnPct / 100);
    const net = gross * fees.steamSaleNetRate;
    return {
      targetBalance: target, scenarioReturnPct: round(scenarioReturnPct), effectivePurchaseCostCny: round(effectiveCost),
      grossExitValue: round(gross), netExitValue: round(net), valuePerCny: round(net / effectiveCost),
      steamGrossPrice: round(gross), steamBalanceAfterFee: round(net), effectivePurchaseCost: round(effectiveCost), steamBalancePerCny: round(net / effectiveCost),
    };
  }
  const usdFace = purchasePrice / fees.steamMarketReferenceCnyPerUsd;
  const cardCost = usdFace * card!.priceCnyPer100Usd / 100 * (1 + fees.riskBufferRate);
  const gross = exitPrice * (1 + scenarioReturnPct / 100);
  const sale = fees.platformSale[platform];
  const net = gross * (1 - sale.feeRate) - sale.fixedFee;
  return {
    targetBalance: target, scenarioReturnPct: round(scenarioReturnPct), effectivePurchaseCostCny: round(cardCost),
    grossExitValue: round(gross), netExitValue: round(net), valuePerCny: round(net / cardCost), returnPct: round((net / cardCost - 1) * 100),
    steamFaceValueUsd: round(usdFace), cardCostCny: round(cardCost), platformNetProceedsCny: round(net),
  };
}

function scenarioResults(target: HangingTargetBalance, purchasePrice: number, exitPrice: number, platform: PurchasePlatform, fees: FeeTemplate, card: { priceCnyPer100Usd: number } | undefined, scenario: SevenDayScenario | undefined): HangingAssessment["sevenDay"] | undefined {
  if (scenario?.status !== "available" || !scenario.scenarios) return undefined;
  return {
    defensive: calculateScenario(target, purchasePrice, exitPrice, scenario.scenarios.defensive.returnPct, platform, fees, card),
    base: calculateScenario(target, purchasePrice, exitPrice, scenario.scenarios.base.returnPct, platform, fees, card),
    optimistic: calculateScenario(target, purchasePrice, exitPrice, scenario.scenarios.optimistic.returnPct, platform, fees, card),
  };
}

function priceSanityWarnings(entry: CsQaqHangingEntry, platform: PurchasePlatform, fees: FeeTemplate): string[] {
  const listing = platformListing(entry, platform);
  const bid = platformExit(entry, platform, "highest_bid");
  const warnings: string[] = [];
  if (isPositive(listing) && isPositive(bid) && bid / listing > fees.selectionPolicy.maximumBidToListingRatio) {
    warnings.push(`${platform} 求购价/在售价为 ${round(bid / listing)}，超过模板上限 ${fees.selectionPolicy.maximumBidToListingRatio}；可能是异常或不可执行订单。`);
  }
  return warnings;
}

function platformListing(entry: CsQaqHangingEntry, platform: PurchasePlatform): number | undefined { return platform === "BUFF" ? entry.buffSellPrice : entry.yyypSellPrice; }
function platformExit(entry: CsQaqHangingEntry, platform: PurchasePlatform, mode: PlatformExitMode): number | undefined { return platform === "BUFF" ? (mode === "listing" ? entry.buffSellPrice : entry.buffBidPrice) : (mode === "listing" ? entry.yyypSellPrice : entry.yyypBidPrice); }
function check(name: string, actual: number | undefined, threshold: number) { return { name, ...(actual !== undefined ? { actual } : {}), threshold, passed: actual !== undefined && actual >= threshold }; }
function isPositive(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value) && value > 0; }
function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
