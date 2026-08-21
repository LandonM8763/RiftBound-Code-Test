import { describe, expect, it } from "vitest";

import { cardId } from "./card.js";
import { cost, powerOf, totalRuneCost } from "./cost.js";
import { DOMAINS, isDomain, withinIdentity } from "./domain.js";
import { CardRegistry } from "./registry.js";
import { isChampionUnit, isSignature } from "./card.js";
import {
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
  resetCardIds,
} from "./testing.js";

describe("domains", () => {
  it("has exactly the six Riftbound domains", () => {
    expect([...DOMAINS]).toEqual([
      "fury",
      "calm",
      "mind",
      "body",
      "chaos",
      "order",
    ]);
  });

  it("recognises domain names and rejects others", () => {
    expect(isDomain("fury")).toBe(true);
    expect(isDomain("Fury")).toBe(false);
    expect(isDomain("shadow")).toBe(false);
  });

  it("accepts a card whose domains fall inside the identity", () => {
    expect(withinIdentity(["fury"], ["fury", "calm"])).toBe(true);
    expect(withinIdentity(["fury", "calm"], ["fury", "calm"])).toBe(true);
  });

  it("rejects a card reaching outside the identity", () => {
    expect(withinIdentity(["mind"], ["fury", "calm"])).toBe(false);
    expect(withinIdentity(["fury", "mind"], ["fury", "calm"])).toBe(false);
  });

  it("treats a domainless card as always legal", () => {
    expect(withinIdentity([], ["fury", "calm"])).toBe(true);
  });
});

describe("cost", () => {
  it("counts Energy and Power as separate resources", () => {
    const value = cost(2, "fury", "fury");
    expect(value.energy).toBe(2);
    expect(value.power).toEqual(["fury", "fury"]);
  });

  it("totals the Runes a cost consumes", () => {
    expect(totalRuneCost(cost(2, "fury", "calm"))).toBe(4);
    expect(totalRuneCost(cost(0))).toBe(0);
  });

  it("counts Power pips per domain", () => {
    const value = cost(1, "fury", "fury", "calm");
    expect(powerOf(value, "fury")).toBe(2);
    expect(powerOf(value, "calm")).toBe(1);
    expect(powerOf(value, "mind")).toBe(0);
  });
});

describe("CardRegistry", () => {
  it("looks cards up by id", () => {
    resetCardIds();
    const unit = makeUnit(3, ["fury"]);
    const registry = CardRegistry.from([unit]);

    expect(registry.size).toBe(1);
    expect(registry.has(unit.id)).toBe(true);
    expect(registry.get(unit.id)).toBe(unit);
    expect(registry.mustGet(unit.id)).toBe(unit);
  });

  it("returns undefined for unknown ids but throws from mustGet", () => {
    const registry = CardRegistry.from([]);
    const missing = cardId("OGN-000");

    expect(registry.get(missing)).toBeUndefined();
    expect(() => registry.mustGet(missing)).toThrow(/Unknown card id/);
  });

  it("rejects duplicate ids rather than silently overwriting", () => {
    const first = makeUnit(3, ["fury"], { id: cardId("OGN-1"), name: "First" });
    const second = makeRune("calm", { id: cardId("OGN-1"), name: "Second" });

    expect(() => CardRegistry.from([first, second])).toThrow(
      /Duplicate card id OGN-1/,
    );
  });
});

describe("supertypes (rule 133.7)", () => {
  it("recognises a Champion Unit", () => {
    expect(isChampionUnit(makeUnit(3, ["fury"], { champion: true }))).toBe(
      true,
    );
    expect(isChampionUnit(makeUnit(3, ["fury"], { champion: false }))).toBe(
      false,
    );
  });

  it("applies exclusively to Units (133.7.a)", () => {
    // A Legend is the deck's Champion Legend, not a Champion Unit.
    expect(isChampionUnit(makeLegend(["fury"]))).toBe(false);
  });

  it("recognises the Signature supertype on any card type (133.7.b)", () => {
    expect(isSignature(makeUnit(3, ["fury"], { signature: true }))).toBe(true);
    expect(isSignature(makeSpell(["fury"], { signature: true }))).toBe(true);
    expect(isSignature(makeSpell(["fury"]))).toBe(false);
  });

  it("carries a Champion Tag in its own field, not among the free-form tags", () => {
    // Rule 133.8.a gives ordinary tags no rules meaning, so the tag that does
    // have one is kept apart from them.
    const card = makeUnit(3, ["fury"], {
      championTag: "Jinx",
      tags: ["rebel"],
    });
    expect(card.championTag).toBe("Jinx");
    expect(card.tags).toEqual(["rebel"]);
  });
});
