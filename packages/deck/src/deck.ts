import type { CardId } from '@riftbound/cards';

/** A card and how many copies of it a pile holds. */
export interface DeckEntry {
  readonly card: CardId;
  readonly count: number;
}

/**
 * A deck as written down: piles of counted cards.
 *
 * Counts rather than a flat list, because that is the shape deck lists are
 * written in and the shape the copy limit is checked against. Use `toCardLists`
 * to flatten it for the engine.
 */
export interface Deck {
  readonly legend: CardId;
  /** The Chosen Champion. Counts toward the copy limit for that card. */
  readonly champion: CardId;
  readonly main: readonly DeckEntry[];
  readonly runes: readonly DeckEntry[];
  readonly battlefields: readonly DeckEntry[];
  /** Best-of-three only. Empty in a best-of-one deck. */
  readonly sideboard: readonly DeckEntry[];
}

/**
 * Flat card lists, one id per physical card.
 *
 * Structurally identical to the engine's `DeckList`, so the result can be
 * handed straight to `createGame` without this package depending on the engine.
 */
export interface CardLists {
  readonly legend: CardId;
  readonly champion: CardId;
  readonly main: readonly CardId[];
  readonly runes: readonly CardId[];
  readonly battlefields: readonly CardId[];
}

export function totalCount(entries: readonly DeckEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.count, 0);
}

export function countOf(entries: readonly DeckEntry[], card: CardId): number {
  return entries.reduce((sum, entry) => (entry.card === card ? sum + entry.count : sum), 0);
}

/** One id per copy, preserving the order the entries were listed in. */
export function expand(entries: readonly DeckEntry[]): CardId[] {
  const cards: CardId[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i += 1) {
      cards.push(entry.card);
    }
  }
  return cards;
}

/** Collapse repeated listings of the same card into one entry, keeping order. */
export function mergeEntries(entries: readonly DeckEntry[]): DeckEntry[] {
  const counts = new Map<CardId, number>();
  for (const entry of entries) {
    counts.set(entry.card, (counts.get(entry.card) ?? 0) + entry.count);
  }
  return [...counts].map(([card, count]) => ({ card, count }));
}

/** Every distinct card in the deck, including the Legend and Champion. */
export function uniqueCards(deck: Deck): CardId[] {
  const seen = new Set<CardId>([deck.legend, deck.champion]);
  for (const entries of [deck.main, deck.runes, deck.battlefields, deck.sideboard]) {
    for (const entry of entries) {
      seen.add(entry.card);
    }
  }
  return [...seen];
}

export function toCardLists(deck: Deck): CardLists {
  return {
    legend: deck.legend,
    champion: deck.champion,
    main: expand(deck.main),
    runes: expand(deck.runes),
    battlefields: expand(deck.battlefields),
  };
}

export function emptyDeck(legend: CardId, champion: CardId): Deck {
  return { legend, champion, main: [], runes: [], battlefields: [], sideboard: [] };
}
