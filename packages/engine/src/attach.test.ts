/**
 * Attachment (rules 434-435, 716-719, 724).
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The direction is what to keep straight: a Gear is what gets Attached, and the
 * *Unit* becomes the Top-Most Card (818.1.b.2). So the Gear's Effect Text reads
 * as though printed on the Unit — 718.3 for its abilities, 718.4 for its Might.
 */
import {
  CardRegistry,
  cardId,
  cost,
  totalRuneCost,
  type CardDefinition,
  type TargetSpec,
} from '@riftbound/cards';
import {
  makeBattlefield,
  makeGear,
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
} from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { activatableAbilities } from './abilities.js';
import { attach, attachmentsOf, detach } from './attach.js';
import { mightOf } from './combat.js';
import { executeEffect } from './effects.js';
import { totalCost } from './costs.js';
import { legalActions } from './legal.js';
import { canPay, payFrom, validUnitLocations } from './play.js';
import { checkInvariants } from './invariants.js';
import { moveEntity } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import { keywordsOf, unitKeywordValue } from './statics.js';
import { sendToNonBoardZone } from './token.js';
import {
  battlefieldLocation,
  isOver,
  playerLocation,
  type EntityId,
  type GameState,
  type PlayerId,
} from './state.js';

const LEGEND = makeLegend(['fury'], { id: cardId('A-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('A-001'), champion: true });
const PLAIN = makeUnit(2, ['fury'], { id: cardId('A-010'), name: 'Plain', cost: cost(1) });

/** "EQUIP Fury / ASSAULT 2 / Might +0" — a real Serrated Dirk. */
const DIRK = makeGear(['fury'], {
  id: cardId('A-020'),
  name: 'Dirk',
  cost: cost(1),
  attached: { mightBonus: 0, keywords: [{ kind: 'assault', value: 2 }] },
});

/** "Might +2" and nothing else — a Long Sword. */
const SWORD = makeGear(['fury'], {
  id: cardId('A-021'),
  name: 'Sword',
  cost: cost(1),
  attached: { mightBonus: 2 },
});

const RUNE = makeRune('fury', { id: cardId('A-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`A-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  DIRK,
  SWORD,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 8 }, () => PLAIN.id),
      ...Array.from({ length: 4 }, () => DIRK.id),
      ...Array.from({ length: 4 }, () => SWORD.id),
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

/** Put a card of `id` onto the active player's Base. */
function onBoard(state: GameState, id: CardDefinition['id']): [GameState, EntityId] {
  const player = state.activePlayer;
  const card = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (card === undefined) {
    throw new Error(`No ${id} left`);
  }
  return [moveEntity(state, card, playerLocation(player, 'base')), card];
}

describe('attaching and detaching (434-435)', () => {
  it('records the link in one direction only', () => {
    let state = game('attach-link');
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, gear] = onBoard(a, DIRK.id);
    state = attach(b, gear, unit);

    // 718.5.d: one Top-Most Card at a time, so the id is stored on the
    // attached card and the reverse direction is a sweep.
    expect(state.entities[gear]!.attachedTo).toBe(unit);
    expect(attachmentsOf(state, unit)).toEqual([gear]);
    expect(state.entities[unit]!.attachedTo).toBeUndefined();
    checkInvariants(state);
  });

  it('434.1.f: attaching to a new Top-Most Card leaves the old one', () => {
    let state = game('attach-move');
    const [a, first] = onBoard(state, PLAIN.id);
    const [b, second] = onBoard(a, PLAIN.id);
    const [c, gear] = onBoard(b, DIRK.id);

    state = attach(c, gear, first);
    state = attach(state, gear, second);

    expect(attachmentsOf(state, first)).toEqual([]);
    expect(attachmentsOf(state, second)).toEqual([gear]);
  });

  it('434.1.g / 435.1.a.1: re-attaching and detaching nothing do nothing', () => {
    let state = game('attach-noop');
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, gear] = onBoard(a, DIRK.id);

    const attached = attach(b, gear, unit);
    expect(attach(attached, gear, unit)).toBe(attached);
    expect(detach(b, gear)).toBe(b);
  });

  it('refuses a link that would close a loop', () => {
    let state = game('attach-cycle');
    const [a, one] = onBoard(state, DIRK.id);
    const [b, two] = onBoard(a, SWORD.id);
    state = attach(b, one, two);

    // Attaching the Top-Most Card to what is already attached to it would make
    // `attachmentsOf` describe an impossible board.
    expect(attach(state, two, one)).toBe(state);
    expect(attach(state, one, one)).toBe(state);
  });
});

describe('what a Top-Most Card gains (718.3-718.4)', () => {
  it('718.4: the Might Bonus modulates the Top-Most Card`s Might', () => {
    let state = game('attach-might');
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, sword] = onBoard(a, SWORD.id);

    expect(mightOf(state, unit)).toBe(2);
    state = attach(b, sword, unit);
    expect(mightOf(state, unit)).toBe(4);

    // 435.1.e: detaching takes it away again.
    state = detach(state, sword);
    expect(mightOf(state, unit)).toBe(2);
  });

  it('718.3: Effect Text keywords read as though printed on the Unit', () => {
    let state = game('attach-keywords');
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, dirk] = onBoard(a, DIRK.id);

    expect(keywordsOf(state, unit)).toEqual([]);
    state = attach(b, dirk, unit);

    // The Gear lends Assault to the Unit, not to itself.
    expect(unitKeywordValue(state, unit, 'assault')).toBe(2);
    expect(unitKeywordValue(state, dirk, 'assault')).toBe(0);
    // 807.1.c: Assault is Might while attacking.
    expect(mightOf(state, unit, 'attacker')).toBe(4);
  });

  it('stacks two attachments (718.4, 807.2)', () => {
    let state = game('attach-two');
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, sword] = onBoard(a, SWORD.id);
    const [c, dirk] = onBoard(b, DIRK.id);

    state = attach(c, sword, unit);
    state = attach(state, dirk, unit);

    expect(attachmentsOf(state, unit)).toHaveLength(2);
    expect(mightOf(state, unit)).toBe(4);
    expect(unitKeywordValue(state, unit, 'assault')).toBe(2);
  });
});

