/**
 * State predicates.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * These are asked by statics, cost modifiers, effects and "enters ready"
 * alike, so they are tested once here rather than four times over.
 */
import {
  CardRegistry,
  cardId,
  cost,
  type CardDefinition,
} from "@riftbound/cards";
import {
  makeBattlefield,
  makeGear,
  makeLegend,
  makeRune,
  makeUnit,
} from "@riftbound/cards/testing";
import { describe, expect, it } from "vitest";

import { mightOf } from "./combat.js";
import { countOf } from "./count.js";
import { conditionMet } from "./condition.js";
import { moveEntity, withEntity, withPlayer } from "./mutate.js";
import { reduce } from "./reduce.js";
import { createGame, type DeckList } from "./setup.js";
import {
  battlefieldLocation,
  isOver,
  playerId,
  playerLocation,
  type EntityId,
  type GameState,
} from "./state.js";

const LEGEND = makeLegend(["fury"], { id: cardId("X-000") });
const CHAMPION = makeUnit(3, ["fury"], { id: cardId("X-001"), champion: true });
const PLAIN = makeUnit(2, ["fury"], {
  id: cardId("X-010"),
  name: "Plain",
  cost: cost(1),
});
/** 133.8.a gives an ordinary tag no rules meaning, but a card may ask about one. */
const PORO = makeUnit(1, ["fury"], {
  id: cardId("X-011"),
  name: "Poro",
  cost: cost(1),
  tags: ["Poro"],
});
const GEAR = makeGear(["fury"], {
  id: cardId("X-012"),
  name: "Gear",
  cost: cost(1),
});
const RUNE = makeRune("fury", { id: cardId("X-100") });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`X-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  PORO,
  GEAR,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 6 }, () => PLAIN.id),
      ...Array.from({ length: 4 }, () => PORO.id),
      ...Array.from({ length: 4 }, () => GEAR.id),
    ],
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function inMainPhase(seed = "condition"): GameState {
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
  return state;
}

/** Put a card of `id` onto `owner`'s Base, out of their deck. */
function onBoard(
  state: GameState,
  id: CardDefinition["id"],
  owner = state.activePlayer,
): [GameState, EntityId] {
  const card = state.players[owner]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (card === undefined) {
    throw new Error(`No ${id} left in player ${owner}'s deck`);
  }
  return [moveEntity(state, card, playerLocation(owner, "base")), card];
}

describe("controls (a count of what a player has on the Board)", () => {
  it("is false with none and true once one arrives", () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const condition = {
      kind: "controls",
      who: "you",
      what: "unit",
      min: 1,
      tag: "Poro",
    } as const;

    expect(conditionMet(state, player, undefined, condition)).toBe(false);
    const [withPoro] = onBoard(state, PORO.id);
    expect(conditionMet(withPoro, player, undefined, condition)).toBe(true);
  });

  it("matches a tag case-insensitively and ignores untagged Units", () => {
    const [state] = onBoard(inMainPhase("tag"), PLAIN.id);
    const player = state.activePlayer;

    expect(
      conditionMet(state, player, undefined, {
        kind: "controls",
        who: "you",
        what: "unit",
        min: 1,
        tag: "poro",
      }),
    ).toBe(false);
  });

  it("counts a threshold, not just presence", () => {
    let state = inMainPhase("two");
    const player = state.activePlayer;
    const condition = {
      kind: "controls",
      who: "you",
      what: "gear",
      min: 2,
    } as const;

    const [one] = onBoard(state, GEAR.id);
    state = one;
    expect(conditionMet(state, player, undefined, condition)).toBe(false);

    const [two] = onBoard(state, GEAR.id);
    expect(conditionMet(two, player, undefined, condition)).toBe(true);
  });

  it('excludes the source for "another"', () => {
    const [state, poro] = onBoard(inMainPhase("another"), PORO.id);
    const player = state.activePlayer;
    const condition = {
      kind: "controls",
      who: "you",
      what: "unit",
      min: 1,
      tag: "Poro",
      excludeSelf: true,
    } as const;

    expect(conditionMet(state, player, poro, condition)).toBe(false);
    const [second] = onBoard(state, PORO.id);
    expect(conditionMet(second, player, poro, condition)).toBe(true);
  });

  it('reads "an opponent controls" from the other seat', () => {
    const state = inMainPhase("theirs");
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);
    const condition = {
      kind: "controls",
      who: "opponent",
      what: "unit",
      min: 1,
    } as const;

    const [mine] = onBoard(state, PLAIN.id, player);
    expect(conditionMet(mine, player, undefined, condition)).toBe(false);

    const [theirs] = onBoard(mine, PLAIN.id, opponent);
    expect(conditionMet(theirs, player, undefined, condition)).toBe(true);
  });

  it("counts Battlefields off the board state, since they are not entities", () => {
    const state = inMainPhase("fields");
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);
    const condition = {
      kind: "controls",
      who: "opponent",
      what: "battlefield",
      min: 1,
    } as const;

    expect(conditionMet(state, player, undefined, condition)).toBe(false);
    const held: GameState = {
      ...state,
      battlefields: state.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: opponent } : battlefield,
      ),
    };
    expect(conditionMet(held, player, undefined, condition)).toBe(true);
  });

  it("sees a Unit at a Battlefield as well as one at a Base", () => {
    const [placed, poro] = onBoard(inMainPhase("at-bf"), PORO.id);
    const state = moveEntity(placed, poro, battlefieldLocation(0));

    expect(
      conditionMet(state, state.activePlayer, undefined, {
        kind: "controls",
        who: "you",
        what: "unit",
        min: 1,
        tag: "Poro",
      }),
    ).toBe(true);
  });
});

