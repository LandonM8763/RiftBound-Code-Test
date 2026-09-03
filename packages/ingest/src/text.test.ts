/**
 * Parsing printed card text into the effect model.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 * Every input below is real text from the card export, not invented.
 */
import { UNMODELLED_KEYWORDS } from "@riftbound/cards";
import { describe, expect, it } from "vitest";

import { parseCardText, parseEffects, stripReminders } from "./text.js";

describe("preprocessing", () => {
  it("drops reminder text, which restates a rule rather than adding one", () => {
    expect(
      stripReminders(
        "ACCELERATE (You may pay 1 Fury to have me enter ready.)",
      ).trim(),
    ).toBe("ACCELERATE");
  });

  it("reads a keyword whether or not the export bracketed it", () => {
    // The same keyword appears as `[Tank]` on some cards and `Tank` on others.
    for (const text of ["[TANK]", "TANK"]) {
      expect(parseCardText(text).keywords).toEqual([{ kind: "tank" }]);
    }
  });

  it("ignores a bare timing marker, which became SpellCard.timing at ingest", () => {
    expect(parseCardText("ACTION").unparsed).toEqual([]);
    expect(parseCardText("REACTION").unparsed).toEqual([]);
  });
});

describe("effect clauses", () => {
  it("parses a draw", () => {
    expect(parseEffects("Draw 1")).toEqual({
      target: { kind: "none" },
      effects: [{ kind: "draw", count: 1 }],
    });
  });

  it("parses damage with the target it names (355.9.b)", () => {
    expect(parseEffects("Deal 3 to a unit at a battlefield")).toEqual({
      target: { kind: "unit", scope: "any", atBattlefield: true },
      effects: [{ kind: "dealDamage", amount: 3 }],
    });
  });

  it("narrows the target by scope", () => {
    expect(
      parseEffects("Give a friendly unit +2 Might this turn")?.target,
    ).toEqual({
      kind: "unit",
      scope: "friendly",
    });
    expect(parseEffects("Deal 2 to an enemy unit")?.target).toEqual({
      kind: "unit",
      scope: "enemy",
    });
  });

  it('parses a sequence joined by "then", in order (359.2.b)', () => {
    expect(
      parseEffects("Deal 4 to a unit at a battlefield, then draw 1"),
    ).toEqual({
      target: { kind: "unit", scope: "any", atBattlefield: true },
      effects: [
        { kind: "dealDamage", amount: 4 },
        { kind: "draw", count: 1 },
      ],
    });
  });

  it("parses kill, ready, buff, discard and channel", () => {
    expect(parseEffects("Kill a unit at a battlefield")?.effects).toEqual([
      { kind: "kill" },
    ]);
    expect(parseEffects("Ready a unit")?.effects).toEqual([{ kind: "ready" }]);
    expect(parseEffects("Buff a friendly unit")?.effects).toEqual([
      { kind: "buff" },
    ]);
    expect(parseEffects("Discard 1")?.effects).toEqual([
      { kind: "discard", count: 1 },
    ]);
    expect(parseEffects("Channel 1 rune exhausted")?.effects).toEqual([
      { kind: "channel", count: 1, exhausted: true },
    ]);
  });

  it("defaults Channel to ready (430.2.a)", () => {
    expect(parseEffects("Channel 2 runes")?.effects).toEqual([
      { kind: "channel", count: 2, exhausted: false },
    ]);
  });

  it("parses an Add ability`s resources (rule 429)", () => {
    expect(parseEffects("ADD 1")?.effects).toEqual([
      { kind: "addEnergy", count: 1 },
    ]);
    expect(parseEffects("ADD calm")?.effects).toEqual([
      { kind: "addPower", domain: "calm", count: 1 },
    ]);
  });

  it("reads number words as well as digits", () => {
    expect(parseEffects("Draw two")?.effects).toEqual([
      { kind: "draw", count: 2 },
    ]);
  });

  it("refuses two clauses that want different targets", () => {
    // CardEffect carries one target for the whole card, so a card that damages
    // one Unit and buffs another cannot be represented — and must not be
    // represented approximately.
    expect(
      parseEffects("Deal 2 to an enemy unit, then buff a friendly unit"),
    ).toBeUndefined();
  });

  it("refuses a clause outside the grammar", () => {
    expect(parseEffects("Banish a unit")).toBeUndefined();
    expect(parseEffects("Banish a unit")).toBeUndefined();
  });
});

describe("self-targeting", () => {
  it('reads "me" as the card the text is printed on', () => {
    expect(parseEffects("Ready me")).toEqual({
      target: { kind: "self" },
      effects: [{ kind: "ready" }],
    });
  });

  it("covers the wordings the cards use", () => {
    const cases = [
      ["Buff me", { kind: "buff" }],
      ["Heal me", { kind: "heal" }],
      ["Exhaust me", { kind: "exhaust" }],
      ["Recall me", { kind: "recall" }],
    ] as const;
    for (const [text, effect] of cases) {
      expect(parseEffects(text)).toEqual({
        target: { kind: "self" },
        effects: [effect],
      });
    }
    expect(parseEffects("Give me +2 Might this turn")).toEqual({
      target: { kind: "self" },
      effects: [{ kind: "giveMight", amount: 2 }],
    });
  });

  it('splits clauses joined by "and" as well as "then"', () => {
    // "Ready me and give me +1 Might this turn" is two effects on one target.
    expect(parseEffects("Ready me and give me +1 Might this turn")).toEqual({
      target: { kind: "self" },
      effects: [{ kind: "ready" }, { kind: "giveMight", amount: 1 }],
    });
  });

  it('refuses to mix "me" with a chosen Unit', () => {
    // One target per card: "me" and "a unit" cannot both be the target.
    expect(parseEffects("Ready me and buff a friendly unit")).toBeUndefined();
  });

  it("parses a self-targeting activated ability end to end", () => {
    const ability =
      parseCardText("Exhaust: Buff me.").abilities?.activated?.[0];
    expect(ability?.effect).toEqual({
      target: { kind: "self" },
      effects: [{ kind: "buff" }],
    });
  });
});

describe("triggered abilities (rule 383)", () => {
  it("parses a Play Effect (383.4.a)", () => {
    const parsed = parseCardText("When you play me, draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: "played", subject: "self" },
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "draw", count: 1 }],
      },
    });
  });

  it("parses the conditions that are about the source itself", () => {
    const conditions = [
      ["When I die, draw 1.", { event: "dies", subject: "self" }],
      ["When I move, draw 1.", { event: "move", subject: "self" }],
      ["When I win a combat, draw 1.", { event: "winCombat", subject: "self" }],
      ["When you buff me, draw 1.", { event: "buffed", subject: "self" }],
    ] as const;
    for (const [text, condition] of conditions) {
      expect(parseCardText(text).abilities?.triggered?.[0]?.condition).toEqual(
        condition,
      );
    }
  });

  it("parses the conditions that are about the player", () => {
    const conditions = [
      [
        "At the end of your turn, draw 1.",
        { event: "endOfTurn", subject: "you" },
      ],
      [
        "At the start of your Beginning Phase, draw 1.",
        { event: "beginningPhase", subject: "you" },
      ],
      ["When you conquer, draw 1.", { event: "conquer", subject: "you" }],
      [
        "When you win a combat, draw 1.",
        { event: "winCombat", subject: "you" },
      ],
      [
        "When you discard one or more cards, draw 1.",
        { event: "discard", subject: "you" },
      ],
    ] as const;
    for (const [text, condition] of conditions) {
      expect(parseCardText(text).abilities?.triggered?.[0]?.condition).toEqual(
        condition,
      );
    }
  });

  it('marks a leading "you may" as optional (383.3.a)', () => {
    const parsed = parseCardText("When you play me, you may draw 1.");
    expect(parsed.abilities?.triggered?.[0]?.optional).toBe(true);
  });

  it("leaves a mandatory trigger unmarked", () => {
    expect(
      parseCardText("When you play me, draw 1.").abilities?.triggered?.[0]
        ?.optional,
    ).toBeUndefined();
  });

  it("refuses a condition it does not know", () => {
    // "When you recycle a rune" is a real condition with no event behind it.
    expect(parseCardText("When you recycle a rune, draw 2.").unparsed).toEqual([
      "When you recycle a rune, draw 2.",
    ]);
  });
});

describe("trigger subjects and filters", () => {
  const conditionOf = (text: string) =>
    parseCardText(text).abilities?.triggered?.[0]?.condition;

  it('separates "I die" from "a friendly unit dies" by subject alone', () => {
    // The same event; only the relationship to the source differs. That is the
    // distinction the old one-variant-per-wording shape could not make.
    expect(conditionOf("When I die, draw 1.")).toEqual({
      event: "dies",
      subject: "self",
    });
    expect(conditionOf("When a friendly unit dies, draw 1.")).toEqual({
      event: "dies",
      subject: "friendly",
    });
    expect(conditionOf("When one or more enemy units die, draw 1.")).toEqual({
      event: "dies",
      subject: "enemy",
    });
  });

  it("reads a card type filter", () => {
    expect(conditionOf("When you play a spell, draw 1.")).toEqual({
      event: "played",
      subject: "you",
      filter: { cardType: "spell" },
    });
    expect(conditionOf("When you play a gear, draw 1.")).toEqual({
      event: "played",
      subject: "you",
      filter: { cardType: "gear" },
    });
  });

  it('reads "another" as excluding the source', () => {
    expect(conditionOf("When you play another unit, draw 1.")).toEqual({
      event: "played",
      subject: "you",
      filter: { cardType: "unit", excludeSelf: true },
    });
  });

  it("reads a cost threshold against the printed cost (356.1.c)", () => {
    expect(
      conditionOf("When you play a spell that costs 5 or more, draw 1."),
    ).toEqual({
      event: "played",
      subject: "you",
      filter: { cardType: "spell", minEnergy: 5 },
    });
    expect(
      conditionOf(
        "When you play a card with power cost 2 runes or more, draw 1.",
      ),
    ).toEqual({
      event: "played",
      subject: "you",
      filter: { minPower: 2 },
    });
  });

  it("reads an ordinal, which picks the occurrence rather than capping it", () => {
    expect(
      conditionOf("When you play your second card in a turn, draw 1."),
    ).toEqual({
      event: "played",
      subject: "you",
      filter: { ordinal: 2 },
    });
  });

  it('reads "here" as a place filter', () => {
    expect(conditionOf("When you conquer here, draw 1.")).toEqual({
      event: "conquer",
      subject: "you",
      filter: { here: true },
    });
    // "I conquer" is the source's own Battlefield being Conquered — a Conquer
    // has no Game Object for a `self` subject to be about.
    expect(conditionOf("When I conquer, draw 1.")).toEqual({
      event: "conquer",
      subject: "you",
      filter: { here: true },
    });
  });

  it('turns "the first time ... each turn" into a per-turn limit (383.3.e)', () => {
    const ability = parseCardText("The first time I conquer each turn, draw 1.")
      .abilities?.triggered?.[0];
    expect(ability?.condition).toEqual({
      event: "conquer",
      subject: "you",
      filter: { here: true },
    });
    expect(ability?.limitPerTurn).toBe(1);
  });

  it('446: reads which end of the Move a Location filter is about', () => {
    // The Move event carries both ends now, so "from a battlefield" is a
    // `direction` on the filter rather than a wording the grammar must refuse.
    const parsed = parseCardText("When I move from a battlefield, draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.condition).toEqual({
      event: "move",
      subject: "self",
      filter: { direction: "from" },
    });
  });
});