describe('attachments follow their Top-Most Card', () => {
  it('719.3: attaching puts them at the same Location', () => {
    let state = game('attach-location');
    let [a, unit] = onBoard(state, PLAIN.id);
    a = moveEntity(a, unit, battlefieldLocation(0));
    const [b, gear] = onBoard(a, DIRK.id);

    state = attach(b, gear, unit);

    expect(state.entities[gear]!.location).toEqual(battlefieldLocation(0));
    checkInvariants(state);
  });

  it('719.5: they leave the Board with it', () => {
    let state = game('attach-death');
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, gear] = onBoard(a, DIRK.id);
    state = attach(b, gear, unit);

    const owner = state.entities[unit]!.owner;
    state = sendToNonBoardZone(state, unit, playerLocation(owner, 'trash'));

    expect(state.players[owner]!.zones.trash).toContain(unit);
    expect(state.players[owner]!.zones.trash).toContain(gear);
    // 435.1.b: it is no longer Attached to anything.
    expect(state.entities[gear]!.attachedTo).toBeUndefined();
    checkInvariants(state);
  });
});

/**
 * 718.2 and 718.3 as they apply to *abilities*, which is the half that decides
 * whether an Equipment does anything at all. Might and keywords are read by
 * `mightOf` and `keywordsOf` above; an ability has to be found by the trigger
 * sweep, the activation sweep and the static sweep, and each of those reads a
 * card rather than a Game Object unless told otherwise.
 */
