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
  type CardAbilities,
  type Domain,
  type CardEffect,
  type Effect,
  type Keyword,
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
} | undefined {
  // A timing marker is not an effect; it became `SpellCard.timing` at ingest.
  if (/^(action|reaction)$/i.test(line)) {
    return {};
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
    const effect = parseEffects(body);
    if (effect === undefined) {
      return undefined;
    }
    return {
      triggered: {
        condition: parsed.condition,
        ...(optional ? { optional } : {}),
        ...(parsed.limitPerTurn === undefined ? {} : { limitPerTurn: parsed.limitPerTurn }),
        effect,
      },
    };
  }

  // Otherwise the whole line is the card's own rules text.
  const effect = parseEffects(line);
  return effect === undefined ? undefined : { effect };
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
  const triggered: TriggeredAbility[] = [];
  const activated: NonNullable<CardAbilities['activated']>[number][] = [];
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

    const parsed = parseLine(line);
    if (parsed === undefined) {
      unparsed.push(line);
      continue;
    }
    if (legion !== null) {
      // 812 gates an *ability*. A card whose Legion clause is its own rules text
      // rather than an ability — "LEGION - I cost 2 less" — has nothing to hang
      // the dependency on, so it stays unparsed.
      if (parsed.triggered === undefined && parsed.activated === undefined) {
        unparsed.push(line);
        continue;
      }
      if (parsed.triggered !== undefined) {
        triggered.push({ ...parsed.triggered, dependsOn: { kind: 'legion' } });
      }
      if (parsed.activated !== undefined) {
        activated.push({ ...parsed.activated, dependsOn: { kind: 'legion' } });
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
      effects.push(...parsed.effect.effects);
    }
    if (parsed.triggered !== undefined) {
      triggered.push(parsed.triggered);
    }
    if (parsed.activated !== undefined) {
      activated.push(parsed.activated);
    }
  }

  const abilities: CardAbilities = {
    ...(triggered.length > 0 ? { triggered } : {}),
    ...(activated.length > 0 ? { activated } : {}),
  };

  return {
    ...(effects.length > 0 ? { effect: { target, effects } } : {}),
    ...(Object.keys(abilities).length > 0 ? { abilities } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    unparsed,
  };
}