describe("keywords (rules 800-828)", () => {
  it("reads the keywords that are rules of the engine", () => {
    for (const [text, keyword] of [
      ["TANK", { kind: "tank" }],
      ["GANKING", { kind: "ganking" }],
      ["BACKLINE", { kind: "backline" }],
    ] as const) {
      expect(parseCardText(text)).toEqual({
        keywords: [keyword],
        unparsed: [],
      });
    }
  });

  it("defaults an omitted keyword value to 1 (807.1.b.3)", () => {
    expect(parseCardText("ASSAULT").keywords).toEqual([
      { kind: "assault", value: 1 },
    ]);
    expect(parseCardText("SHIELD").keywords).toEqual([
      { kind: "shield", value: 1 },
    ]);
  });

  it("reads a printed keyword value", () => {
    expect(parseCardText("ASSAULT 2").keywords).toEqual([
      { kind: "assault", value: 2 },
    ]);
  });

  it("collects several keywords from several lines", () => {
    const parsed = parseCardText("SHIELD\nTANK");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.keywords).toEqual([
      { kind: "shield", value: 1 },
      { kind: "tank" },
    ]);
  });

  it("801.3.a: grants a keyword by effect, to a chosen Unit for one turn", () => {
    // This was refused while the only way to say it was a static, which grants
    // to a *scope* for as long as its source is on the Board — the wrong Unit,
    // and never taken away. `grantKeyword` puts it on the recipient instead,
    // where 317.2.c expires it.
    expect(parseCardText("Give a unit ASSAULT 3 this turn.").effect).toEqual({
      target: { kind: "unit", scope: "any" },
      effects: [
        { kind: "grantKeyword", keyword: { kind: "assault", value: 3 } },
      ],
    });
  });

  it("refuses a grant with no stated duration", () => {
    // A permanent grant is different storage and a different mechanic; giving
    // it an expiry the card never printed would be a guess.
    expect(parseCardText("Give a unit ASSAULT 2.").unparsed).toHaveLength(1);
  });

  it('desugars Deathknell into the "when I die" trigger it is short for (808.1.c)', () => {
    const parsed = parseCardText("DEATHKNELL - Draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: "dies", subject: "self" },
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "draw", count: 1 }],
      },
    });
    // Not a Keyword: the glossary defines it *as* the trigger, so a second way
    // to say it would be a second code path.
    expect(parsed.keywords).toBeUndefined();
  });

  it("desugars Temporary into a Beginning Phase self-kill (816.1.b)", () => {
    const parsed = parseCardText("TEMPORARY");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: "beginningPhase", subject: "you" },
      effect: { target: { kind: "self" }, effects: [{ kind: "kill" }] },
    });
  });

  it("reads Legion as a dependency on an ordinary ability (812.1.b.1)", () => {
    const parsed = parseCardText("LEGION - When you play me, draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: "played", subject: "self" },
      dependsOn: { kind: "legion" },
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "draw", count: 1 }],
      },
    });
  });

  it("gates a passive as readily as a trigger (812.1.b)", () => {
    // The Legion Ability is the whole clause after the keyword, whatever kind
    // of ability that is — a cost modifier counts.
    expect(
      parseCardText("LEGION - I cost 2 less.").abilities?.costModifiers?.[0],
    ).toEqual({
      applies: { scope: "self" },
      change: { kind: "discount", energy: 2 },
      dependsOn: { kind: "legion" },
    });
  });

  it("refuses a Legion clause with nothing to hang the dependency on", () => {
    // A bare effect is not an ability: there is nowhere to record the gate, so
    // reading it would make the effect unconditional.
    expect(parseCardText("LEGION - Draw 1.").unparsed).toHaveLength(1);
  });

  it("has nothing left to refuse: every keyword is modelled", () => {
    // The table is empty, and `REFUSED_KEYWORDS` guards that case explicitly —
    // built from no keys the alternation becomes `\b()\b`, which matches
    // every string and would silently refuse the whole corpus.
    expect(Object.keys(UNMODELLED_KEYWORDS)).toEqual([]);
    expect(parseCardText("Draw 1.").unparsed).toEqual([]);
  });

  it("805: Accelerate is no longer among them, because it now desugars", () => {
    // It was refused for wanting rule 356.2, which now exists. The keyword is
    // shorthand for an ability the model has, so it becomes that ability.
    expect(Object.keys(UNMODELLED_KEYWORDS)).not.toContain("accelerate");
    expect(parseCardText("ACCELERATE", { domains: ["fury"] }).unparsed).toEqual(
      [],
    );
  });
});

describe("activated abilities (rule 377)", () => {
  it("parses the exhaust symbol as the whole cost (414)", () => {
    const parsed = parseCardText("Exhaust: Draw 1.");
    expect(parsed.abilities?.activated?.[0]).toEqual({
      cost: { energy: 0, power: [] },
      exhaustSelf: true,
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "draw", count: 1 }],
      },
    });
  });

  it("parses an Energy cost alongside the exhaust", () => {
    expect(
      parseCardText("1, Exhaust: Draw 1.").abilities?.activated?.[0]?.cost,
    ).toEqual({
      energy: 1,
      power: [],
    });
  });

  it("parses a cost with no exhaust", () => {
    const ability = parseCardText("2: Draw 1.").abilities?.activated?.[0];
    expect(ability?.cost.energy).toBe(2);
    expect(ability?.exhaustSelf).toBe(false);
  });

  it("strips a timing marker printed inside the ability body", () => {
    // "Exhaust: REACTION - ADD 1" — the marker is timing, not effect.
    const ability = parseCardText("Exhaust: REACTION - ADD 1.").abilities
      ?.activated?.[0];
    expect(ability?.effect.effects).toEqual([{ kind: "addEnergy", count: 1 }]);
  });

  it("refuses an ability whose restriction it cannot model", () => {
    // "Use only to play spells" is a real restriction; dropping it would make
    // the ability strictly better than the card.
    expect(
      parseCardText("Exhaust: REACTION - ADD 1. Use only to play spells.")
        .unparsed,
    ).not.toEqual([]);
  });
});

describe("tokens (rules 179-187)", () => {
  it("reads the plain form and looks the token up in rule 187", () => {
    expect(
      parseCardText("Play a 1 Might Recruit unit token here.").effect,
    ).toEqual({
      target: { kind: "none" },
      effects: [
        { kind: "createToken", token: "recruit", count: 1, where: "here" },
      ],
    });
  });

  it("reads a count, written as a word or a digit", () => {
    const two = parseCardText(
      "Play two 1 Might Recruit unit token here.",
    ).effect;
    expect(two?.effects[0]).toMatchObject({ count: 2 });

    const four = parseCardText("Play four 1 Might Recruit unit tokens.").effect;
    expect(four?.effects[0]).toMatchObject({ count: 4 });
  });

  it('184.1: "ready" overrides the default of entering exhausted', () => {
    const parsed = parseCardText(
      "Play a ready 3 Might Sprite unit token with TEMPORARY here.",
    );
    expect(parsed.effect?.effects[0]).toMatchObject({
      token: "sprite",
      ready: true,
      where: "here",
    });
  });

  it("184.2: reads the location, defaulting to the Base when none is printed", () => {
    const base = parseCardText(
      "Play a 1 Might Recruit unit token in your base.",
    ).effect;
    expect(base?.effects[0]).toMatchObject({ where: "base" });

    const into = parseCardText(
      "Play three 1 might Recruit unit tokens into your base.",
    ).effect;
    expect(into?.effects[0]).toMatchObject({ where: "base", count: 3 });

    const bare = parseCardText("Play a 1 Might Recruit unit token.").effect;
    expect(bare?.effects[0]).toMatchObject({ where: "base" });
  });

  it("refuses a token rule 187 does not define", () => {
    // Inventing a Dragon token would put a Unit on the Board that no rule
    // describes — the plausible-and-wrong card the gap model exists to stop.
    expect(
      parseCardText("Play a 5 Might Dragon unit token here.").unparsed,
    ).toHaveLength(1);
  });

  it("refuses a Might that disagrees with rule 187", () => {
    // 187.1 fixes the Recruit at 1 Might. A card printing 4 is not describing
    // that token, so believing either number would be a guess.
    expect(
      parseCardText("Play a 4 Might Recruit unit token here.").unparsed,
    ).toHaveLength(1);
  });

  it("refuses a keyword rule 187 does not give that token", () => {
    expect(
      parseCardText("Play a 1 Might Recruit unit token with TEMPORARY here.")
        .unparsed,
    ).toHaveLength(1);
  });

  it("refuses a type that disagrees with rule 187", () => {
    expect(
      parseCardText("Play a 1 Might Recruit gear token here.").unparsed,
    ).toHaveLength(1);
  });

  it("combines with a trigger, which is how the corpus prints it", () => {
    const parsed = parseCardText(
      "When you play me, play a 1 Might Recruit unit token here.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toMatchObject({
      condition: { event: "played", subject: "self" },
      effect: { effects: [{ kind: "createToken", token: "recruit" }] },
    });
  });
});

describe("granted keywords and wider conditions", () => {
  it('grants to "me" as well as to a chosen Unit', () => {
    expect(parseCardText("Give me GANKING this turn.").effect).toEqual({
      target: { kind: "self" },
      effects: [{ kind: "grantKeyword", keyword: { kind: "ganking" } }],
    });
  });

  it("narrows the recipient by scope", () => {
    expect(
      parseCardText("Give a friendly unit TANK this turn.").effect?.target,
    ).toEqual({
      kind: "unit",
      scope: "friendly",
    });
  });

  it("refuses a keyword the engine does not model", () => {
    // 801.3.a makes a granted keyword do what a printed one does, so granting
    // one the engine ignores is the same wrong card as printing it.
    expect(
      parseCardText("Give a unit DEFLECT this turn.").unparsed,
    ).toHaveLength(1);
  });

  it("801.3.a: grants two keywords from one clause, as two grants", () => {
    // The whole line is matched before `parseEffects` splits on "and", which is
    // what keeps the two halves of one grant together.
    const parsed = parseCardText("Give a unit SHIELD 3 and TANK this turn.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.effect?.effects).toEqual([
      { kind: "grantKeyword", keyword: { kind: "shield", value: 3 } },
      { kind: "grantKeyword", keyword: { kind: "tank" } },
    ]);
  });

  it("still fails the whole clause when one of the two is unmodelled", () => {
    // Half a grant is the wrong card, so an unreadable second keyword loses
    // the first as well.
    expect(
      parseCardText("Give a unit SHIELD 3 and REPEAT 2 this turn.").unparsed,
    ).toHaveLength(1);
  });

  it('161.1.a: reads "while you have 8+ runes" as a count of the Board', () => {
    expect(
      parseCardText("While you have 8+ runes, I have +4 Might.").abilities
        ?.statics?.[0],
    ).toEqual({
      affects: { who: "self" },
      grant: { might: 4 },
      condition: { kind: "controls", who: "you", what: "rune", min: 8 },
    });
  });

  it('355.9: reads "another unit here" with both here and excludeSelf', () => {
    expect(
      parseCardText("While you have another unit here, I have +1 Might.")
        .abilities?.statics?.[0],
    ).toEqual({
      affects: { who: "self" },
      grant: { might: 1 },
      condition: {
        kind: "controls",
        who: "you",
        what: "unit",
        min: 1,
        here: true,
        excludeSelf: true,
      },
    });
  });

  it('refuses a "while" whose predicate it cannot read', () => {
    // Dropping the condition would make the static unconditional, which is
    // strictly stronger than the printed card.
    expect(
      parseCardText("While I've moved twice this turn, I have +2 Might.").unparsed,
    ).toHaveLength(1);
  });
});

describe("zone movement", () => {
  it("reads a bounce off the Board", () => {
    expect(
      parseCardText("Return a unit at a battlefield to its owner's hand.")
        .effect,
    ).toEqual({
      target: { kind: "unit", scope: "any", atBattlefield: true },
      effects: [{ kind: "toHand" }],
    });
  });

  it("reads the friendly and enemy scopes", () => {
    expect(
      parseCardText("Return a friendly unit to its owner's hand.").effect
        ?.target,
    ).toEqual({
      kind: "unit",
      scope: "friendly",
    });
    expect(
      parseCardText("Return an enemy unit to its owner's hand.").effect?.target,
    ).toEqual({
      kind: "unit",
      scope: "enemy",
    });
  });

  it("reads the self form", () => {
    expect(parseCardText("Return me to my owner's hand.").effect).toEqual({
      target: { kind: "self" },
      effects: [{ kind: "toHand" }],
    });
  });

  it("reads a retrieval as the same effect with a different target", () => {
    // Bounce and retrieve are one primitive: only the target differs.
    expect(
      parseCardText("Return a unit from your trash to your hand.").effect,
    ).toEqual({
      target: { kind: "trashCard", cardTypes: ["unit"] },
      effects: [{ kind: "toHand" }],
    });
    expect(
      parseCardText("Return a spell from your trash to your hand.").effect
        ?.target,
    ).toEqual({
      kind: "trashCard",
      cardTypes: ["spell"],
    });
  });

  it('355.9: reads "another" as an excludeSelf, so the card cannot bounce itself', () => {
    const parsed = parseCardText(
      "When you play me, return another unit at a battlefield to its owner's hand.",
    );
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.triggered?.[0]?.effect.target).toEqual({
      kind: "unit",
      scope: "any",
      atBattlefield: true,
      excludeSelf: true,
    });
  });

  it("143: reads a Might bound on the bounced Unit", () => {
    // `unitTarget` has carried `maxMight` since the counted-target round; this
    // clause stayed anchored against it long after it existed.
    const parsed = parseCardText(
      "Return a unit at a battlefield with 3 Might or less to its owner's hand.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toMatchObject({
      kind: "unit",
      atBattlefield: true,
      maxMight: 3,
    });
  });

  it("412: bounces a Gear, narrowing the sweep rather than the effect", () => {
    const parsed = parseCardText("Return a gear to its owner's hand.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.effect?.target).toEqual({
      kind: "unit",
      scope: "any",
      cardType: "gear",
    });
    expect(parsed.effect?.effects).toEqual([{ kind: "toHand" }]);
  });

  it("416: refuses Recycle as an effect, which measured +0 cards", () => {
    // Recycle is a real Game Action and the engine performs it for Runes
    // (164.2.b) and Burn Out (431.2.b). As a *card effect* it unlocks nothing,
    // so it is deliberately absent — see the note in `cards/effect.ts`.
    expect(parseCardText("Recycle me.").unparsed).toHaveLength(1);
    expect(parseCardText("Recycle 3 from your trash.").unparsed).toHaveLength(
      1,
    );
  });
});

