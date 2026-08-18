/**
 * A determinizing search agent (Phase 3's third tier).
 *
 * The heuristic scores the position it is looking at and adds a bonus per
 * action type, one ply deep, because it is handed a `GameView` and a view
 * cannot be played forward. This agent does the thing that needs: it rebuilds a
 * plausible `GameState` from the view and *plays it out*.
 *
 * ## Determinized Monte Carlo, not plain MCTS
 *
 * Hidden information makes a single search tree a lie: the opponent's hand is
 * unknown, so any one tree is a tree over one guess. The standard answer is to
 * sample several worlds and average, which is what this does — for each
 * candidate action, play it in `worlds` different determinizations and score
 * how they end up. It is Monte Carlo over determinizations rather than a UCT
 * tree, and the reason is measured rather than aesthetic: rollouts here are
 * dominated by `reduce`, so spending the budget on more *worlds* rather than
 * deeper selection in one world is what buys accuracy against an opponent whose
 * hand you cannot see.
 *
 * ## What keeps it honest
 *
 * It takes a `GameView` like every other agent. It never sees the state, and
 * `determinize` cannot invent information the view withheld — the opponent's
 * hand comes out of the sampling pool, not out of the real game. The one thing
 * it is given at construction is the card pool, which a player legitimately
 * knows: you can read every card in your own deck.
 */
import {
  Rng,
  determinize,
  isOver,
  legalActions,
  observe,
  reduce,
  type Action,
  type GameState,
  type GameView,
  type Knowledge,
  type PlayerId,
} from '@riftbound/engine';

import type { Agent } from './agent.js';
import { HeuristicAgent, scorePosition, type HeuristicWeights } from './heuristic.js';

export interface SearchOptions {
  /** What the agent legitimately knows: the card pool, and what may be hidden. */
  readonly knowledge: Knowledge;
  /**
   * How many determinizations to average each candidate action over.
   *
   * The accuracy knob that matters most under hidden information: one world is
   * one guess about the opponent's hand, and a good action has to be good
   * across several.
   */
  readonly worlds?: number | undefined;
  /**
   * How many actions deep to play each world before scoring it.
   *
   * Not "plies": a Riftbound turn is many actions, so this is a budget rather
   * than a depth. Scoring a position that is halfway through a Combat would
   * read the board mid-resolution, which is why the rollout runs on rather
   * than stopping at a fixed ply.
   */
  readonly rollout?: number | undefined;
  readonly seed?: number | string | undefined;
  readonly weights?: Partial<HeuristicWeights> | undefined;
  readonly name?: string | undefined;
}

/**
 * Plays by rolling out each candidate action in several sampled worlds.
 *
 * Falls back to the heuristic whenever search cannot help — a single legal
 * action, or a determinization that the engine will not accept — so it is never
 * worse than the tier below it by construction.
 */
export class SearchAgent implements Agent {
  readonly name: string;
  readonly #knowledge: Knowledge;
  readonly #worlds: number;
  readonly #rollout: number;
  readonly #rng: Rng;
  readonly #fallback: HeuristicAgent;
  readonly #weights: Partial<HeuristicWeights> | undefined;

  constructor(options: SearchOptions) {
    this.name = options.name ?? 'search';
    this.#knowledge = options.knowledge;
    this.#worlds = Math.max(1, options.worlds ?? 4);
    this.#rollout = Math.max(1, options.rollout ?? 60);
    this.#rng = Rng.fromSeed(options.seed ?? 'search');
    this.#weights = options.weights;
    this.#fallback = new HeuristicAgent({
      seed: `${String(options.seed ?? 'search')}-fallback`,
      ...(options.weights === undefined ? {} : { weights: options.weights }),
    });
  }

  chooseAction(view: GameView, actions: readonly Action[]): Action {
    // 355.8 and friends often leave exactly one thing to do — resolving a
    // phase, passing into a resolution. Searching those is pure cost.
    if (actions.length === 1) {
      return actions[0]!;
    }

    const me = view.viewer;
    let best: Action | undefined;
    let bestScore = -Infinity;

    for (const action of actions) {
      let total = 0;
      let counted = 0;
      for (let world = 0; world < this.#worlds; world += 1) {
        const value = this.#evaluate(view, action, me, world);
        if (value !== undefined) {
          total += value;
          counted += 1;
        }
      }
      if (counted === 0) {
        continue;
      }
      const mean = total / counted;
      // Ties broken by the agent's own generator, never by list order:
      // `legalActions` enumerates in a fixed order, and taking the first would
      // make the agent replay one rut and hide bugs on the paths it never walks.
      if (mean > bestScore || (mean === bestScore && this.#rng.nextInt(2) === 0)) {
        bestScore = mean;
        best = action;
      }
    }

    // Every world refused every action: fall back rather than guess.
    return best ?? this.#fallback.chooseAction(view, actions);
  }

  /**
   * Play `action` in one sampled world and score where it ends up.
   *
   * The whole evaluation is guarded, not just the setup. A determinization the
   * engine will not accept is a bad *sample*, not a bad action, and it must
   * neither count against the action being considered nor take the agent down
   * — a search that throws is strictly worse than no search.
   */
  #evaluate(view: GameView, action: Action, me: PlayerId, world: number): number | undefined {
    try {
      let state: GameState = determinize(
        view,
        this.#knowledge,
        `${this.#rng.nextInt(1 << 30)}-${world}`,
      );
      state = reduce(state, action).state;

      // Roll out with uniform-random legal play. Deliberately not the
      // heuristic: a rollout policy sharing the evaluation's biases reinforces
      // them, and random play is the standard unbiased default.
      const rng = Rng.fromSeed(`${world}-${this.#rng.nextInt(1 << 30)}`);
      for (let step = 0; step < this.#rollout && !isOver(state); step += 1) {
        const actor = state.priority ?? state.activePlayer;
        const legal = legalActions(state, actor);
        if (legal.length === 0) {
          break;
        }
        state = reduce(state, legal[rng.nextInt(legal.length)]!).state;
      }

      if (isOver(state)) {
        // A decided game outranks any position, so the search prefers a line
        // that wins over one that merely looks strong.
        return state.outcome?.kind === 'win' && state.outcome.winner === me ? 1e6 : -1e6;
      }
      // Scored through the viewer's own eyes with the same function the
      // heuristic tier uses, so "the search agent is stronger" is a claim
      // about lookahead rather than about a different evaluation.
      return scorePosition(observe(state, me), me, this.#weights);
    } catch {
      return undefined;
    }
  }
}
