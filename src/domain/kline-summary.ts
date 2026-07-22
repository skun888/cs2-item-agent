import type { SteamDtKlinePoint } from "../adapters/steamdt/types.js";

export interface KlineSummary {
  readonly pointCount: number;
  readonly first?: SteamDtKlinePoint;
  readonly last?: SteamDtKlinePoint;
  readonly dominantIntervalSeconds?: number;
  readonly dominantIntervalPointPairs?: number;
}

export function summarizeKline(points: readonly SteamDtKlinePoint[]): KlineSummary {
  if (points.length === 0) return { pointCount: 0 };
  const intervals = new Map<number, number>();
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    if (!current || !previous) continue;
    const interval = current.timestamp - previous.timestamp;
    if (interval > 0) intervals.set(interval, (intervals.get(interval) ?? 0) + 1);
  }
  const dominantInterval = [...intervals.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    pointCount: points.length,
    first: points[0]!,
    last: points.at(-1)!,
    ...(dominantInterval
      ? {
          dominantIntervalSeconds: dominantInterval[0],
          dominantIntervalPointPairs: dominantInterval[1],
        }
      : {}),
  };
}
