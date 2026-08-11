/**
 * Batch simulation.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { playGame, type Agent } from '@riftbound/ai';
import type { CardRegistry } from '@riftbound/cards';
import type { DeckList, GameConfig, Outcome } from '@riftbound/engine';

import {
  summarize,
  wilsonInterval,
  type Interval,
  type Summary,
  Z_95,
} from './statistics.js';

/**
 * Builds a fresh agent for one game.
 *
 * A factory rather than an instance because agents carry RNG state. Reusing one
 * across a batch makes game N depend on game N-1, which is fine for a win rate
 * but means a single game cannot be reproduced from its seed alone — and
 * reproducing the one weird game is most of what a batch run is for.
 */
export type AgentFactory = (seed: string) => Agent;

/** One entrant in the batch: a name and the agent it fields each game. */
export interface Entrant {
  readonly name: string;
  readonly create: AgentFactory;
}

export interface SimulateOptions {
  /** One deck per seat. Entrants rotate through the seats, decks do not. */
  readonly decks: readonly DeckList[];
  readonly registry: CardRegistry;
  /** One entrant per seat, in starting seat order. */
  readonly entrants: readonly Entrant[];
  readonly games: number;
  readonly seed: number | string;
  readonly config?: Partial<GameConfig> | undefined;
  /**
   * Rotate entrants through the seats, one step per game. On by default.
   *
   * Riftbound is not seat-symmetric — the player going second Channels an extra
   * Rune (485.7) — so a fixed seating measures that advantage together with the
   * agents and cannot tell them apart. Turn it off only to measure the seat
   * advantage itself.
   */
  readonly rotateSeats?: boolean | undefined;
  /** Called after each game. For progress output; do not mutate anything. */
  readonly onGame?: ((result: GameSummary, index: number) => void) | undefined;
}

export interface GameSummary {
  readonly seed: string;
  /** Entrant index that won, or `null` for a draw. */
  readonly winner: number | null;
  readonly outcome: Outcome;
  readonly turns: number;
  readonly actions: number;
  /** Final points, indexed by entrant. */
  readonly points: readonly number[];
}

export interface EntrantStats {
  readonly name: string;
  readonly wins: number;
  /** Share of *decided* games won; draws are excluded from the denominator. */
  readonly winRate: number;
  readonly interval: Interval;
  readonly points: Summary;
}

export interface SimulationResult {
  readonly games: number;
  /** Games with a winner. Draws are reported but never counted as half a win. */
  readonly decided: number;
  readonly draws: number;
  readonly entrants: readonly EntrantStats[];
  readonly turns: Summary;
  readonly actions: Summary;
}

/**
 * Play a batch and report win rates with intervals.
 *
 * Deterministic: the same `seed`, entrants and deck lists reproduce the same
 * batch, and each game's seed is derived from the batch seed so any single
 * result can be replayed on its own with `playGame`.
 *
 * Single-threaded on purpose. The engine is pure and the state is
 * structurally shared, so a worker pool would parallelize cleanly — but
 * throughput is not the constraint today, and a pool would make the run
 * non-reproducible unless results were reordered on the way back.
 */
export function simulate(options: SimulateOptions): SimulationResult {
  const { decks, entrants, registry, games } = options;

  if (entrants.length !== decks.length) {
    throw new Error(`Got ${entrants.length} entrants for ${decks.length} decks`);
  }
  if (!Number.isInteger(games) || games < 1) {
    throw new Error(`games must be a positive integer, got ${games}`);
  }

  const rotate = options.rotateSeats ?? true;
  const seats = entrants.length;
  const wins = new Array<number>(seats).fill(0);
  const points: number[][] = entrants.map(() => []);
  const turns: number[] = [];
  const actions: number[] = [];
  let draws = 0;

  for (let game = 0; game < games; game += 1) {
    const shift = rotate ? game % seats : 0;
    // seatOf[entrant] = seat it occupies this game.
    const seatOf = entrants.map((_, entrant) => (entrant + shift) % seats);
    const gameSeed = `${String(options.seed)}#${game}`;

    const agents = new Array<Agent>(seats);
    for (let entrant = 0; entrant < seats; entrant += 1) {
      const seat = seatOf[entrant] as number;
      const factory = entrants[entrant] as Entrant;
      agents[seat] = factory.create(`${gameSeed}/${factory.name}`);
    }

    const result = playGame({
      decks,
      registry,
      agents,
      seed: gameSeed,
      ...(options.config ? { config: options.config } : {}),
    });

    const gamePoints = entrants.map(
      (_, entrant) => result.finalState.players[seatOf[entrant] as number]?.points ?? 0,
    );
    for (let entrant = 0; entrant < seats; entrant += 1) {
      (points[entrant] as number[]).push(gamePoints[entrant] as number);
    }

    let winner: number | null = null;
    if (result.outcome.kind === 'win') {
      const seat = result.outcome.winner;
      winner = seatOf.findIndex((occupied) => occupied === seat);
      wins[winner] = (wins[winner] as number) + 1;
    } else {
      draws += 1;
    }

    turns.push(result.turns);
    actions.push(result.actions);

    options.onGame?.(
      {
        seed: gameSeed,
        winner,
        outcome: result.outcome,
        turns: result.turns,
        actions: result.actions,
        points: gamePoints,
      },
      game,
    );
  }

  const decided = games - draws;

  return {
    games,
    decided,
    draws,
    entrants: entrants.map((entrant, index) => ({
      name: entrant.name,
      wins: wins[index] as number,
      winRate: decided === 0 ? 0 : (wins[index] as number) / decided,
      interval: wilsonInterval(wins[index] as number, decided, Z_95),
      points: summarize(points[index] as number[]),
    })),
    turns: summarize(turns),
    actions: summarize(actions),
  };
}

/**
 * Convenience for the common question: is A better than B?
 *
 * Returns A's stats; `excludes(interval, 0.5)` on the result is the actual
 * answer, and is what a caller should check rather than eyeballing the rate.
 */
export function headToHead(
  options: Omit<SimulateOptions, 'entrants'> & {
    readonly challenger: Entrant;
    readonly baseline: Entrant;
  },
): SimulationResult {
  const { challenger, baseline, ...rest } = options;
  return simulate({ ...rest, entrants: [challenger, baseline] });
}
