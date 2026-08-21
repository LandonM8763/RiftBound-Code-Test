/**
 * The Standard Move.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
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
  makeSpell,
  makeUnit,
} from "@riftbound/cards/testing";
import { describe, expect, it } from "vitest";

import { IllegalActionError } from "./actions.js";
import { checkInvariants } from "./invariants.js";
import { currentLegalActions } from "./legal.js";
import { moveEntity } from "./mutate.js";
import { canStandardMove, standardMoveDestinations } from "./move.js";
import { reduce } from "./reduce.js";
import { createGame, type DeckList } from "./setup.js";
import {
  battlefieldLocation,
  type EntityId,
  type GameState,
  isOver,
  playerId,
  playerLocation,
} from "./state.js";

const LEGEND = makeLegend(["fury", "calm"], { id: cardId("M-000") });
const CHAMPION = makeUnit(3, ["fury"], { id: cardId("M-001"), champion: true });
const UNIT = makeUnit(2, ["fury"], {
  id: cardId("M-010"),
  name: "Mover",
  cost: cost(1),
});
const SPELL = makeSpell(["fury"], {
  id: cardId("M-011"),
  name: "Reaction",
  cost: cost(1),
  timing: "reaction",
});
const GANKER = makeUnit(2, ["fury"], {
  id: cardId("M-012"),
  name: "Ganker",
  cost: cost(1),
  keywords: [{ kind: "ganking" }],
});
const FURY_RUNE = makeRune("fury", { id: cardId("M-100") });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`M-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  UNIT,
  GANKER,
  SPELL,
  FURY_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    // Deep enough that `withReadyUnit` can always pull another Unit out.
    main: [
      ...Array.from({ length: 12 }, () => UNIT.id),
      ...Array.from({ length: 4 }, () => GANKER.id),
      SPELL.id,
      SPELL.id,
    ],
    runes: Array.from({ length: 8 }, () => FURY_RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

/** Take the empty Mulligan for every player so play can begin (rule 117). */
function pastMulligan(state: GameState): GameState {
  let next = state;
  while (next.phase === "mulligan") {
    next = reduce(next, { type: "mulligan", cards: [] }).state;
  }
  return next;
}

function inMainPhase(seed = "move"): GameState {
  let state = pastMulligan(
    createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state,
  );
  while (state.phase !== "main" && !isOver(state)) {
    state = reduce(state, { type: "resolvePhase" }).state;
  }
  return state;
}

/**
 * Put a ready Unit at the active player's Base.
 *
 * Playing one the normal way would leave it exhausted (359.2.c), and an
 * exhausted Unit cannot pay the Standard Move's cost — so these tests place it
 * directly rather than spending two turns getting there.
 */
function withReadyUnit(state: GameState, of = UNIT): [GameState, EntityId] {
  const player = state.activePlayer;
  const card = state.players[player]!.zones.mainDeck.find(
    (id) => state.entities[id]!.card === of.id,
  );
  if (card === undefined) {
    throw new Error(`No ${of.name} left in the deck`);
  }
  return [moveEntity(state, card, playerLocation(player, "base")), card];
}

/** Close the Showdown a move opened, handing Control to `player`. */
function settleShowdown(state: GameState, player: number): GameState {
  return {
    ...state,
    showdown: null,
    priority: state.activePlayer,
    battlefields: state.battlefields.map((battlefield, index) =>
      index === 0
        ? { ...battlefield, controller: playerId(player), contestedBy: null }
        : battlefield,
    ),
  };
}

