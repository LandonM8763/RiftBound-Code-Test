import {
  DOMAINS,
  isPlayable,
  powerOf,
  totalRuneCost,
  type CardId,
  type CardRegistry,
  type Domain,
} from '@riftbound/cards';
import { totalCount, type Deck } from '@riftbound/deck';

import { DEFAULT_DRAW_MODEL, runesChannelledByTurn, type DrawModel } from './draw.js';
import { multivariateAtLeast } from './hypergeometric.js';

/**
 * How a deck's Rune deck lines up with what its cards actually demand.
 *
 * A deck can be perfectly on curve for Energy and still fail constantly because
 * its Power pips and its Runes disagree. This is the check for that.
 */
export interface DomainBalance {
  readonly totalRunes: number;
  readonly totalPips: number;
  /** Runes of each Domain in the Rune deck. */
  readonly runeCounts: ReadonlyMap<Domain, number>;
  /** Each Domain's share of the Rune deck, 0 to 1. */
  readonly runeShare: ReadonlyMap<Domain, number>;
  /** Power pips demanded per Domain across the main deck. */
  readonly powerDemand: ReadonlyMap<Domain, number>;
  /** Each Domain's share of total Power demand, 0 to 1. */
  readonly demandShare: ReadonlyMap<Domain, number>;
}

export function domainBalance(deck: Deck, registry: CardRegistry): DomainBalance {
  const runeCounts = new Map<Domain, number>();
  const powerDemand = new Map<Domain, number>();

  for (const entry of deck.runes) {
    const card = registry.mustGet(entry.card);
    if (card.type === 'rune') {
      runeCounts.set(card.domain, (runeCounts.get(card.domain) ?? 0) + entry.count);
    }
  }

  for (const entry of deck.main) {
    const card = registry.mustGet(entry.card);
    if (!isPlayable(card)) {
      continue;
    }
    for (const domain of card.cost.power) {
      powerDemand.set(domain, (powerDemand.get(domain) ?? 0) + entry.count);
    }
  }

  const totalRunes = [...runeCounts.values()].reduce((sum, value) => sum + value, 0);
  const totalPips = [...powerDemand.values()].reduce((sum, value) => sum + value, 0);

  const share = (counts: ReadonlyMap<Domain, number>, total: number): Map<Domain, number> => {
    const result = new Map<Domain, number>();
    if (total === 0) {
      return result;
    }
    for (const [domain, value] of counts) {
      result.set(domain, value / total);
    }
    return result;
  };

  return {
    totalRunes,
    totalPips,
    runeCounts,
    runeShare: share(runeCounts, totalRunes),
    powerDemand,
    demandShare: share(powerDemand, totalPips),
  };
}

export interface PowerQuery {
  readonly deck: Deck;
  readonly registry: CardRegistry;
  /** Pips needed per Domain, e.g. `{ fury: 1, calm: 1 }`. */
  readonly required: Partial<Record<Domain, number>>;
  readonly turn: number;
  readonly model?: DrawModel | undefined;
}

/**
 * Probability of having Channelled enough Runes of the right Domains by a turn.
 *
 * Domains are solved jointly rather than one at a time: every Fury Rune drawn is
 * one fewer slot for a Calm Rune, so multiplying per-Domain odds together would
 * overstate a two-Domain cost.
 *
 * Models Channelling as drawing from the Rune deck without replacement. This is
 * exact until the first Recycle, since paying Power puts Runes on the bottom of
 * the Rune deck and changes the population. Treat it as a first-order estimate
 * for the early turns that decide most games, not as a whole-game figure.
 */
export function powerAvailability(query: PowerQuery): number {
  const model = query.model ?? DEFAULT_DRAW_MODEL;
  const balance = domainBalance(query.deck, query.registry);

  const counts: number[] = [];
  const minimums: number[] = [];
  for (const domain of DOMAINS) {
    counts.push(balance.runeCounts.get(domain) ?? 0);
    minimums.push(query.required[domain] ?? 0);
  }

  const population = totalCount(query.deck.runes);
  const draws = Math.min(runesChannelledByTurn(query.turn, model), population);

  return multivariateAtLeast(counts, minimums, draws);
}

export interface CardCastability {
  readonly card: CardId;
  readonly name: string;
  readonly copies: number;
  readonly energy: number;
  /** Energy plus Power pips: the Runes this card consumes. */
  readonly runeCost: number;
  /**
   * First turn with enough Runes Channelled to pay at all, Domains ignored.
   * `null` when the Rune deck can never supply that many.
   */
  readonly earliestTurn: number | null;
  /** Chance the Channelled Runes are the right Domains by `earliestTurn`. */
  readonly powerOnCurve: number;
}

/**
 * Per-card castability across the main deck.
 *
 * `earliestTurn` is the Energy question and is deterministic — Runes accumulate
 * at a fixed rate. `powerOnCurve` is the Domain question and is probabilistic.
 * A card with a low `powerOnCurve` is the kind of card that looks fine on a
 * curve chart and strands in hand in play.
 */
export function castability(
  deck: Deck,
  registry: CardRegistry,
  model: DrawModel = DEFAULT_DRAW_MODEL,
): CardCastability[] {
  const runeDeckSize = totalCount(deck.runes);
  const results: CardCastability[] = [];

  for (const entry of deck.main) {
    const card = registry.mustGet(entry.card);
    if (!isPlayable(card)) {
      continue;
    }

    const runeCost = totalRuneCost(card.cost);
    const earliestTurn = firstTurnWithRunes(runeCost, runeDeckSize, model);

    const required: Partial<Record<Domain, number>> = {};
    for (const domain of DOMAINS) {
      const pips = powerOf(card.cost, domain);
      if (pips > 0) {
        required[domain] = pips;
      }
    }

    results.push({
      card: card.id,
      name: card.name,
      copies: entry.count,
      energy: card.cost.energy,
      runeCost,
      earliestTurn,
      powerOnCurve:
        earliestTurn === null
          ? 0
          : powerAvailability({ deck, registry, required, turn: earliestTurn, model }),
    });
  }

  return results;
}

function firstTurnWithRunes(
  needed: number,
  runeDeckSize: number,
  model: DrawModel,
): number | null {
  if (needed <= 0) {
    return 0;
  }
  if (needed > runeDeckSize) {
    return null;
  }
  if (model.channelPerTurn <= 0) {
    return null;
  }
  return Math.ceil(needed / model.channelPerTurn);
}
