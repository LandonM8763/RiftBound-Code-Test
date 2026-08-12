/**
 * Combat.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * These tests exist mostly to pin down what Combat is *not*: there is no Might
 * comparison and no tie-destroys-everything rule, both of which community
 * summaries assert and a future session may be tempted to "fix" back in.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { assignDamage, combatResult, mightOf, sumMight } from './combat.js';
import { keywordsOf } from './statics.js';
import { checkInvariants } from './invariants.js';
import { moveEntity, withEntity } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import {
  battlefieldLocation,
  type EntityId,
  type GameState,
  isOver,
  isShowdown,
  playerId,
  playerLocation,
} from './state.js';

const LEGEND = makeLegend(['fury', 'calm'], { id: cardId('C-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('C-001'), champion: true });
const BIG = makeUnit(5, ['fury'], { id: cardId('C-010'), name: 'Big', cost: cost(1) });
const SMALL = makeUnit(2, ['fury'], { id: cardId('C-011'), name: 'Small', cost: cost(1) });
const FURY_RUNE = makeRune('fury', { id: cardId('C-100') });

// Keyword carriers. Assault and Shield are the same base Might as SMALL so the
// only thing a test can be measuring is the keyword.
const ASSAULT = makeUnit(2, ['fury'], {
  id: cardId('C-012'),
  name: 'Assaulter',
  cost: cost(1),
  keywords: [{ kind: 'assault', value: 3 }],
});
const SHIELDED = makeUnit(2, ['fury'], {
  id: cardId('C-013'),
  name: 'Shielded',
  cost: cost(1),
  keywords: [{ kind: 'shield', value: 3 }],
});
const TANK = makeUnit(2, ['fury'], {
  id: cardId('C-014'),
  name: 'Tanker',
  cost: cost(1),
  keywords: [{ kind: 'tank' }],
});
const BACKLINE = makeUnit(2, ['fury'], {
  id: cardId('C-015'),
  name: 'Backliner',
  cost: cost(1),
  keywords: [{ kind: 'backline' }],
});
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`C-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  BIG,
  SMALL,
  ASSAULT,
  SHIELDED,
  TANK,
  BACKLINE,
  FURY_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 8 }, () => BIG.id),
      ...Array.from({ length: 8 }, () => SMALL.id),
      ...Array.from({ length: 2 }, () => ASSAULT.id),
      ...Array.from({ length: 2 }, () => SHIELDED.id),
      ...Array.from({ length: 2 }, () => TANK.id),
      ...Array.from({ length: 2 }, () => BACKLINE.id),
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

function inMainPhase(seed = 'combat'): GameState {
  let state = pastMulligan(createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state);
  while (state.phase !== 'main' && !isOver(state)) {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  return state;
}

/** Place a ready Unit of `card` directly at a Battlefield, controlled by `owner`. */
function place(
  state: GameState,
  owner: number,
  card: CardDefinition,
  battlefield: number,
): [GameState, EntityId] {
  const player = playerId(owner);
  const id = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === card.id,
  );
  if (id === undefined) {
    throw new Error(`No ${card.name} left in player ${owner}'s deck`);
  }
  return [moveEntity(state, id, battlefieldLocation(battlefield)), id];
}

/**
 * A board where the defender already holds Battlefield 0, and the attacker has
 * a ready Unit at their Base poised to move in.
 */
function poised(
  attackerCard: CardDefinition,
  defenderCard: CardDefinition,
  seed = 'combat',
): { state: GameState; attacker: number; defender: number; mover: EntityId } {
  const start = inMainPhase(seed);
  const attacker = start.activePlayer;
  const defender = (attacker + 1) % start.players.length;

  const [withDefender] = place(start, defender, defenderCard, 0);
  const held: GameState = {
    ...withDefender,
    battlefields: withDefender.battlefields.map((battlefield, index) =>
      index === 0 ? { ...battlefield, controller: playerId(defender) } : battlefield,
    ),
  };

  const moverId = held.players[playerId(attacker)]!.zones.mainDeck.find(
    (candidate) => held.entities[candidate]!.card === attackerCard.id,
  );
  if (moverId === undefined) {
    throw new Error('No attacking Unit available');
  }
  const state = moveEntity(held, moverId, playerLocation(playerId(attacker), 'base'));

  return { state, attacker, defender, mover: moverId };
}

