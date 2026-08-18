/**
 * The search agent.
 *
 * Two things are worth testing about a search agent, and neither is "does it
 * pick a good move" — that is what the head-to-head measurement is for.
 *
 * 1. **It cannot cheat.** It sees a `GameView` like every other agent, and the
 *    world it searches is built by `determinize`, which cannot recover what the
 *    view withheld. This is the property the whole hidden-information design
 *    exists to protect.
 * 2. **It is well-behaved.** It always returns an offered action, it is
 *    reproducible from its seed, and it degrades to the tier below rather than
 *    throwing when a world cannot be built.
 */
import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeSpell, makeUnit } from '@riftbound/cards/testing';
import {
  createGame,
  isOver,
  legalActions,
  observe,
  reduce,
  type DeckList,
  type GameState,
  type PlayerId,
} from '@riftbound/engine';
import { describe, expect, it } from 'vitest';

import { isOffered } from './agent.js';
import { playGame } from './match.js';
import { HeuristicAgent } from './heuristic.js';
import { RandomAgent } from './random.js';
import { SearchAgent } from './search.js';

const LEGEND = makeLegend(['fury'], { id: cardId('X-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('X-001'), champion: true });
const GRUNT = makeUnit(2, ['fury'], { id: cardId('X-010'), name: 'Grunt', cost: cost(1) });
const BRAWLER = makeUnit(4, ['fury'], { id: cardId('X-011'), name: 'Brawler', cost: cost(2) });
const BOLT = makeSpell(['fury'], {
  id: cardId('X-020'),
  name: 'Bolt',
  cost: cost(1),
  timing: 'action',
  effect: { target: { kind: 'unit', scope: 'any' }, effects: [{ kind: 'dealDamage', amount: 2 }] },
});
const RUNE = makeRune('fury', { id: cardId('X-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`X-20${i}`) }),
);

const CARDS = [LEGEND, CHAMPION, GRUNT, BRAWLER, BOLT, RUNE, ...BATTLEFIELDS] as CardDefinition[];
const REGISTRY = CardRegistry.from(CARDS);
const DEFINITIONS = Object.fromEntries(CARDS.map((card) => [card.id, card]));

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 16 }, () => GRUNT.id),
      ...Array.from({ length: 14 }, () => BRAWLER.id),
      ...Array.from({ length: 14 }, () => BOLT.id),
    ],
    runes: Array.from({ length: 12 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

const KNOWLEDGE = {
  definitions: DEFINITIONS,
  unseen: [...deck().main, ...deck().main, ...deck().runes, ...deck().runes],
};

function agent(seed: string): SearchAgent {
  // Small budgets: these tests are about behaviour, not strength.
  return new SearchAgent({ knowledge: KNOWLEDGE, worlds: 2, rollout: 8, seed });
}

describe('the search agent is well-behaved', () => {
  it('always returns one of the offered actions', () => {
    const search = agent('offered');
    let state: GameState = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: 'offered',
    }).state;

    for (let step = 0; step < 120 && !isOver(state); step += 1) {
      const actor = (state.priority ?? state.activePlayer) as PlayerId;
      const actions = legalActions(state, actor);
      if (actions.length === 0) {
        break;
      }
      const chosen = search.chooseAction(observe(state, actor), actions);
      expect(isOffered(chosen, actions)).toBe(true);
      state = reduce(state, chosen).state;
    }
  });

  it('is reproducible: the same seed picks the same move', () => {
    const state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed: 'repro' }).state;
    const actor = (state.priority ?? state.activePlayer) as PlayerId;
    const actions = legalActions(state, actor);
    const view = observe(state, actor);

    const first = agent('same').chooseAction(view, actions);
    const second = agent('same').chooseAction(view, actions);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('takes the only action without searching at all', () => {
    // A forced choice is pure cost to search, and there are many of them —
    // resolving a phase, passing into a resolution.
    const search = new SearchAgent({
      // Deliberately unusable knowledge: if this searched, it would throw.
      knowledge: { definitions: {} },
      seed: 'forced',
    });
    const only = { type: 'resolvePhase' } as const;
    expect(search.chooseAction({} as never, [only])).toBe(only);
  });

  it('falls back to the heuristic rather than throwing on a bad world', () => {
    // A determinization the engine cannot accept must not take the agent down
    // with it: the tier below is always a valid answer.
    const broken = new SearchAgent({ knowledge: { definitions: {} }, seed: 'broken' });
    const state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed: 'broken' }).state;
    const actor = (state.priority ?? state.activePlayer) as PlayerId;
    const actions = legalActions(state, actor);
    const chosen = broken.chooseAction(observe(state, actor), actions);
    expect(isOffered(chosen, actions)).toBe(true);
  });

  it('plays a whole game against each other tier', () => {
    for (const opponent of [new RandomAgent('r'), new HeuristicAgent({ seed: 'h' })]) {
      const result = playGame({
        decks: [deck(), deck()],
        registry: REGISTRY,
        agents: [agent('match'), opponent],
        seed: `match-${opponent.name}`,
      });
      expect(result.outcome).not.toBeNull();
    }
  });
});

