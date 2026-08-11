/**
 * The effect primitives that act on the Board and on players.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import {
  CardRegistry,
  NO_TARGET,
  cardId,
  cost,
  type CardDefinition,
  type CardEffect,
  type Effect,
} from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { IllegalActionError } from './actions.js';
import { mightOf } from './combat.js';
import { currentLegalActions } from './legal.js';
import { Rng } from './rng.js';
import { executeEffect, type EffectContext } from './effects.js';
import type { GameEvent } from './events.js';
import { checkInvariants } from './invariants.js';
import { moveEntity, withEntity } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import {
  battlefieldLocation,
  getEntity,
  isOver,
  getPlayer,
  playerId,
  playerLocation,
  zoneOf,
  type EntityId,
  type GameState,
  type Location,
} from './state.js';

const LEGEND = makeLegend(['fury'], { id: cardId('P-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('P-001'), champion: true });
const UNIT = makeUnit(4, ['fury'], { id: cardId('P-010'), name: 'Unit', cost: cost(1) });
/** "When I die, draw 1" — a Deathknell, for the Kill ordering rule. */
const DEATHKNELL = makeUnit(2, ['fury'], {
  id: cardId('P-011'),
  name: 'Deathknell',
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: 'dies', subject: 'self' },
        effect: { target: NO_TARGET, effects: [{ kind: 'draw', count: 1 }] },
      },
    ],
  },
});
/**
 * "[1]: Move a friendly unit to a battlefield."
 *
 * An *Activated* ability rather than a Play Effect, because a Triggered
 * Ability's target is not chosen on the way onto the Chain — see the note in
 * `queueTriggers`. Activation is where both choices are made.
 */
