/**
 * Golden games, and the engine-wide properties they exist to protect.
 *
 * Two things live here, and they catch different failures.
 *
 * **Golden games** replay a fixed seed and a fixed agent through a whole game
 * and pin the result. The engine is deterministic by design, so any unintended
 * rule change moves one of these numbers — which is precisely what a
 * hand-written test about one rule cannot notice. They are recorded as a
 * readable digest rather than a hash so that a break says *what* changed.
 *
 * **Properties** are the four claims CLAUDE.md makes about the engine that
 * nothing else asserts end to end: purity, determinism, legality agreement,
 * and that no view reveals a hidden card. Each is checked over whole games
 * rather than at a point, because that is where they would actually fail.
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

import { checkInvariants } from "./invariants.js";
import { currentLegalActions } from "./legal.js";
import { reduce } from "./reduce.js";
import { Rng } from "./rng.js";
import { createGame, type DeckList } from "./setup.js";
import { observe } from "./view.js";
import { isOver, type GameState } from "./state.js";

/**
 * A deck built to exercise the interesting paths, not to be good.
 *
 * Keywords, a Play Effect, a Triggered Ability, an Activated Ability, a Token,
 * a Gear with Equip and Effect Text, and a card with Hidden — so a golden game
 * walks Combat, the Chain, Attachment and the Facedown Zone rather than only
 * the turn structure.
 */
const LEGEND = makeLegend(["fury"], { id: cardId("G-000") });
const CHAMPION = makeUnit(3, ["fury"], { id: cardId("G-001"), champion: true });

const GRUNT = makeUnit(2, ["fury"], {
  id: cardId("G-010"),
  name: "Grunt",
  cost: cost(1),
});
const TANKER = makeUnit(3, ["fury"], {
  id: cardId("G-011"),
  name: "Tanker",
  cost: cost(2),
  keywords: [{ kind: "tank" }],
});
const RAIDER = makeUnit(2, ["fury"], {
  id: cardId("G-012"),
  name: "Raider",
  cost: cost(2),
  keywords: [{ kind: "assault", value: 2 }],
  effect: { target: { kind: "none" }, effects: [{ kind: "draw", count: 1 }] },
});
const SUMMONER = makeUnit(1, ["fury"], {
  id: cardId("G-013"),
  name: "Summoner",
  cost: cost(2),
  abilities: {
    triggered: [
      {
        condition: { event: "played", subject: "self" },
        effect: {
          target: { kind: "none" },
          effects: [
            { kind: "createToken", token: "recruit", count: 1, where: "base" },
          ],
        },
      },
    ],
  },
});
const LURKER = makeUnit(4, ["fury"], {
  id: cardId("G-014"),
  name: "Lurker",
  cost: cost(5),
  keywords: [{ kind: "hidden" }],
});

const BOLT = makeSpell(["fury"], {
  id: cardId("G-020"),
  name: "Bolt",
  cost: cost(1),
  timing: "action",
  effect: {
    target: { kind: "unit", scope: "any" },
    effects: [{ kind: "dealDamage", amount: 2 }],
  },
});

const BLADE = makeGear(["fury"], {
  id: cardId("G-030"),
  name: "Blade",
  cost: cost(1),
  abilities: {
    activated: [
      {
        cost: cost(0, "fury"),
        exhaustSelf: false,
        effect: {
          target: { kind: "unit", scope: "friendly" },
          effects: [{ kind: "attach" }],
        },
      },
    ],
  },
  attached: { mightBonus: 2, keywords: [{ kind: "assault", value: 1 }] },
});