describe("the Standard Move (rule 144)", () => {
  it("moves a Unit from its Base to a Battlefield (rule 144.4.a)", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    const player = state.activePlayer;

    const after = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;

    expect(after.battlefields[0]?.units).toContain(unit);
    expect(after.players[player]!.zones.base).not.toContain(unit);
    checkInvariants(after);
  });

  it("exhausts the Unit as the cost (rule 144.2)", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    expect(state.entities[unit]!.exhausted).toBe(false);

    const after = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;

    expect(after.entities[unit]!.exhausted).toBe(true);
  });

  it("refuses to move an exhausted Unit", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    const once = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;

    expect(() =>
      reduce(once, {
        type: "moveUnits",
        units: [unit],
        to: playerLocation(once.activePlayer, "base"),
      }),
    ).toThrow(IllegalActionError);
  });

  it("moves a Unit back from a Battlefield to its Base (rule 144.4.b)", () => {
    const [start, unit] = withReadyUnit(inMainPhase());
    const player = start.activePlayer;
    let state = reduce(start, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;

    // Settle the Showdown the move opened — nothing may move during one
    // (144.1.c) — and ready the Unit so it can pay the cost a second time.
    state = settleShowdown(state, player);
    state = {
      ...state,
      entities: {
        ...state.entities,
        [unit]: { ...state.entities[unit]!, exhausted: false },
      },
    };

    const back = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: playerLocation(player, "base"),
    }).state;

    expect(back.players[player]!.zones.base).toContain(unit);
    expect(back.battlefields[0]?.units).not.toContain(unit);
  });

  it("does not offer Battlefield-to-Battlefield without Ganking (rule 144.4.c)", () => {
    const [start, unit] = withReadyUnit(inMainPhase());
    const moved = reduce(start, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;
    const state: GameState = {
      ...settleShowdown(moved, moved.activePlayer),
      entities: {
        ...moved.entities,
        [unit]: { ...moved.entities[unit]!, exhausted: false },
      },
    };

    const destinations = standardMoveDestinations(state, unit);

    expect(destinations).toHaveLength(1);
    expect(destinations[0]).toEqual(playerLocation(state.activePlayer, "base"));
  });

  it("moves several Units together as one action (rule 144.3)", () => {
    let state = inMainPhase();
    const units: EntityId[] = [];
    for (let i = 0; i < 2; i += 1) {
      const [next, unit] = withReadyUnit(state);
      state = next;
      units.push(unit);
    }

    const after = reduce(state, {
      type: "moveUnits",
      units,
      to: battlefieldLocation(0),
    }).state;

    for (const unit of units) {
      expect(after.battlefields[0]?.units).toContain(unit);
      expect(after.entities[unit]!.exhausted).toBe(true);
    }
    checkInvariants(after);
  });

  it("rejects the same Unit twice in one Move", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    expect(() =>
      reduce(state, {
        type: "moveUnits",
        units: [unit, unit],
        to: battlefieldLocation(0),
      }),
    ).toThrow(/cannot move twice/);
  });

  it("rejects an empty Move", () => {
    expect(() =>
      reduce(inMainPhase(), {
        type: "moveUnits",
        units: [],
        to: battlefieldLocation(0),
      }),
    ).toThrow(/at least one Unit/);
  });

  it("rejects moving a Unit another player controls", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    const stolen: GameState = {
      ...state,
      entities: {
        ...state.entities,
        [unit]: { ...state.entities[unit]!, controller: opponent },
      },
    };

    expect(() =>
      reduce(stolen, {
        type: "moveUnits",
        units: [unit],
        to: battlefieldLocation(0),
      }),
    ).toThrow(/does not control/);
  });
});

describe("move timing (rules 144.1, 446.3)", () => {
  it("is unavailable outside the Main Phase (rule 144.1.a)", () => {
    const start = pastMulligan(
      createGame({
        decks: [deck(), deck()],
        registry: REGISTRY,
        seed: "timing",
      }).state,
    );
    const [state, unit] = withReadyUnit(start);

    expect(state.phase).toBe("awaken");
    expect(canStandardMove(state, unit)).toBe(false);
  });

  it("is unavailable while the state is Closed (rule 144.1.b)", () => {
    let state = inMainPhase("closed");
    const [ready, unit] = withReadyUnit(state);
    state = ready;

    // Put a Spell on the Chain to Close the state.
    const rune = state.players[state.activePlayer]!.zones.runes[0]!;
    state = reduce(state, { type: "addEnergy", rune }).state;
    const spell = state.players[state.activePlayer]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === SPELL.id,
    )!;
    state = moveEntity(
      state,
      spell,
      playerLocation(state.activePlayer, "hand"),
    );
    state = reduce(state, { type: "playCard", card: spell }).state;

    expect(canStandardMove(state, unit)).toBe(false);
    expect(
      currentLegalActions(state).some((action) => action.type === "moveUnits"),
    ).toBe(false);
  });

  it("does not use the Chain (rule 446.3.c)", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    const after = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;

    expect(after.chain).toHaveLength(0);
    expect(after.priority).toBe(after.activePlayer);
  });
});

describe("Contested status (rules 190.3, 450)", () => {
  it("Contests an uncontrolled Battlefield when a Unit moves in", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    const player = state.activePlayer;

    const result = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    });

    expect(result.state.battlefields[0]?.contestedBy).toBe(player);
    expect(result.events).toContainEqual({
      type: "battlefieldContested",
      battlefield: 0,
      player,
    });
  });

  it("does not Contest a Battlefield the mover already controls (rule 190.3.a.1)", () => {
    const [start, unit] = withReadyUnit(inMainPhase());
    const player = start.activePlayer;
    const controlled: GameState = {
      ...start,
      battlefields: start.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, controller: player } : battlefield,
      ),
    };

    const after = reduce(controlled, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;

    expect(after.battlefields[0]?.contestedBy).toBeNull();
  });

  it("does not establish Control on its own (rule 190.4)", () => {
    // Control is established at the *end of a Showdown or Combat*, so moving
    // onto an empty Battlefield leaves it Contested and awaiting one.
    const [state, unit] = withReadyUnit(inMainPhase());
    const after = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;

    expect(after.battlefields[0]?.controller).toBeNull();
    expect(after.battlefields[0]?.contestedBy).toBe(after.activePlayer);
  });

  it("blocks further movement while a Battlefield is Contested (rule 144.1.c)", () => {
    let state = inMainPhase();
    const [first, one] = withReadyUnit(state);
    const [second, two] = withReadyUnit(first);
    state = second;

    state = reduce(state, {
      type: "moveUnits",
      units: [one],
      to: battlefieldLocation(0),
    }).state;

    // A Showdown is now pending at that Battlefield; no Unit may move until it
    // resolves.
    expect(canStandardMove(state, two)).toBe(false);
  });
});