const MOVER = makeUnit(2, ['fury'], {
  id: cardId('P-012'),
  name: 'Mover',
  cost: cost(1),
  abilities: {
    activated: [
      {
        cost: cost(1),
        effect: {
          target: { kind: 'unit', scope: 'friendly' },
          destination: { kind: 'battlefield' },
          effects: [{ kind: 'move' }],
        },
      },
    ],
  },
});
const RUNE = makeRune('fury', { id: cardId('P-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`P-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  UNIT,
  DEATHKNELL,
  MOVER,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: Array.from({ length: 14 }, () => UNIT.id),
    runes: Array.from({ length: 10 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function inMainPhase(seed = 'primitives'): GameState {
  let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state;
  while (state.phase === 'mulligan') {
    state = reduce(state, { type: 'mulligan', cards: [] }).state;
  }
  while (state.phase !== 'main') {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  return state;
}

/** Mint a card into the given player's Base. */
function withUnit(
  state: GameState,
  id: CardDefinition['id'] = UNIT.id,
  owner = state.activePlayer,
): [GameState, EntityId] {
  const entity = state.nextEntityId as EntityId;
  const next: GameState = {
    ...state,
    nextEntityId: state.nextEntityId + 1,
    definitions: { ...state.definitions, [id]: REGISTRY.mustGet(id) },
    entities: {
      ...state.entities,
      [entity]: {
        id: entity,
        card: id,
        owner,
        controller: owner,
        location: playerLocation(owner, 'base'),
        exhausted: false,
        damage: 0,
        mightBonus: 0,
        buffs: 0,
      },
    },
    players: state.players.map((seat) =>
      seat.id === owner
        ? { ...seat, zones: { ...seat.zones, base: [...seat.zones.base, entity] } }
        : seat,
    ),
  };
  return [next, entity];
}

/**
 * Run effects directly, so a primitive can be exercised without inventing a
 * card and a Chain for it. Uses the real draw and death-trigger machinery.
 */
function run(
  state: GameState,
  effects: readonly Effect[],
  target?: EntityId,
  destination?: Location,
  source?: EntityId,
): { state: GameState; events: GameEvent[] } {
  const events: GameEvent[] = [];
  const effect: CardEffect = {
    target: target === undefined ? NO_TARGET : { kind: 'unit', scope: 'any' },
    effects,
  };
  const context: EffectContext = {
    drawCards: (current, player, count, log) => {
      let next = current;
      for (let i = 0; i < count; i += 1) {
        const top = getPlayer(next, player).zones.mainDeck[0];
        if (top === undefined) break;
        next = moveEntity(next, top, playerLocation(player, 'hand'));
        log.push({ type: 'cardDrawn', player, entity: top });
      }
      return next;
    },
    queueDeaths: (current) => current,
    // The real tail lives in the reducer; these tests exercise the primitive,
    // and `move` gets its Contest/Cleanup coverage through a played card below.
    afterMove: (current) => current,
    raise: (current) => current,
  };
  return {
    state: executeEffect(
      state,
      { controller: state.activePlayer, source: source ?? target ?? (0 as EntityId), choices: { target, destination } },
      effect,
      events,
      context,
    ),
    events,
  };
}

describe('kill (rule 428)', () => {
  it('sends the target from the Board to the trash', () => {
    const [state, unit] = withUnit(inMainPhase());
    const player = state.activePlayer;

    const { state: after } = run(state, [{ kind: 'kill' }], unit);

    expect(zoneOf(after, player, 'base')).not.toContain(unit);
    expect(zoneOf(after, player, 'trash')).toContain(unit);
    checkInvariants(after);
  });

  it('sends it to its owner`s trash, not its controller`s', () => {
    // 428.1: killing is a Permanent going to the trash; the trash it goes to
    // belongs to the card's owner even if someone else controls it.
    const opponent = playerId(1);
    const [placed, unit] = withUnit(inMainPhase(), UNIT.id, opponent);
    const state = withEntity(placed, unit, (current) => ({
      ...current,
      controller: playerId(0),
    }));

    const { state: after } = run(state, [{ kind: 'kill' }], unit);
    expect(zoneOf(after, opponent, 'trash')).toContain(unit);
  });

  it('queues the Deathknell before the Unit reaches the trash (428.1.a.1.b)', () => {
    // The ordering rule: the trigger is added while the Unit is still on the
    // Board, so the callback must see it in its Base.
    const [state, unit] = withUnit(inMainPhase(), DEATHKNELL.id);
    const player = state.activePlayer;
    let sawOnBoard: boolean | undefined;

    const context: EffectContext = {
      drawCards: (current) => current,
      queueDeaths: (current, units) => {
        sawOnBoard = units.every((id) => zoneOf(current, player, 'base').includes(id));
        return current;
      },
      afterMove: (current) => current,
      raise: (current) => current,
    };
    executeEffect(
      state,
      { controller: player, source: unit, choices: { target: unit } },
      { target: { kind: 'unit', scope: 'any' }, effects: [{ kind: 'kill' }] },
      [],
      context,
    );

    expect(sawOnBoard).toBe(true);
  });

  it('clears counters on the way out (rule 705)', () => {
    const [placed, unit] = withUnit(inMainPhase());
    const state = withEntity(placed, unit, (current) => ({
      ...current,
      damage: 2,
      mightBonus: 3,
      buffs: 1,
    }));

    const { state: after } = run(state, [{ kind: 'kill' }], unit);
    expect(getEntity(after, unit)).toMatchObject({ damage: 0, mightBonus: 0, buffs: 0 });
  });

  it('does nothing to a card that is not on the Board', () => {
    const [placed, unit] = withUnit(inMainPhase());
    const player = placed.activePlayer;
    const state = moveEntity(placed, unit, playerLocation(player, 'hand'));

    const { state: after } = run(state, [{ kind: 'kill' }], unit);
    expect(zoneOf(after, player, 'hand')).toContain(unit);
  });
});

describe('recall (rules 454-458)', () => {
  it('returns the target to its controller`s Base', () => {
    const [placed, unit] = withUnit(inMainPhase());
    const player = placed.activePlayer;
    const state = moveEntity(placed, unit, battlefieldLocation(0));

    const { state: after } = run(state, [{ kind: 'recall' }], unit);

    expect(zoneOf(after, player, 'base')).toContain(unit);
    expect(after.battlefields[0]?.units).not.toContain(unit);
    checkInvariants(after);
  });

  it('leaves damage and statuses untouched (458.1)', () => {
    // A Recall is not a heal and not a ready: the Permanent arrives exactly as
    // it left, which is what separates it from the Combat Cleanup's Recall.
    const [placed, unit] = withUnit(inMainPhase());
    const moved = moveEntity(placed, unit, battlefieldLocation(0));
    const state = withEntity(moved, unit, (current) => ({
      ...current,
      damage: 2,
      exhausted: true,
      buffs: 1,
    }));

    const { state: after } = run(state, [{ kind: 'recall' }], unit);
    expect(getEntity(after, unit)).toMatchObject({ damage: 2, exhausted: true, buffs: 1 });
  });

  it('is a no-op for something already in a Base', () => {
    const [state, unit] = withUnit(inMainPhase());
    const { state: after } = run(state, [{ kind: 'recall' }], unit);
    expect(zoneOf(after, after.activePlayer, 'base')).toContain(unit);
    checkInvariants(after);
  });
});

describe('ready and exhaust (rules 414-415)', () => {
  it('readies an exhausted target', () => {
    const [placed, unit] = withUnit(inMainPhase());
    const state = withEntity(placed, unit, (current) => ({ ...current, exhausted: true }));

    const { state: after } = run(state, [{ kind: 'ready' }], unit);
    expect(getEntity(after, unit).exhausted).toBe(false);
  });

  it('does nothing to a target that is already ready (415.1.c)', () => {
    const [state, unit] = withUnit(inMainPhase());
    const { state: after } = run(state, [{ kind: 'ready' }], unit);
    expect(getEntity(after, unit).exhausted).toBe(false);
  });

  it('exhausts a ready target', () => {
    const [state, unit] = withUnit(inMainPhase());
    const { state: after } = run(state, [{ kind: 'exhaust' }], unit);
    expect(getEntity(after, unit).exhausted).toBe(true);
  });
});

describe('buffs (rules 701-705)', () => {
  it('places a counter that adds +1 Might (703)', () => {
    const [state, unit] = withUnit(inMainPhase());
    const before = mightOf(state, unit);

    const { state: after } = run(state, [{ kind: 'buff' }], unit);
    expect(getEntity(after, unit).buffs).toBe(1);
    expect(mightOf(after, unit)).toBe(before + 1);
  });

  it('refuses a second Buff rather than stacking (702.3.a)', () => {
    const [state, unit] = withUnit(inMainPhase());
    const once = run(state, [{ kind: 'buff' }], unit).state;
    const twice = run(once, [{ kind: 'buff' }], unit).state;

    expect(getEntity(twice, unit).buffs).toBe(1);
    expect(mightOf(twice, unit)).toBe(mightOf(once, unit));
  });

  it('persists across the Ending Phase, unlike a Might modifier', () => {
    // 317.2.c expires "this turn" effects; a Buff is a counter, not one.
    const [placed, unit] = withUnit(inMainPhase());
    const state = run(placed, [{ kind: 'buff' }, { kind: 'giveMight', amount: 2 }], unit).state;
    expect(mightOf(state, unit)).toBe(UNIT.might + 3);

    let next = reduce(state, { type: 'endTurn' }).state;
    while (next.phase === 'ending') {
      next = reduce(next, { type: 'resolvePhase' }).state;
    }
    expect(getEntity(next, unit).mightBonus).toBe(0);
    expect(getEntity(next, unit).buffs).toBe(1);
    expect(mightOf(next, unit)).toBe(UNIT.might + 1);
  });

  it('spends a Buff from a Unit that has one (702.2.b)', () => {
    const [state, unit] = withUnit(inMainPhase());
    const buffed = run(state, [{ kind: 'buff' }], unit).state;

    const { state: after } = run(buffed, [{ kind: 'spendBuff' }], unit);
    expect(getEntity(after, unit).buffs).toBe(0);
  });

  it('cannot spend from a Unit with no Buff (702.2.b.1)', () => {
    const [state, unit] = withUnit(inMainPhase());
    const { state: after, events } = run(state, [{ kind: 'spendBuff' }], unit);
    expect(getEntity(after, unit).buffs).toBe(0);
    expect(events.filter((event) => event.type === 'buffSpent')).toEqual([]);
  });

  it('cannot spend from a Unit another player controls (702.2.b.2)', () => {
    const state = inMainPhase();
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    const [placed, unit] = withUnit(state, UNIT.id, opponent);
    const buffed = withEntity(placed, unit, (current) => ({ ...current, buffs: 1 }));

    const { state: after } = run(buffed, [{ kind: 'spendBuff' }], unit);
    expect(getEntity(after, unit).buffs).toBe(1);
  });
});

describe('discard (rule 422)', () => {
  it('moves cards from hand to trash', () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const hand = [...zoneOf(state, player, 'hand')];

    const { state: after } = run(state, [{ kind: 'discard', count: 2 }]);

    expect(zoneOf(after, player, 'hand')).toHaveLength(hand.length - 2);
    expect(zoneOf(after, player, 'trash')).toHaveLength(2);
    checkInvariants(after);
  });

  it('discards as many as possible from a short hand (422.4)', () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const hand = [...zoneOf(state, player, 'hand')];

    const { state: after } = run(state, [{ kind: 'discard', count: hand.length + 5 }]);

    expect(zoneOf(after, player, 'hand')).toEqual([]);
    expect(zoneOf(after, player, 'trash')).toHaveLength(hand.length);
  });

  it('does nothing with an empty hand', () => {
    let state = inMainPhase();
    const player = state.activePlayer;
    for (const card of [...zoneOf(state, player, 'hand')]) {
      state = moveEntity(state, card, playerLocation(player, 'trash'));
    }

    const { events } = run(state, [{ kind: 'discard', count: 2 }]);
    expect(events).toEqual([]);
  });

  it('does not execute the discarded card`s rules text (422.1)', () => {
    // Discarding is not playing: the card goes straight to the trash.
    const state = inMainPhase();
    const player = state.activePlayer;
    const handBefore = zoneOf(state, player, 'hand').length;

    const { state: after } = run(state, [{ kind: 'discard', count: 1 }]);
    // A card whose text drew would have changed the hand size by more than one.
    expect(zoneOf(after, player, 'hand')).toHaveLength(handBefore - 1);
  });
});

describe('XP (rules 728-733)', () => {
  it('gains and spends', () => {
    const state = inMainPhase();
    const player = state.activePlayer;

    const gained = run(state, [{ kind: 'gainXp', amount: 3 }]).state;
    expect(getPlayer(gained, player).xp).toBe(3);

    const spent = run(gained, [{ kind: 'spendXp', amount: 2 }]).state;
    expect(getPlayer(spent, player).xp).toBe(1);
  });

  it('has no cap (733)', () => {
    let state = inMainPhase();
    for (let i = 0; i < 5; i += 1) {
      state = run(state, [{ kind: 'gainXp', amount: 10 }]).state;
    }
    expect(getPlayer(state, state.activePlayer).xp).toBe(50);
  });

  it('cannot be spent below zero', () => {
    const state = run(inMainPhase(), [{ kind: 'gainXp', amount: 1 }]).state;
    const { state: after } = run(state, [{ kind: 'spendXp', amount: 5 }]);
    expect(getPlayer(after, after.activePlayer).xp).toBe(0);
  });

  it('survives the end of the turn', () => {
    // XP is a resource, not a "this turn" effect, so nothing expires it.
    const state = run(inMainPhase(), [{ kind: 'gainXp', amount: 4 }]).state;
    const player = state.activePlayer;

    let next = reduce(state, { type: 'endTurn' }).state;
    while (next.phase === 'ending') {
      next = reduce(next, { type: 'resolvePhase' }).state;
    }
    expect(getPlayer(next, player).xp).toBe(4);
  });
});

describe('channel (rule 430)', () => {
  it('puts Runes from the top of the Rune Deck onto the Board', () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const runesBefore = zoneOf(state, player, 'runes').length;
    const deckBefore = zoneOf(state, player, 'runeDeck').length;

    const { state: after } = run(state, [{ kind: 'channel', count: 2 }]);

    expect(zoneOf(after, player, 'runes')).toHaveLength(runesBefore + 2);
    expect(zoneOf(after, player, 'runeDeck')).toHaveLength(deckBefore - 2);
    checkInvariants(after);
  });

  it('channels ready by default (430.2.a)', () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const top = zoneOf(state, player, 'runeDeck')[0] as EntityId;

    const { state: after } = run(state, [{ kind: 'channel', count: 1 }]);
    expect(getEntity(after, top).exhausted).toBe(false);
  });

  it('channels exhausted when the effect says so (430.2)', () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const top = zoneOf(state, player, 'runeDeck')[0] as EntityId;

    const { state: after } = run(state, [{ kind: 'channel', count: 1, exhausted: true }]);
    expect(getEntity(after, top).exhausted).toBe(true);
  });

  it('channels as many as possible and does not Burn Out (430.3)', () => {
    // An empty Rune Deck is not an empty Main Deck: rule 431's Burn Out, and
    // the point it hands an opponent, applies only to the latter.
    let state = inMainPhase();
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);
    for (const rune of [...zoneOf(state, player, 'runeDeck')]) {
      state = moveEntity(state, rune, playerLocation(player, 'runes'));
    }
    const pointsBefore = getPlayer(state, opponent).points;

    const { state: after } = run(state, [{ kind: 'channel', count: 3 }]);

    expect(zoneOf(after, player, 'runeDeck')).toEqual([]);
    expect(getPlayer(after, opponent).points).toBe(pointsBefore);
    checkInvariants(after);
  });
});

