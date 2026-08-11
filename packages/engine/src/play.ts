/**
 * The Process of Play (rules 349-359) and cost payment (rules 201, 444).
 *
 * What is modelled and what is not:
 *
 * - **Total Cost is determined by `costs.ts`.** Rule 356's layers live there;
 *   this module asks for the answer and pays it.
 * - **Adding resources is a separate action from playing.** Rule 357.1.a lets
 *   the controller activate Add Reactions *during* the Pay step. Since Basic
 *   Runes are the only source of resources so far (164.2), and their abilities
 *   are Reactions playable whenever resources are needed (429.3), requiring the
 *   pool to be filled first reaches exactly the same states.
 */
import { isPlayable, powerOf, type CardDefinition, type Cost, type Domain } from '@riftbound/cards';

import { totalCost } from './costs.js';

import type { Entity, GameState, Location, PlayerId, RunePool } from './state.js';
import { entityCard, getPlayer, playerLocation, powerIn } from './state.js';

/** Whether a pool covers a cost (rule 357.1). */
export function canPay(pool: RunePool, cost: Cost): boolean {
  if (pool.energy < cost.energy) {
    return false;
  }
  for (const domain of new Set(cost.power)) {
    if (powerIn(pool, domain) < powerOf(cost, domain)) {
      return false;
    }
  }
  return true;
}

/** Remove a cost's resources from a pool (rule 444.1). Assumes `canPay`. */
export function payFrom(pool: RunePool, cost: Cost): RunePool {
  const power: Record<Domain, number> = { ...pool.power };
  for (const domain of cost.power) {
    power[domain] -= 1;
  }
  return { energy: pool.energy - cost.energy, power };
}

/**
 * Locations a Unit may be played to (rule 355.2.a): the controller's Base, or a
 * Battlefield that controller controls.
 */
export function validUnitLocations(state: GameState, player: PlayerId): Location[] {
  const locations: Location[] = [playerLocation(player, 'base')];
  state.battlefields.forEach((battlefield, index) => {
    if (battlefield.controller === player) {
      locations.push({ kind: 'battlefield', index });
    }
  });
  return locations;
}

/**
 * Can this card be played right now, ignoring cost? (rule 358.4)
 *
 * The four states of rule 310 give three distinct permissions:
 * - Closed, either kind: only Reactions (309.1.a).
 * - Showdown Open: only Actions or Reactions (308.1.a).
 * - Neutral Open: anything (310.1.a).
 */
export function timingAllows(
  card: CardDefinition,
  state: { readonly closed: boolean; readonly showdown: boolean },
): boolean {
  if (!isPlayable(card)) {
    return false;
  }
  if (state.closed) {
    return card.type === 'spell' && card.timing === 'reaction';
  }
  if (state.showdown) {
    return card.type === 'spell';
  }
  return true;
}

export interface PlayableCheck {
  readonly card: CardDefinition;
  readonly cost: Cost;
}

/** Cards in `player`'s hand they could legally play and afford right now. */
export function playableFromHand(
  state: GameState,
  player: PlayerId,
  timing: { readonly closed: boolean; readonly showdown: boolean },
): { readonly entity: Entity; readonly check: PlayableCheck }[] {
  const pool = getPlayer(state, player).pool;
  const results: { entity: Entity; check: PlayableCheck }[] = [];

  for (const id of getPlayer(state, player).zones.hand) {
    const card = entityCard(state, id);
    if (!timingAllows(card, timing)) {
      continue;
    }
    const cost = totalCost(state, player, card);
    if (cost === undefined || !canPay(pool, cost)) {
      continue;
    }
    const entity = state.entities[id];
    if (entity !== undefined) {
      results.push({ entity, check: { card, cost } });
    }
  }

  return results;
}
