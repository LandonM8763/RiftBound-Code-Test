/**
 * Determinization (rule 128).
 *
 * The property that makes this trustworthy is a **round trip**: observe a real
 * state, rebuild a state from that view, and everything the viewer was
 * entitled to see must come back identical. What they were not entitled to see
 * must come back *plausible* — right counts, sampled contents — because that is
 * the whole point.
 *
 * The second property is that a rebuilt state is **playable**: the engine has
 * to accept it, `legalActions` has to offer the same choices, and
 * `checkInvariants` has to pass. A determinized world a search agent cannot
 * legally play in is worse than no search at all.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeSpell, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { determinize } from './determinize.js';
import { checkInvariants } from './invariants.js';
import { legalActions } from './legal.js';
import { reduce } from './reduce.js';
import { Rng } from './rng.js';
import { createGame, type DeckList } from './setup.js';
import { observe } from './view.js';
import { isOver, type GameState, type PlayerId } from './state.js';

const LEGEND = makeLegend(['fury'], { id: cardId('D-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('D-001'), champion: true });
const GRUNT = makeUnit(2, ['fury'], { id: cardId('D-010'), name: 'Grunt', cost: cost(1) });
const BRAWLER = makeUnit(4, ['fury'], {
  id: cardId('D-011'),
  name: 'Brawler',
  cost: cost(2),
  keywords: [{ kind: 'tank' }],
});
const BOLT = makeSpell(['fury'], {
  id: cardId('D-020'),
  name: 'Bolt',
  cost: cost(1),
  timing: 'action',
  effect: { target: { kind: 'unit', scope: 'any' }, effects: [{ kind: 'dealDamage', amount: 2 }] },
});
const RUNE = makeRune('fury', { id: cardId('D-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`D-20${i}`) }),
);

const CARDS = [LEGEND, CHAMPION, GRUNT, BRAWLER, BOLT, RUNE, ...BATTLEFIELDS] as CardDefinition[];
const REGISTRY = CardRegistry.from(CARDS);
const DEFINITIONS = Object.fromEntries(CARDS.map((card) => [card.id, card]));

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 16 }, () => GRUNT.id),
      ...Array.from({ length: 14 }, () => BRAWLER.id),
      ...Array.from({ length: 14 }, () => BOLT.id),
    ],
    runes: Array.from({ length: 12 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

/** Everything a deck-testing harness legitimately knows about both decks. */
const UNSEEN = [...deck().main, ...deck().main, ...deck().runes, ...deck().runes];

/** Play `steps` random actions, so the state is genuinely mid-game. */
function played(seed: string, steps: number): GameState {
  const rng = Rng.fromSeed(seed);
  let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state;
  for (let i = 0; i < steps && !isOver(state); i += 1) {
    const legal = legalActions(state, state.priority ?? state.activePlayer);
    const actions = legal.length > 0 ? legal : legalActions(state, state.activePlayer);
    if (actions.length === 0) {
      break;
    }
    state = reduce(state, actions[rng.nextInt(actions.length)]!).state;
  }
  return state;
}

describe('a determinized world is playable', () => {
  it('passes the engine`s own invariants', () => {
    for (const steps of [0, 20, 60, 140]) {
      const state = played(`det-${steps}`, steps);
      const viewer = (state.priority ?? state.activePlayer) as PlayerId;
      const world = determinize(observe(state, viewer), { definitions: DEFINITIONS, unseen: UNSEEN }, 'w');
      expect(() => checkInvariants(world)).not.toThrow();
    }
  });

  it('offers the viewer the same actions the real game does', () => {
    // The point of searching a determinized world is that the action chosen in
    // it is one the real engine will accept. If the two disagree about what is
    // legal, every search result is a guess about a different game.
    for (const steps of [10, 45, 90]) {
      const state = played(`det-legal-${steps}`, steps);
      const viewer = (state.priority ?? state.activePlayer) as PlayerId;
      const world = determinize(observe(state, viewer), { definitions: DEFINITIONS, unseen: UNSEEN }, 'w');
      expect(JSON.stringify(legalActions(world, viewer))).toBe(
        JSON.stringify(legalActions(state, viewer)),
      );
    }
  });

  it('can be played on for a whole game', () => {
    const state = played('det-continue', 40);
    const viewer = (state.priority ?? state.activePlayer) as PlayerId;
    let world = determinize(observe(state, viewer), { definitions: DEFINITIONS, unseen: UNSEEN }, 'w');
    const rng = Rng.fromSeed('rollout');
    for (let i = 0; i < 400 && !isOver(world); i += 1) {
      const actions = legalActions(world, world.priority ?? world.activePlayer);
      if (actions.length === 0) {
        break;
      }
      world = reduce(world, actions[rng.nextInt(actions.length)]!).state;
      checkInvariants(world);
    }
  });
});

