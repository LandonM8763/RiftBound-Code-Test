/**
 * Deck edit suggestions.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The property that matters most here is that a suggestion is *measured*: every
 * one carries the delta it produced against a stated objective, and an edit
 * that does not improve the objective is not proposed at all.
 */
import {
  CardRegistry,
  cardId,
  cost,
  type CardDefinition,
} from "@riftbound/cards";
import {
  makeBattlefield,
  makeLegend,
  makeRune,
  makeUnit,
} from "@riftbound/cards/testing";
import { CONSTRUCTED_BO1, mergeEntries, type Deck } from "@riftbound/deck";
import { describe, expect, it } from "vitest";

import { candidateEdits } from "./candidates.js";
import { CONSISTENCY } from "./objective.js";
import { applyEdit, describeEdit } from "./suggestion.js";
import { suggestEdits } from "./suggest.js";

const LEGEND = makeLegend(["fury", "calm"], {
  id: cardId("S-000"),
  name: "Champ - Legend",
  championTag: "Champ",
});
const CHAMPION = makeUnit(3, ["fury"], {
  id: cardId("S-001"),
  name: "Champ - Unit",
  champion: true,
  championTag: "Champ",
});

/** A Fury card: one Energy, one Fury pip. */
const FURY_UNIT = makeUnit(2, ["fury"], {
  id: cardId("S-010"),
  name: "Fury Unit",
  cost: { energy: 1, power: ["fury"] },
});
/** A Calm card, so a deck can genuinely want both Domains. */
const CALM_UNIT = makeUnit(2, ["calm"], {
  id: cardId("S-011"),
  name: "Calm Unit",
  cost: { energy: 1, power: ["calm"] },
});
/** No Power at all: castable off any Rune deck. */
const NEUTRAL_UNIT = makeUnit(2, [], {
  id: cardId("S-012"),
  name: "Neutral",
  cost: cost(1),
});
/** Far beyond what 12 Runes can ever pay for. */
const UNPAYABLE = makeUnit(9, ["fury"], {
  id: cardId("S-013"),
  name: "Unpayable",
  cost: { energy: 30, power: ["fury"] },
});

const FURY_RUNE = makeRune("fury", { id: cardId("S-100"), name: "Fury Rune" });
const CALM_RUNE = makeRune("calm", { id: cardId("S-101"), name: "Calm Rune" });
// 103.4: Battlefield names must be distinct, so these cannot share one.
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`S-20${i}`), name: `Field ${i}` }),
);

/**
 * Filler bodies, distinct so the 3-copy limit (103.2.b) is not the thing under
 * test. No Power cost, so they say nothing about Domain consistency either.
 */
