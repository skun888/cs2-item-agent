import { createHash } from "node:crypto";

import { AppError } from "../core/errors.js";
import type { AlertOperator, AlertProvider, MarketAlertMetric } from "./alerts.js";
import type { NormalizedMarketQuote } from "./market-quote.js";

export type CompositeMarketMetric =
  | MarketAlertMetric
  | "spread_amount"
  | "spread_rate"
  | "bidding_sell_count_ratio";

export type CompositeInventoryMetric =
  | "added_quantity"
  | "removed_quantity"
  | "inventory_value"
  | "composition_change_amount"
  | "composition_change_rate"
  | "price_coverage"
  | "high_value_added_count"
  | "high_value_removed_count";

export interface CompositeMarketCondition {
  readonly type: "market";
  readonly marketHashName: string;
  readonly platform: string;
  readonly provider?: AlertProvider;
  readonly metric: CompositeMarketMetric;
  readonly mode?: "current" | "change_rate";
  readonly windowMinutes?: number | undefined;
  readonly operator: AlertOperator;
  readonly threshold: number;
}

export interface CompositeInventoryCondition {
  readonly type: "inventory";
  readonly steamId: string;
  readonly metric: CompositeInventoryMetric;
  readonly marketHashName?: string | undefined;
  readonly windowMinutes?: number;
  readonly operator: AlertOperator;
  readonly threshold: number;
}

export type CompositeAlertLeaf = CompositeMarketCondition | CompositeInventoryCondition;

export type CompositeAlertExpression =
  | CompositeAlertLeaf
  | { readonly type: "all"; readonly conditions: readonly CompositeAlertExpression[] }
  | { readonly type: "any"; readonly conditions: readonly CompositeAlertExpression[] };

export interface CreateCompositeAlertRuleInput {
  readonly name: string;
  readonly expression: CompositeAlertExpression;
  readonly cooldownMinutes?: number;
  readonly minimumConsecutiveMatches?: number;
  readonly notifyOnRecovery?: boolean;
  readonly maxDataSkewMinutes?: number;
}

export interface CompositeAlertRule {
  readonly id: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly expression: CompositeAlertExpression;
  readonly cooldownMinutes: number;
  readonly minimumConsecutiveMatches: number;
  readonly notifyOnRecovery: boolean;
  readonly maxDataSkewMinutes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEvaluatedAt?: string;
  readonly lastConditionState?: boolean;
  readonly consecutiveMatches: number;
  readonly lastTriggeredAt?: string;
  readonly lastEvidenceFingerprint?: string;
}

export interface CompositeLeafEvaluation {
  readonly condition: CompositeAlertLeaf;
  readonly status: "matched" | "not_matched" | "unknown";
  readonly value?: number;
  readonly observedAt?: string;
  readonly provider?: string;
  readonly source?: string;
  readonly baselineValue?: number;
  readonly baselineObservedAt?: string;
  readonly limitation: string;
}

export interface CompositeAlertEvaluation {
  readonly status: "matched" | "not_matched" | "unknown";
  readonly conditionMet?: boolean;
  readonly evaluatedAt: string;
  readonly evidenceFingerprint: string;
  readonly leaves: readonly CompositeLeafEvaluation[];
  readonly dataSkewMinutes?: number;
  readonly limitation: string;
}

export interface CompositeAlertPreview {
  readonly normalized: Required<Omit<CreateCompositeAlertRuleInput, "notifyOnRecovery">> & {
    readonly notifyOnRecovery: boolean;
  };
  readonly conditionCount: number;
  readonly marketItems: readonly string[];
  readonly steamIds: readonly string[];
  readonly requiresLocalBaseline: boolean;
  readonly limitations: readonly string[];
}

