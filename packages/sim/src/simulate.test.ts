/**
 * Batch simulation.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { HeuristicAgent, RandomAgent, playGame } from "@riftbound/ai";
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
import type { DeckList } from "@riftbound/engine";
import { describe, expect, it } from "vitest";

import {
  headToHead,
  simulate,
  type Entrant,
  type GameSummary,
} from "./simulate.js";
import { excludes } from "./statistics.js";

const LEGEND = makeLegend(["fury", "calm"], {
  id: cardId("OGN-001"),
  name: "Legend",
});
const CHAMPION = makeUnit(4, ["fury"], {
  id: cardId("OGN-002"),
  name: "Champion",
  champion: true,
});
const UNITS = Array.from({ length: 14 }, (_, i) =>
  makeUnit(2 + (i % 4), ["fury"], {
    id: cardId(`OGN-1${String(i).padStart(2, "0")}`),
    name: `Unit ${i}`,
    cost: cost(1 + (i % 3)),
  }),
);
const FURY_RUNE = makeRune("fury", {
  id: cardId("OGN-200"),
  name: "Fury Rune",
});
const CALM_RUNE = makeRune("calm", {
  id: cardId("OGN-201"),
  name: "Calm Rune",
});
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`OGN-30${i}`), name: `Battlefield ${i}` }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  ...UNITS,
  FURY_RUNE,
  CALM_RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

const DECK: DeckList = {
  legend: LEGEND.id,
  champion: CHAMPION.id,
  main: [
    ...UNITS.slice(0, 13).flatMap((unit) => [unit.id, unit.id, unit.id]),
    (UNITS[13] as CardDefinition).id,
  ],
  runes: [
    ...Array.from({ length: 6 }, () => FURY_RUNE.id),
    ...Array.from({ length: 6 }, () => CALM_RUNE.id),
  ],
  battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
};

const heuristic = (name = "heuristic"): Entrant => ({
  name,
  create: (seed) => new HeuristicAgent({ seed }),
});
const random = (name = "random"): Entrant => ({
  name,
  create: (seed) => new RandomAgent(seed),
});

const base = {
  decks: [DECK, DECK],
  registry: REGISTRY,
  config: { maxTurns: 300 },
} as const;

describe("simulate", () => {
  it("reports wins, a rate and an interval per entrant", () => {
    const result = simulate({
      ...base,
      entrants: [heuristic(), random()],
      games: 40,
      seed: "s",
    });

    expect(result.games).toBe(40);
    expect(result.decided + result.draws).toBe(40);
    expect(result.entrants).toHaveLength(2);
    expect(result.entrants[0]?.name).toBe("heuristic");

    const totalWins = result.entrants.reduce(
      (sum, entrant) => sum + entrant.wins,
      0,
    );
    expect(totalWins).toBe(result.decided);
    for (const entrant of result.entrants) {
      expect(entrant.interval.low).toBeLessThanOrEqual(entrant.winRate);
      expect(entrant.interval.high).toBeGreaterThanOrEqual(entrant.winRate);
    }
  });

  it("is reproducible from its seed", () => {
    const run = () =>
      simulate({
        ...base,
        entrants: [heuristic(), random()],
        games: 20,
        seed: "repeat",
      });
    expect(run()).toEqual(run());
  });

  it("gives different seeds different batches", () => {
    const a = simulate({
      ...base,
      entrants: [heuristic(), random()],
      games: 20,
      seed: "a",
    });
    const b = simulate({
      ...base,
      entrants: [heuristic(), random()],
      games: 20,
      seed: "b",
    });
    expect(a).not.toEqual(b);
  });

  it("derives a per-game seed that replays that game on its own", () => {
    // The point of the batch is finding the one weird game; that is only
    // useful if a single result can be reproduced without rerunning the batch.
    const seen: GameSummary[] = [];
    simulate({
      ...base,
      entrants: [heuristic(), random()],
      games: 3,
      seed: "replay",
      onGame: (summary) => seen.push(summary),
    });

    const first = seen[0] as GameSummary;
    const replayed = playGame({
      decks: [DECK, DECK],
      registry: REGISTRY,
      config: { maxTurns: 300 },
      seed: first.seed,
      agents: [
        new HeuristicAgent({ seed: `${first.seed}/heuristic` }),
        new RandomAgent(`${first.seed}/random`),
      ],
    });

    expect(replayed.outcome).toEqual(first.outcome);
    expect(replayed.turns).toBe(first.turns);
    expect(replayed.actions).toBe(first.actions);
  });

  it("calls onGame once per game, in order", () => {
    const indices: number[] = [];
    simulate({
      ...base,
      entrants: [random("a"), random("b")],
      games: 5,
      seed: "cb",
      onGame: (_summary, index) => indices.push(index),
    });
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("summarizes game length and points", () => {
    const result = simulate({
      ...base,
      entrants: [heuristic(), random()],
      games: 20,
      seed: "len",
    });

    expect(result.turns.n).toBe(20);
    expect(result.turns.mean).toBeGreaterThan(1);
    expect(result.turns.min).toBeLessThanOrEqual(result.turns.max);
    expect(result.actions.mean).toBeGreaterThan(result.turns.mean);
    for (const entrant of result.entrants) {
      expect(entrant.points.n).toBe(20);
      expect(entrant.points.min).toBeGreaterThanOrEqual(0);
    }
    // Someone reached the Victory Score, or nothing would have been decided.
    const best = Math.max(
      ...result.entrants.map((entrant) => entrant.points.max),
    );
    expect(best).toBeGreaterThanOrEqual(8);
  });

  it("allows a final score above the Victory Score", () => {
    // Not a bug: the Scoring Step Holds *every* Battlefield the Turn Player
    // Controls (315.2), and a Hold is exempt from the Final Point restriction
    // (471.1.a.1), so 7 -> 8 -> 9 in one phase is legal. The win is only
    // checked at the Cleanup afterwards (323.1).
    const result = simulate({
      ...base,
      entrants: [heuristic(), random()],
      games: 20,
      seed: "len",
    });
    const best = Math.max(
      ...result.entrants.map((entrant) => entrant.points.max),
    );
    expect(best).toBeGreaterThan(8);
  });

  it("counts draws separately and keeps them out of the win rate", () => {
    // The harness draw guard, not a Riftbound rule: one turn is not enough to
    // reach the Victory Score, so every game ends undecided.
    const result = simulate({
      decks: [DECK, DECK],
      registry: REGISTRY,
      entrants: [heuristic(), random()],
      games: 4,
      seed: "draws",
      config: { maxTurns: 1 },
    });

    expect(result.draws).toBe(4);
    expect(result.decided).toBe(0);
    for (const entrant of result.entrants) {
      expect(entrant.wins).toBe(0);
      expect(entrant.winRate).toBe(0);
      // No decided games is no evidence, not a 0% win rate.
      expect(entrant.interval).toMatchObject({ low: 0, high: 1 });
    }
  });
});

describe("seat rotation", () => {
  it("attributes a win to the entrant, not the seat it sat in", () => {
    // With rotation on, the entrant that occupies seat 0 alternates. If wins
    // were tallied by seat, a one-sided matchup would come out near 50/50.
    const result = simulate({
      ...base,
      entrants: [heuristic(), random()],
      games: 60,
      seed: "rot",
    });
    expect(result.entrants[0]?.winRate).toBeGreaterThan(0.6);
  });

  it("can be turned off to measure the seat advantage itself", () => {
    // Rule 485.7 gives the player going second an extra Rune on their first
    // Channel, so the seats are not symmetric and this is a real question.
    const result = simulate({
      ...base,
      entrants: [random("seat-0"), random("seat-1")],
      games: 40,
      seed: "seats",
      rotateSeats: false,
    });
    expect(result.decided).toBeGreaterThan(0);
    expect(result.entrants[0]?.name).toBe("seat-0");
  });
});

describe("headToHead", () => {
  it("measures the heuristic as better than a coin flip against random", () => {
    // The claim that justifies the heuristic agent existing. `excludes` is the
    // actual test — a bare win rate would not be evidence of anything.
    const result = headToHead({
      ...base,
      challenger: heuristic(),
      baseline: random(),
      games: 150,
      seed: "h2h",
    });

    const challenger = result.entrants[0];
    expect(challenger?.name).toBe("heuristic");
    expect(
      excludes(challenger?.interval ?? { low: 0, high: 1, level: 0.95 }, 0.5),
    ).toBe(true);
    expect(challenger?.interval.low).toBeGreaterThan(0.65);
  });

  it("measures two copies of the same agent as a coin flip", () => {
    // The control. If this drifted from even, the comparison above would be
    // measuring the harness rather than the agents.
    const result = headToHead({
      ...base,
      challenger: random("a"),
      baseline: random("b"),
      games: 150,
      seed: "control",
    });
    expect(
      excludes(
        result.entrants[0]?.interval ?? { low: 0, high: 1, level: 0.95 },
        0.5,
      ),
    ).toBe(false);
  });
});

describe("bad input", () => {
  it("rejects a mismatch between entrants and decks", () => {
    expect(() =>
      simulate({ ...base, entrants: [heuristic()], games: 1, seed: "x" }),
    ).toThrow(/1 entrants for 2 decks/);
  });

  it("rejects a non-positive game count", () => {
    for (const games of [0, -1, 1.5]) {
      expect(() =>
        simulate({
          ...base,
          entrants: [heuristic(), random()],
          games,
          seed: "x",
        }),
      ).toThrow(/positive integer/);
    }
  });
});
