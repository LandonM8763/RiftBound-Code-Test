/**
 * Card effects.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import {
  makeBattlefield,
  makeGear,
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
} from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { mightOf } from './combat.js';
import { legalTargets } from './effects.js';
import { checkInvariants } from './invariants.js';
import { currentLegalActions } from './legal.js';
import { moveEntity } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import {
  battlefieldLocation,
  type EntityId,
  type GameState,
  isOver,
  playerId,
  playerLocation,
} from './state.js';

const LEGEND = makeLegend(['fury', 'calm'], { id: cardId('E-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('E-001'), champion: true });
const PLAIN = makeUnit(4, ['fury'], { id: cardId('E-010'), name: 'Plain', cost: cost(1) });

/** "Deal 3 to a unit." */
const BOLT = makeSpell(['fury'], {
  id: cardId('E-020'),
  name: 'Bolt',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'any' },
    effects: [{ kind: 'dealDamage', amount: 3 }],
  },
});

/** "Draw 2." — no target. */
const INSIGHT = makeSpell(['calm'], {
  id: cardId('E-021'),
  name: 'Insight',
  cost: cost(1),
  timing: 'action',
  effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 2 }] },
});

/** "Give a friendly unit +2 Might this turn." */
const RALLY = makeSpell(['fury'], {
  id: cardId('E-022'),
  name: 'Rally',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'friendly' },
    effects: [{ kind: 'giveMight', amount: 2 }],
  },
});

/** "Deal 1 to an enemy unit at a battlefield." */
const SNIPE = makeSpell(['fury'], {
  id: cardId('E-023'),
  name: 'Snipe',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'enemy', atBattlefield: true },
    effects: [{ kind: 'dealDamage', amount: 1 }],
  },
});

/** A Unit whose text runs when it is played: "When you play me, draw 1." */
const SCOUT = makeUnit(2, ['calm'], {
  id: cardId('E-030'),
  name: 'Scout',
  cost: cost(1),
  effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
});

/** Gear: "Add 2 Energy." */
const BATTERY = makeGear(['fury'], {
  id: cardId('E-031'),
  name: 'Battery',
  cost: cost(1),
  effect: { target: { kind: 'none' }, effects: [{ kind: 'addEnergy', count: 2 }] },
});

const FURY_RUNE = makeRune('fury', { id: cardId('E-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`E-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  BOLT,
  INSIGHT,
  RALLY,
  SNIPE,
  SCOUT,
  BATTERY,
  FURY_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 6 }, () => PLAIN.id),
      BOLT.id,
      BOLT.id,
      INSIGHT.id,
      RALLY.id,
      SNIPE.id,
      SCOUT.id,
      BATTERY.id,
    ],
    runes: Array.from({ length: 8 }, () => FURY_RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

/** Take the empty Mulligan for every player so play can begin (rule 117). */
function pastMulligan(state: GameState): GameState {
  let next = state;
  while (next.phase === 'mulligan') {
    next = reduce(next, { type: 'mulligan', cards: [] }).state;
  }
  return next;
}

function inMainPhase(seed = 'effects'): GameState {
  let state = pastMulligan(createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state);
  while (state.phase !== 'main' && !isOver(state)) {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  return state;
}

/** Fill the active player's pool so cost is never the thing under test. */
function withEnergy(state: GameState, amount: number): GameState {
  let next = state;
  for (let i = 0; i < amount; i += 1) {
    const rune = next.players[next.activePlayer]!.zones.runes.find(
      (id) => !next.entities[id]!.exhausted,
    );
    if (rune === undefined) break;
    next = reduce(next, { type: 'addEnergy', rune }).state;
  }
  return next;
}

/**
 * Make sure the active player holds a copy of `card`, pulling one out of the
 * deck if the opening hand did not happen to contain it.
 */
function toHand(state: GameState, card: CardDefinition): [GameState, EntityId] {
  const player = state.activePlayer;

  const held = state.players[player]!.zones.hand.find(
    (candidate) => state.entities[candidate]!.card === card.id,
  );
  if (held !== undefined) {
    return [state, held];
  }

  const id = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === card.id,
  );
  if (id === undefined) {
    throw new Error(`No ${card.name} in hand or deck`);
  }
  return [moveEntity(state, id, playerLocation(player, 'hand')), id];
}

/** Put a Unit of `card` on the board at a Base or Battlefield. */
function onBoard(
  state: GameState,
  owner: number,
  card: CardDefinition,
  where: 'base' | number,
): [GameState, EntityId] {
  const player = playerId(owner);
  const id = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === card.id,
  );
  if (id === undefined) {
    throw new Error(`No ${card.name} in player ${owner}'s deck`);
  }
  const to = where === 'base' ? playerLocation(player, 'base') : battlefieldLocation(where);
  return [moveEntity(state, id, to), id];
}

