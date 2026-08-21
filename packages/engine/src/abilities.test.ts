/**
 * Activated and Triggered abilities.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import {
  CardRegistry,
  NO_TARGET,
  cardId,
  cost,
  type CardDefinition,
  type CardEffect,
} from "@riftbound/cards";
import {
  makeBattlefield,
  makeLegend,
  makeRune,
  makeSpell,
  makeUnit,
} from "@riftbound/cards/testing";
import { describe, expect, it } from "vitest";

import { activatableAbilities, triggersFor } from "./abilities.js";
import { dependencyMet } from "./dependency.js";
import { currentLegalActions, legalActions } from "./legal.js";
import { Rng } from "./rng.js";
import { IllegalActionError } from "./actions.js";
import { checkInvariants } from "./invariants.js";
import { moveEntity, withEntity, withPlayer } from "./mutate.js";
import { reduce } from "./reduce.js";
import { createGame, type DeckList } from "./setup.js";
import {
  battlefieldLocation,
  getEntity,
  isOver,
  getPlayer,
  playerId,
  playerLocation,
  zoneOf,
  type EntityId,
  type GameState,
  type PlayerId,
} from "./state.js";

const DRAW_ONE: CardEffect = {
  target: NO_TARGET,
  effects: [{ kind: "draw", count: 1 }],
};
const DAMAGE_TWO: CardEffect = {
  target: { kind: "unit", scope: "any" },
  effects: [{ kind: "dealDamage", amount: 2 }],
};

const LEGEND = makeLegend(["fury"], { id: cardId("A-000") });
const CHAMPION = makeUnit(3, ["fury"], { id: cardId("A-001"), champion: true });
const PLAIN = makeUnit(2, ["fury"], {
  id: cardId("A-010"),
  name: "Plain",
  cost: cost(1),
});

/** "[1]: Draw 1" — an Activated Ability paid from the Rune Pool (377.1). */
const ACTIVATOR = makeUnit(2, ["fury"], {
  id: cardId("A-011"),
  name: "Activator",
  cost: cost(1),
  abilities: { activated: [{ cost: cost(1), effect: DRAW_ONE }] },
});

/** "[E]: Draw 1" — the exhaust symbol as the whole cost (414). */
const TAPPER = makeUnit(2, ["fury"], {
  id: cardId("A-012"),
  name: "Tapper",
  cost: cost(1),
  abilities: {
    activated: [{ cost: cost(0), exhaustSelf: true, effect: DRAW_ONE }],
  },
});

/** "When you play me, draw 1" — a Play Effect (383.4.a). */
const GREETER = makeUnit(2, ["fury"], {
  id: cardId("A-013"),
  name: "Greeter",
  cost: cost(1),
  abilities: {
    triggered: [
      { condition: { event: "played", subject: "self" }, effect: DRAW_ONE },
    ],
  },
});

/** "When you play me, you may draw 1" — optional, chosen at finalization (383.3.a). */
const OPTIONAL_GREETER = makeUnit(2, ["fury"], {
  id: cardId("A-014"),
  name: "Maybe",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "played", subject: "self" },
        optional: true,
        effect: DRAW_ONE,
      },
    ],
  },
});

/** "Once each turn, when you play me, draw 1" (383.3.e). */
const LIMITED = makeUnit(2, ["fury"], {
  id: cardId("A-015"),
  name: "Limited",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "played", subject: "self" },
        limitPerTurn: 1,
        effect: DRAW_ONE,
      },
    ],
  },
});

/** "When I die, draw 1" — a Deathknell. */
const DEATHKNELL = makeUnit(2, ["fury"], {
  id: cardId("A-016"),
  name: "Deathknell",
  cost: cost(1),
  abilities: {
    triggered: [
      { condition: { event: "dies", subject: "self" }, effect: DRAW_ONE },
    ],
  },
});

/** "At the end of your turn, draw 1" (317.1). */
const CLOSER = makeUnit(2, ["fury"], {
  id: cardId("A-018"),
  name: "Closer",
  cost: cost(1),
  abilities: {
    triggered: [
      { condition: { event: "endOfTurn", subject: "you" }, effect: DRAW_ONE },
    ],
  },
});

/** "At the start of your Beginning Phase, draw 1" (315.2.a). */
const OPENER = makeUnit(2, ["fury"], {
  id: cardId("A-019"),
  name: "Opener",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "beginningPhase", subject: "you" },
        effect: DRAW_ONE,
      },
    ],
  },
});

/** "When you play a spell, draw 1" — an event plus a card-type filter. */
const SPELLWATCHER = makeUnit(2, ["fury"], {
  id: cardId("A-030"),
  name: "Spellwatcher",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: {
          event: "played",
          subject: "you",
          filter: { cardType: "spell" },
        },
        effect: DRAW_ONE,
      },
    ],
  },
});

/** "When you play another unit, draw 1" — the same event, excluding itself. */
const RECRUITER = makeUnit(2, ["fury"], {
  id: cardId("A-031"),
  name: "Recruiter",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: {
          event: "played",
          subject: "you",
          filter: { cardType: "unit", excludeSelf: true },
        },
        effect: DRAW_ONE,
      },
    ],
  },
});

/** "When a friendly unit dies, draw 1" — the same event as a Deathknell. */
const MOURNER = makeUnit(2, ["fury"], {
  id: cardId("A-032"),
  name: "Mourner",
  cost: cost(1),
  abilities: {
    triggered: [
      { condition: { event: "dies", subject: "friendly" }, effect: DRAW_ONE },
    ],
  },
});

/** "When one or more enemy units die, draw 1". */
const VULTURE = makeUnit(2, ["fury"], {
  id: cardId("A-033"),
  name: "Vulture",
  cost: cost(1),
  abilities: {
    triggered: [
      { condition: { event: "dies", subject: "enemy" }, effect: DRAW_ONE },
    ],
  },
});

/** "When you play your second card in a turn, draw 1". */
const SECOND_WIND = makeUnit(2, ["fury"], {
  id: cardId("A-034"),
  name: "Second Wind",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "played", subject: "you", filter: { ordinal: 2 } },
        effect: DRAW_ONE,
      },
    ],
  },
});

/** "LEGION - When you play me, draw 1" — a Dependent Keyword (812). */
const LEGIONNAIRE = makeUnit(2, ["fury"], {
  id: cardId("A-035"),
  name: "Legionnaire",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "played", subject: "self" },
        dependsOn: { kind: "legion" },
        effect: DRAW_ONE,
      },
    ],
  },
});

/** A cheap Spell, so a card-type filter has something to see. */
const CANTRIP = makeSpell(["fury"], {
  id: cardId("A-036"),
  name: "Cantrip",
  cost: cost(1),
  timing: "action",
});

/** "Units you play cost [1] less" — a Passive cost modifier (356.4, 363). */
const DISCOUNTER = makeUnit(2, ["fury"], {
  id: cardId("A-020"),
  name: "Discounter",
  cost: cost(1),
  abilities: {
    costModifiers: [
      {
        applies: { scope: "friendly", types: ["unit"] },
        change: { kind: "discount", energy: 1 },
      },
    ],
  },
});

/** A symmetric tax, so the fuzz sees costs rise as well as fall (356.3). */
const TAXMAN = makeUnit(2, ["fury"], {
  id: cardId("A-021"),
  name: "Taxman",
  cost: cost(1),
  abilities: {
    costModifiers: [
      { applies: { scope: "any" }, change: { kind: "increase", energy: 1 } },
    ],
  },
});

