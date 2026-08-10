/**
 * Non-Combat Showdowns and Scoring by Conquer.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import {
  makeBattlefield,
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
} from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { checkInvariants } from './invariants.js';
import { currentLegalActions, legalActions } from './legal.js';
import { moveEntity } from './mutate.js';
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

const LEGEND = makeLegend(['fury', 'calm'], { id: cardId('S-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('S-001'), champion: true });
const UNIT = makeUnit(2, ['fury'], { id: cardId('S-010'), name: 'Unit', cost: cost(1) });
const ACTION_SPELL = makeSpell(['fury'], {
  id: cardId('S-011'),
  name: 'Action',
  cost: cost(1),
  timing: 'action',
});
const FURY_RUNE = makeRune('fury', { id: cardId('S-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`S-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  UNIT,
  ACTION_SPELL,
  FURY_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [...Array.from({ length: 12 }, () => UNIT.id), ACTION_SPELL.id, ACTION_SPELL.id],
    runes: Array.from({ length: 8 }, () => FURY_RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function inMainPhase(seed = 'showdown'): GameState {
  let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state;
  while (state.phase !== 'main' && !isOver(state)) {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  return state;
}

function withReadyUnit(state: GameState): [GameState, EntityId] {
  const player = state.activePlayer;
  const card = state.players[player]!.zones.mainDeck.find(
    (id) => state.entities[id]!.card === UNIT.id,
  );
  if (card === undefined) {
    throw new Error('No Unit left in the deck');
  }
  return [moveEntity(state, card, playerLocation(player, 'base')), card];
}

/** Move a Unit onto an empty Battlefield, which opens a Showdown. */
function contesting(seed = 'showdown'): { state: GameState; unit: EntityId } {
  const [start, unit] = withReadyUnit(inMainPhase(seed));
  const state = reduce(start, { type: 'moveUnits', units: [unit], to: battlefieldLocation(0) })
    .state;
  return { state, unit };
}

/** Pass Focus until the Showdown Closes (rule 347.2.a). */
function passUntilClosed(state: GameState): GameState {
  let next = state;
  for (let i = 0; i < 10 && isShowdown(next); i += 1) {
    next = reduce(next, { type: 'pass' }).state;
  }
  return next;
}

describe('opening a Showdown (rules 344-345)', () => {
  it('opens when a Unit Contests an empty Battlefield', () => {
    const { state } = contesting();

    expect(isShowdown(state)).toBe(true);
    expect(state.showdown?.battlefield).toBe(0);
    expect(state.showdown?.combat).toBe(false);
  });

  it('gives Focus to the player who applied Contested (rule 345)', () => {
    const { state } = contesting();
    const mover = state.activePlayer;

    expect(state.showdown?.focus).toBe(mover);
    expect(state.priority).toBe(mover);
  });

  it('reports the opening as an event', () => {
    const [start, unit] = withReadyUnit(inMainPhase());
    const result = reduce(start, { type: 'moveUnits', units: [unit], to: battlefieldLocation(0) });

    expect(result.events).toContainEqual({
      type: 'showdownOpened',
      battlefield: 0,
      focus: start.activePlayer,
    });
  });
});

describe('acting during a Showdown (rules 342, 347)', () => {
  it('offers only Action or Reaction cards (rule 308.1.a)', () => {
    let { state } = contesting();
    // Give the player the resources and a Unit to try to play.
    const rune = state.players[state.activePlayer]!.zones.runes[0]!;
    state = reduce(state, { type: 'addEnergy', rune }).state;

    const unitInHand = state.players[state.activePlayer]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === UNIT.id,
    )!;
    const spell = state.players[state.activePlayer]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === ACTION_SPELL.id,
    )!;
    state = moveEntity(state, unitInHand, playerLocation(state.activePlayer, 'hand'));
    state = moveEntity(state, spell, playerLocation(state.activePlayer, 'hand'));

    const plays = currentLegalActions(state).filter((action) => action.type === 'playCard');

    // Whatever is offered, none of it may be a Unit: only Action and Reaction
    // cards are playable in a Showdown State.
    expect(plays.length).toBeGreaterThan(0);
    for (const play of plays) {
      if (play.type !== 'playCard') continue;
      expect(state.entities[play.card]!.card).toBe(ACTION_SPELL.id);
    }
    expect(plays.some((play) => play.type === 'playCard' && play.card === spell)).toBe(true);
    expect(plays.some((play) => play.type === 'playCard' && play.card === unitInHand)).toBe(false);
  });

  it('offers no Standard Move during a Showdown (rule 144.1.c)', () => {
    const { state } = contesting();
    expect(currentLegalActions(state).some((action) => action.type === 'moveUnits')).toBe(false);
  });

  it('offers no endTurn during a Showdown', () => {
    const { state } = contesting();
    expect(currentLegalActions(state).some((action) => action.type === 'endTurn')).toBe(false);
  });

  it('passes Focus to the next player rather than ending at once (rule 347.2.b)', () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    const opponent = playerId((mover + 1) % state.players.length);

    const after = reduce(state, { type: 'pass' }).state;

    expect(isShowdown(after)).toBe(true);
    expect(after.showdown?.focus).toBe(opponent);
    expect(after.priority).toBe(opponent);
  });

  it('gives the player without Focus no actions', () => {
    const { state } = contesting();
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    expect(legalActions(state, opponent)).toEqual([]);
  });
});

