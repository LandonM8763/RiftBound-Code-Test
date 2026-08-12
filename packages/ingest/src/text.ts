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
  type CardAbilities,
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
  /** Clauses the grammar does not cover. Empty means the card is understood. */
  readonly unparsed: readonly string[];
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
 * `mighty` is here rather than in `UNMODELLED_KEYWORDS` because it is a *state*
 * cards refer to ("when one of your units becomes MIGHTY") rather than a
 * keyword ability in the glossary.
 */
const REFUSED_KEYWORDS = new RegExp(
  `\\b(${[...Object.keys(UNMODELLED_KEYWORDS), 'mighty'].join('|')})\\b`,
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
  { pattern: /^tank$/i, build: () => ({ kind: 'tank' }) },
  { pattern: /^backline$/i, build: () => ({ kind: 'backline' }) },
  { pattern: /^ganking$/i, build: () => ({ kind: 'ganking' }) },
];

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
    pattern: /^add (fury|calm|mind|body|chaos|order)$/i,
    build: (m) => {
      const domain = (m[1] ?? '').toLowerCase() as Domain;
      return { effects: [{ kind: 'addPower', domain, count: 1 }], target: NO_TARGET };
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

  const whileClause = text.match(/^while i'?m (buffed|at a battlefield),\s*(.+)$/i);
  if (whileClause !== null) {
    condition = /buffed/i.test(whileClause[1] ?? '')
      ? { kind: 'buffed' }
      : { kind: 'atBattlefield' };
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

  // "<scope> have/has <+N Might | KEYWORD…>". "an additional +1 Might" is the
  // same statement with a word of emphasis in it.
  const have = text.match(/^(.+?) (?:have|has) (?:an additional )?(.+)$/i);
  if (have === null) {
    return undefined;
  }
  const scope = STATIC_SCOPES.find((entry) => entry.pattern.test((have[1] ?? '').trim()))?.scope;
  if (scope === undefined) {
    return undefined;
  }

  const body = (have[2] ?? '').trim();
  const might = body.match(/^([+-]\d+) might$/i);
  if (might !== null) {
    const amount = Number.parseInt(might[1] ?? '', 10);
    return Number.isNaN(amount)
      ? undefined
      : { affects: scope, grant: { might: amount }, ...(condition ? { condition } : {}) };
  }

  const keywords = grantedKeywords(body);
  return keywords === undefined
    ? undefined
    : { affects: scope, grant: { keywords }, ...(condition ? { condition } : {}) };
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
    // Two sentences of the same kind on one line would silently lose one, so
    // that is a refusal rather than a merge.
    for (const key of Object.keys(parsed) as (keyof typeof merged)[]) {
      if (merged[key] !== undefined) {
        return undefined;
      }
    }
    Object.assign(merged, parsed);
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
 * Parse a card's printed text.
 *
 * The card is understood only when `unparsed` comes back empty; anything in it
 * means the caller should leave the card vanilla and record the gap.
 */
export function parseCardText(text: string): ParsedText {
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

  for (const rawLine of text.split('\n')) {
    let line = normalize(rawLine);
    if (line === '') {
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
    unparsed,
  };
}
