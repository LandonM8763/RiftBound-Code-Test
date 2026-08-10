/**
 * Engine tests.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { CardRegistry, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { IllegalActionError, type Action } from './actions.js';
import { checkInvariants } from './invariants.js';
import { currentLegalActions, legalActions } from './legal.js';
import { reduce } from './reduce.js';
import { Rng } from './rng.js';
import { createGame, type CreateGameOptions, type DeckList } from './setup.js';
import { type GameState, type Phase, type PlayerId, isOver, playerId, zoneOf } from './state.js';

/**
 * Every card the fixtures have minted. The engine needs definitions for costs,
 * so tests build a registry from this rather than passing bare ids.
 */
const CARDS: CardDefinition[] = [];

const registryFor = (): CardRegistry => CardRegistry.from(CARDS);

function testDeck(mainSize = 12, runeSize = 8): DeckList {
  const legend = makeLegend(['fury', 'calm']);
  const champion = makeUnit(3, ['fury'], { champion: true });
  const main = Array.from({ length: mainSize }, () => makeUnit(2, ['fury']));
  const runes = Array.from({ length: runeSize }, () => makeRune('fury'));
  const battlefields = Array.from({ length: 3 }, () => makeBattlefield());

  CARDS.push(legend, champion, ...main, ...runes, ...battlefields);

  return {
    legend: legend.id,
    champion: champion.id,
    main: main.map((card) => card.id),
    runes: runes.map((card) => card.id),
    battlefields: battlefields.map((card) => card.id),
  };
}

function newGame(seed: string | number = 'test', config?: CreateGameOptions['config']) {
  const decks = [testDeck(), testDeck()];
  return createGame({ decks, registry: registryFor(), seed, ...(config ? { config } : {}) });
}