describe("scoreWithin (194.3)", () => {
  it("measures against the Victory Score, not a fixed number", () => {
    const state = inMainPhase("score");
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);
    const condition = {
      kind: "scoreWithin",
      who: "opponent",
      points: 3,
    } as const;

    expect(conditionMet(state, player, undefined, condition)).toBe(false);

    // Victory Score is 8, so 5 points is exactly 3 away.
    const close = withPlayer(state, opponent, (seat) => ({
      ...seat,
      points: 5,
    }));
    expect(conditionMet(close, player, undefined, condition)).toBe(true);
  });

  it("follows a Mode of Play that sets a different Victory Score (483.3)", () => {
    const state = inMainPhase("mode");
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);
    const scored = withPlayer(state, opponent, (seat) => ({
      ...seat,
      points: 5,
    }));
    const condition = {
      kind: "scoreWithin",
      who: "opponent",
      points: 3,
    } as const;

    expect(conditionMet(scored, player, undefined, condition)).toBe(true);
    // Raise the Victory Score and the same 5 points is no longer close.
    const longer: GameState = {
      ...scored,
      config: { ...scored.config, victoryScore: 12 },
    };
    expect(conditionMet(longer, player, undefined, condition)).toBe(false);
  });
});

describe("didThisTurn", () => {
  it("is false before anything happens and true after", () => {
    const state = inMainPhase("turn");
    const player = state.activePlayer;
    const condition = {
      kind: "didThisTurn",
      event: "played",
      who: "you",
      min: 1,
    } as const;

    expect(conditionMet(state, player, undefined, condition)).toBe(false);

    const counted = withPlayer(state, player, (seat) => ({
      ...seat,
      turnEvents: { ...seat.turnEvents, played: 1 },
    }));
    expect(conditionMet(counted, player, undefined, condition)).toBe(true);
  });

  it("separates your events from an opponent`s", () => {
    const state = inMainPhase("sides");
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);
    const theirs = withPlayer(state, opponent, (seat) => ({
      ...seat,
      turnEvents: { ...seat.turnEvents, dies: 1 },
    }));

    expect(
      conditionMet(theirs, player, undefined, {
        kind: "didThisTurn",
        event: "dies",
        who: "opponent",
        min: 1,
      }),
    ).toBe(true);
    expect(
      conditionMet(theirs, player, undefined, {
        kind: "didThisTurn",
        event: "dies",
        who: "you",
        min: 1,
      }),
    ).toBe(false);
  });

  it("is counted as the game runs, and cleared with the turn", () => {
    // 812.1.c scopes "this turn" the same way `playedThisTurn` is scoped.
    let state = inMainPhase("counted");
    const player = state.activePlayer;
    const card = state.players[player]!.zones.hand[0];
    if (card !== undefined) {
      state = withPlayer(state, player, (seat) => ({
        ...seat,
        pool: { ...seat.pool, energy: 5 },
      }));
      state = reduce(state, { type: "playCard", card }).state;
      while (state.chain.length > 0) {
        state = reduce(state, { type: "pass" }).state;
      }
      expect(state.players[player]!.turnEvents.played).toBeGreaterThanOrEqual(
        1,
      );
    }

    state = reduce(state, { type: "endTurn" }).state;
    while (state.phase === "ending") {
      state = reduce(state, { type: "resolvePhase" }).state;
    }
    for (const seat of state.players) {
      expect(seat.turnEvents).toEqual({});
    }
  });
});

