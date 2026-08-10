import type { CardId } from '@riftbound/cards';

import type { RngState } from './rng.js';

/** Seat index. Never assume there are exactly two. */
export type PlayerId = number & { readonly __brand: 'PlayerId' };
/** Identity of a single card instance in a game. */
export type EntityId = number & { readonly __brand: 'EntityId' };

export function playerId(value: number): PlayerId {
  return value as PlayerId;
}

export function entityId(value: number): EntityId {
  return value as EntityId;
}

/**
 * Zones belonging to a player.
 *
 * `runes` holds Runes that have been Channelled out of the Rune deck and are in
 * play, ready or exhausted. `base` holds that player's Units that are not at a
 * Battlefield.
 */
export const PLAYER_ZONES = [
  'mainDeck',
  'hand',
  'runeDeck',
  'runes',
  'base',
  'trash',
  'legendZone',
  'championZone',
] as const;

export type PlayerZone = (typeof PLAYER_ZONES)[number];

/** Zones whose contents are hidden from every player, including their owner. */
export const HIDDEN_ZONES: readonly PlayerZone[] = ['mainDeck', 'runeDeck'];

/** Where an entity currently is. */
export type Location =
  | { readonly kind: 'player'; readonly player: PlayerId; readonly zone: PlayerZone }
  | { readonly kind: 'battlefield'; readonly index: number };

export function playerLocation(player: PlayerId, zone: PlayerZone): Location {
  return { kind: 'player', player, zone };
}

export function battlefieldLocation(index: number): Location {
  return { kind: 'battlefield', index };
}

export function sameLocation(a: Location, b: Location): boolean {
  if (a.kind === 'player' && b.kind === 'player') {
    return a.player === b.player && a.zone === b.zone;
  }
  if (a.kind === 'battlefield' && b.kind === 'battlefield') {
    return a.index === b.index;
  }
  return false;
}

/** A single card instance. */
export interface Entity {
  readonly id: EntityId;
  readonly card: CardId;
  /** Whose deck this came from. Fixed for the whole game. */
  readonly owner: PlayerId;
  /** Who controls it now. May differ from `owner` once effects exist. */
  readonly controller: PlayerId;
  readonly location: Location;
  /** Exhausted cards are turned sideways; Awaken readies them. */
  readonly exhausted: boolean;
  /** Damage marked on a Unit. A Unit is destroyed once this reaches its Might. */
  readonly damage: number;
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly points: number;
  /** Ordered entity lists. Order is meaningful for decks. */
  readonly zones: Readonly<Record<PlayerZone, readonly EntityId[]>>;
}

export interface BattlefieldState {
  readonly card: CardId;
  /** `null` while Uncontrolled (rule 466.5.b). */
  readonly controller: PlayerId | null;
  readonly units: readonly EntityId[];
  /**
   * Players who have already Scored this Battlefield this turn.
   *
   * Rule 470: a player may only Score a given Battlefield once per turn, by
   * either method, so Conquering a Battlefield you already Held this turn
   * scores nothing.
   */
  readonly scoredBy: readonly PlayerId[];
}

/**
 * The phases of a turn (rule 314).
 *
 * Start of Turn is four phases:
 *   Awaken    — ready everything you control (315.1)
 *   Beginning — Hold every Battlefield you Control (315.2)
 *   Channel   — Channel 2 Runes (315.3)
 *   Draw      — draw 1 (315.4)
 * then the Main Phase (316), then the Ending Phase (317).
 *
 * The A/B/C/D naming used by community guides maps onto the four Start of Turn
 * phases; the rulebook names them, and the rulebook is the naming authority.
 */
export const PHASES = ['awaken', 'beginning', 'channel', 'draw', 'main', 'ending'] as const;

export type Phase = (typeof PHASES)[number];

export type Outcome =
  | { readonly kind: 'win'; readonly winner: PlayerId }
  | { readonly kind: 'draw'; readonly reason: string };