/** Drive the game with the first legal action until it reaches `phase`. */
function runTo(state: GameState, phase: Phase): GameState {
  let current = state;
  for (let guard = 0; guard < 400; guard += 1) {
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

/** Finish the active player's turn and stop at the next player's Main Phase. */
function nextTurn(state: GameState): GameState {
  const ending = reduce(runTo(state, 'main'), { type: 'endTurn' }).state;
  return runTo(reduce(ending, { type: 'resolvePhase' }).state, 'main');
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
  });

  it('produces a structurally consistent state', () => {
    expect(() => checkInvariants(start)).not.toThrow();
  });

  it('deals an opening hand of four (rule 116)', () => {
    expect(start.config.openingHandSize).toBe(4);
    for (const player of start.players) {
      expect(player.zones.hand).toHaveLength(4);
      expect(player.zones.mainDeck).toHaveLength(8);
    }
  });

  it('puts the Champion Legend and Chosen Champion in their zones (rules 111-112)', () => {
    for (const player of start.players) {
      expect(player.zones.legendZone).toHaveLength(1);
      expect(player.zones.championZone).toHaveLength(1);
    }
  });

  it('places one Battlefield per player, uncontrolled (rules 485.4, 485.5)', () => {
    expect(start.battlefields).toHaveLength(2);
    expect(start.config.battlefieldCount).toBe(start.players.length);
    for (const battlefield of start.battlefields) {
      expect(battlefield.controller).toBeNull();
      expect(battlefield.units).toEqual([]);
      expect(battlefield.scoredBy).toEqual([]);
    }
  });

  it('selects each player\'s Battlefield from the three they brought (rule 485.5)', () => {
    const decks = [testDeck(), testDeck()];
    const placed = createGame({ decks, registry: registryFor(), seed: 'bf' }).state.battlefields;

    expect(placed[0]?.card).toBeDefined();
    expect(decks[0]?.battlefields).toContain(placed[0]?.card);
    expect(decks[1]?.battlefields).toContain(placed[1]?.card);
  });

  it('picks Battlefields at random, not always the first', () => {
    const decks = [testDeck(), testDeck()];
    const chosen = new Set(
      Array.from(
        { length: 40 },
        (_, i) => createGame({ decks, registry: registryFor(), seed: `bf-${i}` }).state.battlefields[0]?.card,
      ),
    );
    // Three to choose from, so several seeds must disagree.
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('records who goes first (rule 115.1.b.1)', () => {
    expect(start.firstPlayer).toBe(start.activePlayer);
  });

  it('rejects a game with fewer than two players', () => {
    const decks = [testDeck()];
    expect(() => createGame({ decks, registry: registryFor(), seed: 1 })).toThrow(
      /at least 2 players/,
    );
  });

  it('rejects a player who brought no Battlefields', () => {
    const thin: DeckList = { ...testDeck(), battlefields: [] };
    expect(() => createGame({ decks: [thin, thin], registry: registryFor(), seed: 1 })).toThrow(
      /no Battlefields/,
    );
  });

  it('refuses a Battlefield count the rules do not define placement for', () => {
    const decks = [testDeck(), testDeck()];
    expect(() =>
      createGame({ decks, registry: registryFor(), seed: 1, config: { battlefieldCount: 1 } }),
    ).toThrow(/one per player/);
  });
});

describe('determinism', () => {
  const decks = [testDeck(), testDeck()];

  it('replays an identical game for the same seed', () => {
    const registry = registryFor();
    expect(JSON.stringify(createGame({ decks, registry, seed: 'same' }).state)).toEqual(
      JSON.stringify(createGame({ decks, registry, seed: 'same' }).state),
    );
  });

  it('produces a different game for a different seed', () => {
    const registry = registryFor();
    expect(JSON.stringify(createGame({ decks, registry, seed: 'a' }).state)).not.toEqual(
      JSON.stringify(createGame({ decks, registry, seed: 'b' }).state),
    );
  });

  it('replays an identical game for the same seed and action sequence', () => {
    const play = (): GameState => {
      let state = createGame({ decks, registry: registryFor(), seed: 'replay' }).state;
      for (let i = 0; i < 60 && !isOver(state); i += 1) {
        const action = currentLegalActions(state)[0];
        if (action === undefined) break;
        state = reduce(state, action).state;
      }
      return state;
    };
    expect(JSON.stringify(play())).toEqual(JSON.stringify(play()));
  });
});

describe('reduce purity', () => {
  it('never mutates the state it is given', () => {
    let state = deepFreeze(newGame('purity').state);
    for (let i = 0; i < 40 && !isOver(state); i += 1) {
      const action = currentLegalActions(state)[0];
      if (action === undefined) break;
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

describe('turn structure (rule 314)', () => {
  it('runs Awaken, Beginning, Channel, Draw, then the Main Phase', () => {
    let state = newGame('phases').state;
    const seen: Phase[] = [state.phase];
    for (let i = 0; i < 4; i += 1) {
      state = reduce(state, { type: 'resolvePhase' }).state;
      seen.push(state.phase);
    }
    expect(seen).toEqual(['awaken', 'beginning', 'channel', 'draw', 'main']);
  });

  it('moves from the Main Phase into the Ending Phase (rule 316.9)', () => {
    const main = runTo(newGame('ending').state, 'main');
    expect(reduce(main, { type: 'endTurn' }).state.phase).toBe('ending');
  });

  it('passes the turn after the Ending Phase (rule 317.3)', () => {
    const start = newGame('pass').state;
    const first = start.activePlayer;
    const ending = reduce(runTo(start, 'main'), { type: 'endTurn' }).state;
    const next = reduce(ending, { type: 'resolvePhase' }).state;

    expect(next.activePlayer).not.toBe(first);
    expect(next.turn).toBe(start.turn + 1);
    expect(next.phase).toBe('awaken');
  });

  it('Channels two Runes in the Channel Phase (rule 315.3.b)', () => {
    const start = newGame('channel').state;
    const player = start.activePlayer;
    const afterChannel = runTo(start, 'draw');

    expect(zoneOf(afterChannel, player, 'runes')).toHaveLength(2);
    expect(zoneOf(afterChannel, player, 'runeDeck')).toHaveLength(6);
  });

  it('gives the player going second an extra Rune on their first turn (rule 485.7)', () => {
    const start = newGame('second').state;
    const second = playerId((start.firstPlayer + 1) % start.players.length);

    const secondsTurn = nextTurn(start);
    expect(secondsTurn.activePlayer).toBe(second);
    expect(zoneOf(secondsTurn, second, 'runes')).toHaveLength(3);

    // Only on their first turn: the next one is a normal two.
    const thirdTurn = nextTurn(nextTurn(secondsTurn));
    expect(thirdTurn.activePlayer).toBe(second);
    expect(zoneOf(thirdTurn, second, 'runes')).toHaveLength(5);
  });

  it('Channels as many as possible from a short Rune Deck (rule 315.3.b.1)', () => {
    const decks = [testDeck(12, 1), testDeck(12, 1)];
    const start = createGame({ registry: registryFor(), decks, seed: 'short-runes' }).state;
    const player = start.activePlayer;

    const afterChannel = runTo(start, 'draw');
    expect(zoneOf(afterChannel, player, 'runes')).toHaveLength(1);
    expect(zoneOf(afterChannel, player, 'runeDeck')).toHaveLength(0);
  });

  it('draws one card in the Draw Phase (rule 315.4.b)', () => {
    const start = newGame('draw').state;
    const player = start.activePlayer;
    expect(zoneOf(runTo(start, 'main'), player, 'hand')).toHaveLength(5);
  });

  it('readies the active player\'s exhausted cards during Awaken (rule 315.1.b)', () => {
    const state = runTo(newGame('ready').state, 'main');
    const player = state.activePlayer;
    const runes = zoneOf(state, player, 'runes');
    expect(runes.length).toBeGreaterThan(0);

    const entities = { ...state.entities };
    for (const id of runes) {
      entities[id] = { ...entities[id]!, exhausted: true };
    }
    const exhausted: GameState = { ...state, entities };

    const backAround = nextTurn(nextTurn(exhausted));
    expect(backAround.activePlayer).toBe(player);
    for (const id of runes) {
      expect(backAround.entities[id]!.exhausted).toBe(false);
    }
  });
});

describe('scoring (rules 467-471)', () => {
  function holding(state: GameState, player: PlayerId, index = 0): GameState {
    return {
      ...state,
      battlefields: state.battlefields.map((battlefield, i) =>
        i === index ? { ...battlefield, controller: player } : battlefield,
      ),
    };
  }

  it('Holds every Battlefield the Turn Player Controls (rule 315.2.b.2)', () => {
    const start = newGame('score').state;
    const player = start.activePlayer;
    const scored = runTo(holding(start, player), 'channel');

    expect(scored.players[player]!.points).toBe(1);
  });

  it('records a Hold as the Scoring method (rule 469.2)', () => {
    const start = newGame('method').state;
    const player = start.activePlayer;
    const result = reduce(reduce(holding(start, player), { type: 'resolvePhase' }).state, {
      type: 'resolvePhase',
    });

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'pointsScored', method: 'hold', player }),
    );
  });

  it('does not score a Battlefield an opponent Controls', () => {
    const start = newGame('no-score').state;
    const player = start.activePlayer;
    const opponent = playerId((player + 1) % start.players.length);
    const scored = runTo(holding(start, opponent), 'channel');

    expect(scored.players[player]!.points).toBe(0);
    expect(scored.players[opponent]!.points).toBe(0);
  });

  it('scores each Battlefield at most once per turn (rule 470)', () => {
    const start = newGame('once').state;
    const player = start.activePlayer;
    const scored = runTo(holding(start, player), 'channel');

    expect(scored.battlefields[0]?.scoredBy).toEqual([player]);
    // Re-running the Beginning Phase must not score it a second time.
    const again = reduce({ ...scored, phase: 'beginning' }, { type: 'resolvePhase' }).state;
    expect(again.players[player]!.points).toBe(1);
  });

  it('clears the Scoring record when the turn passes', () => {
    const start = newGame('reset').state;
    const player = start.activePlayer;
    const scored = runTo(holding(start, player), 'main');
    expect(scored.battlefields[0]?.scoredBy).toEqual([player]);

    const opponentsTurn = nextTurn(scored);
    expect(opponentsTurn.battlefields[0]?.scoredBy).toEqual([]);
  });

  it('scores both Battlefields when both are Held', () => {
    const start = newGame('both').state;
    const player = start.activePlayer;
    const all: GameState = {
      ...start,
      battlefields: start.battlefields.map((battlefield) => ({ ...battlefield, controller: player })),
    };
    expect(runTo(all, 'channel').players[player]!.points).toBe(2);
  });
});

describe('winning (rules 323.1, 472)', () => {
  it('wins on reaching the Victory Score with more points than the opponent', () => {
    const start = newGame('win').state;
    const player = start.activePlayer;
    const brink: GameState = {
      ...start,
      players: start.players.map((current) =>
        current.id === player ? { ...current, points: start.config.victoryScore - 1 } : current,
      ),
      battlefields: start.battlefields.map((battlefield, i) =>
        i === 0 ? { ...battlefield, controller: player } : battlefield,
      ),
    };

    const finished = reduce(reduce(brink, { type: 'resolvePhase' }).state, { type: 'resolvePhase' });

    expect(finished.state.outcome).toEqual({ kind: 'win', winner: player });
    expect(finished.events).toContainEqual({
      type: 'gameEnded',
      outcome: { kind: 'win', winner: player },
    });
  });

  it('does not win while tied at the Victory Score (rule 194.2.b)', () => {
    const start = newGame('tied').state;
    const player = start.activePlayer;
    const opponent = playerId((player + 1) % start.players.length);
    const victory = start.config.victoryScore;

    const tied: GameState = {
      ...start,
      players: start.players.map((current) =>
        current.id === player
          ? { ...current, points: victory - 1 }
          : { ...current, points: victory },
      ),
      battlefields: start.battlefields.map((battlefield, i) =>
        i === 0 ? { ...battlefield, controller: player } : battlefield,
      ),
    };

    const scored = runTo(tied, 'channel');

    expect(scored.players[player]!.points).toBe(victory);
    expect(scored.players[opponent]!.points).toBe(victory);
    expect(scored.outcome).toBeNull();
  });
});

describe('Burn Out (rules 413.4, 431)', () => {
  /** Four cards, all dealt to the opening hand, so the Draw Phase burns out. */
  const emptyDecks = (): DeckList[] => [testDeck(4), testDeck(4)];

  it('burns out when the Main Deck is empty at the Draw Phase', () => {
    const start = createGame({ decks: emptyDecks(), registry: registryFor(), seed: 'burn' }).state;
    const player = start.activePlayer;
    expect(zoneOf(start, player, 'mainDeck')).toHaveLength(0);

    const result = reduce(runTo(start, 'draw'), { type: 'resolvePhase' });

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'burnedOut', player, recycled: 0 }),
    );
  });

  it('gives an opponent a point (rule 431.2.c)', () => {
    const start = createGame({ decks: emptyDecks(), registry: registryFor(), seed: 'burn-point' }).state;
    const player = start.activePlayer;
    const opponent = playerId((player + 1) % start.players.length);

    const after = reduce(runTo(start, 'draw'), { type: 'resolvePhase' }).state;

    expect(after.players[opponent]!.points).toBe(1);
    expect(after.players[player]!.points).toBe(0);
  });

  it('recycles the trash back into the Main Deck (rule 431.2.b)', () => {
    const start = createGame({ decks: emptyDecks(), registry: registryFor(), seed: 'recycle' }).state;
    const player = start.activePlayer;
    const hand = zoneOf(start, player, 'hand');

    // Put the whole hand in the trash so there is something to recycle.
    const entities = { ...start.entities };
    for (const id of hand) {
      entities[id] = { ...entities[id]!, location: { kind: 'player', player, zone: 'trash' } };
    }
    const trashed: GameState = {
      ...start,
      players: start.players.map((p) =>
        p.id === player ? { ...p, zones: { ...p.zones, hand: [], trash: [...hand] } } : p,
      ),
      entities,
    };
    checkInvariants(trashed);

    const after = reduce(runTo(trashed, 'draw'), { type: 'resolvePhase' }).state;

    expect(zoneOf(after, player, 'trash')).toHaveLength(0);
    // Four recycled, one immediately drawn.
    expect(zoneOf(after, player, 'mainDeck')).toHaveLength(3);
    expect(zoneOf(after, player, 'hand')).toHaveLength(1);
    checkInvariants(after);
  });

  it('ends the game once repeated Burn Outs carry someone to the Victory Score', () => {
    let state = createGame({ decks: emptyDecks(), registry: registryFor(), seed: 'burn-win', config: { maxTurns: 400 } }).state;

    while (!isOver(state)) {
      const action = currentLegalActions(state)[0];
      if (action === undefined) break;
      state = reduce(state, action).state;
    }

    // Nobody can play cards yet, so every turn is a Burn Out and the game
    // resolves on its own rather than running to the turn limit.
    expect(state.outcome?.kind).toBe('win');
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

  it('offers endTurn during the Main Phase, alongside the Add abilities', () => {
    const actions = currentLegalActions(runTo(newGame('legal-main').state, 'main'));

    expect(actions).toContainEqual({ type: 'endTurn' });
    // Rule 164.2: each Rune in play offers both of its Add abilities.
    expect(actions.some((action) => action.type === 'addEnergy')).toBe(true);
    expect(actions.some((action) => action.type === 'addPower')).toBe(true);
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
    for (let i = 0; i < 80 && !isOver(state); i += 1) {
      for (const action of currentLegalActions(state)) {
        expect(() => reduce(state, action)).not.toThrow();
      }
      const next = currentLegalActions(state)[0];
      if (next === undefined) break;
      state = reduce(state, next).state;
    }
  });
});

describe('illegal actions', () => {
  it('rejects endTurn outside the Main Phase', () => {
    expect(() => reduce(newGame('illegal-end').state, { type: 'endTurn' })).toThrow(
      IllegalActionError,
    );
  });

  it('rejects resolvePhase during the Main Phase', () => {
    const state = runTo(newGame('illegal-resolve').state, 'main');
    expect(() => reduce(state, { type: 'resolvePhase' })).toThrow(IllegalActionError);
  });

  it('rejects any action once the game is over', () => {
    const start = newGame('illegal-over').state;
    const ended: GameState = { ...start, outcome: { kind: 'draw', reason: 'test' } };
    expect(() => reduce(ended, { type: 'resolvePhase' })).toThrow(IllegalActionError);
  });

  it('rejects an unknown action', () => {
    expect(() =>
      reduce(newGame('illegal-unknown').state, { type: 'nonsense' } as unknown as Action),
    ).toThrow(IllegalActionError);
  });
});

describe('termination guard', () => {
  it('ends in a draw once the turn limit is passed', () => {
    // A deck big enough that nobody burns out before the limit.
    const decks = [testDeck(60, 40), testDeck(60, 40)];
    let state = createGame({ registry: registryFor(), decks, seed: 'limit', config: { maxTurns: 6 } }).state;

    for (let i = 0; i < 500 && !isOver(state); i += 1) {
      const action = currentLegalActions(state)[0];
      if (action === undefined) break;
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
      let state = newGame(`fuzz-${game}`, { maxTurns: 60 }).state;
      checkInvariants(state);

      let steps = 0;
      while (!isOver(state)) {
        steps += 1;
        if (steps > 5000) throw new Error(`Game ${game} did not terminate`);

        const actions = currentLegalActions(state);
        expect(actions.length).toBeGreaterThan(0);
        state = reduce(state, rng.pick(actions)).state;
        checkInvariants(state);
      }
      expect(state.outcome).not.toBeNull();
    }
  });

  it('conserves every entity across a whole game', () => {
    let state = newGame('conservation', { maxTurns: 40 }).state;
    const total = Object.keys(state.entities).length;

    while (!isOver(state)) {
      const action = currentLegalActions(state)[0];
      if (action === undefined) break;
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
      state = nextTurn(state);
    }
    expect(seen[0]).toBe(seen[2]);
    expect(seen[1]).toBe(seen[3]);
    expect(seen[0]).not.toBe(seen[1]);
  });
});
