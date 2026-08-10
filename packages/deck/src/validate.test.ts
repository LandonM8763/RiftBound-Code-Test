import { CardRegistry, cardId, type CardDefinition } from '@riftbound/cards';
import {
  makeBattlefield,
  makeGear,
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
} from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import type { Deck } from './deck.js';
import { CONSTRUCTED_BO1, CONSTRUCTED_BO3 } from './format.js';
import { validateDeck } from './validate.js';

const LEGEND = makeLegend(['fury', 'calm'], { id: cardId('OGN-001'), name: 'Test Legend' });
const CHAMPION = makeUnit(4, ['fury'], {
  id: cardId('OGN-002'),
  name: 'Test Champion',
  champion: true,
});

/** 14 distinct Units: 13 at three copies plus one single makes exactly 40. */
const UNITS = Array.from({ length: 14 }, (_, i) =>
  makeUnit(2, ['fury'], { id: cardId(`OGN-1${String(i).padStart(2, '0')}`), name: `Unit ${i}` }),
);

const FURY_RUNE = makeRune('fury', { id: cardId('OGN-200'), name: 'Fury Rune' });
const CALM_RUNE = makeRune('calm', { id: cardId('OGN-201'), name: 'Calm Rune' });
const MIND_RUNE = makeRune('mind', { id: cardId('OGN-202'), name: 'Mind Rune' });

const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`OGN-30${i}`), name: `Battlefield ${i}` }),
);

const OFF_DOMAIN_UNIT = makeUnit(3, ['mind'], { id: cardId('OGN-400'), name: 'Mind Unit' });
const SPELL = makeSpell(['fury'], { id: cardId('OGN-401'), name: 'Fury Spell' });
const GEAR = makeGear(['calm'], { id: cardId('OGN-402'), name: 'Calm Gear' });
const NOT_A_CHAMPION = makeUnit(2, ['fury'], { id: cardId('OGN-403'), name: 'Plain Unit' });

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  ...UNITS,
  FURY_RUNE,
  CALM_RUNE,
  MIND_RUNE,
  ...BATTLEFIELDS,
  OFF_DOMAIN_UNIT,
  SPELL,
  GEAR,
  NOT_A_CHAMPION,
] as CardDefinition[]);

function legalDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...UNITS.slice(0, 13).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[13] as CardDefinition).id, count: 1 },
    ],
    runes: [
      { card: FURY_RUNE.id, count: 6 },
      { card: CALM_RUNE.id, count: 6 },
    ],
    battlefields: BATTLEFIELDS.map((battlefield) => ({ card: battlefield.id, count: 1 })),
    sideboard: [],
    ...overrides,
  };
}

const codes = (deck: Deck, format = CONSTRUCTED_BO1): string[] =>
  validateDeck(deck, REGISTRY, format).issues.map((issue) => issue.code);

describe('validateDeck', () => {
  it('accepts a legal best-of-one deck', () => {
    const result = validateDeck(legalDeck(), REGISTRY, CONSTRUCTED_BO1);
    expect(result.issues).toEqual([]);
    expect(result.legal).toBe(true);
  });

  it('accepts a legal best-of-three deck with an 8-card sideboard', () => {
    // 3 + 3 + 2 = 8, and the two extra copies of the single-copy Unit bring it
    // to exactly three across main deck and sideboard.
    const deck = legalDeck({
      sideboard: [
        { card: SPELL.id, count: 3 },
        { card: GEAR.id, count: 3 },
        { card: (UNITS[13] as CardDefinition).id, count: 2 },
      ],
    });
    const result = validateDeck(deck, REGISTRY, CONSTRUCTED_BO3);
    expect(result.issues).toEqual([]);
    expect(result.legal).toBe(true);
  });
});

describe('deck sizes', () => {
  it('requires exactly 40 main deck cards', () => {
    expect(codes(legalDeck({ main: [{ card: (UNITS[0] as CardDefinition).id, count: 3 }] }))).toContain(
      'main-deck-size',
    );
  });

  it('requires exactly 12 Runes', () => {
    expect(codes(legalDeck({ runes: [{ card: FURY_RUNE.id, count: 11 }] }))).toContain(
      'rune-deck-size',
    );
  });

  it('requires exactly 3 Battlefields', () => {
    expect(codes(legalDeck({ battlefields: [{ card: BATTLEFIELDS[0]!.id, count: 1 }] }))).toContain(
      'battlefield-count',
    );
  });

  it('reports the actual and required counts in the message', () => {
    const result = validateDeck(
      legalDeck({ main: [{ card: (UNITS[0] as CardDefinition).id, count: 3 }] }),
      REGISTRY,
    );
    const issue = result.issues.find((candidate) => candidate.code === 'main-deck-size');
    expect(issue?.message).toContain('3');
    expect(issue?.message).toContain('40');
  });
});