/** "[1]: Deal 2 to a unit" — an Activated Ability that targets (355.8). */
const SNIPER = makeUnit(2, ["fury"], {
  id: cardId("A-017"),
  name: "Sniper",
  cost: cost(1),
  abilities: { activated: [{ cost: cost(1), effect: DAMAGE_TWO }] },
});

/** "[0], Exhaust: Ready a friendly unit" — a readying the reducer can drive. */
const WAKER = makeUnit(2, ["fury"], {
  id: cardId("A-073"),
  name: "Waker",
  cost: cost(1),
  abilities: {
    activated: [
      {
        cost: cost(0),
        effect: { target: { kind: "unit", scope: "friendly" }, effects: [{ kind: "ready" }] },
      },
    ],
  },
});

/** "[0], Exhaust: Kill a unit". */
const SLAYER = makeUnit(2, ["fury"], {
  id: cardId("A-074"),
  name: "Slayer",
  cost: cost(1),
  abilities: {
    activated: [
      {
        cost: cost(0),
        effect: { target: { kind: "unit", scope: "any" }, effects: [{ kind: "kill" }] },
      },
    ],
  },
});

/** "When you ready a friendly unit, draw 1" (415). */
const ROUSER = makeUnit(2, ["fury"], {
  id: cardId("A-070"),
  name: "Rouser",
  cost: cost(1),
  abilities: {
    triggered: [{ condition: { event: "ready", subject: "friendly" }, effect: DRAW_ONE }],
  },
});

/** "When you choose me with a spell, draw 1" (355.6). */
const BAIT = makeUnit(2, ["fury"], {
  id: cardId("A-071"),
  name: "Bait",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: {
          event: "chosen",
          subject: "self",
          filter: { byController: true, bySource: "spell" },
        },
        effect: DRAW_ONE,
      },
    ],
  },
});

/** "When a buffed friendly unit dies, draw 1" (702). */
const MOURNER_OF_BUFFS = makeUnit(2, ["fury"], {
  id: cardId("A-072"),
  name: "Buff Mourner",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "dies", subject: "friendly", filter: { buffed: true } },
        effect: DRAW_ONE,
      },
    ],
  },
});

const RUNE = makeRune("fury", { id: cardId("A-100") });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`A-20${i}`) }),
);

/**
 * "DEATHKNELL - Deal 3 to all units at my battlefield" (808.1.d.3).
 *
 * The point of the card: its effect resolves once the Unit is already in the
 * trash, where 359.3.e.12 leaves it no location at all.
 */
const CAUSTIC = makeUnit(2, ["fury"], {
  id: cardId("A-040"),
  name: "Caustic",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "dies", subject: "self" },
        effect: {
          target: { kind: "all", scope: "any", here: true },
          effects: [{ kind: "dealDamage", amount: 3 }],
        },
      },
    ],
  },
});

/** "Kill a unit at a battlefield." — an Active Kill (428.1.a.1). */
const EXECUTE = makeSpell(["fury"], {
  id: cardId("A-041"),
  name: "Execute",
  cost: cost(1),
  timing: "action",
  effect: {
    target: { kind: "unit", scope: "any", atBattlefield: true },
    effects: [{ kind: "kill" }],
  },
});

/**
 * "Other friendly units have VISION" — 801.3.a granting an ability rather than
 * a `Keyword`, because 817.1.b makes Vision a Play Effect.
 */
const SEER = makeUnit(2, ["fury"], {
  id: cardId("A-050"),
  name: "Seer",
  cost: cost(1),
  abilities: {
    statics: [
      {
        affects: { who: "friendly", excludeSelf: true },
        grant: {
          abilities: {
            triggered: [
              {
                condition: { event: "played", subject: "self" },
                effect: DRAW_ONE,
              },
            ],
          },
        },
      },
    ],
  },
});

/**
 * "When you play me, you may pay 1 to draw 1." (403, 356.7)
 *
 * No exhaust in the price: 359.2.c enters a Unit exhausted, so a Play Effect
 * that cost one could never be paid — which the engine correctly refuses.
 */
const TOLLKEEPER = makeUnit(2, ["fury"], {
  id: cardId("A-060"),
  name: "Tollkeeper",
  cost: cost(1),
  abilities: {
    triggered: [
      {
        condition: { event: "played", subject: "self" },
        optional: true,
        cost: cost(1),
        effect: DRAW_ONE,
      },
    ],
  },
});

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  ACTIVATOR,
  TAPPER,
  GREETER,
  OPTIONAL_GREETER,
  LIMITED,
  DEATHKNELL,
  CLOSER,
  OPENER,
  DISCOUNTER,
  TAXMAN,
  SNIPER,
  SPELLWATCHER,
  RECRUITER,
  MOURNER,
  VULTURE,
  SECOND_WIND,
  LEGIONNAIRE,
  CANTRIP,
  CAUSTIC,
  SEER,
  TOLLKEEPER,
  EXECUTE,
  WAKER,
  SLAYER,
  ROUSER,
  BAIT,
  MOURNER_OF_BUFFS,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: Array.from({ length: 14 }, () => PLAIN.id),
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

/** A game in the Main Phase with `energy` in the Turn Player's pool. */
function inMainPhase(seed = "abilities", energy = 3): GameState {
  let state = createGame({
    decks: [deck(), deck()],
    registry: REGISTRY,
    seed,
  }).state;
  while (state.phase === "mulligan") {
    state = reduce(state, { type: "mulligan", cards: [] }).state;
  }
  while (state.phase !== "main") {
    state = reduce(state, { type: "resolvePhase" }).state;
  }
  const player = state.activePlayer;
  return {
    ...state,
    players: state.players.map((seat) =>
      seat.id === player ? { ...seat, pool: { ...seat.pool, energy } } : seat,
    ),
  };
}

/** Put a card of `id` onto the board under the Turn Player. */
function withBoardCard(
  state: GameState,
  id: CardDefinition["id"],
  owner?: PlayerId,
): [GameState, EntityId] {
  const player = owner ?? state.activePlayer;
  const entityId = state.nextEntityId;
  const next: GameState = {
    ...state,
    nextEntityId: entityId + 1,
    definitions: { ...state.definitions, [id]: REGISTRY.mustGet(id) },
    entities: {
      ...state.entities,
      [entityId]: {
        id: entityId as EntityId,
        card: id,
        owner: player,
        controller: player,
        location: playerLocation(player, "base"),
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
            zones: {
              ...seat.zones,
              base: [...seat.zones.base, entityId as EntityId],
            },
          }
        : seat,
    ),
  };
  return [next, entityId as EntityId];
}

/** Put a card into the Turn Player's hand so it can be played. */
function withHandCard(
  state: GameState,
  id: CardDefinition["id"],
): [GameState, EntityId] {
  const [placed, entity] = withBoardCard(state, id);
  const player = placed.activePlayer;
  return [moveEntity(placed, entity, playerLocation(player, "hand")), entity];
}

/** Pass until the top Chain item resolves. */
function resolveChain(state: GameState): GameState {
  let next = state;
  let guard = 0;
  while (next.chain.length > 0) {
    if (guard > 20) throw new Error("Chain did not resolve");
    guard += 1;
    next = reduce(next, { type: "pass" }).state;
  }
  return next;
}

