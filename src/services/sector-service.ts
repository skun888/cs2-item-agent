import type { CsQaqClient } from "../adapters/csqaq/client.js";
import { AppError } from "../core/errors.js";
import type { MarketTradingContext } from "../domain/market-trading-model.js";
import type { AppDatabase } from "../storage/database.js";

export class SectorService {
  constructor(
    private readonly client: CsQaqClient,
    private readonly database: AppDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(refresh = true): Promise<unknown> {
    let evidence;
    if (refresh) {
      evidence = await this.client.getMarketHomeData();
      this.database.saveMarketHomeEvidence(evidence);
    }
    return {
      generatedAt: this.now().toISOString(),
      sectors: this.database.listMarketSectors(),
      latestCardPrice: this.database.getLatestSteamCardPrice(),
      ...(evidence ? { evidence: evidenceMeta(evidence) } : {}),
      limitations: [
        "板块指数采用 CSQAQ 的成分与计算口径，不等于所有 CS2 饰品的全市场表现。",
        "卡价表示购买 100 美元 Steam 余额所需人民币，仅用于平台余额方向的资金成本。",
      ],
    };
  }

  async kline(reference: string, interval = "1day"): Promise<unknown> {
    await this.list(true);
    const sector = resolveSector(this.database.listMarketSectors(), reference);
    const evidence = await this.client.getSectorKline(sector.id, interval);
    this.database.saveSectorKlineEvidence(sector.id, interval, evidence);
    return {
      sector,
      interval,
      points: evidence.data,
      returnsPct: calculateReturns(evidence.data.map((point) => point.close)),
      evidence: evidenceMeta(evidence),
    };
  }

  async context(reference: string, windowDays = 15): Promise<MarketTradingContext["sector"]> {
    const report = await this.kline(reference, "1day") as {
      sector: { name: string };
      points: readonly { close: number }[];
      evidence: { source: string; observedAt: string };
    };
    const closes = report.points.map((point) => point.close);
    if (closes.length < 2) throw new AppError("CONTRACT_ERROR", "CSQAQ sector K-line has fewer than two points.");
    const actualWindow = Math.min(windowDays, closes.length - 1);
    const start = closes[closes.length - 1 - actualWindow]!;
    const end = closes[closes.length - 1]!;
    return {
      name: report.sector.name,
      returnPct: round((end / start - 1) * 100),
      windowDays: actualWindow,
      provenance: {
        sourceType: "provider_data",
        label: "CSQAQ 板块指数 K 线",
        observedAt: report.evidence.observedAt,
        note: "板块成分与指数算法由 CSQAQ 定义。",
      },
    };
  }
}

function resolveSector<T extends { id: string; name: string; nameKey: string }>(sectors: readonly T[], reference: string): T {
  const normalized = reference.trim().toLowerCase();
  const sector = sectors.find((item) => item.id === normalized || item.nameKey.toLowerCase() === normalized || item.name.toLowerCase() === normalized);
  if (!sector) throw new AppError("USAGE_ERROR", `Unknown CSQAQ sector: ${reference}`);
  return sector;
}

function calculateReturns(closes: readonly number[]): Readonly<Record<string, number | undefined>> {
  const result: Record<string, number | undefined> = {};
  for (const days of [1, 7, 15, 30]) {
    result[`days${days}`] = closes.length > days
      ? round((closes.at(-1)! / closes[closes.length - 1 - days]! - 1) * 100)
      : undefined;
  }
  return result;
}

function evidenceMeta<T>(evidence: import("../domain/evidence.js").Evidence<T>) {
  return { source: evidence.source, observedAt: evidence.observedAt, confidence: evidence.confidence, limitations: evidence.limitations };
}

function round(value: number): number { return Math.round(value * 10_000) / 10_000; }
