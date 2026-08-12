/**
 * Additional Costs (rule 356.2), layer 2 of Total Cost.
 *
 * The layer that was absent longest, and the reason was never the arithmetic —
 * it is that an Additional Cost is paid with a *non-standard* cost (356.7):
 * "kill a friendly unit", "discard 1", "spend a buff". Those are actions, not
 * numbers, so the layer needs a payment protocol rather than a subtraction.
 *
 * Two forms, and the difference is a decision point:
 *
 * - **Mandatory** (356.2.a): "As an additional cost to play me, kill a friendly
 *   unit." No "may". It must be paid, so a card whose cost cannot be paid
 *   cannot be played at all.
 * - **Optional** (356.2.b): "As you play me, you may discard a card as an
 *   additional cost. If you do, reduce my cost by 2." The choice is declared at
 *   *step 2* of the Process of Play — before the Total Cost is worked out,
 *   because choosing to pay changes it. That makes it a play-time choice like a
 *   target, not something asked mid-resolution.
 */
import type { Cost } from './cost.js';

/**
 * How an Additional Cost is paid (356.7).
 *
 * Only payments the engine can both *check* and *perform* are here. A cost that
 * could be added to the total and then not paid is worse than one that is not
 * offered, so anything else is refused at ingest.
 */
export type CostPayment =
  /** "pay 1 Calm" — an ordinary Energy/Power cost, paid from the Rune Pool. */
  | { readonly kind: 'resources'; readonly cost: Cost }
  /** "discard a card" (422). */
  | { readonly kind: 'discard'; readonly count: number }
  /** "spend a buff" (702.2). */
  | { readonly kind: 'spendBuff' }
  /**
   * "exhaust your legend" — a specific Game Object, so it needs no choice.
   * That is what makes it expressible while "exhaust a friendly unit" is not.
   */
  | { readonly kind: 'exhaustLegend' }
  /** "kill a friendly unit", "kill a friendly gear" (428). */
  | { readonly kind: 'kill'; readonly what: 'unit' | 'gear' };

export interface AdditionalCost {
  /**
   * 356.2.b: the "may" form, declared at step 2 rather than forced.
   *
   * Absent means Mandatory (356.2.a) — the rule distinguishes them by the word
   * "may" alone, so this flag is the whole difference.
   */
  readonly optional?: boolean | undefined;
  readonly pay: CostPayment;
}

/** Rule 356.2.a: a cost with no "may" must be paid to play the card at all. */
export function isMandatory(cost: AdditionalCost): boolean {
  return cost.optional !== true;
}
