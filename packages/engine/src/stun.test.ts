/**
 * Stun (rule 423).
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The asymmetry is the whole mechanic and the easy thing to get backwards:
 * 423.1.b stops a Stunned Unit *dealing* combat damage, and 423.1.c leaves the
 * damage needed to *kill* it at its full Might. One of those reads the status
 * and the other must not.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeSpell, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { activatableAbilities } from './abilities.js';
import { hasLethalDamage, lethalRemaining, mightOf, sumMight } from './combat.js';
import { checkInvariants } from './invariants.js';
import { moveEntity, withEntity } from './mutate.js';
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

const LEGEND = makeLegend(['fury'], { id: cardId('S-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('S-001'), champion: true });
const BRUTE = makeUnit(4, ['fury'], { id: cardId('S-010'), name: 'Brute', cost: cost(1) });

/** "Stun a unit." */
const JOLT = makeSpell(['fury'], {
  id: cardId('S-020'),
  name: 'Jolt',
  cost: cost(1),
  timing: 'action',
  effect: { target: { kind: 'unit', scope: 'any' }, effects: [{ kind: 'stun' }] },
});

/** "When you stun an enemy unit, draw 1." — the rulebook's Eclipse Herald shape. */
const HERALD = makeUnit(2, ['fury'], {
  id: cardId('S-011'),
  name: 'Herald',
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: 'stun', subject: 'enemy' },
        effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
      },
    ],
  },
});

const RUNE = makeRune('fury', { id: cardId('S-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`S-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  BRUTE,
  JOLT,
  HERALD,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 8 }, () => BRUTE.id),
      ...Array.from({ length: 4 }, () => JOLT.id),
      ...Array.from({ length: 4 }, () => HERALD.id),
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

/** Put a card of `id` at a Battlefield, ready. */
function onField(state: GameState, id: CardDefinition['id'], at = 0): [GameState, EntityId] {
  const player = state.activePlayer;
  const card = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (card === undefined) {
    throw new Error(`No ${id} left`);
  }
  return [moveEntity(state, card, battlefieldLocation(at)), card];
}

function stun(state: GameState, unit: EntityId): GameState {
  return withEntity(state, unit, (current) => ({ ...current, stunned: true }));
}

describe('what Stun does and does not do (423.1.b, 423.1.c)', () => {
  it('423.1.b: a Stunned Unit contributes no Might to combat damage', () => {
    let state = game('stun-damage');
    const [placed, brute] = onField(state, BRUTE.id);
    state = placed;

    expect(sumMight(state, [brute])).toBe(4);
    state = stun(state, brute);
    expect(sumMight(state, [brute])).toBe(0);
  });

  it('423.1.c: killing it still takes damage equal to its full Might', () => {
    let state = game('stun-lethal');
    const [placed, brute] = onField(state, BRUTE.id);
    state = stun(placed, brute);

    // The Unit's own Might is untouched — only the damage it *deals* is.
    expect(mightOf(state, brute)).toBe(4);
    expect(lethalRemaining(state, brute)).toBe(4);

    const hurt = withEntity(state, brute, (current) => ({ ...current, damage: 3 }));
    expect(hasLethalDamage(hurt, brute)).toBe(false);
    const dead = withEntity(state, brute, (current) => ({ ...current, damage: 4 }));
    expect(hasLethalDamage(dead, brute)).toBe(true);
  });

  it('sums only the unstunned side', () => {
    let state = game('stun-sum');
    const [a, first] = onField(state, BRUTE.id);
    const [b, second] = onField(a, BRUTE.id);
    state = stun(b, first);

    expect(sumMight(state, [first, second])).toBe(4);
  });
});

describe('the stun effect and its trigger (423.1.a)', () => {
  /** Run one `stun` effect through the reducer by playing Jolt. */
  function jolt(seed: string): { state: GameState; unit: EntityId; drawn: number } {
    let state = game(seed);
    const player = state.activePlayer;
    const [placed, target] = onField(state, BRUTE.id);
    state = placed;
    // The Herald watches for an *enemy* unit being stunned, so it belongs to
    // the other player while the Brute stays with the active one.
    const other = (player === 0 ? 1 : 0) as PlayerId;
    const herald = state.players[other]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === HERALD.id,
    )!;
    state = moveEntity(state, herald, battlefieldLocation(0));

    const spell = state.players[player]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === JOLT.id,
    )!;
    state = moveEntity(state, spell, playerLocation(player, 'hand'));
    state = {
      ...state,
      players: state.players.map((seat) =>
        seat.id === player ? { ...seat, pool: { ...seat.pool, energy: 5 } } : seat,
      ),
    };
    const before = state.players[other]!.zones.hand.length;
    state = reduce(state, { type: 'playCard', card: spell, target }).state;
    while (state.chain.length > 0) {
      state = reduce(state, { type: 'pass' }).state;
    }
    return { state, unit: target, drawn: state.players[other]!.zones.hand.length - before };
  }

  it('stuns the chosen Unit and fires the watching trigger', () => {
    const { state, unit, drawn } = jolt('stun-effect');
    expect(state.entities[unit]!.stunned).toBe(true);
    expect(drawn).toBe(1);
    checkInvariants(state);
  });

  it('423.1.a.1: stunning an already-Stunned Unit is inert and does not trigger', () => {
    // The rulebook's own Eclipse Herald example: choosing a Unit that is
    // already Stunned is legal, but nothing happens and nothing triggers.
    const first = jolt('stun-twice');
    let state = first.state;
    const other = state.activePlayer === 0 ? 1 : 0;

    const spell = state.players[state.activePlayer]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === JOLT.id,
    )!;
    state = moveEntity(state, spell, playerLocation(state.activePlayer, 'hand'));
    state = {
      ...state,
      players: state.players.map((seat) =>
        seat.id === state.activePlayer ? { ...seat, pool: { ...seat.pool, energy: 5 } } : seat,
      ),
    };
    const before = state.players[other]!.zones.hand.length;
    state = reduce(state, { type: 'playCard', card: spell, target: first.unit }).state;
    while (state.chain.length > 0) {
      state = reduce(state, { type: 'pass' }).state;
    }

    expect(state.entities[first.unit]!.stunned).toBe(true);
    expect(state.players[other]!.zones.hand.length - before).toBe(0);
  });
});

