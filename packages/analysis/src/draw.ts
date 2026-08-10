import type { CardId } from '@riftbound/cards';
import { countOf, totalCount, type Deck } from '@riftbound/deck';
import { DEFAULT_CONFIG, type GameConfig } from '@riftbound/engine';

import { atLeast, mean } from './hypergeometric.js';

/**
 * How many cards and Runes a player has seen by a given turn.
 *
 * Every quantity here is one the engine also owns. Deriving the model from
 * `GameConfig` keeps a single source of truth: when the opening hand size was
 * corrected from 5 to 4 against rule 116, every figure here moved with it and
 * only the test literals needed updating.
 */
export interface DrawModel {
  readonly openingHandSize: number;
  readonly drawPerTurn: number;
  readonly channelPerTurn: number;
  /**
   * Whether a player draws on their own first turn.
   *
   * True in Riftbound: rule 315.4 has the Turn Player draw every turn, and the
   * only first-turn adjustment in the sanctioned 1v1 mode is the extra Rune the
   * second player Channels (485.7) — the Draw Phase is untouched. Kept as a
   * parameter because other Modes of Play may adjust it (483.7).
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