describe('move (rules 420, 445-453)', () => {
  it('relocates the target to the chosen Battlefield', () => {
    const [state, unit] = withUnit(inMainPhase());
    const { state: after } = run(state, [{ kind: 'move' }], unit, battlefieldLocation(1));

    expect(after.battlefields[1]?.units).toContain(unit);
    expect(zoneOf(after, after.activePlayer, 'base')).not.toContain(unit);
    checkInvariants(after);
  });

  it('does not exhaust the target, unlike the Standard Move (420.3.a)', () => {
    // Exhausting is the Standard Move's cost; an instructed Move is free.
    const [state, unit] = withUnit(inMainPhase());
    const { state: after } = run(state, [{ kind: 'move' }], unit, battlefieldLocation(0));
    expect(getEntity(after, unit).exhausted).toBe(false);
  });

  it('does nothing when the target is already there', () => {
    const [placed, unit] = withUnit(inMainPhase());
    const state = moveEntity(placed, unit, battlefieldLocation(0));
    const { state: after, events } = run(state, [{ kind: 'move' }], unit, battlefieldLocation(0));

    expect(after.battlefields[0]?.units).toContain(unit);
    expect(events).toEqual([]);
  });

  it('does nothing without a Destination', () => {
    const [state, unit] = withUnit(inMainPhase());
    const { state: after } = run(state, [{ kind: 'move' }], unit);
    expect(zoneOf(after, after.activePlayer, 'base')).toContain(unit);
  });

  it('Contests the Destination and runs the Cleanup (450, 453)', () => {
    // Through a real played card, so the reducer's Move tail runs rather than
    // the stub the direct-effect harness uses.
    let state = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: 'move-contest',
    }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main') {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    const player = state.activePlayer;

    // A friendly Unit in the Base to move, and the Mover on the Board.
    const [withTarget, victim] = withUnit(state, UNIT.id);
    const [ready, source] = withUnit(withTarget, MOVER.id);
    let next: GameState = {
      ...ready,
      players: ready.players.map((seat) =>
        seat.id === player ? { ...seat, pool: { energy: 5, power: seat.pool.power } } : seat,
      ),
    };

    next = reduce(next, {
      type: 'activateAbility',
      source,
      index: 0,
      target: victim,
      destination: battlefieldLocation(0),
    }).state;
    let guard = 0;
    while (next.chain.length > 0) {
      if (guard++ > 20) throw new Error('Chain did not resolve');
      next = reduce(next, { type: 'pass' }).state;
    }

    expect(next.battlefields[0]?.units).toContain(victim);
    // 450: an Uncontested Battlefield the mover does not control becomes
    // Contested.
    expect(next.battlefields[0]?.contestedBy).toBe(player);

    // 344.2 opens a Showdown only in a Neutral Open state, so the one owed for
    // this Move could not open while the Chain was still up. It opens as the
    // Chain empties, and Control follows when it closes (348.2.a).
    expect(next.showdown?.battlefield).toBe(0);
    while (next.showdown !== null) {
      if (guard++ > 20) throw new Error('Showdown did not close');
      next = reduce(next, { type: 'pass' }).state;
    }
    expect(next.battlefields[0]?.controller).toBe(player);
    checkInvariants(next);
  });

  it('offers one action per Destination and reduce accepts each (355.8)', () => {
    let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed: 'move-legal' }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main') {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    const player = state.activePlayer;

    const [withTarget] = withUnit(state, UNIT.id);
    const [ready, source] = withUnit(withTarget, MOVER.id);
    const next: GameState = {
      ...ready,
      players: ready.players.map((seat) =>
        seat.id === player ? { ...seat, pool: { energy: 5, power: seat.pool.power } } : seat,
      ),
    };

    const offered = currentLegalActions(next).filter(
      (action) => action.type === 'activateAbility' && action.source === source,
    );
    // One per (target, destination) pair, and every one of them must be a move
    // `reduce` will accept — the guarantee `legalActions` exists to give.
    expect(offered.length).toBe(
      next.battlefields.length * zoneOf(next, player, 'base').length,
    );
    for (const action of offered) {
      expect(() => reduce(next, action)).not.toThrow();
    }
  });
});

