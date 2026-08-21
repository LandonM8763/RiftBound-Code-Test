/**
 * Additional Costs (rule 356.2).
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The rulebook's own worked example is the shape to keep in mind: "As you play
 * me, you may discard 1 as an additional cost. If you do, reduce my cost by 2."
 * The declaration happens at step 2, the discount lands at 356.4, and the
 * discard is paid at 357.2.
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
import { describe, expect, it } from "vitest";

import { IllegalActionError } from "./actions.js";
import { canPayAdditional } from "./additional.js";
import { totalCost } from "./costs.js";
import { checkInvariants } from "./invariants.js";
import { legalActions } from "./legal.js";
import { moveEntity, withPlayer } from "./mutate.js";
import { reduce } from "./reduce.js";
import { createGame, type DeckList } from "./setup.js";
import {
  isOver,
  playerLocation,
  type EntityId,
  type GameState,
} from "./state.js";

const LEGEND = makeLegend(["fury"], { id: cardId("D-000") });
const CHAMPION = makeUnit(3, ["fury"], { id: cardId("D-001"), champion: true });
const PLAIN = makeUnit(2, ["fury"], {
  id: cardId("D-010"),
  name: "Plain",
  cost: cost(1),
});

/** The rulebook's example: discard 1 for a 2 Energy discount. */
const BARGAIN = makeUnit(2, ["fury"], {
  id: cardId("D-011"),
  name: "Bargain",
  cost: cost(4),
  abilities: {
    additionalCosts: [{ optional: true, pay: { kind: "discard", count: 1 } }],
    costModifiers: [
      {
        applies: { scope: "self" },
        change: { kind: "discount", energy: 2 },
        condition: { kind: "paidAdditionalCost" },
      },
    ],
  },
});

/** 356.2.a: no "may", so it must be paid to play the card at all. */
const SACRIFICE = makeUnit(2, ["fury"], {
  id: cardId("D-012"),
  name: "Sacrifice",
  cost: cost(1),
  abilities: { additionalCosts: [{ pay: { kind: "kill", what: "unit" } }] },
});

/**
 * Accelerate (805.1.a), exactly as ingest desugars it: an Optional Additional
 * Cost of 1 Energy and 1 Power of the Unit's own Domain, plus "if you do, I
 * enter ready".
 */
const ACCELERATED = makeUnit(2, ["fury"], {
  id: cardId("D-014"),
  name: "Accelerated",
  cost: cost(1),
  abilities: {
    additionalCosts: [
      {
        optional: true,
        pay: { kind: "resources", cost: { energy: 1, power: ["fury"] } },
      },
    ],
    statics: [
      {
        affects: { who: "self" },
        grant: { entersReady: true },
        condition: { kind: "paidAdditionalCost" },
      },
    ],
  },
});

/** An optional cost whose payoff is an effect rather than a discount. */
const BONUS = makeUnit(2, ["fury"], {
  id: cardId("D-013"),
  name: "Bonus",
  cost: cost(1),
  abilities: {
    additionalCosts: [{ optional: true, pay: { kind: "exhaustLegend" } }],
  },
  effect: {
    target: { kind: "none" },
    effects: [{ kind: "draw", count: 1 }],
    condition: { kind: "paidAdditionalCost" },
  },
});