describe('abilities move with the attachment (718.2-718.3)', () => {
  const SELF: TargetSpec = { kind: 'self' };

  /** "EQUIP Fury" — an Activated Ability that Attaches this Gear. */
  const EQUIPPER = makeGear(['fury'], {
    id: cardId('A-030'),
    name: 'Equipper',
    cost: cost(1),
    abilities: {
      activated: [
        {
          cost: cost(0),
          exhaustSelf: false,
          effect: { target: { kind: 'unit', scope: 'friendly' }, effects: [{ kind: 'attach' }] },
        },
      ],
    },
    attached: { mightBonus: 1 },
  });

  /** "When I conquer, draw 1" printed in the Effect Text, not the Rules Text. */
  const LENDER = makeGear(['fury'], {
    id: cardId('A-031'),
    name: 'Lender',
    cost: cost(1),
    attached: {
      abilities: {
        statics: [{ affects: { who: 'self' }, grant: { keywords: [{ kind: 'tank' }] } }],
        activated: [{ cost: cost(0), exhaustSelf: true, effect: { target: SELF, effects: [{ kind: 'ready' }] } }],
      },
    },
  });

  const LENDER_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    PLAIN,
    EQUIPPER,
    LENDER,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function lenderDeck(): DeckList {
    return {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 8 }, () => PLAIN.id),
        ...Array.from({ length: 4 }, () => EQUIPPER.id),
        ...Array.from({ length: 4 }, () => LENDER.id),
      ],
      runes: Array.from({ length: 8 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
  }

  function lenderGame(seed: string): GameState {
    let state = createGame({
      decks: [lenderDeck(), lenderDeck()],
      registry: LENDER_REGISTRY,
      seed,
    }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    return state;
  }

  it('718.2: an Attached Gear stops offering its own Activated Ability', () => {
    let state = lenderGame('attach-inactive');
    const player = state.activePlayer;
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, gear] = onBoard(a, EQUIPPER.id);
    state = b;

    const mine = (): number =>
      activatableAbilities(state, player).filter((entry) => entry.source === gear).length;
    expect(mine()).toBe(1);

    // Once Equipped, its printed Rules Text is Inactive — otherwise it could
    // re-activate Equip and walk itself onto another Unit.
    state = attach(state, gear, unit);
    expect(mine()).toBe(0);
  });

  it('718.3: the Top-Most Card gains the Effect Text`s Activated Ability', () => {
    let state = lenderGame('attach-activated');
    const player = state.activePlayer;
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, gear] = onBoard(a, LENDER.id);
    state = attach(b, gear, unit);

    const lent = activatableAbilities(state, player).filter((entry) => entry.source === unit);
    expect(lent).toHaveLength(1);
    // 377.3.a.1 keeps the text on the Gear, so the ability records where to
    // read it from while belonging to the Unit.
    expect(lent[0]!.from).toBe(gear);
  });

  it('718.3: and its Static, which reads as though printed on the Unit', () => {
    let state = lenderGame('attach-static');
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, gear] = onBoard(a, LENDER.id);

    expect(keywordsOf(b, unit)).toEqual([]);
    state = attach(b, gear, unit);
    // `affects: self` on the Gear's Effect Text means the equipped Unit,
    // because 718.3 appends the ability to *that card's* Rules Text.
    expect(keywordsOf(state, unit)).toEqual([{ kind: 'tank' }]);
    expect(keywordsOf(state, gear)).toEqual([]);
  });

  it('818.1.c.2: activating Equip actually Attaches the Gear', () => {
    let state = lenderGame('attach-equip');
    const player = state.activePlayer;
    const [a, unit] = onBoard(state, PLAIN.id);
    const [b, gear] = onBoard(a, EQUIPPER.id);
    state = { ...b, priority: player };

    const equip = activatableAbilities(state, player).find((entry) => entry.source === gear);
    expect(equip).toBeDefined();
    state = reduce(state, {
      type: 'activateAbility',
      source: gear,
      index: equip!.index,
      target: unit,
    }).state;
    // The ability is on the Chain; resolving it performs the Attach.
    while (state.chain.length > 0) {
      state = reduce(state, { type: 'pass' }).state;
    }

    expect(state.entities[gear]!.attachedTo).toBe(unit);
    expect(mightOf(state, unit)).toBe(3);
    checkInvariants(state);
  });
});

/**
 * Weaponmaster (821) and `[A]`, Power of any Domain (135.2.e.5).
 *
 * These are one piece of work because the keyword's reduction is stated in
 * `[A]`, and `Cost` had no way to say it. The reduction is also the half that
 * does nothing on any Equipment printed so far — 821.1.c.3 says a cost with no
 * `[A]` in it "will not be reduced", and every printed Equip cost is Energy
 * plus a named Domain.
 */
/**
 * Run one Weaponmaster equip effect.
 *
 * `executeEffect` rather than the reducer, because what is under test is the
 * payment and the Attach; the trigger reaching the Chain with a chosen target
 * is `abilities.test.ts`'s subject and the fuzz harness's.
 */
function executeEffectFor(
  state: GameState,
  controller: number,
  source: EntityId,
  target: EntityId,
): GameState {
  return executeEffect(
    state,
    { controller: controller as never, source, choices: { target } },
    { target: { kind: 'gear', scope: 'friendly' }, effects: [{ kind: 'equip', discountAnyPower: 1 }] },
    [],
    {
      drawCards: (current) => current,
      queueDeaths: (current) => current,
      afterMove: (current) => current,
      raise: (current) => current,
    },
  );
}

