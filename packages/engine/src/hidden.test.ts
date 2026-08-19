/**
 * Hidden (rule 811) and the Hide action (rule 421).
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The thing to keep straight is that a facedown card is **not at** the
 * Battlefield it is hidden at. 107.3.e says a Facedown Zone is not a Location,
 * so the card sits in a player zone and only names the Battlefield — which is
 * what keeps it out of Combat, out of `units`, and out of every sweep that asks
 * who is present somewhere.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeSpell, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { executeEffect } from './effects.js';
import type { GameEvent } from './events.js';
import { facedownAt, hideDestinations, playableFromFacedown } from './hidden.js';
import { checkInvariants } from './invariants.js';
import { legalActions } from './legal.js';
import { moveEntity } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import { observe } from './view.js';
import {
  battlefieldLocation,
  isOver,
  playerLocation,
  type EntityId,
  type GameState,
  type PlayerId,
} from './state.js';

const LEGEND = makeLegend(['fury'], { id: cardId('H-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('H-001'), champion: true });
const PLAIN = makeUnit(2, ['fury'], { id: cardId('H-010'), name: 'Plain', cost: cost(1) });

/** A Unit with Hidden, so it can be hidden and then played to that Battlefield. */
const LURKER = makeUnit(4, ['fury'], {
  id: cardId('H-011'),
  name: 'Lurker',
  cost: cost(5),
  keywords: [{ kind: 'hidden' }],
});

/** A Spell with Hidden that chooses a Unit, for 811.1.d.2. */
const AMBUSH = makeSpell(['fury'], {
  id: cardId('H-020'),
  name: 'Ambush',
  cost: cost(4),
  timing: 'action',
  keywords: [{ kind: 'hidden' }],
  effect: { target: { kind: 'unit', scope: 'any' }, effects: [{ kind: 'dealDamage', amount: 3 }] },
});

