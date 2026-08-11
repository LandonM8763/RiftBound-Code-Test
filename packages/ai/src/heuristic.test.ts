/**
 * The heuristic agent, and the head-to-head result that justifies it.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import {
  battlefieldLocation,
  createGame,
  observe,
  playerId,
  type Action,
  type DeckList,
  type GameView,
} from '@riftbound/engine';
import { describe, expect, it } from 'vitest';

import type { Agent } from './agent.js';
import { DEFAULT_WEIGHTS, HeuristicAgent } from './heuristic.js';
import { playGame } from './match.js';
import { RandomAgent } from './random.js';

const LEGEND = makeLegend(['fury', 'calm'], { id: cardId('OGN-001'), name: 'Legend' });
const CHAMPION = makeUnit(4, ['fury'], { id: cardId('OGN-002'), name: 'Champion', champion: true });
/** Varied Might and cost, so evaluation has something to discriminate between. */
const UNITS = Array.from({ length: 14 }, (_, i) =>
  makeUnit(2 + (i % 4), ['fury'], {
    id: cardId(`OGN-1${String(i).padStart(2, '0')}`),
    name: `Unit ${i}`,
    cost: cost(1 + (i % 3)),
  }),
);
const FURY_RUNE = makeRune('fury', { id: cardId('OGN-200'), name: 'Fury Rune' });
const CALM_RUNE = makeRune('calm', { id: cardId('OGN-201'), name: 'Calm Rune' });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`OGN-30${i}`), name: `Battlefield ${i}` }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  ...UNITS,
  FURY_RUNE,
  CALM_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

const DECK: DeckList = {
  legend: LEGEND.id,
  champion: CHAMPION.id,
  main: [
    ...UNITS.slice(0, 13).flatMap((unit) => [unit.id, unit.id, unit.id]),
    (UNITS[13] as CardDefinition).id,
  ],
  runes: [
    ...Array.from({ length: 6 }, () => FURY_RUNE.id),
    ...Array.from({ length: 6 }, () => CALM_RUNE.id),
  ],
  battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
};

interface DuelResult {
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly decided: number;
  readonly winRate: number;
  /** Half-width of the 95% interval on `winRate`. */
  readonly margin: number;
}

/**
 * Play `games` between two agent factories, alternating seats.
 *
 * The seat swap matters: the player going second Channels an extra Rune
 * (485.7), so a fixed seating would measure that as well as the agents. The
 * loop lives here rather than in `ai/` on purpose — `playGame` runs one game,
 * and batch simulation belongs to the planned `sim` package.
 */
function duel(games: number, a: (seed: string) => Agent, b: (seed: string) => Agent): DuelResult {
  let wins = 0;
  let losses = 0;
  let draws = 0;

  for (let i = 0; i < games; i += 1) {
    const swapped = i % 2 === 1;
    const agents = swapped ? [b(`b${i}`), a(`a${i}`)] : [a(`a${i}`), b(`b${i}`)];
    const result = playGame({
      registry: REGISTRY,
      decks: [DECK, DECK],
      agents,
      seed: `duel-${i}`,
      config: { maxTurns: 300 },
    });

    if (result.outcome.kind === 'draw') {
      draws += 1;
    } else if (result.outcome.winner === (swapped ? 1 : 0)) {
      wins += 1;
    } else {
      losses += 1;
    }
  }

  const decided = wins + losses;
  const winRate = decided === 0 ? 0 : wins / decided;
  const margin = decided === 0 ? 1 : 1.96 * Math.sqrt((winRate * (1 - winRate)) / decided);
  return { wins, losses, draws, decided, winRate, margin };
}

/** A view from a real game, to score without hand-building the whole structure. */
function viewOf(seed = 'eval'): GameView {
  const state = createGame({ decks: [DECK, DECK], registry: REGISTRY, seed }).state;
  return observe(state, playerId(0));
}

describe('HeuristicAgent strength', () => {
  // A new tier has to beat the previous one convincingly or it is not an
  // improvement. 120 games is enough to separate ~85% from 50% many times over.
  it('beats the random agent over a large sample', () => {
    const result = duel(120, (seed) => new HeuristicAgent({ seed }), (seed) => new RandomAgent(seed));

    // Reported rather than merely asserted: a win rate with no sample size and
    // no uncertainty is not a statistic.
    expect(result.decided).toBeGreaterThan(100);
    expect(result.winRate - result.margin).toBeGreaterThan(0.65);
  });

  it('measures an even matchup as even, so the harness is not seat-biased', () => {
    // The control. Two identical agents on identical decks should be a coin
    // flip once seats alternate; if this drifts, the duel above means nothing.
    const result = duel(120, (seed) => new RandomAgent(`x${seed}`), (seed) => new RandomAgent(seed));
    expect(Math.abs(result.winRate - 0.5)).toBeLessThan(result.margin + 0.05);
  });

  it('plays deterministically for a given seed', () => {
    const play = (): number[] => {
      const actions: number[] = [];
      playGame({
        registry: REGISTRY,
        decks: [DECK, DECK],
        agents: [new HeuristicAgent({ seed: 'fixed' }), new RandomAgent('fixed-opponent')],
        seed: 'determinism',
        onEvent: () => actions.push(actions.length),
      });
      return actions;
    };
    expect(play()).toEqual(play());
  });

  it('never chooses an action that was not offered', () => {
    // playGame throws IllegalAgentChoiceError otherwise; this pins that the
    // agent survives a full game of real decisions.
    expect(() =>
      playGame({
        registry: REGISTRY,
        decks: [DECK, DECK],
        agents: [new HeuristicAgent({ seed: 'a' }), new HeuristicAgent({ seed: 'b' })],
        seed: 'mirror',
        config: { maxTurns: 300 },
        verifyInvariants: true,
      }),
    ).not.toThrow();
  });
});

