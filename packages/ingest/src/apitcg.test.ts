/**
 * Normalization of the API TCG card export.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { cardId, type LegendCard, type SpellCard, type UnitCard } from '@riftbound/cards';
import { describe, expect, it } from 'vitest';

import {
  APITCG_SOURCE,
  canonicalName,
  championTagFromName,
  parseCardType,
  plainText,
  timingFromText,
} from './apitcg.js';
import { summarizeGaps } from './gaps.js';

/** One raw record in the export's shape. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'origins-001-298',
    name: 'Blazing Scorcher',
    cardType: 'Unit',
    domain: 'Fury',
    energyCost: '5',
    powerCost: '0',
    might: '5',
    description: '',
    ...overrides,
  };
}

const run = (cards: unknown[]) => APITCG_SOURCE.normalize(cards);

describe('card types and supertypes', () => {
  it('reads the plain types', () => {
    for (const [input, type] of [
      ['Unit', 'unit'],
      ['Spell', 'spell'],
      ['Gear', 'gear'],
      ['Rune', 'rune'],
      ['Legend', 'legend'],
      ['Battlefield', 'battlefield'],
    ] as const) {
      expect(parseCardType(input)).toMatchObject({ type, champion: false, signature: false });
    }
  });

  it('reads the Champion supertype, which applies only to Units (133.7.a)', () => {
    expect(parseCardType('Champion Unit')).toEqual({
      type: 'unit',
      champion: true,
      signature: false,
    });
  });

  it('reads the Signature supertype on any card type (133.7.b)', () => {
    expect(parseCardType('Signature Spell')).toMatchObject({ type: 'spell', signature: true });
    expect(parseCardType('Signature Gear')).toMatchObject({ type: 'gear', signature: true });
    expect(parseCardType('Signature Unit')).toMatchObject({ type: 'unit', signature: true });
  });

  it('handles the semicolon-joined forms the export uses', () => {
    expect(parseCardType('Unit;Token')).toMatchObject({ type: 'unit' });
  });

  it('rejects something that is not a card type', () => {
    expect(parseCardType('Booster Pack')).toBeUndefined();
  });

  it('carries the supertypes onto the card', () => {
    const { cards } = run([
      raw({ cardType: 'Champion Unit', name: 'Jinx - Demolitionist' }),
      raw({ id: 'origins-002-298', cardType: 'Signature Spell', name: 'Super Mega Death Rocket!', description: 'ACTION' }),
    ]);
    expect(cards.find((card) => card.name === 'Jinx - Demolitionist')).toMatchObject({
      champion: true,
      signature: false,
    });
    expect(cards.find((card) => card.name === 'Super Mega Death Rocket!')?.signature).toBe(true);
  });
});

describe('Champion Tags', () => {
  it('takes the tag from the name`s leading segment (133.8.b)', () => {
    // The export has no tag field, but names Legends and Champion Units alike
    // as "<Champion> - <Epithet>", and 133.8.b says the tag is what links them.
    expect(championTagFromName("Kai'Sa - Daughter of the Void")).toBe("Kai'Sa");
    expect(championTagFromName("Kai'Sa - Survivor")).toBe("Kai'Sa");
    expect(championTagFromName('Lee Sin - Ascetic')).toBe('Lee Sin');
  });

  it('ignores a printing qualifier when reading the tag', () => {
    expect(championTagFromName('Darius - Trifarian (Alternate Art)')).toBe('Darius');
  });

  it('finds no tag on a card named for its effect', () => {
    expect(championTagFromName('Icathian Rain')).toBeUndefined();
    expect(championTagFromName('Cleave')).toBeUndefined();
  });

  it('lets a Legend and its Champion Unit match (103.2.a.2)', () => {
    const { cards } = run([
      raw({ cardType: 'Legend', name: "Kai'Sa - Daughter of the Void", domain: 'Fury;Mind' }),
      raw({ id: 'origins-002-298', cardType: 'Champion Unit', name: "Kai'Sa - Survivor" }),
    ]);
    const [a, b] = cards;
    expect(a?.championTag).toBe(b?.championTag);
  });

  it('records a gap for a Signature card whose tag is unreadable (103.2.d.2)', () => {
    const { cards, gaps } = run([
      raw({ cardType: 'Signature Spell', name: 'Icathian Rain', description: 'ACTION' }),
    ]);
    expect(cards).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ field: 'championTag', severity: 'degraded' });
  });
});

describe('printings', () => {
  it('strips the qualifiers that mark a printing rather than a card', () => {
    for (const qualifier of ['Alternate Art', 'Overnumbered', 'Signature', 'Starter']) {
      expect(canonicalName(`Vayne - Hunter (${qualifier})`)).toBe('Vayne - Hunter');
    }
  });

  it('keeps one printing per name (103.2.b.2)', () => {
    // The export reuses a collector number across printings, so `id` is not
    // unique — CardRegistry would throw on the collision.
    const { cards } = run([
      raw({ id: 'origins-299-298', name: "Kai'Sa - Daughter of the Void", cardType: 'Legend', domain: 'Fury;Mind' }),
      raw({ id: 'origins-299-298', name: "Kai'Sa - Daughter of the Void (Overnumbered)", cardType: 'Legend', domain: 'Fury;Mind' }),
    ]);
    expect(cards).toHaveLength(1);
  });

  it('never emits two cards with the same id', () => {
    const { cards } = run([
      raw({ id: 'x-1', name: 'Vayne - Hunter (Overnumbered)' }),
      raw({ id: 'x-1', name: 'Vayne - Hunter (Signature)' }),
      raw({ id: 'x-1', name: 'Something Else' }),
    ]);
    expect(new Set(cards.map((card) => card.id)).size).toBe(cards.length);
  });
});

describe('Spell timing (rule 358.4)', () => {
  it('reads the printed marker', () => {
    expect(timingFromText('ACTION (Play on your turn or in showdowns.)')).toBe('action');
    expect(timingFromText('REACTION - ADD rune.')).toBe('reaction');
  });

  it('finds nothing when the text carries neither', () => {
    expect(timingFromText('Deal 3 to a unit.')).toBeUndefined();
  });

  it('drops a Spell rather than defaulting it to Action', () => {
    // A Reaction recorded as an Action is unplayable at the one moment it
    // matters, which is worse than an absent card.
    const { cards, gaps } = run([
      raw({ cardType: 'Spell', name: 'Charm', description: 'Move an enemy unit.' }),
    ]);
    expect(cards).toEqual([]);
    expect(gaps[0]).toMatchObject({ field: 'timing', severity: 'blocking' });
  });

  it('keeps a Spell whose timing is printed', () => {
    const { cards } = run([
      raw({ cardType: 'Spell', name: 'Cleave', description: 'ACTION <em>(Play on your turn.)</em>' }),
    ]);
    expect((cards[0] as SpellCard).timing).toBe('action');
  });
});

describe('costs and Domains', () => {
  it('reads Energy and attributes Power pips to a single Domain', () => {
    const { cards } = run([raw({ energyCost: '3', powerCost: '2', domain: 'Body' })]);
    expect((cards[0] as UnitCard).cost).toEqual({ energy: 3, power: ['body', 'body'] });
  });

  it('drops a multi-Domain card with Power rather than guessing the split', () => {
    const { cards, gaps } = run([raw({ domain: 'Fury;Chaos', energyCost: '8', powerCost: '2' })]);
    expect(cards).toEqual([]);
    expect(gaps[0]).toMatchObject({ field: 'cost.power', severity: 'blocking' });
  });

  it('keeps a multi-Domain card that costs no Power', () => {
    const { cards } = run([raw({ domain: 'Fury;Chaos', energyCost: '4', powerCost: '0' })]);
    expect(cards[0]?.domains).toEqual(['fury', 'chaos']);
  });

  it('treats "None" as the absence of a Domain', () => {
    const { cards, problems } = run([raw({ cardType: 'Battlefield', domain: 'None' })]);
    expect(problems).toEqual([]);
    expect(cards[0]?.domains).toEqual([]);
  });

  it('takes a Legend`s Domain Identity from its Domains (103.1.b.2)', () => {
    const { cards } = run([raw({ cardType: 'Legend', domain: 'Fury;Mind' })]);
    expect((cards[0] as LegendCard).domainIdentity).toEqual(['fury', 'mind']);
  });
});

describe('Might', () => {
  it('is read for Units, which the community export could not supply', () => {
    const { cards } = run([raw({ might: '5' })]);
    expect((cards[0] as UnitCard).might).toBe(5);
  });

  it('drops a Unit that has none (rules 465-466)', () => {
    const { cards, gaps } = run([raw({ might: null })]);
    expect(cards).toEqual([]);
    expect(gaps[0]).toMatchObject({ field: 'might', severity: 'blocking' });
  });
});

describe('non-cards in the export', () => {
  it('drops sealed products silently, since they are not gaps', () => {
    const { cards, gaps, dropped, problems } = run([
      { id: 'origins-pack', name: 'Origins - Booster Pack', cardType: '' },
      { id: 'origins-deck', name: 'Origins - Champion Deck (Jinx)', cardType: '' },
    ]);
    expect(cards).toEqual([]);
    expect(gaps).toEqual([]);
    expect(dropped).toBe(0);
    expect(problems).toEqual([]);
  });

  it('drops a bare Token, which is created rather than deckbuilt', () => {
    const { cards, problems } = run([raw({ id: 'origins-357', cardType: 'Token' })]);
    expect(cards).toEqual([]);
    expect(problems).toEqual([]);
  });
});

describe('rules text', () => {
  it('strips the export`s HTML', () => {
    expect(plainText('ACTION <em>(Play on your turn.)</em><br><br>\r\nDeal 3.')).toBe(
      'ACTION (Play on your turn.)\nDeal 3.',
    );
  });
});

describe('output shape', () => {
  it('sorts by id so an unchanged source regenerates identically', () => {
    const { cards } = run([
      raw({ id: 'origins-050-298', name: 'C' }),
      raw({ id: 'origins-002-298', name: 'A' }),
      raw({ id: 'origins-010-298', name: 'B' }),
    ]);
    expect(cards.map((card) => card.id)).toEqual([
      cardId('origins-002-298'),
      cardId('origins-010-298'),
      cardId('origins-050-298'),
    ]);
  });

  it('rejects input that is not an array', () => {
    expect(APITCG_SOURCE.normalize({ cards: [] }).problems[0]).toMatch(/array of cards/);
  });

  it('summarizes its gaps by field', () => {
    const { gaps } = run([
      raw({ cardType: 'Spell', name: 'A', description: 'no marker' }),
      raw({ id: 'b', cardType: 'Spell', name: 'B', description: 'no marker' }),
      raw({ id: 'c', might: null, name: 'C' }),
    ]);
    expect(summarizeGaps(gaps).byField[0]).toEqual({ field: 'timing', count: 2 });
  });
});
