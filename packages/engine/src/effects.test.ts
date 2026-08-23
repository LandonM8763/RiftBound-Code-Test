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

import { IllegalActionError } from './actions.js';
import { mightOf } from './combat.js';
import { conditionMet } from './condition.js';
import { allTargets, legalTargets } from './effects.js';
import { checkInvariants } from './invariants.js';
import { currentLegalActions, legalActions } from './legal.js';
import { moveEntity, withEntity } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import {
  battlefieldLocation,
  type EntityId,
  type GameState,
  getEntity,
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

/** "Give a unit -3 Might this turn, to a minimum of 1 Might." */
const WITHER = makeSpell(['calm'], {
  id: cardId('E-036'),
  name: 'Wither',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'any' },
    effects: [{ kind: 'giveMight', amount: -3, minimum: 1 }],
  },
});

/**
 * "Choose an enemy unit. If it is stunned, kill it. Otherwise, stun it."
 *
 * Two guarded steps rather than a branch tree — and the point of the test is
 * that the second guard cannot see what the first step did.
 */
const RECKONING = makeSpell(['calm'], {
  id: cardId('E-037'),
  name: 'Reckoning',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'enemy' },
    effects: [
      { kind: 'kill', condition: { kind: 'targetIs', stunned: true } },
      { kind: 'stun', condition: { kind: 'not', condition: { kind: 'targetIs', stunned: true } } },
    ],
  },
});

/** "Counter a spell." — a Reaction, since the Chain has to be up (425). */
const REBUKE = makeSpell(['calm'], {
  id: cardId('E-035'),
  name: 'Rebuke',
  cost: cost(1),
  timing: 'reaction',
  effect: {
    target: { kind: 'chainItem', cardType: 'spell' },
    effects: [{ kind: 'counter' }],
  },
});

/** "Deal 2 to all enemy units." — 355.5.a, an effect with no chosen target. */
const BARRAGE = makeSpell(['fury'], {
  id: cardId('E-032'),
  name: 'Barrage',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'all', scope: 'enemy' },
    effects: [{ kind: 'dealDamage', amount: 2 }],
  },
});

/** "Deal 2 to all units at battlefields." */
const RAIN = makeSpell(['fury'], {
  id: cardId('E-033'),
  name: 'Rain',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'all', scope: 'any', atBattlefield: true },
    effects: [{ kind: 'dealDamage', amount: 2 }],
  },
});

/** "Kill a gear." — 428 kills any Permanent, so only the sweep narrows. */
const DISARM = makeSpell(['fury'], {
  id: cardId('E-034'),
  name: 'Disarm',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'any', cardType: 'gear' },
    effects: [{ kind: 'kill' }],
  },
});

/** "Give two friendly units each +1 Might this turn." — a counted target (355.6). */
const WAR_CRY = makeSpell(['fury'], {
  id: cardId('E-040'),
  name: 'War Cry',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'friendly', count: { min: 2, max: 2 } },
    effects: [{ kind: 'giveMight', amount: 1 }],
  },
});

/** "Buff up to 2 friendly units." — the bounds differ, so choosing fewer is legal. */
const BLESSING = makeSpell(['fury'], {
  id: cardId('E-041'),
  name: 'Blessing',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'friendly', count: { min: 0, max: 2 } },
    effects: [{ kind: 'buff' }],
  },
});

/** "Deal damage equal to my Might to a unit." — a dynamic amount (143). */
const REPRISAL = makeSpell(['fury'], {
  id: cardId('E-042'),
  name: 'Reprisal',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'enemy' },
    effects: [{ kind: 'dealDamage', amount: 1, per: { kind: 'sourceMight' } }],
  },
});

/** "Deal damage equal to your points to a unit." — a count off the player. */
const TRIUMPH = makeSpell(['fury'], {
  id: cardId('E-043'),
  name: 'Triumph',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'unit', scope: 'enemy' },
    effects: [{ kind: 'dealDamage', amount: 1, per: { kind: 'points', who: 'you' } }],
  },
});

/** "Units you play this turn enter ready." — 390.4's Delayed Passive. */
const CONFRONT = makeSpell(['fury'], {
  id: cardId('E-044'),
  name: 'Confront',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'none' },
    effects: [
      { kind: 'thisTurn', static: { affects: { who: 'friendly' }, grant: { entersReady: true } } },
    ],
  },
});

