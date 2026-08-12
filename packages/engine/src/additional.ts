/**
 * Paying Additional Costs (rule 356.2, 357.2).
 *
 * Two questions, and keeping them separate is the whole point:
 *
 * - **Can it be paid?** Asked before the card may be played at all. Rule
 *   356.2.a makes a Mandatory cost part of what playing the card *is*, so a
 *   cost that cannot be paid makes the card unplayable — the same shape as
 *   422.3, which stops a Discard that cannot be performed.
 * - **Pay it.** Step 357.2, after the Total Cost is settled.
 *
 * A cost that could be added to the total and then not paid would leave the
 * game in a state the rules have no name for, which is why payability is
 * proven first rather than discovered halfway through.
 */
import { isMandatory, type AdditionalCost, type CostPayment } from '@riftbound/cards';

import { canPay, payFrom } from './play.js';
import { entityCard, getPlayer, type EntityId, type GameState, type PlayerId } from './state.js';

/** Can `player` pay this non-standard cost right now? */
export function canPayAdditional(
  state: GameState,
  player: PlayerId,
  payment: CostPayment,
  /**
   * The card being played, which cannot pay its own cost with itself: rule
   * 353 step 1 moves it out of the hand before 357.2 pays anything.
   */
  playing?: EntityId,
): boolean {
  const seat = getPlayer(state, player);
  switch (payment.kind) {
    case 'resources':
      return canPay(seat.pool, payment.cost);

    // 422.4 discards as many as possible, but as a *cost* it has to be payable
    // in full — a partly paid cost is not a paid cost.
    case 'discard':
      return seat.zones.hand.filter((card) => card !== playing).length >= payment.count;

    case 'spendBuff':
      // 702.2.b.2: only from a Unit its controller controls.
      return buffedUnit(state, player) !== undefined;

    case 'exhaustLegend': {
      const legend = seat.zones.legendZone[0];
      return legend !== undefined && state.entities[legend]?.exhausted === false;
    }

    case 'kill':
      return killable(state, player, payment.what) !== undefined;

    default: {
      const exhaustive: never = payment;
      throw new Error(`Unknown cost payment: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Every Additional Cost that must be paid, and whether the optional ones can be.
 *
 * Rule 356.2 applies additional costs "in any order", so they are independent
 * and this reports on each rather than folding them together.
 */
export function additionalCostState(
  state: GameState,
  player: PlayerId,
  costs: readonly AdditionalCost[],
  playing?: EntityId,
): { readonly mandatoryPayable: boolean; readonly optionalPayable: boolean; readonly hasOptional: boolean } {
  let mandatoryPayable = true;
  let optionalPayable = true;
  let hasOptional = false;

  for (const cost of costs) {
    const payable = canPayAdditional(state, player, cost.pay, playing);
    if (isMandatory(cost)) {
      mandatoryPayable &&= payable;
    } else {
      hasOptional = true;
      optionalPayable &&= payable;
    }
  }
  return { mandatoryPayable, optionalPayable, hasOptional };
}

/**
 * Perform the payment (357.2).
 *
 * SIMPLIFICATION: where a payment names a *kind* of thing rather than a
 * specific one — "kill a friendly unit", "spend a buff" — the rules let the
 * paying player choose which. That choice is not exposed; this picks
 * deterministically, exactly as `effects.ts` does for Discard (422.1.a) and
 * `combat.ts` does for damage assignment order. Making it a real choice needs
 * the same sub-action protocol all three are waiting on.
 */
export function payAdditional(
  state: GameState,
  player: PlayerId,
  payment: CostPayment,
  /** The card being played — it can never pay its own cost with itself. */
  playing: EntityId,
  kill: (state: GameState, unit: EntityId) => GameState,
  discard: (state: GameState, player: PlayerId, cards: readonly EntityId[]) => GameState,
): GameState {
  const seat = getPlayer(state, player);
  switch (payment.kind) {
    case 'resources':
      return withPool(state, player, payFrom(seat.pool, payment.cost));

    case 'discard': {
      // The played card is still in hand at 357.2 in this engine — 353 step 1
      // moves it out at Announce, which happens atomically with the rest here —
      // so it is excluded explicitly. A card paying its own cost with itself
      // would leave the cost unpaid and the card played.
      const chosen = seat.zones.hand
        .filter((card) => card !== playing)
        .slice(0, Math.max(0, payment.count));
      return chosen.length < payment.count ? state : discard(state, player, chosen);
    }

    case 'spendBuff': {
      const unit = buffedUnit(state, player);
      return unit === undefined ? state : withBuffs(state, unit, -1);
    }

    case 'exhaustLegend': {
      const legend = seat.zones.legendZone[0];
      return legend === undefined ? state : withExhausted(state, legend, true);
    }

    case 'kill': {
      const victim = killable(state, player, payment.what);
      return victim === undefined ? state : kill(state, victim);
    }

    default: {
      const exhaustive: never = payment;
      throw new Error(`Unknown cost payment: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** The first Unit this player controls that carries a Buff (702.2.b.2). */
function buffedUnit(state: GameState, player: PlayerId): EntityId | undefined {
  return boardEntities(state, player).find((entity) => (state.entities[entity]?.buffs ?? 0) > 0);
}

/** The first thing of the named type this player controls on the Board. */
function killable(
  state: GameState,
  player: PlayerId,
  what: 'unit' | 'gear',
): EntityId | undefined {
  return boardEntities(state, player).find((entity) => entityCard(state, entity).type === what);
}

function boardEntities(state: GameState, player: PlayerId): EntityId[] {
  const found: EntityId[] = [];
  const seat = state.players[player];
  if (seat !== undefined) {
    found.push(...seat.zones.base);
  }
  for (const battlefield of state.battlefields) {
    for (const unit of battlefield.units) {
      if (state.entities[unit]?.controller === player) {
        found.push(unit);
      }
    }
  }
  return found;
}

function withPool(state: GameState, player: PlayerId, pool: ReturnType<typeof payFrom>): GameState {
  return {
    ...state,
    players: state.players.map((seat) => (seat.id === player ? { ...seat, pool } : seat)),
  };
}

function withBuffs(state: GameState, unit: EntityId, delta: number): GameState {
  const entity = state.entities[unit];
  if (entity === undefined) {
    return state;
  }
  return {
    ...state,
    entities: { ...state.entities, [unit]: { ...entity, buffs: Math.max(0, entity.buffs + delta) } },
  };
}

function withExhausted(state: GameState, entity: EntityId, exhausted: boolean): GameState {
  const current = state.entities[entity];
  if (current === undefined) {
    return state;
  }
  return { ...state, entities: { ...state.entities, [entity]: { ...current, exhausted } } };
}
