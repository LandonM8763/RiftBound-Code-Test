/**
 * Internal state update helpers.
 *
 * Every function here returns a new state and leaves its input untouched.
 * Updates rebuild only the branches they touch, so unchanged players, zones,
 * and entities are shared by reference rather than deep-copied — the property
 * search agents depend on when they explore thousands of futures.
 */
import type {
  Entity,
  EntityId,
  GameState,
  Location,
  PlayerId,
  PlayerState,
} from './state.js';
import { getEntity, getPlayer, sameLocation } from './state.js';

export type DeckEnd = 'top' | 'bottom';

export function withPlayer(
  state: GameState,
  id: PlayerId,
  update: (player: PlayerState) => PlayerState,
): GameState {
  const players = state.players.slice();
  players[id] = update(getPlayer(state, id));
  return { ...state, players };
}

export function withEntity(
  state: GameState,
  id: EntityId,
  update: (entity: Entity) => Entity,
): GameState {
  return {
    ...state,
    entities: { ...state.entities, [id]: update(getEntity(state, id)) },
  };
}

/** The entity list at a location, in order. Index 0 is the top of a deck. */
export function entitiesAt(state: GameState, location: Location): readonly EntityId[] {
  if (location.kind === 'player') {
    return getPlayer(state, location.player).zones[location.zone];
  }
  const battlefield = state.battlefields[location.index];
  if (battlefield === undefined) {
    throw new Error(`Unknown battlefield index: ${location.index}`);
  }
  return battlefield.units;
}

function withEntitiesAt(
  state: GameState,
  location: Location,
  update: (ids: readonly EntityId[]) => readonly EntityId[],
): GameState {
  if (location.kind === 'player') {
    const zone = location.zone;
    return withPlayer(state, location.player, (player) => ({
      ...player,
      zones: { ...player.zones, [zone]: update(player.zones[zone]) },
    }));
  }

  const battlefields = state.battlefields.slice();
  const battlefield = battlefields[location.index];
  if (battlefield === undefined) {
    throw new Error(`Unknown battlefield index: ${location.index}`);
  }
  battlefields[location.index] = { ...battlefield, units: update(battlefield.units) };
  return { ...state, battlefields };
}

/**
 * Move an entity to a new location.
 *
 * The entity's `location` and the owning zone list are updated together; they
 * are the one place these two representations can drift apart, so nothing else
 * may write either of them directly.
 */
export function moveEntity(
  state: GameState,
  id: EntityId,
  to: Location,
  end: DeckEnd = 'bottom',
): GameState {
  const entity = getEntity(state, id);
  const from = entity.location;

  let next = withEntitiesAt(state, from, (ids) => ids.filter((candidate) => candidate !== id));

  // Re-read: `from` and `to` may be the same list, and the removal above must
  // be visible before the insert.
  next = withEntitiesAt(next, to, (ids) => (end === 'top' ? [id, ...ids] : [...ids, id]));

  return withEntity(next, id, (current) => ({ ...current, location: to }));
}

/** Take the entity at the top of a zone without removing it. */
export function peekTop(state: GameState, location: Location): EntityId | undefined {
  return entitiesAt(state, location)[0];
}

export function addPoints(state: GameState, player: PlayerId, amount: number): GameState {
  return withPlayer(state, player, (current) => ({ ...current, points: current.points + amount }));
}

export function isAt(state: GameState, id: EntityId, location: Location): boolean {
  return sameLocation(getEntity(state, id).location, location);
}
