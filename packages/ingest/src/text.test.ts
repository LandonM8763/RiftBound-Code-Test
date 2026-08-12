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

  it('refuses a keyword granted by an effect for a duration', () => {
    // "Give a unit ASSAULT 3 this turn" is a chosen Unit, for one turn. The
    // static model grants for as long as its source is on the Board and to a
    // scope rather than a choice, so reading it as one would give the wrong
    // Unit the keyword and never take it away.
    expect(parseCardText('Give a unit ASSAULT 3 this turn.').unparsed).toHaveLength(1);
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

  it('gates a passive as readily as a trigger (812.1.b)', () => {
    // The Legion Ability is the whole clause after the keyword, whatever kind
    // of ability that is — a cost modifier counts.
    expect(parseCardText('LEGION - I cost 2 less.').abilities?.costModifiers?.[0]).toEqual({
      applies: { scope: 'self' },
      change: { kind: 'discount', energy: 2 },
      dependsOn: { kind: 'legion' },
    });
  });

  it('refuses a Legion clause with nothing to hang the dependency on', () => {
    // A bare effect is not an ability: there is nowhere to record the gate, so
    // reading it would make the effect unconditional.
    expect(parseCardText('LEGION - Draw 1.').unparsed).toHaveLength(1);
  });

  it('refuses a keyword the engine does not model, with a stated reason', () => {
    for (const keyword of ['HIDDEN', 'DEFLECT', 'EQUIP Calm', 'VISION', 'REPEAT 2']) {
      expect(parseCardText(keyword).unparsed).toHaveLength(1);
    }
    expect(Object.keys(UNMODELLED_KEYWORDS)).toContain('hidden');
  });

  it('805: Accelerate is no longer among them, because it now desugars', () => {
    // It was refused for wanting rule 356.2, which now exists. The keyword is
    // shorthand for an ability the model has, so it becomes that ability.
    expect(Object.keys(UNMODELLED_KEYWORDS)).not.toContain('accelerate');
    expect(parseCardText('ACCELERATE', { domains: ['fury'] }).unparsed).toEqual([]);
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

describe('tokens (rules 179-187)', () => {
  it('reads the plain form and looks the token up in rule 187', () => {
    expect(parseCardText('Play a 1 Might Recruit unit token here.').effect).toEqual({
      target: { kind: 'none' },
      effects: [{ kind: 'createToken', token: 'recruit', count: 1, where: 'here' }],
    });
  });

  it('reads a count, written as a word or a digit', () => {
    const two = parseCardText('Play two 1 Might Recruit unit token here.').effect;
    expect(two?.effects[0]).toMatchObject({ count: 2 });

    const four = parseCardText('Play four 1 Might Recruit unit tokens.').effect;
    expect(four?.effects[0]).toMatchObject({ count: 4 });
  });

  it('184.1: "ready" overrides the default of entering exhausted', () => {
    const parsed = parseCardText('Play a ready 3 Might Sprite unit token with TEMPORARY here.');
    expect(parsed.effect?.effects[0]).toMatchObject({ token: 'sprite', ready: true, where: 'here' });
  });

  it('184.2: reads the location, defaulting to the Base when none is printed', () => {
    const base = parseCardText('Play a 1 Might Recruit unit token in your base.').effect;
    expect(base?.effects[0]).toMatchObject({ where: 'base' });

    const into = parseCardText('Play three 1 might Recruit unit tokens into your base.').effect;
    expect(into?.effects[0]).toMatchObject({ where: 'base', count: 3 });

    const bare = parseCardText('Play a 1 Might Recruit unit token.').effect;
    expect(bare?.effects[0]).toMatchObject({ where: 'base' });
  });

  it('refuses a token rule 187 does not define', () => {
    // Inventing a Dragon token would put a Unit on the Board that no rule
    // describes — the plausible-and-wrong card the gap model exists to stop.
    expect(parseCardText('Play a 5 Might Dragon unit token here.').unparsed).toHaveLength(1);
  });

  it('refuses a Might that disagrees with rule 187', () => {
    // 187.1 fixes the Recruit at 1 Might. A card printing 4 is not describing
    // that token, so believing either number would be a guess.
    expect(parseCardText('Play a 4 Might Recruit unit token here.').unparsed).toHaveLength(1);
  });

  it('refuses a keyword rule 187 does not give that token', () => {
    expect(parseCardText('Play a 1 Might Recruit unit token with TEMPORARY here.').unparsed)
      .toHaveLength(1);
  });

  it('refuses a type that disagrees with rule 187', () => {
    expect(parseCardText('Play a 1 Might Recruit gear token here.').unparsed).toHaveLength(1);
  });

  it('combines with a trigger, which is how the corpus prints it', () => {
    const parsed = parseCardText('When you play me, play a 1 Might Recruit unit token here.');
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toMatchObject({
      condition: { event: 'played', subject: 'self' },
      effect: { effects: [{ kind: 'createToken', token: 'recruit' }] },
    });
  });
});

describe('Accelerate (rule 805)', () => {
  it('805.1.a: desugars to an optional cost plus "if you do, I enter ready"', () => {
    const parsed = parseCardText('ACCELERATE', { domains: ['fury'] });

    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.additionalCosts).toEqual([
      { optional: true, pay: { kind: 'resources', cost: { energy: 1, power: ['fury'] } } },
    ]);
    expect(parsed.abilities?.statics).toEqual([
      {
        affects: { who: 'self' },
        grant: { entersReady: true },
        condition: { kind: 'paidAdditionalCost' },
      },
    ]);
  });

  it('805.1.a.1: takes the Power from the Unit\'s own Domain', () => {
    const parsed = parseCardText('ACCELERATE', { domains: ['order'] });
    expect(parsed.abilities?.additionalCosts?.[0]?.pay).toMatchObject({
      cost: { energy: 1, power: ['order'] },
    });
  });

  it('refuses a multi-Domain Unit, where 805.1.a.1 is a choice', () => {
    // "a Power that matches one of the domains" — picking one would be a guess,
    // and `Cost` has no way to say "either".
    expect(parseCardText('ACCELERATE', { domains: ['fury', 'calm'] }).unparsed).toEqual([
      'ACCELERATE',
    ]);
  });

  it('refuses a domainless Unit, where 805.1.a.2 means any Domain', () => {
    expect(parseCardText('ACCELERATE', { domains: [] }).unparsed).toEqual(['ACCELERATE']);
  });

  it('refuses it when the caller supplies no Domains at all', () => {
    expect(parseCardText('ACCELERATE').unparsed).toEqual(['ACCELERATE']);
  });

  it('820: Repeat is still refused, and the reason is now its measured worth', () => {
    expect(parseCardText('REPEAT 2', { domains: ['fury'] }).unparsed).toHaveLength(1);
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

describe('cost modifiers (rules 356, 363)', () => {
  const modifiersOf = (text: string) => parseCardText(text).abilities?.costModifiers;

  it('reads a flat self-discount', () => {
    expect(modifiersOf('I cost 2 less.')).toEqual([
      { applies: { scope: 'self' }, change: { kind: 'discount', energy: 2 } },
    ]);
  });

  it('reads the "this costs" wording as the same thing', () => {
    expect(modifiersOf('This costs 2 less.')).toEqual(modifiersOf('I cost 2 less.'));
  });

  it('reads a counted discount rather than a flat one', () => {
    expect(modifiersOf('I cost 1 less for each card in your trash.')).toEqual([
      {
        applies: { scope: 'self' },
        change: { kind: 'discount', per: { count: { kind: 'cardsInTrash' }, energy: 1 } },
      },
    ]);
  });

  it('reads a per-discount minimum (356.4.e)', () => {
    expect(
      modifiersOf("I cost 1 less for each card you've played this turn, to a minimum of 1."),
    ).toEqual([
      {
        applies: { scope: 'self' },
        change: {
          kind: 'discount',
          per: { count: { kind: 'cardsPlayedThisTurn' }, energy: 1 },
          minimumEnergy: 1,
        },
      },
    ]);
  });

  it('gates a discount on a state predicate', () => {
    // "If an enemy unit has died this turn, this costs 2 less" — the condition
    // is the same type a static or an effect would carry.
    expect(modifiersOf('If an enemy unit has died this turn, this costs 2 less.')).toEqual([
      {
        applies: { scope: 'self' },
        change: { kind: 'discount', energy: 2 },
        condition: { kind: 'didThisTurn', event: 'dies', who: 'opponent', min: 1 },
      },
    ]);
  });

  it('gates a discount on Legion, which is a passive as much as a trigger', () => {
    expect(modifiersOf('LEGION - I cost 2 less.')).toEqual([
      {
        applies: { scope: 'self' },
        change: { kind: 'discount', energy: 2 },
        dependsOn: { kind: 'legion' },
      },
    ]);
  });

  it('refuses the cost clauses that want a mechanic instead', () => {
    // Every one of these is a real card. Each needs something the model has no
    // representation for — a zone condition, a duration, a count of something
    // invisible, a Battlefield static — so each is refused rather than
    // approximated into a discount that fires at the wrong time.
    const beyond = [
      'I cost 2 less to play from anywhere other than your hand.',
      'When you play me, the next spell you play this turn costs 5 less.',
      'I cost 2 less for each of your MIGHTY units.',
      'While you control this battlefield, friendly gear costs 1 less.',
    ];
    for (const text of beyond) {
      expect(parseCardText(text).unparsed).toHaveLength(1);
    }
  });
});

describe('static abilities (rules 363-365)', () => {
  const staticsOf = (text: string) => parseCardText(text).abilities?.statics;

  it('reads a Might modifier over a scope', () => {
    expect(staticsOf('Other friendly units here have +1 Might.')).toEqual([
      {
        affects: { who: 'friendly', here: true, excludeSelf: true },
        grant: { might: 1 },
      },
    ]);
  });

  it('reads a negative modifier, which 143.2.b floors at the total', () => {
    expect(staticsOf('Enemy units here have -2 Might.')?.[0]?.grant).toEqual({ might: -2 });
  });

  it('separates "other" from the plain scope', () => {
    expect(staticsOf('Friendly units have +1 Might.')?.[0]?.affects).toEqual({ who: 'friendly' });
    expect(staticsOf('Other friendly units have +1 Might.')?.[0]?.affects).toEqual({
      who: 'friendly',
      excludeSelf: true,
    });
  });

  it('reads a granted keyword (801.3.a)', () => {
    expect(staticsOf('Other friendly units here have ASSAULT.')).toEqual([
      {
        affects: { who: 'friendly', here: true, excludeSelf: true },
        grant: { keywords: [{ kind: 'assault', value: 1 }] },
      },
    ]);
  });

  it('reads several granted keywords at once', () => {
    expect(staticsOf('I have ASSAULT and GANKING.')?.[0]?.grant).toEqual({
      keywords: [{ kind: 'assault', value: 1 }, { kind: 'ganking' }],
    });
  });

  it('reads a "while" clause as a condition on the source', () => {
    expect(staticsOf("While I'm buffed, I have GANKING.")).toEqual([
      {
        affects: { who: 'self' },
        grant: { keywords: [{ kind: 'ganking' }] },
        condition: { kind: 'buffed' },
      },
    ]);
  });

  it('treats "an additional +N Might" as the same statement', () => {
    expect(staticsOf("While I'm buffed, I have an additional +1 Might.")?.[0]?.grant).toEqual({
      might: 1,
    });
  });

  it('reads "enters ready", the most repeated static clause in the corpus', () => {
    expect(staticsOf('I enter ready.')).toEqual([
      { affects: { who: 'self' }, grant: { entersReady: true } },
    ]);
    expect(staticsOf('Other friendly units enter ready.')?.[0]?.affects).toEqual({
      who: 'friendly',
      excludeSelf: true,
    });
  });

  it('refuses a keyword it does not model, even in a scope it understands', () => {
    expect(parseCardText('Other friendly units have VISION.').unparsed).toHaveLength(1);
  });

  it('refuses the static clauses that want a mechanic instead', () => {
    // Each is a real card. A dynamic Might, a duration, a scope the model
    // cannot name, or a rule change — none is a scope-plus-grant, so each is
    // refused rather than bent into one.
    const beyond = [
      'My Might is increased by your points.',
      'My Might is increased by the number of cards on your trash.',
      'Units you play this turn enter ready.',
      'I can have any number of buffs.',
      "While I'm at a battlefield, opponents can only play units to their base.",
      'Stunned enemy units here have -8 Might, to a minimum of 1 Might.',
    ];
    for (const text of beyond) {
      expect(parseCardText(text).unparsed).toHaveLength(1);
    }
  });
});

describe('additional costs (rule 356.2)', () => {
  const costsOf = (text: string) => parseCardText(text).abilities?.additionalCosts;

  it('reads the rulebook`s own worked example (356.2.b.1)', () => {
    // "As you play me, you may discard 1 as an additional cost. If you do,
    // reduce my cost by 2." — two sentences on one printed line.
    const parsed = parseCardText(
      'As you play me, you may discard a card as an additional cost. If you do, reduce my cost by 2.',
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.additionalCosts).toEqual([
      { pay: { kind: 'discard', count: 1 }, optional: true },
    ]);
    expect(parsed.abilities?.costModifiers).toEqual([
      {
        applies: { scope: 'self' },
        change: { kind: 'discount', energy: 2 },
        condition: { kind: 'paidAdditionalCost' },
      },
    ]);
  });

  it('reads "may" as the whole difference between mandatory and optional', () => {
    // 356.2.a.1 vs 356.2.b.1: the rulebook's own test.
    expect(costsOf('As an additional cost to play me, kill a friendly unit.')).toEqual([
      { pay: { kind: 'kill', what: 'unit' } },
    ]);
    expect(costsOf('You may kill a friendly gear as an additional cost to play me.')).toEqual([
      { pay: { kind: 'kill', what: 'gear' }, optional: true },
    ]);
  });

  it('covers the wordings the cards use', () => {
    expect(
      costsOf('You may exhaust your legend as an additional cost to play me.')?.[0]?.pay,
    ).toEqual({ kind: 'exhaustLegend' });
    expect(
      costsOf("As you play this, you may spend a buff as an additional cost.")?.[0]?.pay,
    ).toEqual({ kind: 'spendBuff' });
    expect(
      costsOf('As you play me, you may pay 1 Calm as an additional cost.')?.[0]?.pay,
    ).toEqual({ kind: 'resources', cost: { energy: 0, power: ['calm'] } });
  });

  it('gates the payoff on having paid, whatever kind of payoff it is', () => {
    const discount = parseCardText(
      "As you play this, you may spend a buff as an additional cost. If you do, ignore this spell's cost.",
    );
    expect(discount.abilities?.costModifiers?.[0]?.change).toEqual({ kind: 'ignoreAll' });

    const effect = parseCardText(
      'As you play me, you may pay 1 Calm as an additional cost. If you do, draw 1.',
    );
    expect(effect.effect?.condition).toEqual({ kind: 'paidAdditionalCost' });

    const trigger = parseCardText('When you play me, if you paid the additional cost, buff me.');
    expect(trigger.abilities?.triggered?.[0]?.effect.condition).toEqual({
      kind: 'paidAdditionalCost',
    });
  });

  it('refuses a variable count, which cannot be proven payable', () => {
    // "any number of" is a choice as well as a quantity, and a cost that might
    // not be payable in full cannot be checked before the card is played.
    for (const text of [
      'As you play me, you may kill any number of friendly units as an additional cost.',
      'As you play me, you may spend any number of buffs as an additional cost.',
    ]) {
      expect(parseCardText(text).unparsed.length).toBeGreaterThan(0);
    }
  });

  it('never merges two effect lines under different conditions', () => {
    // `CardEffect` carries one condition, so merging would make a conditional
    // effect unconditional — strictly stronger than the printed card.
    const parsed = parseCardText('Draw 1.\nIf you paid the additional cost, draw 1.');
    expect(parsed.unparsed.length).toBeGreaterThan(0);
  });
});
