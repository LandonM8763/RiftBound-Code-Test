/**
 * Everything a player may do.
 *
 * Every transition is an action, including the forced ones: phases A–D offer
 * exactly one legal action, so a single loop — enumerate, choose, reduce —
 * drives the whole game for agents and for the eventual UI alike.
 *
 * Playing cards, moving Units, and Showdowns are deliberately absent. They
 * depend on rules this codebase has not yet verified against the official
 * rulebook, and guessing them would bake wrong behaviour into the layer
 * everything else is measured against.
 */
export type Action =
  /** Resolve the current automatic phase and move to the next. */
  | { readonly type: 'resolvePhase' }
  /** End the action phase, passing the turn. */
  | { readonly type: 'endTurn' };

export type ActionType = Action['type'];

/** Thrown when an action is applied that `legalActions` would not have offered. */
export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalActionError';
  }
}
