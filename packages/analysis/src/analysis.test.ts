import { CardRegistry, cardId, cost, type CardDefinition } from '@riftbound/cards';
import { makeLegend, makeRune, makeSpell, makeUnit } from '@riftbound/cards/testing';
import type { Deck } from '@riftbound/deck';
import { DEFAULT_CONFIG } from '@riftbound/engine';
import { describe, expect, it } from 'vitest';

import { analyzeDeck, openingHandStats, probabilityOfType } from './analyze.js';
import { castability, domainBalance, powerAvailability } from './consistency.js';
import { costCurve, densify, pipsByDomain } from './curve.js';
import {
  DEFAULT_DRAW_MODEL,
  cardsSeenByTurn,
  drawCurve,
  drawModelFromConfig,
  expectedCopies,
  probabilityOfCard,
  runesChannelledByTurn,
} from './draw.js';
import { binomial } from './hypergeometric.js';

const LEGEND = makeLegend(['fury', 'calm'], { id: cardId('T-000'), name: 'Legend' });
/** 1 Energy, no Power. */
const CHEAP = makeUnit(1, ['fury'], { id: cardId('T-001'), name: 'Cheap', cost: cost(1) });
/** 2 Energy + 1 Fury: three Runes in total. */
const MID = makeUnit(3, ['fury'], { id: cardId('T-002'), name: 'Mid', cost: cost(2, 'fury') });
/** 3 Energy + 1 Fury + 1 Calm: five Runes, and a joint Domain requirement. */
const BIG = makeUnit(5, ['fury', 'calm'], {
  id: cardId('T-003'),
  name: 'Big',
  cost: cost(3, 'fury', 'calm'),
});
const FREE_SPELL = makeSpell(['fury'], { id: cardId('T-004'), name: 'Free Spell', cost: cost(0) });
const FURY_RUNE = makeRune('fury', { id: cardId('T-100'), name: 'Fury Rune' });
const CALM_RUNE = makeRune('calm', { id: cardId('T-101'), name: 'Calm Rune' });

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHEAP,
  MID,
  BIG,
  FREE_SPELL,
  FURY_RUNE,
  CALM_RUNE,
] as CardDefinition[]);

/** Ten main deck cards and twelve Runes split evenly between two Domains. */
const DECK: Deck = {
  legend: LEGEND.id,
  champion: CHEAP.id,
  main: [
    { card: CHEAP.id, count: 3 },
    { card: MID.id, count: 3 },
    { card: BIG.id, count: 3 },
    { card: FREE_SPELL.id, count: 1 },
  ],
  runes: [
    { card: FURY_RUNE.id, count: 6 },
    { card: CALM_RUNE.id, count: 6 },
  ],
  battlefields: [],
  sideboard: [],
};

describe('draw model', () => {
  it('derives from the engine config so the numbers cannot drift apart', () => {
    const model = drawModelFromConfig(DEFAULT_CONFIG);
    expect(model.openingHandSize).toBe(DEFAULT_CONFIG.openingHandSize);
    expect(model.drawPerTurn).toBe(DEFAULT_CONFIG.drawPerTurn);
    expect(model.channelPerTurn).toBe(DEFAULT_CONFIG.channelPerTurn);
  });

  it('counts turn 0 as the opening hand', () => {
    expect(cardsSeenByTurn(0)).toBe(DEFAULT_DRAW_MODEL.openingHandSize);
  });

  it('adds one draw per turn', () => {
    expect(cardsSeenByTurn(1)).toBe(5);
    expect(cardsSeenByTurn(3)).toBe(7);
  });

  it('respects a model that skips the first-turn draw', () => {
    const model = { ...DEFAULT_DRAW_MODEL, drawsOnFirstTurn: false };
    expect(cardsSeenByTurn(1, model)).toBe(4);
    expect(cardsSeenByTurn(2, model)).toBe(5);
  });

  it('Channels twice per turn', () => {
    expect(runesChannelledByTurn(0)).toBe(0);
    expect(runesChannelledByTurn(3)).toBe(6);
  });

  it('rejects a negative turn', () => {
    expect(() => cardsSeenByTurn(-1)).toThrow(RangeError);
  });
});