describe('effects run in order (359.2.b)', () => {
  it('applies a sequence top to bottom', () => {
    const [state, unit] = withUnit(inMainPhase());
    // Buff then kill: the Buff lands, then the Unit dies with it cleared.
    const { state: after } = run(state, [{ kind: 'buff' }, { kind: 'kill' }], unit);

    expect(zoneOf(after, after.activePlayer, 'trash')).toContain(unit);
    expect(getEntity(after, unit).buffs).toBe(0);
  });

  it('keeps running after a step whose target has gone', () => {
    const [state, unit] = withUnit(inMainPhase());
    const player = state.activePlayer;
    const xpBefore = getPlayer(state, player).xp;

    // The Unit is dead by the time `buff` runs, so that step does nothing —
    // but the rest of the card still resolves.
    const { state: after } = run(
      state,
      [{ kind: 'kill' }, { kind: 'buff' }, { kind: 'gainXp', amount: 2 }],
      unit,
    );

    expect(getPlayer(after, player).xp).toBe(xpBefore + 2);
  });
});

describe('self-targeting', () => {
  /** "[1]: Ready me." — the source is the target, with no choice to make. */
  const SELF_READY = makeUnit(2, ['fury'], {
    id: cardId('P-013'),
    name: 'Self Ready',
    cost: cost(1),
    abilities: {
      activated: [
        { cost: cost(1), effect: { target: { kind: 'self' }, effects: [{ kind: 'ready' }] } },
      ],
    },
  });
  /** "When you play me, give me +2 Might this turn." — a self Play Effect. */
  const SELF_PUMP = makeUnit(2, ['fury'], {
    id: cardId('P-014'),
    name: 'Self Pump',
    cost: cost(1),
    abilities: {
      triggered: [
        {
          condition: { event: 'played', subject: 'self' },
          effect: { target: { kind: 'self' }, effects: [{ kind: 'giveMight', amount: 2 }] },
        },
      ],
    },
  });

  const registry = CardRegistry.from([
    LEGEND,
    CHAMPION,
    UNIT,
    DEATHKNELL,
    MOVER,
    SELF_READY,
    SELF_PUMP,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function game(seed: string): GameState {
    let state = createGame({ decks: [deck(), deck()], registry, seed }).state;
    while (state.phase === 'mulligan') state = reduce(state, { type: 'mulligan', cards: [] }).state;
    while (state.phase !== 'main') state = reduce(state, { type: 'resolvePhase' }).state;
    const player = state.activePlayer;
    return {
      ...state,
      players: state.players.map((seat) =>
        seat.id === player ? { ...seat, pool: { energy: 5, power: seat.pool.power } } : seat,
      ),
    };
  }

  /** Mint a card of `id` into the Turn Player's Base, using the local registry. */
  function mint(state: GameState, id: CardDefinition['id']): [GameState, EntityId] {
    const player = state.activePlayer;
    const entity = state.nextEntityId as EntityId;
    return [
      {
        ...state,
        nextEntityId: state.nextEntityId + 1,
        definitions: { ...state.definitions, [id]: registry.mustGet(id) },
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
      },
      entity,
    ];
  }

  it('resolves "me" to the ability`s own source (377.3.a.1)', () => {
    const [placed, source] = mint(game('self-ready'), SELF_READY.id);
    const state = withEntity(placed, source, (current) => ({ ...current, exhausted: true }));

    let next = reduce(state, { type: 'activateAbility', source, index: 0 }).state;
    let guard = 0;
    while (next.chain.length > 0) {
      if (guard++ > 20) throw new Error('Chain did not resolve');
      next = reduce(next, { type: 'pass' }).state;
    }

    expect(getEntity(next, source).exhausted).toBe(false);
    checkInvariants(next);
  });

  it('offers the ability with no target, since "me" is not a choice', () => {
    const [state, source] = mint(game('self-legal'), SELF_READY.id);
    const offered = currentLegalActions(state).filter(
      (action) => action.type === 'activateAbility' && action.source === source,
    );

    expect(offered).toHaveLength(1);
    expect(offered[0]).not.toHaveProperty('target');
  });

  it('rejects a chosen target on a self-targeting ability', () => {
    // Supplying one is an error, not a different reading of the card.
    const [placed, source] = mint(game('self-reject'), SELF_READY.id);
    const [state, other] = mint(placed, UNIT.id);
    expect(() =>
      reduce(state, { type: 'activateAbility', source, index: 0, target: other }),
    ).toThrow(IllegalActionError);
  });

  it('resolves "me" to the card itself for a Play Effect', () => {
    const [placed, card] = mint(game('self-play'), SELF_PUMP.id);
    const player = placed.activePlayer;
    const state = moveEntity(placed, card, playerLocation(player, 'hand'));

    let next = reduce(state, { type: 'playCard', card }).state;
    let guard = 0;
    while (next.chain.length > 0) {
      if (guard++ > 20) throw new Error('Chain did not resolve');
      next = reduce(next, { type: 'pass' }).state;
    }

    // The Unit pumped itself, not some other Unit on the board.
    expect(getEntity(next, card).mightBonus).toBe(2);
    expect(mightOf(next, card)).toBe(SELF_PUMP.might + 2);
    checkInvariants(next);
  });
});

describe('primitive fuzz', () => {
  /** Cards carrying every primitive, so a random walk actually reaches them. */
  const unit = (id: string, abilities: object) =>
    makeUnit(2, ['fury'], { id: cardId(id), cost: cost(1), abilities: abilities as never });

  const onPlay = (effects: readonly Effect[], targeted: boolean) => ({
    triggered: [
      {
        condition: { event: 'played', subject: 'self' } as const,
        effect: {
          target: targeted ? ({ kind: 'unit', scope: 'any' } as const) : NO_TARGET,
          effects,
        },
      },
    ],
  });
  const activated = (effects: readonly Effect[], targeted: boolean) => ({
    activated: [
      {
        cost: cost(1),
        effect: {
          target: targeted ? ({ kind: 'unit', scope: 'any' } as const) : NO_TARGET,
          effects,
        },
      },
    ],
  });

  const CARDS = [
    unit('P-300', onPlay([{ kind: 'kill' }], true)),
    unit('P-301', onPlay([{ kind: 'recall' }], true)),
    unit('P-302', activated([{ kind: 'buff' }], true)),
    unit('P-303', activated([{ kind: 'spendBuff' }], true)),
    unit('P-304', onPlay([{ kind: 'discard', count: 2 }], false)),
    unit('P-305', onPlay([{ kind: 'gainXp', amount: 3 }], false)),
    unit('P-306', activated([{ kind: 'spendXp', amount: 2 }, { kind: 'draw', count: 1 }], false)),
    unit('P-307', onPlay([{ kind: 'channel', count: 2, exhausted: true }], false)),
    unit('P-308', activated([{ kind: 'ready' }], true)),
    unit('P-309', activated([{ kind: 'exhaust' }], true)),
    // Moves, which Contest a Battlefield mid-resolution and so can leave a
    // Showdown owed once the Chain empties.
    makeUnit(2, ['fury'], {
      id: cardId('P-310'),
      cost: cost(1),
      abilities: {
        activated: [
          {
            cost: cost(1),
            effect: {
              target: { kind: 'unit', scope: 'friendly' },
              destination: { kind: 'battlefield' },
              effects: [{ kind: 'move' }],
            },
          },
        ],
      },
    }),
    makeUnit(2, ['fury'], {
      id: cardId('P-311'),
      cost: cost(1),
      abilities: {
        activated: [
          {
            cost: cost(1),
            effect: {
              target: { kind: 'unit', scope: 'any' },
              destination: { kind: 'base' },
              effects: [{ kind: 'move' }],
            },
          },
        ],
      },
    }),
  ];

  const registry = CardRegistry.from([
    LEGEND,
    CHAMPION,
    UNIT,
    DEATHKNELL,
    RUNE,
    ...BATTLEFIELDS,
    ...CARDS,
  ] as CardDefinition[]);

  const primitiveDeck: DeckList = {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: CARDS.flatMap((card) => [card.id, card.id, card.id]),
    runes: Array.from({ length: 12 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };

  it('never reaches an inconsistent state and always terminates', () => {
    // Killing, recalling, discarding and channelling all move cards between
    // zones mid-resolution, which is exactly where a zone list and an entity's
    // recorded location can drift apart.
    for (let game = 0; game < 20; game += 1) {
      const seed = `primitive-fuzz-${game}`;
      const rng = Rng.fromSeed(seed);
      let state = createGame({
        decks: [primitiveDeck, primitiveDeck],
        registry,
        seed,
        config: { maxTurns: 60 },
      }).state;
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
    // Nothing is created or destroyed: a killed Unit moves to the trash, it
    // does not leave the entity table.
    const seed = 'primitive-conservation';
    const rng = Rng.fromSeed(seed);
    let state = createGame({
      decks: [primitiveDeck, primitiveDeck],
      registry,
      seed,
      config: { maxTurns: 40 },
    }).state;
    const total = Object.keys(state.entities).length;

    while (!isOver(state)) {
      const actions = currentLegalActions(state);
      if (actions.length === 0) break;
      state = reduce(state, rng.pick(actions)).state;
      expect(Object.keys(state.entities)).toHaveLength(total);
    }
  });
});
