/**
 * Setup and the Mulligan.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { IllegalActionError } from './actions.js';
import { checkInvariants } from './invariants.js';
import { legalActions } from './legal.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import {
  type EntityId,
  type GameState,
  type PlayerId,
  getPlayer,
  playerId,
  zoneOf,
} from './state.js';

const LEGEND = makeLegend(['fury'], { id: cardId('G-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('G-001'), champion: true });
const FURY_RUNE = makeRune('fury', { id: cardId('G-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`G-20${i}`) }),
);
/** Distinct names so a hand is legible when a test fails. */
const UNITS = Array.from({ length: 10 }, (_, i) =>
  makeUnit(1, ['fury'], { id: cardId(`G-01${i}`), name: `Unit ${i}`, cost: cost(1) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  FURY_RUNE,
  ...BATTLEFIELDS,
  ...UNITS,
] as CardDefinition[]);

/** `mainSize` cards in the Main Deck, so tests can run the deck near empty. */
function deck(mainSize = 10): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: Array.from({ length: mainSize }, (_, i) => (UNITS[i % UNITS.length] as CardDefinition).id),
    runes: Array.from({ length: 8 }, () => FURY_RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function newGame(seed = 'mulligan', mainSize = 10): GameState {
  return createGame({ decks: [deck(mainSize), deck(mainSize)], registry: REGISTRY, seed }).state;
}

function hand(state: GameState, player: PlayerId): readonly EntityId[] {
  return getPlayer(state, player).zones.hand;
}

function take(state: GameState, cards: readonly EntityId[]): GameState {
  const next = reduce(state, { type: 'mulligan', cards }).state;
  checkInvariants(next);
  return next;
}

describe('setup (rules 110-118)', () => {
  it('deals each player a hand of 4 (rule 116)', () => {
    const state = newGame();
    for (const player of state.players) {
      expect(player.zones.hand).toHaveLength(4);
    }
  });

  it('opens in the Mulligan phase with the First Player choosing (rules 117, 115.1.b.1)', () => {
    const state = newGame();
    expect(state.phase).toBe('mulligan');
    expect(state.priority).toBe(state.firstPlayer);
    expect(state.mulligansTaken).toBe(0);
    checkInvariants(state);
  });
});

describe('the Mulligan (rule 117)', () => {
  it('sets aside nothing when the player keeps their hand', () => {
    const state = newGame();
    const player = state.firstPlayer;
    const before = [...hand(state, player)];

    const after = take(state, []);

    expect(hand(after, player)).toEqual(before);
    expect(after.mulligansTaken).toBe(1);
  });

  it('replaces the set-aside cards and leaves the hand the same size (117.1-117.3)', () => {
    const state = newGame();
    const player = state.firstPlayer;
    const before = [...hand(state, player)];
    const setAside = before.slice(0, 2);

    const after = take(state, setAside);

    expect(hand(after, player)).toHaveLength(before.length);
    for (const card of setAside) {
      expect(hand(after, player)).not.toContain(card);
    }
    expect(hand(after, player)).toContain(before[2] as EntityId);
    expect(hand(after, player)).toContain(before[3] as EntityId);
  });

  it('Recycles the set-aside cards to the bottom of the Main Deck (117.3, 416.1.a)', () => {
    const state = newGame();
    const player = state.firstPlayer;
    const setAside = hand(state, player).slice(0, 2);

    const after = take(state, setAside);

    const mainDeck = zoneOf(after, player, 'mainDeck');
    expect(mainDeck.slice(-2)).toEqual(setAside);
  });

  it('draws the replacements before Recycling, not after (117.2 then 117.3)', () => {
    // With one card left in the Main Deck the order is observable: drawing
    // first takes that card and Burns Out on the second draw (431), whereas
    // Recycling first would hand the player back a card they just set aside.
    const state = newGame('tight', 5);
    const player = state.firstPlayer;
    const remaining = zoneOf(state, player, 'mainDeck');
    expect(remaining).toHaveLength(1);
    const top = remaining[0] as EntityId;
    const setAside = hand(state, player).slice(0, 2);

    const after = take(state, setAside);

    expect(hand(after, player)).toContain(top);
    for (const card of setAside) {
      expect(hand(after, player)).not.toContain(card);
    }
  });

  it('passes to each player in turn order, then begins play (rule 118)', () => {
    let state = newGame();
    const first = state.firstPlayer;
    const second = playerId((first + 1) % state.players.length);

    state = take(state, []);
    expect(state.phase).toBe('mulligan');
    expect(state.priority).toBe(second);

    state = take(state, []);
    expect(state.mulligansTaken).toBe(2);
    expect(state.phase).toBe('awaken');
    // Rule 118: the First Player takes the first turn, whoever Mulliganed last.
    expect(state.activePlayer).toBe(first);
    // Nothing outside the Main Phase has Priority.
    expect(state.priority).toBeNull();
  });

  it('rejects setting aside more than the limit (117.1)', () => {
    const state = newGame();
    const tooMany = hand(state, state.firstPlayer).slice(0, 3);
    expect(() => reduce(state, { type: 'mulligan', cards: tooMany })).toThrow(IllegalActionError);
  });

  it('rejects a card that is not in the mulliganing player`s hand', () => {
    const state = newGame();
    const opponent = playerId((state.firstPlayer + 1) % state.players.length);
    const theirs = hand(state, opponent)[0] as EntityId;
    expect(() => reduce(state, { type: 'mulligan', cards: [theirs] })).toThrow(IllegalActionError);
  });

  it('rejects the same card set aside twice', () => {
    const state = newGame();
    const card = hand(state, state.firstPlayer)[0] as EntityId;
    expect(() => reduce(state, { type: 'mulligan', cards: [card, card] })).toThrow(
      IllegalActionError,
    );
  });

  it('cannot be taken once play has begun', () => {
    let state = newGame();
    state = take(state, []);
    state = take(state, []);
    expect(() => reduce(state, { type: 'mulligan', cards: [] })).toThrow(IllegalActionError);
  });

  it('is the only phase that does not simply resolve', () => {
    const state = newGame();
    expect(() => reduce(state, { type: 'resolvePhase' })).toThrow(IllegalActionError);
  });
});

describe('Mulligan legal actions', () => {
  it('offers every subset of the hand up to the limit', () => {
    const state = newGame();
    const actions = legalActions(state, state.firstPlayer);
    // A hand of 4 with a limit of 2: 1 empty + 4 singles + 6 pairs.
    expect(actions).toHaveLength(11);
    expect(actions.every((action) => action.type === 'mulligan')).toBe(true);
  });

  it('offers nothing to the player who is not choosing', () => {
    const state = newGame();
    const waiting = playerId((state.firstPlayer + 1) % state.players.length);
    expect(legalActions(state, waiting)).toEqual([]);
  });

  it('only ever offers actions reduce will accept', () => {
    const state = newGame();
    for (const action of legalActions(state, state.firstPlayer)) {
      expect(() => reduce(state, action)).not.toThrow();
    }
  });
});
