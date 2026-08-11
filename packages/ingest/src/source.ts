import type { CardDefinition } from '@riftbound/cards';

import type { Gap } from './gaps.js';

/**
 * A card data source, normalized into this project's schema.
 *
 * Pluggable for the same reason `DeckImporter` is: which source to pin is an
 * open question, every candidate has a different shape, and the environment
 * this runs in can only reach some of them. A new source is a new adapter, not
 * a change to anything downstream.
 *
 * An adapter's job is to translate and to *report what it could not translate*
 * — never to fill a blank with a plausible value.
 */
export interface CardSource {
  /** Stable identifier, recorded in the generated file's provenance. */
  readonly id: string;
  /** Human-readable description, including where the data came from. */
  readonly description: string;
  readonly normalize: (raw: unknown) => IngestResult;
}

export interface IngestResult {
  /** Cards complete enough to represent. Sorted by id for a stable diff. */
  readonly cards: readonly CardDefinition[];
  /** Everything the source could not supply, including for dropped cards. */
  readonly gaps: readonly Gap[];
  /** Cards dropped because a required field was missing. */
  readonly dropped: number;
  /** Problems with the source data itself, as opposed to missing fields. */
  readonly problems: readonly string[];
}
