import { CardRegistry, cardId } from "@riftbound/cards";
import { makeLegend, makeUnit } from "@riftbound/cards/testing";
import { describe, expect, it } from "vitest";

import {
  countOf,
  expand,
  mergeEntries,
  toCardLists,
  totalCount,
  uniqueCards,
} from "./deck.js";
import {
  byIdOrName,
  parseDeckList,
  parseDeckText,
  textImporter,
  type DeckImporter,
} from "./parse.js";

const FULL_LIST = `
# Legend
1 OGN-001

# Champion
1 OGN-002

# Main
3 OGN-100
3 OGN-101
2 OGN-102

# Runes
6 OGN-200
6 OGN-201

# Battlefields
1 OGN-300
1 OGN-301
1 OGN-302

# Sideboard
2 OGN-400
`;

function parsed(text: string) {
  const result = parseDeckText(text);
  if (!result.ok) {
    throw new Error(
      `Expected a parse, got: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return result.deck;
}

describe("parseDeckText", () => {
  it("reads every section of a full list", () => {
    const deck = parsed(FULL_LIST);

    expect(deck.legend).toBe(cardId("OGN-001"));
    expect(deck.champion).toBe(cardId("OGN-002"));
    expect(totalCount(deck.main)).toBe(8);
    expect(totalCount(deck.runes)).toBe(12);
    expect(totalCount(deck.battlefields)).toBe(3);
    expect(totalCount(deck.sideboard)).toBe(2);
  });

  it("accepts the 3x form, bare card lines, and extra whitespace", () => {
    const deck = parsed(`
      Legend
        1 OGN-001
      Champion
        OGN-002
      Main
        3x OGN-100
        2 X OGN-101
        OGN-102
    `);

    expect(countOf(deck.main, cardId("OGN-100"))).toBe(3);
    expect(countOf(deck.main, cardId("OGN-101"))).toBe(2);
    expect(countOf(deck.main, cardId("OGN-102"))).toBe(1);
  });

  it("merges repeated listings of the same card", () => {
    const deck = parsed(`
      Legend
      1 OGN-001
      Champion
      1 OGN-002
      Main
      2 OGN-100
      1 OGN-100
    `);

    expect(deck.main).toEqual([{ card: cardId("OGN-100"), count: 3 }]);
  });

  it("ignores comments and blank lines", () => {
    const deck = parsed(`
      // a leading note
      Legend
      1 OGN-001 // the legend
      Champion
      1 OGN-002

      # not-a-section-name
      Main
      3 OGN-100
    `);

    expect(deck.legend).toBe(cardId("OGN-001"));
    expect(countOf(deck.main, cardId("OGN-100"))).toBe(3);
  });

  it("accepts header aliases and any casing", () => {
    const deck = parsed(`
      LEGEND:
      1 OGN-001
      Chosen Champion
      1 OGN-002
      Maindeck
      1 OGN-100
      Rune Deck
      1 OGN-200
      battlefield
      1 OGN-300
      SIDE
      1 OGN-400
    `);

    expect(totalCount(deck.main)).toBe(1);
    expect(totalCount(deck.runes)).toBe(1);
    expect(totalCount(deck.battlefields)).toBe(1);
    expect(totalCount(deck.sideboard)).toBe(1);
  });

  it("handles Windows line endings", () => {
    const deck = parsed(
      "Legend\r\n1 OGN-001\r\nChampion\r\n1 OGN-002\r\nMain\r\n3 OGN-100\r\n",
    );
    expect(countOf(deck.main, cardId("OGN-100"))).toBe(3);
  });

  it("reports a card listed before any section header", () => {
    const result = parseDeckText("3 OGN-100\nLegend\n1 OGN-001");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors[0]?.code).toBe("card-before-section");
    expect(result.errors[0]?.line).toBe(1);
  });

  it("reports a missing Legend and Champion", () => {
    const result = parseDeckText("Main\n3 OGN-100");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const codes = result.errors.map((issue) => issue.code);
    expect(codes).toContain("missing-legend");
    expect(codes).toContain("missing-champion");
  });

  it("rejects more than one Legend", () => {
    const result = parseDeckText(
      "Legend\n1 OGN-001\n1 OGN-009\nChampion\n1 OGN-002",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors.map((issue) => issue.code)).toContain(
      "multiple-legends",
    );
  });

  it("rejects a zero copy count and points at the line", () => {
    const result = parseDeckText(
      "Legend\n1 OGN-001\nChampion\n1 OGN-002\nMain\n0 OGN-100",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors[0]?.code).toBe("invalid-count");
    expect(result.errors[0]?.line).toBe(6);
  });

  it("rejects an empty list", () => {
    const result = parseDeckText("");
    expect(result.ok).toBe(false);
  });
});

describe("parseDeckList", () => {
  it("uses the first importer that recognises the input", () => {
    const stub: DeckImporter = {
      name: "stub",
      canImport: (input) => input.startsWith("stub:"),
      parse: () => ({
        ok: true,
        deck: {
          legend: cardId("X-1"),
          champion: cardId("X-2"),
          main: [],
          runes: [],
          battlefields: [],
          sideboard: [],
        },
      }),
    };

    const result = parseDeckList("stub: anything", { importers: [stub, textImporter] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.legend).toBe(cardId("X-1"));
  });

  it("falls through to the text importer", () => {
    const result = parseDeckList(FULL_LIST);
    expect(result.ok).toBe(true);
  });

  it("reports when no importer recognises the input", () => {
    const picky: DeckImporter = {
      name: "picky",
      canImport: () => false,
      parse: () => ({ ok: false, errors: [] }),
    };

    const result = parseDeckList(FULL_LIST, { importers: [picky] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("unrecognised-format");
  });
});

describe("naming cards by printed name", () => {
  const POOL = CardRegistry.from([
    makeLegend(["fury"], { id: cardId("N-000"), name: "Kai'Sa - Daughter of the Void" }),
    makeUnit(3, ["fury"], { id: cardId("N-001"), name: "Kai'Sa - Survivor", champion: true }),
    makeUnit(2, ["fury"], { id: cardId("N-002"), name: "Blazing Scorcher" }),
  ]);

  const NAMED = [
    "# Legend",
    "1 Kai'Sa - Daughter of the Void",
    "# Champion",
    "1 Kai'Sa - Survivor",
    "# Main",
    "3 blazing scorcher",
  ].join("\n");

  it("resolves names to ids when a lookup is supplied", () => {
    const result = parseDeckText(NAMED, byIdOrName(POOL));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.legend).toBe(cardId("N-000"));
    expect(result.deck.champion).toBe(cardId("N-001"));
    expect(result.deck.main).toEqual([{ card: cardId("N-002"), count: 3 }]);
  });

  it("leaves the token alone without one, so ids keep working unchanged", () => {
    // The no-lookup behaviour is the whole back-compatibility story: a list of
    // ids parses identically whether or not card data is to hand.
    const result = parseDeckText(NAMED);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.legend).toBe(cardId("Kai'Sa - Daughter of the Void"));
  });

  it("prefers a printed id over a name", () => {
    const byId = parseDeckText(
      "# Legend\n1 N-000\n# Champion\n1 N-001\n",
      byIdOrName(POOL),
    );
    expect(byId.ok).toBe(true);
    if (!byId.ok) return;
    expect(byId.deck.legend).toBe(cardId("N-000"));
  });

  it("keeps an unreadable token as an id, so validation reports it", () => {
    // Rather than a second error path in the parser saying the same thing:
    // `validateDeck` already knows how to say "unknown card".
    const result = parseDeckText(
      "# Legend\n1 Not A Real Card\n# Champion\n1 Kai'Sa - Survivor\n",
      byIdOrName(POOL),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.legend).toBe(cardId("Not A Real Card"));
  });

  it("reaches the text importer through parseDeckList", () => {
    const result = parseDeckList(NAMED, { resolve: byIdOrName(POOL) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.deck.champion).toBe(cardId("N-001"));
  });
});

describe("deck model helpers", () => {
  const entries = [
    { card: cardId("A"), count: 3 },
    { card: cardId("B"), count: 1 },
  ];

  it("totals copies", () => {
    expect(totalCount(entries)).toBe(4);
    expect(totalCount([])).toBe(0);
  });

  it("counts a single card", () => {
    expect(countOf(entries, cardId("A"))).toBe(3);
    expect(countOf(entries, cardId("Z"))).toBe(0);
  });

  it("expands to one id per copy, in order", () => {
    expect(expand(entries)).toEqual([
      cardId("A"),
      cardId("A"),
      cardId("A"),
      cardId("B"),
    ]);
  });

  it("merges duplicate entries while keeping first-seen order", () => {
    expect(
      mergeEntries([
        { card: cardId("B"), count: 1 },
        { card: cardId("A"), count: 2 },
        { card: cardId("B"), count: 2 },
      ]),
    ).toEqual([
      { card: cardId("B"), count: 3 },
      { card: cardId("A"), count: 2 },
    ]);
  });

  it("flattens to engine-shaped card lists", () => {
    const lists = toCardLists(parsed(FULL_LIST));

    expect(lists.main).toHaveLength(8);
    expect(lists.runes).toHaveLength(12);
    expect(lists.battlefields).toHaveLength(3);
    expect(lists.legend).toBe(cardId("OGN-001"));
    // The sideboard is not part of a game's starting card lists.
    expect(lists).not.toHaveProperty("sideboard");
  });

  it("lists every distinct card including the Legend and Champion", () => {
    const unique = uniqueCards(parsed(FULL_LIST));
    expect(unique).toContain(cardId("OGN-001"));
    expect(unique).toContain(cardId("OGN-002"));
    expect(unique).toContain(cardId("OGN-400"));
    expect(new Set(unique).size).toBe(unique.length);
  });
});