const RUNE = makeRune("fury", { id: cardId("G-100") });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`G-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  GRUNT,
  TANKER,
  RAIDER,
  SUMMONER,
  LURKER,
  BOLT,
  BLADE,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  const main: CardDefinition["id"][] = [];
  for (const card of [GRUNT, TANKER, RAIDER, SUMMONER, LURKER, BOLT, BLADE]) {
    for (let i = 0; i < 7; i += 1) {
      main.push(card.id);
    }
  }
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main,
    runes: Array.from({ length: 12 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

/** One whole game, driven by a seeded uniform choice over the legal actions. */
function play(seed: string): { state: GameState; actions: number } {
  const rng = Rng.fromSeed(`golden-${seed}`);
  let state = createGame({
    decks: [deck(), deck()],
    registry: REGISTRY,
    seed,
  }).state;
  let actions = 0;
  while (!isOver(state) && actions < 6000) {
    const legal = currentLegalActions(state);
    state = reduce(state, legal[rng.nextInt(legal.length)]!).state;
    actions += 1;
  }
  return { state, actions };
}

/** A readable digest: enough to notice a rule change, few enough to diagnose one. */
function digest(state: GameState, actions: number): Record<string, unknown> {
  return {
    turns: state.turn,
    actions,
    outcome: state.outcome === null ? null : state.outcome.kind,
    winner: state.outcome?.kind === "win" ? state.outcome.winner : null,
    points: state.players.map((p) => p.points),
    hands: state.players.map((p) => p.zones.hand.length),
    trash: state.players.map((p) => p.zones.trash.length),
    board: state.players.map((p) => p.zones.base.length),
    units: state.battlefields.map((b) => b.units.length),
    control: state.battlefields.map((b) => b.controller),
  };
}

describe("golden games", () => {
  // Recorded from the engine, then reviewed against the rules. A change here
  // is a *result*, not a failure — check that the rule change was intended,
  // then re-record.
  const GOLDEN: Record<string, ReturnType<typeof digest>> = {
    alpha: {
      turns: 20,
      actions: 218,
      outcome: "win",
      winner: 0,
      points: [8, 4],
      hands: [8, 7],
      trash: [3, 5],
      board: [1, 0],
      units: [1, 2],
      control: [1, 0],
    },
    bravo: {
      turns: 13,
      actions: 139,
      outcome: "win",
      winner: 1,
      points: [0, 8],
      hands: [8, 3],
      trash: [1, 1],
      board: [1, 1],
      units: [3, 3],
      control: [1, 1],
    },
    charlie: {
      turns: 26,
      actions: 315,
      outcome: "win",
      winner: 0,
      points: [8, 4],
      hands: [3, 10],
      trash: [4, 7],
      board: [5, 0],
      units: [2, 3],
      control: [0, 0],
    },
    delta: {
      turns: 16,
      actions: 182,
      outcome: "win",
      winner: 0,
      points: [8, 2],
      hands: [5, 8],
      trash: [1, 4],
      board: [3, 0],
      units: [1, 2],
      control: [0, 0],
    },
  };

  for (const seed of ["alpha", "bravo", "charlie", "delta"]) {
    it(`replays "${seed}" to the same finish`, () => {
      const { state, actions } = play(seed);
      const recorded = GOLDEN[seed];
      const actual = digest(state, actions);
      if (recorded === undefined) {
        // Recording mode: print, so the value can be pasted in.
        console.log(`  ${seed}: ${JSON.stringify(actual)},`);
      } else {
        expect(actual).toEqual(recorded);
      }
      checkInvariants(state);
    });
  }

  it("323.1: every recorded win is one the rule would award", () => {
    // The digests are only worth pinning if they are *right*, and the win
    // condition is the rule community sources get wrong most often: reaching
    // the Victory Score is not enough, it also has to beat every opponent.
    for (const golden of Object.values(GOLDEN)) {
      const points = golden["points"] as number[];
      const winner = golden["winner"] as number;
      expect(points[winner]).toBeGreaterThanOrEqual(8);
      for (const [seat, score] of points.entries()) {
        if (seat !== winner) {
          expect(score).toBeLessThan(points[winner]!);
        }
      }
    }
  });
});

/**
 * The four claims CLAUDE.md makes about the engine that no other test asserts
 * over a whole game. Each is cheap to check and expensive to discover broken.
 */
describe("engine properties", () => {
  it("is pure: `reduce` never mutates the state it is given", () => {
    // A search agent explores thousands of futures from one node. A single
    // in-place write would corrupt every sibling, and nothing else in this
    // suite would notice — the mutated state is still internally consistent.
    const rng = Rng.fromSeed("purity");
    let state = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: "purity",
    }).state;
    for (let step = 0; step < 400 && !isOver(state); step += 1) {
      const legal = currentLegalActions(state);
      const before = JSON.stringify(state);
      const next = reduce(state, legal[rng.nextInt(legal.length)]!).state;
      expect(JSON.stringify(state)).toBe(before);
      state = next;
    }
  });

  it("is deterministic: the same seed and actions replay identically", () => {
    // What makes a batch run reproducible, and a single game replayable from
    // its seed alone.
    const rng = Rng.fromSeed("determinism");
    let state = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: "det",
    }).state;
    const taken: unknown[] = [];
    for (let step = 0; step < 400 && !isOver(state); step += 1) {
      const legal = currentLegalActions(state);
      const action = legal[rng.nextInt(legal.length)]!;
      taken.push(action);
      state = reduce(state, action).state;
    }

    let replay = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: "det",
    }).state;
    for (const action of taken) {
      replay = reduce(replay, action as never).state;
    }
    expect(JSON.stringify(replay)).toBe(JSON.stringify(state));
  });

  it("every action `legalActions` offers, `reduce` accepts", () => {
    // The contract `legalActions` documents. Agents and the eventual UI both
    // drive the game by enumerating it, so an offer `reduce` refuses is a
    // crash rather than a bad play.
    const rng = Rng.fromSeed("legality");
    let state = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: "legal",
    }).state;
    for (let step = 0; step < 400 && !isOver(state); step += 1) {
      const legal = currentLegalActions(state);
      expect(legal.length).toBeGreaterThan(0);
      // Every offer is tried against a *copy* of the same state, so this checks
      // all of them rather than the one the walk happens to take.
      for (const action of legal) {
        expect(() => reduce(state, action)).not.toThrow();
      }
      state = reduce(state, legal[rng.nextInt(legal.length)]!).state;
    }
  });

  it("no view ever names a card the viewer may not see", () => {
    // 128.4: a hand is Private to its owner, and a facedown card to its
    // controller. Decks are exposed as counts and so cannot leak at all.
    const rng = Rng.fromSeed("privacy");
    let state = createGame({
      decks: [deck(), deck()],
      registry: REGISTRY,
      seed: "priv",
    }).state;
    for (let step = 0; step < 400 && !isOver(state); step += 1) {
      for (const seat of state.players) {
        for (const other of observe(state, seat.id).players) {
          if (other.id === seat.id) {
            continue;
          }
          expect(other.hand.every((card) => card.card === null)).toBe(true);
          expect(other.facedown.every((card) => card.card === null)).toBe(true);
        }
      }
      const legal = currentLegalActions(state);
      state = reduce(state, legal[rng.nextInt(legal.length)]!).state;
    }
  });
});