const RUNE = makeRune('fury', { id: cardId('H-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`H-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  LURKER,
  AMBUSH,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 8 }, () => PLAIN.id),
      ...Array.from({ length: 4 }, () => LURKER.id),
      ...Array.from({ length: 4 }, () => AMBUSH.id),
    ],
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function game(seed: string): GameState {
  let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state;
  while (state.phase === 'mulligan') {
    state = reduce(state, { type: 'mulligan', cards: [] }).state;
  }
  while (state.phase !== 'main' && !isOver(state)) {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  return state;
}

/** Put a card of `id` into the active player's hand. */
function inHand(state: GameState, id: CardDefinition['id']): [GameState, EntityId] {
  const player = state.activePlayer;
  const card = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (card === undefined) {
    throw new Error(`No ${id} left`);
  }
  return [moveEntity(state, card, playerLocation(player, 'hand')), card];
}

/** Give the active player one Power pip, which is what a Hide costs. */
function withPower(state: GameState, amount: number): GameState {
  const player = state.activePlayer;
  return {
    ...state,
    players: state.players.map((seat) =>
      seat.id === player
        ? { ...seat, pool: { ...seat.pool, power: { ...seat.pool.power, fury: amount } } }
        : seat,
    ),
  };
}

/** Hand `player` Control of a Battlefield, which 107.3.c requires to Hide. */
function controlling(state: GameState, index: number, player: PlayerId): GameState {
  return {
    ...state,
    battlefields: state.battlefields.map((battlefield, at) =>
      at === index ? { ...battlefield, controller: player } : battlefield,
    ),
  };
}

describe('the Hide action (rule 421)', () => {
  it('421.1: puts the card facedown at a Battlefield you Control', () => {
    let state = withPower(game('hide-basic'), 1);
    const player = state.activePlayer;
    state = controlling(state, 0, player);
    const [withCard, lurker] = inHand(state, LURKER.id);
    state = reduce(withCard, { type: 'hide', card: lurker, battlefield: 0 }).state;

    expect(facedownAt(state, 0)).toBe(lurker);
    expect(state.players[player]!.zones.facedown).toContain(lurker);
    // 107.3.e: not a Location, so the card is not *at* the Battlefield.
    expect(state.battlefields[0]!.units).not.toContain(lurker);
    checkInvariants(state);
  });

  it('811.1.b: costs one [A], Power of any Domain', () => {
    let state = game('hide-cost');
    const player = state.activePlayer;
    state = controlling(state, 0, player);
    const [withCard, lurker] = inHand(state, LURKER.id);

    // No Power in the pool: the action is not offered and is refused.
    expect(legalActions(withCard, player).some((action) => action.type === 'hide')).toBe(false);
    expect(() => reduce(withCard, { type: 'hide', card: lurker, battlefield: 0 })).toThrow();

    const paid = reduce(withPower(withCard, 1), {
      type: 'hide',
      card: lurker,
      battlefield: 0,
    }).state;
    expect(paid.players[player]!.pool.power.fury).toBe(0);
  });

  it('107.3.c: refuses a Battlefield you do not Control', () => {
    const state = withPower(game('hide-control'), 1);
    const [withCard, lurker] = inHand(state, LURKER.id);
    // Nobody controls anything at the start of the game.
    expect(hideDestinations(withCard, withCard.activePlayer)).toEqual([]);
    expect(() => reduce(withCard, { type: 'hide', card: lurker, battlefield: 0 })).toThrow();
  });

  it('107.3.b: one card per Facedown Zone', () => {
    let state = withPower(game('hide-occupancy'), 5);
    const player = state.activePlayer;
    state = controlling(state, 0, player);
    const [a, first] = inHand(state, LURKER.id);
    const [b, second] = inHand(a, LURKER.id);
    state = reduce(b, { type: 'hide', card: first, battlefield: 0 }).state;

    expect(hideDestinations(state, player)).not.toContain(0);
    expect(() => reduce(state, { type: 'hide', card: second, battlefield: 0 })).toThrow();
  });

  it('refuses a card without the keyword', () => {
    let state = withPower(game('hide-keyword'), 1);
    state = controlling(state, 0, state.activePlayer);
    const [withCard, plain] = inHand(state, PLAIN.id);
    expect(() => reduce(withCard, { type: 'hide', card: plain, battlefield: 0 })).toThrow();
  });

  it('811.1.c.2: opens no Chain and does not move Priority', () => {
    let state = withPower(game('hide-chain'), 1);
    const player = state.activePlayer;
    state = controlling(state, 0, player);
    const [withCard, lurker] = inHand(state, LURKER.id);
    const after = reduce(withCard, { type: 'hide', card: lurker, battlefield: 0 }).state;

    expect(after.chain).toEqual([]);
    expect(after.priority).toBe(player);
  });
});

describe('playing from facedown (811.1.b, 811.1.d)', () => {
  /** Hide a Lurker at Battlefield 0 and return the state plus its id. */
  function hidden(seed: string, id: CardDefinition['id'] = LURKER.id): [GameState, EntityId] {
    let state = withPower(game(seed), 1);
    const player = state.activePlayer;
    state = controlling(state, 0, player);
    const [withCard, card] = inHand(state, id);
    return [reduce(withCard, { type: 'hide', card, battlefield: 0 }).state, card];
  }

  it('811.1.b: not on the turn it went down', () => {
    const [state, lurker] = hidden('face-sameturn');
    expect(playableFromFacedown(state, state.activePlayer)).not.toContain(lurker);
    expect(() => reduce(state, { type: 'playCard', card: lurker })).toThrow();
  });

  it('811.1.b: playable from the next turn on, ignoring its base cost', () => {
    const [down, lurker] = hidden('face-nextturn');
    const player = down.activePlayer;
    // A later turn, with an empty pool — the Lurker's printed cost is 5.
    const later: GameState = { ...down, turn: down.turn + 1 };

    expect(playableFromFacedown(later, player)).toContain(lurker);
    const after = reduce(later, { type: 'playCard', card: lurker }).state;
    // 811.1.d.1: a hidden Permanent enters at that Battlefield.
    expect(after.battlefields[0]!.units).toContain(lurker);
    expect(after.players[player]!.zones.facedown).not.toContain(lurker);
    // 421.4: out of the zone means revealed, so the association is gone.
    expect(after.entities[lurker]!.hiddenAt).toBeUndefined();
    checkInvariants(after);
  });

  it('811.1.d.2: may only choose at the Battlefield it was hidden at', () => {
    const [down, ambush] = hidden('face-target', AMBUSH.id);
    const player = down.activePlayer;
    let later: GameState = { ...down, turn: down.turn + 1 };

    // One Unit at the hidden Battlefield, one at another.
    const here = later.players[player]!.zones.mainDeck.find(
      (candidate) => later.entities[candidate]!.card === PLAIN.id,
    )!;
    later = moveEntity(later, here, battlefieldLocation(0));
    const elsewhere = later.players[player]!.zones.mainDeck.find(
      (candidate) => later.entities[candidate]!.card === PLAIN.id,
    )!;
    later = moveEntity(later, elsewhere, battlefieldLocation(1));

    const offered = legalActions(later, player)
      .filter((action) => action.type === 'playCard' && action.card === ambush)
      .map((action) => (action as { target?: EntityId }).target);
    expect(offered).toContain(here);
    expect(offered).not.toContain(elsewhere);
    expect(() =>
      reduce(later, { type: 'playCard', card: ambush, target: elsewhere }),
    ).toThrow();
  });

  it('811.3: the card can still be played from hand for its cost', () => {
    // Hidden is a permission, not a restriction — nothing above takes the
    // ordinary play away.
    let state = game('face-normal');
    const player = state.activePlayer;
    const [withCard] = inHand(state, AMBUSH.id);
    state = {
      ...withCard,
      players: withCard.players.map((seat) =>
        seat.id === player ? { ...seat, pool: { ...seat.pool, energy: 9 } } : seat,
      ),
    };
    // A target is needed, so put a Unit somewhere.
    const unit = state.players[player]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === PLAIN.id,
    )!;
    state = moveEntity(state, unit, battlefieldLocation(1));
    expect(legalActions(state, player).some((action) => action.type === 'playCard')).toBe(true);
  });
});