describe('Stun expires (423.1.a.2)', () => {
  it('clears in the end-of-turn Cleanup, beside the "this turn" effects', () => {
    let state = game('stun-expire');
    const [placed, brute] = onField(state, BRUTE.id);
    state = stun(placed, brute);
    expect(state.entities[brute]!.stunned).toBe(true);

    state = reduce(state, { type: 'endTurn' }).state;
    while (state.phase === 'ending' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    expect(state.entities[brute]!.stunned).toBe(false);
    checkInvariants(state);
  });
});

describe('what each player can see (rule 274)', () => {
  it('Stunned is public, like Exhausted', () => {
    let state = game('stun-view');
    const player = state.activePlayer;
    const other = (player === 0 ? 1 : 0) as PlayerId;
    const [placed, brute] = onField(state, BRUTE.id);
    state = stun(placed, brute);

    for (const viewer of [player, other] as const) {
      const seen = observe(state, viewer).battlefields[0]!.units.find((u) => u.id === brute);
      expect(seen?.stunned).toBe(true);
      // 423.1.c: the Unit's Might is unchanged, so the view still reports it.
      expect(seen?.might).toBe(4);
    }
  });
});

/**
 * Rule 383.3.c: a Triggered Ability raised *during* a Chain item's resolution
 * goes on the Chain and resolves after it.
 *
 * This lived here because Stun is what surfaced it, but it was never about
 * Stun: the Chain was rebuilt from the pre-resolution copy, so every trigger a
 * resolving effect queued was created, reported, and then thrown away. A
 * Deathknell from a Kill Instruction and "when you buff" from a Buff were doing
 * the same thing.
 */
describe('triggers raised during resolution reach the Chain (383.3.c)', () => {
  it('a Spell that stuns leaves the watcher`s trigger on the Chain', () => {
    let state = game('stun-chain');
    const player = state.activePlayer;
    const other = (player === 0 ? 1 : 0) as PlayerId;
    const [placed, brute] = onField(state, BRUTE.id);
    state = placed;

    const herald = state.players[other]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === HERALD.id,
    )!;
    state = moveEntity(state, herald, battlefieldLocation(0));
    const spell = state.players[player]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === JOLT.id,
    )!;
    state = moveEntity(state, spell, playerLocation(player, 'hand'));
    state = {
      ...state,
      players: state.players.map((seat) =>
        seat.id === player ? { ...seat, pool: { ...seat.pool, energy: 5 } } : seat,
      ),
    };

    state = reduce(state, { type: 'playCard', card: spell, target: brute }).state;
    // Both players pass, and the Spell resolves.
    state = reduce(state, { type: 'pass' }).state;
    state = reduce(state, { type: 'pass' }).state;

    // The Spell has gone, and the trigger it woke is what is left standing.
    expect(state.chain).toHaveLength(1);
    expect(state.chain[0]!.entity).toBe(herald);
    checkInvariants(state);
  });
});

