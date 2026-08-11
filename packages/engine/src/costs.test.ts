/**
 * Determining Total Cost.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import {
  CardRegistry,
  cardId,
  cost,
  type CardDefinition,
  type CostModifier,
} from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeSpell, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { activeModifiers, applyModifiers, baseCost, totalCost, type ActiveModifier } from './costs.js';
import { legalActions } from './legal.js';
import { moveEntity } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import {
  getPlayer,
  playerId,
  playerLocation,
  type EntityId,
  type GameState,
  type PlayerId,
} from './state.js';

const SEAT_0 = playerId(0);
const SEAT_1 = playerId(1);

/** Wrap changes as if a card the given player controls were supplying them. */
function mods(
  controller: PlayerId,
  ...changes: readonly CostModifier['change'][]
): ActiveModifier[] {
  return changes.map((change) => ({
    controller,
    modifier: { applies: { scope: 'any' }, change },
  }));
}

const apply = (
  base: Parameters<typeof applyModifiers>[0],
  active: readonly ActiveModifier[],
  type: Parameters<typeof applyModifiers>[1] = 'unit',
) => applyModifiers(base, type, SEAT_0, active);

describe('rule 356.1: base cost modifications', () => {
  it('replaces the Base Cost outright (356.1.a)', () => {
    const result = apply(cost(5, 'fury'), mods(SEAT_0, { kind: 'replaceBase', cost: cost(1) }));
    expect(result).toEqual(cost(1));
  });

  it('sets both components to zero when the cost is ignored (356.1.b.1)', () => {
    const result = apply(cost(4, 'fury', 'calm'), mods(SEAT_0, { kind: 'ignoreBase', component: 'both' }));
    expect(result).toEqual({ energy: 0, power: [] });
  });

  it('ignores only the named component (356.1.b.2)', () => {
    expect(apply(cost(4, 'fury'), mods(SEAT_0, { kind: 'ignoreBase', component: 'energy' }))).toEqual(
      { energy: 0, power: ['fury'] },
    );
    expect(apply(cost(4, 'fury'), mods(SEAT_0, { kind: 'ignoreBase', component: 'power' }))).toEqual(
      { energy: 4, power: [] },
    );
  });

  it('lets a later layer raise an ignored cost back above zero (356.1.b.3)', () => {
    // The rulebook's Legion Rearguard case: the Base Cost is ignored, but a
    // cost added afterwards still has to be paid.
    const result = apply(
      cost(2),
      mods(SEAT_0, { kind: 'ignoreBase', component: 'both' }, { kind: 'increase', energy: 1, power: ['fury'] }),
    );
    expect(result).toEqual({ energy: 1, power: ['fury'] });
  });

  it('leaves the printed Base Cost alone (356.1.c)', () => {
    // Effects that refer to "Base Cost" mean the printed one, so the card
    // definition must not be mutated by any of this.
    const card = makeUnit(3, ['fury'], { cost: cost(5) });
    apply(card.cost, mods(SEAT_0, { kind: 'discount', energy: 3 }));
    expect(baseCost(card)).toEqual(cost(5));
  });
});

describe('rule 356.3: cost increases', () => {
  it('raises the Energy cost', () => {
    expect(apply(cost(2), mods(SEAT_0, { kind: 'increase', energy: 2 }))).toEqual(cost(4));
  });

  it('adds Power pips', () => {
    expect(apply(cost(1), mods(SEAT_0, { kind: 'increase', power: ['calm'] }))).toEqual(
      cost(1, 'calm'),
    );
  });

  it('applies before discounts, not after (356.3 then 356.4)', () => {
    // Order matters here only because a discount can floor; the layer order is
    // what guarantees the increase is already in the total when it does.
    const result = apply(
      cost(3),
      mods(SEAT_0, { kind: 'discount', energy: 1 }, { kind: 'increase', energy: 2 }),
    );
    expect(result).toEqual(cost(4));
  });
});

