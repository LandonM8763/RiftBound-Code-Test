import type { CardDefinition, CardId, CardRegistry } from '@riftbound/cards';

import type { GameEvent } from './events.js';
import { moveEntity } from './mutate.js';
import type { ReduceResult } from './reduce.js';
import { Rng } from './rng.js';
import type {
  BattlefieldState,
  Entity,
  EntityId,
  GameConfig,
  GameState,
  PlayerId,
  PlayerState,
  PlayerZone,
} from './state.js';
import {
  DEFAULT_CONFIG,
  EMPTY_POOL,
  PLAYER_ZONES,
  entityId,
  playerId,
  playerLocation,
} from './state.js';

/**
 * The cards a player brings to a game.
 *
 * The engine does NOT check deck construction — sizes, copy limits, and Domain
 * Identity are format legality, which belongs to the deck package. Keeping that
 * out of here lets engine tests use three-card decks.
 */
export interface DeckList {
  readonly legend: CardId;
  readonly champion: CardId;
  readonly main: readonly CardId[];
  readonly runes: readonly CardId[];
  readonly battlefields: readonly CardId[];
}

export interface CreateGameOptions {
  readonly decks: readonly DeckList[];
  /**
   * Definitions for every card in every deck.
   *
   * The engine needs costs and card types to decide what is playable. The
   * definitions are copied onto the state at setup so reducers stay pure
   * functions of the state and a saved game is self-describing.
   */
  readonly registry: CardRegistry;
  /** Same seed plus same actions must always replay the same game. */
  readonly seed: number | string;
  readonly config?: Partial<GameConfig> | undefined;
}

function mergeConfig(overrides: Partial<GameConfig> | undefined, playerCount: number): GameConfig {
  return {
    playerCount,
    victoryScore: overrides?.victoryScore ?? DEFAULT_CONFIG.victoryScore,
    battlefieldCount: overrides?.battlefieldCount ?? playerCount,
    battlefieldsPerPlayer: overrides?.battlefieldsPerPlayer ?? DEFAULT_CONFIG.battlefieldsPerPlayer,
    channelPerTurn: overrides?.channelPerTurn ?? DEFAULT_CONFIG.channelPerTurn,
    drawPerTurn: overrides?.drawPerTurn ?? DEFAULT_CONFIG.drawPerTurn,
    openingHandSize: overrides?.openingHandSize ?? DEFAULT_CONFIG.openingHandSize,
    mulliganLimit: overrides?.mulliganLimit ?? DEFAULT_CONFIG.mulliganLimit,
    secondPlayerBonusRunes:
      overrides?.secondPlayerBonusRunes ?? DEFAULT_CONFIG.secondPlayerBonusRunes,
    maxTurns: overrides?.maxTurns ?? DEFAULT_CONFIG.maxTurns,
  };
}

function emptyZones(): Record<PlayerZone, EntityId[]> {
  const zones = {} as Record<PlayerZone, EntityId[]>;
  for (const zone of PLAYER_ZONES) {
    zones[zone] = [];
  }
  return zones;
}

/**
 * Deal a new game (rules 110-118).
 *
 * The order of random draws is fixed and must not be reordered casually:
 * shuffle each player's main deck then Rune deck in seat order, then select
 * Battlefields, then determine turn order. Changing that order changes every
 * existing seed's game and invalidates stored golden games.
 *
 * Players are dealt their rule 116 hand of 4 and the game opens in the Mulligan
 * phase (117), where each in turn order chooses what to set aside.
 */
