import type {
  NotificationRetryOptions,
  WechatNotifier,
} from "../adapters/notifications/wechat.js";
import { AppError, toPublicError } from "../core/errors.js";
import {
  evaluateMarketAlertRule,
  isCooldownActive,
  validateCreateMarketAlertRule,
  type CreateMarketAlertRuleInput,
  type MarketAlertEvaluation,
  type MarketAlertRule,
} from "../domain/alerts.js";
import {
  collectCompositeLeaves,
  compareAlertValue,
  compositeMarketMetricValue,
  evaluateCompositeAlertExpression,
  previewCompositeAlertRule,
  type CompositeAlertEvaluation,
  type CompositeAlertLeaf,
  type CompositeAlertPreview,
  type CompositeAlertRule,
  type CompositeLeafEvaluation,
  type CreateCompositeAlertRuleInput,
} from "../domain/composite-alerts.js";
import type { MarketCompatibilityService } from "./market-compatibility-service.js";
import type { AppDatabase } from "../storage/database.js";

export type AlertRunStatus =
  | "notified"
  | "not_matched"
  | "no_data"
  | "duplicate_active_condition"
  | "cooldown"
  | "notification_unconfigured"
  | "notification_failed";

export interface AlertRuleRunResult {
  readonly ruleId: number;
  readonly status: AlertRunStatus;
  readonly evaluation: MarketAlertEvaluation;
  readonly notification?: {
    readonly channel: "enterprise_wechat";
    readonly status: "sent" | "failed" | "skipped";
    readonly attemptCount: number;
    readonly message?: string;
  };
}

export interface AlertRunReport {
  readonly startedAt: string;
  readonly completedAt: string;
  readonly enabledRules: number;
  readonly notified: number;
  readonly results: readonly AlertRuleRunResult[];
  readonly enabledCompositeRules: number;
  readonly compositeResults: readonly CompositeAlertRuleRunResult[];
  readonly limitations: readonly string[];
}

export type CompositeAlertRunStatus =
  | "notified"
  | "recovery_notified"
  | "not_matched"
  | "unknown"
  | "waiting_consecutive"
  | "duplicate_active_condition"
  | "cooldown"
  | "notification_unconfigured"
  | "notification_failed";

export interface CompositeAlertRuleRunResult {
  readonly ruleId: number;
  readonly status: CompositeAlertRunStatus;
  readonly evaluation: CompositeAlertEvaluation;
  readonly consecutiveMatches: number;
  readonly notification?: AlertRuleRunResult["notification"];
}

export class AlertService {
  readonly #market: MarketCompatibilityService | undefined;
  readonly #database: AppDatabase;
  readonly #notifier: WechatNotifier | undefined;
  readonly #now: () => Date;
  readonly #notificationRetry: NotificationRetryOptions;

  constructor(
    market: MarketCompatibilityService | undefined,
    database: AppDatabase,
    options: {
      readonly notifier?: WechatNotifier;
      readonly now?: () => Date;
      readonly notificationRetry?: NotificationRetryOptions;
    } = {},
  ) {
    this.#market = market;
    this.#database = database;
    this.#notifier = options.notifier;
    this.#now = options.now ?? (() => new Date());
    this.#notificationRetry = options.notificationRetry ?? {};
  }

