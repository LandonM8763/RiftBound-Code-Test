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
  /**
   * Where this source publishes its data, when it publishes it openly.
   *
   * The adapter owns this rather than the CLI, because knowing the shape of a
   * source's data and knowing where it lives are the same knowledge — a second
   * source with a different layout brings its own list.
   *
   * A pinned list rather than a directory listing: the hosts that would serve
   * one are not reachable (see CLAUDE.md), and a silent partial fetch would
   * produce a card pool that looks complete and is not. **Add a set here when
   * one releases** — a missing set is missing cards, not an error.
   */
  readonly sets?: readonly RemoteSet[] | undefined;
}

/** One published file of a source's card data. */
export interface RemoteSet {
  /** Set name, used as the file name the ingest reports against. */
  readonly name: string;
  readonly url: string;
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
