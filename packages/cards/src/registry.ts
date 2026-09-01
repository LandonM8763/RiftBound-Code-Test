import type { CardDefinition, CardId } from './card.js';

/**
 * An immutable lookup from card id to definition.
 *
 * Card data is ingested and versioned separately from the rules engine; the
 * engine only ever reads definitions through a registry, so a new set is a data
 * update rather than an engine change.
 */
export class CardRegistry {
  readonly #byId: ReadonlyMap<CardId, CardDefinition>;
  /**
   * Lazily built, because most callers only ever look a card up by id.
   *
   * `null` marks a name two different cards carry — see `byName`.
   */
  #byName: Map<string, CardDefinition | null> | undefined;

  private constructor(byId: ReadonlyMap<CardId, CardDefinition>) {
    this.#byId = byId;
  }

  static from(cards: Iterable<CardDefinition>): CardRegistry {
    const byId = new Map<CardId, CardDefinition>();
    for (const card of cards) {
      const existing = byId.get(card.id);
      if (existing !== undefined) {
        throw new Error(
          `Duplicate card id ${card.id}: "${existing.name}" and "${card.name}". ` +
            'Card data is generated — fix the ingest rather than the output.',
        );
      }
      byId.set(card.id, card);
    }
    return new CardRegistry(byId);
  }

  get size(): number {
    return this.#byId.size;
  }

  has(id: CardId): boolean {
    return this.#byId.has(id);
  }

  get(id: CardId): CardDefinition | undefined {
    return this.#byId.get(id);
  }

  /** Throws when the id is unknown. Use where absence is a programming error. */
  mustGet(id: CardId): CardDefinition {
    const card = this.#byId.get(id);
    if (card === undefined) {
      throw new Error(`Unknown card id: ${id}`);
    }
    return card;
  }

  /**
   * The card with this printed name, when exactly one card carries it.
   *
   * For deck lists written by people: 103.2.b.2 makes same-named cards the
   * same card, and the ingest collapses printings by name for that reason, so
   * a name identifies a card in any well-formed pool. Matching ignores case
   * and surrounding whitespace, because the name is typed rather than copied.
   *
   * A name two *different* cards carry is a fault in the data rather than a
   * choice to make, so this answers `undefined` — the same as an unknown name.
   * Returning either card would silently build a deck the author did not
   * write, which is the failure this codebase refuses everywhere else.
   */
  byName(name: string): CardDefinition | undefined {
    if (this.#byName === undefined) {
      const index = new Map<string, CardDefinition | null>();
      for (const card of this.#byId.values()) {
        const key = normalizeName(card.name);
        index.set(key, index.has(key) ? null : card);
      }
      this.#byName = index;
    }
    return this.#byName.get(normalizeName(name)) ?? undefined;
  }

  all(): IterableIterator<CardDefinition> {
    return this.#byId.values();
  }
}

/** Fold the case and the whitespace a typed name varies in. */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}