describe("Accelerate (rule 805)", () => {
  it('805.1.a: desugars to an optional cost plus "if you do, I enter ready"', () => {
    const parsed = parseCardText("ACCELERATE", { domains: ["fury"] });

    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.additionalCosts).toEqual([
      {
        optional: true,
        pay: { kind: "resources", cost: { energy: 1, power: ["fury"] } },
      },
    ]);
    expect(parsed.abilities?.statics).toEqual([
      {
        affects: { who: "self" },
        grant: { entersReady: true },
        condition: { kind: "paidAdditionalCost" },
      },
    ]);
  });

  it("805.1.a.1: takes the Power from the Unit's own Domain", () => {
    const parsed = parseCardText("ACCELERATE", { domains: ["order"] });
    expect(parsed.abilities?.additionalCosts?.[0]?.pay).toMatchObject({
      cost: { energy: 1, power: ["order"] },
    });
  });

  it("refuses a multi-Domain Unit, where 805.1.a.1 is a choice", () => {
    // "a Power that matches one of the domains" — picking one would be a guess,
    // and `Cost` has no way to say "either".
    expect(
      parseCardText("ACCELERATE", { domains: ["fury", "calm"] }).unparsed,
    ).toEqual(["ACCELERATE"]);
  });

  it("refuses a domainless Unit, where 805.1.a.2 means any Domain", () => {
    expect(parseCardText("ACCELERATE", { domains: [] }).unparsed).toEqual([
      "ACCELERATE",
    ]);
  });

  it("refuses it when the caller supplies no Domains at all", () => {
    expect(parseCardText("ACCELERATE").unparsed).toEqual(["ACCELERATE"]);
  });

  it("820.1.d: Repeat is an optional cost plus a second execution", () => {
    const parsed = parseCardText(
      "REPEAT 2\nGive a unit +2 Might this turn.",
      { domains: ["fury"] },
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.additionalCosts).toEqual([
      { optional: true, pay: { kind: "resources", cost: { energy: 2, power: [] } } },
    ]);
    expect(parsed.effect?.repeat).toBe(true);
  });

  it("820.1.c: reads a Power cost, and refuses a Repeat with none printed", () => {
    const power = parseCardText("REPEAT Chaos\nDraw 1.");
    expect(power.unparsed).toEqual([]);
    expect(power.abilities?.additionalCosts?.[0]?.pay).toEqual({
      kind: "resources",
      cost: { energy: 0, power: ["chaos"] },
    });

    // A Repeat with no cost at all would be a free second execution, which is
    // a stronger card than 820.1.c describes.
    expect(parseCardText("REPEAT\nDraw 1.").unparsed).toContain("REPEAT");
  });

  it("820.1.c.2: refuses a second instance, which is a second choice", () => {
    expect(
      parseCardText("REPEAT 2\nREPEAT 3\nDraw 1.").unparsed,
    ).toHaveLength(1);
  });
});

describe("the all-or-nothing rule", () => {
  it("refuses a card whose clause carries a condition it cannot express", () => {
    // Reducing this to "deal 6" would produce a card that plays, looks right
    // and is wrong — worse than leaving it vanilla.
    const text =
      "Choose an enemy unit. Deal 6 to it unless its controller has you draw 2.";
    expect(parseCardText(text).unparsed.length).toBeGreaterThan(0);
  });

  it("refuses a card carrying a keyword the engine does not model", () => {
    // An Accelerate that forgets it is one is a wrong card, not a simpler one.
    const parsed = parseCardText("ACCELERATE\nWhen you play me, draw 1.");
    expect(parsed.unparsed).toContain("ACCELERATE");
  });

  it("drops a modelled keyword too when another clause fails", () => {
    // All-or-nothing applies to keywords as well: a card that keeps its Tank
    // but loses the ability printed under it is still the wrong card.
    const parsed = parseCardText("TANK\nBanish a unit.");
    expect(parsed.unparsed).toEqual(["Banish a unit."]);
  });

  it("reports every clause it could not read, not just the first", () => {
    const parsed = parseCardText("Banish a unit.\nReveal your hand.");
    expect(parsed.unparsed).toHaveLength(2);
  });

  it("returns nothing at all for text it fully understands but that has no effect", () => {
    expect(parseCardText("ACTION")).toEqual({ unparsed: [] });
  });
});

describe("real cards from the export", () => {
  it("parses Hextech Ray", () => {
    const parsed = parseCardText(
      "ACTION (Play on your turn or in showdowns.)\nDeal 3 to a unit at a battlefield.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect).toEqual({
      target: { kind: "unit", scope: "any", atBattlefield: true },
      effects: [{ kind: "dealDamage", amount: 3 }],
    });
  });

  it("parses Void Seeker, which does two things in order", () => {
    const parsed = parseCardText(
      "ACTION (Play on your turn or in showdowns.)\nDeal 4 to a unit at a battlefield, then draw 1.",
    );
    expect(parsed.effect?.effects).toEqual([
      { kind: "dealDamage", amount: 4 },
      { kind: "draw", count: 1 },
    ]);
  });

  it("parses Blast of Power", () => {
    const parsed = parseCardText(
      "ACTION (Play on your turn or in showdowns.)\nKill a unit at a battlefield.",
    );
    expect(parsed.effect?.effects).toEqual([{ kind: "kill" }]);
  });

  it("leaves Blazing Scorcher vanilla, because Accelerate is not modelled", () => {
    const parsed = parseCardText(
      "ACCELERATE (You may pay 1 Fury as an additional cost to have me enter ready.)",
    );
    expect(parsed.unparsed).toEqual(["ACCELERATE"]);
    expect(parsed.effect).toBeUndefined();
  });
});

describe("cost modifiers (rules 356, 363)", () => {
  const modifiersOf = (text: string) =>
    parseCardText(text).abilities?.costModifiers;

  it("reads a flat self-discount", () => {
    expect(modifiersOf("I cost 2 less.")).toEqual([
      { applies: { scope: "self" }, change: { kind: "discount", energy: 2 } },
    ]);
  });

  it('reads the "this costs" wording as the same thing', () => {
    expect(modifiersOf("This costs 2 less.")).toEqual(
      modifiersOf("I cost 2 less."),
    );
  });

  it("reads a counted discount rather than a flat one", () => {
    expect(modifiersOf("I cost 1 less for each card in your trash.")).toEqual([
      {
        applies: { scope: "self" },
        change: {
          kind: "discount",
          per: { count: { kind: "cardsInTrash" }, energy: 1 },
        },
      },
    ]);
  });

  it("reads a per-discount minimum (356.4.e)", () => {
    expect(
      modifiersOf(
        "I cost 1 less for each card you've played this turn, to a minimum of 1.",
      ),
    ).toEqual([
      {
        applies: { scope: "self" },
        change: {
          kind: "discount",
          per: { count: { kind: "cardsPlayedThisTurn" }, energy: 1 },
          minimumEnergy: 1,
        },
      },
    ]);
  });

  it("gates a discount on a state predicate", () => {
    // "If an enemy unit has died this turn, this costs 2 less" — the condition
    // is the same type a static or an effect would carry.
    expect(
      modifiersOf("If an enemy unit has died this turn, this costs 2 less."),
    ).toEqual([
      {
        applies: { scope: "self" },
        change: { kind: "discount", energy: 2 },
        condition: {
          kind: "didThisTurn",
          event: "dies",
          who: "opponent",
          min: 1,
        },
      },
    ]);
  });

  it("gates a discount on Legion, which is a passive as much as a trigger", () => {
    expect(modifiersOf("LEGION - I cost 2 less.")).toEqual([
      {
        applies: { scope: "self" },
        change: { kind: "discount", energy: 2 },
        dependsOn: { kind: "legion" },
      },
    ]);
  });

  it("reads a counted discount through the shared count grammar", () => {
    // One rule over `COUNTS` rather than a pattern per count. There were three
    // written out longhand, and every count the effect grammar could already
    // read was unavailable here for no reason but that nobody had repeated it.
    const parsed = parseCardText("I cost 2 less for each of your MIGHTY units.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.costModifiers?.[0]).toEqual({
      applies: { scope: "self" },
      change: {
        kind: "discount",
        per: {
          count: { kind: "controlled", who: "you", what: "unit", mighty: true },
          energy: 2,
        },
      },
    });
  });

  it("refuses the cost clauses that want a mechanic instead", () => {
    // Each needs something the model has no representation for — a zone
    // condition, a Battlefield static — so each is refused rather than
    // approximated into a discount that fires at the wrong time.
    const beyond = [
      "I cost 2 less to play from anywhere other than your hand.",
      "While you control this battlefield, friendly gear costs 1 less.",
    ];
    for (const text of beyond) {
      expect(parseCardText(text).unparsed).toHaveLength(1);
    }
  });
});

describe("static abilities (rules 363-365)", () => {
  const staticsOf = (text: string) => parseCardText(text).abilities?.statics;

  it("reads a Might modifier over a scope", () => {
    expect(staticsOf("Other friendly units here have +1 Might.")).toEqual([
      {
        affects: { who: "friendly", here: true, excludeSelf: true },
        grant: { might: 1 },
      },
    ]);
  });

  it("reads a negative modifier, which 143.2.b floors at the total", () => {
    expect(staticsOf("Enemy units here have -2 Might.")?.[0]?.grant).toEqual({
      might: -2,
    });
  });

  it('separates "other" from the plain scope', () => {
    expect(staticsOf("Friendly units have +1 Might.")?.[0]?.affects).toEqual({
      who: "friendly",
    });
    expect(
      staticsOf("Other friendly units have +1 Might.")?.[0]?.affects,
    ).toEqual({
      who: "friendly",
      excludeSelf: true,
    });
  });

  it("reads a granted keyword (801.3.a)", () => {
    expect(staticsOf("Other friendly units here have ASSAULT.")).toEqual([
      {
        affects: { who: "friendly", here: true, excludeSelf: true },
        grant: { keywords: [{ kind: "assault", value: 1 }] },
      },
    ]);
  });

  it("reads several granted keywords at once", () => {
    expect(staticsOf("I have ASSAULT and GANKING.")?.[0]?.grant).toEqual({
      keywords: [{ kind: "assault", value: 1 }, { kind: "ganking" }],
    });
  });

  it('reads a "while" clause as a condition on the source', () => {
    expect(staticsOf("While I'm buffed, I have GANKING.")).toEqual([
      {
        affects: { who: "self" },
        grant: { keywords: [{ kind: "ganking" }] },
        condition: { kind: "buffed" },
      },
    ]);
  });

  it('treats "an additional +N Might" as the same statement', () => {
    expect(
      staticsOf("While I'm buffed, I have an additional +1 Might.")?.[0]?.grant,
    ).toEqual({
      might: 1,
    });
  });

  it('reads "enters ready", the most repeated static clause in the corpus', () => {
    expect(staticsOf("I enter ready.")).toEqual([
      { affects: { who: "self" }, grant: { entersReady: true } },
    ]);
    expect(
      staticsOf("Other friendly units enter ready.")?.[0]?.affects,
    ).toEqual({
      who: "friendly",
      excludeSelf: true,
    });
  });

  it("801.3.a: grants a keyword that desugars, as the ability it stands for", () => {
    // VISION is 817.1.b's Play Effect, so the scope gains that rather than a
    // `Keyword` — a granted keyword does exactly what a printed one does.
    const parsed = parseCardText("Other friendly units have VISION.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "friendly", excludeSelf: true },
      grant: {
        abilities: {
          triggered: [
            {
              condition: { event: "played", subject: "self" },
              optional: true,
              effect: {
                target: { kind: "none" },
                effects: [{ kind: "recycleTop", count: 1 }],
              },
            },
          ],
        },
      },
    });
  });

  it("splits a mixed grant into the engine rule and the ability", () => {
    // GANKING is a rule of the engine; DEFLECT is 809.1.c's cost increase.
    // Both halves have to survive, or the card is wrong.
    const grant = parseCardText("Friendly units have DEFLECT and GANKING.")
      .abilities?.statics?.[0]?.grant;
    expect(grant?.keywords).toEqual([{ kind: "ganking" }]);
    expect(grant?.abilities?.costModifiers).toHaveLength(1);
  });

  it("still refuses a keyword that is neither a rule nor a desugar", () => {
    expect(
      parseCardText("Other friendly units have REPEAT 2.").unparsed,
    ).toHaveLength(1);
  });

  it("reads a Might stated the other way round as the same dynamic grant", () => {
    // "My Might is increased by X" and "I have +1 Might for each X" are one
    // statement written two ways, so the second's `readsMight` guard covers
    // both rather than each having its own builder.
    const parsed = parseCardText("My Might is increased by your points.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "self" },
      grant: { might: 1, per: { kind: "points", who: "you" } },
    });
  });

  it("refuses the static clauses that want a mechanic instead", () => {
    // Each is a real card. A scope the model cannot name or a rule change —
    // neither is a scope-plus-grant, so each is refused rather than bent into
    // one. A *dynamic* Might is no longer here ("increased by your points" is
    // "+1 Might for each …"), nor is a *duration* (390.4 is built).
    const beyond = [
      // "on your trash" is not "in your trash", and a near miss is refused
      // rather than read as the rule it nearly is.
      "My Might is increased by the number of cards on your trash.",
      "I can have any number of buffs.",
      "Stunned enemy units here have -8 Might, to a minimum of 1 Might.",
    ];
    for (const text of beyond) {
      expect(parseCardText(text).unparsed).toHaveLength(1);
    }
  });
});

