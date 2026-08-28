/**
 * The Chain, Rune Pools and the Process of Play.
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
  makeGear,
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
} from "@riftbound/cards/testing";
import { describe, expect, it } from "vitest";

import { IllegalActionError } from "./actions.js";
import { checkInvariants } from "./invariants.js";
import { currentLegalActions, legalActions } from "./legal.js";
import { reduce } from "./reduce.js";
import { entersReady } from "./statics.js";
import { moveEntity, withEntity, withPlayer } from "./mutate.js";
import { createGame, type DeckList } from "./setup.js";
import {
  type EntityId,
  type GameState,
  isClosed,
  isOver,
  playerId,
  playerLocation,
  sameLocation,
} from "./state.js";

const LEGEND = makeLegend(["fury", "calm"], { id: cardId("P-000") });
const CHAMPION = makeUnit(3, ["fury"], { id: cardId("P-001"), champion: true });
/** 1 Energy, no Power: affordable from a single exhausted Rune. */
const CHEAP_UNIT = makeUnit(2, ["fury"], {
  id: cardId("P-010"),
  name: "Cheap",
  cost: cost(1),
});
/** 1 Fury Power and no Energy: only payable by Recycling a Fury Rune. */
const POWER_UNIT = makeUnit(4, ["fury"], {
  id: cardId("P-011"),
  name: "Power Unit",
  cost: cost(0, "fury"),
});
const GEAR = makeGear(["fury"], {
  id: cardId("P-012"),
  name: "Gear",
  cost: cost(1),
});
const ACTION_SPELL = makeSpell(["fury"], {
  id: cardId("P-013"),
  name: "Action Spell",
  cost: cost(1),
  timing: "action",
});
const REACTION_SPELL = makeSpell(["fury"], {
  id: cardId("P-014"),
  name: "Reaction Spell",
  cost: cost(1),
  timing: "reaction",
});
const FURY_RUNE = makeRune("fury", { id: cardId("P-100") });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`P-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  CHEAP_UNIT,
  POWER_UNIT,
  GEAR,
  ACTION_SPELL,
  REACTION_SPELL,
  FURY_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

/** Both players draw the same four-card opening hand: one of each playable. */
function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    // Two Action Spells: one test plays one and then needs a second in hand.
    main: [
      CHEAP_UNIT.id,
      POWER_UNIT.id,
      ACTION_SPELL.id,
      ACTION_SPELL.id,
      REACTION_SPELL.id,
      GEAR.id,
      GEAR.id,
    ],
    runes: Array.from({ length: 8 }, () => FURY_RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

/** A game sitting in the Main Phase with two Runes Channelled. */
/** Take the empty Mulligan for every player so play can begin (rule 117). */
function pastMulligan(state: GameState): GameState {
  let next = state;
  while (next.phase === "mulligan") {
    next = reduce(next, { type: "mulligan", cards: [] }).state;
  }
  return next;
}

function inMainPhase(seed = "play"): GameState {
  let state = pastMulligan(
    createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state,
  );
  while (state.phase !== "main" && !isOver(state)) {
    state = reduce(state, { type: "resolvePhase" }).state;
  }
  return state;
}

/**
 * Put a specific card in the active player's hand, drawing it out of their Main
 * Deck if the shuffle did not deal it. Tests here are about the Process of
 * Play, so which cards the opening hand happened to contain is noise.
 */
function withCardInHand(
  state: GameState,
  card: CardDefinition,
): [GameState, EntityId] {
  const player = state.activePlayer;
  const zones = state.players[player]!.zones;

  const held = zones.hand.find((id) => state.entities[id]!.card === card.id);
  if (held !== undefined) {
    return [state, held];
  }

  const inDeck = zones.mainDeck.find(
    (id) => state.entities[id]!.card === card.id,
  );
  if (inDeck === undefined) {
    throw new Error(`${card.name} is in neither hand nor deck`);
  }
  return [moveEntity(state, inDeck, playerLocation(player, "hand")), inDeck];
}

function addEnergy(state: GameState, count: number): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) {
    const rune = next.players[next.activePlayer]!.zones.runes.find(
      (id) => !next.entities[id]!.exhausted,
    );
    if (rune === undefined) {
      throw new Error("No ready Rune left to exhaust");
    }
    next = reduce(next, { type: "addEnergy", rune }).state;
  }
  return next;
}

describe("Rune Pools (rules 165-167)", () => {
  it("starts the Main Phase empty", () => {
    const state = inMainPhase();
    for (const player of state.players) {
      expect(player.pool.energy).toBe(0);
      expect(player.pool.power.fury).toBe(0);
    }
  });

  it("exhausts a Rune to Add 1 Energy (rule 164.2.a)", () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const rune = state.players[player]!.zones.runes[0]!;

    const after = reduce(state, { type: "addEnergy", rune }).state;

    expect(after.players[player]!.pool.energy).toBe(1);
    expect(after.entities[rune]!.exhausted).toBe(true);
    checkInvariants(after);
  });

  it("refuses to exhaust the same Rune twice", () => {
    const state = inMainPhase();
    const rune = state.players[state.activePlayer]!.zones.runes[0]!;
    const once = reduce(state, { type: "addEnergy", rune }).state;

    expect(() => reduce(once, { type: "addEnergy", rune })).toThrow(
      IllegalActionError,
    );
  });

  it("Recycles a Rune to Add 1 Power of its Domain (rules 164.2.b, 416.1.b)", () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const rune = state.players[player]!.zones.runes[0]!;
    const deckBefore = state.players[player]!.zones.runeDeck.length;

    const after = reduce(state, { type: "addPower", rune }).state;

    expect(after.players[player]!.pool.power.fury).toBe(1);
    expect(after.players[player]!.zones.runes).not.toContain(rune);
    // Recycling puts it on the *bottom* of the Rune Deck.
    expect(after.players[player]!.zones.runeDeck).toHaveLength(deckBefore + 1);
    expect(after.players[player]!.zones.runeDeck.at(-1)).toBe(rune);
    checkInvariants(after);
  });

  it("empties at the end of the turn, losing anything unspent (rule 317.2.e)", () => {
    const state = addEnergy(inMainPhase(), 2);
    const player = state.activePlayer;
    expect(state.players[player]!.pool.energy).toBe(2);

    const ending = reduce(state, { type: "endTurn" }).state;
    const passed = reduce(ending, { type: "resolvePhase" }).state;

    expect(passed.players[player]!.pool.energy).toBe(0);
  });

  it("167: loses an unspent [A] too, not just Energy and named Power", () => {
    const state = inMainPhase();
    const player = state.activePlayer;
    const withWild = withPlayer(state, player, (seat) => ({
      ...seat,
      pool: { ...seat.pool, energy: 0, anyPower: 2 },
    }));

    const ending = reduce(withWild, { type: "endTurn" }).state;
    const passed = reduce(ending, { type: "resolvePhase" }).state;

    expect(passed.players[player]!.pool.anyPower).toBe(0);
  });
});

describe("playing permanents (rule 359.2)", () => {
  it("pays the cost and puts a Unit on the board exhausted (rule 359.2.c)", () => {
    let state = addEnergy(inMainPhase(), 1);
    const player = state.activePlayer;
    const [ready, card] = withCardInHand(state, CHEAP_UNIT);

    state = reduce(ready, { type: "playCard", card }).state;

    expect(state.players[player]!.pool.energy).toBe(0);
    expect(state.players[player]!.zones.base).toContain(card);
    expect(state.entities[card]!.exhausted).toBe(true);
    checkInvariants(state);
  });

  it("puts Gear on the board ready at the Base (rule 359.2.d)", () => {
    let state = addEnergy(inMainPhase(), 1);
    const [ready, card] = withCardInHand(state, GEAR);

    state = reduce(ready, { type: "playCard", card }).state;

    expect(state.entities[card]!.exhausted).toBe(false);
    expect(
      sameLocation(
        state.entities[card]!.location,
        playerLocation(state.activePlayer, "base"),
      ),
    ).toBe(true);
  });

  it("pays a Power cost by Recycling (rule 357.1)", () => {
    let state = inMainPhase();
    const player = state.activePlayer;
    const rune = state.players[player]!.zones.runes[0]!;
    state = reduce(state, { type: "addPower", rune }).state;

    const [ready, card] = withCardInHand(state, POWER_UNIT);
    state = reduce(ready, { type: "playCard", card }).state;

    expect(state.players[player]!.pool.power.fury).toBe(0);
    expect(state.players[player]!.zones.base).toContain(card);
  });

  it("refuses a card the pool cannot pay for", () => {
    const [state, card] = withCardInHand(inMainPhase(), CHEAP_UNIT);

    expect(state.players[state.activePlayer]!.pool.energy).toBe(0);
    expect(() => reduce(state, { type: "playCard", card })).toThrow(
      /Cannot pay/,
    );
  });

  it("does not offer an unaffordable card", () => {
    const state = inMainPhase();
    const plays = currentLegalActions(state).filter(
      (action) => action.type === "playCard",
    );
    expect(plays).toHaveLength(0);
  });

  it("leaves a Unit played this turn exhausted until the next Awaken (rule 315.1.b)", () => {
    const [ready, card] = withCardInHand(
      addEnergy(inMainPhase(), 1),
      CHEAP_UNIT,
    );
    let state = reduce(ready, { type: "playCard", card }).state;
    expect(state.entities[card]!.exhausted).toBe(true);

    // Round the table back to the same player's Awaken.
    for (let i = 0; i < 2; i += 1) {
      state = reduce(state, { type: "endTurn" }).state;
      while (state.phase !== "main" && !isOver(state)) {
        state = reduce(state, { type: "resolvePhase" }).state;
      }
    }

    expect(state.entities[card]!.exhausted).toBe(false);
  });
});

describe("the Chain (rules 327-331)", () => {
  function withSpellOnChain(): GameState {
    const [state, card] = withCardInHand(
      addEnergy(inMainPhase("chain"), 1),
      ACTION_SPELL,
    );
    return reduce(state, { type: "playCard", card }).state;
  }

  it("a Spell lingers on the Chain and Closes the state (rules 331.1, 359.3)", () => {
    const state = withSpellOnChain();

    expect(state.chain).toHaveLength(1);
    expect(isClosed(state)).toBe(true);
    expect(state.chain[0]?.pending).toBe(false);
  });

  it("offers the opponent only Reactions while the state is Closed (rule 309.1.a)", () => {
    const state = withSpellOnChain();
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    // Priority moves around the table as players pass.
    const passed = reduce(state, { type: "pass" }).state;

    expect(passed.priority).toBe(opponent);
    const plays = legalActions(passed, opponent).filter(
      (action) => action.type === "playCard",
    );
    for (const play of plays) {
      const card = passed.entities[(play as { card: EntityId }).card]!;
      expect(card.card).toBe(REACTION_SPELL.id);
    }
  });

  it("resolves the top item once everyone passes (rule 359.3.d)", () => {
    let state = withSpellOnChain();
    const player = state.activePlayer;
    const spell = state.chain[0]!.entity;

    state = reduce(state, { type: "pass" }).state;
    state = reduce(state, { type: "pass" }).state;

    expect(state.chain).toHaveLength(0);
    expect(isClosed(state)).toBe(false);
    expect(state.players[player]!.zones.trash).toContain(spell);
    // The state Opens again and the Turn Player acts (rule 312.2.a).
    expect(state.priority).toBe(state.activePlayer);
    checkInvariants(state);
  });

  it("stacks a second item and resolves it first", () => {
    const [ready, first] = withCardInHand(
      addEnergy(inMainPhase("stack"), 2),
      ACTION_SPELL,
    );
    let state = reduce(ready, { type: "playCard", card: first }).state;

    const [staged, second] = withCardInHand(state, REACTION_SPELL);
    state = reduce(staged, { type: "playCard", card: second }).state;
    expect(state.chain.map((item) => item.entity)).toEqual([first, second]);

    state = reduce(state, { type: "pass" }).state;
    state = reduce(state, { type: "pass" }).state;

    // Last on is first off.
    expect(state.chain.map((item) => item.entity)).toEqual([first]);
  });

  it("refuses a non-Reaction Spell while the state is Closed (rule 358.4)", () => {
    const [state, card] = withCardInHand(withSpellOnChain(), ACTION_SPELL);

    expect(() => reduce(state, { type: "playCard", card })).toThrow(/Closed/);
  });

  it("refuses to end the turn while the Chain still holds items", () => {
    const state = withSpellOnChain();
    expect(() => reduce(state, { type: "endTurn" })).toThrow(/Chain/);
  });

  it("refuses a pass when there is no Chain", () => {
    expect(() => reduce(inMainPhase(), { type: "pass" })).toThrow(
      /Chain is empty/,
    );
  });
});

describe("Priority (rules 312-313)", () => {
  it("belongs to the Turn Player on entering the Main Phase (rule 312.2.a)", () => {
    const state = inMainPhase();
    expect(state.priority).toBe(state.activePlayer);
  });

  it("belongs to nobody outside the Main Phase", () => {
    const state = pastMulligan(
      createGame({ decks: [deck(), deck()], registry: REGISTRY, seed: "prio" })
        .state,
    );
    expect(state.phase).toBe("awaken");
    expect(state.priority).toBeNull();
  });

  it("gives the player without Priority no actions", () => {
    const state = inMainPhase();
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    expect(legalActions(state, opponent)).toEqual([]);
  });

  it("only ever offers actions reduce will accept", () => {
    let state = inMainPhase("accepts");
    for (let step = 0; step < 40 && !isOver(state); step += 1) {
      const actions = currentLegalActions(state);
      for (const action of actions) {
        expect(() => reduce(state, action)).not.toThrow();
      }
      const next = actions[0];
      if (next === undefined) break;
      state = reduce(state, next).state;
      checkInvariants(state);
    }
  });
});

function withDefinition(state: GameState, card: CardDefinition): GameState {
  return { ...state, definitions: { ...state.definitions, [card.id]: card } };
}

/** `inMainPhase` with Energy in the Turn Player's pool. */
function ready(seed: string, energy = 5): GameState {
  const state = inMainPhase(seed);
  return {
    ...state,
    players: state.players.map((seat) =>
      seat.id === state.activePlayer
        ? { ...seat, pool: { ...seat.pool, energy } }
        : seat,
    ),
  };
}

/** Mint a card of `card` into the Turn Player's hand. */
function inHand(
  state: GameState,
  card: CardDefinition,
): [GameState, EntityId] {
  const player = state.activePlayer;
  const entity = state.nextEntityId as EntityId;
  const next: GameState = {
    ...withDefinition(state, card),
    nextEntityId: state.nextEntityId + 1,
    entities: {
      ...state.entities,
      [entity]: {
        id: entity,
        card: card.id,
        owner: player,
        controller: player,
        location: playerLocation(player, "hand"),
        exhausted: false,
        damage: 0,
        mightBonus: 0,
        grantedKeywords: [],
        buffs: 0,
        stunned: false,
      },
    },
    players: state.players.map((seat) =>
      seat.id === player
        ? {
            ...seat,
            zones: { ...seat.zones, hand: [...seat.zones.hand, entity] },
          }
        : seat,
    ),
  };
  return [next, entity];
}

describe('"I enter ready" (rule 363 replacing 359.2.c)', () => {
  /** The most repeated static clause in the card corpus. */
  const EAGER = makeUnit(2, ["fury"], {
    id: cardId("P-090"),
    name: "Eager",
    cost: cost(1),
    abilities: {
      statics: [{ affects: { who: "self" }, grant: { entersReady: true } }],
    },
  });

  /** "Other friendly units enter ready" — the same grant from the Board. */
  const MARSHAL = makeUnit(2, ["fury"], {
    id: cardId("P-091"),
    name: "Marshal",
    cost: cost(1),
    abilities: {
      statics: [
        {
          affects: { who: "friendly", excludeSelf: true },
          grant: { entersReady: true },
        },
      ],
    },
  });

  it("enters a Unit exhausted by default (359.2.c)", () => {
    const [state, card] = inHand(ready("plain-enter"), CHEAP_UNIT);
    const played = reduce(state, { type: "playCard", card }).state;
    expect(played.entities[card]!.exhausted).toBe(true);
  });

  it("enters ready when the card says so, read from hand", () => {
    // The static is on the card being played, so a sweep of the Board would
    // never find it — the card is still in hand when the question is asked.
    const [state, card] = inHand(ready("eager"), EAGER);
    const played = reduce(state, { type: "playCard", card }).state;
    expect(played.entities[card]!.exhausted).toBe(false);
  });

  it("lets a Unit already on the Board grant it to others", () => {
    let state = ready("marshal");
    const [withMarshal, marshal] = inHand(state, MARSHAL);
    state = reduce(withMarshal, { type: "playCard", card: marshal }).state;
    // The Marshal itself entered exhausted: its own scope excludes it.
    expect(state.entities[marshal]!.exhausted).toBe(true);

    const [withOther, other] = inHand(state, CHEAP_UNIT);
    const played = reduce(withOther, { type: "playCard", card: other }).state;
    expect(played.entities[other]!.exhausted).toBe(false);
  });

  it("does not grant it across the table", () => {
    let state = ready("marshal-enemy");
    const [withMarshal, marshal] = inHand(state, MARSHAL);
    state = reduce(withMarshal, { type: "playCard", card: marshal }).state;

    // Same Board, but the opponent's own play is unaffected: the grant is
    // friendly-scoped, judged from the Marshal's controller.
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    expect(entersReady(state, opponent, CHEAP_UNIT)).toBe(false);
    expect(entersReady(state, state.activePlayer, CHEAP_UNIT)).toBe(true);
  });

  it("says nothing about a card with no such static", () => {
    const state = ready("gear-enter");
    expect(entersReady(state, state.activePlayer, CHEAP_UNIT)).toBe(false);
    expect(entersReady(state, state.activePlayer, GEAR)).toBe(false);
  });
});

describe("319.6: a Game Object entering the Board runs a Cleanup", () => {
  /**
   * "Enemy units have -2 Might." — the case a Cleanup at the Chain cannot
   * reach: a Permanent leaves the Chain the moment it is Finalized (359.2),
   * so `resolveTop` never sees it and only the entry itself can notice that
   * an enemy is now under its marked damage.
   */
  const CHILL = makeUnit(2, ["fury"], {
    id: cardId("P-095"),
    name: "Chill",
    cost: cost(1),
    abilities: {
      statics: [{ affects: { who: "enemy" }, grant: { might: -2 } }],
    },
  });

  /** "When you play me, deal 2 to a unit." — 359.2.b's inline Play Effect. */
  const ARSONIST = makeUnit(2, ["fury"], {
    id: cardId("P-096"),
    name: "Arsonist",
    cost: cost(1),
    effect: {
      target: { kind: "unit", scope: "enemy" },
      effects: [{ kind: "dealDamage", amount: 2 }],
    },
  });

  /**
   * Put a Unit of `card` in the opponent's Base.
   *
   * Their Base rather than a Battlefield because 355.2.a would not let the
   * Turn Player play anything to a Battlefield an opponent occupies, and the
   * statics under test are Board-wide rather than `here`-scoped.
   */
  function inEnemyBase(
    state: GameState,
    owner: ReturnType<typeof playerId>,
    card: CardDefinition,
  ): [GameState, EntityId] {
    const [inHandState, entity] = inHand(state, card);
    const seated = withEntity(inHandState, entity, (current) => ({
      ...current,
      owner,
      controller: owner,
    }));
    const withoutHand = withPlayer(seated, state.activePlayer, (seat) => ({
      ...seat,
      zones: {
        ...seat.zones,
        hand: seat.zones.hand.filter((id) => id !== entity),
      },
    }));
    return [
      moveEntity(withoutHand, entity, playerLocation(owner, "base")),
      entity,
    ];
  }

  it("kills an enemy a static has just dropped under its marked damage", () => {
    let state = ready("chill");
    const enemy = playerId((state.activePlayer + 1) % state.players.length);
    const [withEnemy, victim] = inEnemyBase(state, enemy, CHEAP_UNIT);
    // Two damage marked on a 2-Might Unit is not yet lethal at Might 2 + 0…
    state = withEntity(withEnemy, victim, (current) => ({
      ...current,
      damage: 1,
    }));

    const [withChill, chill] = inHand(state, CHILL);
    const played = reduce(withChill, {
      type: "playCard",
      card: chill,
    }).state;

    // …but the static takes it to 0, and 142.4.b makes any damage lethal there.
    expect(played.players[enemy]!.zones.trash).toContain(victim);
    checkInvariants(played);
  });

  it("kills from a Permanent's inline Play Effect (359.2.b)", () => {
    // The damage is dealt inside `playCard` rather than from the Chain, so
    // the Cleanup at 319.5 never runs for it.
    let state = ready("arsonist");
    const enemy = playerId((state.activePlayer + 1) % state.players.length);
    const [withEnemy, victim] = inEnemyBase(state, enemy, CHEAP_UNIT);
    state = withEnemy;

    const [withArsonist, arsonist] = inHand(state, ARSONIST);
    const played = reduce(withArsonist, {
      type: "playCard",
      card: arsonist,
      targets: [victim],
    }).state;

    expect(played.players[enemy]!.zones.trash).toContain(victim);
    checkInvariants(played);
  });

  it("leaves a Unit the entry did not make lethal alone", () => {
    let state = ready("chill-survives");
    const enemy = playerId((state.activePlayer + 1) % state.players.length);
    const [withEnemy, survivor] = inEnemyBase(state, enemy, POWER_UNIT);
    state = withEntity(withEnemy, survivor, (current) => ({
      ...current,
      damage: 1,
    }));

    const [withChill, chill] = inHand(state, CHILL);
    const played = reduce(withChill, {
      type: "playCard",
      card: chill,
    }).state;

    expect(played.players[enemy]!.zones.trash).not.toContain(survivor);
    expect(played.entities[survivor]!.damage).toBe(1);
    checkInvariants(played);
  });
});
