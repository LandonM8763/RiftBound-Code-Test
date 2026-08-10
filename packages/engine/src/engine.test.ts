import {
  makeBattlefield,
  makeLegend,
  makeRune,
  makeUnit,
} from '@riftbound/cards/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { IllegalActionError, type Action } from './actions.js';
import { checkInvariants } from './invariants.js';
import { currentLegalActions, legalActions } from './legal.js';
import { reduce } from './reduce.js';
import { Rng } from './rng.js';
import { createGame, type DeckList } from './setup.js';
import {
  type GameState,
  type Phase,
  type PlayerId,
  isOver,
  playerId,
  zoneOf,
} from './state.js';

function testDeck(mainSize = 12, runeSize = 8): DeckList {
  return {
    legend: makeLegend(['fury', 'calm']).id,
    champion: makeUnit(3, ['fury'], { champion: true }).id,
    main: Array.from({ length: mainSize }, () => makeUnit(2, ['fury']).id),
    runes: Array.from({ length: runeSize }, () => makeRune('fury').id),
    battlefields: Array.from({ length: 3 }, () => makeBattlefield().id),
  };
}

function newGame(seed: string | number = 'test', config?: Parameters<typeof createGame>[0]['config']) {
  return createGame({ decks: [testDeck(), testDeck()], seed, ...(config ? { config } : {}) });
}

/** Drive the game with the first legal action until it reaches `phase`. */
function runTo(state: GameState, phase: Phase): GameState {
  let current = state;
  for (let guard = 0; guard < 200; guard += 1) {
    if (current.phase === phase || isOver(current)) {
      return current;
    }
    const action = currentLegalActions(current)[0];
    if (action === undefined) {
      return current;
    }
    current = reduce(current, action).state;
  }
  throw new Error(`Never reached phase ${phase}`);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) {
      deepFreeze(inner);
    }
    Object.freeze(value);
  }
  return value;
}

describe('createGame', () => {
  let start: GameState;

  beforeEach(() => {
    start = newGame().state;
  });

  it('starts on turn 1 in the Awaken phase with no outcome', () => {
    expect(start.turn).toBe(1);
    expect(start.phase).toBe('awaken');
    expect(start.outcome).toBeNull();
    expect(isOver(start)).toBe(false);
  });

  it('produces a structurally consistent state', () => {
    expect(() => checkInvariants(start)).not.toThrow();
  });

  it('deals an opening hand to every player off the top of the deck', () => {
    const { openingHandSize } = start.config;
    for (const player of start.players) {
      expect(player.zones.hand).toHaveLength(openingHandSize);
      expect(player.zones.mainDeck).toHaveLength(12 - openingHandSize);
    }
  });

  it('puts the Legend and Champion in their zones', () => {
    for (const player of start.players) {
      expect(player.zones.legendZone).toHaveLength(1);
      expect(player.zones.championZone).toHaveLength(1);
    }
  });

  it('places the configured number of uncontrolled Battlefields', () => {
    expect(start.battlefields).toHaveLength(start.config.battlefieldCount);
    for (const battlefield of start.battlefields) {
      expect(battlefield.controller).toBeNull();
      expect(battlefield.units).toEqual([]);
    }
  });

  it('starts both players on zero points', () => {
    expect(start.players.map((player) => player.points)).toEqual([0, 0]);
  });

  it('rejects a game with fewer than two players', () => {
    expect(() => createGame({ decks: [testDeck()], seed: 1 })).toThrow(/at least 2 players/);
  });

  it('rejects decks that cannot supply the required Battlefields', () => {
    const thin: DeckList = { ...testDeck(), battlefields: [] };
    expect(() => createGame({ decks: [thin, thin], seed: 1 })).toThrow(/Battlefields/);
  });
});