describe("additional costs (rule 356.2)", () => {
  const costsOf = (text: string) =>
    parseCardText(text).abilities?.additionalCosts;

  it("reads the rulebook`s own worked example (356.2.b.1)", () => {
    // "As you play me, you may discard 1 as an additional cost. If you do,
    // reduce my cost by 2." — two sentences on one printed line.
    const parsed = parseCardText(
      "As you play me, you may discard a card as an additional cost. If you do, reduce my cost by 2.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.additionalCosts).toEqual([
      { pay: { kind: "discard", count: 1 }, optional: true },
    ]);
    expect(parsed.abilities?.costModifiers).toEqual([
      {
        applies: { scope: "self" },
        change: { kind: "discount", energy: 2 },
        condition: { kind: "paidAdditionalCost" },
      },
    ]);
  });

  it('reads "may" as the whole difference between mandatory and optional', () => {
    // 356.2.a.1 vs 356.2.b.1: the rulebook's own test.
    expect(
      costsOf("As an additional cost to play me, kill a friendly unit."),
    ).toEqual([{ pay: { kind: "kill", what: "unit" } }]);
    expect(
      costsOf("You may kill a friendly gear as an additional cost to play me."),
    ).toEqual([{ pay: { kind: "kill", what: "gear" }, optional: true }]);
  });

  it("covers the wordings the cards use", () => {
    expect(
      costsOf(
        "You may exhaust your legend as an additional cost to play me.",
      )?.[0]?.pay,
    ).toEqual({ kind: "exhaustLegend" });
    expect(
      costsOf(
        "As you play this, you may spend a buff as an additional cost.",
      )?.[0]?.pay,
    ).toEqual({ kind: "spendBuff" });
    expect(
      costsOf("As you play me, you may pay 1 Calm as an additional cost.")?.[0]
        ?.pay,
    ).toEqual({ kind: "resources", cost: { energy: 0, power: ["calm"] } });
  });

  it("gates the payoff on having paid, whatever kind of payoff it is", () => {
    const discount = parseCardText(
      "As you play this, you may spend a buff as an additional cost. If you do, ignore this spell's cost.",
    );
    expect(discount.abilities?.costModifiers?.[0]?.change).toEqual({
      kind: "ignoreAll",
    });

    const effect = parseCardText(
      "As you play me, you may pay 1 Calm as an additional cost. If you do, draw 1.",
    );
    expect(effect.effect?.condition).toEqual({ kind: "paidAdditionalCost" });

    const trigger = parseCardText(
      "When you play me, if you paid the additional cost, buff me.",
    );
    expect(trigger.abilities?.triggered?.[0]?.effect.condition).toEqual({
      kind: "paidAdditionalCost",
    });
  });

  it("refuses a variable count, which cannot be proven payable", () => {
    // "any number of" is a choice as well as a quantity, and a cost that might
    // not be payable in full cannot be checked before the card is played.
    for (const text of [
      "As you play me, you may kill any number of friendly units as an additional cost.",
      "As you play me, you may spend any number of buffs as an additional cost.",
    ]) {
      expect(parseCardText(text).unparsed.length).toBeGreaterThan(0);
    }
  });

  it("never merges two effect lines under different conditions", () => {
    // `CardEffect` carries one condition, so merging would make a conditional
    // effect unconditional — strictly stronger than the printed card.
    const parsed = parseCardText(
      "Draw 1.\nIf you paid the additional cost, draw 1.",
    );
    expect(parsed.unparsed.length).toBeGreaterThan(0);
  });
});

describe("dynamic values (counts read off the state)", () => {
  it('reads "draw 1 for each of your MIGHTY units" (706-709)', () => {
    expect(
      parseCardText("Draw 1 for each of your MIGHTY units.").effect,
    ).toEqual({
      target: { kind: "none" },
      effects: [
        {
          kind: "draw",
          count: 1,
          per: { kind: "controlled", who: "you", what: "unit", mighty: true },
        },
      ],
    });
  });

  it('reads a keyword value "equal to" a count', () => {
    expect(
      parseCardText("I have ASSAULT equal to the number of enemy units here.")
        .abilities?.statics?.[0],
    ).toEqual({
      affects: { who: "self" },
      // 807.1.b.3 makes a bare ASSAULT 1, which is the per-unit value scaled.
      grant: {
        keywords: [{ kind: "assault", value: 1 }],
        per: { kind: "controlled", who: "opponent", what: "unit", here: true },
      },
    });
  });

  it('reads "+1 Might for each …" and accepts "get" as well as "have"', () => {
    expect(
      parseCardText(
        "I get +1 might for each buffed friendly unit at my battlefield.",
      ).abilities?.statics?.[0],
    ).toEqual({
      affects: { who: "self" },
      grant: {
        might: 1,
        per: {
          kind: "controlled",
          who: "you",
          what: "unit",
          here: true,
          filter: { buffed: true },
        },
      },
    });
  });

  it("counts other Battlefields, excluding the one it is printed on", () => {
    const parsed = parseCardText(
      "When you conquer here, draw 1 for each other battlefield you or allies control.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.effects[0]).toEqual({
      kind: "draw",
      count: 1,
      per: {
        kind: "controlled",
        who: "you",
        what: "battlefield",
        excludeSelf: true,
      },
    });
  });

  it("refuses a static grant whose count reads Might", () => {
    // `mightOf` consults statics, so a static counting MIGHTY Units would
    // recurse through itself. Refused rather than read as 0, which would be a
    // quietly weaker card.
    expect(
      parseCardText("I have +1 Might for each of your MIGHTY units.").unparsed,
    ).toHaveLength(1);
  });

  it("refuses a count the state cannot answer", () => {
    expect(
      parseCardText("Draw 1 for each card in an opponent hand.").unparsed,
    ).toHaveLength(1);
  });

  it("leaves the plain forms alone", () => {
    expect(parseCardText("Draw 2.").effect?.effects[0]).toEqual({
      kind: "draw",
      count: 2,
    });
    expect(
      parseCardText("Units here have +1 Might.").abilities?.statics?.[0],
    ).toEqual({
      affects: { who: "any", here: true },
      grant: { might: 1 },
    });
  });
});

/**
 * Equip and the Effect Text (rules 136, 137, 718, 818, 819).
 *
 * Two things are being read out of one flat string here, because the export
 * publishes the Rules Text and the Effect Text as one `description` with no
 * marker between them. The Equip line is the marker: 818 makes it an Activated
 * Ability, which 724 would make Inactive if it were Effect Text, so everything
 * printed below it is the Effect Text.
 */
describe("Equip and Effect Text (818, 136.1)", () => {
  it("818.1.c.2: reads Equip as an Activated Ability that Attaches", () => {
    const parsed = parseCardText("EQUIP Fury");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.activated?.[0]).toEqual({
      cost: { energy: 0, power: ["fury"] },
      exhaustSelf: false,
      effect: {
        target: { kind: "unit", scope: "friendly" },
        effects: [{ kind: "attach" }],
      },
    });
  });

  it("reads the three printed cost shapes", () => {
    const cost = (text: string): unknown =>
      parseCardText(text).abilities?.activated?.[0]?.cost;
    expect(cost("EQUIP 1, Fury")).toEqual({ energy: 1, power: ["fury"] });
    expect(cost("EQUIP 1 Body")).toEqual({ energy: 1, power: ["body"] });
    // Printed without a space, which is why the pattern uses a lookahead.
    expect(cost("EQUIP1, Calm")).toEqual({ energy: 1, power: ["calm"] });
  });

  it("818.1.c.3: refuses a non-resource Equip cost rather than reading half", () => {
    // `ActivatedAbility.cost` is Energy and Power. Reading "Order, Kill a
    // friendly unit" as plain Order would make the card cheaper than printed.
    expect(
      parseCardText("EQUIP - Order, Kill a friendly unit").unparsed,
    ).toHaveLength(1);
  });

  it("137: takes the Might Bonus off the end of the Effect Text", () => {
    const parsed = parseCardText("EQUIP Fury\nASSAULT 2\nMight +0");
    expect(parsed.unparsed).toEqual([]);
    // 718.3-718.4: both belong to the Top-Most Card, not to the Gear.
    expect(parsed.attached).toEqual({
      mightBonus: 0,
      keywords: [{ kind: "assault", value: 2 }],
    });
    expect(parsed.keywords).toBeUndefined();
  });

  it("reads a Might Bonus the export glued onto the line above it", () => {
    // "When I conquer, buff me. (reminder)+1 Might" collapses to one line once
    // the reminder is stripped, so the bonus has to be peeled off the tail.
    const parsed = parseCardText(
      "EQUIP Body\nWhen I conquer, buff me.+1 Might",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.attached?.mightBonus).toBe(1);
    expect(parsed.attached?.abilities?.triggered).toHaveLength(1);
  });

  it('does not mistake "give a unit +2 Might this turn" for a Might Bonus', () => {
    // The unpeeled line is tried first for exactly this reason: it parses, so
    // nothing is taken off it.
    const parsed = parseCardText(
      "EQUIP Body\nWhen I conquer, give a unit +2 Might this turn.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.attached?.mightBonus).toBeUndefined();
  });

  it("136.2.b: a card with no Equip line has no Effect Text", () => {
    // Effect Text does nothing unless the card can be Attached, so a Gear that
    // cannot be keeps its abilities as its own.
    const parsed = parseCardText("Exhaust: Draw 1.");
    expect(parsed.attached).toBeUndefined();
    expect(parsed.abilities?.activated).toHaveLength(1);
  });

  it("819.1.d: Quick-Draw desugars into Reaction plus a Play Effect", () => {
    const parsed = parseCardText("QUICK-DRAW\nEQUIP Fury\nMight +2");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.reaction).toBe(true);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: "played", subject: "self" },
      effect: {
        target: { kind: "unit", scope: "friendly" },
        effects: [{ kind: "attach" }],
      },
    });
  });

  it("fails the whole card when the Effect Text does not read", () => {
    // The all-or-nothing rule spans both halves: a Gear that Attaches and then
    // lends nothing is a different card from the one printed.
    const parsed = parseCardText("EQUIP Calm\nI am a mech.\n+1 Might");
    expect(parsed.unparsed).toHaveLength(1);
  });
});

describe("several sentences on one line", () => {
  it("joins two runs of rules text into one ordered effect", () => {
    // "Deal 4 ... . Draw 1." is one run of clauses punctuated with a full stop
    // instead of "then", and 359.2.b reads a card top to bottom either way.
    const parsed = parseCardText("Deal 4 to a unit at a battlefield. Draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect).toEqual({
      target: { kind: "unit", scope: "any", atBattlefield: true },
      effects: [
        { kind: "dealDamage", amount: 4 },
        { kind: "draw", count: 1 },
      ],
    });
  });

  it("refuses two sentences that want different targets", () => {
    // `CardEffect` carries one target for the whole card.
    expect(
      parseCardText("Kill a friendly unit. Deal 2 to an enemy unit.").unparsed,
    ).toHaveLength(1);
  });

  it("still refuses two abilities of the same kind on one line", () => {
    // Merging is for rules text only; a second ability of a kind would
    // silently lose the first.
    expect(
      parseCardText("Exhaust: Draw 1. Exhaust: Draw 2.").unparsed,
    ).toHaveLength(1);
  });
});

describe("Weaponmaster (821)", () => {
  it("821.1.c: desugars into an optional Play Effect that Equips a chosen Gear", () => {
    const parsed = parseCardText("WEAPONMASTER");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: "played", subject: "self" },
      optional: true,
      effect: {
        target: { kind: "gear", scope: "friendly" },
        // 135.2.e.5: the reduction is one `[A]`, printed as "1 Rune less".
        effects: [{ kind: "equip", discountAnyPower: 1 }],
      },
    });
  });

  it("is no longer among the refused keywords", () => {
    expect(Object.keys(UNMODELLED_KEYWORDS)).not.toContain("weaponmaster");
    expect(Object.keys(UNMODELLED_KEYWORDS)).not.toContain("equip");
    expect(Object.keys(UNMODELLED_KEYWORDS)).not.toContain("quick-draw");
    expect(Object.keys(UNMODELLED_KEYWORDS)).not.toContain("deflect");
    expect(Object.keys(UNMODELLED_KEYWORDS)).not.toContain("hidden");
  });
});

