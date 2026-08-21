/**
 * Non-Combat Showdowns and Scoring by Conquer.
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

import { checkInvariants } from "./invariants.js";
import { currentLegalActions, legalActions } from "./legal.js";
import { moveEntity } from "./mutate.js";
import { reduce } from "./reduce.js";
import { createGame, type DeckList } from "./setup.js";
import {
  battlefieldLocation,
  type EntityId,
  type GameState,
  isOver,
  isShowdown,
  playerId,
  playerLocation,
} from "./state.js";

const LEGEND = makeLegend(["fury", "calm"], { id: cardId("S-000") });
const CHAMPION = makeUnit(3, ["fury"], { id: cardId("S-001"), champion: true });
const UNIT = makeUnit(2, ["fury"], {
  id: cardId("S-010"),
  name: "Unit",
  cost: cost(1),
});
const ACTION_SPELL = makeSpell(["fury"], {
  id: cardId("S-011"),
  name: "Action",
  cost: cost(1),
  timing: "action",
});
/** "Move a friendly unit." An Action, so it is playable during a Showdown. */
const CHARGE = makeSpell(["fury"], {
  id: cardId("S-012"),
  name: "Charge",
  cost: cost(0),
  timing: "action",
  effect: {
    target: { kind: "unit", scope: "friendly" },
    destination: { kind: "battlefield" },
    effects: [{ kind: "move" }],
  },
});
const FURY_RUNE = makeRune("fury", { id: cardId("S-100") });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`S-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  UNIT,
  ACTION_SPELL,
  CHARGE,
  FURY_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 12 }, () => UNIT.id),
      ACTION_SPELL.id,
      ACTION_SPELL.id,
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

function inMainPhase(seed = "showdown"): GameState {
  let state = pastMulligan(
    createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state,
  );
  while (state.phase !== "main" && !isOver(state)) {
    state = reduce(state, { type: "resolvePhase" }).state;
  }
  return state;
}

function withReadyUnit(state: GameState): [GameState, EntityId] {
  const player = state.activePlayer;
  const card = state.players[player]!.zones.mainDeck.find(
    (id) => state.entities[id]!.card === UNIT.id,
  );
  if (card === undefined) {
    throw new Error("No Unit left in the deck");
  }
  return [moveEntity(state, card, playerLocation(player, "base")), card];
}

/** Move a Unit onto an empty Battlefield, which opens a Showdown. */
function contesting(seed = "showdown"): { state: GameState; unit: EntityId } {
  const [start, unit] = withReadyUnit(inMainPhase(seed));
  const state = reduce(start, {
    type: "moveUnits",
    units: [unit],
    to: battlefieldLocation(0),
  }).state;
  return { state, unit };
}

/** Pass Focus until the Showdown Closes (rule 347.2.a). */
function passUntilClosed(state: GameState): GameState {
  let next = state;
  for (let i = 0; i < 10 && isShowdown(next); i += 1) {
    next = reduce(next, { type: "pass" }).state;
  }
  return next;
}

describe("opening a Showdown (rules 344-345)", () => {
  it("opens when a Unit Contests an empty Battlefield", () => {
    const { state } = contesting();

    expect(isShowdown(state)).toBe(true);
    expect(state.showdown?.battlefield).toBe(0);
    expect(state.showdown?.combat).toBe(false);
  });

  it("gives Focus to the player who applied Contested (rule 345)", () => {
    const { state } = contesting();
    const mover = state.activePlayer;

    expect(state.showdown?.focus).toBe(mover);
    expect(state.priority).toBe(mover);
  });

  it("reports the opening as an event", () => {
    const [start, unit] = withReadyUnit(inMainPhase());
    const result = reduce(start, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    });

    expect(result.events).toContainEqual({
      type: "showdownOpened",
      battlefield: 0,
      focus: start.activePlayer,
    });
  });
});

describe("acting during a Showdown (rules 342, 347)", () => {
  it("offers only Action or Reaction cards (rule 308.1.a)", () => {
    let { state } = contesting();
    // Give the player the resources and a Unit to try to play.
    const rune = state.players[state.activePlayer]!.zones.runes[0]!;
    state = reduce(state, { type: "addEnergy", rune }).state;

    const unitInHand = state.players[state.activePlayer]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === UNIT.id,
    )!;
    const spell = state.players[state.activePlayer]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === ACTION_SPELL.id,
    )!;
    state = moveEntity(
      state,
      unitInHand,
      playerLocation(state.activePlayer, "hand"),
    );
    state = moveEntity(
      state,
      spell,
      playerLocation(state.activePlayer, "hand"),
    );

    const plays = currentLegalActions(state).filter(
      (action) => action.type === "playCard",
    );

    // Whatever is offered, none of it may be a Unit: only Action and Reaction
    // cards are playable in a Showdown State.
    expect(plays.length).toBeGreaterThan(0);
    for (const play of plays) {
      if (play.type !== "playCard") continue;
      expect(state.entities[play.card]!.card).toBe(ACTION_SPELL.id);
    }
    expect(
      plays.some((play) => play.type === "playCard" && play.card === spell),
    ).toBe(true);
    expect(
      plays.some(
        (play) => play.type === "playCard" && play.card === unitInHand,
      ),
    ).toBe(false);
  });

  it("offers no Standard Move during a Showdown (rule 144.1.c)", () => {
    const { state } = contesting();
    expect(
      currentLegalActions(state).some((action) => action.type === "moveUnits"),
    ).toBe(false);
  });

  it("offers no endTurn during a Showdown", () => {
    const { state } = contesting();
    expect(
      currentLegalActions(state).some((action) => action.type === "endTurn"),
    ).toBe(false);
  });

  it("passes Focus to the next player rather than ending at once (rule 347.2.b)", () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    const opponent = playerId((mover + 1) % state.players.length);

    const after = reduce(state, { type: "pass" }).state;

    expect(isShowdown(after)).toBe(true);
    expect(after.showdown?.focus).toBe(opponent);
    expect(after.priority).toBe(opponent);
  });

  it("gives the player without Focus no actions", () => {
    const { state } = contesting();
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    expect(legalActions(state, opponent)).toEqual([]);
  });
});

describe("closing a Showdown (rule 348.2)", () => {
  it("Closes once every player has passed in sequence (rule 347.2.a)", () => {
    const { state } = contesting();
    const closed = passUntilClosed(state);

    expect(isShowdown(closed)).toBe(false);
    expect(closed.priority).toBe(closed.activePlayer);
  });

  it("establishes Control for the only player with Units there", () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    const closed = passUntilClosed(state);

    expect(closed.battlefields[0]?.controller).toBe(mover);
    expect(closed.battlefields[0]?.contestedBy).toBeNull();
    checkInvariants(closed);
  });

  it("reports establishing Control as an event", () => {
    let { state } = contesting();
    const mover = state.activePlayer;
    state = reduce(state, { type: "pass" }).state;
    const result = reduce(state, { type: "pass" });

    expect(result.events).toContainEqual({
      type: "controlEstablished",
      battlefield: 0,
      player: mover,
    });
  });

  it("lets play continue normally afterwards", () => {
    const closed = passUntilClosed(contesting().state);
    expect(
      currentLegalActions(closed).some((action) => action.type === "endTurn"),
    ).toBe(true);
  });
});

describe("Scoring by Conquer (rules 469.1, 471)", () => {
  it("scores a point for establishing Control (rule 348.2.a.1)", () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    expect(state.players[mover]!.points).toBe(0);

    const closed = passUntilClosed(state);

    expect(closed.players[mover]!.points).toBe(1);
    expect(closed.battlefields[0]?.scoredBy).toEqual([mover]);
  });

  it("records the method as a Conquer (rule 469.1)", () => {
    let { state } = contesting();
    const mover = state.activePlayer;
    state = reduce(state, { type: "pass" }).state;
    const result = reduce(state, { type: "pass" });

    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "pointsScored",
        method: "conquer",
        player: mover,
      }),
    );
  });

  it("does not score a Battlefield already Scored this turn (rule 470)", () => {
    const { state } = contesting();
    const mover = state.activePlayer;
    const alreadyScored: GameState = {
      ...state,
      battlefields: state.battlefields.map((battlefield, index) =>
        index === 0 ? { ...battlefield, scoredBy: [mover] } : battlefield,
      ),
    };

    const closed = passUntilClosed(alreadyScored);

    expect(closed.players[mover]!.points).toBe(0);
    expect(closed.battlefields[0]?.controller).toBe(mover);
  });
});

describe("the Final Point restriction (rule 471.1.b)", () => {
  /** A Conquer while one point short of the Victory Score. */
  function onTheBrink(scoredOther: boolean): {
    state: GameState;
    mover: number;
  } {
    const { state } = contesting("brink");
    const mover = state.activePlayer;
    return {
      mover,
      state: {
        ...state,
        players: state.players.map((player) =>
          player.id === mover
            ? { ...player, points: state.config.victoryScore - 1 }
            : player,
        ),
        battlefields: state.battlefields.map((battlefield, index) =>
          index === 1 && scoredOther
            ? { ...battlefield, scoredBy: [mover] }
            : battlefield,
        ),
      },
    };
  }

  it("denies the Final Point unless every Battlefield was Scored this turn", () => {
    const { state, mover } = onTheBrink(false);
    const handBefore = state.players[mover]!.zones.hand.length;

    const closed = passUntilClosed(state);

    // No point; a card is drawn instead (rule 471.1.b.1).
    expect(closed.players[mover]!.points).toBe(state.config.victoryScore - 1);
    expect(closed.players[mover]!.zones.hand).toHaveLength(handBefore + 1);
    expect(closed.outcome).toBeNull();
  });

  it("reports the denial as an event", () => {
    const { state, mover } = onTheBrink(false);
    let next = reduce(state, { type: "pass" }).state;
    const result = reduce(next, { type: "pass" });

    expect(result.events).toContainEqual({
      type: "finalPointDenied",
      player: playerId(mover),
      battlefield: 0,
    });
  });

  it("grants the Final Point when every Battlefield was Scored this turn", () => {
    const { state, mover } = onTheBrink(true);

    const closed = passUntilClosed(state);

    expect(closed.players[mover]!.points).toBe(state.config.victoryScore);
    expect(closed.outcome).toEqual({ kind: "win", winner: playerId(mover) });
  });

  it("does not restrict a Conquer that is not for the Final Point", () => {
    const { state } = contesting("not-final");
    const mover = state.activePlayer;
    const early: GameState = {
      ...state,
      players: state.players.map((player) =>
        player.id === mover ? { ...player, points: 3 } : player,
      ),
    };

    const closed = passUntilClosed(early);

    expect(closed.players[mover]!.points).toBe(4);
  });
});

/**
 * A Non-Combat Showdown becoming a Combat Showdown (316.8.b.1.a).
 *
 * Rule 464.1 gives Combat two ways to open, and this is the second: a
 * Non-Combat Showdown is ongoing when a Unit controlled by a different player
 * becomes present, and "this will cause the Showdown to become a Combat
 * Showdown in the following cleanup".
 *
 * Before this, the Showdown stayed non-combat and closed by establishing
 * Control — the two sides never fought.
 *
 * This block builds its own deck: the arriving Unit has to come from a card
 * effect, because 144 restricts the Standard Move to the Turn Player and
 * `canStandardMove` refuses it while a Showdown is running.
 */
describe("a Non-Combat Showdown becoming a Combat Showdown (316.8.b.1.a)", () => {
  const CONVERT_REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    UNIT,
    CHARGE,
    FURY_RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function convertDeck(): DeckList {
    return {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 10 }, () => UNIT.id),
        ...Array.from({ length: 6 }, () => CHARGE.id),
      ],
      runes: Array.from({ length: 8 }, () => FURY_RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
  }

  /** A Non-Combat Showdown, opened by the Turn Player at Battlefield 0. */
  function nonCombat(seed: string): { state: GameState; attacker: number } {
    let state = pastMulligan(
      createGame({
        decks: [convertDeck(), convertDeck()],
        registry: CONVERT_REGISTRY,
        seed,
      }).state,
    );
    while (state.phase !== "main" && !isOver(state)) {
      state = reduce(state, { type: "resolvePhase" }).state;
    }
    const attacker = state.activePlayer;
    const unit = state.players[attacker]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === UNIT.id,
    )!;
    state = moveEntity(state, unit, playerLocation(attacker, "base"));
    state = reduce(state, {
      type: "moveUnits",
      units: [unit],
      to: battlefieldLocation(0),
    }).state;
    return { state, attacker };
  }

  /** Find a card of `id` for `seat`, wherever it currently is. */
  function cardFor(
    state: GameState,
    seat: number,
    id: CardDefinition["id"],
  ): EntityId {
    const zones = state.players[seat]!.zones;
    const found = [...zones.mainDeck, ...zones.hand].find(
      (candidate) => state.entities[candidate]!.card === id,
    );
    if (found === undefined) {
      throw new Error(`no ${id} for player ${seat}`);
    }
    return found;
  }

  /**
   * The opponent takes Focus and plays a Spell that Moves one of their Units
   * into the contested Battlefield. The Move's Cleanup (453) is where
   * 316.8.b.1.a converts the Showdown.
   */
  function opposed(seed: string): {
    state: GameState;
    events: readonly { readonly type: string }[];
    attacker: number;
    defender: number;
  } {
    const { state: opened, attacker } = nonCombat(seed);
    const defender = playerId((attacker + 1) % opened.players.length);

    const unit = cardFor(opened, defender, UNIT.id);
    const spell = cardFor(opened, defender, CHARGE.id);
    let armed = moveEntity(opened, unit, playerLocation(defender, "base"));
    armed = moveEntity(armed, spell, playerLocation(defender, "hand"));

    // 347.2.b: passing hands Focus, and with it Priority, to the opponent.
    const theirTurn = reduce(armed, { type: "pass" }).state;
    if (theirTurn.priority !== defender) {
      throw new Error(
        `expected Focus to pass to ${defender}, got ${String(theirTurn.priority)}`,
      );
    }

    let next = reduce(theirTurn, {
      type: "playCard",
      card: spell,
      targets: [unit],
      destination: battlefieldLocation(0),
    }).state;

    // Drain the Chain so the Spell resolves and its Move runs.
    const events: { readonly type: string }[] = [];
    let guard = 0;
    while (next.chain.length > 0 && guard < 8) {
      const result = reduce(next, { type: "pass" });
      events.push(...result.events);
      next = result.state;
      guard += 1;
    }
    return { state: next, events, attacker, defender };
  }

  it("is a Non-Combat Showdown until the opposing Unit arrives", () => {
    const { state } = nonCombat("convert-before");
    expect(state.showdown?.combat).toBe(false);
    expect(state.showdown?.attacker).toBeNull();
  });

  it("464.2.c.1: the Attacker is whoever applied Contested, not who arrived second", () => {
    const { state, attacker, defender } = opposed("convert-who");

    expect(state.showdown?.combat ?? false).toBe(true);
    expect(state.showdown?.attacker).toBe(attacker);
    expect(state.showdown?.defender).toBe(defender);
  });

  it("464.2.d: the Attacker has Focus once the step completes", () => {
    const { state, attacker } = opposed("convert-focus");

    expect(state.showdown?.focus).toBe(attacker);
    expect(state.priority).toBe(attacker);
  });

  it("reports the Combat opening as an event", () => {
    const { events, attacker, defender } = opposed("convert-event");

    expect(events).toContainEqual({
      type: "combatOpened",
      battlefield: 0,
      attacker,
      defender,
    });
  });

  it("then fights, rather than closing by establishing Control", () => {
    const { state, attacker } = opposed("convert-fight");
    let next = state;

    let guard = 0;
    while (isShowdown(next) && guard < 12) {
      next = reduce(next, { type: "pass" }).state;
      guard += 1;
    }

    // Two 2-Might Units traded (465-466), so neither side is left standing and
    // nobody simply took the Battlefield.
    expect(next.battlefields[0]!.units).toHaveLength(0);
    expect(next.battlefields[0]!.controller).not.toBe(attacker);
    checkInvariants(next);
  });

  it("leaves a Showdown alone while only one player has Units there", () => {
    const { state } = nonCombat("convert-none");
    const next = reduce(state, { type: "pass" }).state;

    // Passing Focus does not invent a Combat out of a one-sided Battlefield.
    expect(next.showdown?.combat ?? false).toBe(false);
  });
});
