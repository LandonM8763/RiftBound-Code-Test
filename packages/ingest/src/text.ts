/**
 * Turning printed card text into the effect model.
 *
 * A rule-based parser over a known grammar, not a general one. Riftbound's text
 * is a long tail: `Draw 1` appears on many cards, but most clauses are one-offs
 * carrying conditions ("unless its controller…"), quantifiers ("for each…") and
 * choices ("choose one…") that the effect model cannot express at all.
 *
 * **The parse is all-or-nothing per card.** If every clause is understood the
 * card gets its effect; if one clause is not, the card stays vanilla and the
 * clause is recorded. Attaching a partial effect would be worse than attaching
 * none: "Deal 6 to it unless its controller has you draw 2" reduced to "deal 6"
 * is a card that plays, looks right, and is wrong — exactly the failure mode the
 * ingest gap model exists to prevent.
 */
import {
  NO_TARGET,
  UNMODELLED_KEYWORDS,
  tokenByName,
  tokenMight,
  readsMight,
  DOMAINS,
  FREE,
  type AttachedText,
  type CardAbilities,
  type CardType,
  type Cost,
  type Count,
  type Domain,
  type CardEffect,
  type DestinationSpec,
  type AdditionalCost,
  type CostModifier,
  type CostTarget,
  type GuardedEffect,
  type CostPayment,
  type Effect,
  type Keyword,
  type StaticAbility,
  type Condition,
  type StaticScope,
  targetCount,
  type ObjectFilter,
  type TargetCount,
  type TargetSpec,
  type TriggerCondition,
  type TriggeredAbility,
} from '@riftbound/cards';

export interface ParsedText {
  /** Rules text that runs when the card itself resolves (359.2.b, 359.3.d). */
  readonly effect?: CardEffect | undefined;
  readonly abilities?: CardAbilities | undefined;
  /** Keywords the engine models (rules 800-828). */
  readonly keywords?: readonly Keyword[] | undefined;
  /**
   * Rule 136.1's Effect Text: what a Gear lends its Top-Most Card once
   * Attached. Present only on a card that has an Equip ability to Attach it.
   */
  readonly attached?: AttachedText | undefined;
  /** Rule 819.1.b: Quick-Draw gives a Gear Reaction timing. */
  readonly reaction?: boolean | undefined;
  /** Clauses the grammar does not cover. Empty means the card is understood. */
  readonly unparsed: readonly string[];
}

/**
 * What the parser needs to know about the card beyond its text.
 *
 * Deliberately tiny. Almost every clause is readable from the words alone, and
 * the grammar is better for not having the whole card to reach into. The one
 * exception is Accelerate: rule 805.1.a.1 fixes its Power to the Unit's *own*
 * Domain, which is nowhere in the printed line.
 */
export interface CardFacts {
  readonly domains?: readonly Domain[] | undefined;
}

/** Words the text uses for small numbers. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

function count(raw: string): number | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return NUMBER_WORDS[trimmed];
}

/**
 * Reminder text is parenthesised and restates a rule rather than adding one, so
 * it carries no effect and is dropped before parsing.
 */
export function stripReminders(text: string): string {
  return text.replace(/\([^)]*\)/g, ' ');
}

/** The export writes keywords both as `[Tank]` and `Tank`; normalise to bare. */
function unbracket(text: string): string {
  return text.replace(/\[([^\]]+)\]/g, '$1');
}

function normalize(line: string): string {
  return unbracket(stripReminders(line))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.:;])/g, '$1')
    .trim();
}

/**
 * Keywords the engine refuses (rules 800-828), with `UNMODELLED_KEYWORDS`
 * holding the reason for each.
 *
 * A card carrying one is *recognised* as beyond the grammar rather than
 * silently parsed as though the keyword were absent — a Tank that forgets it is
 * a Tank is a wrong card, not a simpler one, and rule 002 makes the card's text
 * supersede the rules.
 *
 * MIGHTY is deliberately *not* here. Rules 706-709 make it a description of a
 * Unit (Might >= 5) rather than a keyword ability, and no card prints it as a
 * bare line — every use is inside a phrase like "for each of your MIGHTY
 * units", which a clause rule has to match in full or fail. Listing it would
 * refuse the phrases the count grammar can now read, and the all-or-nothing
 * rule already refuses the ones it cannot.
 */
const REFUSED_KEYWORDS = new RegExp(
  `\\b(${Object.keys(UNMODELLED_KEYWORDS).join('|')})\\b`,
  'i',
);

/**
 * Keywords that are rules of the engine, matched against a whole line.
 *
 * Anchored deliberately. "Give a unit ASSAULT 3 this turn" *grants* a keyword,
 * which is a static ability the effect model cannot express — so it must fall
 * through and be refused, not be mistaken for the Unit having Assault itself.
 */
const MODELLED_KEYWORDS: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => Keyword;
}[] = [
  // 807.1.b.3 / 814.1.b: an omitted value is 1.
  {
    pattern: /^assault(?:\s+(\d+))?$/i,
    build: (m) => ({ kind: 'assault', value: count(m[1] ?? '1') ?? 1 }),
  },
  {
    pattern: /^shield(?:\s+(\d+))?$/i,
    build: (m) => ({ kind: 'shield', value: count(m[1] ?? '1') ?? 1 }),
  },
  // Some cards print the glossary wording where the keyword would go, because
  // the export flattens a reminder that lost its parentheses. 815.1.b and
  // 826.3 are those exact sentences, so they are the keyword.
  {
    pattern: /^(?:tank|i must be assigned combat damage first\.?)$/i,
    build: () => ({ kind: 'tank' }),
  },
  {
    pattern: /^(?:backline|i must be assigned combat damage last\.?)$/i,
    build: () => ({ kind: 'backline' }),
  },
  { pattern: /^ganking$/i, build: () => ({ kind: 'ganking' }) },
  // 811.4: multiple instances are redundant, so it carries no value.
  { pattern: /^hidden$/i, build: () => ({ kind: 'hidden' }) },
];

/**
 * Lines that restate a rule and grant nothing (002).
 *
 * Reminder text is parenthesised and stripped before parsing, but the export
 * sometimes publishes it without the parentheses — a token reference card whose
 * whole text is rule 702.3, for instance. Such a line carries no ability, so
 * reading it as nothing is what the card says; refusing it would fail a card
 * that has no rules text at all.
 *
 * Deliberately a closed list of exact sentences. Anything that looks like a
 * restatement but is not on it stays unparsed, because a *near* restatement is
 * how a real ability gets silently dropped.
 */
const RULES_RESTATEMENTS: readonly RegExp[] = [
  // 702.3: "Only one buff counter may be on a unit at a time."
  /^a unit may have no more than one buff at a time$/i,
  // 359.2.c: a Unit enters the Board exhausted already. Printed as a reminder
  // on a Unit, it grants nothing — and it is *not* 184.1's token override,
  // which is about a state contrary to the type's default.
  /^(?:this|i) enters? exhausted$/i,
];

/**
 * A count read off the state: "your MIGHTY units", "enemy units here", "other
 * battlefield you or allies control".
 *
 * Only the wordings the corpus actually prints, and only counts the state can
 * answer — one it cannot is refused, exactly as an unreadable predicate is.
 *
 * "you or allies" reads as "you". The engine models no teams and no sanctioned
 * Mode of Play has any (485 is the 1v1 Duel), so a player's allies are nobody
 * and the two readings coincide everywhere this engine can be played.
 */