describe('drawing a specific card', () => {
  it('matches a hand-computed opening-hand figure', () => {
    // Three copies in ten cards, four seen: 1 - C(7,4)/C(10,4) = 1 - 35/210
    expect(probabilityOfCard({ deck: DECK, card: CHEAP.id, turn: 0 })).toBeCloseTo(
      1 - 35 / 210,
      12,
    );
  });

  it('improves with each draw step', () => {
    const turn0 = probabilityOfCard({ deck: DECK, card: CHEAP.id, turn: 0 });
    const turn1 = probabilityOfCard({ deck: DECK, card: CHEAP.id, turn: 1 });
    expect(turn1).toBeCloseTo(1 - 21 / 252, 12);
    expect(turn1).toBeGreaterThan(turn0);
  });

  it('is certain once the whole deck is seen', () => {
    expect(probabilityOfCard({ deck: DECK, card: CHEAP.id, turn: 20 })).toBeCloseTo(1, 12);
  });

  it('is impossible for a card that is not in the deck', () => {
    expect(probabilityOfCard({ deck: DECK, card: cardId('T-999'), turn: 5 })).toBe(0);
  });

  it('handles a requirement of several copies', () => {
    const one = probabilityOfCard({ deck: DECK, card: CHEAP.id, turn: 2, copies: 1 });
    const two = probabilityOfCard({ deck: DECK, card: CHEAP.id, turn: 2, copies: 2 });
    expect(two).toBeLessThan(one);
    expect(two).toBeGreaterThan(0);
  });

  it('reports expected copies', () => {
    // Four of ten cards seen, three copies in the deck.
    expect(expectedCopies({ deck: DECK, card: CHEAP.id, turn: 0 })).toBeCloseTo(1.2, 12);
  });

  it('produces a monotonically rising curve', () => {
    const curve = drawCurve(DECK, MID.id, 5);
    expect(curve).toHaveLength(6);
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i] as number).toBeGreaterThanOrEqual(curve[i - 1] as number);
    }
  });
});

describe('cost curve', () => {
  const curve = costCurve(DECK.main, REGISTRY);

  it('counts every card', () => {
    expect(curve.totalCards).toBe(10);
  });

  it('bins by Energy', () => {
    expect(curve.byEnergy.get(0)).toBe(1);
    expect(curve.byEnergy.get(1)).toBe(3);
    expect(curve.byEnergy.get(2)).toBe(3);
    expect(curve.byEnergy.get(3)).toBe(3);
  });

  it('bins by total Rune cost, which Energy alone hides', () => {
    // Mid reads as 2 Energy but consumes three Runes; Big reads as 3 and eats five.
    expect(curve.byTotalCost.get(1)).toBe(3);
    expect(curve.byTotalCost.get(3)).toBe(3);
    expect(curve.byTotalCost.get(5)).toBe(3);
    expect(curve.maxTotalCost).toBe(5);
  });

  it('counts Power pips per Domain across every copy', () => {
    expect(curve.powerPips.get('fury')).toBe(6);
    expect(curve.powerPips.get('calm')).toBe(3);
    expect(curve.powerPips.get('mind')).toBeUndefined();
  });

  it('averages Energy and total cost separately', () => {
    expect(curve.averageEnergy).toBeCloseTo(1.8, 12);
    expect(curve.averageTotalCost).toBeCloseTo(2.7, 12);
  });

  it('counts card types', () => {
    expect(curve.byType.get('unit')).toBe(9);
    expect(curve.byType.get('spell')).toBe(1);
  });

  it('densifies for charting', () => {
    expect(densify(curve.byEnergy)).toEqual([1, 3, 3, 3]);
    expect(densify(new Map())).toEqual([]);
  });

  it('orders pips by Domain and drops the unused ones', () => {
    expect([...pipsByDomain(curve).keys()]).toEqual(['fury', 'calm']);
  });

  it('throws on a card the registry does not know', () => {
    expect(() => costCurve([{ card: cardId('T-999'), count: 1 }], REGISTRY)).toThrow(
      /Unknown card id/,
    );
  });
});

describe('domain balance', () => {
  const balance = domainBalance(DECK, REGISTRY);

  it('counts Runes by Domain', () => {
    expect(balance.runeCounts.get('fury')).toBe(6);
    expect(balance.runeCounts.get('calm')).toBe(6);
    expect(balance.totalRunes).toBe(12);
  });

  it('counts Power demand by Domain', () => {
    expect(balance.powerDemand.get('fury')).toBe(6);
    expect(balance.powerDemand.get('calm')).toBe(3);
    expect(balance.totalPips).toBe(9);
  });

  it('reports shares that expose a mismatch', () => {
    // Runes are split evenly while demand is two-to-one toward Fury.
    expect(balance.runeShare.get('fury')).toBeCloseTo(0.5, 12);
    expect(balance.demandShare.get('fury')).toBeCloseTo(6 / 9, 12);
  });

  it('handles a deck with no Power costs at all', () => {
    const flat: Deck = { ...DECK, main: [{ card: CHEAP.id, count: 3 }] };
    const result = domainBalance(flat, REGISTRY);
    expect(result.totalPips).toBe(0);
    expect(result.demandShare.size).toBe(0);
  });
});