const MARKET_METRICS: readonly CompositeMarketMetric[] = [
  "sell_price", "sell_count", "bidding_price", "bidding_count",
  "spread_amount", "spread_rate", "bidding_sell_count_ratio",
];
const INVENTORY_METRICS: readonly CompositeInventoryMetric[] = [
  "added_quantity", "removed_quantity", "inventory_value",
  "composition_change_amount", "composition_change_rate", "price_coverage",
  "high_value_added_count", "high_value_removed_count",
];
const OPERATORS: readonly AlertOperator[] = ["lt", "lte", "gt", "gte"];
const ADAPTER_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export function previewCompositeAlertRule(input: CreateCompositeAlertRuleInput): CompositeAlertPreview {
  const name = requiredText(input.name, "name", 100);
  const expression = normalizeExpression(input.expression, 1);
  const cooldownMinutes = input.cooldownMinutes ?? 60;
  const minimumConsecutiveMatches = input.minimumConsecutiveMatches ?? 1;
  const notifyOnRecovery = input.notifyOnRecovery ?? false;
  const maxDataSkewMinutes = input.maxDataSkewMinutes ?? 30;
  requireInteger(cooldownMinutes, "cooldownMinutes", 0, 43_200);
  requireInteger(minimumConsecutiveMatches, "minimumConsecutiveMatches", 1, 10);
  requireInteger(maxDataSkewMinutes, "maxDataSkewMinutes", 1, 1_440);
  const leaves = collectCompositeLeaves(expression);
  if (leaves.length > 20) throw new AppError("USAGE_ERROR", "A composite rule supports at most 20 leaf conditions.");
  return {
    normalized: {
      name,
      expression,
      cooldownMinutes,
      minimumConsecutiveMatches,
      notifyOnRecovery,
      maxDataSkewMinutes,
    },
    conditionCount: leaves.length,
    marketItems: unique(leaves.flatMap((leaf) => leaf.type === "market" ? [leaf.marketHashName] : [])),
    steamIds: unique(leaves.flatMap((leaf) => leaf.type === "inventory" ? [leaf.steamId] : [])),
    requiresLocalBaseline: leaves.some((leaf) => leaf.type === "market" && leaf.mode === "change_rate"),
    limitations: [
      "Missing or stale required evidence makes the rule unknown and never triggers a notification.",
      "Percentage changes use local append-only observations; insufficient history is waiting_for_baseline.",
      "The Agent must show this normalized rule and obtain user confirmation before saving it.",
    ],
  };
}

export function collectCompositeLeaves(expression: CompositeAlertExpression): readonly CompositeAlertLeaf[] {
  if (expression.type === "market" || expression.type === "inventory") return [expression];
  return expression.conditions.flatMap(collectCompositeLeaves);
}

export async function evaluateCompositeAlertExpression(
  expression: CompositeAlertExpression,
  resolve: (leaf: CompositeAlertLeaf) => Promise<CompositeLeafEvaluation>,
  evaluatedAt: Date,
  maxDataSkewMinutes: number,
): Promise<CompositeAlertEvaluation> {
  const leaves: CompositeLeafEvaluation[] = [];
  const walk = async (node: CompositeAlertExpression): Promise<"matched" | "not_matched" | "unknown"> => {
    if (node.type === "market" || node.type === "inventory") {
      const result = await resolve(node);
      leaves.push(result);
      return result.status;
    }
    const children: ("matched" | "not_matched" | "unknown")[] = [];
    for (const child of node.conditions) children.push(await walk(child));
    if (node.type === "all") {
      if (children.includes("not_matched")) return "not_matched";
      return children.includes("unknown") ? "unknown" : "matched";
    }
    if (children.includes("matched")) return "matched";
    return children.includes("unknown") ? "unknown" : "not_matched";
  };
  let status = await walk(expression);
  const times = leaves.flatMap((leaf) => leaf.observedAt ? [new Date(leaf.observedAt).valueOf()] : []);
  const finiteTimes = times.filter(Number.isFinite);
  const dataSkewMinutes = finiteTimes.length > 1
    ? (Math.max(...finiteTimes) - Math.min(...finiteTimes)) / 60_000
    : undefined;
  if (status === "matched" && dataSkewMinutes !== undefined && dataSkewMinutes > maxDataSkewMinutes) {
    status = "unknown";
  }
  const evidenceFingerprint = createHash("sha256").update(JSON.stringify({
    status,
    leaves: leaves.map((leaf) => ({
      type: leaf.condition.type,
      value: leaf.value,
      observedAt: leaf.observedAt,
      baselineValue: leaf.baselineValue,
      baselineObservedAt: leaf.baselineObservedAt,
      provider: leaf.provider,
      source: leaf.source,
    })),
  })).digest("hex");
  return {
    status,
    ...(status === "matched" ? { conditionMet: true } : status === "not_matched" ? { conditionMet: false } : {}),
    evaluatedAt: evaluatedAt.toISOString(),
    evidenceFingerprint,
    leaves,
    ...(dataSkewMinutes !== undefined ? { dataSkewMinutes } : {}),
    limitation: status === "unknown"
      ? dataSkewMinutes !== undefined && dataSkewMinutes > maxDataSkewMinutes
        ? `Required evidence timestamps differ by ${dataSkewMinutes.toFixed(1)} minutes, above the ${maxDataSkewMinutes}-minute limit.`
        : "At least one required branch is unknown and the expression cannot be decided safely."
      : "A matched rule is based on public observations and does not prove execution, causality, or guaranteed profit.",
  };
}

export function compareAlertValue(value: number, operator: AlertOperator, threshold: number): boolean {
  switch (operator) {
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
  }
}

