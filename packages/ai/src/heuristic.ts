/**
 * A scripted-evaluation agent.
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 */
import { Rng, type Action, type BattlefieldView, type GameView } from '@riftbound/engine';

import type { Agent } from './agent.js';

/**
 * What the agent cares about, and how much.
 *
 * Every weight is a guess that a win rate can falsify — which is the point of
 * keeping them in one struct rather than scattered through the scoring code.
 * Tune them by playing tiers against each other, not by intuition.
 */
export interface HeuristicWeights {
  /** Points are the win condition (323.1), so nothing outranks them. */
  readonly point: number;
  /** Controlling a Battlefield scores every turn you keep it (469.2). */
  readonly control: number;
  /** Might on the board: what Combat is decided with (465-466). */
  readonly might: number;
  /** A Unit at a Battlefield contests and threatens to Score. */
  readonly presence: number;
  /** Cards in hand are options; running out ends games. */
  readonly card: number;
  /** Main deck left, as insurance against Burn Out (431). */
  readonly deck: number;
  /** Runes channelled: the resource ceiling for the rest of the game. */
  readonly rune: number;
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  point: 100,
  control: 22,
  might: 4,
  presence: 3,
  card: 2,
  deck: 0.1,
  rune: 1.5,
};

export interface HeuristicOptions {
  /**
   * Seed for tie-breaking only.
   *
   * Equal-scoring actions are broken randomly rather than by list order:
   * `legalActions` enumerates in a fixed order, so always taking the first
   * would make the agent play the same rut every game and hide bugs that only
   * appear on the paths it never takes.
   */
  readonly seed?: number | string | undefined;
  readonly weights?: Partial<HeuristicWeights> | undefined;
  readonly name?: string | undefined;
}

/**
 * Plays by scoring the position after each legal action, one ply deep.
 *
 * Tier 2 of the agent ladder: it must beat `RandomAgent` convincingly over a
 * large sample or it is not an improvement. It has no search and no model of
 * the opponent's reply, so it is beatable by design — it exists to be a
 * competent sparring partner and the baseline the search agent has to pass.
 *
 * It cannot call `reduce` to see where an action leads: the runner hands it a
 * `GameView`, not a `GameState`, and widening that would let it cheat. So it
 * scores the *current* position and applies a per-action bonus for what the
 * action is known to accomplish. That is the honest trade — a real lookahead
 * needs a determinizing search agent holding its own state.
 */
export class HeuristicAgent implements Agent {
  readonly name: string;
  readonly #weights: HeuristicWeights;
  readonly #rng: Rng;

  constructor(options: HeuristicOptions = {}) {
    this.#weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.#rng = Rng.fromSeed(options.seed ?? 'heuristic');
    this.name = options.name ?? 'heuristic';
  }

  chooseAction(view: GameView, actions: readonly Action[]): Action {
    const first = actions[0];
    if (first === undefined) {
      throw new Error('HeuristicAgent was offered no actions');
    }
    if (actions.length === 1) {
      return first;
    }

    let best: Action[] = [];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const action of actions) {
      const score = this.scoreAction(view, action);
      if (score > bestScore) {
        bestScore = score;
        best = [action];
      } else if (score === bestScore) {
        best.push(action);
      }
    }

