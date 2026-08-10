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
  /** Play a card from hand (rules 349-359). Units need a Location. */
  | { readonly type: 'playCard'; readonly card: EntityId; readonly location?: Location }
  /** Pass Priority (rule 312.2.d). Resolves the Chain once everyone passes. */
  | { readonly type: 'pass' };

export type ActionType = Action['type'];

/** Thrown when an action is applied that `legalActions` would not have offered. */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}