describe('copy limit', () => {
  it('rejects a fourth copy of a card', () => {
    const main = [
      { card: (UNITS[0] as CardDefinition).id, count: 4 },
      ...UNITS.slice(1, 13).map((unit) => ({ card: unit.id, count: 3 })),
    ];
    expect(codes(legalDeck({ main }))).toContain('copy-limit');
  });

  it('counts the Chosen Champion toward its own limit', () => {
    // Champion in the Champion Zone plus two in the main deck is exactly three.
    const withTwoMore = [
      { card: CHAMPION.id, count: 2 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 2 },
    ];
    expect(codes(legalDeck({ main: withTwoMore }))).not.toContain('copy-limit');

    // A third in the main deck makes four in total.
    const withThreeMore = [
      { card: CHAMPION.id, count: 3 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main: withThreeMore }))).toContain('copy-limit');
  });

  it('exempts Runes, which are necessarily played in many copies', () => {
    expect(codes(legalDeck())).not.toContain('copy-limit');
  });

  it('counts the sideboard against the same limit', () => {
    // A legal 8-card sideboard whose only fault is a fourth copy of a card
    // that already appears three times in the main deck.
    const deck = legalDeck({
      sideboard: [
        { card: (UNITS[0] as CardDefinition).id, count: 1 },
        { card: SPELL.id, count: 3 },
        { card: GEAR.id, count: 3 },
        { card: (UNITS[13] as CardDefinition).id, count: 1 },
      ],
    });
    const issues = validateDeck(deck, REGISTRY, CONSTRUCTED_BO3).issues;

    expect(issues.map((issue) => issue.code)).toEqual(['copy-limit']);
    expect(issues[0]?.cards).toEqual([(UNITS[0] as CardDefinition).id]);
  });
});

describe('domain identity', () => {
  it('rejects a card outside the Legend\'s identity', () => {
    const main = [
      { card: OFF_DOMAIN_UNIT.id, count: 3 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main }))).toContain('outside-identity');
  });

  it('rejects a Rune outside the Legend\'s identity', () => {
    const deck = legalDeck({
      runes: [
        { card: FURY_RUNE.id, count: 6 },
        { card: MIND_RUNE.id, count: 6 },
      ],
    });
    expect(codes(deck)).toContain('rune-outside-identity');
  });

  it('names the offending card and the identity in the message', () => {
    const deck = legalDeck({
      runes: [
        { card: FURY_RUNE.id, count: 6 },
        { card: MIND_RUNE.id, count: 6 },
      ],
    });
    const issue = validateDeck(deck, REGISTRY).issues.find(
      (candidate) => candidate.code === 'rune-outside-identity',
    );
    expect(issue?.message).toContain('Mind Rune');
    expect(issue?.cards).toEqual([MIND_RUNE.id]);
  });

  it('accepts both Domains of the identity', () => {
    expect(codes(legalDeck())).not.toContain('outside-identity');
  });
});

describe('card types and piles', () => {
  it('rejects a Legend that is not a Legend', () => {
    expect(codes(legalDeck({ legend: SPELL.id }))).toContain('legend-not-a-legend');
  });

  it('rejects a Champion that is not a Champion Unit', () => {
    expect(codes(legalDeck({ champion: NOT_A_CHAMPION.id }))).toContain('champion-not-a-champion');
  });

  it('rejects a Rune in the main deck', () => {
    const main = [
      { card: FURY_RUNE.id, count: 3 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main }))).toContain('wrong-pile');
  });

  it('rejects a Unit in the Rune deck', () => {
    const deck = legalDeck({ runes: [{ card: (UNITS[0] as CardDefinition).id, count: 12 }] });
    expect(codes(deck)).toContain('wrong-pile');
  });

  it('rejects a Spell among the Battlefields', () => {
    const deck = legalDeck({
      battlefields: [
        { card: SPELL.id, count: 1 },
        { card: BATTLEFIELDS[0]!.id, count: 1 },
        { card: BATTLEFIELDS[1]!.id, count: 1 },
      ],
    });
    expect(codes(deck)).toContain('wrong-pile');
  });

  it('accepts Units, Spells and Gear in the main deck', () => {
    const main = [
      { card: SPELL.id, count: 3 },
      { card: GEAR.id, count: 3 },
      ...UNITS.slice(0, 11).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[11] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main }))).not.toContain('wrong-pile');
  });
});

describe('sideboard', () => {
  it('rejects a sideboard in best-of-one', () => {
    const deck = legalDeck({ sideboard: [{ card: SPELL.id, count: 8 }] });
    expect(codes(deck, CONSTRUCTED_BO1)).toContain('sideboard-not-allowed');
  });

  it('requires exactly 8 cards when one is present in best-of-three', () => {
    const deck = legalDeck({ sideboard: [{ card: SPELL.id, count: 3 }] });
    expect(codes(deck, CONSTRUCTED_BO3)).toContain('sideboard-size');
  });

  it('allows an empty sideboard in best-of-three', () => {
    expect(codes(legalDeck(), CONSTRUCTED_BO3)).toEqual([]);
  });
});

describe('unknown cards', () => {
  it('reports cards missing from the card data', () => {
    const deck = legalDeck({ champion: cardId('OGN-999') });
    const result = validateDeck(deck, REGISTRY);
    const issue = result.issues.find((candidate) => candidate.code === 'unknown-card');

    expect(issue).toBeDefined();
    expect(issue?.cards).toContain(cardId('OGN-999'));
  });

  it('still reports the other problems it can check', () => {
    const deck = legalDeck({ champion: cardId('OGN-999'), runes: [] });
    expect(codes(deck)).toContain('rune-deck-size');
  });
});

describe('issue shape', () => {
  it('reports every problem rather than stopping at the first', () => {
    const deck = legalDeck({ main: [], runes: [], battlefields: [] });
    const found = codes(deck);

    expect(found).toContain('main-deck-size');
    expect(found).toContain('rune-deck-size');
    expect(found).toContain('battlefield-count');
  });

  it('marks blocking problems as errors and reports the deck illegal', () => {
    const result = validateDeck(legalDeck({ runes: [] }), REGISTRY);
    expect(result.legal).toBe(false);
    expect(result.issues.every((issue) => issue.severity === 'error')).toBe(true);
  });
});