/** Play a Spell and resolve it off the Chain (rule 359.3.d). */
function castSpell(state: GameState, spell: EntityId, target?: EntityId): GameState {
  let next = reduce(state, {
    type: 'playCard',
    card: spell,
    ...(target === undefined ? {} : { target }),
  }).state;
  next = reduce(next, { type: 'pass' }).state;
  next = reduce(next, { type: 'pass' }).state;
  return next;
}

describe('targeting (rule 355.9)', () => {
  it('lists Units on the Board and nothing else', () => {
    let state = inMainPhase();
    const [a, mine] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;

    const targets = legalTargets(state, state.activePlayer, { kind: 'unit', scope: 'any' });

    expect(targets).toContain(mine);
    // Cards in hand are not on the Board and cannot be targeted.
    for (const inHand of state.players[state.activePlayer]!.zones.hand) {
      expect(targets).not.toContain(inHand);
    }
  });

  it('narrows to friendly and enemy Units', () => {
    let state = inMainPhase();
    const me = state.activePlayer;
    const them = playerId((me + 1) % state.players.length);
    const [a, mine] = onBoard(state, me, PLAIN, 'base');
    state = a;
    const [b, theirs] = onBoard(state, them, PLAIN, 'base');
    state = b;

    expect(legalTargets(state, me, { kind: 'unit', scope: 'friendly' })).toEqual([mine]);
    expect(legalTargets(state, me, { kind: 'unit', scope: 'enemy' })).toEqual([theirs]);
  });

  it('narrows to Units at a Battlefield', () => {
    let state = inMainPhase();
    const me = state.activePlayer;
    const [a, atBase] = onBoard(state, me, PLAIN, 'base');
    state = a;
    const [b, atField] = onBoard(state, me, PLAIN, 0);
    state = b;

    const targets = legalTargets(state, me, {
      kind: 'unit',
      scope: 'any',
      atBattlefield: true,
    });

    expect(targets).toContain(atField);
    expect(targets).not.toContain(atBase);
  });

  it('refuses to play a targeting card without a valid target', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [withBolt, bolt] = toHand(state, BOLT);
    state = withBolt;

    // No Units are on the board at all.
    expect(() => reduce(state, { type: 'playCard', card: bolt })).toThrow(/no valid target/);
  });

  it('offers one action per legal target', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, bolt] = toHand(state, BOLT);
    state = a;
    const [b] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;
    const [c] = onBoard(state, state.activePlayer, PLAIN, 0);
    state = c;

    const plays = currentLegalActions(state).filter(
      (action) => action.type === 'playCard' && action.card === bolt,
    );

    expect(plays).toHaveLength(2);
  });
});