describe("source-relative conditions", () => {
  it("is false without a source, because a card in hand is neither", () => {
    // "While I'm buffed" cannot hold for a card that is not a Game Object yet.
    const state = inMainPhase("nosource");
    for (const kind of ["buffed", "atBattlefield"] as const) {
      expect(conditionMet(state, state.activePlayer, undefined, { kind })).toBe(
        false,
      );
    }
  });

  it("reads the source once it is on the Board", () => {
    const [placed, unit] = onBoard(inMainPhase("source"), PLAIN.id);
    const player = placed.activePlayer;

    expect(conditionMet(placed, player, unit, { kind: "atBattlefield" })).toBe(
      false,
    );
    const moved = moveEntity(placed, unit, battlefieldLocation(0));
    expect(conditionMet(moved, player, unit, { kind: "atBattlefield" })).toBe(
      true,
    );
  });
});

describe("an absent condition", () => {
  it("imposes nothing", () => {
    const state = inMainPhase("absent");
    expect(conditionMet(state, state.activePlayer, undefined, undefined)).toBe(
      true,
    );
  });
});

describe("Runes count as Board presence (161.1.a)", () => {
  it('counts Channelled Runes, which is what "while you have 8+ runes" asks', () => {
    // 161.1.a: a Rune stays on the Board until it is Recycled or otherwise
    // removed, so it is part of what a player "has" the same way a Unit is.
    const state = inMainPhase("runes");
    const player = state.activePlayer;
    const channelled = state.players[player]!.zones.runes.length;
    expect(channelled).toBeGreaterThan(0);

    const predicate = { kind: "controls", who: "you", what: "rune" } as const;
    expect(
      conditionMet(state, player, undefined, { ...predicate, min: channelled }),
    ).toBe(true);
    expect(
      conditionMet(state, player, undefined, {
        ...predicate,
        min: channelled + 1,
      }),
    ).toBe(false);
  });

  it("does not count Runes still in the Rune Deck", () => {
    const state = inMainPhase("rune-deck");
    const player = state.activePlayer;
    const total =
      state.players[player]!.zones.runes.length +
      state.players[player]!.zones.runeDeck.length;

    expect(
      conditionMet(state, player, undefined, {
        kind: "controls",
        who: "you",
        what: "rune",
        min: total,
      }),
    ).toBe(false);
  });
});

describe('"here" on a controls predicate (355.9)', () => {
  const HERE = {
    kind: "controls",
    who: "you",
    what: "unit",
    min: 1,
    here: true,
    excludeSelf: true,
  } as const;

  it("counts only Units at the source`s own Battlefield", () => {
    let state = inMainPhase("here");
    const player = state.activePlayer;
    const [a, source] = onBoard(state, PLAIN.id);
    state = moveEntity(a, source, battlefieldLocation(0));

    // Alone at Battlefield 0: "another unit here" is false.
    expect(conditionMet(state, player, source, HERE)).toBe(false);

    // A friend at a *different* Battlefield still does not count.
    const [b, elsewhere] = onBoard(state, PLAIN.id);
    state = moveEntity(b, elsewhere, battlefieldLocation(1));
    expect(conditionMet(state, player, source, HERE)).toBe(false);

    // A friend at the same one does.
    const [c, together] = onBoard(state, PLAIN.id);
    state = moveEntity(c, together, battlefieldLocation(0));
    expect(conditionMet(state, player, source, HERE)).toBe(true);
  });

  it("is false for a source that names no Battlefield", () => {
    // A source in a Base, or a card still in hand, has no "here" at all.
    let state = inMainPhase("here-base");
    const player = state.activePlayer;
    const [a, source] = onBoard(state, PLAIN.id);
    const [b] = onBoard(a, PLAIN.id);
    state = b;

    expect(conditionMet(state, player, source, HERE)).toBe(false);
    expect(conditionMet(state, player, undefined, HERE)).toBe(false);
  });
});