describe('Weaponmaster (821)', () => {
  /** "EQUIP Fury" — cost 1 Fury Power, so a pool of one Fury pip pays it. */
  const SWORD_EQUIP = makeGear(['fury'], {
    id: cardId('A-040'),
    name: 'Equip Sword',
    cost: cost(1),
    abilities: {
      activated: [
        {
          cost: cost(0, 'fury'),
          exhaustSelf: false,
          effect: { target: { kind: 'unit', scope: 'friendly' }, effects: [{ kind: 'attach' }] },
        },
      ],
    },
    attached: { mightBonus: 2 },
  });

  /** A Gear with no Equip ability at all — 821.1.c.4's case. */
  const INERT = makeGear(['fury'], { id: cardId('A-041'), name: 'Inert', cost: cost(1) });

  const WEAPONMASTER = makeUnit(2, ['fury'], {
    id: cardId('A-042'),
    name: 'Weaponmaster',
    cost: cost(1),
    abilities: {
      triggered: [
        {
          condition: { event: 'played', subject: 'self' },
          optional: true,
          effect: {
            target: { kind: 'gear', scope: 'friendly' },
            effects: [{ kind: 'equip', discountAnyPower: 1 }],
          },
        },
      ],
    },
  });

  const WM_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    PLAIN,
    SWORD_EQUIP,
    INERT,
    WEAPONMASTER,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function wmGame(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 6 }, () => PLAIN.id),
        ...Array.from({ length: 4 }, () => SWORD_EQUIP.id),
        ...Array.from({ length: 3 }, () => INERT.id),
        ...Array.from({ length: 3 }, () => WEAPONMASTER.id),
      ],
      runes: Array.from({ length: 8 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
    let state = createGame({ decks: [list, list], registry: WM_REGISTRY, seed }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    return state;
  }

  /** Give the active player enough Fury Power to pay an Equip cost. */
  function withFury(state: GameState, amount: number): GameState {
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

  it('821.1.c: pays the chosen Equipment`s own Equip cost and Attaches it', () => {
    let state = withFury(wmGame('wm-pay'), 1);
    const player = state.activePlayer;
    const [a, gear] = onBoard(state, SWORD_EQUIP.id);
    const [b, unit] = onBoard(a, WEAPONMASTER.id);
    state = b;

    state = executeEffectFor(state, player, unit, gear);

    // The *Gear* is attached to the *Unit* — the opposite direction from Equip.
    expect(state.entities[gear]!.attachedTo).toBe(unit);
    expect(mightOf(state, unit)).toBe(4);
    // 1 Fury Power spent.
    expect(state.players[player]!.pool.power.fury).toBe(0);
    checkInvariants(state);
  });

  it('821.1.c.5: an unpayable cost leaves the Equipment exactly where it was', () => {
    let state = withFury(wmGame('wm-broke'), 0);
    const [a, gear] = onBoard(state, SWORD_EQUIP.id);
    const [b, unit] = onBoard(a, WEAPONMASTER.id);
    const before = b;

    const after = executeEffectFor(before, before.activePlayer, unit, gear);
    expect(after.entities[gear]!.attachedTo).toBeUndefined();
  });

  it('821.1.c.4: a chosen card with no Equip ability cannot pay one', () => {
    let state = withFury(wmGame('wm-inert'), 5);
    const [a, gear] = onBoard(state, INERT.id);
    const [b, unit] = onBoard(a, WEAPONMASTER.id);

    const after = executeEffectFor(b, b.activePlayer, unit, gear);
    expect(after.entities[gear]!.attachedTo).toBeUndefined();
    // Nothing was paid either.
    expect(after.players[b.activePlayer]!.pool.power.fury).toBe(5);
  });

  it('821.1.c.3: a cost with no [A] in it is not reduced', () => {
    // The Equip cost is 1 Fury Power, not `[A]`, so the discount removes
    // nothing and the Fury still has to be paid.
    let state = withFury(wmGame('wm-noreduce'), 0);
    const [a, gear] = onBoard(state, SWORD_EQUIP.id);
    const [b, unit] = onBoard(a, WEAPONMASTER.id);
    expect(executeEffectFor(b, b.activePlayer, unit, gear).entities[gear]!.attachedTo).toBeUndefined();
  });
});

describe('[A], Power of any Domain (135.2.e.5)', () => {
  const POOL = {
    energy: 2,
    power: { fury: 1, calm: 1, mind: 0, body: 0, chaos: 0, order: 0 },
  };

  it('135.2.e.5.a: is paid by Power of any Domain', () => {
    expect(canPay(POOL, { energy: 0, power: [], anyPower: 2 })).toBe(true);
    expect(canPay(POOL, { energy: 0, power: [], anyPower: 3 })).toBe(false);
  });

  it('does not let one pip pay both a named Domain and an [A]', () => {
    // One Fury and one Calm cannot cover "Fury plus two [A]"; asking each
    // Domain separately would say yes.
    expect(canPay(POOL, { energy: 0, power: ['fury'], anyPower: 2 })).toBe(false);
    expect(canPay(POOL, { energy: 0, power: ['fury'], anyPower: 1 })).toBe(true);
  });

  it('spends real pips when paid', () => {
    const after = payFrom(POOL, { energy: 0, power: [], anyPower: 2 });
    expect(after.power.fury + after.power.calm).toBe(0);
  });

  it('counts toward the Rune cost of a card (137, 414, 416)', () => {
    expect(totalRuneCost({ energy: 1, power: ['fury'], anyPower: 2 })).toBe(4);
  });
});

/**
 * Deflect (809).
 *
 * The one cost modifier that depends on a *choice* rather than on the board:
 * 809.1.c taxes a Spell an opponent controls for choosing the Unit it is
 * printed on, so the same card in the same hand has two Total Costs depending
 * on where it is pointed.
 */
describe('Deflect (809)', () => {
  /** "DEFLECT 2" — opponents pay 2 more [A] to choose me. */
  const DEFLECTOR = makeUnit(3, ['fury'], {
    id: cardId('A-050'),
    name: 'Deflector',
    cost: cost(1),
    abilities: {
      costModifiers: [
        {
          applies: {
            types: ['unit', 'spell', 'gear', 'ability'],
            scope: 'opponent',
            choosesSource: true,
          },
          change: { kind: 'increase', anyPower: 2 },
        },
      ],
    },
  });

  const BOLT = makeSpell(['fury'], {
    id: cardId('A-051'),
    name: 'Bolt',
    cost: cost(1),
    timing: 'action',
    effect: { target: { kind: 'unit', scope: 'any' }, effects: [{ kind: 'dealDamage', amount: 1 }] },
  });

  const D_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    PLAIN,
    DEFLECTOR,
    BOLT,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function deflectGame(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 6 }, () => PLAIN.id),
        ...Array.from({ length: 5 }, () => DEFLECTOR.id),
        ...Array.from({ length: 5 }, () => BOLT.id),
      ],
      runes: Array.from({ length: 8 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
    let state = createGame({ decks: [list, list], registry: D_REGISTRY, seed }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    return state;
  }

  /** Put a card of `id` onto the given player's Base. */
  function onBoardFor(
    state: GameState,
    player: number,
    id: CardDefinition['id'],
  ): [GameState, EntityId] {
    const card = state.players[player]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === id,
    );
    if (card === undefined) {
      throw new Error(`No ${id} left for ${player}`);
    }
    return [moveEntity(state, card, playerLocation(player as never, 'base')), card];
  }

  it('809.1.c: raises the cost only for the Unit that has it', () => {
    let state = deflectGame('deflect-cost');
    const me = state.activePlayer;
    const them = me === 0 ? 1 : 0;
    const [a, guarded] = onBoardFor(state, them, DEFLECTOR.id);
    const [b, plain] = onBoardFor(a, them, PLAIN.id);
    state = b;

    // Pointed at the Deflector: 1 Energy plus two [A]. Pointed anywhere else:
    // the printed cost.
    expect(totalCost(state, me, BOLT, {}, guarded)).toEqual({
      energy: 1,
      power: [],
      anyPower: 2,
    });
    expect(totalCost(state, me, BOLT, {}, plain)).toEqual({ energy: 1, power: [] });
  });

  it('809.1.c: does not tax its own controller`s spells', () => {
    let state = deflectGame('deflect-friendly');
    const me = state.activePlayer;
    const [a, mine] = onBoardFor(state, me, DEFLECTOR.id);
    state = a;
    expect(totalCost(state, me, BOLT, {}, mine)).toEqual({ energy: 1, power: [] });
  });

  it('drops the play from `legalActions` when the tax cannot be paid', () => {
    let state = deflectGame('deflect-legal');
    const me = state.activePlayer;
    const them = me === 0 ? 1 : 0;
    const [a, guarded] = onBoardFor(state, them, DEFLECTOR.id);
    const [b, plain] = onBoardFor(a, them, PLAIN.id);
    // A Bolt in hand and exactly enough for its printed cost, but not the tax.
    const bolt = b.players[me]!.zones.mainDeck.find(
      (candidate) => b.entities[candidate]!.card === BOLT.id,
    )!;
    state = moveEntity(b, bolt, playerLocation(me, 'hand'));
    state = {
      ...state,
      players: state.players.map((seat) =>
        seat.id === me ? { ...seat, pool: { ...seat.pool, energy: 5 } } : seat,
      ),
    };

    const plays = legalActions(state, me).filter(
      (action) => action.type === 'playCard' && action.card === bolt,
    );
    const chosen = plays.map((action) => (action as { target?: EntityId }).target);
    expect(chosen).toContain(plain);
    // 809.1.c: no Power in the pool, so the Deflected target is unaffordable.
    expect(chosen).not.toContain(guarded);
  });
});