describe('rule 356.4: discounts', () => {
  it('reduces the Energy cost', () => {
    expect(apply(cost(5), mods(SEAT_0, { kind: 'discount', energy: 2 }))).toEqual(cost(3));
  });

  it('removes a Power pip of the named Domain', () => {
    expect(apply(cost(1, 'fury', 'calm'), mods(SEAT_0, { kind: 'discount', power: ['fury'] }))).toEqual(
      cost(1, 'calm'),
    );
  });

  it('cannot reduce a cost below zero (356.6)', () => {
    expect(apply(cost(2), mods(SEAT_0, { kind: 'discount', energy: 5 }))).toEqual(cost(0));
  });

  it('respects its own minimum (356.4.e)', () => {
    expect(apply(cost(8), mods(SEAT_0, { kind: 'discount', energy: 1, minimumEnergy: 1 }))).toEqual(
      cost(7),
    );
    expect(apply(cost(3), mods(SEAT_0, { kind: 'discount', energy: 5, minimumEnergy: 1 }))).toEqual(
      cost(1),
    );
  });

  it('never raises a cost that is already under the minimum', () => {
    // A minimum is a floor on the reduction, not a price the card must reach.
    expect(apply(cost(0), mods(SEAT_0, { kind: 'discount', energy: 1, minimumEnergy: 2 }))).toEqual(
      cost(0),
    );
  });

  it('binds its minimum to itself, so a later discount can go under it (356.4.e)', () => {
    // The rulebook's worked example. Eager Apprentice reduces Energy by 1 to a
    // minimum of 1; Sky Splitter costs 8 and reduces its own cost by 7.
    // Applying the bounded discount first gives 8 -> 7 -> 0. The other order
    // gives 8 -> 1 -> 1, and the rules let the player pick — so the engine
    // takes the favourable one.
    const result = apply(
      cost(8),
      mods(
        SEAT_0,
        { kind: 'discount', energy: 7 },
        { kind: 'discount', energy: 1, minimumEnergy: 1 },
      ),
    );
    expect(result).toEqual(cost(0));
  });

  it('reaches the same answer whichever order the modifiers are found in', () => {
    const forwards = apply(
      cost(8),
      mods(SEAT_0, { kind: 'discount', energy: 1, minimumEnergy: 1 }, { kind: 'discount', energy: 7 }),
    );
    const backwards = apply(
      cost(8),
      mods(SEAT_0, { kind: 'discount', energy: 7 }, { kind: 'discount', energy: 1, minimumEnergy: 1 }),
    );
    expect(forwards).toEqual(backwards);
  });
});

describe('rule 356.5: total cost modifications', () => {
  it('sets the whole cost to zero, increases included (356.5.a)', () => {
    const result = apply(
      cost(4, 'fury'),
      mods(SEAT_0, { kind: 'increase', energy: 3 }, { kind: 'ignoreAll' }),
    );
    expect(result).toEqual({ energy: 0, power: [] });
  });

  it('applies after discounts, so nothing can undo it', () => {
    const result = apply(
      cost(4),
      mods(SEAT_0, { kind: 'ignoreAll' }, { kind: 'discount', energy: 1 }),
    );
    expect(result).toEqual(cost(0));
  });
});

describe('which cards a modifier applies to', () => {
  const discount: CostModifier['change'] = { kind: 'discount', energy: 1 };

  it('filters by card type', () => {
    const spellsOnly: ActiveModifier[] = [
      { controller: SEAT_0, modifier: { applies: { scope: 'any', types: ['spell'] }, change: discount } },
    ];
    expect(applyModifiers(cost(3), 'spell', SEAT_0, spellsOnly)).toEqual(cost(2));
    expect(applyModifiers(cost(3), 'unit', SEAT_0, spellsOnly)).toEqual(cost(3));
  });

  it('an empty type list means every type', () => {
    const anyType: ActiveModifier[] = [
      { controller: SEAT_0, modifier: { applies: { scope: 'any', types: [] }, change: discount } },
    ];
    expect(applyModifiers(cost(3), 'gear', SEAT_0, anyType)).toEqual(cost(2));
  });

  it('a friendly-scoped modifier helps only its own controller', () => {
    const friendly: ActiveModifier[] = [
      { controller: SEAT_0, modifier: { applies: { scope: 'friendly' }, change: discount } },
    ];
    expect(applyModifiers(cost(3), 'unit', SEAT_0, friendly)).toEqual(cost(2));
    expect(applyModifiers(cost(3), 'unit', SEAT_1, friendly)).toEqual(cost(3));
  });

  it('an any-scoped modifier taxes everyone', () => {
    const symmetric: ActiveModifier[] = [
      {
        controller: SEAT_0,
        modifier: { applies: { scope: 'any' }, change: { kind: 'increase', energy: 1 } },
      },
    ];
    expect(applyModifiers(cost(3), 'unit', SEAT_0, symmetric)).toEqual(cost(4));
    expect(applyModifiers(cost(3), 'unit', SEAT_1, symmetric)).toEqual(cost(4));
  });
});