  addMarketRule(input: CreateMarketAlertRuleInput): MarketAlertRule {
    return this.#database.createMarketAlertRule(
      validateCreateMarketAlertRule(input),
      this.#now().toISOString(),
    );
  }

  listRules(enabledOnly = false): readonly MarketAlertRule[] {
    return this.#database.listAlertRules(enabledOnly);
  }

  setRuleEnabled(id: number, enabled: boolean): boolean {
    if (!Number.isInteger(id) || id <= 0) throw new AppError("USAGE_ERROR", "rule id must be positive.");
    return this.#database.setAlertRuleEnabled(id, enabled, this.#now().toISOString());
  }

  previewCompositeRule(input: CreateCompositeAlertRuleInput): CompositeAlertPreview {
    return previewCompositeAlertRule(input);
  }

  addCompositeRule(input: CreateCompositeAlertRuleInput): CompositeAlertRule {
    const preview = previewCompositeAlertRule(input);
    return this.#database.createCompositeAlertRule(preview.normalized, this.#now().toISOString());
  }

  listCompositeRules(enabledOnly = false): readonly CompositeAlertRule[] {
    return this.#database.listCompositeAlertRules(enabledOnly);
  }

  setCompositeRuleEnabled(id: number, enabled: boolean): boolean {
    if (!Number.isInteger(id) || id <= 0) throw new AppError("USAGE_ERROR", "rule id must be positive.");
    return this.#database.setCompositeAlertRuleEnabled(id, enabled, this.#now().toISOString());
  }

  async testWechat(): Promise<{
    readonly status: "sent";
    readonly attemptCount: number;
    readonly sentAt: string;
    readonly message: string;
  }> {
    if (!this.#notifier) {
      throw new AppError("CONFIG_ERROR", "WECHAT_WEBHOOK_URL is required for this command.");
    }
    const createdAt = this.#now().toISOString();
    const content = [
      "CS2 Item Agent 企业微信测试",
      `测试时间：${createdAt}`,
      "如果你看到这条消息，说明本地 Webhook 配置和发送链路正常。",
      "这是一条手动测试消息，不代表市场或库存发生变化。",
    ].join("\n");
    try {
      const sent = await this.#notifier.sendTextWithRetry(content, this.#notificationRetry);
      const sentAt = this.#now().toISOString();
      this.#database.saveAlertDelivery({
        channel: "enterprise_wechat",
        status: "sent",
        attemptCount: sent.attemptCount,
        createdAt,
        attemptedAt: createdAt,
        sentAt,
      });
      return { status: "sent", attemptCount: sent.attemptCount, sentAt, message: sent.message };
    } catch (error) {
      const publicError = toPublicError(error);
      const message = publicErrorMessage(publicError);
      const attemptCount = publicAttemptCount(publicError);
      this.#database.saveAlertDelivery({
        channel: "enterprise_wechat",
        status: "failed",
        attemptCount,
        createdAt,
        attemptedAt: this.#now().toISOString(),
        errorMessage: message,
      });
      throw error;
    }
  }

  async runOnce(): Promise<AlertRunReport> {
    const started = this.#now();
    const rules = this.#database.listAlertRules(true);
    const compositeRules = this.#database.listCompositeAlertRules(true);
    const requiresMarket = compositeRules.some((rule) =>
      collectCompositeLeaves(rule.expression).some((leaf) => leaf.type === "market"),
    );
    if ((rules.length > 0 || requiresMarket) && !this.#market) {
      throw new AppError("CONFIG_ERROR", "At least one market provider is required to evaluate alert rules.");
    }
    const results: AlertRuleRunResult[] = [];
    const quotesByItem = new Map<string, Awaited<ReturnType<MarketCompatibilityService["comparePrices"]>>>();

    for (const rule of rules) {
      const itemKey = rule.marketHashName.toLocaleLowerCase();
      let marketReport = quotesByItem.get(itemKey);
      if (!marketReport) {
        marketReport = await this.#market!.comparePrices(rule.marketHashName);
        quotesByItem.set(itemKey, marketReport);
      }
      results.push(await this.#evaluateAndNotify(rule, marketReport.quotes));
    }

    const compositeResults: CompositeAlertRuleRunResult[] = [];
    for (const rule of compositeRules) {
      compositeResults.push(await this.#evaluateCompositeAndNotify(rule, quotesByItem));
    }

    return {
      startedAt: started.toISOString(),
      completedAt: this.#now().toISOString(),
      enabledRules: rules.length,
      enabledCompositeRules: compositeRules.length,
      notified: results.filter((result) => result.status === "notified").length +
        compositeResults.filter((result) => result.status === "notified" || result.status === "recovery_notified").length,
      results,
      compositeResults,
      limitations: [
        "Rules are edge-triggered: a persistent matched condition is not repeatedly sent until it recovers.",
        "Cooldown suppresses rapid re-alerting after recovery and a new breach.",
        "Zero placeholder prices and counts are ignored.",
        "A provider snapshot alert is evidence of an observation, not a guaranteed executable trade.",
        "Composite rules preserve unknown state, require local baselines for window changes, and reject matched evidence whose timestamps exceed the configured skew limit.",
      ],
    };
  }

  async #evaluateCompositeAndNotify(
    rule: CompositeAlertRule,
    reports: Map<string, Awaited<ReturnType<MarketCompatibilityService["comparePrices"]>>>,
  ): Promise<CompositeAlertRuleRunResult> {
    const evaluatedAt = this.#now();
    const evaluation = await evaluateCompositeAlertExpression(
      rule.expression,
      (leaf) => this.#evaluateCompositeLeaf(leaf, reports, evaluatedAt),
      evaluatedAt,
      rule.maxDataSkewMinutes,
    );
    if (evaluation.status === "unknown") {
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: "unknown",
        preserveConditionState: true,
        consecutiveMatches: rule.consecutiveMatches,
      });
      return { ruleId: rule.id, status: "unknown", evaluation, consecutiveMatches: rule.consecutiveMatches };
    }
    if (evaluation.status === "not_matched") {
      if (rule.lastConditionState && rule.notifyOnRecovery) {
        return this.#sendCompositeNotification(rule, evaluation, "recovery", 0);
      }
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: "not_matched",
        conditionState: false,
        consecutiveMatches: 0,
      });
      return { ruleId: rule.id, status: "not_matched", evaluation, consecutiveMatches: 0 };
    }
    if (rule.lastConditionState) {
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: "duplicate_active_condition",
        conditionState: true,
        consecutiveMatches: rule.consecutiveMatches,
      });
      return {
        ruleId: rule.id,
        status: "duplicate_active_condition",
        evaluation,
        consecutiveMatches: rule.consecutiveMatches,
      };
    }
    const consecutiveMatches = Math.min(
      rule.consecutiveMatches + 1,
      rule.minimumConsecutiveMatches,
    );
    if (consecutiveMatches < rule.minimumConsecutiveMatches) {
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: "waiting_consecutive",
        conditionState: false,
        consecutiveMatches,
      });
      return { ruleId: rule.id, status: "waiting_consecutive", evaluation, consecutiveMatches };
    }
    if (isCompositeCooldownActive(rule, evaluatedAt)) {
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: "cooldown",
        conditionState: false,
        consecutiveMatches,
      });
      return { ruleId: rule.id, status: "cooldown", evaluation, consecutiveMatches };
    }
    return this.#sendCompositeNotification(rule, evaluation, "trigger", consecutiveMatches);
  }

  async #evaluateCompositeLeaf(
    leaf: CompositeAlertLeaf,
    reports: Map<string, Awaited<ReturnType<MarketCompatibilityService["comparePrices"]>>>,
    evaluatedAt: Date,
  ): Promise<CompositeLeafEvaluation> {
    if (leaf.type === "inventory") return this.#evaluateInventoryLeaf(leaf, evaluatedAt);
    const key = leaf.marketHashName.toLocaleLowerCase();
    let report = reports.get(key);
    if (!report) {
      report = await this.#market!.comparePrices(leaf.marketHashName);
      reports.set(key, report);
    }
    const candidates = report.quotes.filter((quote) =>
      quote.platform.toUpperCase() === leaf.platform.toUpperCase() &&
      (leaf.provider === "any" || quote.provider === leaf.provider),
    );
    const evaluatedCandidates = candidates.flatMap((quote) => {
      const current = compositeMarketMetricValue(leaf.metric, quote);
      if (current === undefined) return [];
      if (leaf.mode !== "change_rate") return [{ quote, value: current }];
      const currentObservedAt = new Date(quote.observedAt).valueOf();
      if (!Number.isFinite(currentObservedAt)) return [];
      const targetAt = new Date(currentObservedAt - (leaf.windowMinutes ?? 0) * 60_000);
      const baselineQuote = this.#database.getMarketQuoteAtOrBefore({
        marketHashName: leaf.marketHashName,
        platform: leaf.platform,
        provider: quote.provider,
        targetAt: targetAt.toISOString(),
      });
      const baseline = baselineQuote ? compositeMarketMetricValue(leaf.metric, baselineQuote) : undefined;
      if (baseline === undefined || baseline === 0 || !baselineQuote) return [];
      const baselineDistance = Math.abs(new Date(baselineQuote.observedAt).valueOf() - targetAt.valueOf()) / 60_000;
      if (!Number.isFinite(baselineDistance) || baselineDistance > 60) return [];
      return [{
        quote,
        value: (current - baseline) / Math.abs(baseline),
        baselineValue: baseline,
        baselineObservedAt: baselineQuote.observedAt,
      }];
    });
    if (evaluatedCandidates.length === 0) {
      return {
        condition: leaf,
        status: "unknown",
        limitation: leaf.mode === "change_rate"
          ? "No same-provider local baseline exists within 60 minutes of the requested window boundary."
          : "No positive usable quote matched the requested platform and provider.",
      };
    }
    const selected = [...evaluatedCandidates].sort((left, right) =>
      leaf.operator === "lt" || leaf.operator === "lte" ? left.value - right.value : right.value - left.value,
    )[0]!;
    const matched = compareAlertValue(selected.value, leaf.operator, leaf.threshold);
    const baselineValue = "baselineValue" in selected && typeof selected.baselineValue === "number"
      ? selected.baselineValue
      : undefined;
    const baselineObservedAt = "baselineObservedAt" in selected && typeof selected.baselineObservedAt === "string"
      ? selected.baselineObservedAt
      : undefined;
    return {
      condition: leaf,
      status: matched ? "matched" : "not_matched",
      value: selected.value,
      observedAt: selected.quote.observedAt,
      provider: selected.quote.provider,
      source: selected.quote.source,
      ...(baselineValue !== undefined ? { baselineValue } : {}),
      ...(baselineObservedAt !== undefined ? { baselineObservedAt } : {}),
      limitation: "Market values are provider observations; change rates use a same-provider local baseline.",
    };
  }

  #evaluateInventoryLeaf(
    leaf: Extract<CompositeAlertLeaf, { readonly type: "inventory" }>,
    evaluatedAt: Date,
  ): CompositeLeafEvaluation {
    const latestObservedAt = this.#database.getLatestCompleteInventoryObservedAt(leaf.steamId);
    if (!latestObservedAt) return unknownInventoryLeaf(leaf, "No complete public inventory snapshot exists yet.");
    const windowMinutes = leaf.windowMinutes ?? 30;
    const ageMinutes = (evaluatedAt.valueOf() - new Date(latestObservedAt).valueOf()) / 60_000;
    if (!Number.isFinite(ageMinutes) || ageMinutes < -1 || ageMinutes > windowMinutes) {
      return unknownInventoryLeaf(leaf, "The latest complete public inventory snapshot is outside the condition window.");
    }
    const since = new Date(evaluatedAt.valueOf() - windowMinutes * 60_000).toISOString();
    let value: number | undefined;
    if (leaf.metric === "added_quantity" || leaf.metric === "removed_quantity") {
      value = this.#database.sumInventoryEventQuantity({
        steamId: leaf.steamId,
        direction: leaf.metric === "added_quantity" ? "added" : "removed",
        since,
        until: latestObservedAt,
        ...(leaf.marketHashName ? { marketHashName: leaf.marketHashName } : {}),
      });
    } else if (leaf.metric === "high_value_added_count" || leaf.metric === "high_value_removed_count") {
      value = this.#database.countHighValueInventoryEvents({
        steamId: leaf.steamId,
        direction: leaf.metric === "high_value_added_count" ? "added" : "removed",
        since,
        until: latestObservedAt,
        ...(leaf.marketHashName ? { marketHashName: leaf.marketHashName } : {}),
      });
    } else {
      const valuation = this.#database.getLatestInventoryValuation(leaf.steamId);
      if (!valuation || valuation.inventoryObservedAt !== latestObservedAt) {
        return unknownInventoryLeaf(leaf, "No valuation matches the latest complete inventory snapshot.");
      }
      switch (leaf.metric) {
        case "inventory_value": value = valuation.knownSubtotal; break;
        case "composition_change_amount": value = valuation.compositionDelta; break;
        case "composition_change_rate": value = valuation.compositionDeltaRate; break;
        case "price_coverage": value = valuation.priceCoverage; break;
      }
    }
    if (value === undefined) return unknownInventoryLeaf(leaf, "The requested inventory metric has no comparable baseline.");
    return {
      condition: leaf,
      status: compareAlertValue(value, leaf.operator, leaf.threshold) ? "matched" : "not_matched",
      value,
      observedAt: latestObservedAt,
      provider: "local",
      source: "local:public-inventory",
      limitation: "A public inventory difference does not prove a purchase, sale, transfer counterparty, or intent.",
    };
  }

  async #sendCompositeNotification(
    rule: CompositeAlertRule,
    evaluation: CompositeAlertEvaluation,
    deliveryType: "trigger" | "recovery",
    consecutiveMatches: number,
  ): Promise<CompositeAlertRuleRunResult> {
    const conditionState = deliveryType === "trigger";
    if (!this.#notifier) {
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: "notification_unconfigured",
        conditionState: deliveryType === "recovery" ? true : false,
        consecutiveMatches,
      });
      this.#database.saveCompositeAlertDelivery({
        ruleId: rule.id,
        deliveryType,
        channel: "enterprise_wechat",
        evidenceFingerprint: evaluation.evidenceFingerprint,
        status: "skipped",
        attemptCount: 1,
        createdAt: evaluation.evaluatedAt,
        attemptedAt: evaluation.evaluatedAt,
        errorMessage: "WECHAT_WEBHOOK_URL is not configured.",
      });
      return {
        ruleId: rule.id,
        status: "notification_unconfigured",
        evaluation,
        consecutiveMatches,
        notification: { channel: "enterprise_wechat", status: "skipped", attemptCount: 1, message: "WECHAT_WEBHOOK_URL is not configured." },
      };
    }
    try {
      const sent = await this.#notifier.sendTextWithRetry(
        formatCompositeAlert(rule, evaluation, deliveryType, (steamId) => this.#database.getInventoryWatch(steamId)?.label),
        this.#notificationRetry,
      );
      const sentAt = this.#now().toISOString();
      this.#database.saveCompositeAlertDelivery({
        ruleId: rule.id,
        deliveryType,
        channel: "enterprise_wechat",
        evidenceFingerprint: evaluation.evidenceFingerprint,
        status: "sent",
        attemptCount: sent.attemptCount,
        createdAt: evaluation.evaluatedAt,
        attemptedAt: evaluation.evaluatedAt,
        sentAt,
      });
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: deliveryType === "trigger" ? "notified" : "recovery_notified",
        conditionState,
        consecutiveMatches: conditionState ? consecutiveMatches : 0,
        ...(deliveryType === "trigger" ? { triggeredAt: sentAt } : {}),
      });
      return {
        ruleId: rule.id,
        status: deliveryType === "trigger" ? "notified" : "recovery_notified",
        evaluation,
        consecutiveMatches: conditionState ? consecutiveMatches : 0,
        notification: { channel: "enterprise_wechat", status: "sent", attemptCount: sent.attemptCount, message: sent.message },
      };
    } catch (error) {
      const publicError = toPublicError(error);
      const message = publicErrorMessage(publicError);
      const attemptCount = publicAttemptCount(publicError);
      this.#database.saveCompositeAlertDelivery({
        ruleId: rule.id,
        deliveryType,
        channel: "enterprise_wechat",
        evidenceFingerprint: evaluation.evidenceFingerprint,
        status: "failed",
        attemptCount,
        createdAt: evaluation.evaluatedAt,
        attemptedAt: this.#now().toISOString(),
        errorMessage: message,
      });
      this.#database.recordCompositeAlertEvaluation(rule, evaluation, {
        outcome: "notification_failed",
        conditionState: deliveryType === "recovery" ? true : false,
        consecutiveMatches,
      });
      return {
        ruleId: rule.id,
        status: "notification_failed",
        evaluation,
        consecutiveMatches,
        notification: { channel: "enterprise_wechat", status: "failed", attemptCount, message },
      };
    }
  }

  async #evaluateAndNotify(
    rule: MarketAlertRule,
    quotes: readonly import("../domain/market-quote.js").NormalizedMarketQuote[],
  ): Promise<AlertRuleRunResult> {
    const evaluatedAt = this.#now();
    const evaluation = evaluateMarketAlertRule(rule, quotes, evaluatedAt);
    if (evaluation.status === "no_data") {
      this.#database.recordAlertEvaluation(rule, evaluation, { outcome: "no_data" });
      return { ruleId: rule.id, status: "no_data", evaluation };
    }
    if (!evaluation.conditionMet) {
      this.#database.recordAlertEvaluation(rule, evaluation, {
        outcome: "not_matched",
        conditionState: false,
      });
      return { ruleId: rule.id, status: "not_matched", evaluation };
    }
    if (rule.lastConditionMet) {
      this.#database.recordAlertEvaluation(rule, evaluation, {
        outcome: "duplicate_active_condition",
        conditionState: true,
      });
      return { ruleId: rule.id, status: "duplicate_active_condition", evaluation };
    }
    if (isCooldownActive(rule, evaluatedAt)) {
      this.#database.recordAlertEvaluation(rule, evaluation, {
        outcome: "cooldown",
        conditionState: false,
      });
      return { ruleId: rule.id, status: "cooldown", evaluation };
    }
    if (!this.#notifier) {
      this.#database.recordAlertEvaluation(rule, evaluation, {
        outcome: "notification_unconfigured",
        conditionState: false,
      });
      this.#database.saveAlertDelivery({
        ruleId: rule.id,
        channel: "enterprise_wechat",
        ...(evaluation.evidenceFingerprint ? { evidenceFingerprint: evaluation.evidenceFingerprint } : {}),
        status: "skipped",
        attemptCount: 1,
        createdAt: evaluation.evaluatedAt,
        attemptedAt: evaluation.evaluatedAt,
        errorMessage: "WECHAT_WEBHOOK_URL is not configured.",
      });
      return {
        ruleId: rule.id,
        status: "notification_unconfigured",
        evaluation,
        notification: {
          channel: "enterprise_wechat",
          status: "skipped",
          attemptCount: 1,
          message: "WECHAT_WEBHOOK_URL is not configured.",
        },
      };
    }

    const createdAt = evaluation.evaluatedAt;
    try {
      const sent = await this.#notifier.sendTextWithRetry(
        formatMarketAlert(rule, evaluation),
        this.#notificationRetry,
      );
      const sentAt = this.#now().toISOString();
      this.#database.saveAlertDelivery({
        ruleId: rule.id,
        channel: "enterprise_wechat",
        ...(evaluation.evidenceFingerprint ? { evidenceFingerprint: evaluation.evidenceFingerprint } : {}),
        status: "sent",
        attemptCount: sent.attemptCount,
        createdAt,
        attemptedAt: createdAt,
        sentAt,
      });
      this.#database.recordAlertEvaluation(rule, evaluation, {
        outcome: "notified",
        conditionState: true,
        triggeredAt: sentAt,
      });
      return {
        ruleId: rule.id,
        status: "notified",
        evaluation,
        notification: {
          channel: "enterprise_wechat",
          status: "sent",
          attemptCount: sent.attemptCount,
          message: sent.message,
        },
      };
    } catch (error) {
      const publicError = toPublicError(error);
      const message = publicErrorMessage(publicError);
      const attemptCount = publicAttemptCount(publicError);
      this.#database.saveAlertDelivery({
        ruleId: rule.id,
        channel: "enterprise_wechat",
        ...(evaluation.evidenceFingerprint ? { evidenceFingerprint: evaluation.evidenceFingerprint } : {}),
        status: "failed",
        attemptCount,
        createdAt,
        attemptedAt: this.#now().toISOString(),
        errorMessage: message,
      });
      this.#database.recordAlertEvaluation(rule, evaluation, {
        outcome: "notification_failed",
        conditionState: false,
      });
      return {
        ruleId: rule.id,
        status: "notification_failed",
        evaluation,
        notification: {
          channel: "enterprise_wechat",
          status: "failed",
          attemptCount,
          message,
        },
      };
    }
  }
}

