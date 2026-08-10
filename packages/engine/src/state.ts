import { DOMAINS, type CardDefinition, type CardId, type Domain } from '@riftbound/cards';

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
  /**
   * Cards partway through the Process of Play (rule 328).
   *
   * The Chain itself is a single shared Non-Board Zone, ordered by
   * `GameState.chain`; the cards on it sit here so that zone bookkeeping and
   * the invariant checker need no special case.
   */
  'chain',
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

/**
 * Power held in the Rune Pool, by Domain.
 *
 * Every Domain is always present so callers never deal with `undefined`; a
 * Domain the player holds none of simply reads 0.
 */
export type PowerPool = Readonly<Record<Domain, number>>;

/**
 * A player's available Energy and Power (rule 166).
 *
 * Rule 167: every player's Rune Pool empties at the start of each Main Phase
 * and at the end of each turn, and anything unspent is lost.
 */
export interface RunePool {
  readonly energy: number;
  readonly power: PowerPool;
}

export const EMPTY_POWER: PowerPool = Object.freeze(
  Object.fromEntries(DOMAINS.map((domain) => [domain, 0])) as Record<Domain, number>,
);

export const EMPTY_POOL: RunePool = Object.freeze({ energy: 0, power: EMPTY_POWER });

export function powerIn(pool: RunePool, domain: Domain): number {
  return pool.power[domain];
}

export function addEnergyTo(pool: RunePool, amount: number): RunePool {
  return { energy: pool.energy + amount, power: pool.power };
}

export function addPowerTo(pool: RunePool, domain: Domain, amount: number): RunePool {
  return { energy: pool.energy, power: { ...pool.power, [domain]: pool.power[domain] + amount } };
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly points: number;
  /** Ordered entity lists. Order is meaningful for decks. */
  readonly zones: Readonly<Record<PlayerZone, readonly EntityId[]>>;
  readonly pool: RunePool;
}

/**
 * An item on the Chain (rules 328-329).
 *
 * Items are Pending while the Process of Play is still running for them, and
 * become Finalized at the Check Legality step (329.2). This engine completes
 * that process atomically, so an item is only ever observed Finalized — the
 * flag exists so the distinction survives when Pending windows arrive.
 */
export interface ChainItem {
  readonly entity: EntityId;
  readonly controller: PlayerId;
  readonly pending: boolean;
}

/**
 * An open Showdown (rule 341).
 *
 * A Showdown is a Window of Opportunity: players act in an alternating fashion,
 * passing Focus rather than Priority, until everyone passes in sequence (347.2)
 * and it Closes (348).
 */
export interface ShowdownState {
  readonly battlefield: number;
  /** Rule 345: the player who applied Contested status gains Focus first. */
  readonly focus: PlayerId;
  /** Consecutive Focus passes; equal to the player count ends the Showdown. */
  readonly passes: number;
  /** Rule 344.1: a Showdown with opposing Units present is a Combat Showdown. */
  readonly combat: boolean;
  /** Rule 464.2.c.1: whoever applied Contested. `null` outside Combat. */
  readonly attacker: PlayerId | null;
  /** Rule 464.2.c.2: the player who did not apply Contested. */
  readonly defender: PlayerId | null;
}

export interface BattlefieldState {
  readonly card: CardId;
  /** `null` while Uncontrolled (rule 466.5.b). */
  readonly controller: PlayerId | null;
  readonly units: readonly EntityId[];
  /**
   * Who applied the Contested status, or `null` if the Battlefield is not
   * Contested (rule 190.3.a).
   *
   * Contested is a temporary status applied when a Unit becomes present at a
   * Battlefield its controller does not control. It is what tells the engine a
   * Showdown or Combat is due (190.3.c), and it persists until Control is
   * established or the contesting player has no Units left there (190.3.b).
   */
  readonly contestedBy: PlayerId | null;
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
  /**
   * Card definitions for every card in the game, denormalised at setup.
   *
   * The engine needs costs and card types to decide what may be played, but
   * keeping a `CardRegistry` on the state would make it unserializable and
   * would couple every reducer to card data. Copying the definitions in once
   * keeps `reduce` a pure function of the state alone, and keeps a saved game
   * self-describing.
   */
  readonly definitions: Readonly<Record<string, CardDefinition>>;
  /**
   * The Chain (rule 327). Empty means the turn is in an Open State (331.2).
   * The last element is the top: the next item to resolve.
   */
  readonly chain: readonly ChainItem[];
  /** Who may take Discretionary Actions right now (rule 312). */
  readonly priority: PlayerId | null;
  /** The open Showdown, if any (rule 341). */
  readonly showdown: ShowdownState | null;
  /** Consecutive passes since the last Chain item was added or resolved. */
  readonly passes: number;
  /** `null` while the game is still running. */
  readonly outcome: Outcome | null;
}

/** Rule 331: a Chain existing puts the turn in a Closed State. */
export function isClosed(state: GameState): boolean {
  return state.chain.length > 0;
}

/** Rule 343.1: a Showdown or Combat in progress puts the turn in a Showdown State. */
export function isShowdown(state: GameState): boolean {
  return state.showdown !== null;
}

export function definitionOf(state: GameState, card: CardId): CardDefinition {
  const definition = state.definitions[card];
  if (definition === undefined) {
    throw new Error(`No card definition for ${card}`);
  }
  return definition;
}

/** The definition of the card an entity is an instance of. */
export function entityCard(state: GameState, id: EntityId): CardDefinition {
  return definitionOf(state, getEntity(state, id).card);
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