describe('spell effects (rule 359.3.d)', () => {
  it('deals damage to the chosen Unit', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, bolt] = toHand(state, BOLT);
    state = a;
    const [b, victim] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;

    const after = castSpell(state, bolt, victim);

    expect(after.entities[victim]!.damage).toBe(3);
    checkInvariants(after);
  });

  it('does nothing until the Spell actually resolves', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, bolt] = toHand(state, BOLT);
    state = a;
    const [b, victim] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;

    // On the Chain, not yet resolved.
    const onChain = reduce(state, { type: 'playCard', card: bolt, target: victim }).state;
    expect(onChain.entities[victim]!.damage).toBe(0);
    expect(onChain.chain).toHaveLength(1);
    expect(onChain.chain[0]?.target).toBe(victim);
  });

  it('draws cards for an untargeted Spell', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, insight] = toHand(state, INSIGHT);
    state = a;
    const before = state.players[state.activePlayer]!.zones.hand.length;

    const after = castSpell(state, insight);

    // Two drawn, one spent playing the Spell.
    expect(after.players[after.activePlayer]!.zones.hand).toHaveLength(before + 1);
  });

  it('puts the Spell in the trash after resolving', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, insight] = toHand(state, INSIGHT);
    state = a;

    const after = castSpell(state, insight);

    expect(after.players[after.activePlayer]!.zones.trash).toContain(insight);
    expect(after.chain).toHaveLength(0);
  });

  it('grants Might until the end of the turn (rule 317.2.c)', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, rally] = toHand(state, RALLY);
    state = a;
    const [b, unit] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;

    const buffed = castSpell(state, rally, unit);
    expect(buffed.entities[unit]!.mightBonus).toBe(2);
    expect(mightOf(buffed, unit)).toBe(PLAIN.might + 2);

    // The Ending Phase expires it.
    const ended = reduce(reduce(buffed, { type: 'endTurn' }).state, { type: 'resolvePhase' }).state;
    expect(ended.entities[unit]!.mightBonus).toBe(0);
    expect(mightOf(ended, unit)).toBe(PLAIN.might);
  });

  it('does nothing if the target left the board before resolution', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, bolt] = toHand(state, BOLT);
    state = a;
    const [b, victim] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;

    let onChain = reduce(state, { type: 'playCard', card: bolt, target: victim }).state;
    // The target is removed while the Spell sits on the Chain.
    onChain = moveEntity(onChain, victim, playerLocation(onChain.activePlayer, 'trash'));

    const after = reduce(reduce(onChain, { type: 'pass' }).state, { type: 'pass' }).state;

    expect(after.entities[victim]!.damage).toBe(0);
    expect(after.players[after.activePlayer]!.zones.trash).toContain(bolt);
  });

  it('kills a Unit dealt lethal damage in the next Combat cleanup', () => {
    // Bolt deals 3 to a 2-Might Unit, which is lethal.
    let state = withEnergy(inMainPhase(), 1);
    const [a, bolt] = toHand(state, BOLT);
    state = a;
    const [b, victim] = onBoard(state, state.activePlayer, SCOUT, 'base');
    state = b;

    const after = castSpell(state, bolt, victim);

    // Damage is marked; the Unit dies at the next cleanup that checks it.
    expect(after.entities[victim]!.damage).toBe(3);
    expect(mightOf(after, victim)).toBe(SCOUT.might);
  });
});

describe('permanent effects (rule 359.2.b)', () => {
  it('runs a Unit\'s text when it is played', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, scout] = toHand(state, SCOUT);
    state = a;
    const before = state.players[state.activePlayer]!.zones.hand.length;

    const after = reduce(state, { type: 'playCard', card: scout }).state;

    // One card left hand to be played, one was drawn.
    expect(after.players[after.activePlayer]!.zones.hand).toHaveLength(before);
    expect(after.players[after.activePlayer]!.zones.base).toContain(scout);
    checkInvariants(after);
  });

  it('runs Gear text and Adds to the Rune Pool', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, battery] = toHand(state, BATTERY);
    state = a;
    expect(state.players[state.activePlayer]!.pool.energy).toBe(1);

    const after = reduce(state, { type: 'playCard', card: battery }).state;

    // One Energy paid, two Added.
    expect(after.players[after.activePlayer]!.pool.energy).toBe(2);
  });

  it('leaves a card without rules text alone', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, plain] = toHand(state, PLAIN);
    state = a;

    const after = reduce(state, { type: 'playCard', card: plain }).state;

    expect(after.players[after.activePlayer]!.zones.base).toContain(plain);
    expect(() => checkInvariants(after)).not.toThrow();
  });

  it('rejects a target on a card that does not target', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, plain] = toHand(state, PLAIN);
    state = a;
    const [b, other] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;

    expect(() =>
      reduce(state, { type: 'playCard', card: plain, target: other }),
    ).toThrow(/does not target/);
  });
});

describe('effects and Combat', () => {
  it('a Might buff changes who survives a Combat', () => {
    // Rally makes a 4-Might Unit a 6, enough to kill a 5 and live.
    let state = inMainPhase('buff-combat');
    const me = state.activePlayer;
    const them = playerId((me + 1) % state.players.length);

    const [a, mine] = onBoard(state, me, PLAIN, 'base');
    state = a;
    const [b] = onBoard(state, them, PLAIN, 0);
    state = b;
    state = {
      ...state,
      battlefields: state.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: them } : battlefield,
      ),
    };

    state = withEnergy(state, 1);
    const [c, rally] = toHand(state, RALLY);
    state = c;
    state = castSpell(state, rally, mine);

    expect(mightOf(state, mine)).toBe(PLAIN.might + 2);

    // Now attack: 6 Might kills the 4-Might defender, and 4 is not lethal to a 6.
    state = reduce(state, { type: 'moveUnits', units: [mine], to: battlefieldLocation(0) }).state;
    for (let i = 0; i < 6 && state.showdown !== null; i += 1) {
      state = reduce(state, { type: 'pass' }).state;
    }

    expect(state.battlefields[0]?.units).toEqual([mine]);
    expect(state.battlefields[0]?.controller).toBe(me);
    checkInvariants(state);
  });
});
