/**
 * Zone movement: returning cards to hand.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The distinction worth pinning hardest is bounce against Recall. Rule 412
 * lists no "Return" action, so a bounce is an ordinary zone move that takes a
 * Permanent *off* the Board — where a Recall (455) relocates it to its owner's
 * Base and 458.1 leaves its damage and statuses untouched.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeSpell, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { legalTargets } from './effects.js';
import { checkInvariants } from './invariants.js';
import { legalActions } from './legal.js';
import { moveEntity, withEntity, withPlayer } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import { isToken } from './token.js';
import {
  battlefieldLocation,
  isOver,
  playerLocation,
  type EntityId,
  type GameState,
} from './state.js';

const LEGEND = makeLegend(['fury'], { id: cardId('Z-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('Z-001'), champion: true });
const PLAIN = makeUnit(2, ['fury'], { id: cardId('Z-010'), name: 'Plain', cost: cost(1) });

/** "Return a unit at a battlefield to its owner's hand." */
const REBUKE = makeSpell(['fury'], {
  id: cardId('Z-011'),
  name: 'Rebuke',
  cost: cost(1),
  effect: {
    target: { kind: 'unit', scope: 'any', atBattlefield: true },
    effects: [{ kind: 'toHand' }],
  },
});

/** "When you play me, return a unit from your trash to your hand." */
const ATTENDANT = makeUnit(2, ['fury'], {
  id: cardId('Z-012'),
  name: 'Attendant',
  cost: cost(1),
  effect: {
    target: { kind: 'trashCard', cardType: 'unit' },
    effects: [{ kind: 'toHand' }],
  },
});

/** Creates a token, so a bounced token can be checked against 186.1. */
const DRUMMER = makeUnit(2, ['fury'], {
  id: cardId('Z-014'),
  name: 'Drummer',
  cost: cost(1),
  effect: {
    target: { kind: 'none' },
    effects: [{ kind: 'createToken', token: 'recruit', count: 1, where: 'base' }],
  },
});

const RUNE = makeRune('fury', { id: cardId('Z-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`Z-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  REBUKE,
  ATTENDANT,
  DRUMMER,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 8 }, () => PLAIN.id),
      ...Array.from({ length: 3 }, () => REBUKE.id),
      ...Array.from({ length: 3 }, () => ATTENDANT.id),
      ...Array.from({ length: 3 }, () => DRUMMER.id),
    ],
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function inMainPhase(seed = 'zones', energy = 6): GameState {
  let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state;
  while (state.phase === 'mulligan') {
    state = reduce(state, { type: 'mulligan', cards: [] }).state;
  }
  while (state.phase !== 'main' && !isOver(state)) {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  return withPlayer(state, state.activePlayer, (seat) => ({
    ...seat,
    pool: { energy, power: seat.pool.power },
  }));
}

function inHand(state: GameState, id: CardDefinition['id']): [GameState, EntityId] {
  const player = state.activePlayer;
  const held = state.players[player]!.zones.hand.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (held !== undefined) {
    return [state, held];
  }
  const card = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (card === undefined) {
    throw new Error(`No ${id} left in the deck`);
  }
  return [moveEntity(state, card, playerLocation(player, 'hand')), card];
}

/** Put a Unit belonging to `owner` at Battlefield 0. */
function atBattlefield(state: GameState, owner: number): [GameState, EntityId] {
  const card = state.players[owner]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === PLAIN.id,
  );
  if (card === undefined) {
    throw new Error('No Plain left');
  }
  return [moveEntity(state, card, battlefieldLocation(0)), card];
}

