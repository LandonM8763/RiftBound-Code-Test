/**
 * Parsing printed card text into the effect model.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 * Every input below is real text from the card export, not invented.
 */
import { UNMODELLED_KEYWORDS } from '@riftbound/cards';
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
      expect(parseCardText(text).keywords).toEqual([{ kind: 'tank' }]);
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

describe('self-targeting', () => {
  it('reads "me" as the card the text is printed on', () => {
    expect(parseEffects('Ready me')).toEqual({
      target: { kind: 'self' },
      effects: [{ kind: 'ready' }],
    });
  });

  it('covers the wordings the cards use', () => {
    const cases = [
      ['Buff me', { kind: 'buff' }],
      ['Heal me', { kind: 'heal' }],
      ['Exhaust me', { kind: 'exhaust' }],
      ['Recall me', { kind: 'recall' }],
    ] as const;
    for (const [text, effect] of cases) {
      expect(parseEffects(text)).toEqual({ target: { kind: 'self' }, effects: [effect] });
    }
    expect(parseEffects('Give me +2 Might this turn')).toEqual({
      target: { kind: 'self' },
      effects: [{ kind: 'giveMight', amount: 2 }],
    });
  });

  it('splits clauses joined by "and" as well as "then"', () => {
    // "Ready me and give me +1 Might this turn" is two effects on one target.
    expect(parseEffects('Ready me and give me +1 Might this turn')).toEqual({
      target: { kind: 'self' },
      effects: [{ kind: 'ready' }, { kind: 'giveMight', amount: 1 }],
    });
  });

  it('refuses to mix "me" with a chosen Unit', () => {
    // One target per card: "me" and "a unit" cannot both be the target.
    expect(parseEffects('Ready me and buff a friendly unit')).toBeUndefined();
  });

  it('parses a self-targeting activated ability end to end', () => {
    const ability = parseCardText('Exhaust: Buff me.').abilities?.activated?.[0];
    expect(ability?.effect).toEqual({ target: { kind: 'self' }, effects: [{ kind: 'buff' }] });
  });
});

describe('triggered abilities (rule 383)', () => {
  it('parses a Play Effect (383.4.a)', () => {
    const parsed = parseCardText('When you play me, draw 1.');
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: 'played', subject: 'self' },
      effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
    });
  });

  it('parses the conditions that are about the source itself', () => {
    const conditions = [
      ['When I die, draw 1.', { event: 'dies', subject: 'self' }],
      ['When I move, draw 1.', { event: 'move', subject: 'self' }],
      ['When I win a combat, draw 1.', { event: 'winCombat', subject: 'self' }],
      ['When you buff me, draw 1.', { event: 'buffed', subject: 'self' }],
    ] as const;
    for (const [text, condition] of conditions) {
      expect(parseCardText(text).abilities?.triggered?.[0]?.condition).toEqual(condition);
    }
  });

  it('parses the conditions that are about the player', () => {
    const conditions = [
      ['At the end of your turn, draw 1.', { event: 'endOfTurn', subject: 'you' }],
      ['At the start of your Beginning Phase, draw 1.', { event: 'beginningPhase', subject: 'you' }],
      ['When you conquer, draw 1.', { event: 'conquer', subject: 'you' }],
      ['When you win a combat, draw 1.', { event: 'winCombat', subject: 'you' }],
      ['When you discard one or more cards, draw 1.', { event: 'discard', subject: 'you' }],
    ] as const;
    for (const [text, condition] of conditions) {
      expect(parseCardText(text).abilities?.triggered?.[0]?.condition).toEqual(condition);
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
    // "When you recycle a rune" is a real condition with no event behind it.
    expect(parseCardText('When you recycle a rune, draw 2.').unparsed).toEqual([
      'When you recycle a rune, draw 2.',
    ]);
  });
});

describe('trigger subjects and filters', () => {
  const conditionOf = (text: string) => parseCardText(text).abilities?.triggered?.[0]?.condition;

  it('separates "I die" from "a friendly unit dies" by subject alone', () => {
    // The same event; only the relationship to the source differs. That is the
    // distinction the old one-variant-per-wording shape could not make.
    expect(conditionOf('When I die, draw 1.')).toEqual({ event: 'dies', subject: 'self' });
    expect(conditionOf('When a friendly unit dies, draw 1.')).toEqual({
      event: 'dies',
      subject: 'friendly',
    });
    expect(conditionOf('When one or more enemy units die, draw 1.')).toEqual({
      event: 'dies',
      subject: 'enemy',
    });
  });

  it('reads a card type filter', () => {
    expect(conditionOf('When you play a spell, draw 1.')).toEqual({
      event: 'played',
      subject: 'you',
      filter: { cardType: 'spell' },
    });
    expect(conditionOf('When you play a gear, draw 1.')).toEqual({
      event: 'played',
      subject: 'you',
      filter: { cardType: 'gear' },
    });
  });

  it('reads "another" as excluding the source', () => {
    expect(conditionOf('When you play another unit, draw 1.')).toEqual({
      event: 'played',
      subject: 'you',
      filter: { cardType: 'unit', excludeSelf: true },
    });
  });

  it('reads a cost threshold against the printed cost (356.1.c)', () => {
    expect(conditionOf('When you play a spell that costs 5 or more, draw 1.')).toEqual({
      event: 'played',
      subject: 'you',
      filter: { cardType: 'spell', minEnergy: 5 },
    });
    expect(conditionOf('When you play a card with power cost 2 runes or more, draw 1.')).toEqual({
      event: 'played',
      subject: 'you',
      filter: { minPower: 2 },
    });
  });

  it('reads an ordinal, which picks the occurrence rather than capping it', () => {
    expect(conditionOf('When you play your second card in a turn, draw 1.')).toEqual({
      event: 'played',
      subject: 'you',
      filter: { ordinal: 2 },
    });
  });

  it('reads "here" as a place filter', () => {
    expect(conditionOf('When you conquer here, draw 1.')).toEqual({
      event: 'conquer',
      subject: 'you',
      filter: { here: true },
    });
    // "I conquer" is the source's own Battlefield being Conquered — a Conquer
    // has no Game Object for a `self` subject to be about.
    expect(conditionOf('When I conquer, draw 1.')).toEqual({
      event: 'conquer',
      subject: 'you',
      filter: { here: true },
    });
  });

  it('turns "the first time ... each turn" into a per-turn limit (383.3.e)', () => {
    const ability = parseCardText('The first time I conquer each turn, draw 1.').abilities
      ?.triggered?.[0];
    expect(ability?.condition).toEqual({ event: 'conquer', subject: 'you', filter: { here: true } });
    expect(ability?.limitPerTurn).toBe(1);
  });

  it('refuses "when I move from a battlefield", which needs an origin', () => {
    // The Move event carries the destination, not where the Unit came from.
    // Reading it as any Move would fire on the wrong Moves.
    expect(parseCardText('When I move from a battlefield, draw 1.').unparsed).toHaveLength(1);
  });
});

