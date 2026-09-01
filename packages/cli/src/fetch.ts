/**
 * Downloading a source's published card data.
 *
 * This is the only part of the CLI that touches the network, and it is kept
 * out of `run.ts` on purpose: `run` is a pure function from arguments and a
 * `FileReader` to a result, which is what lets the whole command surface be
 * tested without a network or a filesystem. Fetching happens first, in
 * `main.ts`, and hands `run` a reader over what it downloaded — the same seam
 * a real file goes through.
 */
import type { CardSource, RemoteSet } from '@riftbound/ingest';

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

/**
 * Download every set a source publishes, keyed by a name to read it back by.
 *
 * All of them or none: a source's sets are a card *pool*, and a pool missing
 * one set is not a smaller pool but a wrong one — decks referencing it stop
 * validating, and every statistic computed from it is quietly off. So one
 * failed set fails the fetch and says which, rather than ingesting the rest.
 */
export async function fetchSets(source: CardSource): Promise<Map<string, string>> {
  const sets: readonly RemoteSet[] = source.sets ?? [];
  if (sets.length === 0) {
    throw new FetchError(
      `Source "${source.id}" publishes no download locations, so --fetch has nothing to get. ` +
        'Pass the raw files as arguments instead.',
    );
  }

  const downloaded = new Map<string, string>();
  for (const set of sets) {
    let response: Response;
    try {
      response = await fetch(set.url);
    } catch (error) {
      throw new FetchError(
        `Could not reach ${set.url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new FetchError(`${set.url} responded ${response.status} ${response.statusText}`);
    }
    downloaded.set(set.name, await response.text());
  }
  return downloaded;
}