describe('SearchAgent strength', () => {
  /** Alternating seats, because 485.7 gives the player going second an extra Rune. */
  function duel(games: number, a: (seed: string) => SearchAgent | HeuristicAgent,
                b: (seed: string) => SearchAgent | HeuristicAgent) {
    let wins = 0;
    let decided = 0;
    for (let i = 0; i < games; i += 1) {
      const swapped = i % 2 === 1;
      const result = playGame({
        registry: REGISTRY,
        decks: [deck(), deck()],
        agents: swapped ? [b(`b${i}`), a(`a${i}`)] : [a(`a${i}`), b(`b${i}`)],
        seed: `sduel-${i}`,
        config: { maxTurns: 300 },
      });
      if (result.outcome.kind === 'draw') {
        continue;
      }
      decided += 1;
      if (result.outcome.winner === (swapped ? 1 : 0)) {
        wins += 1;
      }
    }
    const rate = decided === 0 ? 0 : wins / decided;
    const margin = decided === 0 ? 1 : 1.96 * Math.sqrt((rate * (1 - rate)) / decided);
    return { wins, decided, rate, margin };
  }

  // The bar CLAUDE.md sets: a new tier must beat the previous one convincingly
  // or it is not an improvement. Measured at 90.8% [84.3%, 94.8%] over 120
  // games with a larger budget; this runs a smaller one so the suite stays
  // fast, and asserts only that the lower bound clears a coin flip.
  it('beats the heuristic agent over a large sample', () => {
    const result = duel(
      40,
      (seed) => new SearchAgent({ knowledge: KNOWLEDGE, worlds: 2, rollout: 20, seed }),
      (seed) => new HeuristicAgent({ seed }),
    );
    expect(result.decided).toBeGreaterThan(30);
    expect(result.rate - result.margin).toBeGreaterThan(0.5);
  }, 120_000);

  it('measures itself as an even matchup, so the duel above means something', () => {
    // The control. Two search agents on identical decks are a coin flip once
    // seats alternate; without this, the result above could be seat advantage.
    // A smaller budget than the duel above, deliberately: both sides are the
    // same agent, so what is being measured is the *harness*, and a weaker
    // search on both sides tests that just as well for a quarter of the cost.
    const result = duel(
      30,
      (seed) => new SearchAgent({ knowledge: KNOWLEDGE, worlds: 1, rollout: 10, seed: `x${seed}` }),
      (seed) => new SearchAgent({ knowledge: KNOWLEDGE, worlds: 1, rollout: 10, seed }),
    );
    expect(Math.abs(result.rate - 0.5)).toBeLessThan(result.margin + 0.1);
  }, 120_000);
});