/**
 * Non-resource ability costs (356.7, 416, 428).
 *
 * 416.3's payability gate is the load-bearing half, and the rulebook states it
 * as a worked example: Vi Destructive "can't activate the ability, because
 * they can't pay its cost" with an empty trash.
 */
describe('non-resource ability costs', () => {
  /** "Recycle 1 from your trash: Give me +1 Might this turn." — Vi Destructive. */
  const RECYCLER = makeUnit(2, ['fury'], {
    id: cardId('S-030'),
    name: 'Recycler',
    cost: cost(1),
    abilities: {
      activated: [
        {
          cost: cost(0),
          exhaustSelf: false,
          payments: [{ kind: 'recycle', count: 1 }],
          effect: { target: { kind: 'self' }, effects: [{ kind: 'giveMight', amount: 1 }] },
        },
      ],
    },
  });

  /** "Kill this: Draw 1." */
  const SACRIFICE = makeUnit(1, ['fury'], {
    id: cardId('S-031'),
    name: 'Sacrifice',
    cost: cost(1),
    abilities: {
      activated: [
        {
          cost: cost(0),
          exhaustSelf: false,
          payments: [{ kind: 'killSelf' }],
          effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
        },
      ],
    },
  });

  const COST_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    BRUTE,
    RECYCLER,
    SACRIFICE,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function costGame(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 8 }, () => BRUTE.id),
        ...Array.from({ length: 4 }, () => RECYCLER.id),
        ...Array.from({ length: 4 }, () => SACRIFICE.id),
      ],
      runes: Array.from({ length: 8 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
    let state = createGame({ decks: [list, list], registry: COST_REGISTRY, seed }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    return state;
  }

  function place(state: GameState, id: CardDefinition['id']): [GameState, EntityId] {
    const player = state.activePlayer;
    const card = state.players[player]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === id,
    )!;
    return [moveEntity(state, card, playerLocation(player, 'base')), card];
  }

  it('416.3: an empty trash makes the ability unusable', () => {
    // The rulebook's own Vi Destructive example.
    const [state, unit] = place(costGame('cost-empty'), RECYCLER.id);
    expect(state.players[state.activePlayer]!.zones.trash).toHaveLength(0);
    expect(
      activatableAbilities(state, state.activePlayer).filter((a) => a.source === unit),
    ).toHaveLength(0);
  });

  it('416.1: paying puts the card on the bottom of its owner`s Main Deck', () => {
    let state = costGame('cost-recycle');
    const player = state.activePlayer;
    const [placed, unit] = place(state, RECYCLER.id);
    // One card in the trash, so the cost is payable exactly once.
    const spare = placed.players[player]!.zones.mainDeck.find(
      (candidate) => placed.entities[candidate]!.card === BRUTE.id,
    )!;
    state = moveEntity(placed, spare, playerLocation(player, 'trash'));

    const offered = activatableAbilities(state, player).filter((a) => a.source === unit);
    expect(offered).toHaveLength(1);

    const deckBefore = state.players[player]!.zones.mainDeck.length;
    state = reduce(state, { type: 'activateAbility', source: unit, index: 0 }).state;

    expect(state.players[player]!.zones.trash).toHaveLength(0);
    expect(state.players[player]!.zones.mainDeck).toHaveLength(deckBefore + 1);
    // 416.1: the bottom, not the top — it must not be the next card drawn.
    expect(state.players[player]!.zones.mainDeck.at(-1)).toBe(spare);
    // And the cost is spent: with the trash empty it cannot be paid again.
    expect(activatableAbilities(state, player).filter((a) => a.source === unit)).toHaveLength(0);
    checkInvariants(state);
  });

  it('428: "Kill this" sends the source to the trash as the cost', () => {
    let state = costGame('cost-kill');
    const player = state.activePlayer;
    const [placed, unit] = place(state, SACRIFICE.id);
    state = placed;

    expect(activatableAbilities(state, player).filter((a) => a.source === unit)).toHaveLength(1);
    state = reduce(state, { type: 'activateAbility', source: unit, index: 0 }).state;

    expect(state.players[player]!.zones.trash).toContain(unit);
    expect(state.players[player]!.zones.base).not.toContain(unit);
    checkInvariants(state);
  });
});
