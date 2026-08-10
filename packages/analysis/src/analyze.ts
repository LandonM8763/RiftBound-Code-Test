import type { CardRegistry, CardType } from '@riftbound/cards';
import { totalCount, type Deck } from '@riftbound/deck';

import { castability, domainBalance, type CardCastability, type DomainBalance } from './consistency.js';
import { costCurve, type CostCurve } from './curve.js';
import { DEFAULT_DRAW_MODEL, cardsSeenByTurn, type DrawModel } from './draw.js';
import { atLeast, mean } from './hypergeometric.js';

export interface OpeningHandStats {
  readonly handSize: number;
  /** Expected number of cards of each type in the opening hand. */
  readonly expectedByType: ReadonlyMap<CardType, number>;
  /** Probability of at least one card of each type in the opening hand. */
  readonly atLeastOneByType: ReadonlyMap<CardType, number>;
}

/** How many copies of a card type the main deck holds. */
function countByType(deck: Deck, registry: CardRegistry): Map<CardType, number> {
  const counts = new Map<CardType, number>();
  for (const entry of deck.main) {
    const card = registry.mustGet(entry.card);
    counts.set(card.type, (counts.get(card.type) ?? 0) + entry.count);
  }
  return counts;
}

/** Probability of at least `copies` cards of a type by a given turn. */
export function probabilityOfType(
  deck: Deck,
  registry: CardRegistry,
  type: CardType,
  copies = 1,
  turn = 0,
  model: DrawModel = DEFAULT_DRAW_MODEL,
): number {
  const population = totalCount(deck.main);
  const successes = countByType(deck, registry).get(type) ?? 0;
  const draws = Math.min(cardsSeenByTurn(turn, model), population);

  return atLeast({ population, successes, draws }, copies);
}

export function openingHandStats(
  deck: Deck,
  registry: CardRegistry,
  model: DrawModel = DEFAULT_DRAW_MODEL,
): OpeningHandStats {
  const population = totalCount(deck.main);
  const draws = Math.min(cardsSeenByTurn(0, model), population);
  const counts = countByType(deck, registry);

  const expectedByType = new Map<CardType, number>();
  const atLeastOneByType = new Map<CardType, number>();

  for (const [type, successes] of counts) {
    expectedByType.set(type, mean({ population, successes, draws }));
    atLeastOneByType.set(type, atLeast({ population, successes, draws }, 1));
  }

  return { handSize: draws, expectedByType, atLeastOneByType };
}

/**
 * Everything computable about a deck without playing a game.
 *
 * All of it is analytic: closed-form, exact, and fast. Win rates, average game
 * length, and per-card impact are a different kind of statistic — they require
 * the engine and an agent, belong in the planned `sim` package, and must always
 * be reported with a sample size and an uncertainty measure.
 *
 * Throws if the registry does not know a card in the deck. Validate first.
 */
export interface DeckAnalysis {
  readonly mainDeckSize: number;
  readonly runeDeckSize: number;
  readonly curve: CostCurve;
  readonly domains: DomainBalance;
  readonly castability: readonly CardCastability[];
  readonly openingHand: OpeningHandStats;
}

export function analyzeDeck(
  deck: Deck,
  registry: CardRegistry,
  model: DrawModel = DEFAULT_DRAW_MODEL,
): DeckAnalysis {
  return {
    mainDeckSize: totalCount(deck.main),
    runeDeckSize: totalCount(deck.runes),
    curve: costCurve(deck.main, registry),
    domains: domainBalance(deck, registry),
    castability: castability(deck, registry, model),
    openingHand: openingHandStats(deck, registry, model),
  };
}