function formatMarketAlert(rule: MarketAlertRule, evaluation: MarketAlertEvaluation): string {
  return [
    `CS2 市场告警${rule.name ? `：${rule.name}` : ""}`,
    `饰品：${rule.marketHashName}`,
    `平台：${evaluation.platform ?? rule.platform}｜来源：${evaluation.provider ?? rule.provider}`,
    `条件：${rule.metric} ${rule.operator} ${rule.threshold}`,
    `当前值：${evaluation.value ?? "未知"}`,
    `数据时间：${evaluation.observedAt ?? evaluation.evaluatedAt}`,
    "说明：这是公开行情快照触发，不代表一定可以按该价格成交，也不构成投资建议。",
  ].join("\n");
}

function isCompositeCooldownActive(rule: CompositeAlertRule, at: Date): boolean {
  if (!rule.lastTriggeredAt || rule.cooldownMinutes === 0) return false;
  const last = new Date(rule.lastTriggeredAt).valueOf();
  return Number.isFinite(last) && at.valueOf() - last < rule.cooldownMinutes * 60_000;
}

function unknownInventoryLeaf(
  condition: Extract<CompositeAlertLeaf, { readonly type: "inventory" }>,
  limitation: string,
): CompositeLeafEvaluation {
  return { condition, status: "unknown", limitation };
}

