/**
 * Downloading a source's sets.
 *
 * `data:` URLs go through the same `fetch` an https one does, so the happy
 * path is exercised for real rather than against a stubbed client — and the
 * suite still needs no network.
 */
import type { CardSource } from "@riftbound/ingest";
import { describe, expect, it } from "vitest";

import { FetchError, fetchSets } from "./fetch.js";

const NORMALIZE = (): never => {
  throw new Error("not used: these tests are about the download");
};

function sourceWith(sets: CardSource["sets"]): CardSource {
  return {
    id: "test-source",
    description: "A source that exists only to be downloaded from",
    normalize: NORMALIZE,
    ...(sets === undefined ? {} : { sets }),
  };
}

const data = (body: string): string =>
  `data:application/json,${encodeURIComponent(body)}`;

describe("fetchSets", () => {
  it("downloads every set, keyed by the name to read it back by", async () => {
    const fetched = await fetchSets(
      sourceWith([
        { name: "alpha", url: data('[{"id":"a"}]') },
        { name: "beta", url: data('[{"id":"b"}]') },
      ]),
    );

    expect([...fetched.keys()]).toEqual(["alpha", "beta"]);
    expect(fetched.get("alpha")).toBe('[{"id":"a"}]');
  });

  it("fails the whole fetch when one set is unreachable", async () => {
    // A pool missing a set is not a smaller pool but a wrong one: decks
    // referencing it stop validating and every statistic is quietly off.
    await expect(
      fetchSets(
        sourceWith([
          { name: "alpha", url: data('[{"id":"a"}]') },
          { name: "gone", url: "https://127.0.0.1:1/nothing.json" },
        ]),
      ),
    ).rejects.toThrow(FetchError);
  });

  it("says so when a source publishes nowhere to fetch from", async () => {
    await expect(fetchSets(sourceWith(undefined))).rejects.toThrow(
      /publishes no download locations/,
    );
  });
});