describe("Deflect (809)", () => {
  it("809.1.c: desugars into a cost increase gated on choosing this object", () => {
    const parsed = parseCardText("DEFLECT 2");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.costModifiers?.[0]).toEqual({
      applies: {
        types: ["unit", "spell", "gear", "ability"],
        scope: "opponent",
        choosesSource: true,
      },
      // 809.1.c.1: the Power may always be of any Domain, which is `[A]`.
      change: { kind: "increase", anyPower: 2 },
    });
  });

  it("809.1.b.3: an omitted value is 1", () => {
    expect(
      parseCardText("DEFLECT").abilities?.costModifiers?.[0]?.change,
    ).toEqual({
      kind: "increase",
      anyPower: 1,
    });
  });
});

/**
 * Lines the export publishes without their parentheses.
 *
 * Reminder text is stripped before parsing, but the export sometimes flattens a
 * reminder into the rules text — and then the glossary wording for a keyword,
 * or a bare restatement of a rule, arrives where an ability would be.
 */
describe("flattened reminder text", () => {
  it("815.1.b / 826.3: reads the glossary wording as the keyword", () => {
    expect(
      parseCardText("I must be assigned combat damage first.").keywords,
    ).toEqual([{ kind: "tank" }]);
    expect(
      parseCardText("I must be assigned combat damage last.").keywords,
    ).toEqual([{ kind: "backline" }]);
  });

  it("702.3: a line that only restates a rule grants nothing", () => {
    // A token reference card whose whole text is rule 702.3. Understood, with
    // no ability — refusing it would fail a card that has no rules text.
    const parsed = parseCardText(
      "A unit may have no more than one buff at a time.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities).toBeUndefined();
    expect(parsed.keywords).toBeUndefined();
  });

  it("does not read a near-restatement as nothing", () => {
    // The list is closed on purpose: a *near* restatement is how a real ability
    // gets silently dropped.
    expect(
      parseCardText("A unit may have no more than two buffs at a time.")
        .unparsed,
    ).toHaveLength(1);
  });
});

describe("play-location permissions (355.2.b)", () => {
  it('reads "you may play me to an open battlefield"', () => {
    const parsed = parseCardText("You may play me to an open battlefield.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "self" },
      grant: { playTo: ["open"] },
    });
  });

  it("reads the wider scope, and the occupied-enemy case", () => {
    expect(
      parseCardText("Friendly units may be played to open battlefields.")
        .abilities?.statics?.[0],
    ).toEqual({
      affects: { who: "friendly" },
      grant: { playTo: ["open"] },
    });
    expect(
      parseCardText("You may play me to an occupied enemy battlefield.")
        .abilities?.statics?.[0],
    ).toEqual({
      affects: { who: "self" },
      grant: { playTo: ["occupiedEnemy"] },
    });
  });
});

describe("Add (rule 429)", () => {
  it("429.5: reads Energy and Power out of one Add", () => {
    // "Add [1][R]" is one Add of two resources, and Energy and Power are
    // different actions (414 against 416), so it produces both effects.
    expect(parseCardText("ADD 1 Fury.").effect?.effects).toEqual([
      { kind: "addEnergy", count: 1 },
      { kind: "addPower", domain: "fury", count: 1 },
    ]);
  });

  it("counts repeated pips of the same Domain", () => {
    expect(parseCardText("ADD Calm Calm.").effect?.effects).toEqual([
      { kind: "addPower", domain: "calm", count: 2 },
    ]);
  });

  it("leaves the two plain forms alone", () => {
    expect(parseCardText("ADD 2.").effect?.effects).toEqual([
      { kind: "addEnergy", count: 2 },
    ]);
    expect(parseCardText("ADD mind.").effect?.effects).toEqual([
      { kind: "addPower", domain: "mind", count: 1 },
    ]);
  });

  it("still refuses a restricted Add", () => {
    // "Use only to play spells" is a restriction the Rune Pool cannot carry,
    // and reading the Add without it would make the resource more useful than
    // printed.
    expect(
      parseCardText("Exhaust: REACTION - ADD 2. Use only to play spells.")
        .unparsed,
    ).toHaveLength(1);
  });
});

/**
 * Non-resource ability costs (356.7, 377.1, 416.6).
 *
 * The rulebook's own worked examples for 416.3 and 416.5 are Vi Destructive
 * and Garbage Grabber, both of which are real cards in the corpus — so these
 * wordings are the ones to get right.
 */
describe("activated ability costs", () => {
  const activated = (text: string): unknown =>
    parseCardText(text).abilities?.activated?.[0];

  it("377.1: reads Power in the cost, not only Energy", () => {
    expect(activated("1 Calm, Exhaust: Draw 1.")).toEqual({
      cost: { energy: 1, power: ["calm"] },
      exhaustSelf: true,
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "draw", count: 1 }],
      },
    });
    // Printed with no comma before the exhaust, which is how the export gives
    // it — the symbol is glued onto the resource run.
    expect(
      (activated("1 order exhaust: Draw 1.") as { cost: unknown }).cost,
    ).toEqual({
      energy: 1,
      power: ["order"],
    });
  });

  it('416.6: reads "Recycle N from your trash" as a cost payment', () => {
    expect(activated("Recycle 1 from your trash: Draw 1.")).toEqual({
      cost: { energy: 0, power: [] },
      exhaustSelf: false,
      payments: [{ kind: "recycle", count: 1 }],
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "draw", count: 1 }],
      },
    });
  });

  it("reads a cost with resources and a payment mixed", () => {
    // Garbage Grabber, the rulebook's 416.5 example.
    expect(activated("Recycle 3 from your trash, 1, Exhaust: Draw 1.")).toEqual(
      {
        cost: { energy: 1, power: [] },
        exhaustSelf: true,
        payments: [{ kind: "recycle", count: 3 }],
        effect: {
          target: { kind: "none" },
          effects: [{ kind: "draw", count: 1 }],
        },
      },
    );
  });

  it("narrows a Recycle to a card type when the card names one", () => {
    expect(
      (
        activated("Recycle a unit from your trash: Draw 1.") as {
          payments: unknown;
        }
      ).payments,
    ).toEqual([{ kind: "recycle", count: 1, cardType: "unit" }]);
  });

  it('428: "Kill this" names the source, so it needs no choice', () => {
    expect(
      (activated("Kill this: Draw 1.") as { payments: unknown }).payments,
    ).toEqual([{ kind: "killSelf" }]);
  });

  it("refuses a payment the engine cannot prove it can complete", () => {
    // "Banish this" has no Banish action, and a noun that is not a card type
    // cannot be checked against the trash. Both refuse rather than read as
    // free, which would make the ability cheaper than printed.
    expect(parseCardText("Banish this: Draw 1.").unparsed).toHaveLength(1);
    expect(
      parseCardText("Recycle a Poro from your trash: Draw 1.").unparsed,
    ).toHaveLength(1);
  });

  it("leaves the plain forms alone", () => {
    expect(activated("Exhaust: Draw 1.")).toEqual({
      cost: { energy: 0, power: [] },
      exhaustSelf: true,
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "draw", count: 1 }],
      },
    });
    expect((activated("2: Draw 1.") as { cost: unknown }).cost).toEqual({
      energy: 2,
      power: [],
    });
  });
});

describe("effects that affect everything (355.5.a)", () => {
  it('reads "all enemy units in combat"', () => {
    const parsed = parseCardText("Deal 2 to all enemy units in combat.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.effect?.target).toEqual({
      kind: "all",
      scope: "enemy",
      inCombat: true,
    });
    expect(parsed.effect?.effects).toEqual([{ kind: "dealDamage", amount: 2 }]);
  });

  it('reads "all units at battlefields" as every Battlefield', () => {
    expect(
      parseCardText("Deal 1 to all units at battlefields.").effect?.target,
    ).toEqual({
      kind: "all",
      scope: "any",
      atBattlefield: true,
    });
  });

  it('reads "at my battlefield" as 355.9 here, not as every Battlefield', () => {
    expect(
      parseCardText("Deal 4 to all units at my battlefield.").effect?.target,
    ).toEqual({
      kind: "all",
      scope: "any",
      here: true,
    });
  });

  it('refuses "all enemy units at a battlefield", which names a chosen one', () => {
    // The singular is one Battlefield the player picks — a choice `TargetSpec`
    // has no variant for. Reading it as the plural would hit every Battlefield
    // on the board instead of the one chosen.
    expect(
      parseCardText("Deal 3 to all enemy units at a battlefield.").unparsed,
    ).toHaveLength(1);
  });

  it('reads "kill all gear"', () => {
    expect(parseCardText("Kill all gear.").effect?.target).toEqual({
      kind: "all",
      scope: "any",
      cardType: "gear",
    });
  });

  it('702: refuses "buff all gear", which cannot hold a Buff', () => {
    expect(parseCardText("Buff all gear.").unparsed).toHaveLength(1);
  });
});

describe("the target phrase, shared by every clause that takes one", () => {
  it('355.9: reads "here" as the source\'s own Battlefield', () => {
    expect(
      parseCardText("Deal 1 to an enemy unit here.").effect?.target,
    ).toEqual({
      kind: "unit",
      scope: "enemy",
      here: true,
    });
  });

  it('keeps "here" and "at a battlefield" apart', () => {
    expect(
      parseCardText("Deal 1 to an enemy unit at a battlefield.").effect?.target,
    ).toEqual({
      kind: "unit",
      scope: "enemy",
      atBattlefield: true,
    });
  });

  it('reads "another" the same way on every verb', () => {
    for (const line of [
      "Kill another friendly unit.",
      "Buff another friendly unit.",
    ]) {
      expect(parseCardText(line).effect?.target).toEqual({
        kind: "unit",
        scope: "friendly",
        excludeSelf: true,
      });
    }
  });
});

describe("static restrictions (rule 002)", () => {
  it('449.1: reads "Units can\'t move to base"', () => {
    const parsed = parseCardText("Units can't move to base.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "any" },
      grant: { forbid: [{ kind: "moveToBase" }] },
    });
  });

  it('355.9: reads the "from here" form as the same restriction, scoped', () => {
    expect(
      parseCardText("Units can't move from here to base.").abilities
        ?.statics?.[0],
    ).toEqual({
      affects: { who: "any", here: true },
      grant: { forbid: [{ kind: "moveToBase" }] },
    });
  });

  it('carries a "While …" condition onto the restriction', () => {
    expect(
      parseCardText("While I'm at a battlefield, opponents can't score points.")
        .abilities?.statics?.[0],
    ).toEqual({
      affects: { who: "enemy" },
      grant: { forbid: [{ kind: "score" }] },
      condition: { kind: "atBattlefield" },
    });
  });

  it("reads two restrictions on one card as two statics", () => {
    const parsed = parseCardText(
      "While I'm at a battlefield, opponents can only play units to their base.\n" +
        "While I'm at a battlefield, spells and abilities can't ready enemy units and gears.",
    );
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.statics).toHaveLength(2);
  });

  it("refuses a near-miss rather than reading the nearest match", () => {
    // Each is a restriction the engine does not enforce. Reading one as its
    // nearest neighbour would forbid the wrong thing.
    for (const text of [
      "Units can't move from here to a battlefield.",
      "Your opponents' HIDDEN cards can't be revealed here.",
      "Players can't score here until their third turn.",
    ]) {
      expect(parseCardText(text).unparsed, text).toHaveLength(1);
    }
  });
});

describe("reducing Might (143.2)", () => {
  it("reads the signed form with its printed floor", () => {
    const parsed = parseCardText(
      "Give a unit -2 Might this turn, to a minimum of 1 Might.",
    );
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.effect?.effects).toEqual([
      { kind: "giveMight", amount: -2, minimum: 1 },
    ]);
  });

  it("reads the bare plural as a criterion (355.5.a)", () => {
    const parsed = parseCardText(
      "Give enemy units -3 Might this turn, to a minimum of 1 Might.",
    );
    expect(parsed.effect?.target).toEqual({ kind: "all", scope: "enemy" });
    expect(parsed.effect?.effects).toEqual([
      { kind: "giveMight", amount: -3, minimum: 1 },
    ]);
  });

  it('reads "your other units" as friendly, excluding the source', () => {
    expect(
      parseCardText("Give your other units +2 Might this turn.").effect?.target,
    ).toEqual({
      kind: "all",
      scope: "friendly",
      excludeSelf: true,
    });
  });

  it("refuses a floor on a positive grant, which means nothing", () => {
    expect(
      parseCardText("Give a unit +2 Might this turn, to a minimum of 1 Might.")
        .unparsed,
    ).toHaveLength(1);
  });
});

