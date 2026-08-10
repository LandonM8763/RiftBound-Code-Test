import type { CardRegistry } from '@riftbound/cards';

import {
  checkInvariants as assertInvariants,
  createGame,
  isOver,
  legalActions,
  observe,
  reduce,
  type DeckList,
  type GameConfig,
  type GameEvent,
  type GameState,
  type Outcome,
} from '@riftbound/engine';

import { IllegalAgentChoiceError, isOffered, type Agent } from './agent.js';

export interface MatchOptions {
  readonly decks: readonly DeckList[];
  /** Definitions for every card in every deck; the engine needs costs. */
  readonly registry: CardRegistry;
  /** One agent per seat, in seat order. */
  readonly agents: readonly Agent[];
  readonly seed: number | string;
  readonly config?: Partial<GameConfig> | undefined;
  /** Called for every event, in order. Use for logging or replay capture. */
  readonly onEvent?: ((event: GameEvent) => void) | undefined;
  /** Assert structural invariants after each action. Off by default; on when fuzzing. */
  readonly verifyInvariants?: boolean | undefined;
  /** Safety net against an engine bug that stops the game progressing. */
  readonly maxActions?: number | undefined;
}

export interface MatchResult {
  readonly outcome: Outcome;
  readonly turns: number;
  /** How many actions were taken, forced ones included. */
  readonly actions: number;
  readonly finalState: GameState;
}

/**
 * Play one game to completion.
 *
 * Single games only. Batch simulation and the statistics that come with it —
 * win rates, confidence intervals, sample sizes — belong in the planned `sim`
 * package, not here.
 *
 * The runner is the boundary that keeps agents honest: it computes the legal
 * actions, hands each agent nothing but its own view, and rejects any choice
 * that was not on offer.
 */
export function playGame(options: MatchOptions): MatchResult {
  const { decks, agents, registry, seed } = options;

  if (agents.length !== decks.length) {
    throw new Error(`Got ${agents.length} agents for ${decks.length} decks`);
  }

  const maxActions = options.maxActions ?? 100_000;
  const started = createGame({
    decks,
    registry,
    seed,
    ...(options.config ? { config: options.config } : {}),
  });

  let state = started.state;
  emit(started.events, options.onEvent);

  if (options.verifyInvariants === true) {
    assertInvariants(state);
  }

  let actions = 0;
  while (!isOver(state)) {
    if (actions >= maxActions) {
      throw new Error(
        `Game exceeded ${maxActions} actions without ending; the engine is not making progress`,
      );
    }

    const seat = state.activePlayer;
    const offered = legalActions(state, seat);
    if (offered.length === 0) {
      throw new Error(
        `Player ${seat} has no legal actions during the ${state.phase} phase, but the game has not ended`,
      );
    }

    const agent = agents[seat];
    if (agent === undefined) {
      throw new Error(`No agent for seat ${seat}`);
    }

    const chosen = agent.chooseAction(observe(state, seat), offered);
    if (!isOffered(chosen, offered)) {
      throw new IllegalAgentChoiceError(agent.name, chosen, offered);
    }

    const result = reduce(state, chosen);
    state = result.state;
    actions += 1;
    emit(result.events, options.onEvent);

    if (options.verifyInvariants === true) {
      assertInvariants(state);
    }
  }

  const outcome = state.outcome;
  if (outcome === null) {
    throw new Error('Game loop ended with no outcome');
  }

  return { outcome, turns: state.turn, actions, finalState: state };
}

function emit(events: readonly GameEvent[], onEvent: ((event: GameEvent) => void) | undefined): void {
  if (onEvent === undefined) {
    return;
  }
  for (const event of events) {
    onEvent(event);
  }
}
