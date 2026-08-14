/**
 * Attachment (rules 434-435, 716-719, 724).
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The direction is what to keep straight: a Gear is what gets Attached, and the
 * *Unit* becomes the Top-Most Card (818.1.b.2). So the Gear's Effect Text reads
 * as though printed on the Unit — 718.3 for its abilities, 718.4 for its Might.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeGear, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { attach, attachmentsOf, detach } from './attach.js';
import { mightOf } from './combat.js';
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