const RUNE = makeRune("fury", { id: cardId("D-100") });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`D-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  BARGAIN,
  SACRIFICE,
  BONUS,
  ACCELERATED,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 2 }, () => PLAIN.id),
      ...Array.from({ length: 4 }, () => BARGAIN.id),
      ...Array.from({ length: 4 }, () => SACRIFICE.id),
      ...Array.from({ length: 4 }, () => BONUS.id),
      ...Array.from({ length: 4 }, () => ACCELERATED.id),
    ],
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function inMainPhase(seed = "additional", energy = 6): GameState {
  let state = createGame({
    decks: [deck(), deck()],
    registry: REGISTRY,
    seed,
  }).state;
  while (state.phase === "mulligan") {
    state = reduce(state, { type: "mulligan", cards: [] }).state;
  }
  while (state.phase !== "main" && !isOver(state)) {
    state = reduce(state, { type: "resolvePhase" }).state;
  }
  return withPlayer(state, state.activePlayer, (seat) => ({
    ...seat,
    pool: { ...seat.pool, energy },
  }));
}

/** Draw a card of `id` out of the deck and into hand. */
function inHand(
  state: GameState,
  id: CardDefinition["id"],
): [GameState, EntityId] {
  const player = state.activePlayer;
  const held = state.players[player]!.zones.hand.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (held !== undefined) {
    return [state, held];
  }
  const card = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (card === undefined) {
    throw new Error(`No ${id} left in the deck`);
  }
  return [moveEntity(state, card, playerLocation(player, "hand")), card];
}

/** Put a Unit on the Board so a "kill a friendly unit" cost is payable. */
function withUnit(state: GameState): [GameState, EntityId] {
  const player = state.activePlayer;
  const card = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === PLAIN.id,
  );
  if (card === undefined) {
    throw new Error("No Plain left in the deck");
  }
  return [moveEntity(state, card, playerLocation(player, "base")), card];
}

describe("the optional form (356.2.b)", () => {
  it("offers both paying and not paying, as separate plays", () => {
    const [state, card] = inHand(inMainPhase("offer"), BARGAIN.id);
    const plays = legalActions(state, state.activePlayer).filter(
      (action) => action.type === "playCard" && action.card === card,
    );

    expect(plays).toHaveLength(2);
    expect(
      plays.filter(
        (play) => "payAdditional" in play && play.payAdditional === true,
      ),
    ).toHaveLength(1);
  });

  it("changes the Total Cost, which is why the choice is made at step 2", () => {
    const [state] = inHand(inMainPhase("cost"), BARGAIN.id);
    const player = state.activePlayer;

    expect(totalCost(state, player, BARGAIN)).toEqual(cost(4));
    expect(
      totalCost(state, player, BARGAIN, { paidAdditionalCost: true }),
    ).toEqual(cost(2));
  });

  it("pays the cost and charges the discounted total", () => {
    const [state, card] = inHand(inMainPhase("pay", 6), BARGAIN.id);
    const player = state.activePlayer;
    const handBefore = state.players[player]!.zones.hand.length;

    const played = reduce(state, {
      type: "playCard",
      card,
      payAdditional: true,
    }).state;

    // 4 printed, 2 discounted away: 4 Energy left of 6.
    expect(played.players[player]!.pool.energy).toBe(4);
    // The card left the hand and the discard took another.
    expect(played.players[player]!.zones.hand.length).toBe(handBefore - 2);
    checkInvariants(played);
  });

  it("charges the printed cost and takes nothing when declined", () => {
    const [state, card] = inHand(inMainPhase("decline", 6), BARGAIN.id);
    const player = state.activePlayer;
    const handBefore = state.players[player]!.zones.hand.length;

    const played = reduce(state, { type: "playCard", card }).state;

    expect(played.players[player]!.pool.energy).toBe(2);
    expect(played.players[player]!.zones.hand.length).toBe(handBefore - 1);
  });

  it("is not offered when the payment cannot be made", () => {
    // An empty hand cannot pay a discard cost.
    let [state, card] = inHand(inMainPhase("nohand"), BARGAIN.id);
    const player = state.activePlayer;
    state = withPlayer(state, player, (seat) => ({
      ...seat,
      zones: { ...seat.zones, hand: [card] },
    }));

    const plays = legalActions(state, player).filter(
      (action) => action.type === "playCard" && action.card === card,
    );
    // Only the "do not pay" offer survives.
    expect(plays).toHaveLength(1);
    expect(plays[0]).not.toHaveProperty("payAdditional");
  });

  it("runs an effect gated on having paid", () => {
    const [state, card] = inHand(inMainPhase("gated", 3), BONUS.id);
    const player = state.activePlayer;

    const declined = reduce(state, { type: "playCard", card }).state;
    const paid = reduce(state, {
      type: "playCard",
      card,
      payAdditional: true,
    }).state;

    // Only the paid play draws, and only it exhausts the Legend.
    expect(paid.players[player]!.zones.mainDeck.length).toBe(
      declined.players[player]!.zones.mainDeck.length - 1,
    );
    const legend = paid.players[player]!.zones.legendZone[0]!;
    expect(paid.entities[legend]!.exhausted).toBe(true);
    expect(declined.entities[legend]!.exhausted).toBe(false);
  });

  it("rejects a declaration on a card that has no optional cost", () => {
    const [state, card] = inHand(inMainPhase("nocost"), PLAIN.id);
    expect(() =>
      reduce(state, { type: "playCard", card, payAdditional: true }),
    ).toThrow(IllegalActionError);
  });
});

describe("the mandatory form (356.2.a)", () => {
  it("makes the card unplayable when the cost cannot be paid", () => {
    // 356.2.a: paying is part of playing, so with no friendly Unit to kill the
    // card cannot be played at all — the same shape as 422.3 for a Discard.
    const [state, card] = inHand(inMainPhase("unpayable"), SACRIFICE.id);
    const plays = legalActions(state, state.activePlayer).filter(
      (action) => action.type === "playCard" && action.card === card,
    );
    expect(plays).toEqual([]);

    expect(() => reduce(state, { type: "playCard", card })).toThrow(
      IllegalActionError,
    );
  });

  it("is payable, and paid, once there is something to pay it with", () => {
    const [withVictim, victim] = withUnit(inMainPhase("payable"));
    const [state, card] = inHand(withVictim, SACRIFICE.id);
    const player = state.activePlayer;

    expect(
      canPayAdditional(state, player, { kind: "kill", what: "unit" }),
    ).toBe(true);

    const played = reduce(state, { type: "playCard", card }).state;
    expect(played.players[player]!.zones.trash).toContain(victim);
    checkInvariants(played);
  });

  it("needs no declaration — it is not a choice", () => {
    const [withVictim] = withUnit(inMainPhase("nochoice"));
    const [state, card] = inHand(withVictim, SACRIFICE.id);
    const plays = legalActions(state, state.activePlayer).filter(
      (action) => action.type === "playCard" && action.card === card,
    );

    expect(plays).toHaveLength(1);
    expect(plays[0]).not.toHaveProperty("payAdditional");
  });
});

describe("payability", () => {
  it("checks each kind of payment against the state", () => {
    const state = inMainPhase("payability");
    const player = state.activePlayer;

    expect(canPayAdditional(state, player, { kind: "discard", count: 1 })).toBe(
      true,
    );
    expect(
      canPayAdditional(state, player, { kind: "discard", count: 99 }),
    ).toBe(false);
    expect(canPayAdditional(state, player, { kind: "exhaustLegend" })).toBe(
      true,
    );
    expect(canPayAdditional(state, player, { kind: "spendBuff" })).toBe(false);
    expect(
      canPayAdditional(state, player, { kind: "kill", what: "unit" }),
    ).toBe(false);
    expect(
      canPayAdditional(state, player, { kind: "resources", cost: cost(2) }),
    ).toBe(true);
    expect(
      canPayAdditional(state, player, { kind: "resources", cost: cost(99) }),
    ).toBe(false);
  });

  it("will not pay an exhaust cost twice", () => {
    const [state] = inHand(inMainPhase("twice", 3), BONUS.id);
    const player = state.activePlayer;
    const legend = state.players[player]!.zones.legendZone[0]!;
    const exhausted: GameState = {
      ...state,
      entities: {
        ...state.entities,
        [legend]: { ...state.entities[legend]!, exhausted: true },
      },
    };

    expect(canPayAdditional(exhausted, player, { kind: "exhaustLegend" })).toBe(
      false,
    );
  });
});

describe("Accelerate (rule 805)", () => {
  it("805.1.a: entering ready is what paying buys", () => {
    // The keyword is *functionally short for* an optional cost plus "if you do,
    // I enter ready", so the two plays must differ in exactly that.
    const [base, card] = inHand(inMainPhase("accel", 6), ACCELERATED.id);
    const player = base.activePlayer;
    const state = withPlayer(base, player, (seat) => ({
      ...seat,
      pool: { ...seat.pool, energy: 6, power: { ...seat.pool.power, fury: 1 } },
    }));

    const paid = reduce(state, {
      type: "playCard",
      card,
      payAdditional: true,
    }).state;
    const declined = reduce(state, { type: "playCard", card }).state;

    expect(paid.entities[card]!.exhausted).toBe(false);
    // 359.2.c: without the payment it enters exhausted like any other Unit.
    expect(declined.entities[card]!.exhausted).toBe(true);
    checkInvariants(paid);
  });

  it("357.1: the Power comes out of the same pool as the Total Cost", () => {
    const [base, card] = inHand(inMainPhase("accel-pool", 2), ACCELERATED.id);
    const player = base.activePlayer;
    const state = withPlayer(base, player, (seat) => ({
      ...seat,
      pool: { ...seat.pool, energy: 2, power: { ...seat.pool.power, fury: 1 } },
    }));

    const paid = reduce(state, {
      type: "playCard",
      card,
      payAdditional: true,
    }).state;

    // 1 Energy for the card, 1 Energy and 1 Fury for Accelerate.
    expect(paid.players[player]!.pool.energy).toBe(0);
    expect(paid.players[player]!.pool.power.fury).toBe(0);
  });

  it("is not offered when the Power cannot be paid", () => {
    // No Fury in the pool, so 805.1.a's cost is unpayable and only the plain
    // play survives — the accelerated one would strand the game at 357.2.
    const [base, card] = inHand(inMainPhase("accel-broke", 2), ACCELERATED.id);
    const player = base.activePlayer;
    const state = withPlayer(base, player, (seat) => ({
      ...seat,
      pool: { ...seat.pool, energy: 2, power: { ...seat.pool.power, fury: 0 } },
    }));

    const plays = legalActions(state, player).filter(
      (action) => action.type === "playCard" && action.card === card,
    );

    expect(plays).toHaveLength(1);
    expect(plays[0]).not.toHaveProperty("payAdditional");
  });
});
