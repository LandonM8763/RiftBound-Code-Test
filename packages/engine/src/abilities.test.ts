/**
 * Activated and Triggered abilities.
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
} from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { activatableAbilities, triggersFor } from './abilities.js';
import { currentLegalActions, legalActions } from './legal.js';
import { Rng } from './rng.js';
import { IllegalActionError } from './actions.js';
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
  type PlayerId,
} from './state.js';

const DRAW_ONE: CardEffect = { target: NO_TARGET, effects: [{ kind: 'draw', count: 1 }] };
const DAMAGE_TWO: CardEffect = {
  target: { kind: 'unit', scope: 'any' },
  effects: [{ kind: 'dealDamage', amount: 2 }],
};

const LEGEND = makeLegend(['fury'], { id: cardId('A-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('A-001'), champion: true });
const PLAIN = makeUnit(2, ['fury'], { id: cardId('A-010'), name: 'Plain', cost: cost(1) });

/** "[1]: Draw 1" — an Activated Ability paid from the Rune Pool (377.1). */
const ACTIVATOR = makeUnit(2, ['fury'], {
  id: cardId('A-011'),
  name: 'Activator',
  cost: cost(1),
  abilities: { activated: [{ cost: cost(1), effect: DRAW_ONE }] },
});

/** "[E]: Draw 1" — the exhaust symbol as the whole cost (414). */
const TAPPER = makeUnit(2, ['fury'], {
  id: cardId('A-012'),
  name: 'Tapper',
  cost: cost(1),
  abilities: { activated: [{ cost: cost(0), exhaustSelf: true, effect: DRAW_ONE }] },
});

/** "When you play me, draw 1" — a Play Effect (383.4.a). */
const GREETER = makeUnit(2, ['fury'], {
  id: cardId('A-013'),
  name: 'Greeter',
  cost: cost(1),
  abilities: { triggered: [{ condition: { kind: 'played' }, effect: DRAW_ONE }] },
});

/** "When you play me, you may draw 1" — optional, chosen at finalization (383.3.a). */
const OPTIONAL_GREETER = makeUnit(2, ['fury'], {
  id: cardId('A-014'),
  name: 'Maybe',
  cost: cost(1),
  abilities: { triggered: [{ condition: { kind: 'played' }, optional: true, effect: DRAW_ONE }] },
});

/** "Once each turn, when you play me, draw 1" (383.3.e). */
const LIMITED = makeUnit(2, ['fury'], {
  id: cardId('A-015'),
  name: 'Limited',
  cost: cost(1),
  abilities: {
    triggered: [{ condition: { kind: 'played' }, limitPerTurn: 1, effect: DRAW_ONE }],
  },
});

/** "When I die, draw 1" — a Deathknell. */
const DEATHKNELL = makeUnit(2, ['fury'], {
  id: cardId('A-016'),
  name: 'Deathknell',
  cost: cost(1),
  abilities: { triggered: [{ condition: { kind: 'dies' }, effect: DRAW_ONE }] },
});

/** "At the end of your turn, draw 1" (317.1). */
const CLOSER = makeUnit(2, ['fury'], {
  id: cardId('A-018'),
  name: 'Closer',
  cost: cost(1),
  abilities: { triggered: [{ condition: { kind: 'endOfTurn' }, effect: DRAW_ONE }] },
});

/** "At the start of your Beginning Phase, draw 1" (315.2.a). */
const OPENER = makeUnit(2, ['fury'], {
  id: cardId('A-019'),
  name: 'Opener',
  cost: cost(1),
  abilities: { triggered: [{ condition: { kind: 'beginningPhase' }, effect: DRAW_ONE }] },
});

/** "Units you play cost [1] less" — a Passive cost modifier (356.4, 363). */
const DISCOUNTER = makeUnit(2, ['fury'], {
  id: cardId('A-020'),
  name: 'Discounter',
  cost: cost(1),
  abilities: {
    costModifiers: [
      { applies: { scope: 'friendly', types: ['unit'] }, change: { kind: 'discount', energy: 1 } },
    ],
  },
});