export function createGame(options: CreateGameOptions): ReduceResult {
  const playerCount = options.decks.length;
  if (playerCount < 2) {
    throw new Error(`A game needs at least 2 players, got ${playerCount}`);
  }

  const config = mergeConfig(options.config, playerCount);
  const rng = Rng.fromSeed(options.seed);

  const entities: Record<number, Entity> = {};
  const definitions: Record<string, CardDefinition> = {};
  let nextEntityId = 0;

  const define = (card: CardId): void => {
    if (definitions[card] === undefined) {
      definitions[card] = options.registry.mustGet(card);
    }
  };

  const create = (card: CardId, owner: PlayerId, zone: PlayerZone): EntityId => {
    define(card);
    const id = entityId(nextEntityId);
    nextEntityId += 1;
    entities[id] = {
      id,
      card,
      owner,
      controller: owner,
      location: playerLocation(owner, zone),
      exhausted: false,
      damage: 0,
      mightBonus: 0,
    };
    return id;
  };

  const players: PlayerState[] = options.decks.map((deck, seat) => {
    const id = playerId(seat);
    const zones = emptyZones();
    zones.legendZone.push(create(deck.legend, id, 'legendZone'));
    zones.championZone.push(create(deck.champion, id, 'championZone'));
    for (const card of deck.main) {
      zones.mainDeck.push(create(card, id, 'mainDeck'));
    }
    for (const card of deck.runes) {
      zones.runeDeck.push(create(card, id, 'runeDeck'));
    }
    return { id, points: 0, zones, pool: EMPTY_POOL };
  });

  for (let seat = 0; seat < playerCount; seat += 1) {
    const player = players[seat] as PlayerState;
    players[seat] = {
      ...player,
      zones: {
        ...player.zones,
        mainDeck: rng.shuffle(player.zones.mainDeck),
        runeDeck: rng.shuffle(player.zones.runeDeck),
      },
    };
  }

  const battlefields = placeBattlefields(options.decks, config.battlefieldCount, rng);
  for (const battlefield of battlefields) {
    define(battlefield.card);
  }
  // Rule 115: turn order is determined by any fair random method.
  const startingPlayer = playerId(rng.nextInt(playerCount));

  let state: GameState = {
    config,
    rng: rng.state,
    turn: 1,
    activePlayer: startingPlayer,
    firstPlayer: startingPlayer,
    phase: 'mulligan',
    players,
    battlefields,
    entities,
    nextEntityId,
    definitions,
    chain: [],
    // The Mulligan is a choice, so the First Player acts immediately (117).
    priority: startingPlayer,
    showdown: null,
    mulligansTaken: 0,
    triggersUsed: {},
    phaseStep: 0,
    passes: 0,
    outcome: null,
  };

  // Opening hands come off the already-shuffled decks, so no randomness here.
  for (let seat = 0; seat < playerCount; seat += 1) {
    const id = playerId(seat);
    for (let drawn = 0; drawn < config.openingHandSize; drawn += 1) {
      const top = (state.players[seat] as PlayerState).zones.mainDeck[0];
      if (top === undefined) {
        break;
      }
      state = moveEntity(state, top, playerLocation(id, 'hand'));
    }
  }

  const events: readonly GameEvent[] = [
    { type: 'gameStarted', startingPlayer },
    { type: 'phaseEntered', turn: 1, player: startingPlayer, phase: 'mulligan' },
  ];

  return { state, events };
}

/**
 * Choose the Battlefields contested this game.
 *
 * Rule 485.5: each player randomly selects one of their three Battlefields; the
 * others are removed for the game, and the selected ones are placed
 * simultaneously in the Battlefield Zone. The sanctioned modes all place
 * exactly one Battlefield per player, which is why `battlefieldCount` defaults
 * to the player count.
 *
 * Rule 483.4.b allows a mode to use fewer Battlefields than there are players.
 * No sanctioned mode does, and the rules do not say who would be left out, so
 * rather than invent a rule this refuses the configuration.
 */
function placeBattlefields(
  decks: readonly DeckList[],
  battlefieldCount: number,
  rng: Rng,
): BattlefieldState[] {
  if (battlefieldCount !== decks.length) {
    throw new Error(
      `Battlefield placement is defined as one per player (rule 485.5), but the config asks ` +
        `for ${battlefieldCount} Battlefields across ${decks.length} players`,
    );
  }

  return decks.map((deck, seat) => {
    if (deck.battlefields.length === 0) {
      throw new Error(`Player ${seat} brought no Battlefields`);
    }
    return {
      card: rng.pick(deck.battlefields),
      controller: null,
      units: [],
      contestedBy: null,
      scoredBy: [],
    };
  });
}