const COUNTS: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => Count | undefined;
}[] = [
  {
    // 708: Mighty is Might >= 5, a description rather than a keyword.
    pattern: /^(?:your|friendly) mighty units$/i,
    build: () => ({ kind: 'controlled', who: 'you', what: 'unit', mighty: true }),
  },
  {
    pattern: /^(?:each )?buffed friendly units?(?: (?:at|in) my battlefield| here)?$/i,
    build: () => ({ kind: 'controlled', who: 'you', what: 'unit', here: true, buffed: true }),
  },
  {
    // 423.1.a: "stunned enemy units here".
    pattern: /^stunned (friendly|enemy|your) units?(?: (here))?$/i,
    build: (m) => ({
      kind: 'controlled',
      who: (m[1] ?? '').toLowerCase() === 'enemy' ? 'opponent' : 'you',
      what: 'unit',
      stunned: true,
      ...(m[2] === undefined ? {} : { here: true }),
    }),
  },
  { pattern: /^my might$/i, build: () => ({ kind: 'sourceMight' }) },
  {
    pattern: /^my (assault|shield|legion|level)$/i,
    build: (m) => {
      const kind = (m[1] ?? '').toLowerCase();
      return kind === 'assault' || kind === 'shield'
        ? { kind: 'sourceKeyword', keyword: kind }
        : undefined;
    },
  },
  {
    pattern: /^(your|an opponent's|your opponents') points$/i,
    build: (m) => ({
      kind: 'points',
      who: (m[1] ?? '').toLowerCase() === 'your' ? 'you' : 'opponent',
    }),
  },
  {
    pattern: /^(friendly|enemy|your) ([A-Za-z'-]+?)s?(?: (here))?$/i,
    build: (m) => {
      const who = (m[1] ?? '').toLowerCase() === 'enemy' ? 'opponent' : 'you';
      const noun = (m[2] ?? '').toLowerCase();
      const what = CARD_TYPES.find((type) => type === noun);
      return {
        kind: 'controlled',
        who,
        what: what ?? 'unit',
        ...(what === undefined ? { tag: noun } : {}),
        ...(m[3] === undefined ? {} : { here: true }),
      };
    },
  },
  {
    // "each other battlefield you or allies control"
    pattern: /^other battlefields? (?:you|you or allies) controls?$/i,
    build: () => ({
      kind: 'controlled',
      who: 'you',
      what: 'battlefield',
      excludeSelf: true,
    }),
  },
  { pattern: /^cards? in your trash$/i, build: () => ({ kind: 'cardsInTrash' }) },
];

/**
 * A cost written as resources: "Fury", "1, Fury", "1 Body", "2", "Calm Calm".
 *
 * Rule 414 pays Energy by exhausting Runes and 416 pays Power by recycling
 * them, so a cost is a number plus a list of Domains — which is exactly what
 * the printed shorthand says once the separators are ignored. Anything that is
 * not a number or a Domain refuses the whole phrase rather than being skipped:
 * "Order, Kill a friendly unit" is a real Equip cost this model cannot state,
 * and reading it as plain Order would make the card cheaper than printed.
 */
function parseResourceCost(phrase: string): Cost | undefined {
  const parts = phrase
    .trim()
    .replace(/[.]+$/, '')
    .split(/[,\s]+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }

  let energy = 0;
  const power: Domain[] = [];
  for (const part of parts) {
    const number = count(part);
    if (number !== undefined) {
      energy += number;
      continue;
    }
    const domain = DOMAINS.find((candidate) => candidate === part.toLowerCase());
    if (domain === undefined) {
      return undefined;
    }
    power.push(domain);
  }
  return { energy, power };
}

/**
 * Non-resource parts of an Activated Ability's cost (356.7, 377.1).
 *
 * Only payments the engine can both *check* and *perform*, exactly as with an
 * Additional Cost: 416.3 and 422.3 both require such a cost to be completable
 * before it counts as paid, so one the model cannot prove is refused rather
 * than read as free.
 */
const ABILITY_PAYMENTS: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => CostPayment | undefined;
}[] = [
  {
    // 416.6: "Recycle 1 from your trash", "Recycle a unit from your trash".
    pattern: /^recycle (\d+|a|an)(?: ([A-Za-z]+))? (?:cards? )?from (?:your|my) trash$/i,
    build: (m) => {
      const raw = (m[1] ?? '').toLowerCase();
      const n = raw === 'a' || raw === 'an' ? 1 : count(raw);
      if (n === undefined) {
        return undefined;
      }
      const noun = (m[2] ?? '').toLowerCase();
      const cardType = CARD_TYPES.find((type) => type === noun);
      // A noun that is not a card type is a tag or a description the trash
      // sweep cannot check, so it is refused rather than ignored.
      if (noun !== '' && cardType === undefined) {
        return undefined;
      }
      return { kind: 'recycle', count: n, ...(cardType === undefined ? {} : { cardType }) };
    },
  },
  // 428: the source itself, so there is no choice to make.
  { pattern: /^kill this$/i, build: () => ({ kind: 'killSelf' }) },
  {
    pattern: /^discard (\d+|a) cards?$/i,
    build: (m) => {
      const raw = (m[1] ?? '').toLowerCase();
      const n = raw === 'a' ? 1 : count(raw);
      return n === undefined ? undefined : { kind: 'discard', count: n };
    },
  },
  { pattern: /^spend (?:my|a) buff$/i, build: () => ({ kind: 'spendBuff' }) },
];

/** Read one non-resource cost part, or `undefined` if it is not one. */
function parseAbilityPayment(part: string): CostPayment | undefined {
  for (const rule of ABILITY_PAYMENTS) {
    const match = part.match(rule.pattern);
    if (match !== null) {
      return rule.build(match);
    }
  }
  return undefined;
}

/** Read a "for each …" / "the number of …" phrase, or refuse it. */
function parseCount(phrase: string): Count | undefined {
  const text = phrase.trim().replace(/[.]+$/, '').replace(/^the number of\s+/i, '');
  for (const rule of COUNTS) {
    const match = text.match(rule.pattern);
    if (match !== null) {
      return rule.build(match);
    }
  }
  return undefined;
}

/** A clause that consumes the whole line, mapping to zero or more effects. */
interface ClauseRule {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => ClauseResult | undefined;
}

/** What one clause contributes: its effects, its target, and any Destination. */
interface ClauseResult {
  readonly effects: Effect[];
  /**
   * `undefined` means the phrase was refused — `unitTarget` returns it for an
   * adjective it does not know, and `matchClause` turns that into a refusal of
   * the whole clause. Distinct from `NO_TARGET`, which is a clause that
   * legitimately chooses nothing.
   */
  readonly target: TargetSpec | undefined;
  /**
   * "Move a friendly unit **and ready it**" — the clause names no target of
   * its own and inherits the run's.
   *
   * Flagged rather than silently carrying `NO_TARGET`, because a run whose
   * *only* clause is a pronoun has nothing to inherit: "ready it" alone would
   * become an untargeted `ready` that does nothing, which is a card that
   * parses and is wrong. `parseEffects` refuses that.
   */
  readonly pronoun?: boolean | undefined;
  /** 449.1's Destination, for a clause whose verb is a Move. */
  readonly destination?: DestinationSpec | undefined;
}

const SELF: TargetSpec = { kind: 'self' };

/** The "friendly "/"enemy " prefix a target phrase may carry, or "any". */
function unitScope(prefix: string | undefined): 'any' | 'friendly' | 'enemy' {
  const word = (prefix ?? '').trim().toLowerCase();
  return /\bfriendly\b/.test(word) ? 'friendly' : /\benemy\b/.test(word) ? 'enemy' : 'any';
}

/**
 * The adjectives a target phrase may carry alongside its scope — "an
 * **exhausted** friendly unit", "all **damaged** enemy units here".
 *
 * Read out of the same capture as the scope rather than given its own group,
 * so every clause that already names a scope gains the narrowing without a
 * pattern change. A word that is neither a scope nor a known state refuses the
 * phrase: an adjective read as noise would widen the card past what it prints.
 */
function objectFilter(prefix: string | undefined): ObjectFilter | undefined | 'refused' {
  const words = (prefix ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '' && word !== 'friendly' && word !== 'enemy' && word !== 'other');
  if (words.length === 0) {
    return undefined;
  }
  const STATES: Readonly<Record<string, ObjectFilter>> = {
    damaged: { damaged: true },
    exhausted: { exhausted: true },
    ready: { exhausted: false },
    stunned: { stunned: true },
    buffed: { buffed: true },
  };
  let filter: ObjectFilter = {};
  for (const word of words) {
    const state = STATES[word];
    if (state === undefined) {
      return 'refused';
    }
    filter = { ...filter, ...state };
  }
  return filter;
}

/**
 * "+2 Might this turn", "-2 Might this turn, to a minimum of 1 Might".
 *
 * Signed rather than two clause rules, because the two are one effect with
 * opposite amounts — and the floor only means anything on the negative side,
 * which is why it is refused on the positive one rather than ignored.
 */
function signedMight(
  sign: string | undefined,
  digits: string | undefined,
  floor: string | undefined,
): Effect | undefined {
  const n = count(digits ?? '');
  if (n === undefined) {
    return undefined;
  }
  const amount = sign === '-' ? -n : n;
  if (floor === undefined) {
    return { kind: 'giveMight', amount };
  }
  const minimum = count(floor);
  // "+2 Might, to a minimum of 1" is not a wording the corpus prints and not
  // one this model can mean anything by, so it fails rather than dropping the
  // clause — a floor silently ignored is a card stronger than printed.
  if (minimum === undefined || amount >= 0) {
    return undefined;
  }
  return { kind: 'giveMight', amount, minimum };
}

/** The controller scope a bare plural names — "your units", "enemy units". */
function pluralScope(whole: string): 'any' | 'friendly' | 'enemy' {
  if (/\benemy units\b/i.test(whole)) {
    return 'enemy';
  }
  return /\b(?:your|friendly)\b/i.test(whole) ? 'friendly' : 'any';
}

/**
 * One builder for every "a/another [friendly|enemy] unit/gear [where]" phrase.
 *
 * The four parts are orthogonal and each clause that takes a target captures
 * them in the same order, so writing the assembly once is what stops "another"
 * being honoured on `kill` and forgotten on `buff`.
 */
function unitTarget(
  article: string | undefined,
  scope: string | undefined,
  noun: string | undefined,
  where: string | undefined,
  /** "with 3 Might or less" (143), an upper bound on effective Might. */
  maxMight?: number | undefined,
  /** 133.8's tag, when the noun named one rather than a card type. */
  tag?: string | undefined,
): TargetSpec | undefined {
  const cardType = (noun ?? 'unit').trim().toLowerCase();
  const place = (where ?? '').trim().toLowerCase();
  const many = articleCount(article);
  const filter = objectFilter(scope);
  if (filter === 'refused') {
    return undefined;
  }
  return {
    kind: 'unit',
    scope: unitScope(scope),
    ...(filter === undefined ? {} : { filter }),
    ...(cardType === 'gear' ? { cardType: 'gear' as const } : {}),
    ...(place === 'at a battlefield' ? { atBattlefield: true } : {}),
    ...(place === 'here' ? { here: true } : {}),
    // 355.9's "another" — and "two **other** friendly units", which is the
    // same word once a count is in front of it.
    ...(/\b(?:another|other)\b/i.test(article ?? '') ? { excludeSelf: true } : {}),
    ...(maxMight === undefined ? {} : { maxMight }),
    ...(many === undefined ? {} : { count: many }),
    ...(tag === undefined ? {} : { filter: { ...(filter ?? {}), tag } }),
  };
}

/**
 * 133.8's tag, read off a noun that is not a card type.
 *
 * `undefined` for "unit"/"units", which is the ordinary case. Only a
 * capitalised word qualifies, because that is how the corpus prints a tag and
 * a lowercase unknown noun is a shape the grammar has not read rather than a
 * tag it should invent.
 */
function tagNoun(noun: string | undefined): string | undefined {
  const word = (noun ?? '').trim();
  if (word === '' || /^units?$/i.test(word)) {
    return undefined;
  }
  return word.replace(/s$/, '');
}

/**
 * The count an article states: "**two** friendly units", "**up to 2** units".
 *
 * `undefined` for the ordinary singular articles, which is what
 * `targetCount` reads as exactly one. "Up to" is the only wording that makes
 * `min` differ from `max` — a bare number is exact, so a board that cannot
 * supply it makes the card unplayable (355.8) rather than doing less.
 *
 * "Any number of" is deliberately absent: an unbounded count would make
 * `legalActions` enumerate 2^n sets, and the corpus prints it only alongside
 * mechanics that are missing anyway.
 */
function articleCount(article: string | undefined): TargetCount | undefined {
  const word = (article ?? '')
    .replace(/\bother\b/i, '')
    .trim()
    .toLowerCase();
  const upTo = /^up to (\d+|one|two|three|four)$/i.exec(word);
  if (upTo !== null) {
    const max = count(upTo[1] ?? '');
    return max === undefined ? undefined : { min: 0, max };
  }
  const exact = /^(\d+|two|three|four)$/i.exec(word);
  if (exact !== null) {
    const n = count(exact[1] ?? '');
    return n === undefined || n < 2 ? undefined : { min: n, max: n };
  }
  return undefined;
}

/**
 * The `all` counterpart of `unitTarget` (355.5.a).
 *
 * Its own builder for exactly the reason `unitTarget` has one: three clause
 * rules were each assembling this spec inline, and the first widening — an
 * adjective in the scope phrase — was honoured by none of them. "Kill all
 * **damaged** enemy units here" silently became "kill all enemy units here",
 * which is a card that parses and is wrong.
 */
function allTarget(
  scope: string | undefined,
  cardType: string | undefined,
  where: string | undefined,
): TargetSpec | undefined {
  const filter = objectFilter(scope);
  if (filter === 'refused') {
    return undefined;
  }
  const place = (where ?? '').trim().toLowerCase();
  const type = (cardType ?? 'unit').trim().toLowerCase();
  return {
    kind: 'all',
    scope: unitScope(scope),
    ...(filter === undefined ? {} : { filter }),
    ...(type === 'gear' ? { cardType: 'gear' as const } : {}),
    ...(place === 'here' || place === 'at my battlefield' ? { here: true } : {}),
    ...(place === 'at battlefields' ? { atBattlefield: true } : {}),
    ...(place === 'in combat' ? { inCombat: true } : {}),
  };
}

const CLAUSES: readonly ClauseRule[] = [
  {
    // "Draw 1 for each of your MIGHTY units" — the printed number is per-thing.
    pattern: /^draw (\d+|one|two|three|four|five) for each (?:of )?(.+)$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      const per = parseCount(m[2] ?? '');
      return n === undefined || per === undefined
        ? undefined
        : { effects: [{ kind: 'draw', count: n, per }], target: NO_TARGET };
    },
  },
  {
    pattern: /^draw (\d+|one|two|three|four|five)$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined ? undefined : { effects: [{ kind: 'draw', count: n }], target: NO_TARGET };
    },
  },
  {
    pattern: /^discard (\d+|one|two|three)$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined
        ? undefined
        : { effects: [{ kind: 'discard', count: n }], target: NO_TARGET };
    },
  },
  {
    pattern: /^channel (\d+|one|two|three) runes?( exhausted)?$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      if (n === undefined) return undefined;
      // 430.2: an effect may specify that Runes enter exhausted.
      return {
        effects: [{ kind: 'channel', count: n, exhausted: m[2] !== undefined }],
        target: NO_TARGET,
      };
    },
  },
  {
    /**
     * "Deal 2 to all enemy units in combat", "Deal 1 to all units at
     * battlefields", "Deal 3 to all enemy units here".
     *
     * 355.5.a makes this *not* a choice — an effect reaching objects "based on
     * criteria" chooses nothing — so it is one `all` spec resolved at
     * execution rather than an enumerated target.
     *
     * "at **battlefields**" and "at **a** battlefield" are different
     * statements and only the plural is read here: the singular names one
     * Battlefield the player picks, which is a choice `TargetSpec` has no
     * variant for. Reading it as the plural would hit every Battlefield on the
     * board instead of the one chosen.
     */
    pattern:
      /^deal (\d+) (?:damage )?to all ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)units(?: (here|at my battlefield|at battlefields|in combat))?$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      if (n === undefined) return undefined;
      const where = (m[3] ?? '').toLowerCase();
      return { effects: [{ kind: 'dealDamage', amount: n }], target: allTarget(m[2], 'unit', where) };
    },
  },
  {
    /**
     * "Move a unit from a battlefield to its base" (449.1).
     *
     * The origin is what makes this readable: a Unit at a Battlefield is the
     * only one with a Base to be sent to, so "from a battlefield" is the
     * target's location and "to its base" is the Destination.
     */
    pattern:
      /^move (an?|another|up to (?:\d+|one|two|three|four)|two|three|four) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)units?(?: (?:at|from) a battlefield)? (?:to|on) (?:its |your |their )?base$/i,
    build: (m) => ({
      effects: [{ kind: 'move' }],
      target: unitTarget(m[1], m[2], 'unit', 'at a battlefield'),
      destination: { kind: 'base' as const },
    }),
  },
  {
    /** "Kill all gear", "Buff all friendly units" — the same `all` spec. */
    pattern: /^(kill|buff) all ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)(unit|gear)s?(?: (here|at my battlefield|at battlefields))?$/i,
    build: (m) => {
      const where = (m[4] ?? '').toLowerCase();
      const cardType = (m[3] ?? 'unit').toLowerCase() as 'unit' | 'gear';
      // 702: a Buff is a counter on a Unit, so "buff all gear" would be a
      // statement about something that cannot hold one.
      if (m[1]?.toLowerCase() === 'buff' && cardType !== 'unit') {
        return undefined;
      }
      return {
        effects: [{ kind: m[1]?.toLowerCase() === 'kill' ? 'kill' : 'buff' }],
        target: allTarget(m[2], cardType, where),
      };
    },
  },
  {
    // 417 damages a Unit and nothing else, so the noun is fixed here where
    // `kill` and `toHand` take one — a Gear cannot be damaged.
    pattern: /^deal (\d+) to (an?|another) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)unit( at a battlefield| here)?$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined
        ? undefined
        : {
            effects: [{ kind: 'dealDamage', amount: n }],
            target: unitTarget(m[2], m[3], 'unit', m[4]),
          };
    },
  },
  {
    /**
     * "Give friendly units +5 Might this turn" — a bare plural, which 355.5.a
     * makes a criterion rather than a choice. Listed before the singular so
     * "units" is never read as "a unit".
     */
    pattern:
      /^give (?:(?:your|friendly|enemy) )?(?:other )?units ([+-])(\d+) might this turn(?:, to a minimum of (\d+) might)?$/i,
    build: (m) => {
      const grant = signedMight(m[1], m[2], m[3]);
      return grant === undefined
        ? undefined
        : { effects: [grant], target: { kind: 'all', scope: pluralScope(m[0]), ...(/\bother\b/i.test(m[0]) ? { excludeSelf: true } : {}) } };
    },
  },
  {
    pattern:
      /^give (an?|another|up to (?:\d+|one|two|three|four)|two|three|four) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)units?(?: each)?( here| at a battlefield)? ([+-])(\d+) might this turn(?:, to a minimum of (\d+) might)?$/i,
    build: (m) => {
      const grant = signedMight(m[4], m[5], m[6]);
      return grant === undefined
        ? undefined
        : { effects: [grant], target: unitTarget(m[1], m[2], 'unit', m[3]) };
    },
  },
  {
    /**
     * "Play a ready 3 Might Sprite unit token with TEMPORARY here" (180-184).
     *
     * The token's name is looked up in rule 187's table and everything the card
     * prints about it is *checked* against that entry rather than believed. A
     * card asking for a "4 Might Recruit token" does not describe the Recruit
     * the rules define, so it is refused and recorded — inventing one would put
     * a Unit on the Board that no rule describes, which is exactly the
     * plausible-and-wrong card the gap model exists to prevent.
     *
     * The location is rule 184.2's restriction. With none printed the token
     * goes to the controller's Base: "Recruit the Vanguard" reads "(They can be
     * played to your base or a battlefield you control)", so the unrestricted
     * form is a player *choice*, and choosing the Base for them is the same
     * documented simplification as the discard and damage-assignment orders.
     */
    pattern:
      /^play (?:(a|an|one|two|three|four|five|\d+) )?(ready )?(?:(\d+) might )?([a-z' ]+?) (unit|gear) tokens?(?: with ([a-z]+))?(?: (here|(?:in|at|into|to) (?:your |their )?base))?( exhausted)?$/i,
    build: (m) => {
      const n = m[1] === undefined ? 1 : count(m[1] === 'a' || m[1] === 'an' ? '1' : m[1]);
      const found = tokenByName(m[4] ?? '');
      if (n === undefined || found === undefined) {
        return undefined;
      }
      // 185.2.d: a token follows the rules for its type, so the printed type
      // has to be the one rule 187 gives it.
      if (found.spec.type !== (m[5] ?? '').toLowerCase()) {
        return undefined;
      }
      // 185.2.b gives a token *unit* a Might, and every unit token rule 187
      // defines is printed with it — so an absent one on a unit is a wording
      // the table cannot confirm, and a Gear has none to print.
      const might = m[3] === undefined ? undefined : count(m[3]);
      if (found.spec.type === 'unit' && (might === undefined || tokenMight(found.spec) !== might)) {
        return undefined;
      }
      if (found.spec.type === 'gear' && might !== undefined) {
        return undefined;
      }
      // A keyword printed alongside is confirmatory — 187.2 already gives the
      // Sprite Temporary. One the table does not list would be a different
      // token, so it is refused rather than granted.
      const printed = (m[6] ?? '').toLowerCase();
      if (printed !== '' && !(printed === 'temporary' && found.key === 'sprite')) {
        return undefined;
      }
      const where = m[7] !== undefined && /^here$/i.test(m[7]) ? 'here' : 'base';
      // 184.1: the effect may name an entry state "contrary to the default for
      // the token's type", and both directions appear — "a **ready** Sprite"
      // against 359.2.c, "a Gold gear token **exhausted**" against 359.2.d.
      // Naming neither leaves 185.2.d's default alone, so `ready` is omitted.
      const ready = m[2] !== undefined ? true : m[8] !== undefined ? false : undefined;
      // A card cannot ask for both at once; the two matches are separate groups
      // so a wording that did would otherwise silently pick one.
      if (m[2] !== undefined && m[8] !== undefined) {
        return undefined;
      }
      return {
        effects: [
          {
            kind: 'createToken',
            token: found.key,
            count: n,
            where,
            ...(ready === undefined ? {} : { ready }),
          },
        ],
        target: NO_TARGET,
      };
    },
  },
  {
    /**
     * "Give a unit ASSAULT 3 this turn" (801.3.a).
     *
     * The `this turn` is required, not optional. A grant with no stated
     * duration would have to persist past the Ending Phase, which is different
     * storage and a different mechanic — so "Give a unit ASSAULT 2" is refused
     * rather than quietly given an expiry the card never printed.
     *
     * Only one keyword per clause. "Give a unit SHIELD 3 and TANK this turn"
     * is split on "and" before it reaches here and fails, which is the correct
     * outcome: half a grant is the wrong card.
     */
    pattern:
      /^give (?:(an?|another) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)unit( here)?|(me)) ([a-z][a-z\s\d,-]*?) this turn$/i,
    build: (m) => {
      // 801.3.a grants each keyword separately, so "SHIELD 3 and TANK" is two
      // grants on one target rather than an unreadable clause. The whole line
      // is matched before `parseEffects` splits on "and", which is what lets
      // the two arrive together.
      const granted = grantedKeywords(m[5] ?? '');
      return granted === undefined
        ? undefined
        : {
            effects: granted.map((keyword) => ({ kind: 'grantKeyword' as const, keyword })),
            target: m[4] !== undefined ? SELF : unitTarget(m[1], m[2], 'unit', m[3]),
          };
    },
  },
  {
    /**
     * "Return a unit at a battlefield to its owner's hand" — a bounce.
     *
     * Anchored to the whole clause so the qualified printings fall through and
     * are recorded: "another unit at a battlefield" wants an `excludeSelf` that
     * `TargetSpec` has no field for, and "a unit … with 3 might or less" wants
     * a Might filter. Reading either as the unqualified form would let the card
     * hit something the printed text forbids.
     */
    // 355.9.a.1 makes a Unit target a Game Object on the Board, and a Gear is
    // one too — 412's zone move does not care which. Only the sweep narrows.
    pattern:
      /^return (an?|another) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)(unit|gear)( at a battlefield| here)? to (?:its|their) owner'?s? hand$/i,
    build: (m) => ({
      effects: [{ kind: 'toHand' }],
      target: unitTarget(m[1], m[2], m[3], m[4]),
    }),
  },
  {
    /** "Return me to my owner's hand" — the same effect, already-determined target. */
    pattern: /^return me to my owner'?s? hand$/i,
    build: () => ({ effects: [{ kind: 'toHand' }], target: SELF }),
  },
  {
    /**
     * "Play a unit from your trash, ignoring its Energy cost" (354, 355.2).
     *
     * "Ignoring its cost" is required, and not for convenience: a card that
     * plays another and does not say it would have its controller pay at
     * resolution, which needs a payment step during resolution the engine does
     * not have. Reading it as free would make the card stronger than printed.
     */
    pattern:
      /^play an? (unit|gear)(?: costing no more than (\d+)(?: and no more than (\d+|runes?))?)? from your trash,? ignoring (?:its|their) (energy )?cost$/i,
    build: (m) => {
      const maxEnergy = m[2] === undefined ? undefined : count(m[2]);
      if (m[2] !== undefined && maxEnergy === undefined) {
        return undefined;
      }
      // 135.2.e.5: the export renders a Power pip as the word "Rune".
      const power = m[3] === undefined ? undefined : /rune/i.test(m[3]) ? 1 : count(m[3]);
      if (m[3] !== undefined && power === undefined) {
        return undefined;
      }
      const noun = (m[1] ?? 'unit').toLowerCase() as CardType;
      return {
        effects: [{ kind: 'play', ignore: m[4] === undefined ? 'all' : 'energy' }],
        target: {
          kind: 'trashCard',
          cardTypes: [noun],
          ...(maxEnergy === undefined ? {} : { maxEnergy }),
          ...(power === undefined ? {} : { maxPower: power }),
        },
        // 355.2: a Unit needs a Location, chosen alongside the target. 359.2.d
        // puts a Gear at its controller's Base with nothing to decide.
        ...(noun === 'unit' ? { destination: { kind: 'unitEntry' as const } } : {}),
      };
    },
  },
  {
    /**
     * The dispositions a `look`'s Linked Ability takes (390.5).
     *
     * "Put 1 into your hand", "draw one", "you may play one", "recycle the
     * rest". Their target is the looked-at set, which only exists on the Chain
     * item the look created — so these clauses are meaningless outside one, and
     * `parseLook` is the only thing that reaches them.
     */
    pattern:
      /^(?:put|draw|take) (?:(\d+|one|two|a|it) )?(?:of them )?(?:into|in) your hand$/i,
    build: (m) => {
      const n = m[1] === undefined || /^(?:a|it)$/i.test(m[1]) ? 1 : count(m[1]);
      return n === undefined
        ? undefined
        : {
            effects: [{ kind: 'toHand' }],
            target: {
              kind: 'revealed',
              // Exactly one is `targetCount`'s default, so it is left off —
              // otherwise a bare `revealed` elsewhere in the run would not
              // unify with it and the card would be refused.
              ...(n === 1 ? {} : { count: { min: n, max: n } }),
            },
          };
    },
  },
  { pattern: /^draw (?:one|1|it)$/i, build: () => ({ effects: [{ kind: 'toHand' }], target: { kind: 'revealed' } }) },
  {
    // "You may reveal a **gear** from among them and draw it" — the same
    // disposition with the set narrowed by type.
    pattern: /^reveal an? (unit|spell|gear|rune) from among them(?: and draw it)?$/i,
    build: (m) => ({
      effects: [{ kind: 'toHand' }],
      target: { kind: 'revealed', cardTypes: [(m[1] ?? 'unit').toLowerCase() as CardType] },
    }),
  },
  {
    // "Recycle the rest", "recycle the other", "recycle them" — the complement
    // of whatever the Linked Ability chose.
    pattern: /^recycle (?:the (?:rest|others?)|them)$/i,
    build: () => ({ effects: [{ kind: 'recycleRest' }], target: NO_TARGET }),
  },
  { pattern: /^recycle it$/i, build: () => ({ effects: [{ kind: 'recycle' }], target: { kind: 'revealed' } }) },
  {
    // "You may play one", "play it, ignoring its cost".
    pattern: /^play (?:one|it)(?:,? ?ignoring (?:its|their) (energy )?cost)?$/i,
    build: (m) => ({
      effects: [{ kind: 'play', ignore: m[1] === undefined ? 'all' : 'energy' }],
      target: { kind: 'revealed' },
      destination: { kind: 'unitEntry' as const },
    }),
  },
  {
    /**
     * "Return a unit from your trash to your hand" — a retrieval.
     *
     * The same `toHand` effect as the bounce above; only the target differs,
     * which is the whole reason both are one primitive.
     */
    pattern:
      /^return an? (unit|spell|gear|rune)(?: or (unit|spell|gear|rune))? from your trash to your hand$/i,
    build: (m) => ({
      effects: [{ kind: 'toHand' }],
      target: {
        kind: 'trashCard',
        cardTypes: [m[1], m[2]]
          .filter((word): word is string => word !== undefined)
          .map((word) => word.toLowerCase() as CardType),
      },
    }),
  },
  {
    /**
     * "Deal damage equal to my Might to an enemy unit here."
     *
     * The amount is a `Count`, so the arithmetic is the one `draw ... for
     * each` already uses: a printed 1 scaled by what the count reads.
     */
    pattern:
      /^deal damage equal to (.+?) to (an?|another) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)unit( at a battlefield| here)?$/i,
    build: (m) => {
      const per = parseCount(m[1] ?? '');
      return per === undefined
        ? undefined
        : {
            effects: [{ kind: 'dealDamage', amount: 1, per }],
            target: unitTarget(m[2], m[3], 'unit', m[4]),
          };
    },
  },
  {
    // 428 kills any Permanent, so "kill a gear" is the same clause with a
    // different noun — the sweep narrows and the effect does not change.
    pattern:
      /^kill (an?|another) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)(unit|gear)( at a battlefield| here)?(?: with (\d+) might or less)?$/i,
    build: (m) => {
      const bound = m[5] === undefined ? undefined : count(m[5]);
      return m[5] !== undefined && bound === undefined
        ? undefined
        : { effects: [{ kind: 'kill' }], target: unitTarget(m[1], m[2], m[3], m[4], bound) };
    },
  },
  {
    // Rule 423. Same shape as `kill` above, because the wording is the same and
    // only the verb differs.
    pattern: /^stun (an?|another) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)unit( at a battlefield| here)?$/i,
    build: (m) => ({ effects: [{ kind: 'stun' }], target: unitTarget(m[1], m[2], 'unit', m[3]) }),
  },
  {
    /**
     * "Move a friendly unit" with no Destination printed (449.1).
     *
     * Ordered after the destination-bearing Move rules, so "move a unit to
     * base" still reads its printed Destination rather than becoming a free
     * choice — `matchClause` takes the first rule that consumes the line whole.
     */
    pattern: /^move (an?|another) ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)unit$/i,
    build: (m) => ({
      effects: [{ kind: 'move' }],
      target: unitTarget(m[1], m[2], 'unit', undefined),
      destination: { kind: 'any' as const },
    }),
  },
  {
    // "…**give it** +1 Might this turn": the pronoun again, on the one clause
    // that carries an amount as well as a verb.
    pattern: /^give it ([+-])(\d+) might this turn(?:, to a minimum of (\d+) might)?$/i,
    build: (m) => {
      const grant = signedMight(m[1], m[2], m[3]);
      return grant === undefined
        ? undefined
        : { effects: [grant], target: NO_TARGET, pronoun: true };
    },
  },
  {
    // "…**and ready it**": the pronoun is the run's target, named once.
    pattern: /^(ready|buff|heal|exhaust|kill|stun|recall) it$/i,
    build: (m) => ({
      effects: [{ kind: (m[1] ?? '').toLowerCase() } as Effect],
      target: NO_TARGET,
      pronoun: true,
    }),
  },
  {
    // One rule rather than three: the verbs differ and the target phrase does
    // not, which is the whole reason `unitTarget` exists.
    pattern:
      /^(ready|buff|heal|exhaust) (an?|another|(?:up to )?(?:\d+|one|two|three|four))( other)? ((?:damaged |exhausted |ready |stunned |buffed |friendly |enemy )*)(units?|[A-Z][A-Za-z'-]+s?)( at a battlefield| here)?$/i,
    build: (m) => ({
      effects: [{ kind: (m[1] ?? '').toLowerCase() as 'ready' | 'buff' | 'heal' | 'exhaust' }],
      // "buff **two other** friendly units": the count and the "other" are one
      // article phrase, so `unitTarget` reads both from the same string.
      //
      // 133.8: a capitalised noun that is not "unit" is a tag — "ready another
      // friendly **Mech**". A capital is required because a lowercase noun the
      // grammar does not know is a shape it has not read, not a tag.
      target: unitTarget(`${m[2] ?? ''}${m[3] ?? ''}`, m[4], 'unit', m[6], undefined, tagNoun(m[5])),
    }),
  },
  {
    /**
     * "Counter a spell", "Counter a spell that costs no more than 4 and no
     * more than 1 Power" (425.3).
     *
     * The cost filters read the *printed* cost (356.1.c) and are conjuncts, so
     * a wording naming only one leaves the other unbounded.
     */
    pattern:
      /^counter (?:a|an) (spell|ability|card)(?: on the chain)?(?: that costs no more than (\d+)(?: and no more than (\d+) power)?)?$/i,
    build: (m) => {
      const noun = (m[1] ?? '').toLowerCase();
      const maxEnergy = m[2] === undefined ? undefined : count(m[2]);
      const maxPower = m[3] === undefined ? undefined : count(m[3]);
      if ((m[2] !== undefined && maxEnergy === undefined) || (m[3] !== undefined && maxPower === undefined)) {
        return undefined;
      }
      return {
        effects: [{ kind: 'counter' }],
        target: {
          kind: 'chainItem',
          // "a card on the chain" admits an ability too (425.3), so only the
          // narrower nouns filter.
          ...(noun === 'spell' ? { cardType: 'spell' as const } : {}),
          ...(maxEnergy === undefined ? {} : { maxEnergy }),
          ...(maxPower === undefined ? {} : { maxPower }),
        },
      };
    },
  },
  {
    // 467-471: "you score 1 point". 471.1.a.1 keeps it clear of the Final
    // Point restriction, which belongs to Conquer alone.
    pattern: /^(?:you )?scores? (\d+) points?$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined ? undefined : { effects: [{ kind: 'score', amount: n }], target: NO_TARGET };
    },
  },
  {
    // Rule 429: an Add ability puts resources in the Rune Pool. Only the
    // unqualified forms — a restriction like "Use only to play spells" is a
    // separate sentence and fails the parse, which is what should happen.
    pattern: /^add (\d+)$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined
        ? undefined
        : { effects: [{ kind: 'addEnergy', count: n }], target: NO_TARGET };
    },
  },
  {
    /**
     * "ADD Rune" — 135.2.e.5's `[A]`, Power of any Domain.
     *
     * The export renders the rainbow symbol as the word "Rune", which is the
     * same convention Deflect's reminder text uses ("must pay Rune to choose
     * me"). 135.2.e.5.b makes it a wildcard once in the pool rather than Power
     * of a Domain chosen on arrival, which is why it is its own effect.
     */
    pattern: /^add (?:(\d+) )?runes?$/i,
    build: (m) => {
      const n = m[1] === undefined ? 1 : count(m[1]);
      return n === undefined
        ? undefined
        : { effects: [{ kind: 'addAnyPower', count: n }], target: NO_TARGET };
    },
  },
  {
    // "Add [1] [R]" — 429.5's format admits several resources in one Add, and
    // Energy and Power are different actions (414 against 416), so one clause
    // produces both effects rather than one of them.
    pattern: /^add (?:(\d+) )?((?:(?:fury|calm|mind|body|chaos|order)\s*)+)$/i,
    build: (m) => {
      const energy = m[1] === undefined ? 0 : count(m[1]);
      if (energy === undefined) {
        return undefined;
      }
      const domains = (m[2] ?? '')
        .trim()
        .split(/\s+/)
        .map((word) => word.toLowerCase() as Domain);
      const effects: Effect[] = energy > 0 ? [{ kind: 'addEnergy', count: energy }] : [];
      // "Add [R][R]" is two pips of the same Domain, which `addPower` counts.
      for (const domain of new Set(domains)) {
        effects.push({
          kind: 'addPower',
          domain,
          count: domains.filter((entry) => entry === domain).length,
        });
      }
      return { effects, target: NO_TARGET };
    },
  },
  // Self-targeting: "me" is the card the text is printed on, so these need no
  // target choice at all — `TargetSpec` resolves them at execution.
  {
    pattern: /^ready me$/i,
    build: () => ({ effects: [{ kind: 'ready' }], target: SELF }),
  },
  {
    pattern: /^exhaust me$/i,
    build: () => ({ effects: [{ kind: 'exhaust' }], target: SELF }),
  },
  {
    pattern: /^buff me$/i,
    build: () => ({ effects: [{ kind: 'buff' }], target: SELF }),
  },
  {
    pattern: /^heal me$/i,
    build: () => ({ effects: [{ kind: 'heal' }], target: SELF }),
  },
  {
    pattern: /^recall me$/i,
    build: () => ({ effects: [{ kind: 'recall' }], target: SELF }),
  },
  {
    pattern: /^give me ([+-])(\d+) might this turn(?:, to a minimum of (\d+) might)?$/i,
    build: (m) => {
      const grant = signedMight(m[1], m[2], m[3]);
      return grant === undefined ? undefined : { effects: [grant], target: SELF };
    },
  },
  {
    pattern: /^gain (\d+) xp$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined
        ? undefined
        : { effects: [{ kind: 'gainXp', amount: n }], target: NO_TARGET };
    },
  },
  {
    /**
     * 390.4: a Delayed Passive Ability — a Passive with a stated window.
     *
     * "Units you play this turn enter ready", "opponents can't play cards this
     * turn", "the next spell you play this turn costs 5 less". Listed late,
     * because "this turn" also ends an ordinary Might grant and those clauses
     * must keep winning: `matchClause` takes the first rule that consumes the
     * line whole, so every "+N Might this turn" shape is already spoken for.
     */
    pattern: /^(the next )?(.+?) this turn(.*)$/i,
    build: (m) => {
      // "The next spell you play this turn costs 5 less" states the window in
      // the middle; every other wording puts it at the end.
      const body = `${m[2] ?? ''} ${m[3] ?? ''}`.replace(/\s+/g, ' ').trim();
      const delayed = parseDelayedPassive(m[1] === undefined ? body : `the next ${body}`);
      return delayed === undefined ? undefined : { effects: [delayed], target: NO_TARGET };
    },
  },
  {
    /**
     * 390.4 with the rulebook's own Ravenborn Tome example: "**The next** spell
     * you play deals 1 Bonus Damage" is a Delayed Passive whose window is the
     * next spell rather than the turn — "The next spell is a specific time".
     *
     * Listed after the "this turn" rule so a wording carrying both still reads
     * its printed duration.
     */
    pattern: /^the next (.+)$/i,
    build: (m) => {
      const delayed = parseDelayedPassive(`the next ${m[1] ?? ''}`);
      return delayed === undefined ? undefined : { effects: [delayed], target: NO_TARGET };
    },
  },
];

