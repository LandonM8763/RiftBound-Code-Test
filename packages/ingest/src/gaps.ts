import type { CardId } from '@riftbound/cards';

/**
 * A field the source could not supply.
 *
 * Ingest never invents a value. When a source omits something the rules need,
 * that fact is recorded here and travels with the output, because the
 * alternative — defaulting a Unit's Might to 0, say — produces card data that
 * looks complete and is quietly wrong. A statistic computed from it would be
 * plausible and false, which is worse than a missing card.
 */
export interface Gap {
  readonly card: CardId;
  readonly name: string;
  /** The `CardDefinition` field that could not be filled. */
  readonly field: string;
  /** Why it is missing, and what it blocks. */
  readonly reason: string;
  /**
   * `blocking` means the card cannot be represented at all and is dropped.
   * `degraded` means the card is emitted but a rule cannot be checked on it.
   */
  readonly severity: 'blocking' | 'degraded';
}

export interface GapSummary {
  /** Gap counts by field, most frequent first. */
  readonly byField: readonly { readonly field: string; readonly count: number }[];
  readonly blocking: number;
  readonly degraded: number;
}

export function summarizeGaps(gaps: readonly Gap[]): GapSummary {
  const counts = new Map<string, number>();
  for (const gap of gaps) {
    counts.set(gap.field, (counts.get(gap.field) ?? 0) + 1);
  }

  const byField = [...counts]
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count || a.field.localeCompare(b.field));

  return {
    byField,
    blocking: gaps.filter((gap) => gap.severity === 'blocking').length,
    degraded: gaps.filter((gap) => gap.severity === 'degraded').length,
  };
}
