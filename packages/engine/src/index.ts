export { Rng } from './rng.js';
export type { RngState } from './rng.js';

export {
  DEFAULT_CONFIG,
  HIDDEN_ZONES,
  PHASES,
  PLAYER_ZONES,
  battlefieldLocation,
  entityId,
  getEntity,
  getPlayer,
  isOver,
  nextPlayer,
  playerId,
  playerLocation,
  sameLocation,
  zoneOf,
} from './state.js';
export type {
  BattlefieldState,
  Entity,
  EntityId,
  GameConfig,
  GameState,
  Location,
  Outcome,
  Phase,
  PlayerId,
  PlayerState,
  PlayerZone,
} from './state.js';

export { IllegalActionError } from './actions.js';
export type { Action, ActionType } from './actions.js';

export type { GameEvent } from './events.js';

export { createGame } from './setup.js';
export type { CreateGameOptions, DeckList } from './setup.js';

export { reduce } from './reduce.js';
export type { ReduceResult } from './reduce.js';

export { currentLegalActions, legalActions } from './legal.js';

export { knownCardCount, observe, opponentsOf, pointsOf } from './view.js';
export type { BattlefieldView, EntityView, GameView, PlayerView } from './view.js';

export { InvariantError, checkInvariants } from './invariants.js';

export { entitiesAt, moveEntity } from './mutate.js';