export function compositeMarketMetricValue(
  metric: CompositeMarketMetric,
  quote: NormalizedMarketQuote,
): number | undefined {
  switch (metric) {
    case "sell_price": return positive(quote.sellPrice);
    case "sell_count": return positive(quote.sellCount) && positive(quote.sellPrice) ? quote.sellCount : undefined;
    case "bidding_price": return positive(quote.biddingPrice);
    case "bidding_count": return positive(quote.biddingCount) && positive(quote.biddingPrice) ? quote.biddingCount : undefined;
    case "spread_amount": {
      const sell = positive(quote.sellPrice);
      const bid = positive(quote.biddingPrice);
      return sell !== undefined && bid !== undefined ? sell - bid : undefined;
    }
    case "spread_rate": {
      const sell = positive(quote.sellPrice);
      const bid = positive(quote.biddingPrice);
      return sell !== undefined && bid !== undefined ? (sell - bid) / sell : undefined;
    }
    case "bidding_sell_count_ratio": {
      const sellCount = positive(quote.sellCount);
      const biddingCount = positive(quote.biddingCount);
      return sellCount !== undefined && biddingCount !== undefined ? biddingCount / sellCount : undefined;
    }
  }
}

function normalizeExpression(value: CompositeAlertExpression, depth: number): CompositeAlertExpression {
  if (depth > 4) throw new AppError("USAGE_ERROR", "Composite rule nesting cannot exceed 4 levels.");
  if (!value || typeof value !== "object") throw new AppError("USAGE_ERROR", "expression must be an object.");
  if (value.type === "all" || value.type === "any") {
    if (!Array.isArray(value.conditions) || value.conditions.length < 2 || value.conditions.length > 20) {
      throw new AppError("USAGE_ERROR", `${value.type} groups require 2 to 20 conditions.`);
    }
    return { type: value.type, conditions: value.conditions.map((child) => normalizeExpression(child, depth + 1)) };
  }
  if (value.type === "market") {
    if (!MARKET_METRICS.includes(value.metric)) throw new AppError("USAGE_ERROR", "Unsupported market metric.");
    if (!OPERATORS.includes(value.operator)) throw new AppError("USAGE_ERROR", "Unsupported operator.");
    const provider = value.provider ?? "any";
    if (provider !== "any" && !ADAPTER_ID.test(provider)) {
      throw new AppError("USAGE_ERROR", "Market provider must be any or a stable lowercase adapter id.");
    }
    const mode = value.mode ?? "current";
    if (mode !== "current" && mode !== "change_rate") throw new AppError("USAGE_ERROR", "Unsupported market mode.");
    if (!Number.isFinite(value.threshold)) throw new AppError("USAGE_ERROR", "threshold must be finite.");
    if (mode === "change_rate") requireWindow(value.windowMinutes);
    return {
      type: "market",
      marketHashName: requiredText(value.marketHashName, "marketHashName", 256),
      platform: requiredText(value.platform, "platform", 64).toUpperCase(),
      provider,
      metric: value.metric,
      mode,
      ...(mode === "change_rate" ? { windowMinutes: value.windowMinutes } : {}),
      operator: value.operator,
      threshold: value.threshold,
    };
  }
  if (value.type === "inventory") {
    if (!INVENTORY_METRICS.includes(value.metric)) throw new AppError("USAGE_ERROR", "Unsupported inventory metric.");
    if (!OPERATORS.includes(value.operator)) throw new AppError("USAGE_ERROR", "Unsupported operator.");
    if (!/^\d{17}$/.test(value.steamId)) throw new AppError("USAGE_ERROR", "steamId must be a 17-digit SteamID64.");
    if (!Number.isFinite(value.threshold)) throw new AppError("USAGE_ERROR", "threshold must be finite.");
    const windowMinutes = value.windowMinutes ?? 30;
    requireWindow(windowMinutes);
    return {
      type: "inventory",
      steamId: value.steamId,
      metric: value.metric,
      ...(value.marketHashName?.trim() ? { marketHashName: value.marketHashName.trim() } : {}),
      windowMinutes,
      operator: value.operator,
      threshold: value.threshold,
    };
  }
  throw new AppError("USAGE_ERROR", "Unknown composite expression node type.");
}

function requireWindow(value: number | undefined): asserts value is number {
  requireInteger(value, "windowMinutes", 30, 10_080);
}

function requireInteger(value: number | undefined, name: string, minimum: number, maximum: number): asserts value is number {
  if (!Number.isInteger(value) || value === undefined || value < minimum || value > maximum) {
    throw new AppError("USAGE_ERROR", `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function requiredText(value: string, name: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new AppError("USAGE_ERROR", `${name} is required and must not exceed ${maximum} characters.`);
  return normalized;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function positive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