describe('closing a Showdown (rule 348.2)', () => {
  it('Closes once every player has passed in sequence (rule 347.2.a)', () => {
    const { state } = contesting();
    const closed = passUntilClosed(state);

    expect(isShowdown(closed)).toBe(false);
    expect(closed.priority).toBe(closed.activePlayer);
  });

  it('establishes Control for the only player with Units there', () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    const closed = passUntilClosed(state);

    expect(closed.battlefields[0]?.controller).toBe(mover);
    expect(closed.battlefields[0]?.contestedBy).toBeNull();
    checkInvariants(closed);
  });

  it('reports establishing Control as an event', () => {
    let { state } = contesting();
    const mover = state.activePlayer;
    state = reduce(state, { type: 'pass' }).state;
    const result = reduce(state, { type: 'pass' });

    expect(result.events).toContainEqual({
      type: 'controlEstablished',
      battlefield: 0,
      player: mover,
    });
  });

  it('lets play continue normally afterwards', () => {
    const closed = passUntilClosed(contesting().state);
    expect(currentLegalActions(closed).some((action) => action.type === 'endTurn')).toBe(true);
  });
});

describe('Scoring by Conquer (rules 469.1, 471)', () => {
  it('scores a point for establishing Control (rule 348.2.a.1)', () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    expect(state.players[mover]!.points).toBe(0);

    const closed = passUntilClosed(state);

    expect(closed.players[mover]!.points).toBe(1);
    expect(closed.battlefields[0]?.scoredBy).toEqual([mover]);
  });

  it('records the method as a Conquer (rule 469.1)', () => {
    let { state } = contesting();
    const mover = state.activePlayer;
    state = reduce(state, { type: 'pass' }).state;
    const result = reduce(state, { type: 'pass' });

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'pointsScored', method: 'conquer', player: mover }),
    );
  });

  it('does not score a Battlefield already Scored this turn (rule 470)', () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    const alreadyScored: GameState = {
      ...state,
      battlefields: state.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, scoredBy: [mover] } : battlefield,
      ),
    };

    const closed = passUntilClosed(alreadyScored);

    expect(closed.players[mover]!.points).toBe(0);
    expect(closed.battlefields[0]?.controller).toBe(mover);
  });
});

describe('the Final Point restriction (rule 471.1.b)', () => {
  /** A Conquer while one point short of the Victory Score. */
  function onTheBrink(scoredOther: boolean): { state: GameState; mover: number } {
    const { state } = contesting('brink');
    const mover = state.activePlayer;
    return {
      mover,
      state: {
        ...state,
        players: state.players.map((player) =>
          player.id === mover
            ? { ...player, points: state.config.victoryScore - 1 }
            : player,
        ),
        battlefields: state.battlefields.map((battlefield, index) =>
          index === 1 && scoredOther
            ? { ...battlefield, scoredBy: [mover] }
            : battlefield,
        ),
      },
    };
  }

  it('denies the Final Point unless every Battlefield was Scored this turn', () => {
    const { state, mover } = onTheBrink(false);
    const handBefore = state.players[mover]!.zones.hand.length;

    const closed = passUntilClosed(state);

    // No point; a card is drawn instead (rule 471.1.b.1).
    expect(closed.players[mover]!.points).toBe(state.config.victoryScore - 1);
    expect(closed.players[mover]!.zones.hand).toHaveLength(handBefore + 1);
    expect(closed.outcome).toBeNull();
  });

  it('reports the denial as an event', () => {
    const { state, mover } = onTheBrink(false);
    let next = reduce(state, { type: 'pass' }).state;
    const result = reduce(next, { type: 'pass' });

    expect(result.events).toContainEqual({
      type: 'finalPointDenied',
      player: playerId(mover),
      battlefield: 0,
    });
  });

  it('grants the Final Point when every Battlefield was Scored this turn', () => {
    const { state, mover } = onTheBrink(true);

    const closed = passUntilClosed(state);

    expect(closed.players[mover]!.points).toBe(state.config.victoryScore);
    expect(closed.outcome).toEqual({ kind: 'win', winner: playerId(mover) });
  });

  it('does not restrict a Conquer that is not for the Final Point', () => {
    const { state } = contesting('not-final');
    const mover = state.activePlayer;
    const early: GameState = {
      ...state,
      players: state.players.map((player) =>
        player.id === mover ? { ...player, points: 3 } : player,
      ),
    };

    const closed = passUntilClosed(early);

    expect(closed.players[mover]!.points).toBe(4);
  });
});
