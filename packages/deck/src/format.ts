/**
 * Deck construction constraints for a play format.
 *
 * These quantities are well established by community sources and are not part
 * of the UNVERIFIED set: 40-card main deck, 12-card Rune deck, 3 Battlefields,
 * at most 3 copies of a unique card, and an 8-card sideboard in best-of-three.
 */
export interface Format {
  readonly name: string;
  readonly mainDeckSize: number;
  readonly runeDeckSize: number;
  readonly battlefieldCount: number;
  readonly maxCopies: number;
  /** Required sideboard size when a sideboard is allowed. */
  readonly sideboardSize: number;
  readonly allowSideboard: boolean;
}

export const CONSTRUCTED_BO1: Format = {
  name: 'Constructed (best-of-one)',
  mainDeckSize: 40,
  runeDeckSize: 12,
  battlefieldCount: 3,
  maxCopies: 3,
  sideboardSize: 0,
  allowSideboard: false,
};

export const CONSTRUCTED_BO3: Format = {
  name: 'Constructed (best-of-three)',
  mainDeckSize: 40,
  runeDeckSize: 12,
  battlefieldCount: 3,
  maxCopies: 3,
  sideboardSize: 8,
  allowSideboard: true,
};

export const FORMATS: readonly Format[] = [CONSTRUCTED_BO1, CONSTRUCTED_BO3];

export const DEFAULT_FORMAT = CONSTRUCTED_BO1;
