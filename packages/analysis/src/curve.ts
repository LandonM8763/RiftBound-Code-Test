import {
  DOMAINS,
  isPlayable,
  totalRuneCost,
  type CardRegistry,
  type CardType,
  type Domain,
} from '@riftbound/cards';
import type { DeckEntry } from '@riftbound/deck';

/**
 * The shape of a deck's costs.
 *
 * Energy and total cost are tracked separately on purpose. Two cards can both
 * read as "3 Energy" while one of them also demands two Power pips, and the
 * second is a materially later play because Energy and Power both consume Runes.
 */
export interface CostCurve {
  readonly totalCards: number;
  /** Energy cost to the number of copies at that cost. */
  readonly byEnergy: ReadonlyMap<number, number>;
  /** Energy plus Power pips, which is the real number of Runes a card needs. */
  readonly byTotalCost: ReadonlyMap<number, number>;
  readonly byType: ReadonlyMap<CardType, number>;
  /** Power pips demanded per Domain, counting every copy. */
  readonly powerPips: ReadonlyMap<Domain, number>;
  readonly averageEnergy: number;
  readonly averageTotalCost: number;
  readonly maxTotalCost: number;
}

function increment<K>(counts: Map<K, number>, key: K, by: number): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

/**
 * Build the cost curve for a pile of cards.
 *
 * Cards without a cost — Runes, Battlefields, a Legend — contribute to the type
 * histogram but not to the curve, so passing a whole deck does not skew the
 * averages.
 *
 * Throws on a card the registry does not know: run `validateDeck` first.
 */
export function costCurve(entries: readonly DeckEntry[], registry: CardRegistry): CostCurve {
  const byEnergy = new Map<number, number>();
  const byTotalCost = new Map<number, number>();
  const byType = new Map<CardType, number>();
  const powerPips = new Map<Domain, number>();

  let totalCards = 0;
  let costedCards = 0;
  let energySum = 0;
  let totalCostSum = 0;
  let maxTotalCost = 0;

  for (const entry of entries) {
    const card = registry.mustGet(entry.card);
    totalCards += entry.count;
    increment(byType, card.type, entry.count);

    if (!isPlayable(card)) {
      continue;
    }

    const energy = card.cost.energy;
    const total = totalRuneCost(card.cost);

    costedCards += entry.count;
    energySum += energy * entry.count;
    totalCostSum += total * entry.count;
    maxTotalCost = Math.max(maxTotalCost, total);

    increment(byEnergy, energy, entry.count);
    increment(byTotalCost, total, entry.count);

    for (const domain of card.cost.power) {
      increment(powerPips, domain, entry.count);
    }
  }

  return {
    totalCards,
    byEnergy,
    byTotalCost,
    byType,
    powerPips,
    averageEnergy: costedCards === 0 ? 0 : energySum / costedCards,
    averageTotalCost: costedCards === 0 ? 0 : totalCostSum / costedCards,
    maxTotalCost,
  };
}

/** The curve as a dense array indexed by cost, for charting. */
export function densify(counts: ReadonlyMap<number, number>): readonly number[] {
  const highest = Math.max(-1, ...counts.keys());
  return Array.from({ length: highest + 1 }, (_, cost) => counts.get(cost) ?? 0);
}

/** Power pips per Domain in a fixed, predictable Domain order. */
export function pipsByDomain(curve: CostCurve): ReadonlyMap<Domain, number> {
  const ordered = new Map<Domain, number>();
  for (const domain of DOMAINS) {
    const pips = curve.powerPips.get(domain);
    if (pips !== undefined && pips > 0) {
      ordered.set(domain, pips);
    }
  }
  return ordered;
}
