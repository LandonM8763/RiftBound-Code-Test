/**
 * Hand-authored effects for cards the grammar cannot read.
 *
 * **Why this exists, and why it is not a violation of "card data is generated".**
 * That convention exists so nobody hand-patches a *printed field* — a cost, a
 * Might, a Domain — and quietly desynchronises the data from the source. This
 * file touches none of those. Ingest still owns every printed field; an entry
 * here supplies only the effect model for a card whose wording the parser
 * cannot parse, and it is committed source rather than an edit to generated
 * output.
 *
 * It is needed because of a measured fact about the corpus: of the 544 distinct
 * unparsed clause shapes, **459 appear on exactly one card**. A parser rule per
 * card buys one card, so past a point the honest way to model the tail is to
 * write the model down directly. Rule 002 makes card text supersede the rules,
 * so a card the engine plays as vanilla is a card played wrong — and for these
 * there is no shared grammar left to find.
 *
 * ## The safety property
 *
 * Every entry records the **printed text it was authored against**. At ingest
 * the recorded text is compared with the card's actual text, and a mismatch
 * *refuses* the entry rather than applying it. That is what stops an authored
 * effect silently outliving an errata or a data correction: the card falls back
 * to vanilla and the gap is reported, exactly as an unparsed card is today.
 *
 * Keyed by **name**, not by collector number. Rule 103.2.b.2 makes same-named
 * cards the same card, the ingest keeps one printing per name, and the export
 * reuses collector numbers across printings — so the name is the stable key and
 * the id is not.
 */
import type { AttachedText, CardAbilities, CardEffect, Keyword } from '@riftbound/cards';

/** One card's hand-authored model, with the text it was written against. */
export interface AuthoredCard {
  /**
   * The card's printed text at the time this entry was written, normalised the
   * way `parseCardText` sees it (reminders stripped, brackets removed,
   * whitespace collapsed).
   *
   * Compared at ingest; a mismatch refuses the entry. Storing the text rather
   * than a hash keeps the diff readable when a card does change.
   */
  readonly text: string;
  /** Rules text that runs when the card itself resolves (359.2.b, 359.3.d). */
  readonly effect?: CardEffect | undefined;
  readonly abilities?: CardAbilities | undefined;
  /**
   * Printed keywords (800-828), for a keyword *line* the grammar cannot read.
   *
   * "ASSAULT 2, SHIELD 2" is two keywords the model states perfectly and the
   * grammar splits wrongly, so the fix belongs here rather than in a regex.
   * Same all-or-nothing rule as everything else: an authored entry replaces the
   * card's whole reading, keywords included.
   */
  readonly keywords?: readonly Keyword[] | undefined;
  /**
   * A Gear's Effect Text (136.1, 718.3) — what it lends its Top-Most Card.
   *
   * Its own field for the same reason `GearCard.attached` is: 718.2 and 724
   * make a card's two halves active at different times, so collapsing them
   * would give an unattached Gear abilities it does not have.
   */
  readonly attached?: AttachedText | undefined;
  /** Why this card needs authoring rather than a parser rule. */
  readonly note?: string | undefined;
}

/**
 * The authored corpus.
 *
 * Deliberately a plain table rather than generated: each entry is a reading of
 * one card's printed text, and the reading is the work. Entries are added in
 * batches and every one is covered by the round-trip check in `authored.test.ts`.
 */