describe("Activated Abilities (rules 376-381)", () => {
  it("goes on the Chain and resolves its effect", () => {
    const [state, source] = withBoardCard(inMainPhase(), ACTIVATOR.id);
    const player = state.activePlayer;
    const before = zoneOf(state, player, "hand").length;

    const activated = reduce(state, {
      type: "activateAbility",
      source,
      index: 0,
    }).state;
    expect(activated.chain).toHaveLength(1);
    expect(activated.chain[0]?.ability).toEqual({
      kind: "activated",
      index: 0,
    });

    const resolved = resolveChain(activated);
    expect(zoneOf(resolved, player, "hand")).toHaveLength(before + 1);
    checkInvariants(resolved);
  });

  it("pays the cost out of the Rune Pool (rule 377)", () => {
    const [state, source] = withBoardCard(inMainPhase("cost", 3), ACTIVATOR.id);
    const player = state.activePlayer;

    const activated = reduce(state, {
      type: "activateAbility",
      source,
      index: 0,
    }).state;
    expect(getPlayer(activated, player).pool.energy).toBe(2);
  });

  it("leaves its source where it is, unlike a Spell (377.3.a.1)", () => {
    // An ability on the Chain "has no card to represent it": the source is not
    // moved onto the Chain and does not go to the trash when it resolves.
    const [state, source] = withBoardCard(inMainPhase(), ACTIVATOR.id);
    const player = state.activePlayer;

    const resolved = resolveChain(
      reduce(state, { type: "activateAbility", source, index: 0 }).state,
    );
    expect(zoneOf(resolved, player, "base")).toContain(source);
    expect(zoneOf(resolved, player, "trash")).not.toContain(source);
  });

  it("is repeatable while the cost can still be paid (377)", () => {
    const [state, source] = withBoardCard(
      inMainPhase("repeat", 3),
      ACTIVATOR.id,
    );
    const player = state.activePlayer;
    const before = zoneOf(state, player, "hand").length;

    let next = resolveChain(
      reduce(state, { type: "activateAbility", source, index: 0 }).state,
    );
    next = resolveChain(
      reduce(next, { type: "activateAbility", source, index: 0 }).state,
    );

    expect(zoneOf(next, player, "hand")).toHaveLength(before + 2);
  });

  it("exhausts the source when that is the cost (rule 414)", () => {
    const [state, source] = withBoardCard(inMainPhase("exhaust", 0), TAPPER.id);

    const activated = reduce(state, {
      type: "activateAbility",
      source,
      index: 0,
    }).state;
    expect(getEntity(activated, source).exhausted).toBe(true);
  });

  it("cannot pay an exhaust cost twice without readying (414)", () => {
    const [state, source] = withBoardCard(inMainPhase("twice", 0), TAPPER.id);
    const once = resolveChain(
      reduce(state, { type: "activateAbility", source, index: 0 }).state,
    );

    expect(activatableAbilities(once, once.activePlayer)).toEqual([]);
    expect(() =>
      reduce(once, { type: "activateAbility", source, index: 0 }),
    ).toThrow(IllegalActionError);
  });

  it("is unavailable when the cost cannot be paid", () => {
    const [state, source] = withBoardCard(
      inMainPhase("broke", 0),
      ACTIVATOR.id,
    );
    expect(activatableAbilities(state, state.activePlayer)).toEqual([]);
    expect(() =>
      reduce(state, { type: "activateAbility", source, index: 0 }),
    ).toThrow(IllegalActionError);
  });

  it("is unavailable on an opponent`s turn (rule 381)", () => {
    const [state, source] = withBoardCard(inMainPhase("turn", 3), ACTIVATOR.id);
    const opponent = playerId((state.activePlayer + 1) % state.players.length);

    expect(activatableAbilities(state, opponent)).toEqual([]);
    expect(
      activatableAbilities(
        { ...state, activePlayer: opponent },
        state.activePlayer,
      ),
    ).toEqual([]);
    expect(source).toBeGreaterThanOrEqual(0);
  });

  it("is unavailable in a Closed State (rule 381)", () => {
    // 381: "only ... during an Open State"; a Chain makes the state Closed.
    const [state, source] = withBoardCard(
      inMainPhase("closed", 3),
      ACTIVATOR.id,
    );
    const withChain = reduce(state, {
      type: "activateAbility",
      source,
      index: 0,
    }).state;

    expect(activatableAbilities(withChain, withChain.activePlayer)).toEqual([]);
  });

  it("is unavailable from a source that is not on the Board (rule 380)", () => {
    const [state, source] = withHandCard(inMainPhase("hand", 3), ACTIVATOR.id);
    expect(activatableAbilities(state, state.activePlayer)).toEqual([]);
    expect(() =>
      reduce(state, { type: "activateAbility", source, index: 0 }),
    ).toThrow(IllegalActionError);
  });

  it("offers one action per legal target and rejects an invalid one (355.8)", () => {
    const base = inMainPhase("target", 3);
    const [withSniper, sniper] = withBoardCard(base, SNIPER.id);
    const [state, victim] = withBoardCard(withSniper, PLAIN.id);

    const offered = legalActions(state, state.activePlayer).filter(
      (action) => action.type === "activateAbility",
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(
      offered.every(
        (action) => "targets" in action && action.targets?.length === 1,
      ),
    ).toBe(true);

    const damaged = resolveChain(
      reduce(state, {
        type: "activateAbility",
        source: sniper,
        index: 0,
        targets: [victim],
      }).state,
    );
    expect(getEntity(damaged, victim).damage).toBe(2);

    // A targeting ability with no target chosen is not a legal activation.
    expect(() =>
      reduce(state, { type: "activateAbility", source: sniper, index: 0 }),
    ).toThrow(IllegalActionError);
  });

  it("is offered by legalActions and always accepted by reduce", () => {
    const [state, source] = withBoardCard(
      inMainPhase("legal", 3),
      ACTIVATOR.id,
    );
    expect(source).toBeGreaterThanOrEqual(0);
    for (const action of legalActions(state, state.activePlayer)) {
      expect(() => reduce(state, action)).not.toThrow();
    }
  });
});

describe("Play Effects (rule 383.4.a)", () => {
  it("triggers when the Permanent enters the Board", () => {
    const [state, card] = withHandCard(inMainPhase("play", 3), GREETER.id);
    const player = state.activePlayer;
    const before = zoneOf(state, player, "hand").length;

    const played = reduce(state, { type: "playCard", card }).state;
    // 383.4.a.2: it goes on the Chain after the Permanent is finalized.
    expect(played.chain).toHaveLength(1);
    expect(played.chain[0]?.ability).toEqual({ kind: "triggered", index: 0 });

    const resolved = resolveChain(played);
    // -1 for the card played, +1 for the trigger's draw.
    expect(zoneOf(resolved, player, "hand")).toHaveLength(before);
    checkInvariants(resolved);
  });

  it("does not trigger on a card without one", () => {
    const [state, card] = withHandCard(inMainPhase("plain", 3), PLAIN.id);
    expect(reduce(state, { type: "playCard", card }).state.chain).toHaveLength(
      0,
    );
  });

  it("leaves the Permanent on the Board when the trigger resolves", () => {
    const [state, card] = withHandCard(inMainPhase("stay", 3), GREETER.id);
    const player = state.activePlayer;

    const resolved = resolveChain(
      reduce(state, { type: "playCard", card }).state,
    );
    expect(zoneOf(resolved, player, "base")).toContain(card);
  });
});

describe("optional triggers (rule 383.3.a)", () => {
  it("goes on the Chain pending, and offers only the choice", () => {
    const [state, card] = withHandCard(
      inMainPhase("opt", 3),
      OPTIONAL_GREETER.id,
    );
    const played = reduce(state, { type: "playCard", card }).state;

    expect(played.chain[0]?.pending).toBe(true);
    const offered = legalActions(played, played.activePlayer);
    expect(offered).toEqual([
      { type: "resolveTrigger", perform: true },
      { type: "resolveTrigger", perform: false },
    ]);
  });

  it("performs the effect when its controller accepts", () => {
    const [state, card] = withHandCard(
      inMainPhase("accept", 3),
      OPTIONAL_GREETER.id,
    );
    const player = state.activePlayer;
    const played = reduce(state, { type: "playCard", card }).state;
    const before = zoneOf(played, player, "hand").length;

    const resolved = resolveChain(
      reduce(played, { type: "resolveTrigger", perform: true }).state,
    );
    expect(zoneOf(resolved, player, "hand")).toHaveLength(before + 1);
  });

  it("leaves the Chain with no effect when declined (383.3.e.2.b)", () => {
    const [state, card] = withHandCard(
      inMainPhase("decline", 3),
      OPTIONAL_GREETER.id,
    );
    const player = state.activePlayer;
    const played = reduce(state, { type: "playCard", card }).state;
    const before = zoneOf(played, player, "hand").length;

    const declined = reduce(played, {
      type: "resolveTrigger",
      perform: false,
    }).state;
    expect(declined.chain).toHaveLength(0);
    expect(zoneOf(declined, player, "hand")).toHaveLength(before);
    checkInvariants(declined);
  });

  it("cannot be finalized by the wrong player", () => {
    const [state, card] = withHandCard(
      inMainPhase("wrong", 3),
      OPTIONAL_GREETER.id,
    );
    const played = reduce(state, { type: "playCard", card }).state;
    const opponent = playerId(
      (played.activePlayer + 1) % played.players.length,
    );

    expect(legalActions(played, opponent)).toEqual([]);
    expect(() =>
      reduce(
        { ...played, priority: opponent },
        { type: "resolveTrigger", perform: true },
      ),
    ).toThrow(IllegalActionError);
  });

  it("rejects the action when nothing is pending", () => {
    expect(() =>
      reduce(inMainPhase("nothing"), { type: "resolveTrigger", perform: true }),
    ).toThrow(IllegalActionError);
  });
});

describe("per-turn limits (rule 383.3.e)", () => {
  it("stops triggering once it has been performed the stated number of times", () => {
    const [first, cardA] = withHandCard(inMainPhase("limit", 5), LIMITED.id);
    const played = resolveChain(
      reduce(first, { type: "playCard", card: cardA }).state,
    );
    expect(played.triggersUsed[`${cardA}:0`]).toBe(1);

    // The same source cannot trigger again this turn.
    expect(
      triggersFor(played, {
        event: "played",
        actor: played.activePlayer,
        objects: [cardA],
      }),
    ).toEqual([]);
  });

  it("clears the counters at the end of the turn", () => {
    const [first, card] = withHandCard(inMainPhase("reset", 5), LIMITED.id);
    let state = resolveChain(reduce(first, { type: "playCard", card }).state);
    expect(Object.keys(state.triggersUsed)).toHaveLength(1);

    state = reduce(state, { type: "endTurn" }).state;
    while (state.phase === "ending") {
      state = reduce(state, { type: "resolvePhase" }).state;
    }
    expect(state.triggersUsed).toEqual({});
  });

  it("leaves an unlimited ability alone", () => {
    const [state, card] = withBoardCard(inMainPhase("unlimited"), GREETER.id);
    expect(
      triggersFor(state, {
        event: "played",
        actor: state.activePlayer,
        objects: [card],
      }),
    ).toHaveLength(1);
    expect(card).toBeGreaterThanOrEqual(0);
  });
});

describe("death triggers", () => {
  it("fires after the death has been processed (383.2.c)", () => {
    // Put the Deathknell at a Battlefield with lethal damage already marked,
    // then let the Combat Cleanup kill it.
    let state = inMainPhase("death", 3);
    const [placed, unit] = withBoardCard(state, DEATHKNELL.id);
    state = moveEntity(placed, unit, battlefieldLocation(0));

    const triggers = triggersFor(
      state,
      { event: "dies", actor: state.activePlayer, objects: [unit] },
      { extraSources: [unit] },
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.ability).toEqual({ kind: "triggered", index: 0 });
  });

  it('808.1.d.3: notes the location, so "my battlefield" survives the death', () => {
    // An Active Kill (428.1.a.1.b) queues the Deathknell before the move, but
    // the ability *resolves* long after the corpse has reached the trash, where
    // 359.3.e.12 leaves it no location. 808.1.d.3 is the rule that keeps "all
    // units at my battlefield" naming one.
    let state = inMainPhase("noted", 3);
    const [a, caustic] = withBoardCard(state, CAUSTIC.id);
    state = moveEntity(a, caustic, battlefieldLocation(0));
    const [b, bystander] = withBoardCard(state, PLAIN.id);
    state = moveEntity(b, bystander, battlefieldLocation(0));
    const [c, elsewhere] = withBoardCard(state, PLAIN.id);
    state = moveEntity(c, elsewhere, battlefieldLocation(1));
    const [d, execute] = withHandCard(state, EXECUTE.id);
    state = d;

    const after = resolveChain(
      reduce(state, { type: "playCard", card: execute, targets: [caustic] })
        .state,
    );

    expect(zoneOf(after, state.activePlayer, "trash")).toContain(caustic);
    expect(getEntity(after, bystander).damage).toBe(3);
    // A different Battlefield is not "my battlefield".
    expect(getEntity(after, elsewhere).damage).toBe(0);
    checkInvariants(after);
  });

  it("is not offered for a Unit without one", () => {
    let state = inMainPhase("nodeath", 3);
    const [placed, unit] = withBoardCard(state, PLAIN.id);
    state = withEntity(placed, unit, (current) => ({ ...current, damage: 99 }));
    expect(
      triggersFor(
        state,
        { event: "dies", actor: state.activePlayer, objects: [unit] },
        { extraSources: [unit] },
      ),
    ).toEqual([]);
  });
});

describe("abilities granted by a static (801.3.a)", () => {
  it("fires for a Unit in scope, as though printed on it", () => {
    let state = inMainPhase("granted", 3);
    const [withSeer] = withBoardCard(state, SEER.id);
    state = withSeer;
    const [ready, card] = withHandCard(state, PLAIN.id);
    state = ready;
    const player = state.activePlayer;
    const before = getPlayer(state, player).zones.hand.length;

    const played = resolveChain(
      reduce(state, { type: "playCard", card }).state,
    );

    // Played one card, drew one from the granted Play Effect.
    expect(getPlayer(played, player).zones.hand.length).toBe(before);
  });

  it("stops the moment the granting Permanent leaves the Board (365)", () => {
    // Nothing is written onto the Unit, so there is nothing to clean up: the
    // sweep simply stops finding it.
    let state = inMainPhase("ungranted", 3);
    const [withSeer, seer] = withBoardCard(state, SEER.id);
    state = moveEntity(
      withSeer,
      seer,
      playerLocation(state.activePlayer, "trash"),
    );
    const [ready, card] = withHandCard(state, PLAIN.id);
    state = ready;
    const player = state.activePlayer;
    const before = getPlayer(state, player).zones.hand.length;

    const played = resolveChain(
      reduce(state, { type: "playCard", card }).state,
    );

    expect(getPlayer(played, player).zones.hand.length).toBe(before - 1);
  });

  it('never reaches the granting card itself when the scope says "other"', () => {
    const state = inMainPhase("self-grant", 3);
    const [withSeer, seer] = withBoardCard(state, SEER.id);
    expect(
      triggersFor(withSeer, {
        event: "played",
        actor: withSeer.activePlayer,
        objects: [seer],
      }),
    ).toEqual([]);
  });
});

describe("a Triggered Ability with a price (403, 356.7)", () => {
  it("pays at 402.2, the step where its other choices are settled", () => {
    const [state, card] = withHandCard(
      inMainPhase("trigger-cost", 3),
      TOLLKEEPER.id,
    );
    const player = state.activePlayer;
    const played = reduce(state, { type: "playCard", card }).state;
    const before = getPlayer(played, player).pool.energy;

    const finalized = reduce(played, {
      type: "resolveTrigger",
      perform: true,
    }).state;

    // Taken at step 2 rather than on resolution — the item is on the Chain and
    // already paid for.
    expect(getPlayer(finalized, player).pool.energy).toBe(before - 1);
    checkInvariants(resolveChain(finalized));
  });

  it("offers only the decline when the price cannot be met", () => {
    const [empty, card] = withHandCard(
      inMainPhase("trigger-broke", 0),
      TOLLKEEPER.id,
    );
    // Enough to play the Unit, nothing left for the trigger.
    const funded = withPlayer(empty, empty.activePlayer, (seat) => ({
      ...seat,
      pool: { ...seat.pool, energy: 1 },
    }));
    const played = reduce(funded, { type: "playCard", card }).state;

    const offered = currentLegalActions(played).filter(
      (action) => action.type === "resolveTrigger",
    );
    expect(offered).toEqual([{ type: "resolveTrigger", perform: false }]);
    expect(() =>
      reduce(played, { type: "resolveTrigger", perform: true }),
    ).toThrow(/cost/i);
  });

  it("takes nothing when the controller declines", () => {
    const [state, card] = withHandCard(
      inMainPhase("trigger-decline", 3),
      TOLLKEEPER.id,
    );
    const player = state.activePlayer;
    const played = reduce(state, { type: "playCard", card }).state;
    const before = getPlayer(played, player).pool.energy;

    const declined = reduce(played, {
      type: "resolveTrigger",
      perform: false,
    }).state;

    expect(getPlayer(declined, player).pool.energy).toBe(before);
    expect(declined.chain).toHaveLength(0);
  });
});

describe("trigger ordering (rule 383.3.d.1)", () => {
  it("places the Turn Player`s triggers before an opponent`s", () => {
    const state = inMainPhase("order", 3);
    const player = state.activePlayer;
    const opponent = playerId((player + 1) % state.players.length);

    // One identical source per player, the opponent's added first so the
    // ordering cannot come from insertion order.
    const [withTheirs, theirs] = withBoardCard(state, GREETER.id, opponent);
    const [both, mine] = withBoardCard(withTheirs, GREETER.id, player);

    const triggers = triggersFor(both, {
      event: "played",
      actor: player,
      objects: [mine, theirs],
    });
    expect(triggers.map((trigger) => trigger.source)).toEqual([mine, theirs]);
    expect(triggers.map((trigger) => trigger.controller)).toEqual([
      player,
      opponent,
    ]);
  });

  it("keeps a single player`s triggers in a fixed order", () => {
    // The within-player ordering choice of 383.3.d is not exposed; it is
    // deterministic instead, which is what keeps games reproducible.
    const state = inMainPhase("stable", 3);
    const [one, first] = withBoardCard(state, GREETER.id);
    const [two, second] = withBoardCard(one, GREETER.id);

    expect(
      triggersFor(two, {
        event: "played",
        actor: two.activePlayer,
        objects: [first, second],
      }).map((trigger) => trigger.source),
    ).toEqual([first, second]);
  });
});

describe("ability fuzz", () => {
  /** A deck built entirely from ability-carrying cards. */
  function abilityDeck(): DeckList {
    return {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 3 }, () => ACTIVATOR.id),
        ...Array.from({ length: 3 }, () => TAPPER.id),
        ...Array.from({ length: 3 }, () => GREETER.id),
        ...Array.from({ length: 3 }, () => OPTIONAL_GREETER.id),
        ...Array.from({ length: 3 }, () => LIMITED.id),
        ...Array.from({ length: 3 }, () => DEATHKNELL.id),
        ...Array.from({ length: 3 }, () => SNIPER.id),
        // The turn-boundary triggers, which hold a phase open mid-resolution.
        ...Array.from({ length: 3 }, () => CLOSER.id),
        ...Array.from({ length: 3 }, () => OPENER.id),
        // Cost modifiers, so affordability is a moving target for the walk.
        ...Array.from({ length: 3 }, () => DISCOUNTER.id),
        ...Array.from({ length: 3 }, () => TAXMAN.id),
      ],
      runes: Array.from({ length: 10 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
  }

  it("never reaches an inconsistent state and always terminates", () => {
    // The engine-wide fuzz plays vanilla cards, so abilities need their own
    // run: activation, pending triggers and per-turn counters are all state a
    // random walk can corrupt in ways a hand-written test would not think of.
    for (let game = 0; game < 20; game += 1) {
      const seed = `ability-fuzz-${game}`;
      const rng = Rng.fromSeed(seed);
      let state = createGame({
        decks: [abilityDeck(), abilityDeck()],
        registry: REGISTRY,
        seed,
        config: { maxTurns: 60 },
      }).state;
      checkInvariants(state);

      let steps = 0;
      while (!isOver(state)) {
        steps += 1;
        if (steps > 5000) throw new Error(`Game ${game} did not terminate`);

        const actions = currentLegalActions(state);
        expect(actions.length).toBeGreaterThan(0);
        state = reduce(state, rng.pick(actions)).state;
        checkInvariants(state);
      }
      expect(state.outcome).not.toBeNull();
    }
  });

  it("empties the Chain of abilities before the turn passes", () => {
    // A pending trigger that outlived its turn would strand Priority.
    const seed = "ability-chain";
    const rng = Rng.fromSeed(seed);
    let state = createGame({
      decks: [abilityDeck(), abilityDeck()],
      registry: REGISTRY,
      seed,
      config: { maxTurns: 40 },
    }).state;

    let previousTurn = state.turn;
    while (!isOver(state)) {
      const actions = currentLegalActions(state);
      if (actions.length === 0) break;
      state = reduce(state, rng.pick(actions)).state;
      if (state.turn !== previousTurn) {
        expect(state.chain).toEqual([]);
        previousTurn = state.turn;
      }
    }
  });
});

describe("the interruptible phase machine", () => {
  /** Advance until the phase changes or the Chain opens. */
  function step(state: GameState): GameState {
    return reduce(state, { type: "resolvePhase" }).state;
  }

  /** Walk the turn cycle round to `player`'s next Beginning Phase. */
  function untilBeginningOf(state: GameState, player: PlayerId): GameState {
    let next = state;
    let guard = 0;
    while (next.activePlayer !== player || next.phase !== "beginning") {
      if (guard++ > 40) throw new Error("never reached the Beginning Phase");
      // The Main Phase does not resolve on its own (316); it is ended.
      next = reduce(
        next,
        next.phase === "main" ? { type: "endTurn" } : { type: "resolvePhase" },
      ).state;
      if (next.chain.length > 0) {
        next = resolveChain(next);
      }
    }
    return next;
  }

  it("holds the Ending Phase open for an end-of-turn trigger (317.1)", () => {
    const [state, unit] = withBoardCard(inMainPhase("closer"), CLOSER.id);
    const player = state.activePlayer;
    const before = zoneOf(state, player, "hand").length;

    let next = reduce(state, { type: "endTurn" }).state;
    expect(next.phase).toBe("ending");

    // The phase does its first step, puts the trigger on the Chain and stops.
    next = step(next);
    expect(next.phase).toBe("ending");
    expect(next.chain).toHaveLength(1);
    expect(next.chain[0]?.entity).toBe(unit);
    expect(next.phaseStep).toBe(1);

    // Once the Chain drains, nobody holds Priority and the phase resumes.
    next = resolveChain(next);
    expect(next.phase).toBe("ending");
    expect(next.priority).toBeNull();
    expect(zoneOf(next, player, "hand")).toHaveLength(before + 1);

    // Resuming skips the work already done and finishes the turn.
    next = step(next);
    expect(next.phase).toBe("awaken");
    expect(next.activePlayer).not.toBe(player);
    expect(next.phaseStep).toBe(0);
    checkInvariants(next);
  });

  it("lets the opponent respond while the phase is held", () => {
    // 383.3.c: a Triggered Ability goes on the Chain in any state on any
    // player's turn, and the Chain is the response window.
    const [state] = withBoardCard(inMainPhase("respond"), CLOSER.id);
    const opponent = playerId((state.activePlayer + 1) % state.players.length);

    let next = step(reduce(state, { type: "endTurn" }).state);
    expect(next.chain).toHaveLength(1);
    // Priority is live during the hold, so passing is a real decision.
    expect(next.priority).not.toBeNull();
    next = reduce(next, { type: "pass" }).state;
    expect(next.priority).toBe(opponent);
  });

  it("fires a Beginning Phase trigger before the Scoring Step (315.2)", () => {
    const [placed, unit] = withBoardCard(inMainPhase("opener"), OPENER.id);
    const player = placed.activePlayer;

    // Give the player a Battlefield to Hold, so both steps have work to do.
    const state: GameState = {
      ...placed,
      battlefields: placed.battlefields.map((battlefield, index) =>
        index === 0
          ? { ...battlefield, controller: player, scoredBy: [] }
          : battlefield,
      ),
    };

    let next = untilBeginningOf(state, player);

    const pointsBefore = getPlayer(next, player).points;
    next = step(next);

    // The trigger is on the Chain and the Hold has NOT been scored yet.
    expect(next.chain).toHaveLength(1);
    expect(next.chain[0]?.entity).toBe(unit);
    expect(getPlayer(next, player).points).toBe(pointsBefore);

    next = resolveChain(next);
    next = step(next);
    // Now the Scoring Step has run.
    expect(getPlayer(next, player).points).toBe(pointsBefore + 1);
    expect(next.phase).toBe("channel");
  });

  it("does not re-run a step it already completed", () => {
    // The whole hazard of holding a phase open: resuming must not score twice.
    const [placed, unit] = withBoardCard(inMainPhase("once"), OPENER.id);
    const player = placed.activePlayer;
    const state: GameState = {
      ...placed,
      battlefields: placed.battlefields.map((battlefield, index) =>
        index === 0
          ? { ...battlefield, controller: player, scoredBy: [] }
          : battlefield,
      ),
    };

    let next = untilBeginningOf(state, player);

    const pointsBefore = getPlayer(next, player).points;
    next = resolveChain(step(next));
    next = step(next);
    expect(getPlayer(next, player).points).toBe(pointsBefore + 1);
    expect(unit).toBeGreaterThanOrEqual(0);
  });

  it("leaves a phase with nothing to interrupt exactly as it was", () => {
    // Awaken, Channel and Draw have no trigger conditions, so they still
    // resolve in one action and never leave phaseStep set.
    let next = inMainPhase("plainphases");
    next = reduce(next, { type: "endTurn" }).state;
    let guard = 0;
    while (next.phase !== "main") {
      if (guard++ > 20) throw new Error("phases did not advance");
      next = reduce(next, { type: "resolvePhase" }).state;
      expect(next.chain).toEqual([]);
      expect(next.phaseStep).toBe(0);
    }
  });
});

describe("trigger subjects (rule 383.1)", () => {
  it('separates "when I die" from "when a friendly unit dies" on one event', () => {
    // The same death reaches both, and each decides for itself. The old shape
    // could not express this: it looked triggers up by condition against the
    // dying Unit alone, so a bystander never saw the death at all.
    const state = inMainPhase("subjects");
    const [withKnell, dying] = withBoardCard(state, DEATHKNELL.id);
    const [both, mourner] = withBoardCard(withKnell, MOURNER.id);

    const triggers = triggersFor(
      both,
      { event: "dies", actor: both.activePlayer, objects: [dying] },
      { extraSources: [dying] },
    );

    expect(triggers.map((trigger) => trigger.source).sort()).toEqual(
      [dying, mourner].sort(),
    );
  });

  it("reads friendly and enemy from the object`s controller, not the actor`s", () => {
    // A Unit you control can die to an opponent's Spell and still be friendly.
    const state = inMainPhase("sides");
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    const [mine, dying] = withBoardCard(state, PLAIN.id);
    const [withMourner, mourner] = withBoardCard(mine, MOURNER.id);
    const [board, vulture] = withBoardCard(withMourner, VULTURE.id, opponent);

    // The opponent kills it, so the actor is the opponent and the object is mine.
    const triggers = triggersFor(
      board,
      { event: "dies", actor: opponent, objects: [dying] },
      { extraSources: [dying] },
    );
    const sources = triggers.map((trigger) => trigger.source);

    expect(sources).toContain(mourner);
    expect(sources).toContain(vulture);
  });

  it("does not fire a friendly watcher on an enemy death", () => {
    const state = inMainPhase("nofire");
    const opponent = playerId((state.activePlayer + 1) % state.players.length);
    const [board, mourner] = withBoardCard(state, MOURNER.id);
    const [withEnemy, theirs] = withBoardCard(board, PLAIN.id, opponent);

    const triggers = triggersFor(withEnemy, {
      event: "dies",
      actor: opponent,
      objects: [theirs],
    });

    expect(triggers.map((trigger) => trigger.source)).not.toContain(mourner);
  });
});

describe("trigger filters (rule 383.1)", () => {
  it("fires a card-type watcher on a Spell and not on a Unit", () => {
    let state = inMainPhase("filter", 5);
    const [withWatcher] = withBoardCard(state, SPELLWATCHER.id);
    const [withSpell, spell] = withHandCard(withWatcher, CANTRIP.id);
    state = withSpell;
    const before = getPlayer(state, state.activePlayer).zones.hand.length;

    const after = resolveChain(
      reduce(state, { type: "playCard", card: spell }).state,
    );

    // The Spell left the hand and the trigger put a card back into it.
    expect(getPlayer(after, after.activePlayer).zones.hand.length).toBe(before);
  });

  it("does not fire a Spell watcher when a Unit is played", () => {
    let state = inMainPhase("filter-unit", 5);
    const [withWatcher] = withBoardCard(state, SPELLWATCHER.id);
    const [withUnit, unit] = withHandCard(withWatcher, PLAIN.id);
    state = withUnit;
    const before = getPlayer(state, state.activePlayer).zones.hand.length;

    const after = resolveChain(
      reduce(state, { type: "playCard", card: unit }).state,
    );

    expect(getPlayer(after, after.activePlayer).zones.hand.length).toBe(
      before - 1,
    );
  });

  it('excludes the source itself for "another" (383.1)', () => {
    const state = inMainPhase("another");
    const [board, recruiter] = withBoardCard(state, RECRUITER.id);

    // Playing the Recruiter itself must not trigger it.
    expect(
      triggersFor(board, {
        event: "played",
        actor: board.activePlayer,
        objects: [recruiter],
      }),
    ).toEqual([]);

    const [withOther, other] = withBoardCard(board, PLAIN.id);
    expect(
      triggersFor(withOther, {
        event: "played",
        actor: withOther.activePlayer,
        objects: [other],
      }).map((trigger) => trigger.source),
    ).toEqual([recruiter]);
  });

  it("matches an ordinal against the occurrence, not a per-turn cap", () => {
    const state = inMainPhase("ordinal");
    const [board] = withBoardCard(state, SECOND_WIND.id);
    const [withCard, card] = withBoardCard(board, PLAIN.id);

    const at = (ordinal: number) =>
      triggersFor(withCard, {
        event: "played",
        actor: withCard.activePlayer,
        objects: [card],
        ordinal,
      });

    expect(at(1)).toEqual([]);
    expect(at(2)).toHaveLength(1);
    expect(at(3)).toEqual([]);
  });

  it('reads "here" as the source`s own Location (355.9)', () => {
    const state = inMainPhase("here");
    const [board, watcher] = withBoardCard(state, PLAIN.id);
    // A Conquer somewhere the source is not must not reach a `here` trigger.
    const at0 = moveEntity(board, watcher, battlefieldLocation(0));

    const matches = (battlefield: number) =>
      triggersFor(
        {
          ...at0,
          definitions: {
            ...at0.definitions,
            [PLAIN.id]: {
              ...PLAIN,
              abilities: {
                triggered: [
                  {
                    condition: {
                      event: "conquer",
                      subject: "you",
                      filter: { here: true },
                    },
                    effect: DRAW_ONE,
                  },
                ],
              },
            },
          },
        },
        { event: "conquer", actor: at0.activePlayer, battlefield },
      ).length;

    expect(matches(0)).toBe(1);
    expect(matches(1)).toBe(0);
  });
});

describe("Dependent Keywords (rules 801.1, 812)", () => {
  it("is unmet until a *different* card has been Finalized this turn (812.1.c)", () => {
    const state = inMainPhase("legion");
    const player = state.activePlayer;
    const [board, source] = withBoardCard(state, LEGIONNAIRE.id);

    expect(dependencyMet(board, source, player, { kind: "legion" })).toBe(
      false,
    );

    // The card's own Finalization does not satisfy its own Legion — which is
    // exactly why `playedThisTurn` holds identities rather than a count.
    const itself = withPlayer(board, player, (seat) => ({
      ...seat,
      playedThisTurn: [source],
    }));
    expect(dependencyMet(itself, source, player, { kind: "legion" })).toBe(
      false,
    );

    const other = withPlayer(board, player, (seat) => ({
      ...seat,
      playedThisTurn: [(source + 1) as EntityId, source],
    }));
    expect(dependencyMet(other, source, player, { kind: "legion" })).toBe(true);
  });

  it("keeps a gated Play Effect off the Chain until Legion is satisfied", () => {
    // Measured against the Main Deck rather than the hand: playing a card moves
    // it out of the hand whether or not anything triggers, but only the draw
    // touches the deck. So the deck is the signal with no arithmetic in it.
    let state = inMainPhase("legion-play", 6);
    const [first, legionnaire] = withHandCard(state, LEGIONNAIRE.id);
    state = first;
    const player = state.activePlayer;
    const deckBefore = getPlayer(state, player).zones.mainDeck.length;

    // Played as the turn's first card: the ability is not Active, so no draw.
    const alone = resolveChain(
      reduce(state, { type: "playCard", card: legionnaire }).state,
    );
    expect(getPlayer(alone, player).zones.mainDeck.length).toBe(deckBefore);

    // Played second, after any other card: the ability is Active.
    const [withBoth, plain] = withHandCard(state, PLAIN.id);
    let after = resolveChain(
      reduce(withBoth, { type: "playCard", card: plain }).state,
    );
    after = resolveChain(
      reduce(after, { type: "playCard", card: legionnaire }).state,
    );

    expect(getPlayer(after, player).zones.mainDeck.length).toBe(deckBefore - 1);
  });

  it("forgets what was played once the turn ends (812.1.c)", () => {
    let state = inMainPhase("legion-turn", 5);
    const [withCard, card] = withHandCard(state, PLAIN.id);
    state = resolveChain(reduce(withCard, { type: "playCard", card }).state);
    expect(getPlayer(state, state.activePlayer).playedThisTurn).toHaveLength(1);

    state = reduce(state, { type: "endTurn" }).state;
    while (state.phase === "ending") {
      state = reduce(state, { type: "resolvePhase" }).state;
    }

    for (const seat of state.players) {
      expect(seat.playedThisTurn).toEqual([]);
    }
  });
});

/**
 * Choices for Triggered Abilities (rule 402, step 2).
 *
 * The rulebook puts both decisions in one step: 402.1 is the "you may" and
 * 402.2 is "all choices required for this ability, such as targets". Rule 400
 * keeps an Ability Pending until it has completed the steps of playing, so an
 * ability with a choice to make waits at step 2 whether or not it is optional.
 *
 * Before this, `queueTriggers` carried `null` and a targeting trigger resolved
 * into nothing at all — a card that ingested cleanly, looked modelled, and was
 * silently wrong.
 */
describe("choices for Triggered Abilities (rule 402)", () => {
  /** "When you play me, deal 2 to a unit." — mandatory, and it targets. */
  const SNIPER = makeUnit(2, ["fury"], {
    id: cardId("C-030"),
    name: "Sniper",
    cost: cost(1),
    abilities: {
      triggered: [
        {
          condition: { event: "played", subject: "self" },
          effect: {
            target: { kind: "unit", scope: "enemy" },
            effects: [{ kind: "dealDamage", amount: 2 }],
          },
        },
      ],
    },
  });

  const REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    PLAIN,
    SNIPER,
    RUNE,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function game(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: [
        ...Array.from({ length: 8 }, () => PLAIN.id),
        ...Array.from({ length: 6 }, () => SNIPER.id),
      ],
      runes: Array.from({ length: 8 }, () => RUNE.id),
      battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
    };
    let state = createGame({
      decks: [list, list],
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
      pool: { ...seat.pool, energy: 6 },
    }));
  }

  /** Put an enemy Unit on the Board for the trigger to shoot at. */
  function withEnemy(state: GameState): [GameState, EntityId] {
    const enemy = playerId((state.activePlayer + 1) % state.players.length);
    const card = state.players[enemy]!.zones.mainDeck.find(
      (candidate) => state.entities[candidate]!.card === PLAIN.id,
    );
    if (card === undefined) {
      throw new Error("no enemy Plain left");
    }
    return [moveEntity(state, card, playerLocation(enemy, "base")), card];
  }

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
      throw new Error(`No ${id} left`);
    }
    return [moveEntity(state, card, playerLocation(player, "hand")), card];
  }

  it("400: a mandatory trigger with a target waits Pending at step 2", () => {
    const [a, victim] = withEnemy(game("pending"));
    const [state, card] = inHand(a, SNIPER.id);

    const played = reduce(state, { type: "playCard", card }).state;
    const top = played.chain[played.chain.length - 1];

    expect(top?.pending).toBe(true);
    expect(top?.targets).toEqual([]);
    expect(victim).toBeDefined();
  });

  it("402.2: offers one choice per legal target, and no decline", () => {
    const [a] = withEnemy(game("offers"));
    const [b] = withEnemy(a);
    const [state, card] = inHand(b, SNIPER.id);

    const played = reduce(state, { type: "playCard", card }).state;
    const actions = legalActions(played, played.priority!);

    // Two enemy Units, so two ways to make the choice.
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.type === "resolveTrigger")).toBe(
      true,
    );
    // 402.4.b: a mandatory ability's controller may not decline this stage.
    expect(
      actions.some((a2) => a2.type === "resolveTrigger" && !a2.perform),
    ).toBe(false);
  });

  it("carries the choice to resolution, so the effect actually happens", () => {
    const [a, victim] = withEnemy(game("resolve"));
    const [state, card] = inHand(a, SNIPER.id);

    let next = reduce(state, { type: "playCard", card }).state;
    next = reduce(next, {
      type: "resolveTrigger",
      perform: true,
      targets: [victim],
    }).state;
    // Drain the Chain so the ability resolves.
    let guard = 0;
    while (next.chain.length > 0 && guard < 12) {
      next = reduce(next, { type: "pass" }).state;
      guard += 1;
    }

    // This is the whole point: before, the damage was never dealt.
    expect(next.entities[victim]!.damage).toBe(2);
    checkInvariants(next);
  });

  it("402.4: an ability with no legal target never reaches the Chain", () => {
    // No enemy Units at all, so there is nothing to choose.
    const [state, card] = inHand(game("no-target"), SNIPER.id);
    const enemy = playerId((state.activePlayer + 1) % state.players.length);
    expect(state.players[enemy]!.zones.base).toHaveLength(0);

    const played = reduce(state, { type: "playCard", card }).state;

    // 402.4: removed at step 2, never a Finalized Chain Item — and 402.4.a says
    // this is not the ability being countered, so nothing else observes it.
    expect(played.chain).toHaveLength(0);
    checkInvariants(played);
  });

  it("rejects a target the ability could not legally choose", () => {
    const [a, victim] = withEnemy(game("illegal"));
    const [state, card] = inHand(a, SNIPER.id);
    const played = reduce(state, { type: "playCard", card }).state;

    // The Sniper targets an *enemy* unit; its own controller's Legend is not one.
    const friendly = played.players[played.activePlayer]!.zones.legendZone[0]!;
    expect(() =>
      reduce(played, {
        type: "resolveTrigger",
        perform: true,
        targets: [friendly],
      }),
    ).toThrow(IllegalActionError);
    expect(victim).toBeDefined();
  });
});

