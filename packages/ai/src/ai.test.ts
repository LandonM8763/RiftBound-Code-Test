import { CardRegistry, cardId, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { parseDeckText, toCardLists, validateDeck, CONSTRUCTED_BO1 } from '@riftbound/deck';
import {
  createGame,
  isOver,
  legalActions,
  observe,
  type Action,
  type DeckList,
  type GameEvent,
  type GameView,
} from '@riftbound/engine';
import { describe, expect, it } from 'vitest';

import { IllegalAgentChoiceError, isOffered, type Agent } from './agent.js';
import { playGame } from './match.js';
import { FirstActionAgent, RandomAgent } from './random.js';

const LEGEND = makeLegend(['fury', 'calm'], { id: cardId('OGN-001'), name: 'Legend' });
const CHAMPION = makeUnit(4, ['fury'], { id: cardId('OGN-002'), name: 'Champion', champion: true });
const UNITS = Array.from({ length: 14 }, (_, i) =>
  makeUnit(2, ['fury'], { id: cardId(`OGN-1${String(i).padStart(2, '0')}`), name: `Unit ${i}` }),
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

/** A legal 40-card list in the plain-text format. */
const DECK_TEXT = [
  '# Legend',
  `1 ${LEGEND.id}`,
  '# Champion',
  `1 ${CHAMPION.id}`,
  '# Main',
  ...UNITS.slice(0, 13).map((unit) => `3 ${unit.id}`),
  `1 ${(UNITS[13] as CardDefinition).id}`,
  '# Runes',
  `6 ${FURY_RUNE.id}`,
  `6 ${CALM_RUNE.id}`,
  '# Battlefields',
  ...BATTLEFIELDS.map((battlefield) => `1 ${battlefield.id}`),
].join('\n');

function engineDeck(): DeckList {
  const parsed = parseDeckText(DECK_TEXT);
  if (!parsed.ok) {
    throw new Error(parsed.errors.map((issue) => issue.message).join('; '));
  }
  return toCardLists(parsed.deck);
}

const DECKS: readonly DeckList[] = [engineDeck(), engineDeck()];

function someView(): GameView {
  const state = createGame({ decks: DECKS, seed: 'view' }).state;
  return observe(state, state.activePlayer);
}

const TWO_ACTIONS: readonly Action[] = [{ type: 'resolvePhase' }, { type: 'endTurn' }];

describe('RandomAgent', () => {
  it('only ever returns an action it was offered', () => {
    const agent = new RandomAgent('pick');
    const view = someView();

    for (let i = 0; i < 200; i += 1) {
      expect(isOffered(agent.chooseAction(view, TWO_ACTIONS), TWO_ACTIONS)).toBe(true);
    }
  });

  it('is reproducible for a given seed', () => {
    const view = someView();
    const run = (): string[] => {
      const agent = new RandomAgent('same');
      return Array.from({ length: 50 }, () => agent.chooseAction(view, TWO_ACTIONS).type);
    };

    expect(run()).toEqual(run());
  });

  it('diverges for different seeds', () => {
    const view = someView();
    const run = (seed: string): string[] => {
      const agent = new RandomAgent(seed);
      return Array.from({ length: 50 }, () => agent.chooseAction(view, TWO_ACTIONS).type);
    };

    expect(run('alpha')).not.toEqual(run('beta'));
  });

  it('reaches both options over many draws', () => {
    const agent = new RandomAgent('spread');
    const view = someView();
    const seen = new Set(
      Array.from({ length: 200 }, () => agent.chooseAction(view, TWO_ACTIONS).type),
    );

    expect(seen.size).toBe(2);
  });

  it('takes a name for telling agents apart in results', () => {
    expect(new RandomAgent(1).name).toBe('random');
    expect(new RandomAgent(1, 'baseline').name).toBe('baseline');
  });
});

describe('FirstActionAgent', () => {
  it('always takes the first offered action', () => {
    const agent = new FirstActionAgent();
    expect(agent.chooseAction(someView(), TWO_ACTIONS)).toEqual({ type: 'resolvePhase' });
  });

  it('throws when offered nothing', () => {
    expect(() => new FirstActionAgent().chooseAction(someView(), [])).toThrow(/no actions/);
  });
});

describe('agent isolation', () => {
  it('hands the agent a view, never the game state', () => {
    let captured: GameView | undefined;
    const spy: Agent = {
      name: 'spy',
      chooseAction: (view, actions) => {
        captured = view;
        return actions[0] as Action;
      },
    };

    playGame({ decks: DECKS, agents: [spy, new FirstActionAgent()], seed: 'spy', config: { maxTurns: 4 } });

    expect(captured).toBeDefined();
    // None of the engine's internal state reaches the agent.
    expect(captured).not.toHaveProperty('entities');
    expect(captured).not.toHaveProperty('rng');
    expect(captured).not.toHaveProperty('config');
    expect(captured?.players[0]).not.toHaveProperty('zones');
  });

  it('hides the opponent\'s cards from the agent', () => {
    const views: GameView[] = [];
    const spy: Agent = {
      name: 'spy',
      chooseAction: (view, actions) => {
        views.push(view);
        return actions[0] as Action;
      },
    };

    playGame({ decks: DECKS, agents: [spy, spy], seed: 'hidden', config: { maxTurns: 4 } });

    const view = views[0] as GameView;
    const opponent = view.players.find((player) => player.id !== view.viewer);
    expect(opponent?.hand.length).toBeGreaterThan(0);
    for (const card of opponent?.hand ?? []) {
      expect(card.card).toBeNull();
    }
  });
});

describe('playGame', () => {
  it('plays a full game to an outcome', () => {
    const result = playGame({
      decks: DECKS,
      agents: [new RandomAgent('a'), new RandomAgent('b')],
      seed: 'match',
      config: { maxTurns: 20 },
    });

    expect(result.outcome).toBeDefined();
    expect(isOver(result.finalState)).toBe(true);
    expect(result.actions).toBeGreaterThan(0);
    expect(result.turns).toBeGreaterThan(1);
  });

  it('is reproducible for the same game and agent seeds', () => {
    const run = () =>
      playGame({
        decks: DECKS,
        agents: [new RandomAgent('a'), new RandomAgent('b')],
        seed: 'repeat',
        config: { maxTurns: 20 },
      });

    const first = run();
    const second = run();

    expect(first.actions).toBe(second.actions);
    expect(first.turns).toBe(second.turns);
    expect(JSON.stringify(first.finalState)).toEqual(JSON.stringify(second.finalState));
  });

  it('reports events in order, starting with the game starting', () => {
    const events: GameEvent[] = [];
    playGame({
      decks: DECKS,
      agents: [new FirstActionAgent(), new FirstActionAgent()],
      seed: 'events',
      config: { maxTurns: 4 },
      onEvent: (event) => events.push(event),
    });

    expect(events[0]?.type).toBe('gameStarted');
    expect(events.at(-1)?.type).toBe('gameEnded');
    expect(events.filter((event) => event.type === 'cardDrawn').length).toBeGreaterThan(0);
  });

  it('verifies engine invariants when asked', () => {
    expect(() =>
      playGame({
        decks: DECKS,
        agents: [new RandomAgent('inv-a'), new RandomAgent('inv-b')],
        seed: 'invariants',
        config: { maxTurns: 15 },
        verifyInvariants: true,
      }),
    ).not.toThrow();
  });

  it('rejects an agent that returns an action it was not offered', () => {
    const cheat: Agent = {
      name: 'cheat',
      // Legal only during the action phase, so this is illegal on the first call.
      chooseAction: () => ({ type: 'endTurn' }),
    };

    expect(() =>
      playGame({ decks: DECKS, agents: [cheat, cheat], seed: 'cheat' }),
    ).toThrow(IllegalAgentChoiceError);
  });

  it('rejects a mismatched number of agents', () => {
    expect(() =>
      playGame({ decks: DECKS, agents: [new FirstActionAgent()], seed: 'mismatch' }),
    ).toThrow(/1 agents for 2 decks/);
  });

  it('stops rather than hanging if the engine stops progressing', () => {
    expect(() =>
      playGame({
        decks: DECKS,
        agents: [new FirstActionAgent(), new FirstActionAgent()],
        seed: 'stuck',
        config: { maxTurns: 1000 },
        maxActions: 10,
      }),
    ).toThrow(/without ending/);
  });

  it('never offers an empty action list while the game is running', () => {
    // The runner throws on an empty list; this asserts the engine's side of it.
    const state = createGame({ decks: DECKS, seed: 'nonempty' }).state;
    expect(legalActions(state, state.activePlayer).length).toBeGreaterThan(0);
  });
});

describe('deck to engine integration', () => {
  it('parses, validates and plays a legal 40-card deck', () => {
    const parsed = parseDeckText(DECK_TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const validation = validateDeck(parsed.deck, REGISTRY, CONSTRUCTED_BO1);
    expect(validation.issues).toEqual([]);
    expect(validation.legal).toBe(true);

    const lists = toCardLists(parsed.deck);
    expect(lists.main).toHaveLength(40);
    expect(lists.runes).toHaveLength(12);
    expect(lists.battlefields).toHaveLength(3);

    const result = playGame({
      decks: [lists, lists],
      agents: [new RandomAgent('deck-a'), new RandomAgent('deck-b')],
      seed: 'integration',
      config: { maxTurns: 12 },
      verifyInvariants: true,
    });

    expect(result.outcome).toBeDefined();
  });

  it('draws the opening hand from the parsed 40-card deck', () => {
    const lists = engineDeck();
    const state = createGame({ decks: [lists, lists], seed: 'opening' }).state;

    for (const player of state.players) {
      expect(player.zones.hand).toHaveLength(state.config.openingHandSize);
      expect(player.zones.mainDeck).toHaveLength(40 - state.config.openingHandSize);
      expect(player.zones.runeDeck).toHaveLength(12);
    }
  });
});