describe("bounds and destinations on a target", () => {
  it('143: reads "with 3 Might or less" as a bound on effective Might', () => {
    const parsed = parseCardText(
      "When you play me, kill an enemy unit with 3 Might or less.",
    );
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.triggered?.[0]?.effect.target).toEqual({
      kind: "unit",
      scope: "enemy",
      maxMight: 3,
    });
  });

  it('449.1: reads "move a unit from a battlefield to its base"', () => {
    const parsed = parseCardText("Move a unit from a battlefield to its base.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.effect).toEqual({
      target: { kind: "unit", scope: "any", atBattlefield: true },
      destination: { kind: "base" },
      effects: [{ kind: "move" }],
    });
  });

  it("355.5.a: reads a bare plural as a criterion, not a choice", () => {
    expect(
      parseCardText("Give friendly units +5 Might this turn.").effect?.target,
    ).toEqual({
      kind: "all",
      scope: "friendly",
    });
    // The singular still names one chosen Unit.
    expect(
      parseCardText("Give a friendly unit +5 Might this turn.").effect?.target,
    ).toEqual({
      kind: "unit",
      scope: "friendly",
    });
  });
});

describe("a Triggered Ability with a price (403, 356.7)", () => {
  it('reads "you may pay 1 to ready me"', () => {
    const parsed = parseCardText("When I conquer, you may pay 1 to ready me.");
    expect(parsed.unparsed).toHaveLength(0);
    const ability = parsed.abilities?.triggered?.[0];
    expect(ability?.optional).toBe(true);
    expect(ability?.cost).toEqual({ energy: 1, power: [] });
    expect(ability?.effect.effects).toEqual([{ kind: "ready" }]);
  });

  it('414: reads "you may exhaust me to …"', () => {
    const ability = parseCardText(
      "When a friendly unit dies, you may exhaust me to draw 1.",
    ).abilities?.triggered?.[0];
    expect(ability?.exhaustSelf).toBe(true);
    expect(ability?.cost).toBeUndefined();
  });

  it('135.2.e.5: reads the export`s "Rune" as `[A]`', () => {
    expect(
      parseCardText("When you conquer here, you may pay Rune Rune to draw 1.")
        .abilities?.triggered?.[0]?.cost,
    ).toEqual({ energy: 0, power: [], anyPower: 2 });
  });

  it("356.7: reads a non-resource price", () => {
    expect(
      parseCardText("When you conquer here, you may spend a buff to draw 1.")
        .abilities?.triggered?.[0]?.payments,
    ).toEqual([{ kind: "spendBuff" }]);
  });

  it("does not read an ordinary effect as a price", () => {
    // Every price verb is also an effect verb, so "kill a gear" must stay one.
    const ability = parseCardText("When you play me, you may kill a gear.")
      .abilities?.triggered?.[0];
    expect(ability?.cost).toBeUndefined();
    expect(ability?.effect.effects).toEqual([{ kind: "kill" }]);
  });

  it("does not read a destination as a price", () => {
    const ability = parseCardText(
      "When you defend here, you may move a friendly unit here to base.",
    ).abilities?.triggered?.[0];
    // Whether or not the move parses, the "to base" is not a price.
    expect(ability?.cost).toBeUndefined();
  });
});

describe("Counter (425)", () => {
  it("425.3: reads the plain form", () => {
    const parsed = parseCardText("Counter a spell.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.effect).toEqual({
      target: { kind: "chainItem", cardType: "spell" },
      effects: [{ kind: "counter" }],
    });
  });

  it("356.1.c: reads the cost filters against the printed cost", () => {
    expect(
      parseCardText(
        "Counter a spell that costs no more than 4 and no more than 1 Power.",
      ).effect?.target,
    ).toEqual({
      kind: "chainItem",
      cardType: "spell",
      maxEnergy: 4,
      maxPower: 1,
    });
  });

  it('leaves "a card on the chain" open to an ability too', () => {
    expect(
      parseCardText("Counter a card on the chain.").effect?.target,
    ).toEqual({
      kind: "chainItem",
    });
  });
});

describe("the combat designations (464.2.c.3)", () => {
  it('reads "when I attack" and "when I defend"', () => {
    expect(
      parseCardText("When I attack, buff me.").abilities?.triggered?.[0]
        ?.condition,
    ).toEqual({
      event: "attack",
      subject: "self",
    });
    expect(
      parseCardText("When I defend, buff me.").abilities?.triggered?.[0]
        ?.condition,
    ).toEqual({
      event: "defend",
      subject: "self",
    });
  });
});

describe("the Gold gear token (187.5)", () => {
  it("reads a Might-less gear token", () => {
    const parsed = parseCardText("Play a Gold gear token exhausted.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.effect?.effects).toEqual([
      {
        kind: "createToken",
        token: "gold",
        count: 1,
        where: "base",
        ready: false,
      },
    ]);
  });

  it("184.1: omits the entry state when the card names none", () => {
    expect(parseCardText("Play two Gold gear tokens.").effect?.effects).toEqual(
      [{ kind: "createToken", token: "gold", count: 2, where: "base" }],
    );
  });

  it("185.2.b: refuses a Might printed on a gear token", () => {
    expect(
      parseCardText("Play a 2 Might Gold gear token.").unparsed,
    ).toHaveLength(1);
  });

  it("refuses a unit token with no Might, which rule 187 always prints", () => {
    expect(parseCardText("Play a Recruit unit token.").unparsed).toHaveLength(
      1,
    );
  });

  it('135.2.e.5: reads "ADD Rune" as Power of any Domain', () => {
    // The export renders the rainbow `[A]` symbol as the word "Rune".
    expect(
      parseCardText("Exhaust: REACTION - ADD Rune").abilities?.activated?.[0]
        ?.effect,
    ).toEqual({
      target: { kind: "none" },
      effects: [{ kind: "addAnyPower", count: 1 }],
    });
  });
});

describe("Gear as a chosen target", () => {
  it('reads "kill a gear" (428)', () => {
    const parsed = parseCardText("When you play me, you may kill a gear.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.triggered?.[0]?.effect.target).toEqual({
      kind: "unit",
      scope: "any",
      cardType: "gear",
    });
  });

  it("leaves a Unit target unnarrowed, so the two never blur", () => {
    expect(parseCardText("Kill a unit.").effect?.target).toEqual({
      kind: "unit",
      scope: "any",
    });
  });
});

describe("static scopes beyond friendly and enemy", () => {
  it('185: reads "Your tokens enter ready"', () => {
    const parsed = parseCardText("Your tokens enter ready.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "friendly", token: true },
      grant: { entersReady: true },
    });
  });

  it('355.9: reads a trailing "here" onto the scope', () => {
    expect(
      parseCardText("Other friendly units have +1 Might here.").abilities
        ?.statics?.[0],
    ).toEqual({
      affects: { who: "friendly", here: true, excludeSelf: true },
      grant: { might: 1 },
    });
  });

  it('leaves a trailing "here" alone when it belongs to a count', () => {
    // "equal to the number of enemy units here" ends in the same word and
    // means something else, so the printed reading is tried first.
    expect(
      parseCardText("I have ASSAULT equal to the number of enemy units here.")
        .abilities?.statics?.[0]?.affects,
    ).toEqual({ who: "self" });
  });

  it('reads "your units here" as the friendly-here scope', () => {
    expect(
      parseCardText("Your units here have GANKING.").abilities?.statics?.[0]
        ?.affects,
    ).toEqual({
      who: "friendly",
      here: true,
    });
  });

  it("133.8: reads a tag scope, stripping the plural", () => {
    // The data question is separate and belongs to the adapter: this export
    // publishes no tags, so `apitcg.ts` records a `tags` gap for such a card.
    // The clause itself is readable and the engine honours it.
    const parsed = parseCardText("Your Mechs have +1 Might.");
    expect(parsed.unparsed).toHaveLength(0);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "friendly", tag: "Mech" },
      grant: { might: 1 },
    });
  });

  it('prefers a named scope to a tag, so "your units" is never the Unit tag', () => {
    expect(
      parseCardText("Your units have GANKING.").abilities?.statics?.[0]
        ?.affects,
    ).toEqual({
      who: "friendly",
    });
  });
});

describe("scoring and Predict", () => {
  it('467-471: reads "you score 1 point"', () => {
    // 471.1.a.1 keeps it clear of the Final Point restriction, which belongs to
    // Conquer alone, so this is a plain gain with no extra condition.
    expect(
      parseCardText("When I hold, you score 1 point.").abilities
        ?.triggered?.[0],
    ).toEqual({
      condition: { event: "hold", subject: "you", filter: { here: true } },
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "score", amount: 1 }],
      },
    });
  });

  it("817.1.b: Vision desugars into an optional Play Effect that Recycles", () => {
    const parsed = parseCardText("VISION");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]).toEqual({
      condition: { event: "played", subject: "self" },
      // 383.3.a's "you may" is 436.1's "or not Recycle it".
      optional: true,
      // 436.3.a: an omitted count is 1.
      effect: {
        target: { kind: "none" },
        effects: [{ kind: "recycleTop", count: 1 }],
      },
    });
  });

  it("leaves no refused keyword at all", () => {
    expect(Object.keys(UNMODELLED_KEYWORDS)).toEqual([]);
  });
});

describe("counted targets (rule 355.6)", () => {
  it("reads an exact count as one choice of several objects", () => {
    const parsed = parseCardText("Give two friendly units each +2 Might this turn.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "unit",
      scope: "friendly",
      count: { min: 2, max: 2 },
    });
  });

  it('reads "up to" as a range, so choosing fewer is legal', () => {
    const parsed = parseCardText("Move up to 2 friendly units to base.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "unit",
      scope: "friendly",
      atBattlefield: true,
      count: { min: 0, max: 2 },
    });
    expect(parsed.effect?.destination).toEqual({ kind: "base" });
  });

  it('reads the count and "other" from one article phrase', () => {
    const parsed = parseCardText("When you play me, buff two other friendly units.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.target).toEqual({
      kind: "unit",
      scope: "friendly",
      excludeSelf: true,
      count: { min: 2, max: 2 },
    });
  });

  it("leaves the ordinary singular uncounted, so nothing else changes shape", () => {
    const parsed = parseCardText("Buff a friendly unit.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({ kind: "unit", scope: "friendly" });
  });

  it("refuses an unbounded count rather than guessing a bound", () => {
    // 2^n combinations is not an enumeration, and a card played more narrowly
    // than printed is the wrong direction for a *permission*.
    const parsed = parseCardText("Move any number of friendly units to base.");
    expect(parsed.unparsed).not.toEqual([]);
  });
});

describe("dynamic amounts (rules 143, 807)", () => {
  it("reads \"equal to my Might\" as a count that scales the printed number", () => {
    const parsed = parseCardText(
      "When I attack, deal damage equal to my Might to an enemy unit here.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.effects).toEqual([
      { kind: "dealDamage", amount: 1, per: { kind: "sourceMight" } },
    ]);
  });

  it("807: a keyword's value is the same kind of count", () => {
    const parsed = parseCardText(
      "When I attack, deal damage equal to my ASSAULT to an enemy unit here.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.effects).toEqual([
      { kind: "dealDamage", amount: 1, per: { kind: "sourceKeyword", keyword: "assault" } },
    ]);
  });

  it("reads a player's score before the generic tag sweep, which would match nothing", () => {
    // COUNTS is first-match-wins, and "your <noun>" reads an unknown noun as a
    // tag. Ordered after it, "your points" became a count of Units tagged
    // "point" — a card that parses, looks right, and is always 0.
    const parsed = parseCardText("I have +1 Might for each of your points.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.statics?.[0]?.grant.per).toEqual({ kind: "points", who: "you" });
  });

  it("refuses a count in a static's grant that would recurse through Might", () => {
    // `mightOf` consults statics, so a grant counting Might would ask the
    // static that is asking. Refused rather than allowed to read 0.
    expect(parseCardText("I have +1 Might for each my Might.").unparsed).not.toEqual([]);
  });
});