/** Move in, then pass Focus until the Combat resolves. */
function fight(setup: ReturnType<typeof poised>): GameState {
  let state = reduce(setup.state, {
    type: 'moveUnits',
    units: [setup.mover],
    to: battlefieldLocation(0),
  }).state;

  for (let i = 0; i < 10 && isShowdown(state); i += 1) {
    state = reduce(state, { type: 'pass' }).state;
  }
  return state;
}

describe('damage assignment (rule 465.2.c)', () => {
  it('assigns lethal to a Unit before moving to the next (465.2.c.3)', () => {
    let state = inMainPhase();
    const [a, first] = place(state, 0, SMALL, 0);
    state = a;
    const [b, second] = place(state, 0, SMALL, 0);
    state = b;

    // 5 damage among two 2-Might Units: 2 kills the first, 2 kills the second,
    // and the last point has nowhere lethal left to go.
    const assignment = assignDamage(state, 5, [first, second]);

    expect(assignment.get(first)).toBe(2);
    expect(assignment.get(second)).toBe(2);
  });

  it('does not overkill while other Units remain (465.2.c.4)', () => {
    let state = inMainPhase();
    const [a, first] = place(state, 0, BIG, 0);
    state = a;
    const [b, second] = place(state, 0, BIG, 0);
    state = b;

    // 5 Might exactly kills one 5-Might Unit and leaves nothing for the other.
    const assignment = assignDamage(state, 5, [first, second]);

    expect(assignment.get(first)).toBe(5);
    expect(assignment.get(second)).toBeUndefined();
  });

  it('gives the remainder to a Unit it cannot kill', () => {
    let state = inMainPhase();
    const [a, unit] = place(state, 0, BIG, 0);
    state = a;

    const assignment = assignDamage(state, 3, [unit]);

    expect(assignment.get(unit)).toBe(3);
  });

  it('accounts for damage already marked', () => {
    let state = inMainPhase();
    const [a, unit] = place(state, 0, BIG, 0);
    state = { ...a, entities: { ...a.entities, [unit]: { ...a.entities[unit]!, damage: 3 } } };

    // 5 Might, already on 3: two more is lethal.
    expect(assignDamage(state, 4, [unit]).get(unit)).toBe(2);
  });

  it('sums Might across a side (rule 465.2.a)', () => {
    let state = inMainPhase();
    const [a, big] = place(state, 0, BIG, 0);
    state = a;
    const [b, small] = place(state, 0, SMALL, 0);
    state = b;

    expect(sumMight(state, [big, small])).toBe(7);
  });
});

describe('the combat result (rule 466.3)', () => {
  const sides = {
    attacker: playerId(0),
    defender: playerId(1),
    attackingUnits: [],
    defendingUnits: [],
  };

  it('is a win for the only player with Units remaining', () => {
    expect(combatResult(true, false, false, sides)).toEqual({
      kind: 'won',
      winner: playerId(0),
      loser: playerId(1),
    });
    expect(combatResult(false, true, false, sides)).toEqual({
      kind: 'won',
      winner: playerId(1),
      loser: playerId(0),
    });
  });

  it('is No Result when both sides still have Units', () => {
    expect(combatResult(true, true, false, sides)).toEqual({ kind: 'noResult', reason: 'both' });
  });

  it('is No Result when neither side has Units', () => {
    // Community summaries call this "a tie destroys everything and nobody wins".
    // The destruction is a consequence of mutual lethal assignment, not a rule,
    // and the result is simply No Result.
    expect(combatResult(false, false, false, sides)).toEqual({
      kind: 'noResult',
      reason: 'neither',
    });
  });

  it('is No Result when Attackers were Recalled (466.1.a.2)', () => {
    expect(combatResult(true, true, true, sides)).toEqual({
      kind: 'noResult',
      reason: 'recalled',
    });
  });
});

