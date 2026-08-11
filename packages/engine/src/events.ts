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
      /** `null` when the resources came from a card effect rather than a Rune. */
      readonly rune: EntityId | null;
      readonly energy: number;
      readonly power: Domain | null;
    }
  /** Rule 417: damage was dealt to a Unit. */
  | { readonly type: 'damageDealt'; readonly unit: EntityId; readonly amount: number }
  /** Might granted until the end of the turn. */
  | { readonly type: 'mightGranted'; readonly unit: EntityId; readonly amount: number }
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
  /** Rule 144: Units took their Standard Move. */
  | {
      readonly type: 'unitsMoved';
      readonly player: PlayerId;
      readonly units: readonly EntityId[];
      readonly battlefield: number | null;
    }
  /** Rule 450: a Battlefield became Contested. */
  | {
      readonly type: 'battlefieldContested';
      readonly battlefield: number;
      readonly player: PlayerId;
    }
  /** Rule 344: a Showdown opened at a Battlefield. */
  | { readonly type: 'showdownOpened'; readonly battlefield: number; readonly focus: PlayerId }
  /** Rule 464: a Combat opened at a Battlefield. */
  | {
      readonly type: 'combatOpened';
      readonly battlefield: number;
      readonly attacker: PlayerId;
      readonly defender: PlayerId;
    }
  /** Rule 465: Combat Damage was assigned and dealt simultaneously. */
  | {
      readonly type: 'combatDamage';
      readonly battlefield: number;
      readonly attackerMight: number;
      readonly defenderMight: number;
      readonly assigned: readonly { readonly unit: EntityId; readonly damage: number }[];
    }
  /** Rule 428: Units died. */
  | { readonly type: 'unitsKilled'; readonly units: readonly EntityId[] }
  /** Rule 466.1.a.2: surviving Attackers were Recalled to their Base. */
  | { readonly type: 'unitsRecalled'; readonly units: readonly EntityId[] }
  /** Rule 466.3: the Combat result. */
  | {
      readonly type: 'combatResolved';
      readonly battlefield: number;
      readonly winner: PlayerId | null;
      readonly reason: string;
    }
  /** Rule 348: every player passed Focus and the Showdown Closed. */
  | { readonly type: 'showdownClosed'; readonly battlefield: number }
  /** Rule 348.2.a: a player established Control of a Battlefield. */
  | {
      readonly type: 'controlEstablished';
      readonly battlefield: number;
      readonly player: PlayerId;
    }
  /** Rule 471.1.b.1: a Conquer could not take the Final Point, so a card was drawn. */
  | {
      readonly type: 'finalPointDenied';
      readonly player: PlayerId;
      readonly battlefield: number;
    }
  /** Rule 190.4.c: a player lost Control of a Battlefield. */
  | {
      readonly type: 'controlLost';
      readonly battlefield: number;
      readonly player: PlayerId;
    }
  | { readonly type: 'runeChannelled'; readonly player: PlayerId; readonly entity: EntityId }
  | { readonly type: 'runeDeckEmpty'; readonly player: PlayerId }
  | { readonly type: 'cardDrawn'; readonly player: PlayerId; readonly entity: EntityId }
  | { readonly type: 'mainDeckEmpty'; readonly player: PlayerId }
  | { readonly type: 'turnEnded'; readonly player: PlayerId }
  | { readonly type: 'gameEnded'; readonly outcome: Outcome };