describe('what the viewer was entitled to see comes back exactly', () => {
  it('preserves the public board, the Chain and both trashes', () => {
    const state = played('det-public', 80);
    const viewer = (state.priority ?? state.activePlayer) as PlayerId;
    const view = observe(state, viewer);
    const world = determinize(view, { definitions: DEFINITIONS, unseen: UNSEEN }, 'w');

    expect(world.turn).toBe(state.turn);
    expect(world.phase).toBe(state.phase);
    expect(world.activePlayer).toBe(state.activePlayer);
    expect(world.priority).toBe(state.priority);
    expect(world.chain.length).toBe(state.chain.length);
    expect(world.battlefields.map((b) => b.units)).toEqual(state.battlefields.map((b) => b.units));
    expect(world.battlefields.map((b) => b.controller)).toEqual(
      state.battlefields.map((b) => b.controller),
    );
    for (const seat of state.players) {
      expect(world.players[seat.id]!.points).toBe(seat.points);
      expect(world.players[seat.id]!.zones.trash).toEqual(seat.zones.trash);
      expect(world.players[seat.id]!.zones.base).toEqual(seat.zones.base);
      expect(world.players[seat.id]!.zones.runes).toEqual(seat.zones.runes);
    }
  });

  it('preserves the viewer`s own hand, card for card', () => {
    const state = played('det-hand', 70);
    const viewer = (state.priority ?? state.activePlayer) as PlayerId;
    const world = determinize(observe(state, viewer), { definitions: DEFINITIONS, unseen: UNSEEN }, 'w');

    const mine = state.players[viewer]!.zones.hand;
    expect(world.players[viewer]!.zones.hand).toEqual(mine);
    for (const card of mine) {
      expect(world.entities[card]!.card).toBe(state.entities[card]!.card);
    }
  });

  it('keeps entity ids, so an action chosen here is meaningful there', () => {
    // The agent's output is an `Action`, and an action names entities. Fresh
    // ids for hidden cards would produce actions the real engine rejects.
    const state = played('det-ids', 55);
    const viewer = (state.priority ?? state.activePlayer) as PlayerId;
    const world = determinize(observe(state, viewer), { definitions: DEFINITIONS, unseen: UNSEEN }, 'w');
    for (const unit of state.battlefields.flatMap((b) => b.units)) {
      expect(world.entities[unit]).toBeDefined();
      expect(world.entities[unit]!.controller).toBe(state.entities[unit]!.controller);
    }
  });
});

describe('what the viewer was not entitled to see is sampled', () => {
  it('gets the counts right even though the cards are guesses', () => {
    // The counts are public — a deck of the wrong size changes when a Burn Out
    // happens (431) — so those must be exact while the contents are not.
    const state = played('det-hidden', 75);
    const viewer = (state.priority ?? state.activePlayer) as PlayerId;
    const other = (viewer === 0 ? 1 : 0) as PlayerId;
    const world = determinize(observe(state, viewer), { definitions: DEFINITIONS, unseen: UNSEEN }, 'w');

    expect(world.players[other]!.zones.hand.length).toBe(state.players[other]!.zones.hand.length);
    for (const seat of state.players) {
      expect(world.players[seat.id]!.zones.mainDeck.length).toBe(seat.zones.mainDeck.length);
      expect(world.players[seat.id]!.zones.runeDeck.length).toBe(seat.zones.runeDeck.length);
    }
  });

  it('samples differently for different seeds, and the same for the same one', () => {
    const state = played('det-seeds', 60);
    const viewer = (state.priority ?? state.activePlayer) as PlayerId;
    const view = observe(state, viewer);
    const knowledge = { definitions: DEFINITIONS, unseen: UNSEEN };

    const a = determinize(view, knowledge, 'one');
    const b = determinize(view, knowledge, 'one');
    const c = determinize(view, knowledge, 'two');
    const deckOf = (world: GameState): string =>
      JSON.stringify(world.players.map((p) => p.zones.mainDeck.map((id) => world.entities[id]!.card)));

    expect(deckOf(a)).toBe(deckOf(b));
    expect(deckOf(a)).not.toBe(deckOf(c));
  });
});
