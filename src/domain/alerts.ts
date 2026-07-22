import { createHash } from "node:crypto";

import { AppError } from "../core/errors.js";
import type { NormalizedMarketQuote } from "./market-quote.js";

export type MarketAlertMetric = "sell_price" | "sell_count" | "bidding_price" | "bidding_count";
export type AlertOperator = "lt" | "lte" | "gt" | "gte";
/** `any` or a stable registered market adapter id. */
export type AlertProvider = string;

export interface MarketAlertRule {
  readonly id: number;
  readonly name?: string;
  readonly enabled: boolean;
  readonly marketHashName: string;
  readonly platform: string;
  readonly provider: AlertProvider;
  readonly metric: MarketAlertMetric;
  readonly operator: AlertOperator;
  readonly threshold: number;
  readonly cooldownMinutes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEvaluatedAt?: string;
  readonly lastConditionMet: boolean;
  readonly lastTriggeredAt?: string;
  readonly lastEvidenceFingerprint?: string;
}

export interface CreateMarketAlertRuleInput {
  readonly name?: string;
  readonly marketHashName: string;
  readonly platform: string;
  readonly provider?: AlertProvider;
  readonly metric: MarketAlertMetric;
  readonly operator: AlertOperator;
  readonly threshold: number;
  readonly cooldownMinutes?: number;
}

export interface MarketAlertEvaluation {
  readonly conditionMet: boolean;
  readonly status: "matched" | "not_matched" | "no_data";
  readonly evaluatedAt: string;
  readonly metric: MarketAlertMetric;
  readonly threshold: number;
  readonly operator: AlertOperator;
  readonly value?: number;
  readonly provider?: string;
  readonly source?: string;
  readonly platform?: string;
  readonly observedAt?: string;
  readonly evidenceFingerprint?: string;
  readonly limitation: string;
}

export function validateCreateMarketAlertRule(
  input: CreateMarketAlertRuleInput,
): Required<Omit<CreateMarketAlertRuleInput, "name">> & { readonly name?: string } {
  const marketHashName = input.marketHashName.trim();
  const platform = input.platform.trim().toUpperCase();
  const provider = input.provider ?? "any";
  const cooldownMinutes = input.cooldownMinutes ?? 60;
  if (!marketHashName) throw new AppError("USAGE_ERROR", "marketHashName is required.");
  if (!platform) throw new AppError("USAGE_ERROR", "platform is required.");
  if (provider !== "any" && !/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(provider)) {
    throw new AppError("USAGE_ERROR", "provider must be any or a stable lowercase adapter id.");
  }
  if (!Number.isFinite(input.threshold) || input.threshold < 0) {
    throw new AppError("USAGE_ERROR", "threshold must be a finite non-negative number.");
  }
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 43_200) {
    throw new AppError("USAGE_ERROR", "cooldownMinutes must be an integer from 0 to 43200.");
  }
  return {
    marketHashName,
    platform,
    provider,
    metric: input.metric,
    operator: input.operator,
    threshold: input.threshold,
    cooldownMinutes,
    ...(input.name?.trim() ? { name: input.name.trim() } : {}),
  };
}

export function evaluateMarketAlertRule(
  rule: MarketAlertRule,
  quotes: readonly NormalizedMarketQuote[],
  evaluatedAt: Date,
): MarketAlertEvaluation {
  const candidates = quotes
    .filter(
      (quote) =>
        quote.marketHashName.toLocaleLowerCase() === rule.marketHashName.toLocaleLowerCase() &&
        quote.platform.toUpperCase() === rule.platform.toUpperCase() &&
        (rule.provider === "any" || quote.provider === rule.provider),
    )
    .flatMap((quote) => {
      const value = metricValue(rule.metric, quote);
      return value === undefined || !isUsableObservation(rule.metric, quote, value)
        ? []
        : [{ quote, value }];
    });

  if (candidates.length === 0) {
    return {
      conditionMet: false,
      status: "no_data",
      evaluatedAt: evaluatedAt.toISOString(),
      metric: rule.metric,
      threshold: rule.threshold,
      operator: rule.operator,
      limitation: "No positive, usable quote matched the requested provider and platform. Zero placeholders are ignored.",
    };
  }

  const selected = [...candidates].sort((left, right) =>
    rule.operator === "lt" || rule.operator === "lte"
      ? left.value - right.value
      : right.value - left.value,
  )[0]!;
  const conditionMet = compare(selected.value, rule.operator, rule.threshold);
  const evidenceFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        ruleId: rule.id,
        provider: selected.quote.provider,
        source: selected.quote.source,
        platform: selected.quote.platform,
        metric: rule.metric,
        value: selected.value,
        observedAt: selected.quote.observedAt,
      }),
    )
    .digest("hex");
  return {
    conditionMet,
    status: conditionMet ? "matched" : "not_matched",
    evaluatedAt: evaluatedAt.toISOString(),
    metric: rule.metric,
    threshold: rule.threshold,
    operator: rule.operator,
    value: selected.value,
    provider: selected.quote.provider,
    source: selected.quote.source,
    platform: selected.quote.platform,
    observedAt: selected.quote.observedAt,
    evidenceFingerprint,
    limitation: "The alert is based on a provider snapshot and does not prove an executable order or guaranteed profit.",
  };
}

export function isCooldownActive(rule: MarketAlertRule, at: Date): boolean {
  if (!rule.lastTriggeredAt || rule.cooldownMinutes === 0) return false;
  const last = new Date(rule.lastTriggeredAt).valueOf();
  return Number.isFinite(last) && at.valueOf() - last < rule.cooldownMinutes * 60_000;
}

function metricValue(metric: MarketAlertMetric, quote: NormalizedMarketQuote): number | undefined {
  switch (metric) {
    case "sell_price": return quote.sellPrice;
    case "sell_count": return quote.sellCount;
    case "bidding_price": return quote.biddingPrice;
    case "bidding_count": return quote.biddingCount;
  }
}

function isUsableObservation(
  metric: MarketAlertMetric,
  quote: NormalizedMarketQuote,
  value: number,
): boolean {
  if (!Number.isFinite(value) || value < 0) return false;
  if (metric === "sell_price") return value > 0;
  if (metric === "bidding_price") return value > 0;
  if (metric === "sell_count") return value > 0 && (quote.sellPrice ?? 0) > 0;
  return value > 0 && (quote.biddingPrice ?? 0) > 0;
}

function compare(value: number, operator: AlertOperator, threshold: number): boolean {
  switch (operator) {
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
  }
}