/**
 * Conditions that are about a phase and so do not start with "when".
 */
const PHASE_CONDITIONS: readonly {
  readonly pattern: RegExp;
  readonly condition: TriggerCondition;
}[] = [
  { pattern: /^at the end of your turn$/i, condition: { event: 'endOfTurn', subject: 'you' } },
  {
    pattern: /^at the start of your beginning phase$/i,
    condition: { event: 'beginningPhase', subject: 'you' },
  },
];

/**
 * The trigger grammar, matched against the phrase *after* "when"/"whenever".
 *
 * Written as an event plus a subject plus a filter rather than one variant per
 * wording, because measuring the card corpus showed the wordings are flat — the
 * most common one a narrower grammar missed appeared twice. The win is the
 * category, so these rules are mostly about mapping English onto the three
 * fields rather than enumerating sentences.
 */
const CONDITIONS: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => TriggerCondition | undefined;
}[] = [
  // 383.4.a, a Play Effect.
  { pattern: /^you play (?:me|this)$/i, build: () => ({ event: 'played', subject: 'self' }) },
  { pattern: /^i'?m played$/i, build: () => ({ event: 'played', subject: 'self' }) },

  // "When you play a spell", "when you play another unit", with the optional
  // cost qualifier real cards attach.
  {
    pattern:
      /^you play (a|an|another) (spell|unit|gear)(?: that costs (\d+) or more)?$/i,
    build: (m) => {
      const article = (m[1] ?? '').toLowerCase();
      const minEnergy = m[3] === undefined ? undefined : count(m[3]);
      if (m[3] !== undefined && minEnergy === undefined) {
        return undefined;
      }
      return {
        event: 'played',
        subject: 'you',
        filter: {
          cardType: (m[2] ?? '').toLowerCase() as 'spell' | 'unit' | 'gear',
          ...(article === 'another' ? { excludeSelf: true } : {}),
          ...(minEnergy === undefined ? {} : { minEnergy }),
        },
      };
    },
  },
  {
    pattern: /^you play a card with power cost (\d+) runes? or more$/i,
    build: (m) => {
      const minPower = count(m[1] ?? '');
      return minPower === undefined
        ? undefined
        : { event: 'played', subject: 'you', filter: { minPower } };
    },
  },
  {
    // 706-709: "when you play a **MIGHTY** unit". A description rather than a
    // keyword, true exactly while Might is 5 or greater — safe to read here
    // because a trigger sweep is not something `mightOf` consults back.
    pattern: /^you play a mighty unit$/i,
    build: () => ({ event: 'played', subject: 'you', filter: { mighty: true } }),
  },
  {
    // 811: "when you play a card **from HIDDEN**" — out of the Facedown Zone.
    // "from face down" is the same wording with the keyword spelled out.
    pattern: /^you play a card from (?:hidden|face ?down)$/i,
    build: () => ({ event: 'played', subject: 'you', filter: { fromFacedown: true } }),
  },
  {
    // 314: "when you play a card **on an opponent's turn**".
    pattern: /^you play a card on an opponent'?s turn$/i,
    build: () => ({ event: 'played', subject: 'you', filter: { onOpponentTurn: true } }),
  },
  {
    // "your second card in a turn" picks out *which* occurrence fires, which is
    // `ordinal` rather than a per-turn limit.
    pattern: /^you play your (second|third|fourth) card in a turn$/i,
    build: (m) => {
      const ordinal = { second: 2, third: 3, fourth: 4 }[(m[1] ?? '').toLowerCase()];
      return ordinal === undefined
        ? undefined
        : { event: 'played', subject: 'you', filter: { ordinal } };
    },
  },

  // Deaths (428). The subject is what separates these; the event is one.
  { pattern: /^i die$/i, build: () => ({ event: 'dies', subject: 'self' }) },
  { pattern: /^i'?m killed$/i, build: () => ({ event: 'dies', subject: 'self' }) },
  {
    /**
     * "a **buffed** friendly unit dies", "**another non-Recruit** unit you
     * control dies" — one rule, because the noun phrase is the same and only
     * the adjectives differ.
     *
     * At least one narrowing word is required. Without that this would also
     * match the bare "a unit dies" and read it as friendly-only, which is a
     * card narrower than printed — and being first-match-wins, it would win.
     */
    pattern:
      /^(?:a|an|another|one or more) (?=\S*(?:buffed|non-)|.*(?:friendly|you control))(buffed |non-[A-Za-z'-]+ )*(?:friendly )?units? (?:you control )?dies?$/i,
    build: (m) => {
      const words = (m[0] ?? '').toLowerCase();
      const negated = /non-([a-z'-]+)/i.exec(m[0] ?? '');
      const filter = {
        ...(/\bbuffed\b/.test(words) ? { buffed: true } : {}),
        ...(/^another\b/.test(words) ? { excludeSelf: true } : {}),
        ...(negated === null
          ? {}
          : { excludeTag: (negated[1] ?? '').replace(/^./, (c) => c.toUpperCase()) }),
      };
      return {
        event: 'dies',
        subject: 'friendly',
        ...(Object.keys(filter).length === 0 ? {} : { filter }),
      };
    },
  },
  {
    pattern: /^(?:a|one or more) friendly units? dies?$/i,
    build: () => ({ event: 'dies', subject: 'friendly' }),
  },
  {
    pattern: /^(?:an|one or more) enemy units? dies?$/i,
    build: () => ({ event: 'dies', subject: 'enemy' }),
  },
  { pattern: /^(?:a|one or more) units? dies?$/i, build: () => ({ event: 'dies', subject: 'any' }) },

  // Scoring (469). "I conquer" is the Unit's own Battlefield being Conquered,
  // which is `here` — a Conquer has no Game Object to be the subject of.
  {
    pattern: /^you conquer( here)?$/i,
    build: (m) => ({
      event: 'conquer',
      subject: 'you',
      ...(m[1] === undefined ? {} : { filter: { here: true } }),
    }),
  },
  {
    pattern: /^i conquer$/i,
    build: () => ({ event: 'conquer', subject: 'you', filter: { here: true } }),
  },
  {
    pattern: /^you hold( here)?$/i,
    build: (m) => ({
      event: 'hold',
      subject: 'you',
      ...(m[1] === undefined ? {} : { filter: { here: true } }),
    }),
  },
  { pattern: /^i hold$/i, build: () => ({ event: 'hold', subject: 'you', filter: { here: true } }) },

  // Movement (446). "from a battlefield" is deliberately absent: the Move event
  // carries the destination, not the origin, so that wording is refused rather
  // than treated as any Move.
  { pattern: /^i move$/i, build: () => ({ event: 'move', subject: 'self' }) },
  { pattern: /^i move to a battlefield$/i, build: () => ({ event: 'move', subject: 'self' }) },
  {
    // "When I move **from** a battlefield" — the other end of the Move (446).
    pattern: /^i move from a battlefield$/i,
    build: () => ({ event: 'move', subject: 'self', filter: { direction: 'from' } }),
  },
  {
    // "When a unit moves **from here**" — both ends at once: 355.9's here on
    // the Move's origin rather than its Destination.
    pattern: /^an? ((?:friendly|enemy) )?unit moves from (?:here|my location)$/i,
    build: (m) => {
      const who = (m[1] ?? '').trim().toLowerCase();
      return {
        event: 'move',
        subject: who === 'friendly' ? 'friendly' : who === 'enemy' ? 'enemy' : 'any',
        filter: { direction: 'from', here: true },
      };
    },
  },
  {
    // "to a battlefield **other than mine**" — the mirror of `here`, which is
    // why it is its own field rather than `here: false`.
    pattern: /^an opponent moves to a battlefield other than mine$/i,
    build: () => ({ event: 'move', subject: 'enemy', filter: { notHere: true } }),
  },

  // Combat (466.3).
  { pattern: /^i win (?:a )?combat$/i, build: () => ({ event: 'winCombat', subject: 'self' }) },
  { pattern: /^you win (?:a )?combat$/i, build: () => ({ event: 'winCombat', subject: 'you' }) },

  // The designations of 464.2.c.3. "When I attack or defend" is genuinely two
  // conditions, so it produces two abilities rather than one — `parseAbility`
  // splits it, the same way a card with two sentences produces two.
  { pattern: /^i attack$/i, build: () => ({ event: 'attack', subject: 'self' }) },
  { pattern: /^i defend$/i, build: () => ({ event: 'defend', subject: 'self' }) },

  // Stun (423). 423.1.a.1 is what makes "when you stun" meaningful — the
  // engine raises the event only when the status actually changes.
  {
    pattern: /^you stun an? (friendly|enemy) unit$/i,
    build: (m) => ({
      event: 'stun',
      subject: (m[1] ?? '').toLowerCase() === 'enemy' ? 'enemy' : 'friendly',
    }),
  },
  { pattern: /^you stun an? unit$/i, build: () => ({ event: 'stun', subject: 'any' }) },

  // Buffs (702) and discards (422).
  { pattern: /^you buff me$/i, build: () => ({ event: 'buffed', subject: 'self' }) },
  { pattern: /^i'?m buffed$/i, build: () => ({ event: 'buffed', subject: 'self' }) },
  {
    pattern: /^you discard(?: one or more cards| a card| \d+)?$/i,
    build: () => ({ event: 'discard', subject: 'you' }),
  },

  // Activated abilities (377.3).
  {
    pattern: /^you use an activated ability of an? (gear|unit|spell)$/i,
    build: (m) => ({
      event: 'activateAbility',
      subject: 'you',
      filter: { cardType: (m[1] ?? '').toLowerCase() as 'gear' | 'unit' | 'spell' },
    }),
  },

  // Readying (415). The Awaken Phase raises this too, which is what the
  // printed wording means — 315.1 readies by the same rule an effect does.
  {
    pattern: /^you ready an? ((?:friendly|enemy) )?(unit|gear)$/i,
    build: (m) => ({
      event: 'ready',
      subject: (m[1] ?? '').trim().toLowerCase() === 'enemy' ? 'enemy' : 'friendly',
      ...((m[2] ?? 'unit').toLowerCase() === 'gear' ? { filter: { cardType: 'gear' as const } } : {}),
    }),
  },
  { pattern: /^you ready me$/i, build: () => ({ event: 'ready', subject: 'self' }) },

  // Recycling (416) and spending a Buff (702).
  {
    pattern: /^you recycle(?: one or more cards| a card| \d+ cards?)?$/i,
    build: () => ({ event: 'recycle', subject: 'you' }),
  },
  { pattern: /^you spend a buff$/i, build: () => ({ event: 'spendBuff', subject: 'you' }) },

  // 355.6: being chosen as a Target. `byController` is what makes "when **you**
  // choose me" different from an opponent pointing a spell at the same Unit —
  // `subject: 'self'` constrains the object and this constrains the actor.
  {
    pattern: /^you choose me(?: with an? (spell|ability))?$/i,
    build: (m) => ({
      event: 'chosen',
      subject: 'self',
      filter: {
        byController: true,
        // The Spell is what *chose*, so this is `bySource`; read as `cardType`
        // it would ask whether the chosen Unit is a Spell and never hold.
        ...(m[1] === undefined ? {} : { bySource: m[1].toLowerCase() as CardType }),
      },
    }),
  },
];

/**
 * Cost modifiers a card states about *itself* (rule 356.4, 363).
 *
 * Only the self-referential forms are here, and that is the measurement rather
 * than a stopping point: of the 24 clauses in the corpus that mention a cost,
 * every one is distinct, and the ones that are not about the card's own cost
 * want a mechanic instead — a duration ("the next spell you play this turn"), a
 * condition ("if an opponent's score is within 3 points"), a Battlefield static
 * ("while you control this battlefield"), or a count of something the state
 * cannot see. Those are refused, not approximated.
 */
const COST_MODIFIERS: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => CostModifier | undefined;
}[] = [
  {
    // "I cost 2 less." / "This costs 2 less."
    pattern: /^(?:i cost|this costs) (\d+) less$/i,
    build: (m) => {
      const energy = count(m[1] ?? '');
      return energy === undefined
        ? undefined
        : { applies: { scope: 'self' }, change: { kind: 'discount', energy } };
    },
  },
  {
    // "Reduce my cost by 2" — the wording that pairs with an Additional Cost.
    pattern: /^reduce (?:my|this) cost by (\d+)$/i,
    build: (m) => {
      const energy = count(m[1] ?? '');
      return energy === undefined
        ? undefined
        : { applies: { scope: 'self' }, change: { kind: 'discount', energy } };
    },
  },
  {
    // "Ignore this spell's cost" (356.5.a).
    pattern: /^ignore (?:my|this spell'?s|this) cost$/i,
    build: () => ({ applies: { scope: 'self' }, change: { kind: 'ignoreAll' } }),
  },
  {
    // "I cost 1 less for each card in your trash."
    pattern: /^(?:i cost|this costs) (\d+) less for each card in your trash$/i,
    build: (m) => {
      const energy = count(m[1] ?? '');
      return energy === undefined
        ? undefined
        : {
            applies: { scope: 'self' },
            change: { kind: 'discount', per: { count: { kind: 'cardsInTrash' }, energy } },
          };
    },
  },
  {
    /**
     * "**Spells you play** cost 5 less", "your Dragons' Energy costs are
     * reduced by 2, to a minimum of 1" — a discount on a *scope* rather than on
     * the card printing it.
     *
     * `scope: 'controller'` rather than `'self'`: 366.2.a applies a
     * cost-altering Passive "at all times in any zone from which the card with
     * the ability can be played", and this one is about the cards its
     * controller plays, not about its own cost.
     */
    pattern:
      /^(?:the next )?(spells?|units?|gears?|cards?) you play costs? (\d+) less(?:, to a minimum of (\d+))?$/i,
    build: (m) => {
      const energy = count(m[2] ?? '');
      if (energy === undefined) {
        return undefined;
      }
      const minimum = m[3] === undefined ? undefined : count(m[3]);
      if (m[3] !== undefined && minimum === undefined) {
        return undefined;
      }
      const noun = (m[1] ?? 'card').toLowerCase().replace(/s$/, '');
      return {
        applies: {
          scope: 'friendly' as const,
          ...(noun === 'card' ? {} : { types: [noun as CostTarget] }),
        },
        change: {
          kind: 'discount' as const,
          energy,
          ...(minimum === undefined ? {} : { minimumEnergy: minimum }),
        },
      };
    },
  },
  {
    // "I cost 1 less for each card you've played this turn, to a minimum of 1."
    // 356.4.e's minimum binds this discount alone, which is why it rides on the
    // change rather than on the total.
    pattern:
      /^(?:i cost|this costs) (\d+) less for each card you'?ve played this turn(?:, to a minimum of (\d+))?$/i,
    build: (m) => {
      const energy = count(m[1] ?? '');
      if (energy === undefined) {
        return undefined;
      }
      const minimum = m[2] === undefined ? undefined : count(m[2]);
      if (m[2] !== undefined && minimum === undefined) {
        return undefined;
      }
      return {
        applies: { scope: 'self' },
        change: {
          kind: 'discount',
          per: { count: { kind: 'cardsPlayedThisTurn' }, energy },
          ...(minimum === undefined ? {} : { minimumEnergy: minimum }),
        },
      };
    },
  },
];

/**
 * Additional Costs (rule 356.2).
 *
 * Recognised by the phrase "as an additional cost" (356.2.a.1), with the word
 * "may" deciding Mandatory from Optional — that is the rulebook's own test, so
 * it is the parser's too.
 *
 * Only payments the engine can both check and perform are read. "Kill any
 * number of friendly units" and "spend any number of buffs" are refused: a
 * variable count is a choice, and a cost that might not be payable in full
 * cannot be proven payable before the card is played.
 */
const COST_PAYMENTS: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => CostPayment | undefined;
}[] = [
  {
    pattern: /^discard (\d+|a) cards?$/i,
    build: (m) => {
      const raw = (m[1] ?? '').toLowerCase();
      const n = raw === 'a' ? 1 : count(raw);
      return n === undefined ? undefined : { kind: 'discard', count: n };
    },
  },
  {
    pattern: /^pay (\d+)?\s*(fury|calm|mind|body|chaos|order)$/i,
    build: (m) => {
      const n = m[1] === undefined ? 1 : count(m[1]);
      const domain = (m[2] ?? '').toLowerCase() as Domain;
      return n === undefined
        ? undefined
        : { kind: 'resources', cost: { energy: 0, power: Array.from({ length: n }, () => domain) } };
    },
  },
  {
    pattern: /^pay (\d+)$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined ? undefined : { kind: 'resources', cost: { energy: n, power: [] } };
    },
  },
  { pattern: /^spend a buff$/i, build: () => ({ kind: 'spendBuff' }) },
  { pattern: /^exhaust your legend$/i, build: () => ({ kind: 'exhaustLegend' }) },
  {
    pattern: /^kill a friendly (unit|gear)$/i,
    build: (m) => ({ kind: 'kill', what: (m[1] ?? 'unit').toLowerCase() as 'unit' | 'gear' }),
  },
];

/**
 * Read an Additional Cost clause, in any of the three wordings the cards use.
 *
 * "As you play me, you may X as an additional cost."
 * "As an additional cost to play me, X."
 * "You may X as an additional cost to play me."
 */
export function parseAdditionalCost(line: string): AdditionalCost | undefined {
  const text = line.replace(/[.]+$/, '').trim();

  const forms: readonly RegExp[] = [
    /^as (?:you play|an additional cost to play) (?:me|this),?\s*(.+?) as an additional cost$/i,
    /^as an additional cost to play (?:me|this),?\s*(.+)$/i,
    /^(.+?) as an additional cost to play (?:me|this)$/i,
  ];

  for (const form of forms) {
    const match = text.match(form);
    if (match === null) {
      continue;
    }
    let body = (match[1] ?? '').trim();
    // 356.2.a.1 vs 356.2.b.1: the word "may" is the whole difference.
    const optional = /^you may\s+/i.test(body);
    body = body.replace(/^you may\s+/i, '').trim();

    for (const rule of COST_PAYMENTS) {
      const payment = body.match(rule.pattern);
      if (payment === null) {
        continue;
      }
      const pay = rule.build(payment);
      return pay === undefined ? undefined : { pay, ...(optional ? { optional } : {}) };
    }
    return undefined;
  }
  return undefined;
}

/**
 * State predicates: "if you control a Poro", "if an opponent's score is within
 * 3 points of the Victory Score", "if you've discarded a card this turn".
 *
 * One grammar for all four places the corpus asks these — gating a static, an
 * "enters ready", a cost modifier or an effect. Only predicates the engine can
 * answer are here; one that needs a mechanic the model lacks is refused rather
 * than read as a condition that quietly never holds.
 */
const STATE_PREDICATES: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => Condition | undefined;
}[] = [
  {
    /**
     * "if **it** is stunned", "if **it's** an Equipment", "if **it was** an
     * enemy unit" — a predicate about the chosen target rather than the board.
     *
     * The pronoun is what distinguishes it: every other predicate here names a
     * player or a count. A static has no target, so `parseStatic` refusing one
     * of these is the same rule that refuses a source-relative condition
     * without a source.
     */
    pattern: /^it(?:'s| is| was| has been)?\s+(?:an? )?([a-z ]+?)$/i,
    build: (m) => {
      const word = (m[1] ?? '').trim().toLowerCase();
      const TARGET_STATES: Readonly<Record<string, Condition>> = {
        stunned: { kind: 'targetIs', stunned: true },
        exhausted: { kind: 'targetIs', exhausted: true },
        ready: { kind: 'targetIs', exhausted: false },
        damaged: { kind: 'targetIs', damaged: true },
        buffed: { kind: 'targetIs', buffed: true },
        attacking: { kind: 'targetIs', role: 'attacker' },
        defending: { kind: 'targetIs', role: 'defender' },
        equipment: { kind: 'targetIs', cardType: 'gear' },
        gear: { kind: 'targetIs', cardType: 'gear' },
        'enemy unit': { kind: 'targetIs', scope: 'enemy' },
        'friendly unit': { kind: 'targetIs', scope: 'friendly' },
      };
      return TARGET_STATES[word];
    },
  },
  {
    // "if you control a Poro", "if you control another Dragon",
    // "if you control two or more gear"
    pattern:
      /^you control (a|an|another|one|two|three|\d+)(?: or more)? ([A-Za-z'-]+?)s?$/i,
    build: (m) => {
      const word = (m[1] ?? '').toLowerCase();
      const min = word === 'a' || word === 'an' || word === 'another' ? 1 : count(word);
      if (min === undefined) {
        return undefined;
      }
      const noun = (m[2] ?? '').toLowerCase();
      const what = CARD_TYPES.find((type) => type === noun);
      return {
        kind: 'controls',
        who: 'you',
        // A noun that is not a card type is a tag — "Poro", "Dragon", "Mech" —
        // and those only ever appear on Units.
        what: what ?? 'unit',
        min,
        ...(what === undefined ? { tag: m[2] ?? '' } : {}),
        ...(word === 'another' ? { excludeSelf: true } : {}),
      };
    },
  },
  {
    // "While you have 8+ runes" — Channelled Runes are on the Board (161.1.a),
    // so this is an ordinary `controls` count rather than a new predicate.
    pattern: /^you have (\d+)\+? or more ([A-Za-z'-]+?)s?$|^you have (\d+)\+ ([A-Za-z'-]+?)s?$/i,
    build: (m) => {
      const min = count(m[1] ?? m[3] ?? '');
      const noun = (m[2] ?? m[4] ?? '').toLowerCase();
      if (min === undefined) {
        return undefined;
      }
      const what = CARD_TYPES.find((type) => type === noun);
      return {
        kind: 'controls',
        who: 'you',
        what: what ?? 'unit',
        min,
        ...(what === undefined ? { tag: noun } : {}),
      };
    },
  },
  {
    // "While you have another unit here" (355.9).
    pattern: /^you have (a|an|another|one|two|three|\d+)(?: or more)? ([A-Za-z'-]+?)s? here$/i,
    build: (m) => {
      const word = (m[1] ?? '').toLowerCase();
      const min = word === 'a' || word === 'an' || word === 'another' ? 1 : count(word);
      if (min === undefined) {
        return undefined;
      }
      const noun = (m[2] ?? '').toLowerCase();
      const what = CARD_TYPES.find((type) => type === noun);
      return {
        kind: 'controls',
        who: 'you',
        what: what ?? 'unit',
        min,
        here: true,
        ...(what === undefined ? { tag: noun } : {}),
        ...(word === 'another' ? { excludeSelf: true } : {}),
      };
    },
  },
  {
    pattern: /^an opponent controls a battlefield$/i,
    build: () => ({ kind: 'controls', who: 'opponent', what: 'battlefield', min: 1 }),
  },
  {
    // "if an opponent's score is within 3 points of the Victory Score"
    pattern:
      /^an opponent'?s score is within (\d+) points? of the victory score$/i,
    build: (m) => {
      const points = count(m[1] ?? '');
      return points === undefined ? undefined : { kind: 'scoreWithin', who: 'opponent', points };
    },
  },
  {
    pattern: /^your score is within (\d+) points? of the victory score$/i,
    build: (m) => {
      const points = count(m[1] ?? '');
      return points === undefined ? undefined : { kind: 'scoreWithin', who: 'you', points };
    },
  },
  {
    // "if you paid the additional cost" (356.2.b) — the most repeated
    // conditional wording in the corpus.
    pattern: /^you paid the additional cost$/i,
    build: () => ({ kind: 'paidAdditionalCost' }),
  },
  {
    pattern: /^you do$/i,
    build: () => ({ kind: 'paidAdditionalCost' }),
  },
  {
    // "if you've discarded a card this turn"
    pattern: /^you'?ve discarded (?:a card|\d+ cards?) this turn$/i,
    build: () => ({ kind: 'didThisTurn', event: 'discard', who: 'you', min: 1 }),
  },
  {
    // "if an enemy unit has died this turn"
    pattern: /^an enemy unit has died this turn$/i,
    build: () => ({ kind: 'didThisTurn', event: 'dies', who: 'opponent', min: 1 }),
  },
  {
    pattern: /^a friendly unit has died this turn$/i,
    build: () => ({ kind: 'didThisTurn', event: 'dies', who: 'you', min: 1 }),
  },
];

const CARD_TYPES = ['legend', 'unit', 'spell', 'gear', 'rune', 'battlefield'] as const;

/** Read a state predicate, or `undefined` if it is outside the grammar. */
export function parseStatePredicate(phrase: string): Condition | undefined {
  const text = phrase.trim().replace(/[.]+$/, '');
  for (const rule of STATE_PREDICATES) {
    const match = text.match(rule.pattern);
    if (match !== null) {
      return rule.build(match);
    }
  }
  return undefined;
}

/**
 * Peel a leading or trailing "if <predicate>," off a clause.
 *
 * Returns the condition and the rest, or `undefined` when there is an "if" the
 * grammar cannot read — which must fail the card rather than drop the
 * condition, since a card that ignores its own condition is strictly stronger
 * than printed.
 */
export function splitCondition(
  line: string,
): { readonly condition?: Condition | undefined; readonly rest: string } | undefined {
  const leading = line.match(/^if ([^,]+),\s*(.+)$/i);
  if (leading !== null) {
    const condition = parseStatePredicate(leading[1] ?? '');
    return condition === undefined ? undefined : { condition, rest: leading[2] ?? '' };
  }

  const trailing = line.match(/^(.+?) if ([^,]+?)[.]?$/i);
  if (trailing !== null) {
    const condition = parseStatePredicate(trailing[2] ?? '');
    return condition === undefined ? undefined : { condition, rest: trailing[1] ?? '' };
  }

  return { rest: line };
}

/**
 * Static and Passive abilities (rules 363-365).
 *
 * Written as a scope plus a grant rather than one pattern per sentence, the
 * same shape the trigger grammar took and for the same measured reason: the
 * literal wordings are flat (108 distinct clauses over 113 occurrences) while
 * the *categories* are few. Modifying Might and granting keywords are two
 * categories that between them account for most of the recognizably-static
 * text; "enters ready" is the third and is the single most repeated clause.
 *
 * A leading "While I'm buffed," / "While I'm at a battlefield," is stripped
 * into `condition` first, because it is orthogonal to what follows.
 */
const STATIC_SCOPES: readonly { readonly pattern: RegExp; readonly scope: StaticScope }[] = [
  { pattern: /^i$/i, scope: { who: 'self' } },
  { pattern: /^other friendly units here$/i, scope: { who: 'friendly', here: true, excludeSelf: true } },
  { pattern: /^other friendly units$/i, scope: { who: 'friendly', excludeSelf: true } },
  { pattern: /^friendly units here$/i, scope: { who: 'friendly', here: true } },
  { pattern: /^friendly units$/i, scope: { who: 'friendly' } },
  { pattern: /^enemy units here$/i, scope: { who: 'enemy', here: true } },
  { pattern: /^enemy units$/i, scope: { who: 'enemy' } },
  { pattern: /^units here$/i, scope: { who: 'any', here: true } },
  // A bare plural with no controller word is everyone's — "Units can't move to
  // base" binds the printer's own Units too.
  { pattern: /^units$/i, scope: { who: 'any' } },
  // "Your units here have GANKING" — the same statement as "friendly units",
  // written from the reader's side rather than the board's.
  { pattern: /^your units here$/i, scope: { who: 'friendly', here: true } },
  { pattern: /^your units$/i, scope: { who: 'friendly' } },
  // 185: "Your tokens enter ready". Listed before the tag rule below so the
  // noun is never mistaken for a tag.
  { pattern: /^your tokens$/i, scope: { who: 'friendly', token: true } },
  // 712: "**Your spells and abilities** deal 1 Bonus Damage" — the scope names
  // whose Deal actions, not which Game Objects.
  { pattern: /^your spells and abilities$/i, scope: { who: 'friendly' } },
  // "Spells and abilities affecting units **here** each deal 1 Bonus Damage."
  {
    pattern: /^spells and abilities affecting units here(?: each)?$/i,
    scope: { who: 'any', here: true },
  },
  // "**Units you play** this turn enter ready" — the same friendly scope said
  // from the entering card's side. 359.2.c is about how a card enters, so the
  // wording can only ever be about the player doing the playing.
  // "Units you play this turn enter ready", "the next spell you play deals 1
  // Bonus Damage" — the same friendly scope said from the played card's side.
  { pattern: /^(?:the next )?(?:units?|spells?|gears?|cards?) you play$/i, scope: { who: 'friendly' } },
];

/**
 * "Your **Mechs** have +1 Might" — a scope narrowed to a tag (133.8).
 *
 * Separate from `STATIC_SCOPES` because it captures rather than matching a
 * fixed phrase, and it is tried last so every noun the table names wins first.
 * The plural is stripped: card text says "Mechs" and the tag is "Mech".
 */
const TAGGED_SCOPE = /^your ([a-z][a-z' ]*?)s$/i;

function taggedScope(text: string): StaticScope | undefined {
  const match = text.match(TAGGED_SCOPE);
  return match === null ? undefined : { who: 'friendly', tag: (match[1] ?? '').trim() };
}

/** The scope a static's subject phrase names, fixed phrases before tags. */
function scopeNamed(text: string): StaticScope | undefined {
  return STATIC_SCOPES.find((entry) => entry.pattern.test(text))?.scope ?? taggedScope(text);
}

/**
 * The keywords that are *shorthand for an ability* rather than an engine rule,
 * expanded into what they stand for (801).
 *
 * Written once and used twice: a printed keyword line expands here, and so does
 * one a static grants — "Friendly units have DEFLECT" and a printed DEFLECT
 * must mean the same thing, which 801.3.a requires and two expansions would
 * eventually break.
 *
 * Only the two the corpus ever grants. The others desugar into shapes a *scope*
 * cannot carry — Equip is an Activated Ability about the Gear itself, Accelerate
 * is an Additional Cost on the card being played — so granting them to a set of
 * Units would be a different mechanic rather than the same one.
 */
function desugarKeyword(name: string, value: string | undefined): CardAbilities | undefined {
  // 809.1.c: a Passive cost increase of `[A]` on Spells and Abilities an
  // opponent controls that choose this Game Object. 809.1.b.3: omitted is 1.
  if (/^deflect$/i.test(name)) {
    return {
      costModifiers: [
        {
          applies: {
            types: ['unit', 'spell', 'gear', 'ability'],
            scope: 'opponent',
            choosesSource: true,
          },
          change: { kind: 'increase', anyPower: count(value ?? '1') ?? 1 },
        },
      ],
    };
  }
  // 817.1.b: "When this is played, predict", and 436.1 makes a Predict a look
  // plus an optional Recycle. 436.3.a: an omitted count is 1.
  if (/^vision$/i.test(name) && value === undefined) {
    return {
      triggered: [
        {
          condition: { event: 'played', subject: 'self' },
          optional: true,
          effect: { target: NO_TARGET, effects: [{ kind: 'recycleTop', count: 1 }] },
        },
      ],
    };
  }
  return undefined;
}

/**
 * The keyword list a grant names, e.g. "ASSAULT and GANKING", "SHIELD 3, TANK".
 *
 * Shared by a static's grant and an effect's, and it reads `MODELLED_KEYWORDS`
 * rather than a second table — so a keyword the engine does not implement
 * cannot be granted either way. 801.3.a makes a granted keyword do exactly what
 * a printed one does, and granting one the engine ignores would be the same
 * wrong card as printing it.
 */
function grantedKeywords(text: string): readonly Keyword[] | undefined {
  const parsed = grantedKeywordList(text);
  // An effect's grant carries `Keyword`s only, so a desugaring one — which is
  // an ability rather than a keyword — is not something this form can express.
  return parsed === undefined || parsed.abilities !== undefined ? undefined : parsed.keywords;
}

/**
 * A keyword list split into the two things a keyword can be: an engine rule
 * (`Keyword`) and shorthand for an ability (`CardAbilities`).
 *
 * "Your Mechs have DEFLECT and GANKING" is one of each, and both halves have to
 * survive — 801.3.a makes a granted keyword do exactly what a printed one does,
 * so dropping either would be the wrong card.
 */
function grantedKeywordList(
  text: string,
): { keywords?: readonly Keyword[]; abilities?: CardAbilities } | undefined {
  const keywords: Keyword[] = [];
  let abilities: CardAbilities | undefined;
  let found = false;
  for (const part of text.split(/\s+and\s+|,\s*/i)) {
    const token = part.trim();
    if (token === '') {
      continue;
    }
    found = true;
    const rule = MODELLED_KEYWORDS.map((entry) => ({ entry, match: token.match(entry.pattern) })).find(
      (entry) => entry.match !== null,
    );
    if (rule?.match != null) {
      keywords.push(rule.entry.build(rule.match));
      continue;
    }
    const named = token.match(/^([a-z-]+)(?:\s+(\d+))?$/i);
    const desugared = named === null ? undefined : desugarKeyword(named[1] ?? '', named[2]);
    if (desugared === undefined) {
      return undefined;
    }
    abilities = mergeAbilities(abilities, desugared);
  }
  if (!found) {
    return undefined;
  }
  return {
    ...(keywords.length === 0 ? {} : { keywords }),
    ...(abilities === undefined ? {} : { abilities }),
  };
}

/** Union two `CardAbilities`, for a grant naming several keywords. */
function mergeAbilities(a: CardAbilities | undefined, b: CardAbilities): CardAbilities {
  if (a === undefined) {
    return b;
  }
  return {
    ...(a.activated ?? b.activated ? { activated: [...(a.activated ?? []), ...(b.activated ?? [])] } : {}),
    ...(a.triggered ?? b.triggered ? { triggered: [...(a.triggered ?? []), ...(b.triggered ?? [])] } : {}),
    ...(a.costModifiers ?? b.costModifiers
      ? { costModifiers: [...(a.costModifiers ?? []), ...(b.costModifiers ?? [])] }
      : {}),
    ...(a.statics ?? b.statics ? { statics: [...(a.statics ?? []), ...(b.statics ?? [])] } : {}),
  };
}

/**
 * Restrictions a static may state (rule 002), by their printed wording.
 *
 * A closed table rather than a grammar, and deliberately so: each entry names
 * one rule the engine enforces at one place, and a wording that is *nearly* one
 * of these — "units can't move from here to a battlefield" — is a different
 * restriction the engine does not have. Reading it as the nearest match would
 * be the plausible-and-wrong card the gap model exists to prevent.
 *
 * `scope` is the phrase before the prohibition, read by `scopeNamed` where it
 * names objects and by `who` where it names players.
 */
const RESTRICTIONS: readonly {
  readonly pattern: RegExp;
  readonly build: (match: RegExpMatchArray) => StaticAbility | undefined;
}[] = [
  {
    // 449.1: "Units can't move to base", "Units can't move from here to base".
    pattern: /^(.+?) can'?t move (?:from here )?to base$/i,
    build: (m) => {
      const here = /^units? can'?t move from here/i.test(m[0]);
      const scope = scopeNamed((m[1] ?? '').trim());
      return scope === undefined
        ? undefined
        : {
            affects: here ? { ...scope, here: true } : scope,
            grant: { forbid: [{ kind: 'moveToBase' }] },
          };
    },
  },
  {
    // 355.2: "Units can't be played here" — place-facing, so the scope names
    // whose Units it binds and the place is this card's own Location.
    pattern: /^(.+?) can'?t be played here$/i,
    build: (m) => {
      const scope = scopeNamed((m[1] ?? '').trim());
      return scope === undefined
        ? undefined
        : { affects: scope, grant: { forbid: [{ kind: 'playHere' }] } };
    },
  },
  {
    // 355.6: "I can't be chosen by enemy spells and abilities" — the mirror of
    // Deflect, which prices the choice rather than removing it.
    pattern: /^i can'?t be chosen by enemy spells and abilities$/i,
    build: () => ({
      affects: { who: 'self' },
      grant: { forbid: [{ kind: 'chosenByOpponent' }] },
    }),
  },
  {
    // 467: "opponents can't score points".
    pattern: /^opponents? can'?t score points$/i,
    build: () => ({ affects: { who: 'enemy' }, grant: { forbid: [{ kind: 'score' }] } }),
  },
  {
    // 358.4 with rule 002: "opponents can't play cards". Player-facing, like
    // `score` — it is about who may act, not about a Game Object.
    pattern: /^opponents? can'?t play cards$/i,
    build: () => ({ affects: { who: 'enemy' }, grant: { forbid: [{ kind: 'playCards' }] } }),
  },
  {
    // 355.2: "opponents can only play units to their base" — the inverse of
    // 355.2.b's permission.
    pattern: /^opponents? can only play units to (?:their|your) base$/i,
    build: () => ({
      affects: { who: 'enemy' },
      grant: { forbid: [{ kind: 'playAwayFromBase' }] },
    }),
  },
  {
    // 419: "spells and abilities can't ready enemy units and gears".
    pattern: /^spells and abilities can'?t ready (friendly|enemy) units and gears?$/i,
    build: (m) => ({
      affects: { who: (m[1] ?? '').toLowerCase() === 'enemy' ? 'enemy' : 'friendly' },
      grant: { forbid: [{ kind: 'readyByEffect' }] },
    }),
  },
];

/** Read one static clause, or `undefined` if it is outside the grammar. */
/**
 * A predicate that may be about the *source* rather than the state.
 *
 * `parseStatePredicate` deliberately does not answer "I'm buffed" or "I'm at a
 * battlefield" — those read the source, and a card in hand has neither — so the
 * two are named here and everything else goes through the shared grammar.
 * Factored out because two callers need it: the "While …" wrapper and rule
 * 002's "Use my abilities only while …".
 */
function parseSourcePredicate(phrase: string): Condition | undefined {
  const source = phrase.trim().match(/^i'?m (buffed|at a battlefield)$/i);
  if (source !== null) {
    return /buffed/i.test(source[1] ?? '') ? { kind: 'buffed' } : { kind: 'atBattlefield' };
  }
  const state = parseStatePredicate(phrase);
  // A static has no chosen target, so a `targetIs` predicate could never hold
  // — the same reason a source-relative condition is refused without a source.
  return state?.kind === 'targetIs' ? undefined : state;
}

/**
 * "Look at the top N cards of your Main Deck. <disposition>" (424, 390.5).
 *
 * Read here rather than as a clause rule because the two halves are separate
 * *sentences*, and `parseSentences` would otherwise merge them as siblings —
 * where 390.5 makes the second a Linked Ability *generated by* the first.
 *
 * The disposition is parsed by the ordinary effect grammar, with `revealed` as
 * its target: "put 1 into your hand", "you may play one", "if it's a gear,
 * draw it. Otherwise, recycle it".
 */
function parseLook(line: string): Effect | undefined {
  // "Reveal cards from the top of your Main Deck **until you reveal a unit**":
  // the count is a cap and the first match ends the look. Read first, because
  // the general pattern below would otherwise take it with no `until`.
  const bounded =
    /^(look at|reveal) cards? from the top of your main deck until you (?:look at|reveal) an? (unit|spell|gear|rune)[.,]?\s*(.*)$/i.exec(
      line.trim(),
    );
  if (bounded !== null) {
    const rest = (bounded[3] ?? '').trim();
    const then = parseEffects(rest.replace(/[.]+$/, ''));
    if (then === undefined || (then.target.kind !== 'revealed' && then.target.kind !== 'none')) {
      return undefined;
    }
    return {
      kind: 'look',
      // No printed cap. A whole deck is the bound the rules give (431.1.c
      // makes running short a look at as many as possible, not a Burn Out).
      count: Number.MAX_SAFE_INTEGER,
      until: (bounded[2] ?? 'unit').toLowerCase() as CardType,
      ...(/^reveal$/i.test(bounded[1] ?? '') ? { reveal: true } : {}),
      then,
    };
  }

  const opened =
    /^(look at|reveal) (?:the )?top (\d+|one|two|three|four|five)? ?cards? (?:from the top )?of your main deck[.,]?\s*(.*)$/i.exec(
      line.trim(),
    );
  if (opened === null) {
    return undefined;
  }
  const looked = opened[2] === undefined ? 1 : count(opened[2]);
  if (looked === undefined) {
    return undefined;
  }
  const rest = (opened[3] ?? '').trim();
  if (rest === '') {
    return undefined;
  }
  const then = parseEffects(rest.replace(/[.]+$/, ''));
  // The disposition has to be about the cards just looked at. A body that
  // chooses something else entirely is a different card, not this shape.
  if (then === undefined || (then.target.kind !== 'revealed' && then.target.kind !== 'none')) {
    return undefined;
  }
  return {
    kind: 'look',
    count: looked,
    // 424.1 presents to all players; a "look" is Private to the looker (128.4).
    ...(/^reveal$/i.test(opened[1] ?? '') ? { reveal: true } : {}),
    then,
  };
}

/** The first `COST_MODIFIERS` rule that reads `body` whole, if any. */
function parseCostModifier(body: string): CostModifier | undefined {
  for (const rule of COST_MODIFIERS) {
    const match = body.match(rule.pattern);
    if (match !== null) {
      return rule.build(match);
    }
  }
  return undefined;
}

/**
 * "<passive> this turn" (390.4) — a Delayed Passive Ability.
 *
 * Delegates to the ordinary Passive and cost-modifier grammars rather than
 * having one of its own: 390.1 says a Delayed Ability "can be any other type of
 * Ability, and contains all of the properties of that type in addition to the
 * properties of Delayed Abilities". The window is the only thing this adds.
 */
function parseDelayedPassive(body: string): Effect | undefined {
  const next = /^the next (.+)$/i.exec(body.trim());
  const inner = (next?.[1] ?? body).trim();
  // "The next" is a counted window. Reading it as uncounted would make the card
  // strictly stronger than printed, so the count is carried, never dropped.
  const uses = next === null ? undefined : 1;

  // A cost wording is tried first: it would otherwise reach `parseStatic` and
  // fail there, since a discount is not a scope-plus-grant.
  const costModifier = parseCostModifier(inner);
  if (costModifier !== undefined) {
    return { kind: 'thisTurn', costModifier, ...(uses === undefined ? {} : { uses }) };
  }
  const asStatic = parseStatic(inner);
  if (asStatic === undefined) {
    return undefined;
  }
  // A `self` scope is about the card that opened the window, which for a Spell
  // is in the trash before anything reads it. Refused rather than registered as
  // a Passive that can never apply.
  if (asStatic.affects.who === 'self') {
    return undefined;
  }
  return { kind: 'thisTurn', static: asStatic, ...(uses === undefined ? {} : { uses }) };
}

export function parseStatic(line: string): StaticAbility | undefined {
  let text = line.replace(/[.]+$/, '').trim();
  let condition: Condition | undefined;

  // "While <predicate>, <static>". The two source-relative predicates are named
  // here because they are about the source rather than the state, and
  // `parseStatePredicate` deliberately does not answer those; anything else is
  // an ordinary state predicate and goes through the shared grammar, so
  // "While you have 8+ runes" needs no rule of its own.
  const whileClause = text.match(/^while (.+?),\s*(.+)$/i);
  if (whileClause !== null) {
    condition = parseSourcePredicate((whileClause[1] ?? '').trim());
    // A "while" the grammar cannot read must fail the card: dropping it would
    // make the static unconditional, which is strictly stronger than printed.
    if (condition === undefined) {
      return undefined;
    }
    text = whileClause[2] ?? '';
  } else {
    // "If you control another Dragon, I enter ready" and "I enter ready if you
    // control another Dragon" are the same statement written two ways.
    const split = splitCondition(text);
    if (split === undefined) {
      return undefined;
    }
    condition = split.condition;
    text = split.rest;
  }

  // "Use my abilities only while I'm at a battlefield" (377 with rule 002).
  //
  // Read before the `RESTRICTIONS` table because the printed wording is
  // "only while X" and the model wants "while not X" — the negation is what
  // makes it the same shape as every other restriction, and `Condition.not`
  // supplies it. A condition already read off the line would be about the
  // wrong half, so a wording carrying both is refused.
  const onlyWhile = text.match(/^use (?:my|this) abilit(?:y|ies) only while (.+)$/i);
  if (onlyWhile !== null) {
    const inner = parseSourcePredicate(onlyWhile[1] ?? '');
    if (inner === undefined || condition !== undefined) {
      return undefined;
    }
    return {
      affects: { who: 'self' },
      grant: { forbid: [{ kind: 'activateAbility' }] },
      condition: { kind: 'not', condition: inner },
    };
  }

  // Rule 002: a clause that takes a permission away rather than adding one.
  // Tried before the grants, because "Units can't be played here" would
  // otherwise fall through to the "<scope> have <grant>" shape and fail there.
  for (const rule of RESTRICTIONS) {
    const match = text.match(rule.pattern);
    if (match === null) {
      continue;
    }
    const restriction = rule.build(match);
    return restriction === undefined
      ? undefined
      : { ...restriction, ...(condition ? { condition } : {}) };
  }

  // "<scope> enter(s) ready" (359.2.c is what this replaces).
  const ready = text.match(/^(.+?) enters? ready$/i);
  if (ready !== null) {
    const scope = scopeNamed((ready[1] ?? '').trim());
    return scope === undefined
      ? undefined
      : { affects: scope, grant: { entersReady: true }, ...(condition ? { condition } : {}) };
  }

  // 355.2.b: "You may play me to an open battlefield", "Friendly units may be
  // played to open battlefields." A permission that widens 355.2.a's default,
  // and 170.11 defines the two states cards name.
  const playTo = text.match(
    /^(?:you may play (me|.+?)|(.+?) may be played) to (?:an? )?(open|occupied enemy) battlefields?$/i,
  );
  if (playTo !== null) {
    const who = (playTo[1] ?? playTo[2] ?? '').trim();
    const scope = /^me$/i.test(who) ? ({ who: 'self' } as StaticScope) : scopeNamed(who);
    if (scope === undefined) {
      return undefined;
    }
    const where = /^open$/i.test(playTo[3] ?? '') ? 'open' : 'occupiedEnemy';
    return {
      affects: scope,
      grant: { playTo: [where] },
      ...(condition ? { condition } : {}),
    };
  }

  // "My Might is increased by your points" — the same dynamic Might as "I have
  // +1 Might for each …", written the other way round. Normalised rather than
  // given its own builder, so the count still goes through `readsMight`.
  const increased = text.match(/^(.+?)(?:'s)? might is (increased|reduced) by (.+)$/i);
  if (increased !== null) {
    const sign = /^increased$/i.test(increased[2] ?? '') ? '+' : '-';
    const whose = (increased[1] ?? '').trim();
    return buildStatic(
      /^my$/i.test(whose) ? 'I' : whose,
      `${sign}1 might for each ${increased[3] ?? ''}`,
      condition,
    );
  }

  // "<scope> have/has <+N Might | KEYWORD…>". "an additional +1 Might" is the
  // same statement with a word of emphasis in it.
  // "deal(s)" joins the list because 712's Bonus Damage is stated as a verb —
  // "Your spells and abilities **deal** 1 Bonus Damage" — where every other
  // grant is stated as a possession. An effect clause cannot be caught by it:
  // "Deal 2 to a unit" has nothing before the verb to be a scope.
  const have = text.match(/^(.+?) (?:have|has|gets?|deals?) (?:an additional )?(.+)$/i);
  if (have === null) {
    return undefined;
  }
  const printedScope = (have[1] ?? '').trim();
  const printedBody = (have[2] ?? '').trim();

  // 355.9's "here" is printed at either end — "Other friendly units here have
  // +1 Might" and "Other friendly units have +1 Might here" are the same
  // statement — so a trailing one is moved onto the scope, which is the half it
  // is about. As a *fallback* rather than a rewrite: "I have ASSAULT equal to
  // the number of enemy units here" ends in the same word and means something
  // else entirely, so the printed reading is tried first and only a failure
  // reaches this one.
  const trailingHere = /^(.+?)\s+here$/i.exec(printedBody);
  const asPrinted = buildStatic(printedScope, printedBody, condition);
  if (asPrinted !== undefined || trailingHere === null) {
    return asPrinted;
  }
  return buildStatic(`${printedScope} here`, (trailingHere[1] ?? '').trim(), condition);
}

/** The grant half of a static, once its scope phrase and body are separated. */
function buildStatic(
  scopePhrase: string,
  printed: string,
  condition: Condition | undefined,
): StaticAbility | undefined {
  const scope = scopeNamed(scopePhrase);
  if (scope === undefined) {
    return undefined;
  }

  let body = printed;

  // "I have +1 Might **for each friendly gear**", "I have ASSAULT **equal to
  // the number of enemy units here**". The count multiplies whatever the grant
  // gives, so it is peeled off first and the rest parses as an ordinary grant.
  let per: Count | undefined;
  const dynamic = body.match(/^(.+?) (?:for each|equal to) (?:of )?(.+)$/i);
  if (dynamic !== null) {
    per = parseCount(dynamic[2] ?? '');
    if (per === undefined) {
      return undefined;
    }
    // A count that reads Might cannot appear in a static's grant: `mightOf`
    // consults statics, so it would recurse through this one. Refused rather
    // than allowed to read 0, which would be a quietly weaker card.
    if (readsMight(per)) {
      return undefined;
    }
    body = (dynamic[1] ?? '').trim();
    // "ASSAULT equal to N" prints no value, and 807.1.b.3 makes a bare keyword
    // 1 — which is exactly the per-unit value the count then scales.
  }

  // 712-715: "deal 1 Bonus Damage". A grant like any other, and the scope in
  // front of it says whose Deal actions it reaches.
  const bonus = body.match(/^(?:deals? )?(\d+) bonus damage$/i);
  if (bonus !== null) {
    const amount = count(bonus[1] ?? '');
    // 714.1: Bonus Damage is only ever positive.
    return amount === undefined || amount < 1
      ? undefined
      : { affects: scope, grant: { bonusDamage: amount }, ...(condition ? { condition } : {}) };
  }

  const might = body.match(/^([+-]\d+) might(?:, to a minimum of (\d+) might)?$/i);
  if (might !== null) {
    const amount = Number.parseInt(might[1] ?? '', 10);
    const floor = might[2] === undefined ? undefined : count(might[2]);
    // 143.2.b: the floor only means anything on a reduction. Printed on a
    // positive grant it would be noise, so it is refused rather than dropped.
    if (might[2] !== undefined && (floor === undefined || amount >= 0)) {
      return undefined;
    }
    return Number.isNaN(amount)
      ? undefined
      : {
          affects: scope,
          grant: {
            might: amount,
            ...(floor === undefined ? {} : { minimumMight: floor }),
            ...(per === undefined ? {} : { per }),
          },
          ...(condition ? { condition } : {}),
        };
  }

  // 801.3.a: a granted keyword does exactly what a printed one does, so a
  // keyword that *is* an ability is granted as that ability — "Friendly units
  // have DEFLECT" gives each of them 809.1.c's cost increase.
  const granted = grantedKeywordList(body);
  if (granted === undefined) {
    return undefined;
  }
  // A count multiplies what a grant *gives*, and an ability has no number to
  // multiply. Refused rather than silently applied to the keywords alone.
  if (per !== undefined && granted.abilities !== undefined) {
    return undefined;
  }
  return {
    affects: scope,
    grant: {
      ...(granted.keywords === undefined ? {} : { keywords: granted.keywords }),
      ...(granted.abilities === undefined ? {} : { abilities: granted.abilities }),
      ...(per === undefined ? {} : { per }),
    },
    ...(condition ? { condition } : {}),
  };
}

/**
 * The conditions a clause names, together with any per-turn limit its wording
 * implies.
 *
 * A list because 383.2 gives one Triggered Ability exactly one condition, so
 * "When I attack **or** defend, …" is two abilities sharing an effect rather
 * than one ability with a disjunction. Reading it as a disjunction would need
 * a `TriggerCondition` shape that no rule describes.
 */
interface ParsedCondition {
  readonly conditions: readonly TriggerCondition[];
  readonly limitPerTurn?: number | undefined;
}

/**
 * Read a trigger's condition clause.
 *
 * Three wrappers come off first, because each is orthogonal to *what* the
 * condition watches: "the first time ... each turn" is rule 383.3.e's per-turn
 * limit, and "when"/"whenever" is noise.
 */
export function parseCondition(head: string): ParsedCondition | undefined {
  const phrase = head.trim();

  const firstTime = phrase.match(/^the first time (.+?) each turn$/i);
  if (firstTime !== null) {
    const inner = parseCondition(`when ${firstTime[1] ?? ''}`);
    // A limit already implied by the inner wording would be being overwritten,
    // which never happens today and should not pass silently if it starts to.
    return inner === undefined || inner.limitPerTurn !== undefined
      ? undefined
      : { conditions: inner.conditions, limitPerTurn: 1 };
  }

  const when = phrase.match(/^(?:when|whenever)\s+(.+)$/i);
  if (when === null) {
    const phase = PHASE_CONDITIONS.find((entry) => entry.pattern.test(phrase));
    return phase === undefined ? undefined : { conditions: [phase.condition] };
  }

  const body = when[1] ?? '';
  const one = matchCondition(body);
  if (one !== undefined) {
    return { conditions: [one] };
  }

  // "When I attack **or** defend", "When I'm played **and when** I conquer" —
  // two conditions sharing one effect. Tried only after the whole clause has
  // failed, because a condition may contain the word itself: "when you play a
  // unit or gear" is one condition, and splitting it would lose the card.
  //
  // Each half is re-read as a whole clause, so "when I attack or defend" needs
  // the subject carried over — the second half prints none.
  const split = body.split(/\s+(?:and when|or when|or)\s+/i);
  if (split.length < 2) {
    return undefined;
  }
  // "when I attack or defend" prints the subject once, so a later half that
  // does not parse alone is retried with the first half's subject in front.
  // Only on failure: a half that already reads as a condition is left alone.
  const subject = /^((?:i'm|i|you)\b)/i.exec(split[0] ?? '')?.[1] ?? '';
  const conditions: TriggerCondition[] = [];
  for (const half of split) {
    const text = half.trim();
    const parsed =
      matchCondition(text) ??
      (subject === '' ? undefined : matchCondition(`${subject} ${text}`));
    if (parsed === undefined) {
      return undefined;
    }
    conditions.push(parsed);
  }
  return { conditions };
}

/** One condition clause, with the "when" already stripped. */
function matchCondition(body: string): TriggerCondition | undefined {
  for (const rule of CONDITIONS) {
    const match = body.match(rule.pattern);
    if (match !== null) {
      const condition = rule.build(match);
      if (condition !== undefined) {
        return condition;
      }
    }
  }
  return undefined;
}

/**
 * Parse a run of effect clauses, e.g. `"Draw 1, then deal 2 to a unit"`.
 *
 * Returns `undefined` if any clause is unrecognised, or if two clauses want
 * *different* targets — `CardEffect` carries one target for the whole card, so
 * a card that damages one Unit and buffs another cannot be represented.
 */
export function parseEffects(body: string): CardEffect | undefined {
  // 424 with 390.5, reached from a trigger's body: "reveal the top 2 … . You
  // may play one. Then recycle the rest."
  const look = parseLook(body);
  if (look !== undefined) {
    return { target: NO_TARGET, effects: [look] };
  }

  // "**You may** kill a gear." — an optional instruction with a chosen target
  // is a choice of *zero or one*, which `TargetCount` already states. Refused
  // when the clause chooses nothing: "you may draw 1" read as a bare draw
  // would be mandatory, which is a different and stronger card.
  const may = /^you may\s+(.+)$/i.exec(body.trim());
  if (may !== null) {
    const inner = parseEffects(may[1] ?? '');
    // Only a spec that *counts* can express "you may": the choice of none is
    // the zero end of its range. A clause choosing nothing read as optional
    // would be mandatory, which is a different and stronger card.
    if (inner === undefined || (inner.target.kind !== 'unit' && inner.target.kind !== 'revealed')) {
      return undefined;
    }
    const { min, max } = targetCount(inner.target);
    return min === 0
      ? inner
      : { ...inner, target: { ...inner.target, count: { min: 0, max } } };
  }

  // A whole-line match wins over the split, because "and" is both a sequence
  // joiner and part of single clauses — "give a unit SHIELD 3 and TANK this
  // turn" is one grant, not two halves. Every clause pattern is anchored, so
  // a whole-line match can only be the clause it names.
  const asOne = matchClause(body.replace(/[.]+$/, '').trim());
  // A pronoun clause alone refers to the triggering object, which the split
  // path below builds — so the whole-line shortcut steps aside for it.
  if (asOne !== undefined && asOne.pronoun !== true) {
    return {
      target: asOne.target,
      effects: asOne.effects,
      ...(asOne.destination === undefined ? {} : { destination: asOne.destination }),
    };
  }

  // Sentences first, then the joiners within each. A guard belongs to a whole
  // sentence — "**If it's a gear**, draw it" — and the comma split would sever
  // it from what it gates, which is why the two levels are separate.
  const sentences = body
    .split(/\.\s*/)
    .map((one) => one.replace(/^then\s+/i, '').replace(/[.]+$/, '').trim())
    .filter((one) => one.length > 0);

  if (sentences.length === 0) {
    return undefined;
  }

  const effects: GuardedEffect[] = [];
  let target: TargetSpec = NO_TARGET;
  let destination: DestinationSpec | undefined;
  let pronoun = false;
  let previous: Condition | undefined;

  for (const sentence of sentences) {
    // "**Otherwise**, recycle it" is the negation of the sentence before it,
    // which is what `Condition.not` exists for. Without the back-reference the
    // branch would be unconditional and both halves would run.
    const otherwise = /^otherwise,?\s*(.+)$/i.exec(sentence);
    let condition: Condition | undefined;
    let rest: string;
    if (otherwise !== null) {
      if (previous === undefined) {
        return undefined;
      }
      condition = { kind: 'not', condition: previous };
      rest = otherwise[1] ?? '';
    } else {
      const guarded = splitCondition(sentence);
      if (guarded === undefined) {
        return undefined;
      }
      condition = guarded.condition;
      rest = guarded.rest;
      previous = condition;
    }

    // "Play it**, ignoring its cost**, and recycle the rest": the comma before
    // "ignoring" is punctuation inside one clause, not a separator, so it is
    // normalised away before the split. A sentence holds at most one play, and
    // the phrase only ever qualifies one, so this cannot reattach it wrongly.
    const joined = rest.replace(/,\s*(ignoring (?:its|their) (?:energy )?cost)/gi, ' $1');

    // A whole-sentence match wins over the joiner split, because "and" and a
    // comma are both part of single clauses as well as separators — "play it
    // ignoring its cost" and "reveal a gear from among them and draw it" are
    // each one clause. The same reasoning the whole-body attempt above uses.
    const asOne = matchClause(joined);
    const parts =
      asOne !== undefined
        ? [joined]
        : joined
            .split(/,\s*then\s+|\s+then\s+|,\s*and\s+|\s+and\s+|,\s*/i)
            .map((part) => part.replace(/^then\s+/i, '').trim())
            .filter((part) => part.length > 0);
    if (parts.length === 0) {
      return undefined;
    }

    for (const part of parts) {
      const built = matchClause(part);
      if (built === undefined) {
        return undefined;
      }
      pronoun = pronoun || built.pronoun === true;
      // One Destination for the whole card, as `CardEffect` says; two different
      // ones would need a choice per Move, which nothing here can carry.
      if (built.destination !== undefined) {
        if (
          destination !== undefined &&
          JSON.stringify(destination) !== JSON.stringify(built.destination)
        ) {
          return undefined;
        }
        destination = built.destination;
      }
      if (built.target.kind !== 'none') {
        if (target.kind !== 'none' && JSON.stringify(target) !== JSON.stringify(built.target)) {
          return undefined;
        }
        target = built.target;
      }
      effects.push(
        ...(condition === undefined
          ? built.effects
          : built.effects.map((one) => ({ ...one, condition }))),
      );
    }
  }

  // A pronoun with nothing earlier in the run to refer back to is the "it" of
  // "When a friendly unit dies, buff **it**" — the triggering event's object.
  // `parseLine` refuses that outside a trigger, where there is no such object.
  if (pronoun && target.kind === 'none') {
    target = { kind: 'triggerObject' };
  }

  return { target, effects, ...(destination === undefined ? {} : { destination }) };
}

/**
 * Build from the *first* clause rule whose pattern consumes `part` whole.
 *
 * First match rather than first success on purpose: a rule that matches and
 * then refuses has decided the clause is one it owns and is wrong — "play a 4
 * Might Recruit unit token" is a token clause with the wrong Might, not an
 * invitation to try something else. Falling through would turn a deliberate
 * refusal into a different reading.
 */
function matchClause(part: string): (ClauseResult & { target: TargetSpec }) | undefined {
  for (const candidate of CLAUSES) {
    if (candidate.pattern.test(part)) {
      const match = part.match(candidate.pattern);
      const built = match === null ? undefined : candidate.build(match);
      // A refused target phrase refuses the clause: reading "an exhausted
      // friendly unit" as "a friendly unit" would widen the card.
      return built === undefined || built.target === undefined
        ? undefined
        : { ...built, target: built.target };
    }
  }
  return undefined;
}

/** Split a line into `"<lead>: <body>"`, respecting only the first colon. */
function splitOnColon(line: string): [string, string] | undefined {
  const index = line.indexOf(':');
  if (index === -1) {
    return undefined;
  }
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

/**
 * Parse one line of card text into what it contributes.
 *
 * `undefined` means the line was not understood, which makes the whole card
 * unparsed.
 */
function parseLine(line: string): {
  effect?: CardEffect;
  /**
   * A list because 383.2 gives an ability exactly one condition, so "When I
   * attack **or** defend, …" is two abilities sharing an effect — and a card
   * printing two trigger *sentences* is two as well.
   */
  triggered?: readonly TriggeredAbility[];
  activated?: NonNullable<CardAbilities['activated']>[number];
  costModifier?: CostModifier;
  static?: StaticAbility;
  additionalCost?: AdditionalCost;
} | undefined {
  // A timing marker is not an effect; it became `SpellCard.timing` at ingest.
  if (/^(action|reaction)$/i.test(line)) {
    return {};
  }

  // An Additional Cost (356.2) is recognised before anything else, because its
  // wording wraps a payment that would otherwise read as an effect.
  if (/as an additional cost/i.test(line)) {
    const additionalCost = parseAdditionalCost(line);
    return additionalCost === undefined ? undefined : { additionalCost };
  }

  // A Passive cost modifier is a standing statement, not something that fires,
  // so it is recognised before the ability shapes below. The trailing period
  // comes off here because these patterns match a whole sentence, where the
  // effect clauses are split out of one by `parseEffects` first.
  const sentence = line.replace(/[.]+$/, '');
  const costSplit = splitCondition(sentence);
  for (const rule of COST_MODIFIERS) {
    const match = (costSplit?.rest ?? sentence).match(rule.pattern);
    if (match === null) {
      continue;
    }
    const costModifier = rule.build(match);
    if (costModifier === undefined) {
      return undefined;
    }
    return {
      costModifier:
        costSplit?.condition === undefined
          ? costModifier
          : { ...costModifier, condition: costSplit.condition },
    };
  }

  // A Passive that modifies Might or grants a keyword (363-365). Tried before
  // the trigger split below, because "Other friendly units here have ASSAULT"
  // has no comma and would otherwise fall through to the effect grammar.
  const passive = parseStatic(line);
  if (passive !== undefined) {
    return { static: passive };
  }

  // An Activated Ability is recognised by the colon (377.1). Its cost may be
  // Energy, the exhaust symbol, or both.
  const colon = splitOnColon(line);
  if (colon !== undefined) {
    const [lead, body] = colon;
    // 377.1 puts the cost before the colon. It is an ordinary `Cost` — Energy
    // and Power (414, 416) — plus 414's exhaust symbol, so the exhaust is
    // peeled off and the rest goes through the same resource reader an Equip
    // cost uses. Anything left that is neither a number nor a Domain refuses
    // the ability: "Discard 1, Exhaust" is a real cost this model cannot state,
    // and reading it as the exhaust alone would make it free.
    // The lead is a comma-separated list, and each part is either resources or
    // a non-resource payment (356.7). The exhaust symbol can be a part of its
    // own or glued onto a resource run — "1 order exhaust" prints no comma.
    let exhaustSelf = false;
    const payments: CostPayment[] = [];
    const resourceWords: string[] = [];
    for (const raw of lead.split(',')) {
      let part = raw.trim();
      if (part === '') {
        continue;
      }
      if (/(?:^|\s)exhaust$/i.test(part)) {
        exhaustSelf = true;
        part = part.replace(/(?:^|\s)exhaust$/i, '').trim();
        if (part === '') {
          continue;
        }
      }
      const payment = parseAbilityPayment(part);
      if (payment !== undefined) {
        payments.push(payment);
        continue;
      }
      resourceWords.push(part);
    }
    const abilityCost =
      resourceWords.length === 0 ? FREE : parseResourceCost(resourceWords.join(' '));
    if (abilityCost === undefined) {
      return undefined;
    }
    // 377.1 puts the effect after the colon, but an Add ability prints its own
    // timing marker there first — "Exhaust: REACTION - ADD 1". The marker is
    // timing, not effect, so it comes off before the body is parsed.
    //
    // 812.1.b: Legion runs from the keyword to the end of the *clause*, and for
    // "Exhaust: LEGION - …" the clause is this ability's effect — so the gate is
    // peeled off here as well as at the start of a line.
    let inner = body.replace(/^(?:action|reaction)\s*[-—]\s*/i, '');
    const gated = /^legion\s*[-—>]?\s*(.+)$/i.exec(inner);
    if (gated !== null) {
      inner = gated[1] ?? '';
    }
    const effect = parseEffects(inner);
    // 377: an Activated Ability is not triggered by anything, so there is no
    // "it" for a pronoun to refer to.
    if (effect === undefined || effect.target.kind === 'triggerObject') {
      return undefined;
    }
    return {
      activated: {
        cost: abilityCost,
        exhaustSelf,
        ...(payments.length === 0 ? {} : { payments }),
        ...(gated === null ? {} : { dependsOn: { kind: 'legion' as const } }),
        effect,
      },
    };
  }

  // A Triggered Ability is a condition clause followed by its effect (383.2).
  // The split is at the *first* comma so that a condition never swallows the
  // effect, and every prefix is tried so a condition containing a comma is not
  // lost — "when you play a spell that costs 5 or more, ..." has none, but the
  // grammar should not depend on that.
  for (let comma = line.indexOf(','); comma !== -1; comma = line.indexOf(',', comma + 1)) {
    const parsed = parseCondition(line.slice(0, comma).trim());
    if (parsed === undefined) {
      continue;
    }
    let body = line.slice(comma + 1).trim();
    // 383.3.a: a leading "you may" makes performing it the controller's choice.
    const optional = /^you may\s+/i.test(body);
    if (optional) {
      body = body.replace(/^you may\s+/i, '');
    }
    // 403 with 356.7: "you may **pay 1 and exhaust me** to ready it" prices the
    // ability. Only after a "you may" — a mandatory price would have to strand
    // the game when it could not be paid, and the corpus prints none.
    let price: TriggerPrice | undefined;
    if (optional) {
      const priced = splitTriggerPrice(body);
      if (priced === undefined) {
        return undefined;
      }
      price = priced.price;
      body = priced.rest;
    }
    // "When you play me, **if you control a Poro**, buff me and draw 1."
    const split = splitCondition(body);
    if (split === undefined) {
      return undefined;
    }
    const effect = parseEffects(split.rest);
    if (effect === undefined) {
      return undefined;
    }
    const body_ = split.condition === undefined ? effect : { ...effect, condition: split.condition };
    return {
      triggered: parsed.conditions.map((condition) => ({
        condition,
        ...(optional ? { optional } : {}),
        ...(parsed.limitPerTurn === undefined ? {} : { limitPerTurn: parsed.limitPerTurn }),
        ...(price ?? {}),
        effect: body_,
      })),
    };
  }

  // "When I conquer play a Gold gear token exhausted." — the comma the split
  // relies on is simply not printed. Tried only when the line has no comma at
  // all, and only for a line that opens with the trigger wording, so the
  // ordinary path is untouched: each word boundary is offered as the split and
  // the first that yields *both* a condition and an effect wins.
  if (!line.includes(',') && /^(?:when|whenever)\s/i.test(line)) {
    for (const boundary of [...line.matchAll(/\s+/g)].map((m) => m.index ?? -1)) {
      const parsed = parseCondition(line.slice(0, boundary).trim());
      if (parsed === undefined) {
        continue;
      }
      const effect = parseEffects(line.slice(boundary).trim());
      if (effect === undefined) {
        continue;
      }
      return {
        triggered: parsed.conditions.map((condition) => ({
          condition,
          ...(parsed.limitPerTurn === undefined ? {} : { limitPerTurn: parsed.limitPerTurn }),
          effect,
        })),
      };
    }
  }

  // Otherwise the whole line is the card's own rules text — possibly gated,
  // as in "If you do, draw 1" after an Additional Cost.
  const gated = splitCondition(line);
  if (gated === undefined) {
    return undefined;
  }
  const effect = parseEffects(gated.rest);
  // A `triggerObject` target outside a Triggered Ability has nothing to refer
  // to, so the pronoun would resolve to nothing and the card would do nothing.
  if (effect === undefined || effect.target.kind === 'triggerObject') {
    return undefined;
  }
  return {
    effect: gated.condition === undefined ? effect : { ...effect, condition: gated.condition },
  };
}

/** The priced half of "you may <price> to <effect>" (403, 356.7). */
interface TriggerPrice {
  readonly cost?: Cost | undefined;
  readonly exhaustSelf?: boolean | undefined;
  readonly payments?: readonly CostPayment[] | undefined;
}

/**
 * Split "pay 1 and exhaust me to ready it" into its price and its effect.
 *
 * Anchored on " to " after a price-shaped lead, because "to" is also an
 * ordinary preposition — "move a friendly unit to base" must not be read as a
 * price of "move a friendly unit". The lead has to parse *entirely* as a
 * payment for the split to happen at all, which is what makes that safe.
 *
 * A line with no price is returned unchanged, so every caller can use this.
 */
function splitTriggerPrice(
  body: string,
): { readonly price?: TriggerPrice; readonly rest: string } | undefined {
  // Only a lead that starts like a price is considered, and only when there is
  // a " to " for it to precede. Every one of these verbs is also an ordinary
  // effect — "you may kill a gear" is not a price — so without the split there
  // is nothing here to read.
  if (!/^(?:pay|exhaust|spend|recycle|kill)\b/i.test(body) || !/ to /i.test(body)) {
    return { rest: body };
  }
  // Try each " to " from the left: the first split whose lead is entirely a
  // price is the right one, since a price cannot contain the word.
  for (let at = body.toLowerCase().indexOf(' to '); at !== -1; at = body.toLowerCase().indexOf(' to ', at + 1)) {
    const price = parseTriggerPrice(body.slice(0, at).trim());
    if (price !== undefined) {
      return { price, rest: body.slice(at + 4).trim() };
    }
  }
  // No split read as a price, so this is an ordinary effect that happens to
  // start with one of those verbs — "you may move a friendly unit to base".
  return { rest: body };
}

/** Read "1 and Fury", "exhaust me", "spend a buff", or a comma-joined mix. */
function parseTriggerPrice(lead: string): TriggerPrice | undefined {
  let exhaustSelf = false;
  let anyPower = 0;
  const payments: CostPayment[] = [];
  const resourceWords: string[] = [];

  for (const raw of lead.split(/,|\s+and\s+/i)) {
    let part = raw.trim().replace(/^pay\s+/i, '').trim();
    if (part === '') {
      continue;
    }
    // 414: "exhaust me"/"exhaust this" is the exhaust symbol spelled out.
    if (/^exhaust (?:me|this)$/i.test(part)) {
      exhaustSelf = true;
      continue;
    }
    const payment = parseAbilityPayment(part);
    if (payment !== undefined) {
      payments.push(payment);
      continue;
    }
    // 135.2.e.5: the export renders `[A]` as the word "Rune", and repeats it
    // per pip — "pay Rune Rune" is two Power of any Domain.
    part = part
      .replace(/\brunes?\b/gi, () => {
        anyPower += 1;
        return '';
      })
      .trim();
    if (part === '') {
      continue;
    }
    resourceWords.push(part);
  }

  const named = resourceWords.length === 0 ? undefined : parseResourceCost(resourceWords.join(' '));
  if (resourceWords.length > 0 && named === undefined) {
    return undefined;
  }
  const cost: Cost | undefined =
    named === undefined && anyPower === 0
      ? undefined
      : {
          energy: named?.energy ?? 0,
          power: named?.power ?? [],
          ...(anyPower === 0 ? {} : { anyPower }),
        };
  if (cost === undefined && !exhaustSelf && payments.length === 0) {
    return undefined;
  }
  return {
    ...(cost === undefined ? {} : { cost }),
    ...(exhaustSelf ? { exhaustSelf } : {}),
    ...(payments.length === 0 ? {} : { payments }),
  };
}

/**
 * Join two sentences' rules text into one `CardEffect`, or refuse.
 *
 * "Deal 4 to a unit at a battlefield. Draw 1." is one run of clauses that
 * happens to be punctuated with a full stop instead of "then", and rule 359.2.b
 * reads a card top to bottom either way — so the two become one ordered list.
 *
 * The refusals are the same ones `parseEffects` makes within a sentence, plus
 * one that only arises across sentences: a `condition` gates the *whole* clause
 * it is attached to, so two sentences gated differently cannot become one
 * effect without silently widening or narrowing that gate.
 */
function mergeEffects(a: CardEffect, b: CardEffect): CardEffect | undefined {
  if (JSON.stringify(a.condition ?? null) !== JSON.stringify(b.condition ?? null)) {
    return undefined;
  }
  // One target and one Destination for the whole card, as `CardEffect` says.
  let target = a.target;
  if (b.target.kind !== 'none') {
    if (target.kind !== 'none' && JSON.stringify(target) !== JSON.stringify(b.target)) {
      return undefined;
    }
    target = b.target;
  }
  const destination = a.destination ?? b.destination;
  if (
    a.destination !== undefined &&
    b.destination !== undefined &&
    JSON.stringify(a.destination) !== JSON.stringify(b.destination)
  ) {
    return undefined;
  }
  return {
    target,
    effects: [...a.effects, ...b.effects],
    ...(destination === undefined ? {} : { destination }),
    ...(a.condition === undefined ? {} : { condition: a.condition }),
  };
}

/**
 * Parse a line that may hold more than one sentence.
 *
 * Returns the merged contribution, or `undefined` if any sentence is outside
 * the grammar. A single-sentence line takes the fast path unchanged, so this
 * only changes behaviour where a line genuinely has a full stop in the middle.
 */
function parseSentences(line: string): ReturnType<typeof parseLine> {
  // 424 with 390.5: "Look at the top 3 … . Put 1 into your hand and recycle the
  // rest." is *one* statement whose second sentence is a Linked Ability
  // generated by the first — so it is read before the split, which would
  // otherwise merge the two as siblings and lose the link.
  const look = parseLook(line);
  if (look !== undefined) {
    return { effect: { target: NO_TARGET, effects: [look] } };
  }

  const sentences = splitSentences(line);
  if (sentences.length <= 1) {
    return parseLine(line);
  }

  // A whole-line read wins over the split, for the reason `parseEffects` tries
  // one first: some statements span sentences. "When I move, reveal the top
  // card. If it's a gear, draw it. Otherwise, recycle it." is one Triggered
  // Ability whose effect is three sentences, and splitting it makes three
  // fragments that mean nothing apart.
  const whole = parseLine(line);
  if (whole !== undefined) {
    return whole;
  }

  const merged: {
    effect?: CardEffect;
    triggered?: readonly TriggeredAbility[];
    activated?: NonNullable<CardAbilities['activated']>[number];
    costModifier?: CostModifier;
    static?: StaticAbility;
    additionalCost?: AdditionalCost;
  } = {};

  for (const sentence of sentences) {
    const parsed = parseLine(sentence);
    if (parsed === undefined) {
      return undefined;
    }
    const { effect, triggered, ...rest } = parsed;

    // Triggered Abilities accumulate: two sentences each printing one are two
    // abilities, not a conflict. Every other kind stays exclusive.
    if (triggered !== undefined) {
      merged.triggered = [...(merged.triggered ?? []), ...triggered];
    }

    // Rules text is the one kind that *concatenates* across sentences; every
    // other kind is a distinct ability, so a second one of the same kind would
    // silently lose the first and is refused instead.
    if (effect !== undefined) {
      const combined = merged.effect === undefined ? effect : mergeEffects(merged.effect, effect);
      if (combined === undefined) {
        return undefined;
      }
      merged.effect = combined;
    }
    for (const key of Object.keys(rest) as (keyof typeof rest)[]) {
      if (merged[key] !== undefined) {
        return undefined;
      }
    }
    Object.assign(merged, rest);
  }
  return merged;
}

/**
 * Split on a full stop that ends a sentence.
 *
 * Not on every period: an Activated Ability's cost and a decimal would both be
 * cut in the wrong place, so this requires whitespace and a capital after it.
 */
function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.])\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Keywords that are shorthand for an ability this model already has (801).
 *
 * Desugared here rather than added to `Keyword`, because the glossary defines
 * them *as* the expansion: 808.1.c makes Deathknell "When I die, [Effect]" and
 * 816.1.b makes Temporary a Beginning Phase trigger that kills its source.
 * Giving the engine a second way to say either is how two code paths drift.
 */
function parseKeywordAbility(line: string): TriggeredAbility | undefined {
  // 808.1.b: "[Deathknell][>] [Effect]", printed with a dash.
  const deathknell = line.match(/^deathknell\s*[-—]\s*(.+)$/i);
  if (deathknell !== null) {
    const effect = parseEffects(deathknell[1] ?? '');
    return effect === undefined
      ? undefined
      : { condition: { event: 'dies', subject: 'self' }, effect };
  }

  // 816.1.b: "At the start of this permanent's controller's Beginning Phase,
  // before scoring, kill this." The engine's Beginning Step already runs before
  // the Scoring Step, so "before scoring" needs nothing extra.
  if (/^temporary$/i.test(line)) {
    return {
      condition: { event: 'beginningPhase', subject: 'you' },
      effect: { target: SELF, effects: [{ kind: 'kill' }] },
    };
  }

  return undefined;
}

/**
 * Accelerate's Additional Cost (805.1.a), or `undefined` when it cannot be
 * stated.
 *
 * 1 Energy plus 1 Power, and 805.1.a.1 fixes that Power to one of the Unit's
 * own Domains — so a single-Domain Unit has exactly one reading and anything
 * else does not. Every Accelerate in the corpus today is single-Domain, which
 * is why this covers all of them; the refusal is here so that a future
 * multi-Domain printing is recorded as a gap rather than given an arbitrary
 * Domain.
 */
function accelerateCost(domains: readonly Domain[] | undefined): AdditionalCost | undefined {
  if (domains === undefined || domains.length !== 1) {
    return undefined;
  }
  return {
    optional: true,
    pay: { kind: 'resources', cost: { energy: 1, power: [domains[0]!] } },
  };
}

/**
 * "EQUIP Fury", "EQUIP 1, Fury", "EQUIP1, Calm", "EQUIP - Order, Kill a unit".
 *
 * The lookahead rather than `\b` is for "EQUIP1", which the export prints
 * without a space: `\b` finds no boundary between two word characters.
 */
const EQUIP = /^equip(?=[\s\d-—:]|$)\s*(?:[-—:]\s*)?(.*)$/i;

/** 137.1: the Might Bonus, printed in the card's lower right corner. */
const MIGHT_BONUS = /(?:might\s*\+(\d+)|\+(\d+)\s*might)\.?\s*$/i;

/**
 * Split a card's text at its Equip line into Rules Text and Effect Text.
 *
 * Rule 136.1 puts the Effect Text in "a separate section of text below the
 * Rules Text", and the export flattens the two into one string with no marker
 * between them — so the split has to be inferred. The Equip line is the marker
 * that works: 818 makes Equip an Activated Ability, which 724 says would be
 * Inactive if it were Effect Text, so Equip is necessarily Rules Text and
 * everything printed below it is the Effect Text it exists to deliver.
 *
 * A card with no Equip line has no Effect Text, which is 136.2.b's own reason:
 * Effect Text does nothing unless the card can be Attached.
 */
function splitEffectText(text: string): { readonly rules: string; readonly effect?: string } {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => EQUIP.test(normalize(line)));
  if (index === -1) {
    return { rules: text };
  }
  const below = lines.slice(index + 1).join('\n');
  return below.trim() === ''
    ? { rules: text }
    : { rules: lines.slice(0, index + 1).join('\n'), effect: below };
}

/**
 * Read a Gear's Effect Text into what it lends its Top-Most Card (718.3-718.4).
 *
 * Recursive rather than a second parser: 718.3 appends the Effect Text's
 * *abilities* to the Top-Most Card's Rules Text, so they are ordinary abilities
 * and the ordinary grammar reads them. What is refused is a bare effect — text
 * that would run "when the card resolves" — because an Attached card never
 * resolves and there is nothing for such a clause to mean.
 *
 * The Might Bonus is peeled off the last line only when the line does not
 * otherwise parse. 137.1 puts it in the lower right corner and the export
 * glues it onto whatever text ends up above it, so it can arrive as a line of
 * its own ("Might +0"), tacked onto a keyword ("TANK +1 Might") or run into a
 * sentence ("When I conquer, buff me.+1 Might"). Trying the unpeeled line
 * first is what keeps "give a unit +2 Might this turn" intact.
 */
function parseEffectText(
  text: string,
  card: CardFacts,
): { readonly attached: AttachedText; readonly unparsed: readonly string[] } {
  const lines = text.split('\n').filter((line) => normalize(line) !== '');
  const last = lines.length - 1;
  const bonus = last >= 0 ? normalize(lines[last]!).match(MIGHT_BONUS) : null;

  const attempts: { readonly text: string; readonly mightBonus?: number }[] = [];
  if (bonus !== null) {
    const peeled = [...lines];
    peeled[last] = normalize(lines[last]!).replace(MIGHT_BONUS, '').trim();
    attempts.push({
      text: peeled.filter((line) => line !== '').join('\n'),
      mightBonus: count(bonus[1] ?? bonus[2] ?? '') ?? 0,
    });
  }
  attempts.push({ text: lines.join('\n') });

  let fallback: { readonly attached: AttachedText; readonly unparsed: readonly string[] } | undefined;
  for (const attempt of attempts) {
    const inner = parseCardText(attempt.text, card);
    const unparsed =
      inner.effect === undefined
        ? inner.unparsed
        : // An Attached card has no resolution, so text that only makes sense
          // as one is beyond this model rather than silently dropped.
          [...inner.unparsed, attempt.text];
    const attached: AttachedText = {
      ...(attempt.mightBonus === undefined ? {} : { mightBonus: attempt.mightBonus }),
      ...(inner.keywords === undefined ? {} : { keywords: inner.keywords }),
      ...(inner.abilities === undefined ? {} : { abilities: inner.abilities }),
    };
    if (unparsed.length === 0) {
      return { attached, unparsed };
    }
    fallback ??= { attached, unparsed };
  }
  return fallback ?? { attached: {}, unparsed: [] };
}

/**
 * Parse a card's printed text.
 *
 * The card is understood only when `unparsed` comes back empty; anything in it
 * means the caller should leave the card vanilla and record the gap.
 */
export function parseCardText(text: string, card: CardFacts = {}): ParsedText {
  const unparsed: string[] = [];
  const effects: Effect[] = [];
  let target: TargetSpec = NO_TARGET;
  let destination: DestinationSpec | undefined;
  let condition: Condition | undefined;
  const triggered: TriggeredAbility[] = [];
  const activated: NonNullable<CardAbilities['activated']>[number][] = [];
  const costModifiers: CostModifier[] = [];
  const statics: StaticAbility[] = [];
  const additionalCosts: AdditionalCost[] = [];
  const keywords: Keyword[] = [];
  let reaction = false;

  // 136.1: a Gear's Effect Text sits below its Rules Text and is read into a
  // separate `AttachedText`, because 724 makes the two halves active at
  // different times and collapsing them would give an unattached Gear
  // abilities it does not have.
  const split = splitEffectText(text);
  const below = split.effect === undefined ? undefined : parseEffectText(split.effect, card);
  if (below !== undefined) {
    unparsed.push(...below.unparsed);
  }

  for (const rawLine of split.rules.split('\n')) {
    let line = normalize(rawLine);
    if (line === '') {
      continue;
    }

    // 818.1.c.2: "Equip [Cost]" is short for "[Cost]: Attach this gear to a
    // unit you control", so it is an ordinary Activated Ability whose effect is
    // the Attach — not a keyword the engine needs a rule for.
    const equip = line.match(EQUIP);
    if (equip !== null) {
      const cost = parseResourceCost(equip[1] ?? '');
      if (cost === undefined) {
        // 818.1.c.3 allows non-resource Equip costs. `ActivatedAbility.cost` is
        // Energy and Power, so "Order, Kill a friendly unit" is refused rather
        // than read as the resource half alone, which would be cheaper than
        // printed.
        unparsed.push(line);
        continue;
      }
      activated.push({
        cost,
        exhaustSelf: false,
        effect: { target: { kind: 'unit', scope: 'friendly' }, effects: [{ kind: 'attach' }] },
      });
      continue;
    }

    // 809 and 817: the two keywords that are shorthand for an ability rather
    // than for an engine rule. Expanded by `desugarKeyword`, which a static's
    // grant reads too — 801.3.a makes a granted keyword do exactly what a
    // printed one does, and two expansions would eventually disagree.
    const namedKeyword = line.match(/^([a-z-]+)(?:\s+(\d+))?$/i);
    const expansion =
      namedKeyword === null ? undefined : desugarKeyword(namedKeyword[1] ?? '', namedKeyword[2]);
    if (expansion !== undefined) {
      triggered.push(...(expansion.triggered ?? []));
      costModifiers.push(...(expansion.costModifiers ?? []));
      continue;
    }

    // 821.1.c: Weaponmaster is "When you play me, you may choose a Card you
    // control with the Equipment tag … Pay the cost of its Equip ability,
    // reduced by [A], to attach it to this unit." A Play Effect with a target
    // and a payment, all of which the model has, so it desugars too.
    if (/^weaponmaster$/i.test(line)) {
      triggered.push({
        condition: { event: 'played', subject: 'self' },
        optional: true,
        effect: {
          target: { kind: 'gear', scope: 'friendly' },
          // 135.2.e.5: the reduction is one `[A]`, which the export renders as
          // "1 Rune less" in the reminder.
          effects: [{ kind: 'equip', discountAnyPower: 1 }],
        },
      });
      continue;
    }

    // 819.1.d: Quick-Draw is "[Reaction]" plus "When you play this, attach it
    // to a unit you control" — two things the model already has, so it
    // desugars rather than becoming a keyword.
    if (/^quick-?draw$/i.test(line)) {
      reaction = true;
      triggered.push({
        condition: { event: 'played', subject: 'self' },
        effect: { target: { kind: 'unit', scope: 'friendly' }, effects: [{ kind: 'attach' }] },
      });
      continue;
    }

    // A line that only restates a rule grants nothing, so it is understood and
    // contributes nothing. See `RULES_RESTATEMENTS`.
    if (RULES_RESTATEMENTS.some((pattern) => pattern.test(line.replace(/[.]+$/, '')))) {
      continue;
    }

    // A keyword the engine is a rule for, on a line of its own.
    const keyword = MODELLED_KEYWORDS.map((rule) => ({ rule, match: line.match(rule.pattern) })).find(
      (entry) => entry.match !== null,
    );
    if (keyword?.match != null) {
      keywords.push(keyword.rule.build(keyword.match));
      continue;
    }

    // A keyword that is shorthand for an ability the model already has.
    const desugared = parseKeywordAbility(line);
    if (desugared !== undefined) {
      triggered.push(desugared);
      continue;
    }

    // 805.1.a: Accelerate is "As you play me, you may pay [1][C] as an
    // additional cost. If you do, I enter ready." Both halves exist — 356.2's
    // optional payment and an `entersReady` static gated on having made it — so
    // the keyword desugars rather than becoming a rule of its own.
    if (/^accelerate$/i.test(line)) {
      const accelerate = accelerateCost(card.domains);
      if (accelerate === undefined) {
        // 805.1.a.1 pays the Power with "a Power that matches one of the
        // domains of the unit", which is a *choice* on a multi-Domain card, and
        // 805.1.a.2 makes a domainless unit's Power any Domain at all. `Cost`
        // is a fixed Domain list and can state neither, so those are refused.
        unparsed.push(line);
        continue;
      }
      additionalCosts.push(accelerate);
      statics.push({
        affects: { who: 'self' },
        grant: { entersReady: true },
        condition: { kind: 'paidAdditionalCost' },
      });
      continue;
    }

    // 812.1.b: Legion runs from the keyword to the end of the clause, and what
    // follows is an ordinary ability that happens to be gated. So it is peeled
    // off here and reattached as a dependency once the rest has parsed.
    const legion = line.match(/^legion\s*[-—>]?\s*(.+)$/i);
    if (legion !== null) {
      line = legion[1] ?? '';
    }

    // A keyword carrying rules the engine does not model makes the card beyond
    // the grammar however well the rest of the line reads.
    if (REFUSED_KEYWORDS.test(line)) {
      unparsed.push(line);
      continue;
    }

    // A printed line can hold several sentences — "As you play me, you may
    // discard a card as an additional cost. If you do, reduce my cost by 2." is
    // one line and two statements. Split before parsing, and require every
    // sentence to parse: the all-or-nothing rule is per *card*, so a line that
    // half-reads still fails the card.
    const parsed = parseSentences(line);
    if (parsed === undefined) {
      unparsed.push(line);
      continue;
    }
    if (legion !== null) {
      // 812.1.b makes the whole clause the Legion Ability, and a passive is as
      // gateable as a triggered one. What cannot be gated is a bare effect —
      // there is nothing for the dependency to sit on — so that stays unparsed.
      if (
        parsed.triggered === undefined &&
        parsed.activated === undefined &&
        parsed.costModifier === undefined &&
        parsed.static === undefined
      ) {
        unparsed.push(line);
        continue;
      }
      if (parsed.triggered !== undefined) {
        triggered.push(
          ...parsed.triggered.map((one) => ({ ...one, dependsOn: { kind: 'legion' as const } })),
        );
      }
      if (parsed.activated !== undefined) {
        activated.push({ ...parsed.activated, dependsOn: { kind: 'legion' } });
      }
      if (parsed.costModifier !== undefined) {
        costModifiers.push({ ...parsed.costModifier, dependsOn: { kind: 'legion' } });
      }
      if (parsed.static !== undefined) {
        statics.push({ ...parsed.static, dependsOn: { kind: 'legion' } });
      }
      continue;
    }
    if (parsed.effect !== undefined) {
      if (parsed.effect.target.kind !== 'none') {
        if (target.kind !== 'none' && JSON.stringify(target) !== JSON.stringify(parsed.effect.target)) {
          unparsed.push(line);
          continue;
        }
        target = parsed.effect.target;
      }
      // `CardEffect` carries one condition for the whole card, so two lines
      // under *different* conditions cannot be merged — doing it anyway would
      // make a conditional effect unconditional, which is strictly stronger
      // than the printed card. Refuse instead.
      if (JSON.stringify(condition) !== JSON.stringify(parsed.effect.condition)) {
        if (effects.length > 0 || condition !== undefined) {
          unparsed.push(line);
          continue;
        }
        condition = parsed.effect.condition;
      }
      // 449.1's Destination rides with the effects, and `CardEffect` carries
      // one for the whole card — so two lines naming different ones cannot be
      // merged any more than two conditions can.
      if (parsed.effect.destination !== undefined) {
        if (
          destination !== undefined &&
          JSON.stringify(destination) !== JSON.stringify(parsed.effect.destination)
        ) {
          unparsed.push(line);
          continue;
        }
        destination = parsed.effect.destination;
      }
      effects.push(...parsed.effect.effects);
    }
    if (parsed.triggered !== undefined) {
      triggered.push(...parsed.triggered);
    }
    if (parsed.activated !== undefined) {
      activated.push(parsed.activated);
    }
    if (parsed.costModifier !== undefined) {
      costModifiers.push(parsed.costModifier);
    }
    if (parsed.static !== undefined) {
      statics.push(parsed.static);
    }
    if (parsed.additionalCost !== undefined) {
      additionalCosts.push(parsed.additionalCost);
    }
  }

  const abilities: CardAbilities = {
    ...(triggered.length > 0 ? { triggered } : {}),
    ...(activated.length > 0 ? { activated } : {}),
    ...(costModifiers.length > 0 ? { costModifiers } : {}),
    ...(statics.length > 0 ? { statics } : {}),
    ...(additionalCosts.length > 0 ? { additionalCosts } : {}),
  };

  return {
    ...(effects.length > 0
      ? {
          effect: {
            target,
            effects,
            ...(destination === undefined ? {} : { destination }),
            ...(condition === undefined ? {} : { condition }),
          },
        }
      : {}),
    ...(Object.keys(abilities).length > 0 ? { abilities } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(below === undefined || Object.keys(below.attached).length === 0
      ? {}
      : { attached: below.attached }),
    ...(reaction ? { reaction } : {}),
    unparsed,
  };
}
