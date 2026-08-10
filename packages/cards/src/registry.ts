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

  all(): IterableIterator<CardDefinition> {
    return this.#byId.values();
  }
}
