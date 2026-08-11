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
   * Units need a Location. A card whose rules text targets needs `target`,
   * chosen now rather than on resolution: rule 355.8 requires valid choices for
   * every target before the card can go on the Chain.
   */
  | {
      readonly type: 'playCard';
      readonly card: EntityId;
      /** Where a Unit enters the Board (359.2.c). Entering is not a Move. */
      readonly location?: Location;
      readonly target?: EntityId;
      /** Where a `move` effect on the card sends its target (rule 449.1). */
      readonly destination?: Location;
    }
  /** Pass Priority (rule 312.2.d). Resolves the Chain once everyone passes. */
  | { readonly type: 'pass' }
  /**
   * Rule 377.3.a: declare activation of an Activated Ability. `source` is the
   * Game Object the ability is printed on, `index` its position in that card's
   * activated abilities.
   */
  | {
      readonly type: 'activateAbility';
      readonly source: EntityId;
      readonly index: number;
      readonly target?: EntityId;
      readonly destination?: Location;
    }
  /**
   * Rule 383.3.a: a "you may" Triggered Ability is performed or declined by its
   * controller during finalization; declining removes it from the Chain
   * (383.3.e.2.b).
   */
  | { readonly type: 'resolveTrigger'; readonly perform: boolean }
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
