import type { Domain } from '@riftbound/cards';

import type { EntityId, Outcome, Phase, PlayerId } from './state.js';

/**
 * Structured records of what happened.
 *
 * Events carry data, never presentation. No formatted strings, no colours, no
 * layout — consumers (a log, a replay viewer, the eventual UI) render them.
 */
export type GameEvent =
  | { readonly type: 'gameStarted'; readonly startingPlayer: PlayerId }
  | {
      readonly type: 'phaseEntered';
      readonly turn: number;
      readonly player: PlayerId;
      readonly phase: Phase;
    }
  | { readonly type: 'readied'; readonly player: PlayerId; readonly entities: readonly EntityId[] }
  | {
      readonly type: 'pointsScored';
      readonly player: PlayerId;
      readonly battlefield: number;
      readonly amount: number;
      readonly total: number;
      /** Which of the two Scoring methods this was (rule 469). */
      readonly method: 'hold' | 'conquer';
    }
  /** Rule 431: the player ran out of Main Deck and an opponent gained a point. */
  | {
      readonly type: 'burnedOut';
      readonly player: PlayerId;
      readonly recycled: number;
      readonly beneficiary: PlayerId;
      readonly total: number;
    }
  /** Rule 317.2.b: all Units heal in the Ending Phase. */
  | { readonly type: 'healed'; readonly entities: readonly EntityId[] }
  /** Rule 429: resources were Added to a Rune Pool. */
  | {
      readonly type: 'resourcesAdded';
      readonly player: PlayerId;
      readonly rune: EntityId;
      readonly energy: number;
      readonly power: Domain | null;
    }
  /** Rule 167: the Rune Pool emptied and unspent resources were lost. */
  | { readonly type: 'poolEmptied'; readonly player: PlayerId }
  /** Rule 359: a card finished the Process of Play. */
  | {
      readonly type: 'cardPlayed';
      readonly player: PlayerId;
      readonly entity: EntityId;
      readonly onChain: boolean;
    }
  /** Rule 328: an item was added to the Chain. */
  | { readonly type: 'chainItemAdded'; readonly entity: EntityId; readonly controller: PlayerId }
  /** Rule 359.3.d: a Chain item resolved. */
  | { readonly type: 'chainItemResolved'; readonly entity: EntityId }
  | { readonly type: 'priorityPassed'; readonly player: PlayerId }
  | { readonly type: 'runeChannelled'; readonly player: PlayerId; readonly entity: EntityId }
  | { readonly type: 'runeDeckEmpty'; readonly player: PlayerId }
  | { readonly type: 'cardDrawn'; readonly player: PlayerId; readonly entity: EntityId }
  | { readonly type: 'mainDeckEmpty'; readonly player: PlayerId }
  | { readonly type: 'turnEnded'; readonly player: PlayerId }
  | { readonly type: 'gameEnded'; readonly outcome: Outcome };