describe('ability costs (rule 403)', () => {
  const discount: CostModifier['change'] = { kind: 'discount', energy: 1 };

  it('are modified by a modifier that names abilities', () => {
    const forAbilities: ActiveModifier[] = [
      {
        controller: SEAT_0,
        modifier: { applies: { scope: 'friendly', types: ['ability'] }, change: discount },
      },
    ];
    expect(applyModifiers(cost(2), 'ability', SEAT_0, forAbilities)).toEqual(cost(1));
  });

  it('are untouched by an unqualified card modifier', () => {
    // "Cards cost 1 less" is not a statement about Activated Abilities, so an
    // unqualified modifier must not silently discount them.
    const forCards: ActiveModifier[] = [
      { controller: SEAT_0, modifier: { applies: { scope: 'friendly' }, change: discount } },
    ];
    expect(applyModifiers(cost(2), 'ability', SEAT_0, forCards)).toEqual(cost(2));
    expect(applyModifiers(cost(2), 'unit', SEAT_0, forCards)).toEqual(cost(1));
  });

  it('are untouched by a modifier naming only card types', () => {
    const unitsOnly: ActiveModifier[] = [
      {
        controller: SEAT_0,
        modifier: { applies: { scope: 'friendly', types: ['unit'] }, change: discount },
      },
    ];
    expect(applyModifiers(cost(2), 'ability', SEAT_0, unitsOnly)).toEqual(cost(2));
  });
});

// --- Integration through a real game state -------------------------------

const DISCOUNTER_MODS: readonly CostModifier[] = [
  { applies: { scope: 'friendly', types: ['unit'] }, change: { kind: 'discount', energy: 1 } },
];

