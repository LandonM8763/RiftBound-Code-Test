import { CardRegistry, cardId, type CardDefinition } from "@riftbound/cards";
import {
  makeBattlefield,
  makeGear,
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
} from "@riftbound/cards/testing";
import { describe, expect, it } from "vitest";

import type { Deck, DeckEntry } from "./deck.js";
import { CONSTRUCTED_BO1, CONSTRUCTED_BO3 } from "./format.js";
import { validateDeck } from "./validate.js";

/** Champion Tags (rule 133.8.b) link the Legend to its Champion and Signatures. */
const TAG = "Testarossa";
const OTHER_TAG = "Someone Else";

const LEGEND = makeLegend(["fury", "calm"], {
  id: cardId("OGN-001"),
  name: "Test Legend",
  championTag: TAG,
});
const CHAMPION = makeUnit(4, ["fury"], {
  id: cardId("OGN-002"),
  name: "Test Champion",
  champion: true,
  championTag: TAG,
});

/** 14 distinct Units: 13 at three copies plus one single makes exactly 40. */
const UNITS = Array.from({ length: 14 }, (_, i) =>
  makeUnit(2, ["fury"], {
    id: cardId(`OGN-1${String(i).padStart(2, "0")}`),
    name: `Unit ${i}`,
  }),
);

const FURY_RUNE = makeRune("fury", {
  id: cardId("OGN-200"),
  name: "Fury Rune",
});
const CALM_RUNE = makeRune("calm", {
  id: cardId("OGN-201"),
  name: "Calm Rune",
});
const MIND_RUNE = makeRune("mind", {
  id: cardId("OGN-202"),
  name: "Mind Rune",
});

const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`OGN-30${i}`), name: `Battlefield ${i}` }),
);

const OFF_DOMAIN_UNIT = makeUnit(3, ["mind"], {
  id: cardId("OGN-400"),
  name: "Mind Unit",
});
const SPELL = makeSpell(["fury"], {
  id: cardId("OGN-401"),
  name: "Fury Spell",
});
const GEAR = makeGear(["calm"], { id: cardId("OGN-402"), name: "Calm Gear" });
const NOT_A_CHAMPION = makeUnit(2, ["fury"], {
  id: cardId("OGN-403"),
  name: "Plain Unit",
});

/** A Champion Unit belonging to a different Legend (rule 103.2.a.2). */
const WRONG_CHAMPION = makeUnit(4, ["fury"], {
  id: cardId("OGN-404"),
  name: "Borrowed Champion",
  champion: true,
  championTag: OTHER_TAG,
});

/**
 * Signature cards (rule 133.7.b). The supertype applies to any card type, so
 * there is a Signature Spell here as well as a Signature Unit.
 */
const SIGNATURE_UNIT = makeUnit(3, ["fury"], {
  id: cardId("OGN-500"),
  name: "Signature Unit",
  championTag: TAG,
  signature: true,
});
const SIGNATURE_SPELL = makeSpell(["fury"], {
  id: cardId("OGN-501"),
  name: "Signature Spell",
  championTag: TAG,
  signature: true,
});
const OFF_TAG_SIGNATURE = makeUnit(3, ["fury"], {
  id: cardId("OGN-502"),
  name: "Borrowed Signature",
  championTag: OTHER_TAG,
  signature: true,
});
/** Contradictory card data: rule 103.2.d.3 makes these mutually exclusive. */
const SIGNATURE_CHAMPION = makeUnit(4, ["fury"], {
  id: cardId("OGN-503"),
  name: "Impossible Card",
  champion: true,
  championTag: TAG,
  signature: true,
});
/** Card data with no Champion Tag at all, as an ingest that omits it produces. */
const UNTAGGED_LEGEND = makeLegend(["fury", "calm"], {
  id: cardId("OGN-600"),
  name: "Untagged Legend",
});
const UNTAGGED_CHAMPION = makeUnit(4, ["fury"], {
  id: cardId("OGN-601"),
  name: "Untagged Champion",
  champion: true,
});

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  ...UNITS,
  FURY_RUNE,
  CALM_RUNE,
  MIND_RUNE,
  ...BATTLEFIELDS,
  OFF_DOMAIN_UNIT,
  SPELL,
  GEAR,
  NOT_A_CHAMPION,
  WRONG_CHAMPION,
  SIGNATURE_UNIT,
  SIGNATURE_SPELL,
  OFF_TAG_SIGNATURE,
  SIGNATURE_CHAMPION,
  UNTAGGED_LEGEND,
  UNTAGGED_CHAMPION,
] as CardDefinition[]);

function legalDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...UNITS.slice(0, 13).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[13] as CardDefinition).id, count: 1 },
    ],
    runes: [
      { card: FURY_RUNE.id, count: 6 },
      { card: CALM_RUNE.id, count: 6 },
    ],
    battlefields: BATTLEFIELDS.map((battlefield) => ({
      card: battlefield.id,
      count: 1,
    })),
    sideboard: [],
    ...overrides,
  };
}

const codes = (deck: Deck, format = CONSTRUCTED_BO1): string[] =>
  validateDeck(deck, REGISTRY, format).issues.map((issue) => issue.code);

/** A 40-card main deck holding `extra`, padded to size with plain Units. */
function mainWith(extra: readonly DeckEntry[]): DeckEntry[] {
  let remaining = 40 - extra.reduce((sum, entry) => sum + entry.count, 0);
  const filler: DeckEntry[] = [];
  for (const unit of UNITS) {
    if (remaining <= 0) {
      break;
    }
    const count = Math.min(3, remaining);
    filler.push({ card: unit.id, count });
    remaining -= count;
  }
  return [...filler, ...extra];
}

describe("validateDeck", () => {
  it("accepts a legal best-of-one deck", () => {
    const result = validateDeck(legalDeck(), REGISTRY, CONSTRUCTED_BO1);
    expect(result.issues).toEqual([]);
    expect(result.legal).toBe(true);
  });

  it("accepts a legal best-of-three deck with an 8-card sideboard", () => {
    // 3 + 3 + 2 = 8, and the two extra copies of the single-copy Unit bring it
    // to exactly three across main deck and sideboard.
    const deck = legalDeck({
      sideboard: [
        { card: SPELL.id, count: 3 },
        { card: GEAR.id, count: 3 },
        { card: (UNITS[13] as CardDefinition).id, count: 2 },
      ],
    });
    const result = validateDeck(deck, REGISTRY, CONSTRUCTED_BO3);
    expect(result.issues).toEqual([]);
    expect(result.legal).toBe(true);
  });
});

describe("deck sizes", () => {
  it("requires exactly 40 main deck cards", () => {
    expect(
      codes(
        legalDeck({
          main: [{ card: (UNITS[0] as CardDefinition).id, count: 3 }],
        }),
      ),
    ).toContain("main-deck-size");
  });

  it("requires exactly 12 Runes", () => {
    expect(
      codes(legalDeck({ runes: [{ card: FURY_RUNE.id, count: 11 }] })),
    ).toContain("rune-deck-size");
  });

  it("requires exactly 3 Battlefields", () => {
    expect(
      codes(
        legalDeck({ battlefields: [{ card: BATTLEFIELDS[0]!.id, count: 1 }] }),
      ),
    ).toContain("battlefield-count");
  });

  it("reports the actual and required counts in the message", () => {
    const result = validateDeck(
      legalDeck({
        main: [{ card: (UNITS[0] as CardDefinition).id, count: 3 }],
      }),
      REGISTRY,
    );
    const issue = result.issues.find(
      (candidate) => candidate.code === "main-deck-size",
    );
    expect(issue?.message).toContain("3");
    expect(issue?.message).toContain("40");
  });
});