describe('returning a Permanent to hand', () => {
  it('takes it off the Board, into *its owner\'s* hand', () => {
    // The victim belongs to player 0; whichever seat is active plays the Spell,
    // so when they differ this also pins that the card goes to the owner rather
    // than to whoever returned it.
    const [state, victim] = atBattlefield(inMainPhase('bounce'), 0);
    const owner = state.entities[victim]!.owner;
    const [withSpell, spell] = inHand(state, REBUKE.id);

    const played = reduce(withSpell, { type: 'playCard', card: spell, target: victim }).state;
    // A Spell lingers on the Chain (359.3), so resolve it.
    const resolved = reduce(played, { type: 'pass' }).state;
    const settled = resolved.chain.length > 0 ? reduce(resolved, { type: 'pass' }).state : resolved;

    expect(settled.battlefields[0]!.units).not.toContain(victim);
    expect(owner).toBe(0);
    expect(settled.players[owner]!.zones.hand).toContain(victim);
    checkInvariants(settled);
  });

  it('is not a Recall: it does not go to the Base (455, 458.1)', () => {
    const [base, victim] = atBattlefield(inMainPhase('not-recall'), 0);
    const [state, spell] = inHand(base, REBUKE.id);

    const played = reduce(state, { type: 'playCard', card: spell, target: victim }).state;
    let settled = reduce(played, { type: 'pass' }).state;
    if (settled.chain.length > 0) {
      settled = reduce(settled, { type: 'pass' }).state;
    }

    const owner = settled.entities[victim]!.owner;
    expect(settled.players[owner]!.zones.base).not.toContain(victim);
    expect(settled.entities[victim]!.location).toEqual(playerLocation(owner, 'hand'));
  });

  it('705: leaving the Board strips Buffs, damage and everything granted this turn', () => {
    let [state, victim] = atBattlefield(inMainPhase('counters'), 0);
    state = withEntity(state, victim, (e) => ({
      ...e,
      buffs: 1,
      damage: 1,
      mightBonus: 2,
      grantedKeywords: [{ kind: 'tank' }],
      exhausted: true,
    }));
    const [withSpell, spell] = inHand(state, REBUKE.id);

    const played = reduce(withSpell, { type: 'playCard', card: spell, target: victim }).state;
    let settled = reduce(played, { type: 'pass' }).state;
    if (settled.chain.length > 0) {
      settled = reduce(settled, { type: 'pass' }).state;
    }

    expect(settled.entities[victim]).toMatchObject({
      buffs: 0,
      damage: 0,
      mightBonus: 0,
      grantedKeywords: [],
      exhausted: false,
    });
  });

  it('186.1: a Token stops existing rather than becoming a card in a hand', () => {
    const [state, drummer] = inHand(inMainPhase('bounce-token'), DRUMMER.id);
    const player = state.activePlayer;
    let next = reduce(state, { type: 'playCard', card: drummer }).state;
    const token = next.players[player]!.zones.base.find((id) => isToken(next, id))!;
    // Put it where the Spell can reach it.
    next = moveEntity(next, token, battlefieldLocation(0));

    const [withSpell, spell] = inHand(next, REBUKE.id);
    const played = reduce(withSpell, { type: 'playCard', card: spell, target: token }).state;
    let settled = reduce(played, { type: 'pass' }).state;
    if (settled.chain.length > 0) {
      settled = reduce(settled, { type: 'pass' }).state;
    }

    // 185: it is not a card, so it never reaches a hand.
    expect(settled.players[player]!.zones.hand).not.toContain(token);
    expect(settled.players[player]!.zones.banishment).toContain(token);
    checkInvariants(settled);
  });
});

describe('retrieving a card from the trash', () => {
  it('moves it from the trash into hand', () => {
    let state = inMainPhase('retrieve');
    const player = state.activePlayer;
    const buried = state.players[player]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === PLAIN.id,
    )!;
    state = moveEntity(state, buried, playerLocation(player, 'trash'));
    const [withCard, card] = inHand(state, ATTENDANT.id);

    const played = reduce(withCard, { type: 'playCard', card, target: buried }).state;

    expect(played.players[player]!.zones.trash).not.toContain(buried);
    expect(played.players[player]!.zones.hand).toContain(buried);
    checkInvariants(played);
  });

  it('offers only cards of the printed type', () => {
    let state = inMainPhase('retrieve-type');
    const player = state.activePlayer;
    const unit = state.players[player]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === PLAIN.id,
    )!;
    const spell = state.players[player]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === REBUKE.id,
    )!;
    state = moveEntity(state, unit, playerLocation(player, 'trash'));
    state = moveEntity(state, spell, playerLocation(player, 'trash'));

    const targets = legalTargets(state, player, { kind: 'trashCard', cardType: 'unit' });

    expect(targets).toContain(unit);
    expect(targets).not.toContain(spell);
  });

  it('355.8: an empty trash makes the card unplayable, not a no-op', () => {
    const [state, card] = inHand(inMainPhase('retrieve-empty'), ATTENDANT.id);
    const player = state.activePlayer;
    // Nothing is in the trash this early, so there is no valid choice to make.
    expect(state.players[player]!.zones.trash).toHaveLength(0);

    const plays = legalActions(state, player).filter(
      (action) => action.type === 'playCard' && action.card === card,
    );
    expect(plays).toHaveLength(0);
  });
});

describe('Recycle (rule 416)', () => {
  // Recycle is not a card-effect primitive — it measured +0, see the note in
  // `cards/effect.ts`. The engine still performs it where the rules demand,
  // which is what this covers.
  it('416.1.b: a Rune is Recycled to the Rune Deck, not the Main Deck', () => {
    // The Basic Rune's own `Recycle this: Add [C]` already exercises 416.1.b;
    // this pins that the destination is chosen by card type rather than by the
    // zone the card came from.
    let state = inMainPhase('recycle-rune');
    const player = state.activePlayer;
    const rune = state.players[player]!.zones.runes[0];
    if (rune === undefined) {
      throw new Error('no rune in play');
    }

    const recycled = reduce(state, { type: 'addPower', rune }).state;

    expect(recycled.players[player]!.zones.runeDeck).toContain(rune);
    expect(recycled.players[player]!.zones.mainDeck).not.toContain(rune);
  });
});
