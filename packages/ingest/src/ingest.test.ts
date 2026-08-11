/**
 * Normalization of the community card export.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { cardId, type CardDefinition, type LegendCard, type RuneCard } from '@riftbound/cards';
import { describe, expect, it } from 'vitest';

import { COMMUNITY_SOURCE, stripHtml } from './community.js';
import { summarizeGaps, type Gap } from './gaps.js';

/** One raw card in the source's shape. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ogn-001-298',
    name: 'Test Card',
    publicCode: 'OGN-001/298',
    set: 'OGN',
    domains: [{ id: 'fury', label: 'Fury' }],
    cardType: [{ id: 'battlefield', label: 'Battlefield' }],
    text: '',
    ...overrides,
  };
}

const run = (cards: unknown[]) => COMMUNITY_SOURCE.normalize(cards);
const fieldsOf = (gaps: readonly Gap[]): string[] => gaps.map((gap) => gap.field);

describe('card ids', () => {
  it('takes the id from the public code, dropping the set size', () => {
    const { cards } = run([raw()]);
    expect(cards[0]?.id).toBe(cardId('OGN-001'));
  });

  it('keeps a variant suffix, which distinguishes two printings', () => {
    // OGN-007 and OGN-007a are both Fury Runes; they must not collide.
    const { cards } = run([
      raw({ publicCode: 'OGN-007/298', cardType: [{ id: 'rune' }], name: 'Fury Rune' }),
      raw({ publicCode: 'OGN-007a/298', cardType: [{ id: 'rune' }], name: 'Fury Rune' }),
    ]);
    expect(cards.map((card) => card.id)).toEqual([cardId('OGN-007'), cardId('OGN-007a')]);
  });

  it('sorts the output so an unchanged source regenerates byte-identically', () => {
    const { cards } = run([
      raw({ publicCode: 'OGN-050/298' }),
      raw({ publicCode: 'OGN-002/298' }),
      raw({ publicCode: 'OGN-010/298' }),
    ]);
    expect(cards.map((card) => card.id)).toEqual(['OGN-002', 'OGN-010', 'OGN-050']);
  });
});

describe('domains', () => {
  it('treats "colorless" as the absence of a Domain, not a seventh one', () => {
    const { cards, problems } = run([raw({ domains: [{ id: 'colorless', label: 'Colorless' }] })]);
    expect(problems).toEqual([]);
    expect(cards[0]?.domains).toEqual([]);
  });

  it('reports a Domain it does not recognise', () => {
    const { cards, problems } = run([raw({ domains: [{ id: 'shadow', label: 'Shadow' }] })]);
    expect(cards).toEqual([]);
    expect(problems[0]).toMatch(/not a Domain/);
  });
});

describe('Legends', () => {
  it('takes the Domain Identity from the printed Domains (rule 103.1.b.2)', () => {
    const { cards } = run([
      raw({
        cardType: [{ id: 'legend' }],
        domains: [{ id: 'fury' }, { id: 'chaos' }],
      }),
    ]);
    const legend = cards[0] as LegendCard;
    expect(legend.type).toBe('legend');
    expect(legend.domainIdentity).toEqual(['fury', 'chaos']);
  });

  it('records the missing Champion Tag as degraded, not blocking', () => {
    const { cards, gaps } = run([raw({ cardType: [{ id: 'legend' }], domains: [{ id: 'fury' }] })]);
    expect(cards).toHaveLength(1);
    expect(gaps[0]?.field).toBe('championTag');
    expect(gaps[0]?.severity).toBe('degraded');
  });
});

describe('Runes', () => {
  it('takes the Rune Domain from its single printed Domain', () => {
    const { cards } = run([raw({ cardType: [{ id: 'rune' }], domains: [{ id: 'calm' }] })]);
    expect((cards[0] as RuneCard).domain).toBe('calm');
  });

  it('drops a Rune that does not have exactly one Domain', () => {
    const { cards, gaps } = run([raw({ cardType: [{ id: 'rune' }], domains: [] })]);
    expect(cards).toEqual([]);
    expect(gaps[0]?.field).toBe('domain');
  });
});

describe('costs', () => {
  it('reads an Energy-only cost', () => {
    const { cards } = run([raw({ cardType: [{ id: 'gear' }], energy: 3 })]);
    expect((cards[0] as CardDefinition & { cost: unknown }).cost).toEqual({ energy: 3, power: [] });
  });

  it('attributes Power pips to the card`s single Domain', () => {
    // The source publishes a pip count, not the Domains it demands. With one
    // Domain the attribution is forced.
    const { cards } = run([
      raw({ cardType: [{ id: 'gear' }], domains: [{ id: 'body' }], energy: 2, power: 2 }),
    ]);
    expect((cards[0] as CardDefinition & { cost: unknown }).cost).toEqual({
      energy: 2,
      power: ['body', 'body'],
    });
  });

  it('drops a multi-Domain card with Power rather than guessing the split', () => {
    const { cards, gaps } = run([
      raw({
        cardType: [{ id: 'gear' }],
        domains: [{ id: 'fury' }, { id: 'chaos' }],
        energy: 8,
        power: 2,
      }),
    ]);
    expect(cards).toEqual([]);
    expect(gaps[0]?.field).toBe('cost.power');
    expect(gaps[0]?.severity).toBe('blocking');
  });

  it('keeps a multi-Domain card that costs no Power', () => {
    const { cards } = run([
      raw({ cardType: [{ id: 'gear' }], domains: [{ id: 'fury' }, { id: 'chaos' }], energy: 4 }),
    ]);
    expect(cards).toHaveLength(1);
  });

  it('drops a card the source gives no Energy cost', () => {
    const { cards, gaps } = run([raw({ cardType: [{ id: 'gear' }] })]);
    expect(cards).toEqual([]);
    expect(gaps[0]?.field).toBe('cost.energy');
  });
});

describe('fields the source does not publish', () => {
  it('drops Units, because Might is what a Unit fights with (rules 465-466)', () => {
    const { cards, gaps, dropped } = run([raw({ cardType: [{ id: 'unit' }], energy: 3 })]);
    expect(cards).toEqual([]);
    expect(dropped).toBe(1);
    expect(gaps[0]?.field).toBe('might');
    expect(gaps[0]?.severity).toBe('blocking');
  });

  it('drops Spells rather than defaulting the timing to Action (rule 358.4)', () => {
    // A Reaction silently recorded as an Action is unplayable exactly when it
    // matters, which is worse than an absent card.
    const { cards, gaps } = run([raw({ cardType: [{ id: 'spell' }], energy: 1 })]);
    expect(cards).toEqual([]);
    expect(gaps[0]?.field).toBe('timing');
  });

  it('never invents a value to fill a gap', () => {
    const { cards } = run([
      raw({ cardType: [{ id: 'unit' }], energy: 3 }),
      raw({ publicCode: 'OGN-002/298', cardType: [{ id: 'spell' }], energy: 1 }),
    ]);
    expect(cards).toEqual([]);
  });
});

describe('rules text', () => {
  it('strips the source`s HTML markup', () => {
    expect(stripHtml('<p>Deal 3 to a unit.</p>')).toBe('Deal 3 to a unit.');
    expect(stripHtml('<p>One.<br />Two.</p>')).toBe('One.\nTwo.');
    expect(stripHtml('<p>A</p><p>B</p>')).toBe('A\nB');
    expect(stripHtml('<p>Bold <em>and italic</em>.</p>')).toBe('Bold and italic.');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('<p>Ready &amp; exhaust &quot;me&quot;.</p>')).toBe('Ready & exhaust "me".');
  });

  it('leaves the symbol tokens alone, since rendering them is presentation', () => {
    expect(stripHtml('<p>Pay :rb_energy_1::rb_rune_fury:.</p>')).toBe(
      'Pay :rb_energy_1::rb_rune_fury:.',
    );
  });
});

describe('malformed source data', () => {
  it('rejects input that is not an array', () => {
    const result = COMMUNITY_SOURCE.normalize({ cards: [] });
    expect(result.problems[0]).toMatch(/array of cards/);
  });

  it('reports a card with no public code', () => {
    const { problems } = run([{ name: 'Nameless' }]);
    expect(problems[0]).toMatch(/publicCode/);
  });

  it('reports an unknown card type', () => {
    const { problems } = run([raw({ cardType: [{ id: 'token' }] })]);
    expect(problems[0]).toMatch(/unknown card type/);
  });

  it('keeps going after a bad card rather than stopping at the first', () => {
    const { cards, problems } = run([raw({ cardType: [{ id: 'token' }] }), raw({ publicCode: 'OGN-002/298' })]);
    expect(problems).toHaveLength(1);
    expect(cards).toHaveLength(1);
  });
});

describe('gap summary', () => {
  it('counts by field, most frequent first', () => {
    const { gaps } = run([
      raw({ cardType: [{ id: 'unit' }], energy: 1 }),
      raw({ publicCode: 'OGN-002/298', cardType: [{ id: 'unit' }], energy: 1 }),
      raw({ publicCode: 'OGN-003/298', cardType: [{ id: 'spell' }], energy: 1 }),
    ]);
    const summary = summarizeGaps(gaps);

    expect(summary.byField).toEqual([
      { field: 'might', count: 2 },
      { field: 'timing', count: 1 },
    ]);
    expect(summary.blocking).toBe(3);
    expect(summary.degraded).toBe(0);
  });

  it('separates blocking gaps from degraded ones', () => {
    const { gaps } = run([
      raw({ cardType: [{ id: 'legend' }], domains: [{ id: 'fury' }] }),
      raw({ publicCode: 'OGN-002/298', cardType: [{ id: 'unit' }], energy: 1 }),
    ]);
    const summary = summarizeGaps(gaps);

    expect(summary.degraded).toBe(1);
    expect(summary.blocking).toBe(1);
  });

  it('names the card each gap belongs to', () => {
    const { gaps } = run([raw({ cardType: [{ id: 'unit' }], name: 'Blazing Scorcher', energy: 5 })]);
    expect(gaps[0]?.card).toBe(cardId('OGN-001'));
    expect(gaps[0]?.name).toBe('Blazing Scorcher');
    expect(fieldsOf(gaps)).toEqual(['might']);
  });
});
