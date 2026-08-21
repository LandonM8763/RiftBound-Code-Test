import type { EntityId, Location } from './state.js';

/**
 * Everything a player may do.
 *
 * Every transition is an action, including the forced ones: the automatic
 * phases offer exactly one legal action, so a single loop — enumerate, choose,
 * reduce — drives the whole game for agents and for the eventual UI alike.
 *
 * Movement, Showdowns and Combat are still absent; see CLAUDE.md.
 */
export type Action =
  /** Resolve the current automatic phase and move to the next. */
  | { readonly type: 'resolvePhase' }
  /** End the Main Phase, passing to the Ending Phase (rule 316.9). */
  | { readonly type: 'endTurn' }
  /**
   * Exhaust a ready Rune for 1 Energy — a Basic Rune's `[E]: Add [1]`
   * (rule 164.2.a).
   */
  | { readonly type: 'addEnergy'; readonly rune: EntityId }
  /**
   * Recycle a Rune for 1 Power of its Domain — a Basic Rune's
   * `Recycle this: Add [C]` (rule 164.2.b).
   */
  | { readonly type: 'addPower'; readonly rune: EntityId }
  /**
   * Play a card from hand (rules 349-359).
   *
   * Units need a Location. A card whose rules text targets needs `targets`,
   * chosen now rather than on resolution: rule 355.8 requires valid choices for
   * every target before the card can go on the Chain.
   *
   * A list rather than one id because a spec may choose several (355.6 makes
   * each chosen object a Target of its own). Almost every card names one, and
   * for those the list holds exactly one.
   */
  | {
      readonly type: 'playCard';
      readonly card: EntityId;
      /** Where a Unit enters the Board (359.2.c). Entering is not a Move. */
      readonly location?: Location;
      readonly targets?: readonly EntityId[];
      /** Where a `move` effect on the card sends its target (rule 449.1). */
      readonly destination?: Location;
      /**
       * Rule 356.2.b.1: declares the optional Additional Cost will be paid.
       *
       * Declared here, at step 2, because choosing to pay changes the Total
       * Cost worked out at step 3 — so it cannot be asked any later.
       */
      readonly payAdditional?: boolean;
    }
  /** Pass Priority (rule 312.2.d). Resolves the Chain once everyone passes. */
  | { readonly type: 'pass' }
  /**
   * Rule 421: Hide a card facedown at a Battlefield you Control.
   *
   * A Discretionary Action of its own, not a kind of play — 811.1.c.1 says so
   * explicitly, and 811.1.c.2 adds that it opens no Chain. `battlefield` is the
   * index whose Facedown Zone the card goes into.
   */
  | { readonly type: 'hide'; readonly card: EntityId; readonly battlefield: number }
  /**
   * Rule 377.3.a: declare activation of an Activated Ability. `source` is the
   * Game Object the ability is printed on, `index` its position in that card's
   * activated abilities.
   */
  | {
      readonly type: 'activateAbility';
      readonly source: EntityId;
      readonly index: number;
      /**
       * 718.3: the Attached card this ability was read from, when the source
       * has it only because something is Equipped to it.
       */
      readonly from?: EntityId;
      readonly targets?: readonly EntityId[];
      readonly destination?: Location;
    }
  /**
   * Rule 402, step 2 of playing an Ability: make the relevant choices.
   *
   * The rulebook puts two decisions in this one step, which is why one action
   * carries both. 402.1 is the "you may" — its controller decides whether to
   * perform it, and declining removes it from the Chain (383.3.e.2.b). 402.2 is
   * every other choice the ability needs, "such as targets, modes, or other
   * relevant decisions".
   *
   * A mandatory ability still passes through this step whenever it has
   * something to choose: 402.4.b says its controller *must* choose, and may not
   * decline this stage, so `perform` is false only for a genuine "you may".
   */
  | {
      readonly type: 'resolveTrigger';
      readonly perform: boolean;
      readonly targets?: readonly EntityId[];
      readonly destination?: Location;
    }
  /**
   * Take the Mulligan (rule 117): set aside these cards, draw that many, then
   * Recycle the set-aside ones. An empty list keeps the opening hand.
   */
  | { readonly type: 'mulligan'; readonly cards: readonly EntityId[] }
  /**
   * The Standard Move (rule 144): exhaust one or more Units to move them to a
   * shared destination. Rule 144.3 allows several at once as a single action.
   */
  | {
      readonly type: 'moveUnits';
      readonly units: readonly EntityId[];
      readonly to: Location;
    };

export type ActionType = Action['type'];

/** Thrown when an action is applied that `legalActions` would not have offered. */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}
