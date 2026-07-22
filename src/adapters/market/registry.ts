import { AppError } from "../../core/errors.js";
import type {
  MarketAdapterDescriptor,
  MarketAdapterFetchReport,
  MarketAdapterFetchStatus,
  MarketAdapterHealth,
  MarketAdapterRegistration,
  MarketDataAdapter,
} from "./contract.js";

const ADAPTER_ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

export class MarketAdapterRegistry {
  readonly #registrations = new Map<string, MarketAdapterRegistration>();

  constructor(registrations: readonly MarketAdapterRegistration[] = []) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: MarketAdapterRegistration): void {
    validateRegistration(registration);
    const id = registration.descriptor.id;
    if (this.#registrations.has(id)) {
      throw new AppError("CONFIG_ERROR", `Duplicate market adapter id: ${id}`);
    }
    this.#registrations.set(id, registration);
  }

  health(): readonly MarketAdapterHealth[] {
    return this.#ordered().map(({ descriptor, adapter }) => ({
      id: descriptor.id,
      displayName: descriptor.displayName,
      kind: descriptor.kind,
      configured: Boolean(adapter),
      priority: descriptor.priority,
      capabilities: descriptor.capabilities,
      platforms: descriptor.platforms,
      ...(descriptor.batchPolicy ? { batchPolicy: descriptor.batchPolicy } : {}),
    }));
  }

  hasConfiguredAdapter(): boolean {
    return this.#ordered().some((registration) => registration.adapter !== undefined);
  }

  getPreferredBatchAdapter(
    platform: string,
    preferredAdapterId?: string,
  ): MarketDataAdapter | undefined {
    const normalizedPlatform = normalizePlatform(platform);
    const candidates = this.#ordered().filter(({ descriptor, adapter }) =>
      adapter !== undefined &&
      descriptor.capabilities.includes("batch_market_quotes") &&
      adapter.getBatchQuotes !== undefined &&
      supportsPlatform(descriptor, normalizedPlatform),
    );
    if (preferredAdapterId) {
      const preferred = candidates.find(({ descriptor }) => descriptor.id === preferredAdapterId);
      if (preferred?.adapter) return preferred.adapter;
    }
    return candidates[0]?.adapter;
  }

  async fetchAllQuotes(marketHashName: string): Promise<MarketAdapterFetchReport> {
    const name = marketHashName.trim();
    if (!name) throw new AppError("USAGE_ERROR", "marketHashName is required.");
    const registrations = this.#ordered();
    const results = await Promise.allSettled(
      registrations.map(({ adapter }) => adapter?.getQuotes(name)),
    );
    const quotes = [];
    const providers: MarketAdapterFetchStatus[] = [];
    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index];
      const result = results[index];
      if (!registration || !result) continue;
      if (!registration.adapter) {
        providers.push({
          provider: registration.descriptor.id,
          status: "not_configured",
          quoteCount: 0,
        });
        continue;
      }
      if (result.status === "rejected") {
        providers.push({
          provider: registration.descriptor.id,
          status: "failed",
          quoteCount: 0,
          error: describeFailure(result.reason),
        });
        continue;
      }
      if (!result.value) {
        providers.push({
          provider: registration.descriptor.id,
          status: "failed",
          quoteCount: 0,
          error: "Adapter returned no evidence.",
        });
        continue;
      }
      validateQuotes(registration.descriptor, result.value.data);
      quotes.push(...result.value.data);
      providers.push({
        provider: registration.descriptor.id,
        status: "available",
        source: result.value.source,
        observedAt: result.value.observedAt,
        quoteCount: result.value.data.length,
      });
    }
    return { quotes, providers };
  }

  #ordered(): readonly MarketAdapterRegistration[] {
    return [...this.#registrations.values()].sort((left, right) =>
      left.descriptor.priority - right.descriptor.priority ||
      left.descriptor.id.localeCompare(right.descriptor.id),
    );
  }
}

function validateRegistration(registration: MarketAdapterRegistration): void {
  const { descriptor, adapter } = registration;
  if (!ADAPTER_ID.test(descriptor.id)) {
    throw new AppError(
      "CONFIG_ERROR",
      "Market adapter id must be lowercase ASCII and may contain digits, hyphens, or underscores.",
    );
  }
  if (!descriptor.displayName.trim()) {
    throw new AppError("CONFIG_ERROR", `Market adapter ${descriptor.id} requires a display name.`);
  }
  if (!Number.isInteger(descriptor.priority) || descriptor.priority < 0) {
    throw new AppError("CONFIG_ERROR", `Market adapter ${descriptor.id} priority must be a non-negative integer.`);
  }
  if (!descriptor.capabilities.includes("market_quotes")) {
    throw new AppError("CONFIG_ERROR", `Market adapter ${descriptor.id} must declare market_quotes.`);
  }
  if (adapter && adapter.descriptor.id !== descriptor.id) {
    throw new AppError("CONFIG_ERROR", `Market adapter registration id mismatch for ${descriptor.id}.`);
  }
  const declaresBatch = descriptor.capabilities.includes("batch_market_quotes");
  if (declaresBatch && !descriptor.batchPolicy) {
    throw new AppError("CONFIG_ERROR", `Market adapter ${descriptor.id} requires a batch policy.`);
  }
  if (declaresBatch && adapter && !adapter.getBatchQuotes) {
    throw new AppError("CONFIG_ERROR", `Market adapter ${descriptor.id} declares batch quotes without implementing them.`);
  }
  if (!declaresBatch && (descriptor.batchPolicy || adapter?.getBatchQuotes)) {
    throw new AppError(
      "CONFIG_ERROR",
      `Market adapter ${descriptor.id} exposes batch behavior without declaring batch_market_quotes.`,
    );
  }
  if (descriptor.batchPolicy) {
    if (!Number.isInteger(descriptor.batchPolicy.maximumItems) || descriptor.batchPolicy.maximumItems <= 0) {
      throw new AppError("CONFIG_ERROR", `Market adapter ${descriptor.id} maximumItems must be positive.`);
    }
    if (!Number.isInteger(descriptor.batchPolicy.minimumIntervalMs) || descriptor.batchPolicy.minimumIntervalMs < 0) {
      throw new AppError("CONFIG_ERROR", `Market adapter ${descriptor.id} minimumIntervalMs cannot be negative.`);
    }
  }
}

function validateQuotes(
  descriptor: MarketAdapterDescriptor,
  quotes: readonly { readonly provider: string; readonly platform: string; readonly marketHashName: string }[],
): void {
  for (const quote of quotes) {
    if (quote.provider !== descriptor.id) {
      throw new AppError(
        "CONTRACT_ERROR",
        `Market adapter ${descriptor.id} returned a quote attributed to ${quote.provider}.`,
      );
    }
    if (!quote.marketHashName.trim() || !quote.platform.trim()) {
      throw new AppError("CONTRACT_ERROR", `Market adapter ${descriptor.id} returned an incomplete quote.`);
    }
  }
}

function supportsPlatform(descriptor: MarketAdapterDescriptor, platform: string): boolean {
  return descriptor.platforms === "provider_defined" ||
    descriptor.platforms.some((candidate) => normalizePlatform(candidate) === platform);
}

function normalizePlatform(value: string): string {
  return value.trim().toUpperCase();
}

function describeFailure(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Unknown adapter failure";
}
