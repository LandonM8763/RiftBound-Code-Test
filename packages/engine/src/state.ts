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
  /** `null` while uncontrolled — moving in is an Open Showdown. */
  readonly controller: PlayerId | null;
  readonly units: readonly EntityId[];
}

/**
 * Turn phases A/B/C/D, then the action phase.
 *
 * A — Awaken:    ready all your cards, including Runes.
 * B — Beginning: score for each Battlefield you are Holding.
 * C — Channel:   Channel Runes from your Rune deck.
 * D — Draw:      draw from your main deck.
 */
export const PHASES = ['awaken', 'beginning', 'channel', 'draw', 'action'] as const;

export type Phase = (typeof PHASES)[number];

export type Outcome =
  | { readonly kind: 'win'; readonly winner: PlayerId }
  | { readonly kind: 'draw'; readonly reason: string };

/**
 * Tunable rule quantities.
 *
 * Values marked UNVERIFIED are placeholders that community sources did not
 * settle. They are configuration rather than constants precisely so that
 * checking them against the official rulebook is a one-line change and not an
 * engine edit. See the open questions in CLAUDE.md.
 */
export interface GameConfig {
  readonly playerCount: number;
  /** Points needed to win. */
  readonly pointsToWin: number;
  /**
   * Battlefields contested in a game. UNVERIFIED: decks contain 3 Battlefields,
   * but how many are in play at once is not established by the sources used.
   * The phrase "conquering both battlefields" implies 2 in a 1v1.
   */
  readonly battlefieldCount: number;
  /** Runes Channelled during phase C. */
  readonly channelPerTurn: number;
  /** Cards drawn during phase D. */
  readonly drawPerTurn: number;
  /** UNVERIFIED: opening hand size is not established by the sources used. */
  readonly openingHandSize: number;
  /**
   * Harness guard, NOT a Riftbound rule. Fuzzing must not hang, so a game that
   * exceeds this many turns ends in a draw. Raise it for real simulations.
   */
  readonly maxTurns: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  playerCount: 2,
  pointsToWin: 8,
  battlefieldCount: 2,
  channelPerTurn: 2,
  drawPerTurn: 1,
  openingHandSize: 5,
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
