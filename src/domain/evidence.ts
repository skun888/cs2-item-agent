export type ConfidenceLevel = "verified_source" | "high_confidence_inference" | "unknown";

export interface Evidence<T> {
  readonly source: string;
  readonly observedAt: string;
  readonly confidence: ConfidenceLevel;
  readonly limitations: readonly string[];
  readonly data: T;
}

export function verifiedEvidence<T>(
  source: string,
  observedAt: Date,
  data: T,
  limitations: readonly string[] = [],
): Evidence<T> {
  return {
    source,
    observedAt: observedAt.toISOString(),
    confidence: "verified_source",
    limitations,
    data,
  };
}