describe('power availability', () => {
  it('matches a hand-computed single-Domain figure', () => {
    // Two turns Channels four Runes; at least one Fury from six of twelve.
    expect(
      powerAvailability({ deck: DECK, registry: REGISTRY, required: { fury: 1 }, turn: 2 }),
    ).toBeCloseTo(1 - 15 / 495, 12);
  });

  it('solves two Domains jointly', () => {
    // Three turns Channels six Runes; one Fury and one Calm.
    expect(
      powerAvailability({
        deck: DECK,
        registry: REGISTRY,
        required: { fury: 1, calm: 1 },
        turn: 3,
      }),
    ).toBeCloseTo(1 - 2 / binomial(12, 6), 12);
  });

  it('is certain when nothing is required', () => {
    expect(
      powerAvailability({ deck: DECK, registry: REGISTRY, required: {}, turn: 1 }),
    ).toBeCloseTo(1, 12);
  });

  it('is impossible before anything is Channelled', () => {
    expect(
      powerAvailability({ deck: DECK, registry: REGISTRY, required: { fury: 1 }, turn: 0 }),
    ).toBe(0);
  });

  it('is impossible for a Domain the Rune deck does not contain', () => {
    expect(
      powerAvailability({ deck: DECK, registry: REGISTRY, required: { mind: 1 }, turn: 4 }),
    ).toBe(0);
  });

  it('rises with each turn', () => {
    const turns = [1, 2, 3, 4].map((turn) =>
      powerAvailability({ deck: DECK, registry: REGISTRY, required: { fury: 1 }, turn }),
    );
    for (let i = 1; i < turns.length; i += 1) {
      expect(turns[i] as number).toBeGreaterThanOrEqual(turns[i - 1] as number);
    }
  });
});

describe('castability', () => {
  const results = castability(DECK, REGISTRY);
  const find = (id: string) => results.find((entry) => entry.card === id);

  it('covers every playable card in the main deck', () => {
    expect(results).toHaveLength(4);
  });

  it('derives the earliest turn from the total Rune cost, not Energy', () => {
    // Mid is 2 Energy but three Runes, so it needs two Channel steps.
    expect(find(MID.id)?.runeCost).toBe(3);
    expect(find(MID.id)?.earliestTurn).toBe(2);
    expect(find(BIG.id)?.runeCost).toBe(5);
    expect(find(BIG.id)?.earliestTurn).toBe(3);
  });

  it('treats a free card as available immediately', () => {
    expect(find(FREE_SPELL.id)?.earliestTurn).toBe(0);
    expect(find(FREE_SPELL.id)?.powerOnCurve).toBeCloseTo(1, 12);
  });

  it('gives a Domain-free card a certain Power figure', () => {
    expect(find(CHEAP.id)?.powerOnCurve).toBeCloseTo(1, 12);
  });

  it('reports a Power figure below certainty for a two-Domain card', () => {
    const big = find(BIG.id);
    expect(big?.powerOnCurve).toBeGreaterThan(0.9);
    expect(big?.powerOnCurve).toBeLessThan(1);
  });

  it('reports no earliest turn when the Rune deck cannot pay at all', () => {
    const heavy = makeUnit(9, ['fury'], { id: cardId('T-900'), cost: cost(20) });
    const registry = CardRegistry.from([...REGISTRY.all(), heavy] as CardDefinition[]);
    const deck: Deck = { ...DECK, main: [{ card: heavy.id, count: 1 }] };

    const result = castability(deck, registry)[0];
    expect(result?.earliestTurn).toBeNull();
    expect(result?.powerOnCurve).toBe(0);
  });
});

describe('opening hand', () => {
  const stats = openingHandStats(DECK, REGISTRY);

  it('reports the hand size actually drawn', () => {
    expect(stats.handSize).toBe(4);
  });

  it('reports expected counts per card type', () => {
    // Nine of ten cards are Units and four are seen.
    expect(stats.expectedByType.get('unit')).toBeCloseTo(3.6, 12);
    expect(stats.expectedByType.get('spell')).toBeCloseTo(0.4, 12);
  });

  it('reports the chance of seeing each type', () => {
    expect(stats.atLeastOneByType.get('unit')).toBeCloseTo(1, 12);
    // 1 - C(9,4)/C(10,4) = 1 - 126/210
    expect(stats.atLeastOneByType.get('spell')).toBeCloseTo(0.4, 12);
  });

  it('answers a threshold question for a type by turn', () => {
    expect(probabilityOfType(DECK, REGISTRY, 'spell', 1, 0)).toBeCloseTo(0.4, 12);
    expect(probabilityOfType(DECK, REGISTRY, 'spell', 2, 0)).toBe(0);
  });
});

describe('analyzeDeck', () => {
  const analysis = analyzeDeck(DECK, REGISTRY);

  it('reports deck sizes', () => {
    expect(analysis.mainDeckSize).toBe(10);
    expect(analysis.runeDeckSize).toBe(12);
  });

  it('bundles the curve, balance, castability and opening hand', () => {
    expect(analysis.curve.totalCards).toBe(10);
    expect(analysis.domains.totalRunes).toBe(12);
    expect(analysis.castability).toHaveLength(4);
    expect(analysis.openingHand.handSize).toBe(4);
  });

  it('needs no engine, no agent and no randomness', () => {
    // Analytic statistics are exact and repeatable: same deck, same numbers.
    expect(JSON.stringify(analyzeDeck(DECK, REGISTRY).curve.averageEnergy)).toEqual(
      JSON.stringify(analyzeDeck(DECK, REGISTRY).curve.averageEnergy),
    );
  });

  it('throws on an unknown card rather than reporting a wrong number', () => {
    const broken: Deck = { ...DECK, main: [{ card: cardId('T-999'), count: 1 }] };
    expect(() => analyzeDeck(broken, REGISTRY)).toThrow(/Unknown card id/);
  });
});
