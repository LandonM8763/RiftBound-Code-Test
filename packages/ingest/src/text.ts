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
  type AttachedText,
  type CardAbilities,
  type CardType,
  type Cost,
  type Count,
  type Domain,
  type CardEffect,
  type AdditionalCost,
  type CostModifier,
  type CostPayment,
  type Effect,
  type Keyword,
  type StaticAbility,
  type Condition,
  type StaticScope,
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
];

/**
 * A modelled keyword by name, for the "give a unit X this turn" grant.
 *
 * Reuses `MODELLED_KEYWORDS` rather than a second table, so a keyword the
 * engine does not implement cannot be granted by an effect either — 801.3.a
 * makes a granted keyword do exactly what a printed one does, and granting one
 * the engine ignores would be the same wrong card as printing it.
 */
function keywordNamed(name: string, value: string | undefined): Keyword | undefined {
  const line = value === undefined ? name : `${name} ${value}`;
  for (const rule of MODELLED_KEYWORDS) {
    const match = line.match(rule.pattern);
    if (match !== null) {
      return rule.build(match);
    }
  }
  return undefined;
}

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
  readonly build: (match: RegExpMatchArray) => { effects: Effect[]; target: TargetSpec } | undefined;
}

const SELF: TargetSpec = { kind: 'self' };
const UNIT_ANY: TargetSpec = { kind: 'unit', scope: 'any' };
const UNIT_FRIENDLY: TargetSpec = { kind: 'unit', scope: 'friendly' };
const UNIT_ENEMY: TargetSpec = { kind: 'unit', scope: 'enemy' };

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
    pattern: /^deal (\d+) to an? (friendly |enemy )?unit(?: at a battlefield)?$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      if (n === undefined) return undefined;
      const scope = (m[2] ?? '').trim().toLowerCase();
      const atBattlefield = /at a battlefield$/i.test(m[0]);
      const base: TargetSpec =
        scope === 'friendly' ? UNIT_FRIENDLY : scope === 'enemy' ? UNIT_ENEMY : UNIT_ANY;
      return {
        effects: [{ kind: 'dealDamage', amount: n }],
        target: atBattlefield ? { ...base, atBattlefield: true } : base,
      };
    },
  },
  {
    pattern: /^give an? (friendly |enemy )?unit \+(\d+) might this turn$/i,
    build: (m) => {
      const n = count(m[2] ?? '');
      if (n === undefined) return undefined;
      const scope = (m[1] ?? '').trim().toLowerCase();
      return {
        effects: [{ kind: 'giveMight', amount: n }],
        target: scope === 'friendly' ? UNIT_FRIENDLY : scope === 'enemy' ? UNIT_ENEMY : UNIT_ANY,
      };
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
      /^play (?:(a|an|one|two|three|four|five|\d+) )?(ready )?(\d+) might ([a-z' ]+?) (unit|gear) tokens?(?: with ([a-z]+))?(?: (here|(?:in|at|into|to) (?:your |their )?base))?$/i,
    build: (m) => {
      const n = m[1] === undefined ? 1 : count(m[1] === 'a' || m[1] === 'an' ? '1' : m[1]);
      const might = count(m[3] ?? '');
      const found = tokenByName(m[4] ?? '');
      if (n === undefined || might === undefined || found === undefined) {
        return undefined;
      }
      // 185.2.d: a token follows the rules for its type, so the printed type
      // has to be the one rule 187 gives it.
      if (found.spec.type !== (m[5] ?? '').toLowerCase()) {
        return undefined;
      }
      if (tokenMight(found.spec) !== might) {
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
      return {
        effects: [
          {
            kind: 'createToken',
            token: found.key,
            count: n,
            where,
            // 184.1: the effect may say it enters ready, against the default.
            ...(m[2] === undefined ? {} : { ready: true }),
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
    pattern: /^give (?:an? (friendly |enemy )?unit|(me)) ([a-z]+)(?:\s+(\d+))? this turn$/i,
    build: (m) => {
      const keyword = keywordNamed(m[3] ?? '', m[4]);
      if (keyword === undefined) {
        return undefined;
      }
      const scope = (m[1] ?? '').trim().toLowerCase();
      return {
        effects: [{ kind: 'grantKeyword', keyword }],
        target:
          m[2] !== undefined
            ? SELF
            : scope === 'friendly'
              ? UNIT_FRIENDLY
              : scope === 'enemy'
                ? UNIT_ENEMY
                : UNIT_ANY,
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
    pattern: /^return an? (friendly |enemy )?(unit|gear)( at a battlefield)? to (?:its|their) owner'?s? hand$/i,
    build: (m) => {
      // 355.9.a.1 makes a Unit target a Game Object on the Board. Gear is a
      // Permanent too, but `TargetSpec` only enumerates Units, so a Gear bounce
      // has nothing to choose from and is refused rather than silently missing.
      if ((m[2] ?? '').toLowerCase() !== 'unit') {
        return undefined;
      }
      const scope = (m[1] ?? '').trim().toLowerCase();
      const base: TargetSpec =
        scope === 'friendly' ? UNIT_FRIENDLY : scope === 'enemy' ? UNIT_ENEMY : UNIT_ANY;
      return {
        effects: [{ kind: 'toHand' }],
        target: m[3] === undefined ? base : { ...base, atBattlefield: true },
      };
    },
  },
  {
    /** "Return me to my owner's hand" — the same effect, already-determined target. */
    pattern: /^return me to my owner'?s? hand$/i,
    build: () => ({ effects: [{ kind: 'toHand' }], target: SELF }),
  },
  {
    /**
     * "Return a unit from your trash to your hand" — a retrieval.
     *
     * The same `toHand` effect as the bounce above; only the target differs,
     * which is the whole reason both are one primitive.
     */
    pattern: /^return an? (unit|spell|gear|rune) from your trash to your hand$/i,
    build: (m) => ({
      effects: [{ kind: 'toHand' }],
      target: { kind: 'trashCard', cardType: (m[1] ?? 'unit').toLowerCase() as CardType },
    }),
  },
  {
    pattern: /^kill an? (friendly |enemy )?unit(?: at a battlefield)?$/i,
    build: (m) => {
      const scope = (m[1] ?? '').trim().toLowerCase();
      const base: TargetSpec =
        scope === 'friendly' ? UNIT_FRIENDLY : scope === 'enemy' ? UNIT_ENEMY : UNIT_ANY;
      const atBattlefield = /at a battlefield$/i.test(m[0]);
      return {
        effects: [{ kind: 'kill' }],
        target: atBattlefield ? { ...base, atBattlefield: true } : base,
      };
    },
  },
  {
    pattern: /^ready an? (friendly |enemy )?unit$/i,
    build: (m) => {
      const scope = (m[1] ?? '').trim().toLowerCase();
      return {
        effects: [{ kind: 'ready' }],
        target: scope === 'friendly' ? UNIT_FRIENDLY : scope === 'enemy' ? UNIT_ENEMY : UNIT_ANY,
      };
    },
  },
  {
    pattern: /^buff an? (friendly |enemy )?unit$/i,
    build: (m) => {
      const scope = (m[1] ?? '').trim().toLowerCase();
      return {
        effects: [{ kind: 'buff' }],
        target: scope === 'friendly' ? UNIT_FRIENDLY : scope === 'enemy' ? UNIT_ENEMY : UNIT_ANY,
      };
    },
  },
  {
    pattern: /^heal an? (friendly |enemy )?unit$/i,
    build: (m) => {
      const scope = (m[1] ?? '').trim().toLowerCase();
      return {
        effects: [{ kind: 'heal' }],
        target: scope === 'friendly' ? UNIT_FRIENDLY : scope === 'enemy' ? UNIT_ENEMY : UNIT_ANY,
      };
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
    pattern: /^give me \+(\d+) might this turn$/i,
    build: (m) => {
      const n = count(m[1] ?? '');
      return n === undefined
        ? undefined
        : { effects: [{ kind: 'giveMight', amount: n }], target: SELF };
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

  // Combat (466.3).
  { pattern: /^i win (?:a )?combat$/i, build: () => ({ event: 'winCombat', subject: 'self' }) },
  { pattern: /^you win (?:a )?combat$/i, build: () => ({ event: 'winCombat', subject: 'you' }) },

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
];

/** The keyword list a static may grant, e.g. "ASSAULT and GANKING". */
function grantedKeywords(text: string): readonly Keyword[] | undefined {
  const granted: Keyword[] = [];
  for (const part of text.split(/\s+and\s+|,\s*/i)) {
    const token = part.trim();
    if (token === '') {
      continue;
    }
    const rule = MODELLED_KEYWORDS.map((entry) => ({ entry, match: token.match(entry.pattern) })).find(
      (entry) => entry.match !== null,
    );
    if (rule?.match == null) {
      return undefined;
    }
    granted.push(rule.entry.build(rule.match));
  }
  return granted.length === 0 ? undefined : granted;
}

/** Read one static clause, or `undefined` if it is outside the grammar. */
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
    const predicate = (whileClause[1] ?? '').trim();
    const source = predicate.match(/^i'?m (buffed|at a battlefield)$/i);
    condition =
      source !== null
        ? /buffed/i.test(source[1] ?? '')
          ? { kind: 'buffed' }
          : { kind: 'atBattlefield' }
        : parseStatePredicate(predicate);
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

  // "<scope> enter(s) ready" (359.2.c is what this replaces).
  const ready = text.match(/^(.+?) enters? ready$/i);
  if (ready !== null) {
    const scope = STATIC_SCOPES.find((entry) => entry.pattern.test((ready[1] ?? '').trim()))?.scope;
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
    const scope =
      /^me$/i.test(who)
        ? ({ who: 'self' } as StaticScope)
        : STATIC_SCOPES.find((entry) => entry.pattern.test(who))?.scope;
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

  // "<scope> have/has <+N Might | KEYWORD…>". "an additional +1 Might" is the
  // same statement with a word of emphasis in it.
  const have = text.match(/^(.+?) (?:have|has|gets?) (?:an additional )?(.+)$/i);
  if (have === null) {
    return undefined;
  }
  const scope = STATIC_SCOPES.find((entry) => entry.pattern.test((have[1] ?? '').trim()))?.scope;
  if (scope === undefined) {
    return undefined;
  }

  let body = (have[2] ?? '').trim();

  // "I have +1 Might **for each friendly gear**", "I have ASSAULT **equal to
  // the number of enemy units here**". The count multiplies whatever the grant
  // gives, so it is peeled off first and the rest parses as an ordinary grant.
  let per: Count | undefined;
  const dynamic = body.match(/^(.+?) (?:for each|equal to) (.+)$/i);
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

  const might = body.match(/^([+-]\d+) might$/i);
  if (might !== null) {
    const amount = Number.parseInt(might[1] ?? '', 10);
    return Number.isNaN(amount)
      ? undefined
      : {
          affects: scope,
          grant: { might: amount, ...(per === undefined ? {} : { per }) },
          ...(condition ? { condition } : {}),
        };
  }

  const keywords = grantedKeywords(body);
  return keywords === undefined
    ? undefined
    : {
        affects: scope,
        grant: { keywords, ...(per === undefined ? {} : { per }) },
        ...(condition ? { condition } : {}),
      };
}

/** A trigger condition together with any per-turn limit its wording implies. */
interface ParsedCondition {
  readonly condition: TriggerCondition;
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
      : { condition: inner.condition, limitPerTurn: 1 };
  }

  const when = phrase.match(/^(?:when|whenever)\s+(.+)$/i);
  if (when === null) {
    const phase = PHASE_CONDITIONS.find((entry) => entry.pattern.test(phrase));
    return phase === undefined ? undefined : { condition: phase.condition };
  }

  const body = when[1] ?? '';
  for (const rule of CONDITIONS) {
    const match = body.match(rule.pattern);
    if (match === null) {
      continue;
    }
    const condition = rule.build(match);
    return condition === undefined ? undefined : { condition };
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
  const parts = body
    .split(/,\s*then\s+|\s+then\s+|\.\s*|,\s*and\s+|\s+and\s+|,\s*/i)
    .map((part) => part.replace(/[.]+$/, '').trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    return undefined;
  }

  const effects: Effect[] = [];
  let target: TargetSpec = NO_TARGET;

  for (const part of parts) {
    const rule = CLAUSES.map((candidate) => ({
      candidate,
      match: part.match(candidate.pattern),
    })).find((entry) => entry.match !== null);

    if (rule === undefined || rule.match === null) {
      return undefined;
    }
    const built = rule.candidate.build(rule.match);
    if (built === undefined) {
      return undefined;
    }
    if (built.target.kind !== 'none') {
      if (target.kind !== 'none' && JSON.stringify(target) !== JSON.stringify(built.target)) {
        return undefined;
      }
      target = built.target;
    }
    effects.push(...built.effects);
  }

  return { target, effects };
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
  triggered?: TriggeredAbility;
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
    const costMatch = lead.match(/^(?:(\d+)\s*,\s*)?exhaust$/i) ?? lead.match(/^(\d+)$/);
    if (costMatch === null) {
      return undefined;
    }
    // 377.1 puts the effect after the colon, but an Add ability prints its own
    // timing marker there first — "Exhaust: REACTION - ADD 1". The marker is
    // timing, not effect, so it comes off before the body is parsed.
    const effect = parseEffects(body.replace(/^(?:action|reaction)\s*[-—]\s*/i, ''));
    if (effect === undefined) {
      return undefined;
    }
    const energy = count(costMatch[1] ?? '0') ?? 0;
    return {
      activated: {
        cost: { energy, power: [] },
        exhaustSelf: /exhaust/i.test(lead),
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
    // "When you play me, **if you control a Poro**, buff me and draw 1."
    const split = splitCondition(body);
    if (split === undefined) {
      return undefined;
    }
    const effect = parseEffects(split.rest);
    if (effect === undefined) {
      return undefined;
    }
    return {
      triggered: {
        condition: parsed.condition,
        ...(optional ? { optional } : {}),
        ...(parsed.limitPerTurn === undefined ? {} : { limitPerTurn: parsed.limitPerTurn }),
        effect: split.condition === undefined ? effect : { ...effect, condition: split.condition },
      },
    };
  }

  // Otherwise the whole line is the card's own rules text — possibly gated,
  // as in "If you do, draw 1" after an Additional Cost.
  const gated = splitCondition(line);
  if (gated === undefined) {
    return undefined;
  }
  const effect = parseEffects(gated.rest);
  if (effect === undefined) {
    return undefined;
  }
  return {
    effect: gated.condition === undefined ? effect : { ...effect, condition: gated.condition },
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
  const sentences = splitSentences(line);
  if (sentences.length <= 1) {
    return parseLine(line);
  }

  const merged: {
    effect?: CardEffect;
    triggered?: TriggeredAbility;
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
    const { effect, ...rest } = parsed;

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

    // 809.1.c: Deflect X is "Spells and abilities an opponent controls that
    // target me cost X more Power to play as an additional cost for each time
    // they choose me", and 809.1.c.1 makes that Power any Domain — which `[A]`
    // now states. A Passive cost increase, gated on the play choosing this
    // Game Object.
    const deflect = line.match(/^deflect(?:\s+(\d+))?$/i);
    if (deflect !== null) {
      // 809.1.b.3: an omitted value is 1.
      costModifiers.push({
        applies: {
          // 809.1.d puts it on "Spells and Abilities", both of which pay.
          types: ['unit', 'spell', 'gear', 'ability'],
          // "an opponent controls" — `any` would tax the Deflecting player's
          // own spells for choosing their own Unit.
          scope: 'opponent',
          choosesSource: true,
        },
        change: { kind: 'increase', anyPower: count(deflect[1] ?? '1') ?? 1 },
      });
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
        triggered.push({ ...parsed.triggered, dependsOn: { kind: 'legion' } });
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
      effects.push(...parsed.effect.effects);
    }
    if (parsed.triggered !== undefined) {
      triggered.push(parsed.triggered);
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
      ? { effect: { target, effects, ...(condition === undefined ? {} : { condition }) } }
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