/**
 * The variables a Mode of Play must define (rule 483), plus one harness guard.
 *
 * Defaults are the sanctioned 1v1 Duel mode (rule 485). Every value here is
 * taken from the official Core Rules, RUP4 of 2026-07-16, with the rule number
 * cited; none of them is a guess any more.
 */
export interface GameConfig {
  /** Rule 483.1. */
  readonly playerCount: number;
  /** Rule 483.3 / 485.3: the point total needed to win. 8 in the Duel mode. */
  readonly victoryScore: number;
  /** Rule 483.4 / 485.4: Battlefields in play. 2 in the Duel mode. */
  readonly battlefieldCount: number;
  /** Rule 485.4.a: Battlefields each player brings, of which one is used. */
  readonly battlefieldsPerPlayer: number;
  /** Rule 315.3.b: the Turn Player Channels 2 Runes in the Channel Phase. */
  readonly channelPerTurn: number;
  /** Rule 315.4.b: the Turn Player draws 1 in the Draw Phase. */
  readonly drawPerTurn: number;
  /** Rule 116: each player draws 4. */
  readonly openingHandSize: number;
  /** Rule 117.1: a player may set aside up to 2 cards when they Mulligan. */
  readonly mulliganLimit: number;
  /**
   * Rule 485.7: the player going second Channels this many extra Runes during
   * their first Channel Phase of the game.
   */
  readonly secondPlayerBonusRunes: number;
  /**
   * Harness guard, NOT a Riftbound rule. Fuzzing must not hang, so a game that
   * exceeds this many turns ends in a draw. Raise it for real simulations.
   *
   * Real games terminate on their own: an empty Main Deck causes a Burn Out
   * (rule 431), which hands an opponent a point, repeatedly, until someone
   * reaches the Victory Score.
   */
  readonly maxTurns: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  playerCount: 2,
  victoryScore: 8,
  battlefieldCount: 2,
  battlefieldsPerPlayer: 3,
  channelPerTurn: 2,
  drawPerTurn: 1,
  openingHandSize: 4,
  mulliganLimit: 2,
  secondPlayerBonusRunes: 1,
  maxTurns: 200,
};

/**
 * The complete game state.
 *
 * Plain readonly data throughout: it serializes for golden-game tests, and
 * reducers rebuild it with structural sharing rather than deep cloning.
 */
export interface GameState {
  readonly config: GameConfig;
  /** Position of the seeded PRNG. Advancing it is part of the state. */
  readonly rng: RngState;
  /** 1-based; increments each time the active player changes. */
  readonly turn: number;
  readonly activePlayer: PlayerId;
  /** Rule 115.1.b.1: the player who became the Turn Player first. */
  readonly firstPlayer: PlayerId;
  readonly phase: Phase;
  readonly players: readonly PlayerState[];
  readonly battlefields: readonly BattlefieldState[];
  readonly entities: Readonly<Record<number, Entity>>;
  readonly nextEntityId: number;
  /** `null` while the game is still running. */
  readonly outcome: Outcome | null;
}

export function isOver(state: GameState): boolean {
  return state.outcome !== null;
}

export function getEntity(state: GameState, id: EntityId): Entity {
  const entity = state.entities[id];
  if (entity === undefined) {
    throw new Error(`Unknown entity id: ${id}`);
  }
  return entity;
}

export function getPlayer(state: GameState, id: PlayerId): PlayerState {
  const player = state.players[id];
  if (player === undefined) {
    throw new Error(`Unknown player id: ${id}`);
  }
  return player;
}

export function zoneOf(state: GameState, player: PlayerId, zone: PlayerZone): readonly EntityId[] {
  return getPlayer(state, player).zones[zone];
}

/** Seat that acts after `player`. */
export function nextPlayer(state: GameState, player: PlayerId): PlayerId {
  return playerId((player + 1) % state.players.length);
}
