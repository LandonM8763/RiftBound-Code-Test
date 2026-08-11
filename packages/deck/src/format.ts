/**
 * Deck construction constraints for a play format.
 *
 * Quantities come from the official Core Rules (RUP4, 2026-07-16):
 *
 * - Rule 103.2: a Main Deck of **at least** 40 cards. It is a minimum, not an
 *   exact size — an easy thing to get wrong, and community summaries do.
 * - Rule 103.3.a: exactly 12 Rune cards.
 * - Rule 103.2.b: at most 3 copies of the same named card, the Chosen Champion
 *   included (103.2.b.1).
 * - Rule 485.4.a: each player provides 3 Battlefields, of which one is used.
 * - Rule 103.4.c: those Battlefields must have distinct names.
 * - Rule 103.2.d.1: at most 3 Signature cards in total, regardless of name.
 */
export interface Format {
  readonly name: string;
  /** Rule 103.2: the Main Deck floor. There is no ceiling. */
  readonly mainDeckMinimum: number;
  readonly runeDeckSize: number;
  /** Battlefields carried in the deck, not the number placed in play. */
  readonly battlefieldCount: number;
  readonly maxCopies: number;
  /**
   * Rule 103.2.d.1: Signature cards a deck may hold in total.
   *
   * A separate budget from `maxCopies`: it is a *sum* across every Signature
   * card, "regardless of name", so three different Signature cards exhaust it
   * just as three copies of one do.
   */
  readonly maxSignatureCards: number;
  /**
   * Sideboard size when one is allowed.
   *
   * NOT from the Core Rules, which describe no sideboard: rule 486 defines the
   * best-of-three Match without one. Community sources describe an 8-card
   * sideboard, so it is presumably a competitive/tournament rule in a document
   * this project has not seen. Treat the number as unverified.
   */
  readonly sideboardSize: number;
  readonly allowSideboard: boolean;
}

/** Rule 485: the sanctioned 1v1 Duel, best of one. */
export const CONSTRUCTED_BO1: Format = {
  name: 'Constructed (best-of-one)',
  mainDeckMinimum: 40,
  runeDeckSize: 12,
  battlefieldCount: 3,
  maxCopies: 3,
  maxSignatureCards: 3,
  sideboardSize: 0,
  allowSideboard: false,
};

/** Rule 486: the sanctioned 1v1 Match, best of three. */
export const CONSTRUCTED_BO3: Format = {
  name: 'Constructed (best-of-three)',
  mainDeckMinimum: 40,
  runeDeckSize: 12,
  battlefieldCount: 3,
  maxCopies: 3,
  maxSignatureCards: 3,
  sideboardSize: 8,
  allowSideboard: true,
};

export const FORMATS: readonly Format[] = [CONSTRUCTED_BO1, CONSTRUCTED_BO3];

export const DEFAULT_FORMAT = CONSTRUCTED_BO1;
