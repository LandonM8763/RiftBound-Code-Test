export { Rng } from './rng.js';
export type { RngState } from './rng.js';

export {
  DEFAULT_CONFIG,
  EMPTY_POOL,
  EMPTY_POWER,
  HIDDEN_ZONES,
  PHASES,
  PLAYER_ZONES,
  battlefieldLocation,
  entityId,
  getEntity,
  getPlayer,
  addEnergyTo,
  addPowerTo,
  definitionOf,
  entityCard,
  isClosed,
  isOver,
  isShowdown,
  nextPlayer,
  powerIn,
  playerId,
  playerLocation,
  sameLocation,
  zoneOf,
} from './state.js';
export type {
  BattlefieldState,
  ChainItem,
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
  PowerPool,
  RunePool,
  ShowdownState,
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

export { executeEffect, isValidTarget, legalTargets } from './effects.js';

export {
  assignDamage,
  combatResult,
  combatSides,
  hasLethalDamage,
  lethalRemaining,
  mightOf,
  sumMight,
} from './combat.js';
export type { CombatResult, CombatSides } from './combat.js';

export {
  applyContested,
  canStandardMove,
  cleanupControl,
  showdownInProgress,
  standardMoveDestinations,
  standardMoves,
} from './move.js';

export {
  canPay,
  payFrom,
  playableFromHand,
  timingAllows,
  totalCost,
  validUnitLocations,
} from './play.js';

export { InvariantError, checkInvariants } from './invariants.js';

export { entitiesAt, moveEntity } from './mutate.js';
