import type { CardId } from '@riftbound/cards';

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
import { DEFAULT_CONFIG, PLAYER_ZONES, entityId, playerId, playerLocation } from './state.js';

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
  /** Same seed plus same actions must always replay the same game. */
  readonly seed: number | string;
  readonly config?: Partial<GameConfig> | undefined;
}

function mergeConfig(overrides: Partial<GameConfig> | undefined, playerCount: number): GameConfig {
  return {
    playerCount,
    pointsToWin: overrides?.pointsToWin ?? DEFAULT_CONFIG.pointsToWin,
    battlefieldCount: overrides?.battlefieldCount ?? DEFAULT_CONFIG.battlefieldCount,
    channelPerTurn: overrides?.channelPerTurn ?? DEFAULT_CONFIG.channelPerTurn,
    drawPerTurn: overrides?.drawPerTurn ?? DEFAULT_CONFIG.drawPerTurn,
    openingHandSize: overrides?.openingHandSize ?? DEFAULT_CONFIG.openingHandSize,
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
 * Deal a new game.
 *
 * The order of random draws is fixed and must not be reordered casually:
 * shuffle each player's main deck then Rune deck in seat order, then choose the
 * starting player. Changing that order changes every existing seed's game, and
 * invalidates stored golden games.
 *
 * UNVERIFIED: which player goes first is chosen at random here, and no
 * first-turn adjustment (skipping the draw, for instance) is applied.
 */
export function createGame(options: CreateGameOptions): ReduceResult {
  const playerCount = options.decks.length;
  if (playerCount < 2) {
    throw new Error(`A game needs at least 2 players, got ${playerCount}`);
  }

  const config = mergeConfig(options.config, playerCount);
  const rng = Rng.fromSeed(options.seed);

  const entities: Record<number, Entity> = {};
  let nextEntityId = 0;

  const create = (card: CardId, owner: PlayerId, zone: PlayerZone): EntityId => {
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
    return { id, points: 0, zones };
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

  const battlefields = placeBattlefields(options.decks, config.battlefieldCount);
  const startingPlayer = playerId(rng.nextInt(playerCount));

  let state: GameState = {
    config,
    rng: rng.state,
    turn: 1,
    activePlayer: startingPlayer,
    phase: 'awaken',
    players,
    battlefields,
    entities,
    nextEntityId,
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
    { type: 'phaseEntered', turn: 1, player: startingPlayer, phase: 'awaken' },
  ];

  return { state, events };
}

/**
 * Choose the Battlefields contested this game, round-robin across seats.
 *
 * UNVERIFIED: each deck contains 3 Battlefields, but how many end up in play
 * and who picks them is not established by the sources used. This takes them in
 * seat order until `battlefieldCount` is filled.
 */
function placeBattlefields(
  decks: readonly DeckList[],
  battlefieldCount: number,
): BattlefieldState[] {
  const battlefields: BattlefieldState[] = [];
  const rounds = Math.max(...decks.map((deck) => deck.battlefields.length));

  for (let round = 0; round < rounds && battlefields.length < battlefieldCount; round += 1) {
    for (let seat = 0; seat < decks.length && battlefields.length < battlefieldCount; seat += 1) {
      const card = (decks[seat] as DeckList).battlefields[round];
      if (card !== undefined) {
        battlefields.push({ card, controller: null, units: [] });
      }
    }
  }

  if (battlefields.length < battlefieldCount) {
    throw new Error(
      `Need ${battlefieldCount} Battlefields in play but the decks supply only ${battlefields.length}`,
    );
  }

  return battlefields;
}
