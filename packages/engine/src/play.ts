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
  DOMAINS,
  anyPowerOf,
  isMandatory,
  isPlayable,
  powerOf,
  type AdditionalCost,
  type CardDefinition,
  type Cost,
  type Domain,
} from '@riftbound/cards';

import { canPayAdditional } from './additional.js';
import { extraPlayLocations } from './statics.js';
import { totalCost } from './costs.js';

import type { Entity, EntityId, GameState, Location, PlayerId, RunePool } from './state.js';
import { entityCard, getPlayer, playerLocation, powerIn } from './state.js';

/** Whether a pool covers a cost (rule 357.1). */
export function canPay(pool: RunePool, cost: Cost): boolean {
  if (pool.energy < cost.energy) {
    return false;
  }
  let spare = 0;
  for (const domain of DOMAINS) {
    const held = powerIn(pool, domain);
    const owed = powerOf(cost, domain);
    if (held < owed) {
      return false;
    }
    spare += held - owed;
  }
  // 135.2.e.5.a: `[A]` is paid by Power of any Domain, so what is left over
  // once every named Domain is covered has to stretch across all of it. Asking
  // each Domain separately would let one surplus pip pay two [A].
  return spare >= anyPowerOf(cost);
}

/** Remove a cost's resources from a pool (rule 444.1). Assumes `canPay`. */
export function payFrom(pool: RunePool, cost: Cost): RunePool {
  const power: Record<Domain, number> = { ...pool.power };
  for (const domain of cost.power) {
    power[domain] -= 1;
  }
  // Which Domain pays an `[A]` is the player's choice (135.2.e.5.a) and the
  // engine makes it for them, in a fixed Domain order. Nothing downstream can
  // observe the difference today: the pool empties at the start of the Main
  // Phase and again in the Ending Phase (316.3, 317.2.e), so a leftover pip of
  // one Domain rather than another survives only until the next spend. Expose
  // the choice when a card cares which Domain is left.
  let owed = anyPowerOf(cost);
  for (const domain of DOMAINS) {
    if (owed === 0) {
      break;
    }
    const spend = Math.min(owed, power[domain]);
    power[domain] -= spend;
    owed -= spend;
  }
  return { energy: pool.energy - cost.energy, power };
}

/**
 * Locations a Unit may be played to (rule 355.2).
 *
 * 355.2.a is the default — the controller's Base, or a Battlefield that
 * controller Controls. 355.2.b lets a card widen it, which is what `card` is
 * for: "You may play me to an open battlefield" makes a Location valid that
 * otherwise is not. Omitting `card` asks the default question, which is what
 * every caller that is not about a specific card wants.
 */
export function validUnitLocations(
  state: GameState,
  player: PlayerId,
  card?: CardDefinition | undefined,
): Location[] {
  const extra = card === undefined ? undefined : extraPlayLocations(state, player, card);
  const locations: Location[] = [playerLocation(player, 'base')];
  state.battlefields.forEach((battlefield, index) => {
    if (battlefield.controller === player) {
      locations.push({ kind: 'battlefield', index });
      return;
    }
    if (extra === undefined || extra.size === 0) {
      return;
    }
    // 170.11.c: "open" is unoccupied *and* uncontrolled — both halves, so a
    // Battlefield an opponent controls with no Units at it is not open.
    const occupied = battlefield.units.length > 0;
    const uncontrolled = battlefield.controller === null;
    if (extra.has('open') && !occupied && uncontrolled) {
      locations.push({ kind: 'battlefield', index });
      return;
    }
    // 170.11.a: "occupied" means a Unit is present; "enemy" is the opponent's
    // Control, which is what makes this distinct from `open`.
    if (extra.has('occupiedEnemy') && occupied && !uncontrolled) {
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
  let anyPower = anyPowerOf(cost);
  for (const additional of costs) {
    if (additional.pay.kind === 'resources') {
      energy += additional.pay.cost.energy;
      power = [...power, ...additional.pay.cost.power];
      // 809.1.c's Deflect cost is `[A]`, so this sum has to carry it or an
      // unaffordable Deflect would read as free.
      anyPower += anyPowerOf(additional.pay.cost);
    }
  }
  return { energy, power, ...(anyPower === 0 ? {} : { anyPower }) };
}

/**
 * The Total Cost of one play, or `undefined` when this player cannot pay it.
 *
 * `chosen` is the Game Object the play would choose, which matters because of
 * 809.1.c: a Deflect taxes a Spell for choosing a particular Unit, so the same
 * card in the same hand has two answers depending on where it is pointed.
 * `legalActions` asks once per target it is about to offer.
 */
export function affordable(
  state: GameState,
  player: PlayerId,
  card: CardDefinition,
  payAdditional: boolean,
  chosen?: EntityId | undefined,
): Cost | undefined {
  const additional = card.abilities?.additionalCosts ?? [];
  const paid = payAdditional ? additional : additional.filter(isMandatory);
  const cost = totalCost(state, player, card, { paidAdditionalCost: payAdditional }, chosen);
  if (cost === undefined) {
    return undefined;
  }
  return canPay(getPlayer(state, player).pool, withResourceCosts(cost, paid)) ? cost : undefined;
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
 *
 * Called with no `chosen`, the cost this checks is a **lower bound** for a card
 * that will go on to choose a target, because the only choice-dependent
 * modifier is 809.1.c's Deflect and it only ever *increases*. `legalActions`
 * re-asks `affordable` per target and drops the ones that stop being payable.
 * A choice-dependent *discount* would need this gate to move rather than that
 * one; the parser produces none, and this is where to look if one appears.
 */
export function playableFromHand(
  state: GameState,
  player: PlayerId,
  timing: { readonly closed: boolean; readonly showdown: boolean },
  /**
   * 809.1.c: the Game Object this play would choose.
   *
   * Deflect makes the same card cost different amounts depending on where it is
   * pointed, so affordability is a question about the (card, target) pair
   * rather than about the card. `legalActions` asks once per target it is about
   * to offer; the plain call with no target answers for a card that chooses
   * nothing, which is almost all of them.
   */
  chosen?: EntityId | undefined,
): { readonly entity: Entity; readonly check: PlayableCheck }[] {
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
      const cost = affordable(state, player, card, payAdditional, chosen);
      if (cost === undefined) {
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