const LEGEND = makeLegend(['fury'], { id: cardId('C-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('C-001'), champion: true });
/** "Units you play cost [1] less" — a Passive Ability (363). */
const DISCOUNTER = makeUnit(2, ['fury'], {
  id: cardId('C-010'),
  name: 'Discounter',
  cost: cost(1),
  abilities: { costModifiers: DISCOUNTER_MODS },
});
const EXPENSIVE = makeUnit(4, ['fury'], {
  id: cardId('C-011'),
  name: 'Expensive',
  cost: cost(3),
});
const SPELL = makeSpell(['fury'], { id: cardId('C-012'), name: 'Spell', cost: cost(3) });
const RUNE = makeRune('fury', { id: cardId('C-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`C-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  DISCOUNTER,
  EXPENSIVE,
  SPELL,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: Array.from({ length: 14 }, () => EXPENSIVE.id),
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function inMainPhase(seed = 'costs', energy = 2): GameState {
  let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state;
  while (state.phase === 'mulligan') {
    state = reduce(state, { type: 'mulligan', cards: [] }).state;
  }
  while (state.phase !== 'main') {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  const player = state.activePlayer;
  return {
    ...state,
    players: state.players.map((seat) =>
      seat.id === player ? { ...seat, pool: { energy, power: seat.pool.power } } : seat,
    ),
  };
}

/** Mint a card into a zone under `owner`. */
function withCard(
  state: GameState,
  id: CardDefinition['id'],
  zone: 'base' | 'hand' | 'trash',
  owner?: PlayerId,
): [GameState, EntityId] {
  const player = owner ?? state.activePlayer;
  const entity = state.nextEntityId as EntityId;
  const placed: GameState = {
    ...state,
    nextEntityId: state.nextEntityId + 1,
    definitions: { ...state.definitions, [id]: REGISTRY.mustGet(id) },
    entities: {
      ...state.entities,
      [entity]: {
        id: entity,
        card: id,
        owner: player,
        controller: player,
        location: playerLocation(player, 'base'),
        exhausted: false,
        damage: 0,
        mightBonus: 0,
        buffs: 0,
      },
    },
    players: state.players.map((seat) =>
      seat.id === player
        ? { ...seat, zones: { ...seat.zones, base: [...seat.zones.base, entity] } }
        : seat,
    ),
  };
  return [
    zone === 'base' ? placed : moveEntity(placed, entity, playerLocation(player, zone)),
    entity,
  ];
}

describe('cost modification in play', () => {
  it('reports the printed cost when nothing modifies it', () => {
    const state = inMainPhase();
    expect(totalCost(state, state.activePlayer, EXPENSIVE)).toEqual(cost(3));
  });

  it('applies a Passive Ability from a card on the Board (365.1)', () => {
    const [state] = withCard(inMainPhase(), DISCOUNTER.id, 'base');
    expect(totalCost(state, state.activePlayer, EXPENSIVE)).toEqual(cost(2));
  });

  it('ignores the same ability while the card is in hand or trash (365.1)', () => {
    for (const zone of ['hand', 'trash'] as const) {
      const [state] = withCard(inMainPhase(), DISCOUNTER.id, zone);
      expect(activeModifiers(state)).toEqual([]);
      expect(totalCost(state, state.activePlayer, EXPENSIVE)).toEqual(cost(3));
    }
  });

  it('applies a modifier on a Unit at a Battlefield', () => {
    const [placed, entity] = withCard(inMainPhase(), DISCOUNTER.id, 'base');
    const state = moveEntity(placed, entity, { kind: 'battlefield', index: 0 });
    expect(totalCost(state, state.activePlayer, EXPENSIVE)).toEqual(cost(2));
  });

  it('does not discount a card type the modifier excludes', () => {
    const [state] = withCard(inMainPhase(), DISCOUNTER.id, 'base');
    expect(totalCost(state, state.activePlayer, SPELL)).toEqual(cost(3));
  });

  it('does not help the opponent when the modifier is friendly-scoped', () => {
    const [state] = withCard(inMainPhase(), DISCOUNTER.id, 'base');
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    expect(totalCost(state, opponent, EXPENSIVE)).toEqual(cost(3));
  });

  it('stacks two copies of the same modifier', () => {
    const [one] = withCard(inMainPhase(), DISCOUNTER.id, 'base');
    const [two] = withCard(one, DISCOUNTER.id, 'base');
    expect(totalCost(two, two.activePlayer, EXPENSIVE)).toEqual(cost(1));
  });

  it('makes a card playable that the pool could not otherwise afford', () => {
    // Two Energy, a card printed at three: unplayable until the discount lands.
    const withoutDiscount = withCard(inMainPhase('afford', 2), EXPENSIVE.id, 'hand');
    const before = legalActions(withoutDiscount[0], withoutDiscount[0].activePlayer).filter(
      (action) => action.type === 'playCard' && action.card === withoutDiscount[1],
    );
    expect(before).toEqual([]);

    const [state, card] = withCard(withoutDiscount[0], DISCOUNTER.id, 'base');
    const after = legalActions(state, state.activePlayer).filter(
      (action) => action.type === 'playCard' && action.card === withoutDiscount[1],
    );
    expect(after).toHaveLength(1);
    expect(card).toBeGreaterThanOrEqual(0);
  });

  it('charges the modified cost, not the printed one', () => {
    const [base] = withCard(inMainPhase('charge', 3), DISCOUNTER.id, 'base');
    const [state, card] = withCard(base, EXPENSIVE.id, 'hand');
    const player = state.activePlayer;

    const played = reduce(state, { type: 'playCard', card }).state;
    // 3 Energy in the pool, 3 printed, 1 discounted away: 1 Energy left.
    expect(getPlayer(played, player).pool.energy).toBe(1);
  });
});

describe('ability cost modification in play', () => {
  /** "[2]: Draw 1", with a friendly ability discount printed on the same card. */
  const CHEAP_ABILITY = makeUnit(2, ['fury'], {
    id: cardId('C-013'),
    name: 'Cheap Ability',
    cost: cost(1),
    abilities: {
      activated: [
        {
          cost: cost(2),
          effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
        },
      ],
      costModifiers: [
        { applies: { scope: 'friendly', types: ['ability'] }, change: { kind: 'discount', energy: 1 } },
      ],
    },
  });

  const registry = CardRegistry.from([
    LEGEND,
    CHAMPION,
    DISCOUNTER,
    EXPENSIVE,
    SPELL,
    RUNE,
    CHEAP_ABILITY,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function game(energy: number): [GameState, EntityId] {
    let state = createGame({ decks: [deck(), deck()], registry, seed: 'ability-cost' }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main') {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    const player = state.activePlayer;
    const entity = state.nextEntityId as EntityId;
    const withSource: GameState = {
      ...state,
      nextEntityId: state.nextEntityId + 1,
      definitions: { ...state.definitions, [CHEAP_ABILITY.id]: CHEAP_ABILITY },
      entities: {
        ...state.entities,
        [entity]: {
          id: entity,
          card: CHEAP_ABILITY.id,
          owner: player,
          controller: player,
          location: playerLocation(player, 'base'),
          exhausted: false,
          damage: 0,
          mightBonus: 0,
          buffs: 0,
        },
      },
      players: state.players.map((seat) =>
        seat.id === player
          ? {
              ...seat,
              pool: { energy, power: seat.pool.power },
              zones: { ...seat.zones, base: [...seat.zones.base, entity] },
            }
          : seat,
      ),
    };
    return [withSource, entity];
  }

  it('charges the discounted ability cost (403.2)', () => {
    const [state, source] = game(2);
    const player = state.activePlayer;

    const activated = reduce(state, { type: 'activateAbility', source, index: 0 }).state;
    // Printed 2, discounted to 1: one Energy left of the two.
    expect(getPlayer(activated, player).pool.energy).toBe(1);
  });

  it('makes an ability activatable that the pool could not otherwise afford', () => {
    // One Energy against a printed cost of two.
    const [state, source] = game(1);
    const offered = legalActions(state, state.activePlayer).filter(
      (action) => action.type === 'activateAbility' && action.source === source,
    );
    expect(offered).toHaveLength(1);
  });
});
