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
import {
  isMandatory,
  isPlayable,
  powerOf,
  type AdditionalCost,
  type CardDefinition,
  type Cost,
  type Domain,
} from '@riftbound/cards';

import { canPayAdditional } from './additional.js';
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
    return isReaction(card);
  }
  if (state.showdown) {
    // 308.1.a admits Actions and Reactions. Every Spell is one or the other,
    // and 819.1.b makes a Quick-Draw Gear a Reaction as well.
    return card.type === 'spell' || isReaction(card);
  }
  return true;
}

/**
 * Rule 813: does this card have Reaction timing?
 *
 * Asked of the card rather than of Spells, because 819.1.b gives a Gear with
 * Quick-Draw "Reaction inherently" — the keyword's whole point is that the Gear
 * may be played in a Closed state, so a check that only looked at Spells would
 * quietly ignore it.
 */
function isReaction(card: CardDefinition): boolean {
  return (card.type === 'spell' || card.type === 'gear') && card.timing === 'reaction';
}

export interface PlayableCheck {
  readonly card: CardDefinition;
  /** The Total Cost after rule 356, for this choice of Additional Cost. */
  readonly cost: Cost;
  /**
   * Rule 356.2.b: whether this offer declares the optional Additional Cost.
   *
   * A card with one is offered twice — paying and not paying are genuinely
   * different plays with different Total Costs, which is why the choice has to
   * be made at step 2 rather than discovered later.
   */
  readonly payAdditional: boolean;
}

/**
 * Rule 356.2 with 357.1: the resources an Additional Cost consumes are paid
 * from the same Rune Pool as the Total Cost, so affordability is one question
 * about their sum rather than two questions that could each say yes.
 */
function withResourceCosts(cost: Cost, costs: readonly AdditionalCost[]): Cost {
  let energy = cost.energy;
  let power = [...cost.power];
  for (const additional of costs) {
    if (additional.pay.kind === 'resources') {
      energy += additional.pay.cost.energy;
      power = [...power, ...additional.pay.cost.power];
    }
  }
  return { energy, power };
}

/**
 * Cards in `player`'s hand they could legally play and afford right now.
 *
 * A card whose Additional Cost is optional appears twice — once for each
 * declaration — because 356.2.b.1 makes that a choice at step 2 and the two
 * choices have different Total Costs. A card whose *Mandatory* cost cannot be
 * paid does not appear at all: 356.2.a makes paying it part of playing the
 * card, so an unpayable one makes the card unplayable, the same shape as 422.3
 * for a Discard that cannot be performed.
 */
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
    const entity = state.entities[id];
    if (entity === undefined) {
      continue;
    }

    const additional = card.abilities?.additionalCosts ?? [];
    const mandatory = additional.filter(isMandatory);
    const optional = additional.filter((cost) => !isMandatory(cost));

    // 356.2.a: every Mandatory cost must be payable or the card is unplayable.
    if (!mandatory.every((cost) => canPayAdditional(state, player, cost.pay, id))) {
      continue;
    }

    const offer = (payAdditional: boolean): void => {
      const paid = payAdditional ? [...mandatory, ...optional] : mandatory;
      const cost = totalCost(state, player, card, { paidAdditionalCost: payAdditional });
      if (cost === undefined || !canPay(pool, withResourceCosts(cost, paid))) {
        return;
      }
      results.push({ entity, check: { card, cost, payAdditional } });
    };

    offer(false);
    if (
      optional.length > 0 &&
      optional.every((cost) => canPayAdditional(state, player, cost.pay, id))
    ) {
      offer(true);
    }
  }

  return results;
}