/**
 * Play-location permissions (355.2.b).
 *
 * 355.2.a's default is the controller's Base or a Battlefield they Control, and
 * 170.11 names the two states cards widen it to.
 */
describe('play-location permissions (355.2.b)', () => {
  const SNEAK = makeUnit(2, ['fury'], {
    id: cardId('A-060'),
    name: 'Sneak',
    cost: cost(1),
    abilities: { statics: [{ affects: { who: 'self' }, grant: { playTo: ['open'] } }] },
  });
  const RAIDER = makeUnit(2, ['fury'], {
    id: cardId('A-061'),
    name: 'Raider',
    cost: cost(1),
    abilities: { statics: [{ affects: { who: 'self' }, grant: { playTo: ['occupiedEnemy'] } }] },
  });

  const P_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    PLAIN,
    SNEAK,
    RAIDER,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function permGame(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 6 }, () => PLAIN.id),
        ...Array.from({ length: 5 }, () => SNEAK.id),
        ...Array.from({ length: 5 }, () => RAIDER.id),
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

  it('355.2.a: the default is the Base and Battlefields you Control', () => {
    const state = permGame('perm-default');
    const player = state.activePlayer;
    // Nothing is Controlled at the start, so a plain Unit has only its Base.
    expect(validUnitLocations(state, player, PLAIN)).toEqual([playerLocation(player, 'base')]);
  });

  it('170.11.c: "open" needs unoccupied *and* uncontrolled', () => {
    let state = permGame('perm-open');
    const player = state.activePlayer;
    expect(validUnitLocations(state, player, SNEAK)).toHaveLength(1 + state.battlefields.length);

    // A Unit standing there makes it occupied, so it stops being open — even
    // though nobody Controls it yet.
    const [occupied, unit] = onBoard(state, PLAIN.id);
    state = moveEntity(occupied, unit, battlefieldLocation(0));
    expect(validUnitLocations(state, player, SNEAK)).toHaveLength(state.battlefields.length);
  });

  it('170.11.a: "occupied enemy" is the mirror — a Unit present and Controlled', () => {
    let state = permGame('perm-occupied');
    const player = state.activePlayer;
    // Open Battlefields do not qualify for this permission.
    expect(validUnitLocations(state, player, RAIDER)).toEqual([playerLocation(player, 'base')]);

    const them = player === 0 ? 1 : 0;
    const card = state.players[them]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === PLAIN.id,
    )!;
    state = moveEntity(state, card, battlefieldLocation(0));
    state = {
      ...state,
      battlefields: state.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: them as PlayerId } : battlefield,
      ),
    };
    expect(validUnitLocations(state, player, RAIDER)).toHaveLength(2);
  });

  it('a permission never takes a Location away', () => {
    // The Base is always valid, whatever a card grants.
    const state = permGame('perm-union');
    const player = state.activePlayer;
    expect(validUnitLocations(state, player, RAIDER)).toContainEqual(playerLocation(player, 'base'));
  });
});
