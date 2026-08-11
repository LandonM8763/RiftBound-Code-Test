/**
 * Structural checks on a game state.
 *
 * The zone lists and each entity's `location` are two representations of the
 * same fact, kept in step by `moveEntity`. This is the assertion that they have
 * not drifted. Run it after every action when fuzzing: a random agent that
 * reaches an inconsistent state has found an engine bug, and this turns that
 * into an immediate, located failure instead of a confusing one later.
 */
import type { EntityId, GameState, Location } from './state.js';
import { PLAYER_ZONES, battlefieldLocation, playerLocation, sameLocation } from './state.js';

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

function describe(location: Location): string {
  return location.kind === 'player'
    ? `player ${location.player} ${location.zone}`
    : `battlefield ${location.index}`;
}

export function checkInvariants(state: GameState): void {
  const placement = new Map<EntityId, Location>();

  const record = (id: EntityId, location: Location): void => {
    const existing = placement.get(id);
    if (existing !== undefined) {
      throw new InvariantError(
        `Entity ${id} appears in two places: ${describe(existing)} and ${describe(location)}`,
      );
    }
    placement.set(id, location);
  };

  for (const player of state.players) {
    for (const zone of PLAYER_ZONES) {
      for (const id of player.zones[zone]) {
        record(id, playerLocation(player.id, zone));
      }
    }
  }

  state.battlefields.forEach((battlefield, index) => {
    for (const id of battlefield.units) {
      record(id, battlefieldLocation(index));
    }
  });

  for (const [key, entity] of Object.entries(state.entities)) {
    if (Number(key) !== entity.id) {
      throw new InvariantError(`Entity table key ${key} does not match entity id ${entity.id}`);
    }

    const actual = placement.get(entity.id);
    if (actual === undefined) {
      throw new InvariantError(
        `Entity ${entity.id} claims to be at ${describe(entity.location)} but is in no zone list`,
      );
    }
    if (!sameLocation(actual, entity.location)) {
      throw new InvariantError(
        `Entity ${entity.id} is in ${describe(actual)} but records ${describe(entity.location)}`,
      );
    }
    if (entity.damage < 0) {
      throw new InvariantError(`Entity ${entity.id} has negative damage`);
    }
    // Rule 702.3: there can only be one Buff on a Unit at a time.
    if (entity.buffs < 0 || entity.buffs > 1) {
      throw new InvariantError(
        `Entity ${entity.id} carries ${entity.buffs} Buffs; rule 702.3 allows at most one`,
      );
    }
    if (entity.id >= state.nextEntityId) {
      throw new InvariantError(`Entity ${entity.id} is at or beyond nextEntityId`);
    }
  }

  const entityCount = Object.keys(state.entities).length;
  if (placement.size !== entityCount) {
    throw new InvariantError(
      `${placement.size} entities are in zones but the entity table holds ${entityCount}`,
    );
  }

  state.players.forEach((player, seat) => {
    if (player.id !== seat) {
      throw new InvariantError(`Player at seat ${seat} records id ${player.id}`);
    }
    if (player.points < 0) {
      throw new InvariantError(`Player ${player.id} has negative points`);
    }
    // Rule 730.2 only ever reduces XP by what is there to spend.
    if (player.xp < 0) {
      throw new InvariantError(`Player ${player.id} has negative XP`);
    }
  });

  if (state.activePlayer < 0 || state.activePlayer >= state.players.length) {
    throw new InvariantError(`Active player ${state.activePlayer} is not a seat`);
  }

  // Only Beginning (315.2) and Ending (317) have a step that can be held open;
  // a non-zero counter anywhere else means a phase resumed into the wrong body.
  if (state.phaseStep !== 0 && state.phase !== 'beginning' && state.phase !== 'ending') {
    throw new InvariantError(
      `Phase ${state.phase} recorded step ${state.phaseStep}, but it has only one step`,
    );
  }
  if (state.phaseStep < 0) {
    throw new InvariantError(`Negative phase step ${state.phaseStep}`);
  }

  // A phase held open must have something to wait for. Once the Chain drains,
  // `resolvePhase` is what resumes it, so nobody may hold Priority meanwhile.
  if (state.phaseStep > 0 && state.chain.length === 0 && state.priority !== null) {
    throw new InvariantError(
      `Phase ${state.phase} is held at step ${state.phaseStep} with an empty Chain, ` +
        `but player ${state.priority} holds Priority`,
    );
  }

  for (const battlefield of state.battlefields) {
    const controller = battlefield.controller;
    if (controller !== null && (controller < 0 || controller >= state.players.length)) {
      throw new InvariantError(`Battlefield controller ${controller} is not a seat`);
    }
  }

  if (state.turn < 1) {
    throw new InvariantError(`Turn counter is ${state.turn}`);
  }
}