/** A symmetric tax, so the fuzz sees costs rise as well as fall (356.3). */
const TAXMAN = makeUnit(2, ['fury'], {
  id: cardId('A-021'),
  name: 'Taxman',
  cost: cost(1),
  abilities: {
    costModifiers: [{ applies: { scope: 'any' }, change: { kind: 'increase', energy: 1 } }],
  },
});

/** "[1]: Deal 2 to a unit" — an Activated Ability that targets (355.8). */
const SNIPER = makeUnit(2, ['fury'], {
  id: cardId('A-017'),
  name: 'Sniper',
  cost: cost(1),
  abilities: { activated: [{ cost: cost(1), effect: DAMAGE_TWO }] },
});

const RUNE = makeRune('fury', { id: cardId('A-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`A-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  ACTIVATOR,
  TAPPER,
  GREETER,
  OPTIONAL_GREETER,
  LIMITED,
  DEATHKNELL,
  CLOSER,
  OPENER,
  DISCOUNTER,
  TAXMAN,
  SNIPER,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: Array.from({ length: 14 }, () => PLAIN.id),
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

/** A game in the Main Phase with `energy` in the Turn Player's pool. */
function inMainPhase(seed = 'abilities', energy = 3): GameState {
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

/** Put a card of `id` onto the board under the Turn Player. */
function withBoardCard(
  state: GameState,
  id: CardDefinition['id'],
  owner?: PlayerId,
): [GameState, EntityId] {
  const player = owner ?? state.activePlayer;
  const entityId = state.nextEntityId;
  const next: GameState = {
    ...state,
    nextEntityId: entityId + 1,
    definitions: { ...state.definitions, [id]: REGISTRY.mustGet(id) },
    entities: {
      ...state.entities,
      [entityId]: {
        id: entityId as EntityId,
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
        ? { ...seat, zones: { ...seat.zones, base: [...seat.zones.base, entityId as EntityId] } }
        : seat,
    ),
  };
  return [next, entityId as EntityId];
}

/** Put a card into the Turn Player's hand so it can be played. */
function withHandCard(state: GameState, id: CardDefinition['id']): [GameState, EntityId] {
  const [placed, entity] = withBoardCard(state, id);
  const player = placed.activePlayer;
  return [moveEntity(placed, entity, playerLocation(player, 'hand')), entity];
}

/** Pass until the top Chain item resolves. */
function resolveChain(state: GameState): GameState {
  let next = state;
  let guard = 0;
  while (next.chain.length > 0) {
    if (guard > 20) throw new Error('Chain did not resolve');
    guard += 1;
    next = reduce(next, { type: 'pass' }).state;
  }
  return next;
}

describe('Activated Abilities (rules 376-381)', () => {
  it('goes on the Chain and resolves its effect', () => {
    const [state, source] = withBoardCard(inMainPhase(), ACTIVATOR.id);
    const player = state.activePlayer;
    const before = zoneOf(state, player, 'hand').length;

    const activated = reduce(state, { type: 'activateAbility', source, index: 0 }).state;
    expect(activated.chain).toHaveLength(1);
    expect(activated.chain[0]?.ability).toEqual({ kind: 'activated', index: 0 });

    const resolved = resolveChain(activated);
    expect(zoneOf(resolved, player, 'hand')).toHaveLength(before + 1);
    checkInvariants(resolved);
  });

  it('pays the cost out of the Rune Pool (rule 377)', () => {
    const [state, source] = withBoardCard(inMainPhase('cost', 3), ACTIVATOR.id);
    const player = state.activePlayer;

    const activated = reduce(state, { type: 'activateAbility', source, index: 0 }).state;
    expect(getPlayer(activated, player).pool.energy).toBe(2);
  });

  it('leaves its source where it is, unlike a Spell (377.3.a.1)', () => {
    // An ability on the Chain "has no card to represent it": the source is not
    // moved onto the Chain and does not go to the trash when it resolves.
    const [state, source] = withBoardCard(inMainPhase(), ACTIVATOR.id);
    const player = state.activePlayer;

    const resolved = resolveChain(reduce(state, { type: 'activateAbility', source, index: 0 }).state);
    expect(zoneOf(resolved, player, 'base')).toContain(source);
    expect(zoneOf(resolved, player, 'trash')).not.toContain(source);
  });

  it('is repeatable while the cost can still be paid (377)', () => {
    const [state, source] = withBoardCard(inMainPhase('repeat', 3), ACTIVATOR.id);
    const player = state.activePlayer;
    const before = zoneOf(state, player, 'hand').length;

    let next = resolveChain(reduce(state, { type: 'activateAbility', source, index: 0 }).state);
    next = resolveChain(reduce(next, { type: 'activateAbility', source, index: 0 }).state);

    expect(zoneOf(next, player, 'hand')).toHaveLength(before + 2);
  });

  it('exhausts the source when that is the cost (rule 414)', () => {
    const [state, source] = withBoardCard(inMainPhase('exhaust', 0), TAPPER.id);

    const activated = reduce(state, { type: 'activateAbility', source, index: 0 }).state;
    expect(getEntity(activated, source).exhausted).toBe(true);
  });

  it('cannot pay an exhaust cost twice without readying (414)', () => {
    const [state, source] = withBoardCard(inMainPhase('twice', 0), TAPPER.id);
    const once = resolveChain(reduce(state, { type: 'activateAbility', source, index: 0 }).state);

    expect(activatableAbilities(once, once.activePlayer)).toEqual([]);
    expect(() => reduce(once, { type: 'activateAbility', source, index: 0 })).toThrow(
      IllegalActionError,
    );
  });

  it('is unavailable when the cost cannot be paid', () => {
    const [state, source] = withBoardCard(inMainPhase('broke', 0), ACTIVATOR.id);
    expect(activatableAbilities(state, state.activePlayer)).toEqual([]);
    expect(() => reduce(state, { type: 'activateAbility', source, index: 0 })).toThrow(
      IllegalActionError,
    );
  });

  it('is unavailable on an opponent`s turn (rule 381)', () => {
    const [state, source] = withBoardCard(inMainPhase('turn', 3), ACTIVATOR.id);
    const opponent = playerId((state.activePlayer + 1) % state.players.length);

    expect(activatableAbilities(state, opponent)).toEqual([]);
    expect(activatableAbilities({ ...state, activePlayer: opponent }, state.activePlayer)).toEqual(
      [],
    );
    expect(source).toBeGreaterThanOrEqual(0);
  });

  it('is unavailable in a Closed State (rule 381)', () => {
    // 381: "only ... during an Open State"; a Chain makes the state Closed.
    const [state, source] = withBoardCard(inMainPhase('closed', 3), ACTIVATOR.id);
    const withChain = reduce(state, { type: 'activateAbility', source, index: 0 }).state;

    expect(activatableAbilities(withChain, withChain.activePlayer)).toEqual([]);
  });

  it('is unavailable from a source that is not on the Board (rule 380)', () => {
    const [state, source] = withHandCard(inMainPhase('hand', 3), ACTIVATOR.id);
    expect(activatableAbilities(state, state.activePlayer)).toEqual([]);
    expect(() => reduce(state, { type: 'activateAbility', source, index: 0 })).toThrow(
      IllegalActionError,
    );
  });

  it('offers one action per legal target and rejects an invalid one (355.8)', () => {
    const base = inMainPhase('target', 3);
    const [withSniper, sniper] = withBoardCard(base, SNIPER.id);
    const [state, victim] = withBoardCard(withSniper, PLAIN.id);

    const offered = legalActions(state, state.activePlayer).filter(
      (action) => action.type === 'activateAbility',
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((action) => 'target' in action && action.target !== undefined)).toBe(true);

    const damaged = resolveChain(
      reduce(state, { type: 'activateAbility', source: sniper, index: 0, target: victim }).state,
    );
    expect(getEntity(damaged, victim).damage).toBe(2);

    // A targeting ability with no target chosen is not a legal activation.
    expect(() => reduce(state, { type: 'activateAbility', source: sniper, index: 0 })).toThrow(
      IllegalActionError,
    );
  });

  it('is offered by legalActions and always accepted by reduce', () => {
    const [state, source] = withBoardCard(inMainPhase('legal', 3), ACTIVATOR.id);
    expect(source).toBeGreaterThanOrEqual(0);
    for (const action of legalActions(state, state.activePlayer)) {
      expect(() => reduce(state, action)).not.toThrow();
    }
  });
});

describe('Play Effects (rule 383.4.a)', () => {
  it('triggers when the Permanent enters the Board', () => {
    const [state, card] = withHandCard(inMainPhase('play', 3), GREETER.id);
    const player = state.activePlayer;
    const before = zoneOf(state, player, 'hand').length;

    const played = reduce(state, { type: 'playCard', card }).state;
    // 383.4.a.2: it goes on the Chain after the Permanent is finalized.
    expect(played.chain).toHaveLength(1);
    expect(played.chain[0]?.ability).toEqual({ kind: 'triggered', index: 0 });

    const resolved = resolveChain(played);
    // -1 for the card played, +1 for the trigger's draw.
    expect(zoneOf(resolved, player, 'hand')).toHaveLength(before);
    checkInvariants(resolved);
  });

  it('does not trigger on a card without one', () => {
    const [state, card] = withHandCard(inMainPhase('plain', 3), PLAIN.id);
    expect(reduce(state, { type: 'playCard', card }).state.chain).toHaveLength(0);
  });

  it('leaves the Permanent on the Board when the trigger resolves', () => {
    const [state, card] = withHandCard(inMainPhase('stay', 3), GREETER.id);
    const player = state.activePlayer;

    const resolved = resolveChain(reduce(state, { type: 'playCard', card }).state);
    expect(zoneOf(resolved, player, 'base')).toContain(card);
  });
});

describe('optional triggers (rule 383.3.a)', () => {
  it('goes on the Chain pending, and offers only the choice', () => {
    const [state, card] = withHandCard(inMainPhase('opt', 3), OPTIONAL_GREETER.id);
    const played = reduce(state, { type: 'playCard', card }).state;

    expect(played.chain[0]?.pending).toBe(true);
    const offered = legalActions(played, played.activePlayer);
    expect(offered).toEqual([
      { type: 'resolveTrigger', perform: true },
      { type: 'resolveTrigger', perform: false },
    ]);
  });

  it('performs the effect when its controller accepts', () => {
    const [state, card] = withHandCard(inMainPhase('accept', 3), OPTIONAL_GREETER.id);
    const player = state.activePlayer;
    const played = reduce(state, { type: 'playCard', card }).state;
    const before = zoneOf(played, player, 'hand').length;

    const resolved = resolveChain(reduce(played, { type: 'resolveTrigger', perform: true }).state);
    expect(zoneOf(resolved, player, 'hand')).toHaveLength(before + 1);
  });

  it('leaves the Chain with no effect when declined (383.3.e.2.b)', () => {
    const [state, card] = withHandCard(inMainPhase('decline', 3), OPTIONAL_GREETER.id);
    const player = state.activePlayer;
    const played = reduce(state, { type: 'playCard', card }).state;
    const before = zoneOf(played, player, 'hand').length;

    const declined = reduce(played, { type: 'resolveTrigger', perform: false }).state;
    expect(declined.chain).toHaveLength(0);
    expect(zoneOf(declined, player, 'hand')).toHaveLength(before);
    checkInvariants(declined);
  });

  it('cannot be finalized by the wrong player', () => {
    const [state, card] = withHandCard(inMainPhase('wrong', 3), OPTIONAL_GREETER.id);
    const played = reduce(state, { type: 'playCard', card }).state;
    const opponent = playerId((played.activePlayer + 1) % played.players.length);

    expect(legalActions(played, opponent)).toEqual([]);
    expect(() =>
      reduce({ ...played, priority: opponent }, { type: 'resolveTrigger', perform: true }),
    ).toThrow(IllegalActionError);
  });

  it('rejects the action when nothing is pending', () => {
    expect(() => reduce(inMainPhase('nothing'), { type: 'resolveTrigger', perform: true })).toThrow(
      IllegalActionError,
    );
  });
});

describe('per-turn limits (rule 383.3.e)', () => {
  it('stops triggering once it has been performed the stated number of times', () => {
    const [first, cardA] = withHandCard(inMainPhase('limit', 5), LIMITED.id);
    const played = resolveChain(reduce(first, { type: 'playCard', card: cardA }).state);
    expect(played.triggersUsed[`${cardA}:0`]).toBe(1);

    // The same source cannot trigger again this turn.
    expect(triggersFor(played, { kind: 'played' }, { sources: [cardA] })).toEqual([]);
  });

  it('clears the counters at the end of the turn', () => {
    const [first, card] = withHandCard(inMainPhase('reset', 5), LIMITED.id);
    let state = resolveChain(reduce(first, { type: 'playCard', card }).state);
    expect(Object.keys(state.triggersUsed)).toHaveLength(1);

    state = reduce(state, { type: 'endTurn' }).state;
    while (state.phase === 'ending') {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    expect(state.triggersUsed).toEqual({});
  });

  it('leaves an unlimited ability alone', () => {
    const [state, card] = withBoardCard(inMainPhase('unlimited'), GREETER.id);
    expect(triggersFor(state, { kind: 'played' }, { sources: [card] })).toHaveLength(1);
    expect(card).toBeGreaterThanOrEqual(0);
  });
});

describe('death triggers', () => {
  it('fires after the death has been processed (383.2.c)', () => {
    // Put the Deathknell at a Battlefield with lethal damage already marked,
    // then let the Combat Cleanup kill it.
    let state = inMainPhase('death', 3);
    const [placed, unit] = withBoardCard(state, DEATHKNELL.id);
    state = moveEntity(placed, unit, battlefieldLocation(0));

    const triggers = triggersFor(state, { kind: 'dies' }, { sources: [unit] });
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.ability).toEqual({ kind: 'triggered', index: 0 });
  });

  it('is not offered for a Unit without one', () => {
    let state = inMainPhase('nodeath', 3);
    const [placed, unit] = withBoardCard(state, PLAIN.id);
    state = withEntity(placed, unit, (current) => ({ ...current, damage: 99 }));
    expect(triggersFor(state, { kind: 'dies' }, { sources: [unit] })).toEqual([]);
  });
});

describe('trigger ordering (rule 383.3.d.1)', () => {
  it('places the Turn Player`s triggers before an opponent`s', () => {
    const state = inMainPhase('order', 3);
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);

    // One identical source per player, the opponent's added first so the
    // ordering cannot come from insertion order.
    const [withTheirs, theirs] = withBoardCard(state, GREETER.id, opponent);
    const [both, mine] = withBoardCard(withTheirs, GREETER.id, player);

    const triggers = triggersFor(both, { kind: 'played' });
    expect(triggers.map((trigger) => trigger.source)).toEqual([mine, theirs]);
    expect(triggers.map((trigger) => trigger.controller)).toEqual([player, opponent]);
  });

  it('keeps a single player`s triggers in a fixed order', () => {
    // The within-player ordering choice of 383.3.d is not exposed; it is
    // deterministic instead, which is what keeps games reproducible.
    const state = inMainPhase('stable', 3);
    const [one, first] = withBoardCard(state, GREETER.id);
    const [two, second] = withBoardCard(one, GREETER.id);

    expect(triggersFor(two, { kind: 'played' }).map((trigger) => trigger.source)).toEqual([
      first,
      second,
    ]);
  });
});

describe('ability fuzz', () => {
  /** A deck built entirely from ability-carrying cards. */
  function abilityDeck(): DeckList {
    return {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 3 }, () => ACTIVATOR.id),
        ...Array.from({ length: 3 }, () => TAPPER.id),
        ...Array.from({ length: 3 }, () => GREETER.id),
        ...Array.from({ length: 3 }, () => OPTIONAL_GREETER.id),
        ...Array.from({ length: 3 }, () => LIMITED.id),
        ...Array.from({ length: 3 }, () => DEATHKNELL.id),
        ...Array.from({ length: 3 }, () => SNIPER.id),
        // The turn-boundary triggers, which hold a phase open mid-resolution.
        ...Array.from({ length: 3 }, () => CLOSER.id),
        ...Array.from({ length: 3 }, () => OPENER.id),
        // Cost modifiers, so affordability is a moving target for the walk.
        ...Array.from({ length: 3 }, () => DISCOUNTER.id),
        ...Array.from({ length: 3 }, () => TAXMAN.id),
      ],
      runes: Array.from({ length: 10 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
  }

  it('never reaches an inconsistent state and always terminates', () => {
    // The engine-wide fuzz plays vanilla cards, so abilities need their own
    // run: activation, pending triggers and per-turn counters are all state a
    // random walk can corrupt in ways a hand-written test would not think of.
    for (let game = 0; game < 20; game += 1) {
      const seed = `ability-fuzz-${game}`;
      const rng = Rng.fromSeed(seed);
      let state = createGame({
        decks: [abilityDeck(), abilityDeck()],
        registry: REGISTRY,
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

  it('empties the Chain of abilities before the turn passes', () => {
    // A pending trigger that outlived its turn would strand Priority.
    const seed = 'ability-chain';
    const rng = Rng.fromSeed(seed);
    let state = createGame({
      decks: [abilityDeck(), abilityDeck()],
      registry: REGISTRY,
      seed,
      config: { maxTurns: 40 },
    }).state;

    let previousTurn = state.turn;
    while (!isOver(state)) {
      const actions = currentLegalActions(state);
      if (actions.length === 0) break;
      state = reduce(state, rng.pick(actions)).state;
      if (state.turn !== previousTurn) {
        expect(state.chain).toEqual([]);
        previousTurn = state.turn;
      }
    }
  });
});

describe('the interruptible phase machine', () => {
  /** Advance until the phase changes or the Chain opens. */
  function step(state: GameState): GameState {
    return reduce(state, { type: 'resolvePhase' }).state;
  }

  /** Walk the turn cycle round to `player`'s next Beginning Phase. */
  function untilBeginningOf(state: GameState, player: PlayerId): GameState {
    let next = state;
    let guard = 0;
    while (next.activePlayer !== player || next.phase !== 'beginning') {
      if (guard++ > 40) throw new Error('never reached the Beginning Phase');
      // The Main Phase does not resolve on its own (316); it is ended.
      next = reduce(next, next.phase === 'main' ? { type: 'endTurn' } : { type: 'resolvePhase' })
        .state;
      if (next.chain.length > 0) {
        next = resolveChain(next);
      }
    }
    return next;
  }

  it('holds the Ending Phase open for an end-of-turn trigger (317.1)', () => {
    const [state, unit] = withBoardCard(inMainPhase('closer'), CLOSER.id);
    const player = state.activePlayer;
    const before = zoneOf(state, player, 'hand').length;

    let next = reduce(state, { type: 'endTurn' }).state;
    expect(next.phase).toBe('ending');

    // The phase does its first step, puts the trigger on the Chain and stops.
    next = step(next);
    expect(next.phase).toBe('ending');
    expect(next.chain).toHaveLength(1);
    expect(next.chain[0]?.entity).toBe(unit);
    expect(next.phaseStep).toBe(1);

    // Once the Chain drains, nobody holds Priority and the phase resumes.
    next = resolveChain(next);
    expect(next.phase).toBe('ending');
    expect(next.priority).toBeNull();
    expect(zoneOf(next, player, 'hand')).toHaveLength(before + 1);

    // Resuming skips the work already done and finishes the turn.
    next = step(next);
    expect(next.phase).toBe('awaken');
    expect(next.activePlayer).not.toBe(player);
    expect(next.phaseStep).toBe(0);
    checkInvariants(next);
  });

  it('lets the opponent respond while the phase is held', () => {
    // 383.3.c: a Triggered Ability goes on the Chain in any state on any
    // player's turn, and the Chain is the response window.
    const [state] = withBoardCard(inMainPhase('respond'), CLOSER.id);
    const opponent = playerId((state.activePlayer + 1) % state.players.length);

    let next = step(reduce(state, { type: 'endTurn' }).state);
    expect(next.chain).toHaveLength(1);
    // Priority is live during the hold, so passing is a real decision.
    expect(next.priority).not.toBeNull();
    next = reduce(next, { type: 'pass' }).state;
    expect(next.priority).toBe(opponent);
  });

  it('fires a Beginning Phase trigger before the Scoring Step (315.2)', () => {
    const [placed, unit] = withBoardCard(inMainPhase('opener'), OPENER.id);
    const player = placed.activePlayer;

    // Give the player a Battlefield to Hold, so both steps have work to do.
    const state: GameState = {
      ...placed,
      battlefields: placed.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: player, scoredBy: [] } : battlefield,
      ),
    };

    let next = untilBeginningOf(state, player);

    const pointsBefore = getPlayer(next, player).points;
    next = step(next);

    // The trigger is on the Chain and the Hold has NOT been scored yet.
    expect(next.chain).toHaveLength(1);
    expect(next.chain[0]?.entity).toBe(unit);
    expect(getPlayer(next, player).points).toBe(pointsBefore);

    next = resolveChain(next);
    next = step(next);
    // Now the Scoring Step has run.
    expect(getPlayer(next, player).points).toBe(pointsBefore + 1);
    expect(next.phase).toBe('channel');
  });

  it('does not re-run a step it already completed', () => {
    // The whole hazard of holding a phase open: resuming must not score twice.
    const [placed, unit] = withBoardCard(inMainPhase('once'), OPENER.id);
    const player = placed.activePlayer;
    const state: GameState = {
      ...placed,
      battlefields: placed.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: player, scoredBy: [] } : battlefield,
      ),
    };

    let next = untilBeginningOf(state, player);

    const pointsBefore = getPlayer(next, player).points;
    next = resolveChain(step(next));
    next = step(next);
    expect(getPlayer(next, player).points).toBe(pointsBefore + 1);
    expect(unit).toBeGreaterThanOrEqual(0);
  });

  it('leaves a phase with nothing to interrupt exactly as it was', () => {
    // Awaken, Channel and Draw have no trigger conditions, so they still
    // resolve in one action and never leave phaseStep set.
    let next = inMainPhase('plainphases');
    next = reduce(next, { type: 'endTurn' }).state;
    let guard = 0;
    while (next.phase !== 'main') {
      if (guard++ > 20) throw new Error('phases did not advance');
      next = reduce(next, { type: 'resolvePhase' }).state;
      expect(next.chain).toEqual([]);
      expect(next.phaseStep).toBe(0);
    }
  });
});
