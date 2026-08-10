import type { Action, GameView } from '@riftbound/engine';

/**
 * Something that can play Riftbound.
 *
 * An agent is handed its own observable view and the list of actions the engine
 * says are legal, and returns one of them. It never receives `GameState`: the
 * signature is the enforcement mechanism for "an agent cannot cheat", so do not
 * widen it to take state, and do not let an agent reach for the engine's
 * accessors to get around it.
 *
 * Deliberately synchronous. Search agents run this millions of times per match,
 * and a promise per decision would dominate the cost. A human or UI player is a
 * different interface built on top, not a reason to make this async.
 */
export interface Agent {
  readonly name: string;

  /**
   * Choose one of `actions`.
   *
   * `actions` is never empty when the engine calls this, and the returned
   * action must be one of them — the match runner rejects anything else rather
   * than letting an illegal move through.
   */
  chooseAction(view: GameView, actions: readonly Action[]): Action;
}

/** Thrown when an agent returns something that was not on offer. */
export class IllegalAgentChoiceError extends Error {
  constructor(agent: string, chosen: Action, offered: readonly Action[]) {
    super(
      `Agent "${agent}" chose ${JSON.stringify(chosen)}, which is not among the ` +
        `${offered.length} legal action(s): ${JSON.stringify(offered)}`,
    );
    this.name = 'IllegalAgentChoiceError';
  }
}

/** True when `chosen` matches one of the offered actions structurally. */
export function isOffered(chosen: Action, offered: readonly Action[]): boolean {
  if (offered.includes(chosen)) {
    return true;
  }
  const target = JSON.stringify(chosen);
  return offered.some((action) => JSON.stringify(action) === target);
}
