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
  type CardAbilities,
  type Domain,
  type CardEffect,
  type Effect,
  type TargetSpec,
  type TriggerCondition,
  type TriggeredAbility,
} from '@riftbound/cards';

export interface ParsedText {
  /** Rules text that runs when the card itself resolves (359.2.b, 359.3.d). */
  readonly effect?: CardEffect | undefined;
  readonly abilities?: CardAbilities | undefined;
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
 * Keywords with their own rules (700s), none of which the engine models.
 *
 * Listed so a card carrying one is *recognised* as beyond the grammar rather
 * than silently parsed as though the keyword were absent — a Tank that forgets
 * it is a Tank is a wrong card, not a simpler one.
 */
const KEYWORDS =
  /\b(tank|shield|assault|accelerate|deflect|hidden|ganking|weaponmaster|legion|temporary|mighty|equip|repeat|vision|deathknell)\b/i;

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

/** Trigger conditions the grammar recognises, in the wording the cards use. */
const CONDITIONS: readonly { readonly pattern: RegExp; readonly condition: TriggerCondition }[] = [
  { pattern: /^when you play me$/i, condition: { kind: 'played' } },
  { pattern: /^when you play this$/i, condition: { kind: 'played' } },
  { pattern: /^when i die$/i, condition: { kind: 'dies' } },
  { pattern: /^when i'm killed$/i, condition: { kind: 'dies' } },
  { pattern: /^when you conquer(?: here)?$/i, condition: { kind: 'conquer' } },
  { pattern: /^at the end of your turn$/i, condition: { kind: 'endOfTurn' } },
  { pattern: /^at the start of your beginning phase$/i, condition: { kind: 'beginningPhase' } },
];

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
  const comma = line.indexOf(',');
  if (comma !== -1) {
    const head = line.slice(0, comma).trim();
    let body = line.slice(comma + 1).trim();
    const condition = CONDITIONS.find((entry) => entry.pattern.test(head))?.condition;
    if (condition !== undefined) {
      // 383.3.a: a leading "you may" makes performing it the controller's choice.
      const optional = /^you may\s+/i.test(body);
      if (optional) {
        body = body.replace(/^you may\s+/i, '');
      }
      const effect = parseEffects(body);
      if (effect === undefined) {
        return undefined;
      }
      return { triggered: { condition, ...(optional ? { optional } : {}), effect } };
    }
  }

  // Otherwise the whole line is the card's own rules text.
  const effect = parseEffects(line);
  return effect === undefined ? undefined : { effect };
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

  for (const rawLine of text.split('\n')) {
    const line = normalize(rawLine);
    if (line === '') {
      continue;
    }

    // A keyword carries rules the engine does not model, so a card with one is
    // beyond the grammar however well the rest of the line reads.
    if (KEYWORDS.test(line)) {
      unparsed.push(line);
      continue;
    }

    const parsed = parseLine(line);
    if (parsed === undefined) {
      unparsed.push(line);
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
    unparsed,
  };
}
