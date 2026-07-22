import type {
  CsQaqCaseCountEntry,
  CsQaqCaseRoiEntry,
  CsQaqHolderRankEntry,
  CsQaqSupplyPoint,
} from "../adapters/csqaq/types.js";

export interface HolderConcentrationSummary {
  readonly observedAccounts: number;
  readonly observedQuantity: number;
  readonly top1Quantity: number;
  readonly top5Quantity: number;
  readonly top10Quantity: number;
  readonly top1SharePct: number;
  readonly top5SharePct: number;
  readonly top10SharePct: number;
  readonly scope: "csqaq_monitored_accounts";
}

export interface SupplyTrendSummary {
  readonly pointCount: number;
  readonly currentQuantity?: number;
  readonly historyStart?: string;
  readonly historyEnd?: string;
  readonly change7dPct?: number;
  readonly change30dPct?: number;
  readonly change90dPct?: number;
  readonly changeFullWindowPct?: number;
}

export interface CaseOverviewEntry {
  readonly goodId: string;
  readonly name: string;
  readonly openingCounts?: CsQaqCaseCountEntry;
  readonly roi?: CsQaqCaseRoiEntry;
}

export function summarizeHolderConcentration(
  entries: readonly CsQaqHolderRankEntry[],
): HolderConcentrationSummary {
  const sorted = deduplicateHolderRanking(entries);
  const total = sorted.reduce((sum, entry) => sum + entry.quantity, 0);
  const top = (count: number) => sorted.slice(0, count).reduce((sum, entry) => sum + entry.quantity, 0);
  const top1 = top(1);
  const top5 = top(5);
  const top10 = top(10);
  return {
    observedAccounts: sorted.length,
    observedQuantity: total,
    top1Quantity: top1,
    top5Quantity: top5,
    top10Quantity: top10,
    top1SharePct: share(top1, total),
    top5SharePct: share(top5, total),
    top10SharePct: share(top10, total),
    scope: "csqaq_monitored_accounts",
  };
}

export function deduplicateHolderRanking(
  entries: readonly CsQaqHolderRankEntry[],
): readonly CsQaqHolderRankEntry[] {
  const bySteamId = new Map<string, CsQaqHolderRankEntry>();
  for (const entry of entries) {
    if (entry.quantity < 0) continue;
    const current = bySteamId.get(entry.steamId);
    if (!current || entry.quantity > current.quantity) bySteamId.set(entry.steamId, entry);
  }
  return [...bySteamId.values()].sort((a, b) => b.quantity - a.quantity || a.steamId.localeCompare(b.steamId));
}

export function summarizeSupplyTrend(pointsInput: readonly CsQaqSupplyPoint[]): SupplyTrendSummary {
  const points = [...pointsInput].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const latest = points.at(-1);
  if (!latest) return { pointCount: 0 };
  return {
    pointCount: points.length,
    currentQuantity: latest.quantity,
    historyStart: points[0]!.recordedAt,
    historyEnd: latest.recordedAt,
    ...periodChange(points, latest, 7, "change7dPct"),
    ...periodChange(points, latest, 30, "change30dPct"),
    ...periodChange(points, latest, 90, "change90dPct"),
    ...(points.length > 1 && points[0]!.quantity > 0
      ? { changeFullWindowPct: round(((latest.quantity / points[0]!.quantity) - 1) * 100) }
      : {}),
  };
}

export function joinCaseOverview(
  counts: readonly CsQaqCaseCountEntry[],
  roi: readonly CsQaqCaseRoiEntry[],
): readonly CaseOverviewEntry[] {
  const countMap = new Map(counts.map((entry) => [entry.goodId, entry]));
  const roiMap = new Map(roi.map((entry) => [entry.goodId, entry]));
  const ids = new Set([...countMap.keys(), ...roiMap.keys()]);
  return [...ids].map((goodId) => ({
    goodId,
    name: countMap.get(goodId)?.name ?? roiMap.get(goodId)?.name ?? goodId,
    ...(countMap.get(goodId) ? { openingCounts: countMap.get(goodId)! } : {}),
    ...(roiMap.get(goodId) ? { roi: roiMap.get(goodId)! } : {}),
  }));
}

function periodChange<K extends string>(
  points: readonly CsQaqSupplyPoint[],
  latest: CsQaqSupplyPoint,
  days: number,
  key: K,
): Partial<Record<K, number>> {
  const target = new Date(latest.recordedAt).valueOf() - days * 86_400_000;
  let baseline: CsQaqSupplyPoint | undefined;
  for (const point of points) {
    if (new Date(point.recordedAt).valueOf() <= target) baseline = point;
    else break;
  }
  if (!baseline || baseline.quantity <= 0) return {};
  return { [key]: round(((latest.quantity / baseline.quantity) - 1) * 100) } as Record<K, number>;
}

function share(part: number, total: number): number {
  return total > 0 ? round((part / total) * 100) : 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