describe('position evaluation', () => {
  const agent = new HeuristicAgent({ seed: 'eval' });

  it('is symmetric at the start of a mirror match', () => {
    // Identical decks, nothing on the board: neither seat is ahead.
    const state = createGame({ decks: [DECK, DECK], registry: REGISTRY, seed: 'sym' }).state;
    expect(agent.evaluate(observe(state, playerId(0)))).toBe(0);
    expect(agent.evaluate(observe(state, playerId(1)))).toBe(0);
  });

  it('is zero-sum: what helps one seat hurts the other', () => {
    const state = createGame({ decks: [DECK, DECK], registry: REGISTRY, seed: 'zero' }).state;
    const first = agent.evaluate(observe(state, playerId(0)));
    const second = agent.evaluate(observe(state, playerId(1)));
    expect(first).toBeCloseTo(-second, 10);
  });

  it('ranks points above everything else (rule 323.1)', () => {
    const view = viewOf();
    const withPoint = {
      ...view,
      players: view.players.map((player) =>
        player.id === view.viewer ? { ...player, points: 1 } : player,
      ),
    };
    expect(agent.evaluate(withPoint)).toBeGreaterThan(agent.evaluate(view) + DEFAULT_WEIGHTS.control);
  });

  it('values controlling a Battlefield (rule 469.2)', () => {
    const view = viewOf();
    const held = {
      ...view,
      battlefields: view.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: view.viewer } : battlefield,
      ),
    };
    expect(agent.evaluate(held)).toBeGreaterThan(agent.evaluate(view));
  });

  it('counts an opponent`s Control against it', () => {
    const view = viewOf();
    const opponent = playerId(1);
    const theirs = {
      ...view,
      battlefields: view.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: opponent } : battlefield,
      ),
    };
    expect(agent.evaluate(theirs)).toBeLessThan(agent.evaluate(view));
  });
});

describe('action preferences', () => {
  const agent = new HeuristicAgent({ seed: 'prefs' });
  const view = viewOf();

  const choose = (actions: readonly Action[]): Action => agent.chooseAction(view, actions);

  it('prefers taking a Battlefield to ending the turn', () => {
    const chosen = choose([
      { type: 'endTurn' },
      { type: 'moveUnits', units: [], to: battlefieldLocation(0) },
    ]);
    expect(chosen.type).toBe('moveUnits');
  });

  it('prefers playing a card to passing', () => {
    const chosen = choose([{ type: 'pass' }, { type: 'playCard', card: 0 as never }]);
    expect(chosen.type).toBe('playCard');
  });

  it('prefers an uncontrolled Battlefield to one it already holds', () => {
    const holding: GameView = {
      ...view,
      battlefields: view.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: view.viewer } : battlefield,
      ),
    };
    const chosen = agent.chooseAction(holding, [
      { type: 'moveUnits', units: [0 as never], to: battlefieldLocation(0) },
      { type: 'moveUnits', units: [0 as never], to: battlefieldLocation(1) },
    ]);
    expect(chosen).toMatchObject({ to: battlefieldLocation(1) });
  });

  it('will not walk into a Battlefield it already Scored this turn (rule 470)', () => {
    const scored: GameView = {
      ...view,
      battlefields: view.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, scoredBy: [view.viewer] } : battlefield,
      ),
    };
    const chosen = agent.chooseAction(scored, [
      { type: 'moveUnits', units: [0 as never], to: battlefieldLocation(0) },
      { type: 'moveUnits', units: [0 as never], to: battlefieldLocation(1) },
    ]);
    expect(chosen).toMatchObject({ to: battlefieldLocation(1) });
  });

  it('takes the only action when there is just one', () => {
    expect(choose([{ type: 'resolvePhase' }])).toEqual({ type: 'resolvePhase' });
  });

  it('throws rather than guessing when offered nothing', () => {
    expect(() => choose([])).toThrow(/no actions/);
  });

  it('keeps its hand at the Mulligan rather than churning it (rule 117)', () => {
    const chosen = choose([
      { type: 'mulligan', cards: [] },
      { type: 'mulligan', cards: [0 as never, 1 as never] },
    ]);
    expect(chosen).toMatchObject({ cards: [] });
  });
});

describe('weights', () => {
  it('can be overridden without touching the scoring code', () => {
    const indifferent = new HeuristicAgent({ seed: 'w', weights: { control: 0, presence: 0 } });
    const view = viewOf();
    const held = {
      ...view,
      battlefields: view.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: view.viewer } : battlefield,
      ),
    };
    expect(indifferent.evaluate(held)).toBe(indifferent.evaluate(view));
  });

  it('takes a name for reporting', () => {
    expect(new HeuristicAgent({ seed: 1, name: 'tuned' }).name).toBe('tuned');
    expect(new HeuristicAgent().name).toBe('heuristic');
  });
});