describe("copy limit", () => {
  it("rejects a fourth copy of a card", () => {
    const main = [
      { card: (UNITS[0] as CardDefinition).id, count: 4 },
      ...UNITS.slice(1, 13).map((unit) => ({ card: unit.id, count: 3 })),
    ];
    expect(codes(legalDeck({ main }))).toContain("copy-limit");
  });

  it("counts the Chosen Champion toward its own limit", () => {
    // Champion in the Champion Zone plus two in the main deck is exactly three.
    const withTwoMore = [
      { card: CHAMPION.id, count: 2 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 2 },
    ];
    expect(codes(legalDeck({ main: withTwoMore }))).not.toContain("copy-limit");

    // A third in the main deck makes four in total.
    const withThreeMore = [
      { card: CHAMPION.id, count: 3 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main: withThreeMore }))).toContain("copy-limit");
  });

  it("exempts Runes, which are necessarily played in many copies", () => {
    expect(codes(legalDeck())).not.toContain("copy-limit");
  });

  it("counts the sideboard against the same limit", () => {
    // A legal 8-card sideboard whose only fault is a fourth copy of a card
    // that already appears three times in the main deck.
    const deck = legalDeck({
      sideboard: [
        { card: (UNITS[0] as CardDefinition).id, count: 1 },
        { card: SPELL.id, count: 3 },
        { card: GEAR.id, count: 3 },
        { card: (UNITS[13] as CardDefinition).id, count: 1 },
      ],
    });
    const issues = validateDeck(deck, REGISTRY, CONSTRUCTED_BO3).issues;

    expect(issues.map((issue) => issue.code)).toEqual(["copy-limit"]);
    expect(issues[0]?.cards).toEqual([(UNITS[0] as CardDefinition).id]);
  });
});

describe("Champion Tags (rule 103.2.a.2)", () => {
  it("accepts a Chosen Champion whose tag matches the Legend", () => {
    expect(codes(legalDeck())).not.toContain("champion-tag-mismatch");
  });

  it("rejects a Chosen Champion carrying a different tag", () => {
    expect(codes(legalDeck({ champion: WRONG_CHAMPION.id }))).toContain(
      "champion-tag-mismatch",
    );
  });

  it("names both tags and both cards in the message", () => {
    const result = validateDeck(
      legalDeck({ champion: WRONG_CHAMPION.id }),
      REGISTRY,
    );
    const issue = result.issues.find(
      (candidate) => candidate.code === "champion-tag-mismatch",
    );

    expect(issue?.message).toContain(TAG);
    expect(issue?.message).toContain(OTHER_TAG);
    expect(issue?.cards).toEqual([WRONG_CHAMPION.id, LEGEND.id]);
  });

  it("warns rather than errors when the card data carries no tag", () => {
    // A missing field is a gap in the card data, not an illegal deck.
    const deck = legalDeck({
      legend: UNTAGGED_LEGEND.id,
      champion: UNTAGGED_CHAMPION.id,
    });
    const result = validateDeck(deck, REGISTRY);
    const issue = result.issues.find(
      (candidate) => candidate.code === "champion-tag-unknown",
    );

    expect(issue?.severity).toBe("warning");
    expect(result.legal).toBe(true);
  });

  it("warns when only the Champion is untagged", () => {
    const result = validateDeck(
      legalDeck({ champion: UNTAGGED_CHAMPION.id }),
      REGISTRY,
    );
    const issue = result.issues.find(
      (candidate) => candidate.code === "champion-tag-unknown",
    );

    expect(issue?.cards).toEqual([UNTAGGED_CHAMPION.id]);
  });

  it("does not check the tag on a card that is not a Champion Unit at all", () => {
    // The 'champion-not-a-champion' error already says everything useful.
    const found = codes(legalDeck({ champion: NOT_A_CHAMPION.id }));
    expect(found).toContain("champion-not-a-champion");
    expect(found).not.toContain("champion-tag-mismatch");
    expect(found).not.toContain("champion-tag-unknown");
  });
});

