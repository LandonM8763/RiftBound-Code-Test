import type { Action } from './actions.js';
import { playableFromHand, validUnitLocations } from './play.js';
import type { GameState, PlayerId } from './state.js';
import { entityCard, getPlayer, isClosed, isOver } from './state.js';

/**
 * Every action `player` may legally take right now.
 *
 * First-class on purpose: agents and the eventual UI both drive the game by
 * enumerating this and choosing from it, so neither has to guess-and-check.
 * An action returned here is guaranteed to be accepted by `reduce`.
 */
export function legalActions(state: GameState, player: PlayerId): readonly Action[] {
  if (isOver(state)) {
    return [];
  }

  // Outside the Main Phase nothing has Priority and the phase simply resolves.
  if (state.priority === null) {
    return player === state.activePlayer ? [{ type: 'resolvePhase' }] : [];
  }

  if (player !== state.priority) {
    return [];
  }

  const closed = isClosed(state);
  const actions: Action[] = [];

  // Rule 164.2: a Basic Rune's two Add abilities are Reactions, so they are
  // available whenever their controller has Priority, Chain or no Chain.
  for (const rune of getPlayer(state, player).zones.runes) {
    const entity = state.entities[rune];
    if (entity === undefined) {
      continue;
    }
    if (!entity.exhausted) {
      actions.push({ type: 'addEnergy', rune });
    }
    if (entityCard(state, rune).type === 'rune') {
      actions.push({ type: 'addPower', rune });
    }
  }

  // Rule 358.4: timing permissions. `playableFromHand` filters to cards this
  // player can both legally play now and afford.
  for (const { entity, check } of playableFromHand(state, player, closed)) {
    if (check.card.type === 'unit') {
      for (const location of validUnitLocations(state, player)) {
        actions.push({ type: 'playCard', card: entity.id, location });
      }
    } else {
      actions.push({ type: 'playCard', card: entity.id });
    }
  }

  if (closed) {
    // Rule 312.2.d: with a Chain, passing is always available and is how items
    // eventually resolve.
    actions.push({ type: 'pass' });
  } else if (player === state.activePlayer && state.phase === 'main') {
    actions.push({ type: 'endTurn' });
  }

  return actions;
}

/** Convenience wrapper for the player who may act right now. */
export function currentLegalActions(state: GameState): readonly Action[] {
  return legalActions(state, state.priority ?? state.activePlayer);
}