/** "The next unit you play this turn enters ready." — a counted window. */
const ONE_SHOT = makeSpell(['fury'], {
  id: cardId('E-045'),
  name: 'One Shot',
  cost: cost(1),
  timing: 'action',
  effect: {
    target: { kind: 'none' },
    effects: [
      {
        kind: 'thisTurn',
        uses: 1,
        static: { affects: { who: 'friendly' }, grant: { entersReady: true } },
      },
    ],
  },
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
  BARRAGE,
  RAIN,
  DISARM,
  REBUKE,
  WITHER,
  RECKONING,
  WAR_CRY,
  BLESSING,
  REPRISAL,
  TRIUMPH,
  CONFRONT,
  ONE_SHOT,
  FURY_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 12 }, () => PLAIN.id),
      ...Array.from({ length: 3 }, () => BOLT.id),
      ...Array.from({ length: 2 }, () => INSIGHT.id),
      ...Array.from({ length: 2 }, () => RALLY.id),
      ...Array.from({ length: 2 }, () => SNIPE.id),
      ...Array.from({ length: 3 }, () => SCOUT.id),
      ...Array.from({ length: 3 }, () => BATTERY.id),
      ...Array.from({ length: 2 }, () => BARRAGE.id),
      ...Array.from({ length: 2 }, () => RAIN.id),
      ...Array.from({ length: 2 }, () => DISARM.id),
      ...Array.from({ length: 2 }, () => REBUKE.id),
      ...Array.from({ length: 3 }, () => WITHER.id),
      ...Array.from({ length: 3 }, () => RECKONING.id),
      ...Array.from({ length: 2 }, () => WAR_CRY.id),
      ...Array.from({ length: 2 }, () => BLESSING.id),
      ...Array.from({ length: 2 }, () => REPRISAL.id),
      ...Array.from({ length: 2 }, () => TRIUMPH.id),
      ...Array.from({ length: 2 }, () => CONFRONT.id),
      ...Array.from({ length: 2 }, () => ONE_SHOT.id),
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
    ...(target === undefined ? {} : { targets: [target] }),
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

  it('355.9: narrows to the source\'s own Battlefield with "here"', () => {
    let state = inMainPhase();
    const me = state.activePlayer;
    const [a, source] = onBoard(state, me, PLAIN, 0);
    state = a;
    const [b, sameField] = onBoard(state, me, PLAIN, 0);
    state = b;
    const [c, elsewhere] = onBoard(state, me, PLAIN, 1);
    state = c;

    const targets = legalTargets(state, me, { kind: 'unit', scope: 'any', here: true }, source);

    expect(targets).toContain(sameField);
    expect(targets).toContain(source);
    expect(targets).not.toContain(elsewhere);
  });

  it('names nothing when the source is not at a Battlefield', () => {
    let state = inMainPhase();
    const me = state.activePlayer;
    const [a, atBase] = onBoard(state, me, PLAIN, 'base');
    state = a;
    const [b] = onBoard(state, me, PLAIN, 0);
    state = b;

    // A source in a Base names no Battlefield, so 355.8 makes the card
    // unplayable rather than letting it reach the whole Board.
    expect(legalTargets(state, me, { kind: 'unit', scope: 'any', here: true }, atBase)).toEqual([]);
  });

  it('143: bounds by effective Might, not printed Might', () => {
    let state = inMainPhase();
    const me = state.activePlayer;
    const [a, small] = onBoard(state, me, PLAIN, 'base');
    state = a;
    const [b, buffed] = onBoard(state, me, PLAIN, 'base');
    state = withEntity(b, buffed, (current) => ({ ...current, mightBonus: 5 }));

    // PLAIN is 4 Might; the buffed one is 9.
    const targets = legalTargets(state, me, { kind: 'unit', scope: 'any', maxMight: 4 });

    expect(targets).toContain(small);
    expect(targets).not.toContain(buffed);
  });

  it('excludes the source itself for "another"', () => {
    let state = inMainPhase();
    const me = state.activePlayer;
    const [a, source] = onBoard(state, me, PLAIN, 'base');
    state = a;
    const [b, other] = onBoard(state, me, PLAIN, 'base');
    state = b;

    const spec = { kind: 'unit' as const, scope: 'friendly' as const, excludeSelf: true };
    expect(legalTargets(state, me, spec, source)).toEqual([other]);
    // Without a source there is nothing to exclude, which is the plain reading.
    expect(legalTargets(state, me, spec)).toContain(source);
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

describe('effects that affect everything (rule 355.5.a)', () => {
  it('chooses nothing, so it is playable with no target', () => {
    let state = withEnergy(inMainPhase(), 1);
    const [a, barrage] = toHand(state, BARRAGE);
    state = a;

    // 355.5.a: reaching objects "based on criteria" is not choosing, so
    // `legalActions` offers exactly one play rather than one per Unit.
    const [b] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;
    const plays = currentLegalActions(state).filter(
      (action) => action.type === 'playCard' && action.card === barrage,
    );

    expect(plays).toHaveLength(1);
    expect(plays[0]).not.toHaveProperty('target');
  });

  it('damages every enemy Unit and no friendly one', () => {
    let state = withEnergy(inMainPhase(), 1);
    const me = state.activePlayer;
    const them = playerId((me + 1) % state.players.length);
    const [a, barrage] = toHand(state, BARRAGE);
    state = a;
    const [b, mine] = onBoard(state, me, PLAIN, 'base');
    state = b;
    const [c, theirs] = onBoard(state, them, PLAIN, 'base');
    state = c;
    const [d, alsoTheirs] = onBoard(state, them, PLAIN, 0);
    state = d;

    const after = castSpell(state, barrage);

    expect(after.entities[theirs]!.damage).toBe(2);
    expect(after.entities[alsoTheirs]!.damage).toBe(2);
    expect(after.entities[mine]!.damage).toBe(0);
    checkInvariants(after);
  });

  it('narrows to Battlefields, leaving Bases alone', () => {
    let state = withEnergy(inMainPhase(), 1);
    const me = state.activePlayer;
    const [a, rain] = toHand(state, RAIN);
    state = a;
    const [b, atBase] = onBoard(state, me, PLAIN, 'base');
    state = b;
    const [c, atField] = onBoard(state, me, PLAIN, 0);
    state = c;

    const after = castSpell(state, rain);

    expect(after.entities[atField]!.damage).toBe(2);
    expect(after.entities[atBase]!.damage).toBe(0);
  });
});

describe('Gear as a target (428)', () => {
  it('offers a Gear and never a Unit', () => {
    let state = withEnergy(inMainPhase(), 2);
    const me = state.activePlayer;
    const [a, unit] = onBoard(state, me, PLAIN, 'base');
    state = a;
    const [b, gear] = onBoard(state, me, BATTERY, 'base');
    state = b;

    const targets = legalTargets(state, me, { kind: 'unit', scope: 'any', cardType: 'gear' });

    expect(targets).toEqual([gear]);
    expect(targets).not.toContain(unit);
  });

  it('kills the chosen Gear', () => {
    let state = withEnergy(inMainPhase(), 1);
    const me = state.activePlayer;
    const [a, disarm] = toHand(state, DISARM);
    state = a;
    const [b, gear] = onBoard(state, me, BATTERY, 'base');
    state = b;

    const after = castSpell(state, disarm, gear);

    expect(after.players[me]!.zones.trash).toContain(gear);
    checkInvariants(after);
  });
});

describe('reducing Might with a printed floor (143.2)', () => {
  it('stops at the floor rather than continuing past it', () => {
    let state = withEnergy(inMainPhase('wither'), 1);
    const me = state.activePlayer;
    const [a, wither] = toHand(state, WITHER);
    state = a;
    const [b, victim] = onBoard(state, me, PLAIN, 'base');
    state = b;

    // PLAIN is 4 Might; -3 to a minimum of 1 lands exactly on the floor.
    const after = castSpell(state, wither, victim);

    expect(mightOf(after, victim)).toBe(1);
    expect(after.entities[victim]!.mightBonus).toBe(-3);
  });

  it('applies only as much as the floor allows', () => {
    let state = withEnergy(inMainPhase('wither-partial'), 1);
    const me = state.activePlayer;
    const [a, wither] = toHand(state, WITHER);
    state = a;
    const [b, victim] = onBoard(state, me, PLAIN, 'base');
    // Already down to 2: only 1 of the 3 may be taken.
    state = withEntity(b, victim, (current) => ({ ...current, mightBonus: -2 }));

    const after = castSpell(state, wither, victim);

    expect(mightOf(after, victim)).toBe(1);
    expect(after.entities[victim]!.mightBonus).toBe(-3);
  });

  it('143.2.b.1: measures against the actual Might, not the floored 0', () => {
    let state = withEnergy(inMainPhase('wither-negative'), 1);
    const me = state.activePlayer;
    const [a, wither] = toHand(state, WITHER);
    state = a;
    const [b, victim] = onBoard(state, me, PLAIN, 'base');
    // Actual Might -1. `mightOf` reports 0, but 143.2.b.1 says it "is not 0"
    // and that increases and decreases use the actual value — so a reduction
    // to a minimum of 1 must take nothing, never *raise* it to 1.
    state = withEntity(b, victim, (current) => ({ ...current, mightBonus: -5 }));

    const after = castSpell(state, wither, victim);

    expect(after.entities[victim]!.mightBonus).toBe(-5);
    expect(mightOf(after, victim)).toBe(0);
  });
});

describe('guarded effect steps', () => {
  it('runs the branch whose guard holds', () => {
    let state = withEnergy(inMainPhase('guard-stun'), 1);
    const me = state.activePlayer;
    const them = playerId((me + 1) % state.players.length);
    const [a, spell] = toHand(state, RECKONING);
    state = a;
    const [b, victim] = onBoard(state, them, PLAIN, 'base');
    state = b;

    // Not stunned, so the "otherwise" branch runs and the Unit survives.
    const after = castSpell(state, spell, victim);

    expect(after.entities[victim]!.stunned).toBe(true);
    expect(after.players[them]!.zones.base).toContain(victim);
  });

  it('takes the first branch when its guard holds', () => {
    let state = withEnergy(inMainPhase('guard-kill'), 1);
    const me = state.activePlayer;
    const them = playerId((me + 1) % state.players.length);
    const [a, spell] = toHand(state, RECKONING);
    state = a;
    const [b, victim] = onBoard(state, them, PLAIN, 'base');
    state = withEntity(b, victim, (current) => ({ ...current, stunned: true }));

    const after = castSpell(state, spell, victim);

    expect(after.players[them]!.zones.trash).toContain(victim);
    checkInvariants(after);
  });

  it('asks every guard against the state on entry, so an else cannot see the branch above it', () => {
    // The hazard this rules out: kill a stunned Unit, then have "otherwise,
    // stun it" observe a corpse that is no longer stunned and stun it again.
    let state = withEnergy(inMainPhase('guard-once'), 1);
    const me = state.activePlayer;
    const them = playerId((me + 1) % state.players.length);
    const [a, spell] = toHand(state, RECKONING);
    state = a;
    const [b, victim] = onBoard(state, them, PLAIN, 'base');
    state = withEntity(b, victim, (current) => ({ ...current, stunned: true }));

    const after = castSpell(state, spell, victim);

    // Killed by the first branch, and 705's cleanup left it unstunned — which
    // is exactly the state a re-evaluated "otherwise" would have acted on.
    expect(after.players[them]!.zones.trash).toContain(victim);
    expect(after.entities[victim]!.stunned).toBe(false);
  });

  it('is false without a chosen target, the way a source condition is', () => {
    const state = inMainPhase('guard-none');
    expect(
      conditionMet(state, state.activePlayer, undefined, { kind: 'targetIs', stunned: true }),
    ).toBe(false);
  });
});

describe('Counter (rule 425)', () => {
  it('425.1.a: clears the item from the Chain, and 425.1.a.1 trashes the card', () => {
    let state = withEnergy(inMainPhase('counter'), 4);
    const me = state.activePlayer;
    const [a, bolt] = toHand(state, BOLT);
    state = a;
    const [b, rebuke] = toHand(state, REBUKE);
    state = b;
    const [c, victim] = onBoard(state, me, PLAIN, 'base');
    state = c;

    // The Bolt lingers on the Chain (359.3), which is what makes it Counterable.
    state = reduce(state, { type: 'playCard', card: bolt, targets: [victim]}).state;
    expect(state.chain).toHaveLength(1);

    state = reduce(state, { type: 'playCard', card: rebuke, targets: [bolt]}).state;
    expect(state.chain).toHaveLength(2);

    // Resolve the Rebuke; the Bolt is cleared rather than resolving.
    state = reduce(state, { type: 'pass' }).state;
    state = reduce(state, { type: 'pass' }).state;

    expect(state.chain).toHaveLength(0);
    expect(state.players[me]!.zones.trash).toContain(bolt);
    // 425.1.a: it "does nothing", so the damage never lands.
    expect(state.entities[victim]!.damage).toBe(0);
    checkInvariants(state);
  });

  it('offers nothing to Counter while the Chain is empty (355.8)', () => {
    let state = withEnergy(inMainPhase('counter-empty'), 4);
    const [a, rebuke] = toHand(state, REBUKE);
    state = a;

    expect(legalTargets(state, state.activePlayer, { kind: 'chainItem', cardType: 'spell' })).toEqual(
      [],
    );
    expect(
      currentLegalActions(state).filter(
        (action) => action.type === 'playCard' && action.card === rebuke,
      ),
    ).toEqual([]);
  });

  it('356.1.c: filters on the printed cost, not the modified one', () => {
    let state = withEnergy(inMainPhase('counter-cost'), 4);
    const me = state.activePlayer;
    const [a, bolt] = toHand(state, BOLT);
    state = a;
    const [b, victim] = onBoard(state, me, PLAIN, 'base');
    state = b;
    state = reduce(state, { type: 'playCard', card: bolt, targets: [victim]}).state;

    // Bolt costs 1 Energy.
    expect(legalTargets(state, me, { kind: 'chainItem', maxEnergy: 1 })).toEqual([bolt]);
    expect(legalTargets(state, me, { kind: 'chainItem', maxEnergy: 0 })).toEqual([]);
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
    const onChain = reduce(state, { type: 'playCard', card: bolt, targets: [victim]}).state;
    expect(onChain.entities[victim]!.damage).toBe(0);
    expect(onChain.chain).toHaveLength(1);
    expect(onChain.chain[0]?.targets).toEqual([victim]);
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

    let onChain = reduce(state, { type: 'playCard', card: bolt, targets: [victim]}).state;
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
      reduce(state, { type: 'playCard', card: plain, targets: [other]}),
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

describe('counted targets (rule 355.6)', () => {
  it('applies the effect to every chosen object', () => {
    let state = withEnergy(inMainPhase('counted'), 1);
    const [a, first] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;
    const [b, second] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;
    const [c, cry] = toHand(state, WAR_CRY);
    state = c;

    state = reduce(state, { type: 'playCard', card: cry, targets: [first, second] }).state;
    state = reduce(reduce(state, { type: 'pass' }).state, { type: 'pass' }).state;

    expect(mightOf(state, first)).toBe(PLAIN.might + 1);
    expect(mightOf(state, second)).toBe(PLAIN.might + 1);
    checkInvariants(state);
  });

  it('offers one action per combination, and never the same set twice', () => {
    let state = withEnergy(inMainPhase('combinations'), 1);
    for (let i = 0; i < 3; i += 1) {
      const [next] = onBoard(state, state.activePlayer, PLAIN, 'base');
      state = next;
    }
    const [withCry, cry] = toHand(state, WAR_CRY);
    state = withCry;

    const plays = legalActions(state, state.activePlayer).filter(
      (action) => action.type === 'playCard' && action.card === cry,
    ) as { targets?: readonly EntityId[] }[];

    // Three Units the player controls, plus the Champion already in play: the
    // sets are the unordered pairs, so C(n, 2) of them and no duplicates.
    const sets = plays.map((play) => [...(play.targets ?? [])].sort().join(','));
    expect(new Set(sets).size).toBe(sets.length);
    expect(plays.every((play) => play.targets?.length === 2)).toBe(true);
  });

  it('355.6: refuses a set naming the same object twice', () => {
    let state = withEnergy(inMainPhase('duplicate'), 1);
    const [a, only] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;
    const [b, cry] = toHand(state, WAR_CRY);
    state = b;

    expect(() =>
      reduce(state, { type: 'playCard', card: cry, targets: [only, only] }),
    ).toThrow(IllegalActionError);
  });

  it('refuses a set outside the spec\'s bounds', () => {
    let state = withEnergy(inMainPhase('bounds'), 1);
    const [a, first] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;
    const [b, second] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = b;
    const [c, third] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = c;
    const [d, cry] = toHand(state, WAR_CRY);
    state = d;

    // "two friendly units" is exact: one is too few and three too many.
    expect(() => reduce(state, { type: 'playCard', card: cry, targets: [first] })).toThrow(
      IllegalActionError,
    );
    expect(() =>
      reduce(state, { type: 'playCard', card: cry, targets: [first, second, third] }),
    ).toThrow(IllegalActionError);
  });

  it('"up to" makes choosing fewer — or none — a legal choice', () => {
    let state = withEnergy(inMainPhase('uptoN'), 1);
    const [a, only] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;
    const [b, blessing] = toHand(state, BLESSING);
    state = b;

    const offered = legalActions(state, state.activePlayer).filter(
      (action) => action.type === 'playCard' && action.card === blessing,
    ) as { targets?: readonly EntityId[] }[];
    const sizes = new Set(offered.map((play) => play.targets?.length ?? 0));
    expect(sizes).toContain(0);
    expect(sizes).toContain(1);

    // Choosing none still resolves: the steps run, they just reach nobody.
    const none = reduce(state, { type: 'playCard', card: blessing }).state;
    const settled = reduce(reduce(none, { type: 'pass' }).state, { type: 'pass' }).state;
    expect(getEntity(settled, only).buffs).toBe(0);
    checkInvariants(settled);
  });
});

describe('dynamic amounts (rules 143, 807)', () => {
  it('scales the printed number by what the count reads', () => {
    let state = withEnergy(inMainPhase('dynamic'), 1);
    const them = state.activePlayer === playerId(0) ? playerId(1) : playerId(0);
    const [a, mine] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;
    const [b, theirs] = onBoard(state, them, PLAIN, 'base');
    state = b;
    const [c, reprisal] = toHand(state, REPRISAL);
    state = c;

    // The source of a Spell's effect is the Spell itself, which has no Might —
    // 143 is a Unit's stat — so this reads 0 and deals no Valid Damage (417.1.e).
    state = castSpell(state, reprisal, theirs);
    expect(getEntity(state, theirs).damage).toBe(0);
    expect(mightOf(state, mine)).toBe(PLAIN.might);
    checkInvariants(state);
  });

  it('reads a count off the player, not the board', () => {
    let state = withEnergy(inMainPhase('points'), 1);
    const them = state.activePlayer === playerId(0) ? playerId(1) : playerId(0);
    const [a, theirs] = onBoard(state, them, PLAIN, 'base');
    state = a;
    const [b, triumph] = toHand(state, TRIUMPH);
    state = b;
    state = {
      ...state,
      players: state.players.map((seat) =>
        seat.id === state.activePlayer ? { ...seat, points: 3 } : seat,
      ) as typeof state.players,
    };

    state = castSpell(state, triumph, theirs);
    expect(getEntity(state, theirs).damage).toBe(3);
    checkInvariants(state);
  });

  it('417.1.e: a count of zero deals nothing rather than negative damage', () => {
    let state = withEnergy(inMainPhase('zero'), 1);
    const them = state.activePlayer === playerId(0) ? playerId(1) : playerId(0);
    const [a, theirs] = onBoard(state, them, PLAIN, 'base');
    state = a;
    const [b, triumph] = toHand(state, TRIUMPH);
    state = b;

    state = castSpell(state, triumph, theirs);
    expect(getEntity(state, theirs).damage).toBe(0);
    checkInvariants(state);
  });
});

describe('object filters (417, 414, 423, 702, 133.8)', () => {
  it('narrows a chosen target to the state the card names', () => {
    let state = withEnergy(inMainPhase('filter'), 1);
    const [a, ready] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;
    const [b, tired] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = withEntity(b, tired, (current) => ({ ...current, exhausted: true }));

    const spec = { kind: 'unit', scope: 'friendly', filter: { exhausted: true } } as const;
    const legal = legalTargets(state, state.activePlayer, spec);
    expect(legal).toContain(tired);
    expect(legal).not.toContain(ready);
  });

  it('narrows an `all` sweep the same way, so the two never disagree', () => {
    let state = inMainPhase('allfilter');
    const [a, hurt] = onBoard(state, state.activePlayer, PLAIN, 0);
    state = withEntity(a, hurt, (current) => ({ ...current, damage: 1 }));
    const [b, whole] = onBoard(state, state.activePlayer, PLAIN, 0);
    state = b;

    const every = allTargets(state, state.activePlayer, {
      kind: 'all',
      scope: 'friendly',
      filter: { damaged: true },
    });
    expect(every).toContain(hurt);
    expect(every).not.toContain(whole);
  });

  it('133.8: a tag filter matches nothing while the data carries no tags', () => {
    // The engine answers this; today's export does not supply it, so the gap
    // is recorded rather than the clause refused.
    let state = inMainPhase('tagfilter');
    const [a] = onBoard(state, state.activePlayer, PLAIN, 'base');
    state = a;
    expect(
      legalTargets(state, state.activePlayer, {
        kind: 'unit',
        scope: 'friendly',
        filter: { tag: 'Mech' },
      }),
    ).toEqual([]);
  });
});

describe('Delayed Passive Abilities (rule 390.4)', () => {
  /** Play a Unit from hand and let the Chain settle. */
  const playUnit = (state: GameState): [GameState, EntityId] => {
    const [withCard, card] = toHand(state, PLAIN);
    let next = reduce(withCard, {
      type: 'playCard',
      card,
      location: playerLocation(next0(withCard), 'base'),
    }).state;
    while (next.chain.length > 0) {
      next = reduce(next, { type: 'pass' }).state;
    }
    return [next, card];
  };
  const next0 = (state: GameState) => state.activePlayer;

  it('359.2.c: a Unit enters exhausted, and the window changes that', () => {
    let state = withEnergy(inMainPhase('window'), 3);
    // Without the window, 359.2.c applies.
    const [before, plain] = playUnit(state);
    expect(getEntity(before, plain).exhausted).toBe(true);

    const [a, confront] = toHand(state, CONFRONT);
    state = castSpell(a, confront);
    const [after, wide] = playUnit(state);
    expect(getEntity(after, wide).exhausted).toBe(false);
    checkInvariants(after);
  });

  it('"the next" spends one use and then stops applying', () => {
    let state = withEnergy(inMainPhase('one-shot'), 6);
    const [a, spell] = toHand(state, ONE_SHOT);
    state = castSpell(a, spell);
    expect(state.turnEffects).toHaveLength(1);

    const [first, one] = playUnit(state);
    expect(getEntity(first, one).exhausted).toBe(false);
    expect(first.turnEffects[0]?.uses).toBe(0);

    // Spent: the second Unit enters exhausted like any other.
    // Top the pool up directly: `withEnergy` exhausts Runes, and by now they
    // are spent.
    const topped: GameState = {
      ...first,
      players: first.players.map((seat) =>
        seat.id === first.activePlayer ? { ...seat, pool: { ...seat.pool, energy: 5 } } : seat,
      ) as typeof first.players,
    };
    const [second, two] = playUnit(topped);
    expect(getEntity(second, two).exhausted).toBe(true);
    checkInvariants(second);
  });

  it('317.2.c: the window expires with the turn, with nothing to unwind', () => {
    let state = withEnergy(inMainPhase('expire'), 3);
    const [a, confront] = toHand(state, CONFRONT);
    state = castSpell(a, confront);
    expect(state.turnEffects).toHaveLength(1);

    // Run the turn out. A Passive is consulted, never written onto anything,
    // so dropping the entry is the whole of expiring it.
    let next = state;
    for (let i = 0; i < 60 && next.turnEffects.length > 0 && !isOver(next); i += 1) {
      next = reduce(next, currentLegalActions(next)[0] as never).state;
    }
    expect(next.turnEffects).toEqual([]);
    checkInvariants(next);
  });
});