describe('the Facedown Zone empties (107.3.d, 421.4)', () => {
  it('107.3.d: a card whose Battlefield is lost is removed at the Cleanup', () => {
    let state = withPower(game('face-expire'), 1);
    const player = state.activePlayer;
    state = controlling(state, 0, player);
    const [withCard, lurker] = inHand(state, LURKER.id);
    state = reduce(withCard, { type: 'hide', card: lurker, battlefield: 0 }).state;

    // Control lapses, and the next Move's Cleanup sweeps the Facedown Zone.
    state = controlling(state, 0, (player === 0 ? 1 : 0) as PlayerId);
    const [withUnit, unit] = inHand(state, PLAIN.id);
    state = moveEntity(withUnit, unit, playerLocation(player, 'base'));
    state = reduce(
      { ...state, entities: { ...state.entities, [unit]: { ...state.entities[unit]!, exhausted: false } } },
      { type: 'moveUnits', units: [unit], to: battlefieldLocation(1) },
    ).state;

    expect(state.players[player]!.zones.facedown).not.toContain(lurker);
    expect(state.players[player]!.zones.trash).toContain(lurker);
    expect(state.entities[lurker]!.hiddenAt).toBeUndefined();
    checkInvariants(state);
  });
});

describe('what each player can see (107.3.f, 128.4)', () => {
  it('shows the Battlefield to everyone and the face only to its controller', () => {
    let state = withPower(game('face-view'), 1);
    const player = state.activePlayer;
    const other = (player === 0 ? 1 : 0) as PlayerId;
    state = controlling(state, 0, player);
    const [withCard, lurker] = inHand(state, LURKER.id);
    state = reduce(withCard, { type: 'hide', card: lurker, battlefield: 0 }).state;

    const mine = observe(state, player).players[player]!.facedown;
    const theirs = observe(state, other).players[player]!.facedown;

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    // 107.3.f: the zone is public, so both see that something is at 0.
    expect(mine[0]!.battlefield).toBe(0);
    expect(theirs[0]!.battlefield).toBe(0);
    // 128.4: only the controller may read the face.
    expect(mine[0]!.card).toBe(LURKER.id);
    expect(theirs[0]!.card).toBeNull();
    expect(theirs[0]!.might).toBeNull();
  });
});

/**
 * Predict (436) and Vision (817), plus scoring by effect (467-471).
 *
 * Predict lives here because it is the *other* hidden-information rule: it
 * opens a one-card window into the Main Deck, which is otherwise hidden from
 * everyone including its owner. 436.1 makes the look part of the action, so a
 * controller deciding blind would be playing a weaker card than the one printed.
 */