    return best.length === 1 ? (best[0] as Action) : this.#rng.pick(best);
  }

  /** Positional value of `view` from the viewer's seat. Exposed for tests. */
  evaluate(view: GameView): number {
    const w = this.#weights;
    let score = 0;

    for (const player of view.players) {
      const sign = player.id === view.viewer ? 1 : -1;
      score +=
        sign *
        (player.points * w.point +
          player.hand.length * w.card +
          player.runes.length * w.rune +
          player.mainDeckCount * w.deck);
    }

    for (const battlefield of view.battlefields) {
      if (battlefield.controller !== null) {
        score += (battlefield.controller === view.viewer ? 1 : -1) * w.control;
      }
      for (const unit of battlefield.units) {
        const sign = unit.controller === view.viewer ? 1 : -1;
        score += sign * (w.presence + (unit.might ?? 0) * w.might);
      }
    }

    // Units in Base are Might that is not doing anything yet, so they count for
    // less than the same Might standing on a Battlefield.
    for (const player of view.players) {
      const sign = player.id === view.viewer ? 1 : -1;
      for (const unit of player.base) {
        score += sign * (unit.might ?? 0) * w.might * 0.5;
      }
    }

    return score;
  }

  /**
   * Value of taking `action`, as the current position plus what the action is
   * known to achieve. Higher is better.
   */
  private scoreAction(view: GameView, action: Action): number {
    const w = this.#weights;
    const base = this.evaluate(view);

    switch (action.type) {
      case 'playCard':
        // Spending resources on board is almost always better than passing,
        // and the engine only offers affordable cards.
        return base + w.presence * 2;

      case 'moveUnits':
        return base + this.moveValue(view, action.units.length, action.to);

      case 'addEnergy':
      case 'addPower':
        // Filling the pool is a prerequisite for playing anything, but it is
        // never the goal, so it ranks just above doing nothing.
        return base + 0.5;

      case 'mulligan':
        return base + this.mulliganValue(action.cards.length);

      case 'endTurn':
        // Ending the turn is what the agent does when it has nothing better;
        // every action above outranks it.
        return base - 1;

      case 'pass':
        // Passing in a Showdown concedes the initiative (347.2), but holding
        // Priority with nothing to play just stalls the Chain.
        return base - 0.5;

      case 'resolvePhase':
        return base;

      default:
        return base;
    }
  }

  /**
   * Moving is how a Battlefield is contested and therefore how points are
   * taken (469.1), so it is the agent's main lever.
   */
  private moveValue(
    view: GameView,
    unitCount: number,
    to: { readonly kind: string; readonly index?: number },
  ): number {
    const w = this.#weights;
    if (to.kind !== 'battlefield' || to.index === undefined) {
      // A Recall to Base gives up board position.
      return -w.presence * unitCount;
    }

    const battlefield = view.battlefields[to.index];
    if (battlefield === undefined) {
      return 0;
    }

    let value = w.presence * unitCount;

    // Rule 470: Scoring a Battlefield already Scored this turn gains nothing.
    if (battlefield.scoredBy.includes(view.viewer)) {
      return value * 0.25;
    }

    if (battlefield.controller === null) {
      // Uncontrolled: walking in takes it without a fight.
      value += w.control;
    } else if (battlefield.controller !== view.viewer) {
      value += w.control + this.combatValue(view, battlefield, unitCount);
    } else {
      // Reinforcing something already held does not Score again this turn.
      value *= 0.5;
    }

    return value;
  }

  /**
   * Rough read on attacking into a defended Battlefield.
   *
   * Combat is decided by who has Units left, not by Might totals (466.3), but
   * Might is what removes the other side's Units, so more of it is what makes
   * being the only side standing likely.
   */
  private combatValue(view: GameView, battlefield: BattlefieldView, incoming: number): number {
    const w = this.#weights;
    const defenders = battlefield.units.filter((unit) => unit.controller !== view.viewer);
    const defendingMight = defenders.reduce((sum, unit) => sum + (unit.might ?? 0), 0);
    const attackingMight = battlefield.units
      .filter((unit) => unit.controller === view.viewer)
      .reduce((sum, unit) => sum + (unit.might ?? 0), 0);

    if (defenders.length === 0) {
      return w.control;
    }
    // Trading into a bigger board loses Units for nothing; the sign of the
    // difference is the whole signal here.
    return (attackingMight - defendingMight) * w.might + incoming * w.presence;
  }

  /**
   * Rule 117.1: replacing cards is free, so the only question is how many.
   *
   * With no card-quality model yet, this keeps a hand rather than churning it —
   * a placeholder that gets interesting once costs can be weighed against the
   * Runes available. Deliberately not random: a stable choice keeps the agent's
   * games comparable.
   */
  private mulliganValue(setAside: number): number {
    return setAside === 0 ? 1 : -setAside;
  }
}

/** Convenience for the common case of a seeded agent. */
export function heuristicAgent(seed: number | string, name?: string): HeuristicAgent {
  return new HeuristicAgent({ seed, ...(name === undefined ? {} : { name }) });
}
