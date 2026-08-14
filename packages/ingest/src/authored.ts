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
import type { CardAbilities, CardEffect } from '@riftbound/cards';

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
export const AUTHORED_CARDS: Readonly<Record<string, AuthoredCard>> = {};

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