describe('Predict (436) and Vision (817)', () => {
  /** "VISION" — an optional Play Effect that Recycles from the top. */
  const SEER = makeUnit(2, ['fury'], {
    id: cardId('H-030'),
    name: 'Seer',
    cost: cost(1),
    abilities: {
      triggered: [
        {
          condition: { event: 'played', subject: 'self' },
          optional: true,
          effect: { target: { kind: 'none' }, effects: [{ kind: 'recycleTop', count: 1 }] },
        },
      ],
    },
  });

  /** "When I hold, you score 1 point." */
  const HOLDER = makeUnit(2, ['fury'], {
    id: cardId('H-031'),
    name: 'Holder',
    cost: cost(1),
    abilities: {
      triggered: [
        {
          condition: { event: 'hold', subject: 'you' },
          effect: { target: { kind: 'none' }, effects: [{ kind: 'score', amount: 1 }] },
        },
      ],
    },
  });

  const P_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    PLAIN,
    SEER,
    HOLDER,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function predictGame(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 8 }, () => PLAIN.id),
        ...Array.from({ length: 4 }, () => SEER.id),
        ...Array.from({ length: 4 }, () => HOLDER.id),
      ],
      runes: Array.from({ length: 8 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
    let state = createGame({ decks: [list, list], registry: P_REGISTRY, seed }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    return state;
  }

  /** Play a Seer from hand and stop on the pending Vision trigger. */
  function pendingVision(seed: string): { state: GameState; player: PlayerId } {
    let state = predictGame(seed);
    const player = state.activePlayer;
    const seer = state.players[player]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === SEER.id,
    )!;
    state = moveEntity(state, seer, playerLocation(player, 'hand'));
    state = {
      ...state,
      players: state.players.map((seat) =>
        seat.id === player ? { ...seat, pool: { ...seat.pool, energy: 5 } } : seat,
      ),
    };
    state = reduce(state, { type: 'playCard', card: seer }).state;
    return { state, player };
  }

  it('436.1: the controller sees the top card while deciding, and only then', () => {
    const { state, player } = pendingVision('predict-look');
    const other = (player === 0 ? 1 : 0) as PlayerId;

    // The pending trigger is the Predict, so the window is open.
    expect(state.chain[state.chain.length - 1]!.pending).toBe(true);
    const top = state.players[player]!.zones.mainDeck[0]!;
    expect(observe(state, player).players[player]!.predicting?.id).toBe(top);
    // 128: nobody else may look into a Main Deck, ever.
    expect(observe(state, other).players[player]!.predicting).toBeNull();
  });

  it('closes the window once the decision is made', () => {
    let { state, player } = pendingVision('predict-close');
    state = reduce(state, { type: 'resolveTrigger', perform: false }).state;
    expect(observe(state, player).players[player]!.predicting).toBeNull();
  });

  it('436.1: performing Recycles the top card to the bottom', () => {
    let { state, player } = pendingVision('predict-recycle');
    const deck = state.players[player]!.zones.mainDeck;
    const top = deck[0]!;
    const size = deck.length;

    state = reduce(state, { type: 'resolveTrigger', perform: true }).state;
    while (state.chain.length > 0) {
      state = reduce(state, { type: 'pass' }).state;
    }

    const after = state.players[player]!.zones.mainDeck;
    expect(after).toHaveLength(size);
    expect(after[0]).not.toBe(top);
    expect(after.at(-1)).toBe(top);
    checkInvariants(state);
  });

  it('436.1: declining leaves the deck exactly as it was', () => {
    let { state, player } = pendingVision('predict-decline');
    const before = [...state.players[player]!.zones.mainDeck];

    state = reduce(state, { type: 'resolveTrigger', perform: false }).state;
    while (state.chain.length > 0) {
      state = reduce(state, { type: 'pass' }).state;
    }
    expect(state.players[player]!.zones.mainDeck).toEqual(before);
  });

  it('436.4.a: an empty deck Predicts nothing and is not a Burn Out', () => {
    let { state, player } = pendingVision('predict-empty');
    // Empty the Main Deck without touching anything else.
    state = {
      ...state,
      players: state.players.map((seat) =>
        seat.id === player ? { ...seat, zones: { ...seat.zones, mainDeck: [] } } : seat,
      ),
    };
    const points = state.players.map((seat) => seat.points);

    state = reduce(state, { type: 'resolveTrigger', perform: true }).state;
    while (state.chain.length > 0) {
      state = reduce(state, { type: 'pass' }).state;
    }
    // A Burn Out would have handed an opponent a point (431.2.c).
    expect(state.players.map((seat) => seat.points)).toEqual(points);
  });
});

describe('scoring by effect (467-471)', () => {
  it('471.1.a.1: gains the point with no Final Point restriction', () => {
    // The restriction is Conquer's alone, so an effect can take a player to the
    // Victory Score with no extra condition — unlike a Conquer, which would
    // draw a card instead.
    const player = 0 as PlayerId;
    const events: GameEvent[] = [];
    const state = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: 'score-effect',
    }).state;
    const before = state.players[player]!.points;

    const after = executeEffect(
      state,
      { controller: player, source: 0 as EntityId, choices: {} },
      { target: { kind: 'none' }, effects: [{ kind: 'score', amount: 2 }] },
      events,
      {
        drawCards: (current) => current,
        queueDeaths: (current) => current,
        afterMove: (current) => current,
        raise: (current) => current,
      },
    );

    expect(after.players[player]!.points).toBe(before + 2);
    expect(events.some((event) => event.type === 'pointsScored')).toBe(true);
  });
});