describe("shapes the grammar reads once rather than per card", () => {
  it("383.2: a two-condition clause is two abilities sharing an effect", () => {
    const parsed = parseCardText("When I attack or defend, deal 2 to an enemy unit here.");
    expect(parsed.unparsed).toEqual([]);
    const triggered = parsed.abilities?.triggered ?? [];
    expect(triggered.map((one) => one.condition)).toEqual([
      { event: "attack", subject: "self" },
      { event: "defend", subject: "self" },
    ]);
    // One effect, not two readings of it.
    expect(triggered[0]?.effect).toEqual(triggered[1]?.effect);
  });

  it("carries the subject into a half that prints none", () => {
    const parsed = parseCardText("When I conquer or hold, draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered).toHaveLength(2);
  });

  it("tries the whole clause before splitting, so a condition may contain the word", () => {
    // "a unit or gear" is one condition. The split is a fallback, never a
    // rewrite, so a clause that reads whole is never cut in half.
    const whole = parseCardText("When you play a spell or ability, draw 1.");
    const split = parseCardText("When I attack or defend, draw 1.");
    expect(split.abilities?.triggered).toHaveLength(2);
    // Whichever way the first reads, it must not become two mismatched halves.
    expect(whole.abilities?.triggered?.length ?? 0).not.toBe(2);
  });

  it("splits a trigger with no printed comma", () => {
    const parsed = parseCardText("When I conquer play a Gold gear token exhausted.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.effects).toEqual([
      { kind: "createToken", token: "gold", count: 1, where: "base", ready: false },
    ]);
  });

  it('reads "you may <verb> a <thing>" as a choice of zero or one', () => {
    const parsed = parseCardText("You may kill a gear. Draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "unit",
      scope: "any",
      cardType: "gear",
      count: { min: 0, max: 1 },
    });
    // The draw is not optional — it is a separate sentence.
    expect(parsed.effect?.effects).toEqual([{ kind: "kill" }, { kind: "draw", count: 1 }]);
  });

  it('refuses "you may" on a clause that chooses nothing', () => {
    // Read as a bare draw it would be mandatory, which is a stronger card.
    expect(parseCardText("You may draw 1.").unparsed).not.toEqual([]);
  });

  it("449.1: a Move with no printed Destination lets the controller pick any", () => {
    const parsed = parseCardText("Move a friendly unit and ready it.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.destination).toEqual({ kind: "any" });
    expect(parsed.effect?.effects).toEqual([{ kind: "move" }, { kind: "ready" }]);
  });

  it("refuses a pronoun with nothing to refer back to", () => {
    // An untargeted `ready` does nothing, so the card would parse and be wrong.
    expect(parseCardText("Ready it.").unparsed).not.toEqual([]);
  });

  it("359.2.c: a Unit already enters exhausted, so printing it grants nothing", () => {
    expect(parseCardText("This enters exhausted.").unparsed).toEqual([]);
    expect(parseCardText("This enters exhausted.").abilities).toBeUndefined();
  });
});

describe("object filters and ability-use restrictions", () => {
  it("reads a state adjective out of the scope phrase", () => {
    const parsed = parseCardText("Buff an exhausted friendly unit.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "unit",
      scope: "friendly",
      filter: { exhausted: true },
    });
  });

  it("carries the filter into an `all` sweep as well", () => {
    // Three clause rules assembled this spec inline and none honoured the
    // adjective, so "kill all damaged enemy units here" silently became "kill
    // all enemy units here" — a card that parses and is wrong.
    const parsed = parseCardText("Kill all damaged enemy units here.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "all",
      scope: "enemy",
      filter: { damaged: true },
      here: true,
    });
  });

  it("refuses an adjective it does not know rather than reading it as noise", () => {
    expect(parseCardText("Buff a legendary friendly unit.").unparsed).not.toEqual([]);
  });

  it("133.8: a capitalised noun that is not a card type is a tag", () => {
    const parsed = parseCardText("When you play me, ready another friendly Mech.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.target).toEqual({
      kind: "unit",
      scope: "friendly",
      excludeSelf: true,
      filter: { tag: "Mech" },
    });
  });

  it("002 with 377: \"only while X\" is a restriction gated by not-X", () => {
    const parsed = parseCardText("Use my abilities only while I'm at a battlefield.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "self" },
      grant: { forbid: [{ kind: "activateAbility" }] },
      condition: { kind: "not", condition: { kind: "atBattlefield" } },
    });
  });

  it("refuses an ability restriction whose predicate it cannot read", () => {
    expect(
      parseCardText("Use my abilities only while the moon is full.").unparsed,
    ).not.toEqual([]);
  });
});

describe("trigger events the reducer now raises", () => {
  const conditionOf = (text: string) =>
    parseCardText(text).abilities?.triggered?.map((one) => one.condition);

  it("415: readying, and 416: recycling", () => {
    expect(conditionOf("When you ready a friendly unit, draw 1.")).toEqual([
      { event: "ready", subject: "friendly" },
    ]);
    expect(conditionOf("When you recycle one or more cards, draw 1.")).toEqual([
      { event: "recycle", subject: "you" },
    ]);
  });

  it("702: spending a Buff", () => {
    expect(conditionOf("When you spend a buff, draw 1.")).toEqual([
      { event: "spendBuff", subject: "you" },
    ]);
  });

  it('355.6: "with a spell" is about what chose, not about what was chosen', () => {
    // Read as `cardType` this would ask whether the chosen Unit is a Spell,
    // which is never true — a filter that can only be false is a dead card.
    expect(conditionOf("When you choose me with a spell, draw 1.")).toEqual([
      { event: "chosen", subject: "self", filter: { byController: true, bySource: "spell" } },
    ]);
  });

  it("428 with 702 and 133.8: adjectives narrow a death", () => {
    expect(conditionOf("When a buffed friendly unit dies, draw 1.")).toEqual([
      { event: "dies", subject: "friendly", filter: { object: { buffed: true } } },
    ]);
    expect(conditionOf("When another non-Recruit unit you control dies, draw 1.")).toEqual([
      { event: "dies", subject: "friendly", filter: { excludeSelf: true, excludeTag: "Recruit" } },
    ]);
  });

  it("leaves the plain death wordings alone, which the adjective rule could have eaten", () => {
    // Being first-match-wins, a rule matching "a unit dies" would read it as
    // friendly-only — a card narrower than printed.
    expect(conditionOf("When a unit dies, draw 1.")).toEqual([
      { event: "dies", subject: "any" },
    ]);
    expect(conditionOf("When an enemy unit dies, draw 1.")).toEqual([
      { event: "dies", subject: "enemy" },
    ]);
  });

  it("811 and 314: where a card was played from, and whose turn it was", () => {
    expect(conditionOf("When you play a card from HIDDEN, draw 1.")).toEqual([
      { event: "played", subject: "you", filter: { fromFacedown: true } },
    ]);
    expect(conditionOf("When you play a card on an opponent's turn, draw 1.")).toEqual([
      { event: "played", subject: "you", filter: { onOpponentTurn: true } },
    ]);
  });

  it("446: both ends of a Move, and the mirror of `here`", () => {
    expect(conditionOf("When I move from a battlefield, draw 1.")).toEqual([
      { event: "move", subject: "self", filter: { direction: "from" } },
    ]);
    expect(
      conditionOf("When an opponent moves to a battlefield other than mine, draw 1."),
    ).toEqual([{ event: "move", subject: "enemy", filter: { notHere: true } }]);
  });
});

describe("the triggering object, and a floor on a static grant", () => {
  it('reads a bare "it" as the triggering event\'s object', () => {
    const parsed = parseCardText("When you ready a friendly unit, give it +1 Might this turn.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect).toEqual({
      target: { kind: "triggerObject" },
      effects: [{ kind: "giveMight", amount: 1 }],
    });
  });

  it("keeps a pronoun that refers back within the run as an ordinary target", () => {
    // "Move a friendly unit and ready it" chooses the Unit, so "it" is that
    // choice — not the triggering object, which a Spell does not have.
    const parsed = parseCardText("Move a friendly unit and ready it.");
    expect(parsed.effect?.target).toEqual({ kind: "unit", scope: "friendly" });
  });

  it("refuses the pronoun outside a trigger, where there is nothing to refer to", () => {
    expect(parseCardText("Ready it.").unparsed).not.toEqual([]);
    expect(parseCardText("Exhaust: Buff it.").unparsed).not.toEqual([]);
  });

  it("143.2: a static Might reduction may carry a printed floor", () => {
    const parsed = parseCardText("Enemy units here have -8 Might, to a minimum of 1 Might.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.statics?.[0]?.grant).toEqual({ might: -8, minimumMight: 1 });
  });

  it("refuses a floor on a grant that raises Might, where it would be noise", () => {
    expect(
      parseCardText("Other friendly units have +1 Might, to a minimum of 1 Might.").unparsed,
    ).not.toEqual([]);
  });

  it("708: MIGHTY narrows a trigger's object, where a static grant may not", () => {
    expect(
      parseCardText("When you play a MIGHTY unit, draw 1.").abilities?.triggered?.[0]?.condition,
    ).toEqual({ event: "played", subject: "you", filter: { mighty: true } });
    // `mightOf` consults statics, so a grant counting Might would recurse.
    expect(parseCardText("I have +1 Might for each my Might.").unparsed).not.toEqual([]);
  });
});

describe("playing a card out of the trash (354, 355.2)", () => {
  it("reads the effect, the cost bounds and the entry Location", () => {
    const parsed = parseCardText(
      "When you play me, you may play a unit costing no more than 3 and no more than rune from your trash, ignoring its cost.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect).toEqual({
      target: { kind: "trashCard", cardTypes: ["unit"], maxEnergy: 3, maxPower: 1 },
      destination: { kind: "unitEntry" },
      effects: [{ kind: "play", ignore: "all" }],
    });
    expect(parsed.abilities?.triggered?.[0]?.optional).toBe(true);
  });

  it('distinguishes "ignoring its cost" from "ignoring its Energy cost"', () => {
    const energyOnly = parseCardText(
      "When you play me, you may play a unit from your trash, ignoring its Energy cost.",
    );
    expect(energyOnly.abilities?.triggered?.[0]?.effect.effects).toEqual([
      { kind: "play", ignore: "energy" },
    ]);
  });

  it("refuses a play whose cost is not ignored, rather than making the card free", () => {
    // Paying at resolution needs a payment step the engine does not have, so
    // reading this as free would be a card stronger than printed.
    expect(
      parseCardText("When I conquer, you may play a unit from your trash.").unparsed,
    ).not.toEqual([]);
  });

  it("reads a disjunction of card types as one list", () => {
    const parsed = parseCardText("Return a unit or gear from your trash to your hand.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({ kind: "trashCard", cardTypes: ["unit", "gear"] });
  });
});

describe("Delayed Passive Abilities (rule 390.4)", () => {
  it("reads a turn-scoped static through the ordinary Passive grammar", () => {
    const parsed = parseCardText("Units you play this turn enter ready.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.effects).toEqual([
      {
        kind: "thisTurn",
        static: { affects: { who: "friendly" }, grant: { entersReady: true } },
      },
    ]);
  });

  it("002: a turn-scoped restriction is the same shape with the opposite sign", () => {
    const parsed = parseCardText("When you play me, opponents can't play cards this turn.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.effects).toEqual([
      {
        kind: "thisTurn",
        static: { affects: { who: "enemy" }, grant: { forbid: [{ kind: "playCards" }] } },
      },
    ]);
  });

  it('"the next" is a counted window, never dropped', () => {
    // Read as uncounted it would be every spell this turn — strictly stronger
    // than the card printed.
    const parsed = parseCardText(
      "When you play me, the next spell you play this turn costs 5 less.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.effects).toEqual([
      {
        kind: "thisTurn",
        uses: 1,
        costModifier: {
          applies: { scope: "friendly", types: ["spell"] },
          change: { kind: "discount", energy: 5 },
        },
      },
    ]);
  });

  it("812.1.b: LEGION inside an ability body gates that ability", () => {
    const parsed = parseCardText("Exhaust: LEGION - The next unit you play this turn enters ready.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.activated?.[0]?.dependsOn).toEqual({ kind: "legion" });
  });

  it("leaves an ordinary Might grant alone, which the window pattern could have eaten", () => {
    // `CLAUSES` is first-match-wins and this rule matches almost any line with
    // "this turn" in it, so it is listed last. Ordered earlier it shadowed
    // eleven cards that were already parsing.
    const parsed = parseCardText("Give a friendly unit +2 Might this turn.");
    expect(parsed.effect?.effects).toEqual([{ kind: "giveMight", amount: 2 }]);
  });

  it("refuses a `self` window, which would be about a card already in the trash", () => {
    expect(parseCardText("I have +1 Might this turn.").unparsed).not.toEqual([]);
  });
});

describe("looking at the top of the deck (424, 390.5)", () => {
  it("reads the look and its Linked Ability as one statement", () => {
    const parsed = parseCardText(
      "Look at the top 3 cards of your Main Deck. Put 1 into your hand and recycle the rest.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.effects).toEqual([
      {
        kind: "look",
        count: 3,
        then: {
          target: { kind: "revealed" },
          effects: [{ kind: "toHand" }, { kind: "recycleRest" }],
        },
      },
    ]);
  });

  it("424.1: distinguishes a reveal from a private look", () => {
    const revealed = parseCardText(
      "When I attack, you may reveal the top 2 cards of your Main Deck. You may play one. Then recycle the rest.",
    );
    expect(revealed.unparsed).toEqual([]);
    const effect = revealed.abilities?.triggered?.[0]?.effect.effects[0];
    expect(effect).toMatchObject({ kind: "look", count: 2, reveal: true });
    // "You may play one" is a choice of zero or one, not a refusal.
    expect((effect as { then: { target: unknown } }).then.target).toEqual({
      kind: "revealed",
      count: { min: 0, max: 1 },
    });
  });

  it("reads a guarded disposition, with `otherwise` negating the branch before", () => {
    const parsed = parseCardText(
      "When I move, reveal the top card of your Main Deck. If it's a gear, draw it. Otherwise, recycle it.",
    );
    expect(parsed.unparsed).toEqual([]);
    const then = (
      parsed.abilities?.triggered?.[0]?.effect.effects[0] as { then: { effects: unknown } }
    ).then;
    expect(then.effects).toEqual([
      { kind: "toHand", condition: { kind: "targetIs", cardType: "gear" } },
      {
        kind: "recycle",
        condition: { kind: "not", condition: { kind: "targetIs", cardType: "gear" } },
      },
    ]);
  });

  it("424.3: reads a look bounded by what it finds rather than by a count", () => {
    const parsed = parseCardText(
      "At the end of your turn, reveal cards from the top of your Main Deck until you reveal a unit. Play it, ignoring its cost, and recycle the rest.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.effect.effects[0]).toMatchObject({
      kind: "look",
      until: "unit",
      reveal: true,
    });
  });

  it("refuses a disposition that is not about the cards just looked at", () => {
    // The Linked Ability references what its generator affected (390.5); a body
    // choosing something else is a different card, not this shape.
    expect(
      parseCardText("Look at the top 3 cards of your Main Deck. Kill an enemy unit.").unparsed,
    ).not.toEqual([]);
  });
});

