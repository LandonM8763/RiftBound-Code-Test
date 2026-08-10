import { Rng, type Action, type GameView } from '@riftbound/engine';

import type { Agent } from './agent.js';

/**
 * Picks uniformly at random from the legal actions.
 *
 * The fuzz-testing workhorse and the baseline every stronger agent has to beat.
 * It is not trying to play well; it is trying to reach states a hand-written
 * test would not think of.
 *
 * It carries its own generator, seeded separately from the game's. Agent
 * choices therefore never perturb the game's random stream, so the same game
 * seed deals the same cards no matter which agents are playing — which is what
 * makes an A/B comparison between two agents a fair one.
 */
export class RandomAgent implements Agent {
  readonly name: string;
  readonly #rng: Rng;

  constructor(seed: number | string, name = 'random') {
    this.#rng = Rng.fromSeed(seed);
    this.name = name;
  }

  chooseAction(_view: GameView, actions: readonly Action[]): Action {
    return this.#rng.pick(actions);
  }
}

/**
 * Always takes the first legal action.
 *
 * Not an opponent — a fixed, seed-independent control for tests that need a
 * deterministic action sequence without threading a seed through.
 */
export class FirstActionAgent implements Agent {
  readonly name = 'first-action';

  chooseAction(_view: GameView, actions: readonly Action[]): Action {
    const first = actions[0];
    if (first === undefined) {
      throw new Error('FirstActionAgent was offered no actions');
    }
    return first;
  }
}