function formatCompositeAlert(
  rule: CompositeAlertRule,
  evaluation: CompositeAlertEvaluation,
  deliveryType: "trigger" | "recovery",
  getWatchLabel: (steamId: string) => string | undefined,
): string {
  const evidence = evaluation.leaves.map((leaf, index) => {
    const condition = leaf.condition;
    const target = condition.type === "market"
      ? `${condition.marketHashName}｜${condition.platform}`
      : `${getWatchLabel(condition.steamId) ?? maskSteamId(condition.steamId)}${condition.marketHashName ? `｜${condition.marketHashName}` : ""}`;
    const mode = condition.type === "market" && condition.mode === "change_rate"
      ? `${condition.windowMinutes}分钟变化率`
      : condition.type === "inventory" ? `${condition.windowMinutes}分钟窗口` : "当前值";
    return [
      `${index + 1}. ${target}`,
      `   ${condition.metric} ${condition.operator} ${condition.threshold}｜${mode}`,
      `   结果：${leaf.status}｜观测值：${leaf.value ?? "未知"}｜时间：${leaf.observedAt ?? "未知"}`,
      `   来源：${leaf.provider ?? "未知"}/${leaf.source ?? "未知"}`,
    ].join("\n");
  });
  return [
    deliveryType === "trigger" ? `CS2 组合告警：${rule.name}` : `CS2 组合告警恢复：${rule.name}`,
    `逻辑结果：${evaluation.status}｜规则ID：${rule.id}`,
    ...evidence,
    `评估时间：${evaluation.evaluatedAt}`,
    evaluation.dataSkewMinutes !== undefined ? `证据时间差：${evaluation.dataSkewMinutes.toFixed(1)}分钟` : "",
    "说明：这是公开行情与本地公开库存观测触发，不证明真实成交、买卖关系或未来收益，也不构成投资建议。",
  ].filter(Boolean).join("\n");
}

function maskSteamId(steamId: string): string {
  return steamId.length >= 8 ? `${steamId.slice(0, 4)}****${steamId.slice(-4)}` : "****";
}

function publicErrorMessage(value: Readonly<Record<string, unknown>>): string {
  const error = typeof value.error === "object" && value.error !== null
    ? (value.error as Readonly<Record<string, unknown>>)
    : undefined;
  return typeof error?.message === "string" ? error.message : "Notification failed.";
}

function publicAttemptCount(value: Readonly<Record<string, unknown>>): number {
  const error = typeof value.error === "object" && value.error !== null
    ? (value.error as Readonly<Record<string, unknown>>)
    : undefined;
  const details = typeof error?.details === "object" && error.details !== null
    ? (error.details as Readonly<Record<string, unknown>>)
    : undefined;
  return typeof details?.attemptCount === "number" ? details.attemptCount : 1;
}
