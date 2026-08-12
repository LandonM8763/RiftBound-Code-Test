/**
 * What the suggester proposes, and how an edit is applied.
 *
 * An edit is a *value*, not a mutation: `applyEdit` returns a new deck. That is
 * what lets the search score a candidate by actually building the deck it
 * produces and measuring it, rather than by predicting what it would do.
 */
import { countOf, mergeEntries, type Deck, type DeckEntry } from '@riftbound/deck';
import type { CardId } from '@riftbound/cards';

/** A change to a deck, small enough to be evaluated on its own. */
export type DeckEdit =
  /** Remove `count` copies of a card from a list. */
  | { readonly kind: 'cut'; readonly list: EditableList; readonly card: CardId; readonly count: number }
  /** Add `count` copies. */
  | { readonly kind: 'add'; readonly list: EditableList; readonly card: CardId; readonly count: number }
  /**
   * Exchange copies of one card for another in the same list, in one step.
   *
   * Not a cut plus an add: the main deck has a size floor (103.2) and the Rune
   * deck an exact size (103.3), so evaluating half of a swap would score an
   * illegal deck and reject an edit that is fine.
   */
  | {
      readonly kind: 'swap';
      readonly list: EditableList;
      readonly out: CardId;
      readonly in: CardId;
      readonly count: number;
    };

/**
 * Which list an edit touches.
 *
 * The Legend and Chosen Champion are deliberately absent: changing either
 * rewrites the deck's Domain Identity (103.1) and its Champion Tag matching
 * (103.2.a.2), which is building a different deck rather than editing this one.
 */
export type EditableList = 'main' | 'runes';

export interface Suggestion {
  readonly edit: DeckEdit;
  /**
   * Why, in the deck's own terms. Always states the measurement that motivated
   * it, never only that a number improved.
   */
  readonly reason: string;
  /** How much the objective moved. Positive means better. */
  readonly delta: number;
  /** Which components of the objective moved, and by how much. */
  readonly components: Readonly<Record<string, number>>;
}

function entriesOf(deck: Deck, list: EditableList): readonly DeckEntry[] {
  return list === 'main' ? deck.main : deck.runes;
}

function withList(deck: Deck, list: EditableList, entries: readonly DeckEntry[]): Deck {
  return list === 'main' ? { ...deck, main: entries } : { ...deck, runes: entries };
}

/** Add or remove copies, dropping an entry that reaches zero. */
function adjust(
  entries: readonly DeckEntry[],
  card: CardId,
  delta: number,
): readonly DeckEntry[] {
  const current = countOf(entries, card);
  const next = Math.max(0, current + delta);
  const others = entries.filter((entry) => entry.card !== card);
  return next === 0 ? others : mergeEntries([...others, { card, count: next }]);
}

/** Apply an edit, returning a new deck. Never mutates its input. */
export function applyEdit(deck: Deck, edit: DeckEdit): Deck {
  const entries = entriesOf(deck, edit.list);
  switch (edit.kind) {
    case 'cut':
      return withList(deck, edit.list, adjust(entries, edit.card, -edit.count));
    case 'add':
      return withList(deck, edit.list, adjust(entries, edit.card, edit.count));
    case 'swap': {
      const cut = adjust(entries, edit.out, -edit.count);
      return withList(deck, edit.list, adjust(cut, edit.in, edit.count));
    }
    default: {
      const exhaustive: never = edit;
      throw new Error(`Unknown edit: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A short human-readable form of an edit, for reports. */
export function describeEdit(edit: DeckEdit, nameOf: (card: CardId) => string): string {
  switch (edit.kind) {
    case 'cut':
      return `Cut ${edit.count} ${nameOf(edit.card)}`;
    case 'add':
      return `Add ${edit.count} ${nameOf(edit.card)}`;
    case 'swap':
      return `Swap ${edit.count} ${nameOf(edit.out)} for ${nameOf(edit.in)}`;
    default: {
      const exhaustive: never = edit;
      throw new Error(`Unknown edit: ${JSON.stringify(exhaustive)}`);
    }
  }
}