describe("Signature cards (rule 103.2.d)", () => {
  it("accepts three Signature cards", () => {
    const deck = legalDeck({
      main: mainWith([{ card: SIGNATURE_UNIT.id, count: 3 }]),
    });
    expect(codes(deck)).toEqual([]);
  });

  it("rejects a fourth", () => {
    const deck = legalDeck({
      main: mainWith([
        { card: SIGNATURE_UNIT.id, count: 3 },
        { card: SIGNATURE_SPELL.id, count: 1 },
      ]),
    });
    expect(codes(deck)).toContain("signature-limit");
  });

  it("counts the limit across names, not per name (103.2.d.1)", () => {
    // Two copies each of two different Signature cards: legal under the 3-copy
    // rule, over the Signature budget.
    const deck = legalDeck({
      main: mainWith([
        { card: SIGNATURE_UNIT.id, count: 2 },
        { card: SIGNATURE_SPELL.id, count: 2 },
      ]),
    });
    const found = codes(deck);

    expect(found).toContain("signature-limit");
    expect(found).not.toContain("copy-limit");
  });

  it("counts the sideboard against the same budget", () => {
    const deck = legalDeck({
      main: mainWith([{ card: SIGNATURE_UNIT.id, count: 3 }]),
      sideboard: [
        { card: SIGNATURE_SPELL.id, count: 1 },
        { card: SPELL.id, count: 3 },
        { card: GEAR.id, count: 3 },
        { card: (UNITS[13] as CardDefinition).id, count: 1 },
      ],
    });
    expect(codes(deck, CONSTRUCTED_BO3)).toContain("signature-limit");
  });

  it("requires every Signature card to carry the Legend`s tag (103.2.d.2)", () => {
    const deck = legalDeck({
      main: mainWith([{ card: OFF_TAG_SIGNATURE.id, count: 1 }]),
    });
    const result = validateDeck(deck, REGISTRY);
    const issue = result.issues.find(
      (candidate) => candidate.code === "signature-tag-mismatch",
    );

    expect(issue?.cards).toEqual([OFF_TAG_SIGNATURE.id, LEGEND.id]);
    expect(result.legal).toBe(false);
  });

  it("applies the supertype to any card type, Spells included (133.7.b)", () => {
    const deck = legalDeck({
      main: mainWith([{ card: SIGNATURE_SPELL.id, count: 3 }]),
    });
    expect(codes(deck)).toEqual([]);

    const overBudget = legalDeck({
      main: mainWith([
        { card: SIGNATURE_SPELL.id, count: 3 },
        { card: SIGNATURE_UNIT.id, count: 1 },
      ]),
    });
    expect(codes(overBudget)).toContain("signature-limit");
  });

  it("rejects a Signature Chosen Champion (103.2.d.3)", () => {
    expect(codes(legalDeck({ champion: SIGNATURE_CHAMPION.id }))).toContain(
      "champion-is-signature",
    );
  });

  it("rejects card data claiming both supertypes (103.2.d.3)", () => {
    const deck = legalDeck({
      main: mainWith([{ card: SIGNATURE_CHAMPION.id, count: 1 }]),
    });
    expect(codes(deck)).toContain("signature-champion-unit");
  });

  it("warns rather than errors when a Signature card carries no tag", () => {
    const deck = legalDeck({
      legend: UNTAGGED_LEGEND.id,
      champion: UNTAGGED_CHAMPION.id,
      main: mainWith([{ card: SIGNATURE_UNIT.id, count: 1 }]),
    });
    const result = validateDeck(deck, REGISTRY);
    const issue = result.issues.find(
      (candidate) => candidate.code === "signature-tag-unknown",
    );

    expect(issue?.severity).toBe("warning");
    expect(result.legal).toBe(true);
  });

  it("says nothing at all about a deck with no Signature cards", () => {
    const found = codes(legalDeck());
    expect(found.filter((code) => code.startsWith("signature"))).toEqual([]);
  });
});

describe("domain identity", () => {
  it("rejects a card outside the Legend's identity", () => {
    const main = [
      { card: OFF_DOMAIN_UNIT.id, count: 3 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main }))).toContain("outside-identity");
  });

  it("rejects a Rune outside the Legend's identity", () => {
    const deck = legalDeck({
      runes: [
        { card: FURY_RUNE.id, count: 6 },
        { card: MIND_RUNE.id, count: 6 },
      ],
    });
    expect(codes(deck)).toContain("rune-outside-identity");
  });

  it("names the offending card and the identity in the message", () => {
    const deck = legalDeck({
      runes: [
        { card: FURY_RUNE.id, count: 6 },
        { card: MIND_RUNE.id, count: 6 },
      ],
    });
    const issue = validateDeck(deck, REGISTRY).issues.find(
      (candidate) => candidate.code === "rune-outside-identity",
    );
    expect(issue?.message).toContain("Mind Rune");
    expect(issue?.cards).toEqual([MIND_RUNE.id]);
  });

  it("accepts both Domains of the identity", () => {
    expect(codes(legalDeck())).not.toContain("outside-identity");
  });
});