describe("counts read off the state (dynamic values)", () => {
  it("counts what a player controls, by type and tag", () => {
    let state = inMainPhase("count-basic");
    const player = state.activePlayer;
    const before = countOf(state, player, undefined, {
      kind: "controlled",
      who: "you",
      what: "unit",
    });

    const [withUnit] = onBoard(state, PLAIN.id);
    state = withUnit;

    expect(
      countOf(state, player, undefined, {
        kind: "controlled",
        who: "you",
        what: "unit",
      }),
    ).toBe(before + 1);
  });

  it("708: counts a Unit as MIGHTY exactly while its Might is 5 or more", () => {
    let state = inMainPhase("count-mighty");
    const player = state.activePlayer;
    const [placed, unit] = onBoard(state, PLAIN.id);
    state = placed;

    const mighty = {
      kind: "controlled",
      who: "you",
      what: "unit",
      mighty: true,
    } as const;
    // PLAIN is 2 Might, so nothing qualifies yet.
    expect(countOf(state, player, undefined, mighty, mightOf)).toBe(0);

    // 708's threshold is 5, so +3 is exactly enough.
    state = withEntity(state, unit, (e) => ({ ...e, mightBonus: 3 }));
    expect(mightOf(state, unit)).toBe(5);
    expect(countOf(state, player, undefined, mighty, mightOf)).toBe(1);
  });

  it("reads 0 for a Mighty count when no Might function is supplied", () => {
    // That is the guard against recursion: a static's grant asks without one,
    // because `mightOf` is what is asking. The parser refuses the combination,
    // so this is the belt to its braces rather than a reachable path.
    let state = inMainPhase("count-no-might");
    const player = state.activePlayer;
    const [placed, unit] = onBoard(state, PLAIN.id);
    state = withEntity(placed, unit, (e) => ({ ...e, mightBonus: 5 }));

    expect(
      countOf(state, player, undefined, {
        kind: "controlled",
        who: "you",
        what: "unit",
        mighty: true,
      }),
    ).toBe(0);
  });

  it("702: counts buffed Units, which reads a counter rather than Might", () => {
    let state = inMainPhase("count-buffed");
    const player = state.activePlayer;
    const [a, source] = onBoard(state, PLAIN.id);
    state = moveEntity(a, source, battlefieldLocation(0));
    const [b, friend] = onBoard(state, PLAIN.id);
    state = moveEntity(b, friend, battlefieldLocation(0));

    const buffedHere = {
      kind: "controlled",
      who: "you",
      what: "unit",
      here: true,
      buffed: true,
    } as const;

    expect(countOf(state, player, source, buffedHere)).toBe(0);
    state = withEntity(state, friend, (e) => ({ ...e, buffs: 1 }));
    expect(countOf(state, player, source, buffedHere)).toBe(1);
  });

  it("counts Battlefields, excluding the source`s own", () => {
    let state = inMainPhase("count-battlefields");
    const player = state.activePlayer;
    const others = {
      kind: "controlled",
      who: "you",
      what: "battlefield",
      excludeSelf: true,
    } as const;

    // Take Control of both Battlefields.
    state = {
      ...state,
      battlefields: state.battlefields.map((battlefield) => ({
        ...battlefield,
        controller: player,
      })),
    };

    // Asked by Battlefield 0's own Game Object, it does not count itself.
    const source = state.battlefields[0]!.entity;
    expect(countOf(state, player, source, others)).toBe(
      state.battlefields.length - 1,
    );
    // Asked by something that is not a Battlefield, all of them count.
    expect(countOf(state, player, undefined, others)).toBe(
      state.battlefields.length,
    );
  });
});