describe('determinism', () => {
  // The same decks must be reused across runs: the fixture builder mints a
  // fresh card id per call, so rebuilding them would vary the input rather than
  // the engine.
  const decks = [testDeck(), testDeck()];

  it('replays an identical game for the same seed', () => {
    const a = createGame({ decks, seed: 'same-seed' }).state;
    const b = createGame({ decks, seed: 'same-seed' }).state;
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('produces a different shuffle for a different seed', () => {
    const a = createGame({ decks, seed: 'seed-a' }).state;
    const b = createGame({ decks, seed: 'seed-b' }).state;
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it('replays an identical game for the same seed and action sequence', () => {
    const play = (): GameState => {
      let state = createGame({ decks, seed: 'replay' }).state;
      for (let i = 0; i < 40 && !isOver(state); i += 1) {
        const action = currentLegalActions(state)[0];
        if (action === undefined) {
          break;
        }
        state = reduce(state, action).state;
      }
      return state;
    };

    expect(JSON.stringify(play())).toEqual(JSON.stringify(play()));
  });

  it('produces the same events for the same seed', () => {
    const a = createGame({ decks, seed: 'events' });
    const b = createGame({ decks, seed: 'events' });
    expect(a.events).toEqual(b.events);

    const stepA = reduce(a.state, { type: 'resolvePhase' });
    const stepB = reduce(b.state, { type: 'resolvePhase' });
    expect(stepA.events).toEqual(stepB.events);
  });
});

describe('reduce purity', () => {
  it('never mutates the state it is given', () => {
    let state = deepFreeze(newGame('purity').state);
    for (let i = 0; i < 30 && !isOver(state); i += 1) {
      const action = currentLegalActions(state)[0];
      if (action === undefined) {
        break;
      }
      // Throws if reduce writes to the frozen input.
      state = deepFreeze(reduce(state, action).state);
    }
    expect(state.turn).toBeGreaterThan(1);
  });

  it('returns a new state object rather than the same reference', () => {
    const start = newGame('identity').state;
    const next = reduce(start, { type: 'resolvePhase' }).state;
    expect(next).not.toBe(start);
    expect(start.phase).toBe('awaken');
  });
});

describe('turn structure', () => {
  it('walks A, B, C, D and then the action phase', () => {
    let state = newGame('phases').state;
    const seen: Phase[] = [state.phase];

    for (let i = 0; i < 4; i += 1) {
      state = reduce(state, { type: 'resolvePhase' }).state;
      seen.push(state.phase);
    }

    expect(seen).toEqual(['awaken', 'beginning', 'channel', 'draw', 'action']);
  });

  it('Channels the configured number of Runes in phase C', () => {
    const start = newGame('channel').state;
    const player = start.activePlayer;
    const before = zoneOf(start, player, 'runeDeck').length;

    const afterChannel = runTo(start, 'draw');

    expect(zoneOf(afterChannel, player, 'runes')).toHaveLength(start.config.channelPerTurn);
    expect(zoneOf(afterChannel, player, 'runeDeck')).toHaveLength(
      before - start.config.channelPerTurn,
    );
  });

  it('draws the configured number of cards in phase D', () => {
    const start = newGame('draw').state;
    const player = start.activePlayer;
    const handBefore = zoneOf(start, player, 'hand').length;

    const afterDraw = runTo(start, 'action');

    expect(zoneOf(afterDraw, player, 'hand')).toHaveLength(handBefore + start.config.drawPerTurn);
  });

  it('passes the turn to the next player and increments the turn counter', () => {
    const start = newGame('pass').state;
    const first = start.activePlayer;

    const action = runTo(start, 'action');
    const next = reduce(action, { type: 'endTurn' }).state;

    expect(next.activePlayer).not.toBe(first);
    expect(next.turn).toBe(start.turn + 1);
    expect(next.phase).toBe('awaken');
  });

  it('readies the active player\'s exhausted cards during Awaken', () => {
    // Channel runes, exhaust them, then confirm the next Awaken readies them.
    let state = runTo(newGame('ready').state, 'action');
    const player = state.activePlayer;
    const runes = zoneOf(state, player, 'runes');
    expect(runes.length).toBeGreaterThan(0);

    const exhausted = { ...state, entities: { ...state.entities } };
    for (const id of runes) {
      exhausted.entities[id] = { ...state.entities[id]!, exhausted: true };
    }

    state = reduce(exhausted, { type: 'endTurn' }).state;
    state = runTo(state, 'action');
    state = reduce(state, { type: 'endTurn' }).state;
    const readied = reduce(state, { type: 'resolvePhase' }).state;

    for (const id of runes) {
      expect(readied.entities[id]!.exhausted).toBe(false);
    }
  });
});

describe('scoring', () => {
  it('scores a point per Battlefield held at the Beginning phase', () => {
    const start = newGame('score').state;
    const player = start.activePlayer;
    const holding: GameState = {
      ...start,
      battlefields: start.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: player } : battlefield,
      ),
    };

    const scored = runTo(holding, 'channel');

    expect(scored.players[player]!.points).toBe(1);
  });

  it('does not score for a Battlefield the opponent holds', () => {
    const start = newGame('no-score').state;
    const player = start.activePlayer;
    const opponent = playerId((player + 1) % start.players.length);
    const holding: GameState = {
      ...start,
      battlefields: start.battlefields.map((battlefield) => ({
        ...battlefield,
        controller: opponent,
      })),
    };

    const scored = runTo(holding, 'channel');

    expect(scored.players[player]!.points).toBe(0);
    expect(scored.players[opponent]!.points).toBe(0);
  });

  it('ends the game once a player reaches the points target', () => {
    const start = newGame('win').state;
    const player = start.activePlayer;
    const onTheBrink: GameState = {
      ...start,
      players: start.players.map((current) =>
        current.id === player ? { ...current, points: start.config.pointsToWin - 1 } : current,
      ),
      battlefields: start.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: player } : battlefield,
      ),
    };

    const finished = reduce(reduce(onTheBrink, { type: 'resolvePhase' }).state, {
      type: 'resolvePhase',
    });

    expect(finished.state.outcome).toEqual({ kind: 'win', winner: player });
    expect(finished.events).toContainEqual({
      type: 'gameEnded',
      outcome: { kind: 'win', winner: player },
    });
  });
});