describe("card types and piles", () => {
  it("rejects a Legend that is not a Legend", () => {
    expect(codes(legalDeck({ legend: SPELL.id }))).toContain(
      "legend-not-a-legend",
    );
  });

  it("rejects a Champion that is not a Champion Unit", () => {
    expect(codes(legalDeck({ champion: NOT_A_CHAMPION.id }))).toContain(
      "champion-not-a-champion",
    );
  });

  it("rejects a Rune in the main deck", () => {
    const main = [
      { card: FURY_RUNE.id, count: 3 },
      ...UNITS.slice(0, 12).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[12] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main }))).toContain("wrong-pile");
  });

  it("rejects a Unit in the Rune deck", () => {
    const deck = legalDeck({
      runes: [{ card: (UNITS[0] as CardDefinition).id, count: 12 }],
    });
    expect(codes(deck)).toContain("wrong-pile");
  });

  it("rejects a Spell among the Battlefields", () => {
    const deck = legalDeck({
      battlefields: [
        { card: SPELL.id, count: 1 },
        { card: BATTLEFIELDS[0]!.id, count: 1 },
        { card: BATTLEFIELDS[1]!.id, count: 1 },
      ],
    });
    expect(codes(deck)).toContain("wrong-pile");
  });

  it("accepts Units, Spells and Gear in the main deck", () => {
    const main = [
      { card: SPELL.id, count: 3 },
      { card: GEAR.id, count: 3 },
      ...UNITS.slice(0, 11).map((unit) => ({ card: unit.id, count: 3 })),
      { card: (UNITS[11] as CardDefinition).id, count: 1 },
    ];
    expect(codes(legalDeck({ main }))).not.toContain("wrong-pile");
  });
});

describe("sideboard", () => {
  it("rejects a sideboard in best-of-one", () => {
    const deck = legalDeck({ sideboard: [{ card: SPELL.id, count: 8 }] });
    expect(codes(deck, CONSTRUCTED_BO1)).toContain("sideboard-not-allowed");
  });

  it("requires exactly 8 cards when one is present in best-of-three", () => {
    const deck = legalDeck({ sideboard: [{ card: SPELL.id, count: 3 }] });
    expect(codes(deck, CONSTRUCTED_BO3)).toContain("sideboard-size");
  });

  it("allows an empty sideboard in best-of-three", () => {
    expect(codes(legalDeck(), CONSTRUCTED_BO3)).toEqual([]);
  });
});

describe("unknown cards", () => {
  it("reports cards missing from the card data", () => {
    const deck = legalDeck({ champion: cardId("OGN-999") });
    const result = validateDeck(deck, REGISTRY);
    const issue = result.issues.find(
      (candidate) => candidate.code === "unknown-card",
    );

    expect(issue).toBeDefined();
    expect(issue?.cards).toContain(cardId("OGN-999"));
  });

  it("still reports the other problems it can check", () => {
    const deck = legalDeck({ champion: cardId("OGN-999"), runes: [] });
    expect(codes(deck)).toContain("rune-deck-size");
  });
});

describe("issue shape", () => {
  it("reports every problem rather than stopping at the first", () => {
    const deck = legalDeck({ main: [], runes: [], battlefields: [] });
    const found = codes(deck);

    expect(found).toContain("main-deck-size");
    expect(found).toContain("rune-deck-size");
    expect(found).toContain("battlefield-count");
  });

  it("marks blocking problems as errors and reports the deck illegal", () => {
    const result = validateDeck(legalDeck({ runes: [] }), REGISTRY);
    expect(result.legal).toBe(false);
    expect(result.issues.every((issue) => issue.severity === "error")).toBe(
      true,
    );
  });
});
