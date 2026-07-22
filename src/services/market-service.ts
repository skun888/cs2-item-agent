import type { SteamDtClient } from "../adapters/steamdt/client.js";
import type { KlineQuery, SteamDtKlinePoint, SteamDtPriceEntry } from "../adapters/steamdt/types.js";
import { AppError } from "../core/errors.js";
import { analyzeMarket, type MarketAnalysisReport } from "../domain/market-analysis.js";
import type { Evidence } from "../domain/evidence.js";
import type { AppDatabase } from "../storage/database.js";

export interface AnalyzeMarketRequest extends KlineQuery {
  readonly includeBroadMarket?: boolean;
}

export class MarketService {
  readonly #client: SteamDtClient;
  readonly #database: AppDatabase;
  readonly #now: () => Date;

  constructor(client: SteamDtClient, database: AppDatabase, now: () => Date = () => new Date()) {
    this.#client = client;
    this.#database = database;
    this.#now = now;
  }

  async getPrices(marketHashName: string): Promise<Evidence<readonly SteamDtPriceEntry[]>> {
    const evidence = await this.#client.getSinglePrice(marketHashName);
    this.#database.savePriceEvidence(marketHashName, evidence);
    return evidence;
  }

  async getKline(query: KlineQuery): Promise<Evidence<readonly SteamDtKlinePoint[]>> {
    const evidence = await this.#client.getKline(query);
    this.#database.saveKlineEvidence(query.marketHashName, query.platform, query.type, evidence);
    return evidence;
  }

  async analyze(request: AnalyzeMarketRequest): Promise<MarketAnalysisReport> {
    const previousPrices = this.#database.getLatestPriceEvidence(request.marketHashName);
    const broadPromise = request.includeBroadMarket === false
      ? Promise.resolve<
          | { readonly evidence: Evidence<readonly SteamDtKlinePoint[]> }
          | { readonly error: string }
        >({ error: "调用方关闭了大盘比较。" })
      : this.#client
          .getBroadKline(request.type)
          .then((evidence) => ({ evidence }))
          .catch((error: unknown) => ({ error: describeProviderFailure(error) }));

    const [prices, itemKline, broadResult] = await Promise.all([
      this.#client.getSinglePrice(request.marketHashName),
      this.#client.getKline(request),
      broadPromise,
    ]);

    this.#database.savePriceEvidence(request.marketHashName, prices);
    this.#database.saveKlineEvidence(
      request.marketHashName,
      request.platform,
      request.type,
      itemKline,
    );
    if ("evidence" in broadResult) {
      this.#database.saveBroadKlineEvidence(request.type, broadResult.evidence);
    }

    const report = analyzeMarket({
      marketHashName: request.marketHashName,
      platform: request.platform,
      klineType: request.type,
      prices,
      itemKline,
      generatedAt: this.#now(),
      ...(previousPrices ? { previousPrices } : {}),
      ...("evidence" in broadResult
        ? { broadKline: broadResult.evidence }
        : { broadUnavailableReason: broadResult.error }),
    });
    this.#database.saveAnalysisReport(report);
    return report;
  }
}

function describeProviderFailure(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "未知的大盘数据错误。";
}
