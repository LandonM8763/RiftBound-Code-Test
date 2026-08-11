/**
 * The Standard Move (rule 144) and the Cleanup that follows a Move (rule 453).
 *
 * Moving is deliberately simple in the rules and should stay simple here:
 * it is instantaneous, does not use the Chain, and cannot be Reacted to
 * (446.3). What it *does* do is apply Contested status, which is the trigger
 * for Showdowns and Combat (190.3.c).
 */
import { hasKeyword } from '@riftbound/cards';

import type { BattlefieldState, EntityId, GameState, Location, PlayerId } from './state.js';
import {
  battlefieldLocation,
  entityCard,
  getEntity,
  getPlayer,
  isClosed,
  sameLocation,
} from './state.js';

/** Rule 144.4: without Ganking, Units move Base to Battlefield or back. */
export function standardMoveDestinations(state: GameState, unit: EntityId): Location[] {
  const entity = getEntity(state, unit);
  const player = entity.controller;

  const toBattlefields = (): Location[] => {
    const destinations: Location[] = [];
    state.battlefields.forEach((battlefield, index) => {
      const from = entity.location;
      if (from.kind === 'battlefield' && from.index === index) {
        return;
      }
      if (isValidDestination(state, player, battlefield)) {
        destinations.push(battlefieldLocation(index));
      }
    });
    return destinations;
  };

  if (entity.location.kind === 'battlefield') {
    // 144.4.b: back to the Base, always.
    const home: Location = { kind: 'player', player, zone: 'base' };
    // 144.4.c / 810.1.b: Ganking is what makes Battlefield to Battlefield a
    // legal Standard Move. 810.1.c.1-3: it only *adds* this destination — it is
    // not an extra Move and has no cost of its own, so the exhaust in
    // `canStandardMove` is still the whole price.
    if (!hasKeyword(entityCard(state, unit).keywords, 'ganking')) {
      return [home];
    }
    return [home, ...toBattlefields()];
  }

  if (entity.location.zone !== 'base') {
    return [];
  }

  // 144.4.a: Base to a Battlefield, subject to the destination being valid.
  return toBattlefields();
}

/**
 * Rule 449.2 / 144.4.a.1: a Unit cannot move to a Battlefield that already has
 * Units belonging to two *other* players. With two players this never bites,
 * but the rule is about seats rather than about 1v1.
 *
 * Moving onto a Battlefield one other player holds is legal and is how Combat
 * starts (452, 461).
 */
function isValidDestination(
  state: GameState,
  player: PlayerId,
  battlefield: BattlefieldState,
): boolean {
  const others = new Set<PlayerId>();
  for (const unit of battlefield.units) {
    const controller = getEntity(state, unit).controller;
    if (controller !== player) {
      others.add(controller);
    }
  }
  return others.size < 2;
}

/**
 * Whether a Unit may take its Standard Move right now.
 *
 * 144.1.a: only during its controller's Main Phase.
 * 144.1.b: never during a Closed State.
 * 144.1.c: never during a Showdown or Combat.
 * 144.2: exhausting the Unit is the cost, so it must be ready.
 */
export function canStandardMove(state: GameState, unit: EntityId): boolean {
  const entity = getEntity(state, unit);

  if (state.phase !== 'main' || isClosed(state)) {
    return false;
  }
  if (state.priority !== entity.controller || state.activePlayer !== entity.controller) {
    return false;
  }
  if (entity.exhausted) {
    return false;
  }
  if (entityCard(state, unit).type !== 'unit') {
    return false;
  }
  return !showdownInProgress(state);
}

/**
 * A Showdown or Combat is pending or in progress somewhere.
 *
 * Contested status is what marks that (190.3.c). Showdowns themselves are not
 * implemented yet; this is the guard that keeps movement honest in the
 * meantime, and the hook they will replace.
 */
export function showdownInProgress(state: GameState): boolean {
  return (
    state.showdown !== null ||
    state.battlefields.some((battlefield) => battlefield.contestedBy !== null)
  );
}

/** Every Unit `player` could move right now, with where it could go. */
export function standardMoves(
  state: GameState,
  player: PlayerId,
): { readonly unit: EntityId; readonly destinations: readonly Location[] }[] {
  const moves: { unit: EntityId; destinations: readonly Location[] }[] = [];

  const candidates: EntityId[] = [...getPlayer(state, player).zones.base];
  for (const battlefield of state.battlefields) {
    for (const unit of battlefield.units) {
      if (getEntity(state, unit).controller === player) {
        candidates.push(unit);
      }
    }
  }

  for (const unit of candidates) {
    if (!canStandardMove(state, unit)) {
      continue;
    }
    const destinations = standardMoveDestinations(state, unit);
    if (destinations.length > 0) {
      moves.push({ unit, destinations });
    }
  }

  return moves;
}

/**
 * Rule 450 / 190.3.a: the destination becomes Contested when a Unit becomes
 * present at a Battlefield its controller does not already control.
 */
export function applyContested(
  state: GameState,
  index: number,
  player: PlayerId,
): GameState {
  const battlefield = state.battlefields[index];
  if (battlefield === undefined) {
    throw new Error(`Unknown battlefield index: ${index}`);
  }
  if (battlefield.contestedBy !== null || battlefield.controller === player) {
    return state;
  }

  const battlefields = state.battlefields.slice();
  battlefields[index] = { ...battlefield, contestedBy: player };
  return { ...state, battlefields };
}

/**
 * The Cleanup after a Move (rule 453), limited to what Control needs.
 *
 * 190.4.c: a player with no Units at a Battlefield loses Control of it in the
 * following Cleanup, unless a Combat or Showdown is ongoing there.
 * 190.3.b.1: Contested status lifts when the contesting player has no Units
 * there and nothing is ongoing.
 *
 * Establishing Control is deliberately absent: rule 190.4 establishes it at the
 * *end of a Showdown or Combat*, so moving onto an empty Battlefield leaves it
 * Contested and awaiting a Showdown rather than handing over Control here.
 */
export function cleanupControl(state: GameState): GameState {
  let changed = false;
  const battlefields = state.battlefields.map((battlefield) => {
    const hasUnits = (player: PlayerId): boolean =>
      battlefield.units.some((unit) => getEntity(state, unit).controller === player);

    let next = battlefield;

    if (next.contestedBy !== null && !hasUnits(next.contestedBy)) {
      next = { ...next, contestedBy: null };
    }
    if (next.controller !== null && !hasUnits(next.controller) && next.contestedBy === null) {
      next = { ...next, controller: null };
    }

    if (next !== battlefield) {
      changed = true;
    }
    return next;
  });

  return changed ? { ...state, battlefields } : state;
}

/** Index of the Battlefield a location refers to, or `undefined` for a Base. */
export function battlefieldIndexOf(location: Location): number | undefined {
  return location.kind === 'battlefield' ? location.index : undefined;
}

export function isSameDestination(a: Location, b: Location): boolean {
  return sameLocation(a, b);
}