describe("Control cleanup (rule 190.4.c)", () => {
  it("loses Control of a Battlefield once the last Unit leaves", () => {
    const [start, unit] = withReadyUnit(inMainPhase());
    const player = start.activePlayer;

    // A Battlefield this player controls, with their Unit standing on it.
    let state = reduce(start, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;
    state = settleShowdown(state, player);
    state = {
      ...state,
      entities: {
        ...state.entities,
        [unit]: { ...state.entities[unit]!, exhausted: false },
      },
    };

    const result = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: playerLocation(player, "base"),
    });

    expect(result.state.battlefields[0]?.controller).toBeNull();
    expect(result.events).toContainEqual({
      type: "controlLost",
      battlefield: 0,
      player,
    });
  });

  it("keeps Control while a Unit remains", () => {
    let state = inMainPhase();
    const [first, one] = withReadyUnit(state);
    const [second, two] = withReadyUnit(first);
    state = second;
    const player = state.activePlayer;

    state = reduce(state, {
      type: "moveUnits",
      units: [one, two],
      to: battlefieldLocation(0),
    }).state;
    state = settleShowdown(state, player);
    state = {
      ...state,
      entities: {
        ...state.entities,
        [one]: { ...state.entities[one]!, exhausted: false },
      },
    };

    const after = reduce(state, {
      type: "moveUnits",
      units: [one],
      to: playerLocation(player, "base"),
    }).state;

    // One Unit walked home; the other still holds the Battlefield.
    expect(after.battlefields[0]?.units).toContain(two);
    expect(after.battlefields[0]?.controller).toBe(player);
  });
});

describe("legal action generation", () => {
  it("offers a move for each ready Unit and destination", () => {
    const [state, unit] = withReadyUnit(inMainPhase());
    const moves = currentLegalActions(state).filter(
      (action) => action.type === "moveUnits",
    );

    // One Unit at the Base, two Battlefields to choose between.
    expect(moves).toHaveLength(2);
    for (const move of moves) {
      expect(move.type).toBe("moveUnits");
      if (move.type === "moveUnits") {
        expect(move.units).toEqual([unit]);
      }
    }
  });

  it("offers nothing for a Unit still in hand", () => {
    const state = inMainPhase();
    expect(
      currentLegalActions(state).filter(
        (action) => action.type === "moveUnits",
      ),
    ).toEqual([]);
  });

  it("only ever offers moves reduce will accept", () => {
    const [state, _unit] = withReadyUnit(inMainPhase("accepts"));
    for (const action of currentLegalActions(state)) {
      expect(() => reduce(state, action)).not.toThrow();
    }
  });
});

describe("Ganking (rules 144.4.c, 810)", () => {
  it("is what makes a Battlefield-to-Battlefield Standard Move legal", () => {
    // 144.4.b alone gets a Unit at a Battlefield only back to its Base.
    const [placed, unit] = withReadyUnit(inMainPhase("gank"));
    const state = settleShowdown(
      moveEntity(placed, unit, battlefieldLocation(0)),
      0,
    );
    const player = state.activePlayer;

    expect(standardMoveDestinations(state, unit)).toEqual([
      playerLocation(playerId(player), "base"),
    ]);

    const [withGanker, ganker] = withReadyUnit(state, GANKER);
    const ganking = moveEntity(withGanker, ganker, battlefieldLocation(0));

    expect(standardMoveDestinations(ganking, ganker)).toContainEqual(
      battlefieldLocation(1),
    );
  });

  it("adds the option rather than replacing the move home (810.1.c.1)", () => {
    const [placed, ganker] = withReadyUnit(inMainPhase("gank-adds"), GANKER);
    const state = settleShowdown(
      moveEntity(placed, ganker, battlefieldLocation(0)),
      0,
    );
    const player = state.activePlayer;

    expect(standardMoveDestinations(state, ganker)).toContainEqual(
      playerLocation(playerId(player), "base"),
    );
  });

  it("never offers the Battlefield the Unit is already at", () => {
    const [placed, ganker] = withReadyUnit(inMainPhase("gank-same"), GANKER);
    const state = settleShowdown(
      moveEntity(placed, ganker, battlefieldLocation(0)),
      0,
    );

    expect(standardMoveDestinations(state, ganker)).not.toContainEqual(
      battlefieldLocation(0),
    );
  });

  it("costs the same exhaust and nothing more (810.1.c.2)", () => {
    const [placed, ganker] = withReadyUnit(inMainPhase("gank-cost"), GANKER);
    const state = settleShowdown(
      moveEntity(placed, ganker, battlefieldLocation(0)),
      0,
    );

    const after = reduce(state, {
      type: "moveUnits",
      units: [ganker],
      to: battlefieldLocation(1),
    }).state;

    expect(after.battlefields[1]?.units).toContain(ganker);
    expect(after.entities[ganker]!.exhausted).toBe(true);
    checkInvariants(after);
  });
});