describe("Bonus Damage (rules 712-715)", () => {
  it("reads it as a grant, with the scope saying whose Deal actions", () => {
    const parsed = parseCardText("Your spells and abilities deal 1 Bonus Damage.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "friendly" },
      grant: { bonusDamage: 1 },
    });
  });

  it("355.9: a `here` scope is about where the damaged Unit is", () => {
    const parsed = parseCardText(
      "Spells and abilities affecting units here each deal 1 Bonus Damage.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.statics?.[0]).toEqual({
      affects: { who: "any", here: true },
      grant: { bonusDamage: 1 },
    });
  });

  it('390.4: "the next spell you play" is a window with no "this turn" printed', () => {
    // The rulebook's own Ravenborn Tome example: "The next spell is a specific
    // time, and the 1 Bonus Damage is a passive ability."
    const parsed = parseCardText("Exhaust: The next spell you play deals 1 Bonus Damage.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.activated?.[0]?.effect.effects).toEqual([
      {
        kind: "thisTurn",
        uses: 1,
        static: { affects: { who: "friendly" }, grant: { bonusDamage: 1 } },
      },
    ]);
  });

  it("714.1: Bonus Damage is only ever positive", () => {
    expect(parseCardText("Your spells and abilities deal 0 Bonus Damage.").unparsed).not.toEqual(
      [],
    );
  });

  it('does not mistake an effect clause for a static, now that "deal" is a grant verb', () => {
    const parsed = parseCardText("Deal 2 to a unit at a battlefield.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.effects).toEqual([{ kind: "dealDamage", amount: 2 }]);
  });
});

describe("a second chosen thing (rule 355.5)", () => {
  it('reads "a friendly unit and an enemy unit" as two slots, not one wider one', () => {
    const parsed = parseCardText("Stun a friendly unit and an enemy unit at the same battlefield.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({ kind: "unit", scope: "friendly" });
    expect(parsed.effect?.second).toEqual({
      kind: "unit",
      scope: "enemy",
      sameLocation: true,
    });
    // One verb, run once per chosen object: both get stunned.
    expect(parsed.effect?.effects).toEqual([{ kind: "stun" }]);
  });

  it('carries "another" onto the first slot and not the second', () => {
    const parsed = parseCardText(
      "When you play me, return another friendly unit and an enemy unit to their owners' hands.",
    );
    expect(parsed.unparsed).toEqual([]);
    const effect = parsed.abilities?.triggered?.[0]?.effect;
    expect(effect?.target).toEqual({ kind: "unit", scope: "friendly", excludeSelf: true });
    expect(effect?.second).toEqual({ kind: "unit", scope: "enemy" });
  });

  it('reads a bare "Choose …" sentence as slots with the verb still to come', () => {
    const parsed = parseCardText(
      "Choose a friendly unit and an enemy unit. They deal damage equal to their Mights to each other.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({ kind: "unit", scope: "friendly" });
    expect(parsed.effect?.second).toEqual({ kind: "unit", scope: "enemy" });
    expect(parsed.effect?.effects).toEqual([{ kind: "mutualDamage" }]);
  });

  it('reads "we" as the source being one of the pair, so only one is chosen', () => {
    const parsed = parseCardText(
      "When you play me, choose an enemy unit at a battlefield. " +
        "We deal damage equal to our Mights to each other.",
    );
    expect(parsed.unparsed).toEqual([]);
    const effect = parsed.abilities?.triggered?.[0]?.effect;
    expect(effect?.target).toEqual({ kind: "unit", scope: "enemy", atBattlefield: true });
    expect(effect?.second).toBeUndefined();
    expect(effect?.effects).toEqual([{ kind: "mutualDamage", self: true }]);
  });

  it("fills the second slot from a later sentence than the one naming the first", () => {
    const parsed = parseCardText(
      "Give a friendly unit +3 Might this turn. Then, choose an enemy unit. " +
        "They deal damage equal to their Mights to each other.",
    );
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({ kind: "unit", scope: "friendly" });
    expect(parsed.effect?.second).toEqual({ kind: "unit", scope: "enemy" });
    expect(parsed.effect?.effects).toEqual([
      { kind: "giveMight", amount: 3 },
      { kind: "mutualDamage" },
    ]);
  });

  it("refuses a second slot with no first, which would choose one thing and act on two", () => {
    expect(parseCardText("Choose an enemy unit.").unparsed).not.toEqual([]);
  });
});

describe("the combat designations as an adjective (464.2.c.3)", () => {
  it("narrows a chosen target", () => {
    const parsed = parseCardText("Stun an attacking unit.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "unit",
      scope: "any",
      filter: { role: "attacker" },
    });
  });

  it("narrows a criteria set the same way, from the one shared alternation", () => {
    // The adjective run lives in `ADJECTIVES` rather than in each pattern, so
    // a new adjective reaches every clause or none — the failure mode being
    // that it reaches eleven of twelve and one card reads too widely.
    const parsed = parseCardText("Kill all defending units here.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "all",
      scope: "any",
      here: true,
      filter: { role: "defender" },
    });
  });

  it("still refuses an adjective the table does not know", () => {
    expect(parseCardText("Stun a lurking unit.").unparsed).not.toEqual([]);
  });
});

describe("reminders the export malforms", () => {
  it("reads a `{` where the `(` should be", () => {
    // "ACTION {Play on your turn or in showdowns.)" — a defect in the source,
    // not a wording any grammar should learn.
    const parsed = parseCardText("ACTION {Play on your turn or in showdowns.)\nDraw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.effects).toEqual([{ kind: "draw", count: 1 }]);
  });

  it("drops a reminder whose opening bracket was lost", () => {
    const parsed = parseCardText(
      "Your Mechs have SHIELD. +1 Might while they're defenders.)",
    );
    expect(parsed.unparsed).toEqual([]);
  });

  it("keeps a sentence that merely ends in a parenthetical", () => {
    // The unmatched bracket is the whole signal. With both brackets present
    // the ordinary strip applies and nothing before it is touched.
    const parsed = parseCardText("Draw 1. (Then you have a card.)");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.effects).toEqual([{ kind: "draw", count: 1 }]);
  });

  it("leaves a line alone when there is no bracket at all", () => {
    expect(parseCardText("Draw 1. Buff me.").unparsed).toEqual([]);
  });
});

describe("Runes and the Legend as Game Objects (161.1.a, 103.1)", () => {
  it("reads a counted set of Runes as a choice", () => {
    const parsed = parseCardText("Ready 2 runes.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "unit",
      scope: "friendly",
      cardType: "rune",
      count: { min: 2, max: 2 },
    });
  });

  it("reads a bare plural as a criteria set, not a choice (355.5.a)", () => {
    // "Ready your runes" names every one rather than a number of them, so it
    // is enumerated at resolution and needs no choice.
    const parsed = parseCardText("Ready your runes.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "all",
      scope: "friendly",
      cardType: "rune",
    });
  });

  it("reaches the Legend, which is in its own zone all game", () => {
    const parsed = parseCardText("Ready your legend.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.target).toEqual({
      kind: "all",
      scope: "friendly",
      cardType: "legend",
    });
  });
});

describe("attacking and defending alone (464.2.c.3)", () => {
  const staticOf = (text: string) => parseCardText(text).abilities?.statics?.[0];

  it("narrows the source itself, with no designation named", () => {
    // "Attacking or defending" is both, which is an absent `role`: the Unit
    // holds one and the card does not care which.
    expect(staticOf("While I'm attacking or defending alone, I have +2 Might.")).toEqual({
      affects: { who: "self", filter: { alone: true } },
      grant: { might: 2 },
    });
  });

  it("narrows the objects, not the source, when the subject is a set", () => {
    // The condition's subject *is* the grant's: "while a friendly unit defends
    // alone, it gets +2 Might" grants to the units the condition describes, not
    // to the Legend printing it. Read through the ordinary "While <predicate>,"
    // split it would become a source predicate that is never true.
    expect(staticOf("While a friendly unit defends alone, it gets +2 Might.")).toEqual({
      affects: { who: "friendly", filter: { alone: true, role: "defender" } },
      grant: { might: 2 },
    });
  });

  it("keeps the designation when only one is named", () => {
    expect(
      staticOf("While an enemy unit attacks alone, it gets +1 Might.")?.affects,
    ).toEqual({ who: "enemy", filter: { alone: true, role: "attacker" } });
  });
});

describe("effects that name a player (symmetric and opposing)", () => {
  it('reads "each player channels" as one instruction run per player', () => {
    const parsed = parseCardText("Each player channels 1 rune exhausted.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.effects).toEqual([
      { kind: "channel", count: 1, exhausted: true, who: "each" },
    ]);
  });

  it("leaves an unqualified channel acting on its controller", () => {
    expect(parseCardText("Channel 1 rune exhausted.").effect?.effects).toEqual([
      { kind: "channel", count: 1, exhausted: true },
    ]);
  });

  it('does not read "its owner channels" as a player-directed effect', () => {
    // That names the owner of a *target*, which is a different question from
    // naming a seat — and reading it as one would channel for the wrong player.
    expect(
      parseCardText("Return a friendly unit to its owner's hand. Its owner channels 1 rune exhausted.")
        .unparsed,
    ).not.toEqual([]);
  });
});

describe("counts and prices, read once rather than per wording", () => {
  const conditionOfEffect = (text: string) =>
    parseCardText(text).abilities?.triggered?.[0]?.effect.effects?.[0]?.condition;

  it("reads an adjective in a count, as a target already could", () => {
    // Three near-identical rules built this predicate, each knowing about a
    // different subset of the phrase — so an adjective was readable in a
    // target and not in a count.
    const parsed = parseCardText("Draw 1 if there is a ready enemy unit here.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.effect?.condition).toEqual({
      kind: "controls",
      who: "opponent",
      what: "unit",
      min: 1,
      here: true,
      filter: { exhausted: false },
    });
  });

  it('keeps "here" working with either verb', () => {
    for (const text of [
      "Draw 1 if you control another unit here.",
      "Draw 1 if you have another unit here.",
    ]) {
      expect(parseCardText(text).effect?.condition).toMatchObject({
        kind: "controls",
        here: true,
        excludeSelf: true,
      });
    }
  });

  it("still refuses a lowercase noun that is not a card type", () => {
    // A tag is capitalised (133.8); a lowercase unknown noun is a shape the
    // grammar has not read rather than a tag to invent.
    expect(parseCardText("Draw 1 if you control a widget.").unparsed).not.toEqual([]);
  });

  it('403: reads "pay X. If you do, Y" as the price it is', () => {
    // The same statement as "pay X to Y" — 402.2 settles the price either way.
    const parsed = parseCardText("When I conquer, you may pay 1. If you do, draw 1.");
    expect(parsed.unparsed).toEqual([]);
    const ability = parsed.abilities?.triggered?.[0];
    expect(ability?.optional).toBe(true);
    expect(ability?.cost).toEqual({ energy: 1, power: [] });
    expect(ability?.effect.effects).toEqual([{ kind: "draw", count: 1 }]);
    expect(conditionOfEffect("When I conquer, you may pay 1. If you do, draw 1.")).toBeUndefined();
  });
});

describe("the designations said of a player (464.2.c.3)", () => {
  const conditionOf = (text: string) =>
    parseCardText(text).abilities?.triggered?.[0]?.condition;

  it('reads "when you defend here" as the side, scoped to this Battlefield', () => {
    // `subject` says whose *Unit*; this says whose *side*, and every corpus
    // printing sits on the Battlefield where it happens.
    expect(conditionOf("When you defend here, draw 1.")).toEqual({
      event: "defend",
      subject: "friendly",
      filter: { here: true },
    });
  });

  it("leaves the self form alone", () => {
    expect(conditionOf("When I defend, draw 1.")).toEqual({
      event: "defend",
      subject: "self",
    });
  });

  it('428: reads "kill me" as the same payment as "kill this"', () => {
    const parsed = parseCardText("When I defend, you may kill me to draw 1.");
    expect(parsed.unparsed).toEqual([]);
    expect(parsed.abilities?.triggered?.[0]?.payments).toEqual([{ kind: "killSelf" }]);
  });
});