export const AUTHORED_CARDS: Readonly<Record<string, AuthoredCard>> = {
  // 807.2 / 814.2: two printed keywords on one line. The model states this
  // exactly; only the keyword-line grammar, which reads one keyword per line,
  // cannot — so the reading belongs here rather than in a looser regex that
  // would start splitting real sentences.
  'Garen - Rugged': {
    text: 'ASSAULT 2, SHIELD 2',
    keywords: [
      { kind: 'assault', value: 2 },
      { kind: 'shield', value: 2 },
    ],
    note: 'Two keywords on one printed line (807.2, 814.2).',
  },

  // Three trigger conditions, one effect (383.2). Each is its own ability:
  // `TriggerCondition` is one event, and a card that fires on three writes
  // three. The grammar has no rule for a condition list.
  Scrapheap: {
    text: 'When this is played, discarded, or killed, draw 1.',
    abilities: {
      triggered: [
        {
          condition: { event: 'played', subject: 'self' },
          effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
        },
        {
          condition: { event: 'discard', subject: 'self' },
          effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
        },
        {
          condition: { event: 'dies', subject: 'self' },
          effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
        },
      ],
    },
    note: 'Three conditions sharing one effect; TriggerCondition holds one event each.',
  },

  // 383.1's `minEnergy` filter states this; the effect clause is a typo in the
  // export ("draw a 1") that no grammar should be taught to read.
  'Lux - Lady of Luminosity': {
    text: 'When you play a spell that costs 5 or more, draw a 1.',
    abilities: {
      triggered: [
        {
          condition: {
            event: 'played',
            subject: 'you',
            filter: { cardType: 'spell', minEnergy: 5 },
          },
          effect: { target: { kind: 'none' }, effects: [{ kind: 'draw', count: 1 }] },
        },
      ],
    },
    note: 'Printed "draw a 1" — a typo in the source, not a wording to parse.',
  },

  // Guarded steps (see `GuardedEffect`): two branches on one check, which is
  // what "Otherwise" means. The parser has no grammar for "Choose X. If Y, A.
  // Otherwise, B." and teaching it one buys these three cards and nothing else.
  'Solari Chief': {
    text: 'When you play me, choose an enemy unit. If it is stunned, kill it. Otherwise, stun it.',
    abilities: {
      triggered: [
        {
          condition: { event: 'played', subject: 'self' },
          effect: {
            target: { kind: 'unit', scope: 'enemy' },
            effects: [
              { kind: 'kill', condition: { kind: 'targetIs', stunned: true } },
              {
                kind: 'stun',
                condition: { kind: 'not', condition: { kind: 'targetIs', stunned: true } },
              },
            ],
          },
        },
      ],
    },
    note: '"Otherwise" as the negation of the branch above it.',
  },

  // "If it was an enemy unit" is asked *before* the Kill, which is what
  // `GuardedEffect` guarantees — after it, the phrase would have nothing to
  // read. The source prints "BGold", a typo for the Gold token of 187.5.
  'Blood Money': {
    text:
      'ACTION Kill a unit at a battlefield with 2 Might or less. If it was an enemy unit, play a ' +
      'Gold gear token exhausted. If it was a friendly unit, play two BGold gear tokens exhausted.',
    effect: {
      target: { kind: 'unit', scope: 'any', atBattlefield: true, maxMight: 2 },
      effects: [
        { kind: 'kill' },
        {
          kind: 'createToken',
          token: 'gold',
          count: 1,
          where: 'base',
          ready: false,
          condition: { kind: 'targetIs', scope: 'enemy' },
        },
        {
          kind: 'createToken',
          token: 'gold',
          count: 2,
          where: 'base',
          ready: false,
          condition: { kind: 'targetIs', scope: 'friendly' },
        },
      ],
    },
    note: 'Two guards read before the Kill; the source prints "BGold" for Gold.',
  },

  // "Deal 4 to it instead" is the same check twice with opposite signs, which
  // is exactly two guarded steps — no replacement machinery needed.
  'Sudden Storm': {
    text: "HIDDEN ACTION Deal 2 to a unit at a battlefield. If it's attacking, deal 4 to it instead.",
    effect: {
      target: { kind: 'unit', scope: 'any', atBattlefield: true },
      effects: [
        {
          kind: 'dealDamage',
          amount: 2,
          condition: { kind: 'not', condition: { kind: 'targetIs', role: 'attacker' } },
        },
        { kind: 'dealDamage', amount: 4, condition: { kind: 'targetIs', role: 'attacker' } },
      ],
    },
    note: '"instead" as two mutually exclusive guards rather than a replacement.',
  },

  // 818.1.c.3 allows a non-resource Equip cost, and the parser refuses one
  // rather than reading the resource half alone — which would be cheaper than
  // printed. Written out here, the cost is exactly what 356.7 already states.
  // The trailing "+4 Might" is 137.1's Might Bonus, the Effect Text's half.
  'Blade of the Ruined King': {
    text: 'EQUIP — Order, Kill a friendly unit +4 Might',
    abilities: {
      activated: [
        {
          cost: { energy: 0, power: ['order'] },
          exhaustSelf: false,
          payments: [{ kind: 'kill', what: 'unit' }],
          effect: { target: { kind: 'unit', scope: 'friendly' }, effects: [{ kind: 'attach' }] },
        },
      ],
    },
    attached: { mightBonus: 4 },
    note: 'Equip with a non-resource cost (818.1.c.3, 356.7) plus a Might Bonus (137.1).',
  },

  // 423.1.a.1's stun event with an enemy subject. "one or more" is a plural the
  // grammar has no rule for; the event fires once per stun either way.
  'Leona - Radiant Dawn': {
    text: 'When you stun one or more enemy units, buff a friendly unit.',
    abilities: {
      triggered: [
        {
          condition: { event: 'stun', subject: 'enemy' },
          effect: { target: { kind: 'unit', scope: 'friendly' }, effects: [{ kind: 'buff' }] },
        },
      ],
    },
    note: '"one or more" plural on a per-object event (383.2).',
  },

};

/**
 * Normalise printed text for comparison.
 *
 * Must match what the parser sees, or an entry authored against the parser's
 * view would never match the raw text. Kept here rather than imported from
 * `text.ts` so the comparison cannot drift if the parser's preprocessing gains
 * a step that is about parsing rather than about identity.
 */
export function normalizeForAuthoring(text: string): string {
  return text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The authored model for a card, if one exists *and* still matches its text.
 *
 * Returns `undefined` both when nothing is authored and when the authored entry
 * has gone stale — the caller cannot tell the two apart, and should not: both
 * mean "no authored model applies", and both leave the card vanilla with a
 * recorded gap.
 */
export function authoredFor(
  name: string,
  printed: string,
): { readonly card: AuthoredCard; readonly stale: false } | { readonly stale: true } | undefined {
  const entry = AUTHORED_CARDS[name];
  if (entry === undefined) {
    return undefined;
  }
  return normalizeForAuthoring(entry.text) === normalizeForAuthoring(printed)
    ? { card: entry, stale: false }
    : { stale: true };
}
