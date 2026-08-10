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
    }
  | { readonly type: 'runeChannelled'; readonly player: PlayerId; readonly entity: EntityId }
  | { readonly type: 'runeDeckEmpty'; readonly player: PlayerId }
  | { readonly type: 'cardDrawn'; readonly player: PlayerId; readonly entity: EntityId }
  | { readonly type: 'mainDeckEmpty'; readonly player: PlayerId }
  | { readonly type: 'turnEnded'; readonly player: PlayerId }
  | { readonly type: 'gameEnded'; readonly outcome: Outcome };
