/**
 * The Process of Play (rules 349-359) and cost payment (rules 201, 444).
 *
 * What is modelled and what is not:
 *
 * - **Total Cost is the base cost.** Rule 356 layers base-cost replacement,
 *   additional costs, increases and discounts on top; all of those come from
 *   card effects, and no card has effects yet. `totalCost` is the seam they
 *   plug into.
 * - **Adding resources is a separate action from playing.** Rule 357.1.a lets
 *   the controller activate Add Reactions *during* the Pay step. Since Basic
 *   Runes are the only source of resources so far (164.2), and their abilities
 *   are Reactions playable whenever resources are needed (429.3), requiring the
 *   pool to be filled first reaches exactly the same states.
 */
import { isPlayable, powerOf, type CardDefinition, type Cost, type Domain } from '@riftbound/cards';

import type { Entity, GameState, Location, PlayerId, RunePool } from './state.js';
import { entityCard, getPlayer, playerLocation, powerIn } from './state.js';

/** Rule 356. Currently the printed cost: nothing modifies costs yet. */
export function totalCost(card: CardDefinition): Cost | undefined {
  return isPlayable(card) ? card.cost : undefined;
}

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
 * Can this card be played right now, ignoring cost?
 *
 * Rule 358.4 checks timing permissions. In a Closed State only Reactions may be
 * played (309.1.a); in an Open Neutral State the Turn Player may play anything
 * (310.1.a).
 */
export function timingAllows(card: CardDefinition, closed: boolean): boolean {
  if (!isPlayable(card)) {
    return false;
  }
  if (!closed) {
    return true;
  }
  return card.type === 'spell' && card.timing === 'reaction';
}

export interface PlayableCheck {
  readonly card: CardDefinition;
  readonly cost: Cost;
}

/** Cards in `player`'s hand they could legally play and afford right now. */
export function playableFromHand(
  state: GameState,
  player: PlayerId,
  closed: boolean,
): { readonly entity: Entity; readonly check: PlayableCheck }[] {
  const pool = getPlayer(state, player).pool;
  const results: { entity: Entity; check: PlayableCheck }[] = [];

  for (const id of getPlayer(state, player).zones.hand) {
    const card = entityCard(state, id);
    if (!timingAllows(card, closed)) {
      continue;
    }
    const cost = totalCost(card);
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
