import type { CardId } from '@riftbound/cards';
import { countOf, totalCount, type Deck } from '@riftbound/deck';
import { DEFAULT_CONFIG, type GameConfig } from '@riftbound/engine';

import { atLeast, mean } from './hypergeometric.js';

/**
 * How many cards and Runes a player has seen by a given turn.
 *
 * Every quantity here is one the engine also owns, and several are still
 * UNVERIFIED. Deriving the model from `GameConfig` keeps a single source of
 * truth: correcting the opening hand size against the rulebook fixes the engine
 * and these statistics together, instead of leaving them silently disagreeing.
 */
export interface DrawModel {
  readonly openingHandSize: number;
  readonly drawPerTurn: number;
  readonly channelPerTurn: number;
  /**
   * Whether a player draws on their own first turn.
   *
   * UNVERIFIED, like the engine's matching assumption: many card games skip the
   * first draw for whoever goes first, and this one may too.
   */
  readonly drawsOnFirstTurn: boolean;
}

export function drawModelFromConfig(config: GameConfig, drawsOnFirstTurn = true): DrawModel {
  return {
    openingHandSize: config.openingHandSize,
    drawPerTurn: config.drawPerTurn,
    channelPerTurn: config.channelPerTurn,
    drawsOnFirstTurn,
  };
}

export const DEFAULT_DRAW_MODEL: DrawModel = drawModelFromConfig(DEFAULT_CONFIG);

function requireTurn(turn: number): void {
  if (!Number.isInteger(turn) || turn < 0) {
    throw new RangeError(`Turn must be a non-negative integer, got ${turn}`);
  }
}

/**
 * Cards seen by the end of the Draw phase of the player's `turn`-th turn.
 * Turn 0 is the opening hand, before anyone has drawn.
 */
export function cardsSeenByTurn(turn: number, model: DrawModel = DEFAULT_DRAW_MODEL): number {
  requireTurn(turn);
  const drawTurns = model.drawsOnFirstTurn ? turn : Math.max(0, turn - 1);
  return model.openingHandSize + drawTurns * model.drawPerTurn;
}

/** Runes Channelled by the end of the player's `turn`-th Channelling phase. */
export function runesChannelledByTurn(
  turn: number,
  model: DrawModel = DEFAULT_DRAW_MODEL,
): number {
  requireTurn(turn);
  return turn * model.channelPerTurn;
}

export interface DrawQuery {
  readonly deck: Deck;
  readonly card: CardId;
  /** The player's own turn number. 0 is the opening hand. */
  readonly turn: number;
  /** How many copies you need. Defaults to 1. */
  readonly copies?: number | undefined;
  readonly model?: DrawModel | undefined;
}

/** Probability of holding at least `copies` of a card by a given turn. */
export function probabilityOfCard(query: DrawQuery): number {
  const model = query.model ?? DEFAULT_DRAW_MODEL;
  const population = totalCount(query.deck.main);
  const successes = countOf(query.deck.main, query.card);
  const draws = Math.min(cardsSeenByTurn(query.turn, model), population);

  return atLeast({ population, successes, draws }, query.copies ?? 1);
}

/** Expected number of copies of a card seen by a given turn. */
export function expectedCopies(query: Omit<DrawQuery, 'copies'>): number {
  const model = query.model ?? DEFAULT_DRAW_MODEL;
  const population = totalCount(query.deck.main);
  const successes = countOf(query.deck.main, query.card);
  const draws = Math.min(cardsSeenByTurn(query.turn, model), population);

  return mean({ population, successes, draws });
}

/**
 * The turn-by-turn odds of holding a card, from the opening hand onwards.
 * The shape a "probability of hitting X by turn N" chart is drawn from.
 */
export function drawCurve(
  deck: Deck,
  card: CardId,
  throughTurn: number,
  model: DrawModel = DEFAULT_DRAW_MODEL,
  copies = 1,
): readonly number[] {
  requireTurn(throughTurn);
  return Array.from({ length: throughTurn + 1 }, (_, turn) =>
    probabilityOfCard({ deck, card, turn, copies, model }),
  );
}
