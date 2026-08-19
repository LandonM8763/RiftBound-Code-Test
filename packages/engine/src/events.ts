import type { Domain, Keyword } from '@riftbound/cards';

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
      /**
       * `null` when the points came from a card effect rather than from a
       * Battlefield. 468.1 makes every Score a point gain, but 469 gives only
       * two *methods* and both name a Battlefield — "you score 1 point" names
       * none, so it is neither.
       */
      readonly battlefield: number | null;
      readonly amount: number;
      readonly total: number;
      /** Which of the two Scoring methods this was (rule 469), or neither. */
      readonly method: 'hold' | 'conquer' | 'effect';
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
      /** 135.2.e.5.b: Power of any Domain, which has no Domain to name. */
      readonly anyPower?: number | undefined;
    }
  /** Rule 417: damage was dealt to a Unit. */
  | { readonly type: 'damageDealt'; readonly unit: EntityId; readonly amount: number }
  /** Might granted until the end of the turn. */
  | { readonly type: 'mightGranted'; readonly unit: EntityId; readonly amount: number }
  /** Rule 117: a player took their Mulligan. */
  | {
      readonly type: 'mulliganed';
      readonly player: PlayerId;
      readonly setAside: readonly EntityId[];
    }
  /** Rule 167: the Rune Pool emptied and unspent resources were lost. */
  | { readonly type: 'poolEmptied'; readonly player: PlayerId }
  /**
   * An Additional Cost was paid (356.2, 357.2). `optional` distinguishes a
   * declared 356.2.b payment from a forced 356.2.a one.
   */
  | {
      readonly type: 'additionalCostPaid';
      readonly player: PlayerId;
      readonly entity: EntityId;
      readonly optional: boolean;
    }
  /** Rule 359: a card finished the Process of Play. */
  | {
      readonly type: 'cardPlayed';
      readonly player: PlayerId;
      readonly entity: EntityId;
      readonly onChain: boolean;
    }
  /** Rule 377.3.a: a player activated an Activated Ability. */
  | {
      readonly type: 'abilityActivated';
      readonly player: PlayerId;
      readonly source: EntityId;
      readonly index: number;
    }
  /** Rule 383.3: a Triggered Ability's condition was met and it went on the Chain. */
  | {
      readonly type: 'abilityTriggered';
      readonly player: PlayerId;
      readonly source: EntityId;
      readonly index: number;
    }
  /** Rule 383.3.e.2.b: a "you may" trigger was declined and left the Chain. */
  | { readonly type: 'triggerDeclined'; readonly player: PlayerId; readonly source: EntityId }
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
  /** Rules 701-702: a Buff counter was placed on a Unit. */
  | { readonly type: 'buffAdded'; readonly unit: EntityId }
  /** Rule 702.2.b: a Buff was spent from a Unit. */
  | { readonly type: 'buffSpent'; readonly unit: EntityId }
  /** Rule 422: cards went from a hand to its trash. */
  | {
      readonly type: 'cardsDiscarded';
      readonly player: PlayerId;
      readonly cards: readonly EntityId[];
    }
  /** Rules 730: XP was gained (positive) or spent (negative). */
  | { readonly type: 'xpChanged'; readonly player: PlayerId; readonly amount: number }
  /** Rule 428: Units died. */
  | { readonly type: 'unitsKilled'; readonly units: readonly EntityId[] }
  /** Rule 434: a card was Attached, making the other a Top-Most Card. */
  | { readonly type: 'attached'; readonly card: EntityId; readonly topMost: EntityId }
  /** Rule 801.3.a: a keyword was granted to a Unit until end of turn. */
  | { readonly type: 'keywordGranted'; readonly unit: EntityId; readonly keyword: Keyword }
  /** Cards were put into their owner's hand — a bounce or a retrieval. */
  | {
      readonly type: 'returnedToHand';
      readonly player: PlayerId;
      readonly cards: readonly EntityId[];
    }
  /**
   * Rule 421: a card was Hidden facedown at a Battlefield.
   *
   * The card is deliberately *not* named. 107.3.f makes the Facedown Zone
   * public and its contents Private, so the event every player sees is that
   * something went down there — naming the entity in a shared event log would
   * leak what `view.ts` is careful to redact.
   */
  | { readonly type: 'cardHidden'; readonly player: PlayerId; readonly battlefield: number }
  /** 107.3.d / 421.4: a facedown card was removed and revealed. */
  | {
      readonly type: 'facedownRevealed';
      readonly player: PlayerId;
      readonly card: EntityId;
      readonly battlefield: number;
    }
  /** Rule 416: cards went to the bottom of their owner's Main Deck. */
  | {
      readonly type: 'cardsRecycled';
      readonly player: PlayerId;
      readonly cards: readonly EntityId[];
    }
  /** Rule 423: a Unit became Stunned. Not raised for an already-Stunned one. */
  | { readonly type: 'stunned'; readonly unit: EntityId }
  /** Rules 180-184: Tokens were Created on the Board. `token` keys rule 187. */
  | {
      readonly type: 'tokensCreated';
      readonly player: PlayerId;
      readonly token: string;
      readonly entities: readonly EntityId[];
    }
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
