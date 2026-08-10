import { IllegalActionError, type Action } from './actions.js';
import type { GameEvent } from './events.js';
import { addPoints, moveEntity, withEntity } from './mutate.js';
import type { EntityId, GameState, Outcome, Phase } from './state.js';
import { getPlayer, isOver, nextPlayer, playerLocation, zoneOf } from './state.js';

export interface ReduceResult {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/**
 * The engine's single transition function: `(state, action) -> state`.
 *
 * Pure. No I/O, no clock, no globals, no mutation of the input. All randomness
 * comes from the seeded generator carried in `state.rng`.
 *
 * Throws `IllegalActionError` for any action `legalActions` would not have
 * offered — an illegal action is a caller bug, not a game outcome.
 */
export function reduce(state: GameState, action: Action): ReduceResult {
  if (isOver(state)) {
    throw new IllegalActionError('The game has ended; no further actions are legal');
  }

  switch (action.type) {
    case 'resolvePhase':
      return resolvePhase(state);
    case 'endTurn':
      return endTurn(state);
    default: {
      const exhaustive: never = action;
      throw new IllegalActionError(`Unknown action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function resolvePhase(state: GameState): ReduceResult {
  switch (state.phase) {
    case 'awaken':
      return awaken(state);
    case 'beginning':
      return beginning(state);
    case 'channel':
      return channel(state);
    case 'draw':
      return draw(state);
    case 'action':
      throw new IllegalActionError(
        'The action phase does not resolve automatically; end the turn instead',
      );
    default: {
      const exhaustive: never = state.phase;
      throw new IllegalActionError(`Unknown phase: ${String(exhaustive)}`);
    }
  }
}

/** Phase A — Awaken: the turn player readies all their cards, Runes included. */
function awaken(state: GameState): ReduceResult {
  const player = state.activePlayer;
  const readied: EntityId[] = [];
  let next = state;

  // Numeric keys iterate in ascending order, so this is deterministic.
  for (const entity of Object.values(state.entities)) {
    if (entity.controller === player && entity.exhausted) {
      readied.push(entity.id);
      next = withEntity(next, entity.id, (current) => ({ ...current, exhausted: false }));
    }
  }

  return advance(next, 'beginning', [{ type: 'readied', player, entities: readied }]);
}

/**
 * Phase B — Beginning: score for each Battlefield being Held.
 *
 * UNVERIFIED: sources say "if you are Holding a Battlefield, score a point"
 * without settling whether that is one point per Battlefield or one point
 * total. This scores per Battlefield, the more natural reading.
 *
 * UNVERIFIED: the final point is reported to be special — it must come from
 * Holding, or from conquering every Battlefield in one turn, and otherwise the
 * player draws a card instead of winning. That restriction is NOT implemented,
 * because implementing it from a guess would silently corrupt every win rate
 * this application reports. Verify against the official rulebook first.
 */
function beginning(state: GameState): ReduceResult {
  const player = state.activePlayer;
  const events: GameEvent[] = [];
  let next = state;

  state.battlefields.forEach((battlefield, index) => {
    if (battlefield.controller === player) {
      next = addPoints(next, player, 1);
      events.push({
        type: 'pointsScored',
        player,
        battlefield: index,
        amount: 1,
        total: getPlayer(next, player).points,
      });
    }
  });

  if (getPlayer(next, player).points >= next.config.pointsToWin) {
    const outcome: Outcome = { kind: 'win', winner: player };
    events.push({ type: 'gameEnded', outcome });
    return { state: { ...next, outcome }, events };
  }

  return advance(next, 'channel', events);
}

/** Phase C — Channelling: Channel Runes from the Rune deck into play. */
function channel(state: GameState): ReduceResult {
  const player = state.activePlayer;
  const events: GameEvent[] = [];
  let next = state;

  for (let i = 0; i < state.config.channelPerTurn; i += 1) {
    const top = zoneOf(next, player, 'runeDeck')[0];
    if (top === undefined) {
      events.push({ type: 'runeDeckEmpty', player });
      break;
    }
    next = moveEntity(next, top, playerLocation(player, 'runes'));
    events.push({ type: 'runeChannelled', player, entity: top });
  }

  return advance(next, 'draw', events);
}

/**
 * Phase D — Draw.
 *
 * UNVERIFIED: what happens when the main deck is empty. Many card games lose
 * the game on an empty draw; this engine emits `mainDeckEmpty` and continues,
 * rather than inventing a loss condition.
 */
function draw(state: GameState): ReduceResult {
  const player = state.activePlayer;
  const events: GameEvent[] = [];
  let next = state;

  for (let i = 0; i < state.config.drawPerTurn; i += 1) {
    const top = zoneOf(next, player, 'mainDeck')[0];
    if (top === undefined) {
      events.push({ type: 'mainDeckEmpty', player });
      break;
    }
    next = moveEntity(next, top, playerLocation(player, 'hand'));
    events.push({ type: 'cardDrawn', player, entity: top });
  }

  return advance(next, 'action', events);
}

function endTurn(state: GameState): ReduceResult {
  if (state.phase !== 'action') {
    throw new IllegalActionError(`Cannot end the turn during the ${state.phase} phase`);
  }

  const player = state.activePlayer;
  const events: GameEvent[] = [{ type: 'turnEnded', player }];
  const turn = state.turn + 1;

  // Harness guard, not a rule: fuzzing must terminate.
  if (turn > state.config.maxTurns) {
    const outcome: Outcome = {
      kind: 'draw',
      reason: `Exceeded the ${state.config.maxTurns}-turn engine limit`,
    };
    events.push({ type: 'gameEnded', outcome });
    return { state: { ...state, outcome }, events };
  }

  const upcoming = nextPlayer(state, player);
  events.push({ type: 'phaseEntered', turn, player: upcoming, phase: 'awaken' });

  return {
    state: { ...state, activePlayer: upcoming, turn, phase: 'awaken' },
    events,
  };
}

function advance(state: GameState, phase: Phase, events: readonly GameEvent[]): ReduceResult {
  return {
    state: { ...state, phase },
    events: [
      ...events,
      { type: 'phaseEntered', turn: state.turn, player: state.activePlayer, phase },
    ],
  };
}