const FILLER = Array.from({ length: 14 }, (_, i) =>
  makeUnit(2, [], {
    id: cardId(`S-3${String(i).padStart(2, "0")}`),
    name: `Filler ${i}`,
    cost: cost(1),
  }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  FURY_UNIT,
  CALM_UNIT,
  NEUTRAL_UNIT,
  UNPAYABLE,
  ...FILLER,
  FURY_RUNE,
  CALM_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

/** Filler entries summing to exactly `count`, three copies of a name at most. */
function fillerFor(
  count: number,
): { card: CardDefinition["id"]; count: number }[] {
  const entries: { card: CardDefinition["id"]; count: number }[] = [];
  let remaining = count;
  for (const card of FILLER) {
    if (remaining <= 0) {
      break;
    }
    const take = Math.min(3, remaining);
    entries.push({ card: card.id, count: take });
    remaining -= take;
  }
  if (remaining > 0) {
    throw new Error(`Not enough distinct filler for ${count} cards`);
  }
  return entries;
}

/**
 * A legal deck: 40 main, 12 Runes, 3 distinct Battlefields.
 *
 * Legal on purpose — `suggestEdits` refuses to propose an edit that leaves the
 * deck illegal, so an illegal fixture would silently suppress every suggestion
 * and the tests would pass for the wrong reason.
 */
function deck(overrides: Partial<Deck> = {}): Deck {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: mergeEntries([{ card: FURY_UNIT.id, count: 3 }, ...fillerFor(37)]),
    runes: mergeEntries([
      { card: FURY_RUNE.id, count: 6 },
      { card: CALM_RUNE.id, count: 6 },
    ]),
    battlefields: BATTLEFIELDS.map((battlefield) => ({
      card: battlefield.id,
      count: 1,
    })),
    sideboard: [],
    ...overrides,
  };
}

const nameOf = (card: Parameters<typeof REGISTRY.get>[0]) =>
  REGISTRY.get(card)?.name ?? String(card);

describe("the objective", () => {
  it("scores a deck whose Runes match its demand above one that does not", () => {
    // Every Power pip is Fury, so a half-Calm Rune deck is half wasted.
    const mismatched = CONSISTENCY.score(deck(), REGISTRY);
    const matched = CONSISTENCY.score(
      deck({ runes: mergeEntries([{ card: FURY_RUNE.id, count: 12 }]) }),
      REGISTRY,
    );

    expect(matched.total).toBeGreaterThan(mismatched.total);
    expect(matched.components["domains"]).toBeGreaterThan(
      mismatched.components["domains"] ?? 0,
    );
  });

  it("penalizes a card the Rune deck can never pay for", () => {
    const fine = CONSISTENCY.score(deck(), REGISTRY);
    const stuck = CONSISTENCY.score(
      deck({
        main: mergeEntries([
          { card: UNPAYABLE.id, count: 3 },
          ...fillerFor(37),
        ]),
      }),
      REGISTRY,
    );

    expect(stuck.components["curve"]).toBeLessThan(
      fine.components["curve"] ?? 0,
    );
  });

  it("reports components that add up to the total", () => {
    const score = CONSISTENCY.score(deck(), REGISTRY);
    const parts = Object.values(score.components);
    const mean = parts.reduce((a, b) => a + b, 0) / parts.length;
    expect(score.total).toBeCloseTo(mean, 10);
  });
});

describe("applying an edit", () => {
  it("never mutates the deck it is given", () => {
    const before = deck();
    const snapshot = JSON.stringify(before);
    applyEdit(before, {
      kind: "cut",
      list: "main",
      card: NEUTRAL_UNIT.id,
      count: 1,
    });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("drops an entry that reaches zero rather than leaving a zero count", () => {
    const edited = applyEdit(deck(), {
      kind: "cut",
      list: "main",
      card: FURY_UNIT.id,
      count: 3,
    });
    expect(
      edited.main.find((entry) => entry.card === FURY_UNIT.id),
    ).toBeUndefined();
  });

  it("never cuts below zero", () => {
    const edited = applyEdit(deck(), {
      kind: "cut",
      list: "main",
      card: FURY_UNIT.id,
      count: 99,
    });
    expect(
      edited.main.find((entry) => entry.card === FURY_UNIT.id),
    ).toBeUndefined();
  });

  it("keeps a swap size-neutral, which is what makes it one edit", () => {
    // 103.3 fixes the Rune deck at 12, so a cut and an add evaluated separately
    // would each score an illegal deck.
    const edited = applyEdit(deck(), {
      kind: "swap",
      list: "runes",
      out: CALM_RUNE.id,
      in: FURY_RUNE.id,
      count: 1,
    });
    const total = edited.runes.reduce((sum, entry) => sum + entry.count, 0);
    expect(total).toBe(12);
  });
});

describe("suggesting edits", () => {
  it("proposes the Rune swap a mismatched deck needs", () => {
    const report = suggestEdits(deck(), REGISTRY, { format: CONSTRUCTED_BO1 });
    const top = report.suggestions[0];

    expect(top?.edit).toMatchObject({
      kind: "swap",
      list: "runes",
      out: CALM_RUNE.id,
      in: FURY_RUNE.id,
    });
    expect(top?.delta).toBeGreaterThan(0);
  });

  it("states the measurement, not just that a number improved", () => {
    const report = suggestEdits(deck(), REGISTRY, { format: CONSTRUCTED_BO1 });
    // The reason has to name the actual shares, so the reader can check it.
    expect(report.suggestions[0]?.reason).toMatch(
      /50% of your Runes are calm/i,
    );
    expect(report.suggestions[0]?.reason).toMatch(/0% of your Power demand/i);
  });

  it("says nothing when the deck is already right on every axis", () => {
    const tuned = deck({
      runes: mergeEntries([{ card: FURY_RUNE.id, count: 12 }]),
    });
    const report = suggestEdits(tuned, REGISTRY, { format: CONSTRUCTED_BO1 });

    expect(report.suggestions).toEqual([]);
    // Silence and "nothing was tried" are different answers.
    expect(report.baseline.total).toBeCloseTo(1, 6);
  });

  it("converges: applying the top suggestion repeatedly reaches a fixed point", () => {
    let current = deck();
    let previous = -Infinity;

    for (let round = 0; round < 20; round += 1) {
      const report = suggestEdits(current, REGISTRY, {
        format: CONSTRUCTED_BO1,
        limit: 1,
      });
      expect(report.baseline.total).toBeGreaterThanOrEqual(previous);
      previous = report.baseline.total;
      const top = report.suggestions[0];
      if (top === undefined) {
        break;
      }
      current = applyEdit(current, top.edit);
    }

    expect(
      suggestEdits(current, REGISTRY, { format: CONSTRUCTED_BO1 }).suggestions,
    ).toEqual([]);
  });

  it("never proposes an edit that makes the deck illegal", () => {
    // A 40-card main deck is the floor (103.2), so cutting from it is illegal.
    const minimal = deck({
      main: mergeEntries([{ card: UNPAYABLE.id, count: 3 }, ...fillerFor(37)]),
    });
    const report = suggestEdits(minimal, REGISTRY, { format: CONSTRUCTED_BO1 });

    for (const suggestion of report.suggestions) {
      expect(suggestion.edit.kind).not.toBe("cut");
    }
  });

  it("will cut when there is room above the floor", () => {
    const roomy = deck({
      main: mergeEntries([{ card: UNPAYABLE.id, count: 3 }, ...fillerFor(39)]),
    });
    const report = suggestEdits(roomy, REGISTRY, { format: CONSTRUCTED_BO1 });

    expect(report.suggestions.some((s) => s.edit.kind === "cut")).toBe(true);
  });

  it("is deterministic: the same deck gives the same report", () => {
    const first = suggestEdits(deck(), REGISTRY, { format: CONSTRUCTED_BO1 });
    const second = suggestEdits(deck(), REGISTRY, { format: CONSTRUCTED_BO1 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("ranks by how much the objective moved", () => {
    const report = suggestEdits(deck(), REGISTRY, {
      format: CONSTRUCTED_BO1,
      limit: 10,
    });
    const deltas = report.suggestions.map((s) => s.delta);
    expect([...deltas].sort((a, b) => b - a)).toEqual(deltas);
  });

  it("reports one suggestion per decision, keeping the best", () => {
    // Many ways to replace the same card are one decision, not many
    // suggestions. Without this the list fills with variations of one move.
    const pool = [CALM_UNIT.id, NEUTRAL_UNIT.id, FILLER[0]!.id, FILLER[1]!.id];
    const report = suggestEdits(deck(), REGISTRY, {
      format: CONSTRUCTED_BO1,
      pool,
      limit: 20,
    });

    const cutCards = report.suggestions
      .filter((suggestion) => suggestion.edit.kind === "swap")
      .map((suggestion) => (suggestion.edit as { out: string }).out);
    expect(new Set(cutCards).size).toBe(cutCards.length);
  });

  it("keeps the structurally different suggestion rather than variations", () => {
    // The Rune swap must survive a pool large enough to crowd it out.
    const pool = [
      CALM_UNIT.id,
      NEUTRAL_UNIT.id,
      ...FILLER.map((card) => card.id),
    ];
    const report = suggestEdits(deck(), REGISTRY, {
      format: CONSTRUCTED_BO1,
      pool,
      limit: 20,
    });

    expect(report.suggestions.some((s) => s.edit.list === "runes")).toBe(true);
  });

  it("honours the limit", () => {
    const report = suggestEdits(deck(), REGISTRY, {
      format: CONSTRUCTED_BO1,
      limit: 1,
    });
    expect(report.suggestions.length).toBeLessThanOrEqual(1);
  });
});

describe("candidates from a pool", () => {
  it("proposes nothing to add when given no pool", () => {
    // Suggesting a card the owner does not have is shopping, not a deck edit.
    const candidates = candidateEdits(deck(), REGISTRY);
    expect(candidates.some((candidate) => candidate.edit.kind === "add")).toBe(
      false,
    );
  });

  it("offers cards from the pool", () => {
    const candidates = candidateEdits(deck(), REGISTRY, {
      pool: [CALM_UNIT.id],
    });
    expect(candidates.some((candidate) => candidate.edit.kind === "add")).toBe(
      true,
    );
  });

  it("refuses a card outside the Legend`s Domain Identity (103.1.b.4)", () => {
    const OFF_IDENTITY = makeUnit(2, ["chaos"], {
      id: cardId("S-014"),
      name: "Off Identity",
      cost: { energy: 1, power: ["chaos"] },
    });
    const registry = CardRegistry.from([
      LEGEND,
      CHAMPION,
      FURY_UNIT,
      CALM_UNIT,
      NEUTRAL_UNIT,
      UNPAYABLE,
      OFF_IDENTITY,
      ...FILLER,
      FURY_RUNE,
      CALM_RUNE,
      ...BATTLEFIELDS,
    ] as CardDefinition[]);

    const candidates = candidateEdits(deck(), registry, {
      pool: [OFF_IDENTITY.id],
    });
    const touchesIt = candidates.some((candidate) =>
      JSON.stringify(candidate.edit).includes(OFF_IDENTITY.id),
    );
    expect(touchesIt).toBe(false);
  });

  it("respects the 3-copy limit (103.2.b)", () => {
    const candidates = candidateEdits(deck(), REGISTRY, {
      pool: [FURY_UNIT.id],
    });
    // The deck already runs 3.
    const adds = candidates.filter(
      (candidate) =>
        candidate.edit.kind === "add" && candidate.edit.card === FURY_UNIT.id,
    );
    expect(adds).toEqual([]);
  });
});

describe("describing an edit", () => {
  it("reads as an instruction a player could follow", () => {
    expect(
      describeEdit(
        { kind: "cut", list: "main", card: FURY_UNIT.id, count: 2 },
        nameOf,
      ),
    ).toBe("Cut 2 Fury Unit");
    expect(
      describeEdit(
        { kind: "add", list: "main", card: CALM_UNIT.id, count: 1 },
        nameOf,
      ),
    ).toBe("Add 1 Calm Unit");
    expect(
      describeEdit(
        {
          kind: "swap",
          list: "runes",
          out: CALM_RUNE.id,
          in: FURY_RUNE.id,
          count: 1,
        },
        nameOf,
      ),
    ).toBe("Swap 1 Calm Rune for Fury Rune");
  });
});
