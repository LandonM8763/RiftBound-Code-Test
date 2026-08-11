import { CardRegistry, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { currentLegalActions } from './legal.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import { type GameState, isOver, playerId, playerLocation } from './state.js';
import { moveEntity } from './mutate.js';
import { knownCardCount, observe, opponentsOf, pointsOf } from './view.js';

const CARDS: CardDefinition[] = [];
const registryFor = (): CardRegistry => CardRegistry.from(CARDS);

function testDeck(): DeckList {
  const legend = makeLegend(['fury', 'calm']);
  const champion = makeUnit(3, ['fury'], { champion: true });
  const main = Array.from({ length: 12 }, () => makeUnit(2, ['fury']));
  const runes = Array.from({ length: 8 }, () => makeRune('fury'));
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

function game(seed = 'view'): GameState {
  const decks = [testDeck(), testDeck()];
  let state = createGame({ decks, registry: registryFor(), seed }).state;
  // Take the empty Mulligan for both players (rule 117).
  while (state.phase === 'mulligan') {
    state = reduce(state, { type: 'mulligan', cards: [] }).state;
  }
  return state;
}

const SEAT_0 = playerId(0);
const SEAT_1 = playerId(1);

describe('observe', () => {
  it('reveals the viewer\'s own hand', () => {
    const state = game();
    const view = observe(state, SEAT_0);
    const own = view.players[SEAT_0]!;

    expect(own.hand).toHaveLength(state.config.openingHandSize);
    for (const card of own.hand) {
      expect(card.card).not.toBeNull();
    }
  });

  it('hides the opponent\'s hand while still reporting its size', () => {
    const state = game();
    const view = observe(state, SEAT_0);
    const opponent = view.players[SEAT_1]!;

    expect(opponent.hand).toHaveLength(state.config.openingHandSize);
    for (const card of opponent.hand) {
      expect(card.card).toBeNull();
    }
  });

  it('never leaks an opponent hand card id anywhere in the view', () => {
    const state = game();
    const hidden = state.players[SEAT_1]!.zones.hand.map((id) => state.entities[id]!.card);
    expect(hidden.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(observe(state, SEAT_0));
    for (const card of hidden) {
      expect(serialized).not.toContain(card);
    }
  });

  it('exposes decks as counts only, for both players', () => {
    const state = game();
    const view = observe(state, SEAT_0);

    for (const seat of [SEAT_0, SEAT_1]) {
      const player = view.players[seat]!;
      expect(player.mainDeckCount).toBe(state.players[seat]!.zones.mainDeck.length);
      expect(player.runeDeckCount).toBe(state.players[seat]!.zones.runeDeck.length);
      // No entity list for a deck: identity must not survive a shuffle.
      expect(player).not.toHaveProperty('mainDeck');
      expect(player).not.toHaveProperty('runeDeck');
    }
  });

  it('does not leak the order or identity of any deck', () => {
    const state = game();
    const deckCards = state.players[SEAT_0]!.zones.mainDeck.map((id) => state.entities[id]!.card);
    expect(deckCards.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(observe(state, SEAT_0));
    for (const card of deckCards) {
      expect(serialized).not.toContain(card);
    }
  });

  it('reveals public zones to everyone', () => {
    let state = game();
    // Channel a rune into play, then confirm the opponent can see it.
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, currentLegalActions(state)[0]!).state;
    }
    const active = state.activePlayer;
    const runes = state.players[active]!.zones.runes;
    expect(runes.length).toBeGreaterThan(0);

    const opponent = playerId((active + 1) % state.players.length);
    const view = observe(state, opponent);

    for (const rune of view.players[active]!.runes) {
      expect(rune.card).not.toBeNull();
    }
  });

  it('reveals both Legends and Champions', () => {
    const view = observe(game(), SEAT_0);
    for (const player of view.players) {
      expect(player.legend?.card).not.toBeNull();
      expect(player.champion?.card).not.toBeNull();
    }
  });

  it('reveals Battlefields and their controllers', () => {
    const state = game();
    const view = observe(state, SEAT_0);

    expect(view.battlefields).toHaveLength(state.config.battlefieldCount);
    for (const battlefield of view.battlefields) {
      expect(battlefield.card).toBeTruthy();
      expect(battlefield.controller).toBeNull();
    }
  });

  it('reveals a card once it moves from a hidden zone to a public one', () => {
    const state = game();
    const card = state.players[SEAT_1]!.zones.hand[0]!;

    expect(observe(state, SEAT_0).players[SEAT_1]!.hand[0]?.card).toBeNull();

    const played = moveEntity(state, card, playerLocation(SEAT_1, 'base'));
    const revealed = observe(played, SEAT_0).players[SEAT_1]!.base[0];

    expect(revealed?.card).toBe(state.entities[card]!.card);
  });

  it('gives each player a different view of the same state', () => {
    const state = game();
    expect(JSON.stringify(observe(state, SEAT_0))).not.toEqual(
      JSON.stringify(observe(state, SEAT_1)),
    );
  });

  it('carries turn, phase and outcome through unchanged', () => {
    const state = game();
    const view = observe(state, SEAT_0);

    expect(view.viewer).toBe(SEAT_0);
    expect(view.turn).toBe(state.turn);
    expect(view.phase).toBe(state.phase);
    expect(view.activePlayer).toBe(state.activePlayer);
    expect(view.outcome).toBeNull();
  });
});

describe('view helpers', () => {
  it('counts only the cards the viewer can identify', () => {
    const state = game();
    const mine = knownCardCount(observe(state, SEAT_0));
    const theirs = knownCardCount(observe(state, SEAT_1));

    expect(mine).toBe(state.config.openingHandSize);
    expect(theirs).toBe(state.config.openingHandSize);
  });

  it('lists opponents without the player themself', () => {
    const state = game();
    expect(opponentsOf(state, SEAT_0)).toEqual([SEAT_1]);
    expect(opponentsOf(state, SEAT_1)).toEqual([SEAT_0]);
  });

  it('reads points from state', () => {
    const state = game();
    expect(pointsOf(state, SEAT_0)).toBe(0);
  });
});