describe('fighting a Combat end to end', () => {
  it('opens a Combat Showdown when Units meet (rule 344.1)', () => {
    const setup = poised(BIG, SMALL);
    const state = reduce(setup.state, {
      type: 'moveUnits',
      units: [setup.mover],
      to: battlefieldLocation(0),
    }).state;

    expect(state.showdown?.combat).toBe(true);
    expect(state.showdown?.attacker).toBe(playerId(setup.attacker));
    expect(state.showdown?.defender).toBe(playerId(setup.defender));
    // 464.2.d: the Attacker gains Focus.
    expect(state.showdown?.focus).toBe(playerId(setup.attacker));
  });

  it('kills the smaller side and takes the Battlefield', () => {
    // 5 Might attacker against a 2 Might defender: the defender dies, the
    // attacker survives on 2 damage which the Combat Cleanup then heals.
    const setup = poised(BIG, SMALL);
    const state = fight(setup);

    expect(isShowdown(state)).toBe(false);
    expect(state.battlefields[0]?.units).toEqual([setup.mover]);
    expect(state.entities[setup.mover]!.damage).toBe(0);
    expect(state.battlefields[0]?.controller).toBe(playerId(setup.attacker));
    checkInvariants(state);
  });

  it('scores a Conquer for establishing Control (rule 466.5.d)', () => {
    const setup = poised(BIG, SMALL);
    const state = fight(setup);

    expect(state.players[playerId(setup.attacker)]!.points).toBe(1);
    expect(state.battlefields[0]?.scoredBy).toEqual([playerId(setup.attacker)]);
  });

  it('destroys both sides when each assigns lethal, leaving nobody in Control', () => {
    // Two 2-Might Units: each assigns exactly lethal, and because assignment is
    // not dealing (465.2.c.1.a) both die simultaneously.
    const setup = poised(SMALL, SMALL);
    const state = fight(setup);

    expect(state.battlefields[0]?.units).toEqual([]);
    expect(state.battlefields[0]?.controller).toBeNull();
    // Nobody Conquered, so nobody scored.
    expect(state.players[playerId(setup.attacker)]!.points).toBe(0);
    expect(state.players[playerId(setup.defender)]!.points).toBe(0);
    checkInvariants(state);
  });

  it('leaves the defender holding when the attack is too small', () => {
    // A 2-Might attacker into a 5-Might defender: the defender takes 2 and
    // lives, the attacker takes 5 and dies.
    //
    // Note this is NOT the Recall case (466.1.a.2), which needs the Attacker to
    // survive while a Defender also survives. With vanilla Units that is
    // unreachable: Might is both the damage dealt and the damage survived, so
    // one side outlives the other exactly when it has more Might, and the
    // comparison cannot go both ways. Reaching a Recall in a real game needs
    // damage prevention or healing — that is, card effects. Until then
    // `combatResult` covers the Recall branch directly, above.
    const setup = poised(SMALL, BIG);
    const state = fight(setup);

    expect(state.battlefields[0]?.units).toHaveLength(1);
    expect(state.battlefields[0]?.controller).toBe(playerId(setup.defender));
    checkInvariants(state);
  });

  it('leaves the defender in Control after a No Result', () => {
    const setup = poised(SMALL, BIG);
    const state = fight(setup);

    // The defender already controlled it and never lost Units, so no Conquer.
    expect(state.players[playerId(setup.defender)]!.points).toBe(0);
  });

  it('heals every survivor in the Combat Cleanup (rule 466.1.a.1)', () => {
    const setup = poised(BIG, SMALL);
    const state = fight(setup);

    for (const unit of state.battlefields[0]?.units ?? []) {
      expect(state.entities[unit]!.damage).toBe(0);
    }
  });

  it('puts killed Units in their owner\'s trash (rule 428.2)', () => {
    const setup = poised(BIG, SMALL);
    const before = setup.state.players[playerId(setup.defender)]!.zones.trash.length;
    const state = fight(setup);

    expect(state.players[playerId(setup.defender)]!.zones.trash.length).toBe(before + 1);
  });

  it('reports the whole sequence as events', () => {
    const setup = poised(BIG, SMALL);
    let state = reduce(setup.state, {
      type: 'moveUnits',
      units: [setup.mover],
      to: battlefieldLocation(0),
    }).state;

    state = reduce(state, { type: 'pass' }).state;
    const result = reduce(state, { type: 'pass' });

    const types = result.events.map((event) => event.type);
    expect(types).toContain('combatDamage');
    expect(types).toContain('unitsKilled');
    expect(types).toContain('combatResolved');
    expect(types).toContain('controlEstablished');
  });

  it('lets a Combat happen at all, where movement once refused it', () => {
    // The guard that used to exclude occupied Battlefields is gone.
    const setup = poised(BIG, SMALL);
    expect(() =>
      reduce(setup.state, {
        type: 'moveUnits',
        units: [setup.mover],
        to: battlefieldLocation(0),
      }),
    ).not.toThrow();
  });
});

