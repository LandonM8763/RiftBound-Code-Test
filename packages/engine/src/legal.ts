import type { Action } from './actions.js';
import type { GameState, PlayerId } from './state.js';
import { isOver } from './state.js';

/**
 * Every action `player` may legally take right now.
 *
 * First-class on purpose: agents and the eventual UI both drive the game by
 * enumerating this and choosing from it, so neither has to guess-and-check.
 * An action returned here is guaranteed to be accepted by `reduce`.
 *
 * Non-active players currently have no legal actions. That changes once
 * Reactions exist, at which point this is where their priority windows appear.
 */
export function legalActions(state: GameState, player: PlayerId): readonly Action[] {
  if (isOver(state)) {
    return [];
  }
  if (player !== state.activePlayer) {
    return [];
  }
  return state.phase === 'main' ? [{ type: 'endTurn' }] : [{ type: 'resolvePhase' }];
}

/** Convenience wrapper for the common case. */
export function currentLegalActions(state: GameState): readonly Action[] {
  return legalActions(state, state.activePlayer);
}
