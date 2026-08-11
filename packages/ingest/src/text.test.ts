/**
 * Parsing printed card text into the effect model.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 * Every input below is real text from the card export, not invented.
 */
import { describe, expect, it } from 'vitest';

import { parseCardText, parseEffects, stripReminders } from './text.js';

describe('preprocessing', () => {
  it('drops reminder text, which restates a rule rather than adding one', () => {
    expect(stripReminders('ACCELERATE (You may pay 1 Fury to have me enter ready.)').trim()).toBe(
      'ACCELERATE',
    );
  });

  it('reads a keyword whether or not the export bracketed it', () => {
    // The same keyword appears as `[Tank]` on some cards and `Tank` on others.
    for (const text of ['[TANK]', 'TANK']) {
      expect(parseCardText(text).unparsed).toEqual(['TANK']);
    }
  });

  it('ignores a bare timing marker, which became SpellCard.timing at ingest', () => {
    expect(parseCardText('ACTION').unparsed).toEqual([]);
    expect(parseCardText('REACTION').unparsed).toEqual([]);
  });
});

describe('effect clauses', () => {
  it('parses a draw', () => {
    expect(parseEffects('Draw 1')).toEqual({
      target: { kind: 'none' },
      effects: [{ kind: 'draw', count: 1 }],
    });
  });

  it('parses damage with the target it names (355.9.b)', () => {
    expect(parseEffects('Deal 3 to a unit at a battlefield')).toEqual({
      target: { kind: 'unit', scope: 'any', atBattlefield: true },
      effects: [{ kind: 'dealDamage', amount: 3 }],
    });
  });

  it('narrows the target by scope', () => {
    expect(parseEffects('Give a friendly unit +2 Might this turn')?.target).toEqual({
      kind: 'unit',
      scope: 'friendly',
    });
    expect(parseEffects('Deal 2 to an enemy unit')?.target).toEqual({
      kind: 'unit',
      scope: 'enemy',
    });
  });

  it('parses a sequence joined by "then", in order (359.2.b)', () => {
    expect(parseEffects('Deal 4 to a unit at a battlefield, then draw 1')).toEqual({
      target: { kind: 'unit', scope: 'any', atBattlefield: true },
      effects: [{ kind: 'dealDamage', amount: 4 }, { kind: 'draw', count: 1 }],
    });
  });

  it('parses kill, ready, buff, discard and channel', () => {
    expect(parseEffects('Kill a unit at a battlefield')?.effects).toEqual([{ kind: 'kill' }]);
    expect(parseEffects('Ready a unit')?.effects).toEqual([{ kind: 'ready' }]);
    expect(parseEffects('Buff a friendly unit')?.effects).toEqual([{ kind: 'buff' }]);
    expect(parseEffects('Discard 1')?.effects).toEqual([{ kind: 'discard', count: 1 }]);
    expect(parseEffects('Channel 1 rune exhausted')?.effects).toEqual([
      { kind: 'channel', count: 1, exhausted: true },
    ]);
  });

  it('defaults Channel to ready (430.2.a)', () => {
    expect(parseEffects('Channel 2 runes')?.effects).toEqual([
      { kind: 'channel', count: 2, exhausted: false },
    ]);
  });

  it('parses an Add ability`s resources (rule 429)', () => {
    expect(parseEffects('ADD 1')?.effects).toEqual([{ kind: 'addEnergy', count: 1 }]);
    expect(parseEffects('ADD calm')?.effects).toEqual([
      { kind: 'addPower', domain: 'calm', count: 1 },
    ]);
  });

  it('reads number words as well as digits', () => {
    expect(parseEffects('Draw two')?.effects).toEqual([{ kind: 'draw', count: 2 }]);
  });

  it('refuses two clauses that want different targets', () => {
    // CardEffect carries one target for the whole card, so a card that damages
    // one Unit and buffs another cannot be represented — and must not be
    // represented approximately.
    expect(parseEffects('Deal 2 to an enemy unit, then buff a friendly unit')).toBeUndefined();
  });

  it('refuses a clause outside the grammar', () => {
    expect(parseEffects('Stun a unit')).toBeUndefined();
    expect(parseEffects('Counter a spell')).toBeUndefined();
  });
});