describe('Assault and Shield (rules 807, 814)', () => {
  it('adds Might only while the Unit has the matching designation', () => {
    const [state, unit] = place(inMainPhase('assault'), 0, ASSAULT, 0);

    // 807.1.d: the keyword applies while the Unit *has* the Attacker
    // designation, not whenever a Combat is happening — so the plain reading is
    // still the printed Might.
    expect(mightOf(state, unit)).toBe(2);
    expect(mightOf(state, unit, 'attacker')).toBe(5);
    expect(mightOf(state, unit, 'defender')).toBe(2);
  });

  it('gives Shield to the defender and nothing to the attacker (814.1.c)', () => {
    const [state, unit] = place(inMainPhase('shield'), 0, SHIELDED, 0);

    expect(mightOf(state, unit, 'defender')).toBe(5);
    expect(mightOf(state, unit, 'attacker')).toBe(2);
  });

  it('counts in the summed Might a side assigns (465.2.a)', () => {
    let state = inMainPhase('sum');
    const [a, assaulter] = place(state, 0, ASSAULT, 0);
    state = a;
    const [b, plain] = place(state, 0, SMALL, 0);
    state = b;

    expect(sumMight(state, [assaulter, plain])).toBe(4);
    expect(sumMight(state, [assaulter, plain], 'attacker')).toBe(7);
  });

  it('raises the damage a Unit survives, because Might is one stat', () => {
    // Might is both the damage dealt and the damage sustained, so a Shield that
    // only added to the damage dealt would be half a keyword.
    const [state, unit] = place(inMainPhase('survive'), 0, SHIELDED, 0);

    expect(assignDamage(state, 4, [unit]).get(unit)).toBe(2);
    expect(assignDamage(state, 4, [unit], 'defender').get(unit)).toBe(4);
  });

  it('turns a mutual kill into a won Combat', () => {
    // Both Units are 2 Might, so without Assault each kills the other and the
    // result is No Result with nobody in Control (466.3). Assault 3 makes the
    // Attacker a 5 that survives the 2 it takes, so it is the only side left.
    const mutual = fight(poised(SMALL, SMALL, 'mutual'));
    expect(mutual.battlefields[0]?.controller).toBeNull();

    const settled = fight(poised(ASSAULT, SMALL, 'assault-kill'));
    expect(settled.battlefields[0]?.controller).toBe(settled.activePlayer);
    checkInvariants(settled);
  });
});