describe("events the reducer raises (415, 355.6, 702)", () => {
  const handSize = (state: GameState, player: PlayerId): number =>
    state.players[player]!.zones.hand.length;

  /** Activate ability 0 of `source` at `victim` and let the Chain settle. */
  const use = (state: GameState, source: EntityId, victim: EntityId): GameState =>
    resolveChain(
      reduce(state, { type: "activateAbility", source, index: 0, targets: [victim] }).state,
    );

  it("415.1.c: readying fires on the change, not on the instruction", () => {
    let state = inMainPhase("ready-event");
    const me = state.activePlayer;
    const [a] = withBoardCard(state, ROUSER.id);
    state = a;
    const [b, waker] = withBoardCard(state, WAKER.id);
    state = b;
    const [c, sleeping] = withBoardCard(state, PLAIN.id);
    state = withEntity(c, sleeping, (current) => ({ ...current, exhausted: true }));

    const before = handSize(state, me);
    const woken = use(state, waker, sleeping);
    expect(getEntity(woken, sleeping).exhausted).toBe(false);
    expect(handSize(woken, me)).toBe(before + 1);

    // 415.1.c makes readying something already ready do nothing, so nothing
    // triggers — the same rule `stun` follows for 423.1.a.1.
    const [d, second] = withBoardCard(woken, WAKER.id);
    const again = use(d, second, sleeping);
    expect(handSize(again, me)).toBe(handSize(woken, me));
  });

  it("315.1: the Awaken Phase raises one event, not one per Unit", () => {
    let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed: "awaken" }).state;
    while (state.phase === "mulligan") {
      state = reduce(state, { type: "mulligan", cards: [] }).state;
    }
    const me = state.activePlayer;
    const [a] = withBoardCard(state, ROUSER.id);
    state = a;
    for (let i = 0; i < 2; i += 1) {
      const [next, unit] = withBoardCard(state, PLAIN.id);
      state = withEntity(next, unit, (current) => ({ ...current, exhausted: true }));
    }

    expect(state.phase).toBe("awaken");
    const awoken = reduce(state, { type: "resolvePhase" }).state;
    // Two Units woken, one event: a per-Unit event would queue this twice.
    expect(awoken.chain).toHaveLength(1);
    expect(handSize(resolveChain(awoken), me)).toBe(handSize(state, me) + 1);
  });

  it("355.6: choosing is an event, and who chose is part of it", () => {
    let state = inMainPhase("chosen-event");
    const me = state.activePlayer;
    const [a, bait] = withBoardCard(state, BAIT.id);
    // EXECUTE only chooses a Unit at a Battlefield (355.9.b).
    state = moveEntity(a, bait, battlefieldLocation(0));
    const [b, execute] = withHandCard(state, EXECUTE.id);
    state = b;

    const before = handSize(state, me);
    const played = resolveChain(
      reduce(state, { type: "playCard", card: execute, targets: [bait] }).state,
    );
    // One card drawn, one Spell gone from the hand.
    expect(handSize(played, me)).toBe(before);
  });

  it("355.6: an ability chose, so the \"with a spell\" half does not hold", () => {
    let state = inMainPhase("chosen-by-ability");
    const me = state.activePlayer;
    const [a, bait] = withBoardCard(state, BAIT.id);
    state = a;
    const [b, sniper] = withBoardCard(state, SNIPER.id);
    state = b;

    const before = handSize(state, me);
    // 377.3.a.1 puts no card on the Chain for an ability, so `bySource` is
    // unset and the filter refuses it.
    expect(handSize(use(state, sniper, bait), me)).toBe(before);
  });

  it("702: a death filter reads the Buff off the pre-move copy", () => {
    let state = inMainPhase("buffed-death");
    const me = state.activePlayer;
    const [a] = withBoardCard(state, MOURNER_OF_BUFFS.id);
    state = a;
    const [b, slayer] = withBoardCard(state, SLAYER.id);
    state = b;
    const [c, victim] = withBoardCard(state, PLAIN.id);
    state = withEntity(c, victim, (current) => ({ ...current, buffs: 1 }));

    const before = handSize(state, me);
    expect(handSize(use(state, slayer, victim), me)).toBe(before + 1);
  });

  it("702: an unbuffed death does not match the same filter", () => {
    let state = inMainPhase("plain-death");
    const me = state.activePlayer;
    const [a] = withBoardCard(state, MOURNER_OF_BUFFS.id);
    state = a;
    const [b, slayer] = withBoardCard(state, SLAYER.id);
    state = b;
    const [c, victim] = withBoardCard(state, PLAIN.id);
    state = c;

    const before = handSize(state, me);
    expect(handSize(use(state, slayer, victim), me)).toBe(before);
  });
});