describe('triggered abilities (rule 383)', () => {
  it('parses a Play Effect (383.4.a)', () => {
    const parsed = parseCardText('When you play me, draw 1.');
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { kind: 'played' },
      effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
    });
  });

  it('parses the other conditions the grammar covers', () => {
    const conditions = [
      ['When I die, draw 1.', 'dies'],
      ['When you conquer, draw 1.', 'conquer'],
      ['At the end of your turn, draw 1.', 'endOfTurn'],
      ['At the start of your Beginning Phase, draw 1.', 'beginningPhase'],
    ] as const;
    for (const [text, kind] of conditions) {
      expect(parseCardText(text).abilities?.triggered?.[0]?.condition).toEqual({ kind });
    }
  });

  it('marks a leading "you may" as optional (383.3.a)', () => {
    const parsed = parseCardText('When you play me, you may draw 1.');
    expect(parsed.abilities?.triggered?.[0]?.optional).toBe(true);
  });

  it('leaves a mandatory trigger unmarked', () => {
    expect(parseCardText('When you play me, draw 1.').abilities?.triggered?.[0]?.optional).toBeUndefined();
  });

  it('refuses a condition it does not know', () => {
    // "When I hold" is a real condition the engine has no TriggerCondition for.
    expect(parseCardText('When I hold, draw 2.').unparsed).toEqual(['When I hold, draw 2.']);
  });
});

describe('activated abilities (rule 377)', () => {
  it('parses the exhaust symbol as the whole cost (414)', () => {
    const parsed = parseCardText('Exhaust: Draw 1.');
    expect(parsed.abilities?.activated?.[0]).toEqual({
      cost: { energy: 0, power: [] },
      exhaustSelf: true,
      effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
    });
  });

  it('parses an Energy cost alongside the exhaust', () => {
    expect(parseCardText('1, Exhaust: Draw 1.').abilities?.activated?.[0]?.cost).toEqual({
      energy: 1,
      power: [],
    });
  });

  it('parses a cost with no exhaust', () => {
    const ability = parseCardText('2: Draw 1.').abilities?.activated?.[0];
    expect(ability?.cost.energy).toBe(2);
    expect(ability?.exhaustSelf).toBe(false);
  });

  it('strips a timing marker printed inside the ability body', () => {
    // "Exhaust: REACTION - ADD 1" — the marker is timing, not effect.
    const ability = parseCardText('Exhaust: REACTION - ADD 1.').abilities?.activated?.[0];
    expect(ability?.effect.effects).toEqual([{ kind: 'addEnergy', count: 1 }]);
  });

  it('refuses an ability whose restriction it cannot model', () => {
    // "Use only to play spells" is a real restriction; dropping it would make
    // the ability strictly better than the card.
    expect(parseCardText('Exhaust: REACTION - ADD 1. Use only to play spells.').unparsed).not.toEqual(
      [],
    );
  });
});

describe('the all-or-nothing rule', () => {
  it('refuses a card whose clause carries a condition it cannot express', () => {
    // Reducing this to "deal 6" would produce a card that plays, looks right
    // and is wrong — worse than leaving it vanilla.
    const text = 'Choose an enemy unit. Deal 6 to it unless its controller has you draw 2.';
    expect(parseCardText(text).unparsed.length).toBeGreaterThan(0);
  });

  it('refuses a card carrying a keyword the engine does not model', () => {
    // A Tank that forgets it is a Tank is a wrong card, not a simpler one.
    const parsed = parseCardText('TANK\nWhen you play me, draw 1.');
    expect(parsed.unparsed).toContain('TANK');
  });

  it('reports every clause it could not read, not just the first', () => {
    const parsed = parseCardText('Stun a unit.\nCounter a spell.');
    expect(parsed.unparsed).toHaveLength(2);
  });

  it('returns nothing at all for text it fully understands but that has no effect', () => {
    expect(parseCardText('ACTION')).toEqual({ unparsed: [] });
  });
});

describe('real cards from the export', () => {
  it('parses Hextech Ray', () => {
    const parsed = parseCardText(
      'ACTION (Play on your turn or in showdowns.)\nDeal 3 to a unit at a battlefield.',
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect).toEqual({
      target: { kind: 'unit', scope: 'any', atBattlefield: true },
      effects: [{ kind: 'dealDamage', amount: 3 }],
    });
  });

  it('parses Void Seeker, which does two things in order', () => {
    const parsed = parseCardText(
      'ACTION (Play on your turn or in showdowns.)\nDeal 4 to a unit at a battlefield, then draw 1.',
    );
    expect(parsed.effect?.effects).toEqual([
      { kind: 'dealDamage', amount: 4 },
      { kind: 'draw', count: 1 },
    ]);
  });

  it('parses Blast of Power', () => {
    const parsed = parseCardText(
      'ACTION (Play on your turn or in showdowns.)\nKill a unit at a battlefield.',
    );
    expect(parsed.effect?.effects).toEqual([{ kind: 'kill' }]);
  });

  it('leaves Blazing Scorcher vanilla, because Accelerate is not modelled', () => {
    const parsed = parseCardText(
      'ACCELERATE (You may pay 1 Fury as an additional cost to have me enter ready.)',
    );
    expect(parsed.unparsed).toEqual(['ACCELERATE']);
    expect(parsed.effect).toBeUndefined();
  });
});