describe('Tank and Backline (rules 815, 826)', () => {
  it('assigns lethal damage to a Tank before anything else (815.1.b)', () => {
    let state = inMainPhase('tank');
    // The plain Unit is placed first, so list order alone would take it first.
    const [a, plain] = place(state, 0, SMALL, 0);
    state = a;
    const [b, tank] = place(state, 0, TANK, 0);
    state = b;

    const assignment = assignDamage(state, 2, [plain, tank]);

    expect(assignment.get(tank)).toBe(2);
    expect(assignment.get(plain)).toBeUndefined();
  });

  it('assigns lethal damage to a Backline last (826.3)', () => {
    let state = inMainPhase('backline');
    const [a, back] = place(state, 0, BACKLINE, 0);
    state = a;
    const [b, plain] = place(state, 0, SMALL, 0);
    state = b;

    const assignment = assignDamage(state, 2, [back, plain]);

    expect(assignment.get(plain)).toBe(2);
    expect(assignment.get(back)).toBeUndefined();
  });

  it('still assigns lethal before moving on, within the keyword order', () => {
    // 815.1.c.1: the keywords reorder the targets; they do not relax 465.2.c.3.
    let state = inMainPhase('tank-lethal');
    const [a, plain] = place(state, 0, SMALL, 0);
    state = a;
    const [b, tank] = place(state, 0, TANK, 0);
    state = b;

    const assignment = assignDamage(state, 4, [plain, tank]);

    expect(assignment.get(tank)).toBe(2);
    expect(assignment.get(plain)).toBe(2);
  });

  it('orders a Tank ahead of a Backline', () => {
    let state = inMainPhase('both');
    const [a, back] = place(state, 0, BACKLINE, 0);
    state = a;
    const [b, plain] = place(state, 0, SMALL, 0);
    state = b;
    const [c, tank] = place(state, 0, TANK, 0);
    state = c;

    const assignment = assignDamage(state, 4, [back, plain, tank]);

    expect(assignment.get(tank)).toBe(2);
    expect(assignment.get(plain)).toBe(2);
    expect(assignment.get(back)).toBeUndefined();
  });
});