describe('keywords (rules 800-828)', () => {
  it('reads the keywords that are rules of the engine', () => {
    for (const [text, keyword] of [
      ['TANK', { kind: 'tank' }],
      ['GANKING', { kind: 'ganking' }],
      ['BACKLINE', { kind: 'backline' }],
    ] as const) {
      expect(parseCardText(text)).toEqual({ keywords: [keyword], unparsed: [] });
    }
  });

  it('defaults an omitted keyword value to 1 (807.1.b.3)', () => {
    expect(parseCardText('ASSAULT').keywords).toEqual([{ kind: 'assault', value: 1 }]);
    expect(parseCardText('SHIELD').keywords).toEqual([{ kind: 'shield', value: 1 }]);
  });

  it('reads a printed keyword value', () => {
    expect(parseCardText('ASSAULT 2').keywords).toEqual([{ kind: 'assault', value: 2 }]);
  });

  it('collects several keywords from several lines', () => {
    const parsed = parseCardText('SHIELD\nTANK');
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.keywords).toEqual([{ kind: 'shield', value: 1 }, { kind: 'tank' }]);
  });

  it('refuses a keyword granted by an effect, which is a static ability', () => {
    // "Give a unit ASSAULT 3 this turn" is not the card having Assault. Reading
    // it as though it were would give the wrong Unit the keyword, permanently.
    expect(parseCardText('Give a unit ASSAULT 3 this turn.').unparsed).toHaveLength(1);
    expect(parseCardText('Other friendly units here have SHIELD.').unparsed).toHaveLength(1);
  });

  it('desugars Deathknell into the "when I die" trigger it is short for (808.1.c)', () => {
    const parsed = parseCardText('DEATHKNELL - Draw 1.');
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: 'dies', subject: 'self' },
      effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
    });
    // Not a Keyword: the glossary defines it *as* the trigger, so a second way
    // to say it would be a second code path.
    expect(parsed.keywords).toBeUndefined();
  });

  it('desugars Temporary into a Beginning Phase self-kill (816.1.b)', () => {
    const parsed = parseCardText('TEMPORARY');
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: 'beginningPhase', subject: 'you' },
      effect: { target: { kind: 'self' }, effects: [{ kind: 'kill' }] },
    });
  });

  it('reads Legion as a dependency on an ordinary ability (812.1.b.1)', () => {
    const parsed = parseCardText('LEGION - When you play me, draw 1.');
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: 'played', subject: 'self' },
      dependsOn: { kind: 'legion' },
      effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
    });
  });

  it('refuses a Legion clause that gates something other than an ability', () => {
    // "LEGION - I cost 2 less" is a passive cost modifier. 812 gates an
    // ability, and there is nothing here to hang the dependency on.
    expect(parseCardText('LEGION - I cost 2 less.').unparsed).toHaveLength(1);
  });

  it('refuses a keyword the engine does not model, with a stated reason', () => {
    for (const keyword of ['ACCELERATE', 'HIDDEN', 'DEFLECT', 'EQUIP Calm', 'VISION', 'REPEAT 2']) {
      expect(parseCardText(keyword).unparsed).toHaveLength(1);
    }
    expect(Object.keys(UNMODELLED_KEYWORDS)).toContain('accelerate');
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
    // An Accelerate that forgets it is one is a wrong card, not a simpler one.
    const parsed = parseCardText('ACCELERATE\nWhen you play me, draw 1.');
    expect(parsed.unparsed).toContain('ACCELERATE');
  });

  it('drops a modelled keyword too when another clause fails', () => {
    // All-or-nothing applies to keywords as well: a card that keeps its Tank
    // but loses the ability printed under it is still the wrong card.
    const parsed = parseCardText('TANK\nStun a unit.');
    expect(parsed.unparsed).toEqual(['Stun a unit.']);
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