describe('legal actions', () => {
  it('offers exactly one action during the automatic phases', () => {
    let state = newGame('legal').state;
    for (const phase of ['awaken', 'beginning', 'channel', 'draw'] as const) {
      expect(state.phase).toBe(phase);
      expect(currentLegalActions(state)).toEqual([{ type: 'resolvePhase' }]);
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
  });

  it('offers endTurn during the action phase', () => {
    const state = runTo(newGame('legal-action').state, 'action');
    expect(currentLegalActions(state)).toEqual([{ type: 'endTurn' }]);
  });

  it('offers the inactive player nothing', () => {
    const state = newGame('inactive').state;
    const inactive = playerId((state.activePlayer + 1) % state.players.length);
    expect(legalActions(state, inactive)).toEqual([]);
  });

  it('offers nothing once the game is over', () => {
    const start = newGame('over').state;
    const ended: GameState = { ...start, outcome: { kind: 'draw', reason: 'test' } };
    expect(legalActions(ended, ended.activePlayer)).toEqual([]);
  });

  it('only ever offers actions reduce will accept', () => {
    let state = newGame('accepts').state;
    for (let i = 0; i < 60 && !isOver(state); i += 1) {
      for (const action of currentLegalActions(state)) {
        expect(() => reduce(state, action)).not.toThrow();
      }
      const next = currentLegalActions(state)[0];
      if (next === undefined) {
        break;
      }
      state = reduce(state, next).state;
    }
  });
});

describe('illegal actions', () => {
  it('rejects endTurn outside the action phase', () => {
    const start = newGame('illegal-end').state;
    expect(start.phase).toBe('awaken');
    expect(() => reduce(start, { type: 'endTurn' })).toThrow(IllegalActionError);
  });

  it('rejects resolvePhase during the action phase', () => {
    const state = runTo(newGame('illegal-resolve').state, 'action');
    expect(() => reduce(state, { type: 'resolvePhase' })).toThrow(IllegalActionError);
  });

  it('rejects any action once the game is over', () => {
    const start = newGame('illegal-over').state;
    const ended: GameState = { ...start, outcome: { kind: 'draw', reason: 'test' } };
    expect(() => reduce(ended, { type: 'resolvePhase' })).toThrow(IllegalActionError);
  });

  it('rejects an unknown action', () => {
    const start = newGame('illegal-unknown').state;
    expect(() => reduce(start, { type: 'nonsense' } as unknown as Action)).toThrow(
      IllegalActionError,
    );
  });
});

describe('termination guard', () => {
  it('ends in a draw once the turn limit is passed', () => {
    let state = newGame('limit', { maxTurns: 6 }).state;

    for (let i = 0; i < 500 && !isOver(state); i += 1) {
      const action = currentLegalActions(state)[0];
      if (action === undefined) {
        break;
      }
      state = reduce(state, action).state;
    }

    expect(state.outcome?.kind).toBe('draw');
    expect(state.turn).toBe(6);
  });
});

describe('random-agent fuzz', () => {
  it('never reaches an inconsistent state and always terminates', () => {
    for (let game = 0; game < 25; game += 1) {
      const rng = Rng.fromSeed(`fuzz-${game}`);
      let state = newGame(`fuzz-${game}`, { maxTurns: 40 }).state;
      checkInvariants(state);

      let steps = 0;
      while (!isOver(state)) {
        steps += 1;
        if (steps > 5000) {
          throw new Error(`Game ${game} did not terminate`);
        }

        const actions = currentLegalActions(state);
        expect(actions.length).toBeGreaterThan(0);

        state = reduce(state, rng.pick(actions)).state;
        checkInvariants(state);
      }

      expect(state.outcome).not.toBeNull();
    }
  });

  it('conserves every entity across a whole game', () => {
    let state = newGame('conservation', { maxTurns: 30 }).state;
    const total = Object.keys(state.entities).length;

    while (!isOver(state)) {
      const action = currentLegalActions(state)[0];
      if (action === undefined) {
        break;
      }
      state = reduce(state, action).state;
      expect(Object.keys(state.entities)).toHaveLength(total);
    }
  });
});

describe('players', () => {
  it('alternates seats around the table', () => {
    let state = newGame('seats').state;
    const seen: PlayerId[] = [];

    for (let turn = 0; turn < 4; turn += 1) {
      seen.push(state.activePlayer);
      state = reduce(runTo(state, 'action'), { type: 'endTurn' }).state;
    }

    expect(seen[0]).toBe(seen[2]);
    expect(seen[1]).toBe(seen[3]);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