describe('static abilities (rules 363-365)', () => {
  /** "Other friendly units here have +2 Might." */
  const BANNER = makeUnit(1, ['fury'], {
    id: cardId('C-020'),
    name: 'Banner',
    cost: cost(1),
    abilities: {
      statics: [
        {
          affects: { who: 'friendly', here: true, excludeSelf: true },
          grant: { might: 2 },
        },
      ],
    },
  });

  /** "Other friendly units here have TANK." — a granted keyword (801.3.a). */
  const WARDEN = makeUnit(1, ['fury'], {
    id: cardId('C-021'),
    name: 'Warden',
    cost: cost(1),
    abilities: {
      statics: [
        {
          affects: { who: 'friendly', here: true, excludeSelf: true },
          grant: { keywords: [{ kind: 'tank' }] },
        },
      ],
    },
  });

  /** "While I'm buffed, I have an additional +3 Might." */
  const BERSERKER = makeUnit(2, ['fury'], {
    id: cardId('C-022'),
    name: 'Berserker',
    cost: cost(1),
    abilities: {
      statics: [{ affects: { who: 'self' }, grant: { might: 3 }, condition: { kind: 'buffed' } }],
    },
  });

  const STATIC_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    BIG,
    SMALL,
    ASSAULT,
    SHIELDED,
    TANK,
    BACKLINE,
    BANNER,
    WARDEN,
    BERSERKER,
    FURY_RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function staticGame(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 6 }, () => SMALL.id),
        ...Array.from({ length: 3 }, () => BIG.id),
        ...Array.from({ length: 3 }, () => BANNER.id),
        ...Array.from({ length: 3 }, () => WARDEN.id),
        ...Array.from({ length: 3 }, () => BERSERKER.id),
      ],
      runes: Array.from({ length: 8 }, () => FURY_RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
    let state = pastMulligan(
      createGame({ decks: [list, list], registry: STATIC_REGISTRY, seed }).state,
    );
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    return state;
  }

  it('adds Might to the Units in its scope, and not to itself', () => {
    let state = staticGame('banner');
    const [a, banner] = place(state, 0, BANNER, 0);
    state = a;
    const [b, ally] = place(state, 0, SMALL, 0);
    state = b;

    expect(mightOf(state, ally)).toBe(4); // 2 printed + 2 from the Banner
    expect(mightOf(state, banner)).toBe(1); // "Other": never itself
  });

  it('stops the moment the source leaves the Board (365)', () => {
    // Nothing is written onto the Unit, so nothing has to be cleaned up: the
    // answer simply changes. That is the point of consulting rather than
    // executing a static.
    let state = staticGame('leaves');
    const [a, banner] = place(state, 0, BANNER, 0);
    state = a;
    const [b, ally] = place(state, 0, SMALL, 0);
    state = b;
    expect(mightOf(state, ally)).toBe(4);

    const gone = moveEntity(state, banner, playerLocation(playerId(0), 'trash'));
    expect(mightOf(gone, ally)).toBe(2);
  });

  it('honours "here" — a Unit elsewhere is out of scope (355.9)', () => {
    let state = staticGame('here');
    const [a] = place(state, 0, BANNER, 0);
    state = a;
    const [b, elsewhere] = place(state, 0, SMALL, 1);
    state = b;

    expect(mightOf(state, elsewhere)).toBe(2);
  });

  it('does not reach an opponent`s Units', () => {
    let state = staticGame('friendly');
    const [a] = place(state, 0, BANNER, 0);
    state = a;
    const [b, theirs] = place(state, 1, SMALL, 0);
    state = b;

    expect(mightOf(state, theirs)).toBe(2);
  });

  it('grants a keyword, which the engine must read as though printed (801.3.a)', () => {
    let state = staticGame('grant');
    const [a, warden] = place(state, 0, WARDEN, 0);
    state = a;
    const [b, plain] = place(state, 0, SMALL, 0);
    state = b;

    // The Warden's own scope excludes itself, so exactly one of these two has
    // Tank — which is what makes the assignment order say something.
    expect(keywordsOf(state, plain)).toEqual([{ kind: 'tank' }]);
    expect(keywordsOf(state, warden)).toEqual([]);

    // The granted Tank must sort ahead in damage assignment exactly as a
    // printed one does (815.1.b), even though the Warden is listed first.
    const assignment = assignDamage(state, 2, [warden, plain]);
    expect(assignment.get(plain)).toBe(2);
    expect(assignment.get(warden)).toBeUndefined();
  });

  it('grants to everything in scope, not just the first', () => {
    let state = staticGame('grant-all');
    const [a] = place(state, 0, WARDEN, 0);
    state = a;
    const [b, first] = place(state, 0, SMALL, 0);
    state = b;
    const [c, second] = place(state, 0, BIG, 0);
    state = c;

    for (const unit of [first, second]) {
      expect(keywordsOf(state, unit)).toContainEqual({ kind: 'tank' });
    }
  });

  it('applies its condition to the source, not to what it affects', () => {
    let state = staticGame('while');
    const [placed, berserker] = place(state, 0, BERSERKER, 0);
    state = placed;
    expect(mightOf(state, berserker)).toBe(2);

    const buffed = withEntity(state, berserker, (current) => ({ ...current, buffs: 1 }));
    // 2 printed + 1 for the Buff (703) + 3 from the now-active static.
    expect(mightOf(buffed, berserker)).toBe(6);
  });

  it('counts toward the Might a side deals in Combat (465.2.a)', () => {
    let state = staticGame('sum');
    const [a, banner] = place(state, 0, BANNER, 0);
    state = a;
    const [b, ally] = place(state, 0, SMALL, 0);
    state = b;

    // 1 for the Banner, 2 printed + 2 granted for the ally.
    expect(sumMight(state, [banner, ally])).toBe(5);
  });

  it('floors the total at 0 for a negative static (143.2.b)', () => {
    const WEAKEN = makeUnit(1, ['fury'], {
      id: cardId('C-023'),
      name: 'Weaken',
      cost: cost(1),
      abilities: {
        statics: [{ affects: { who: 'enemy', here: true }, grant: { might: -9 } }],
      },
    });
    let state = staticGame('floor');
    state = {
      ...state,
      definitions: { ...state.definitions, [WEAKEN.id]: WEAKEN },
    };
    const [a, theirs] = place(state, 1, SMALL, 0);
    state = a;

    const entity = state.nextEntityId as EntityId;
    state = {
      ...state,
      nextEntityId: entity + 1,
      entities: {
        ...state.entities,
        [entity]: {
          id: entity,
          card: WEAKEN.id,
          owner: playerId(0),
          controller: playerId(0),
          location: battlefieldLocation(0),
          exhausted: false,
          damage: 0,
          mightBonus: 0,
          buffs: 0,
        },
      },
      battlefields: state.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, units: [...battlefield.units, entity] } : battlefield,
      ),
    };

    expect(mightOf(state, theirs)).toBe(0);
  });
});
