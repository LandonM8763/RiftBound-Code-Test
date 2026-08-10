import { IllegalActionError, type Action } from './actions.js';
import type { GameEvent } from './events.js';
import { addPoints, moveEntity, withEntity } from './mutate.js';
import { Rng } from './rng.js';
import type { BattlefieldState, EntityId, GameState, Outcome, Phase, PlayerId } from './state.js';
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
    case 'main':
      throw new IllegalActionError(
        'The Main Phase does not resolve automatically; end the turn instead',
      );
    case 'ending':
      return ending(state);
    default: {
      const exhaustive: never = state.phase;
      throw new IllegalActionError(`Unknown phase: ${String(exhaustive)}`);
    }
  }
}

/** Awaken Phase (315.1): the Turn Player readies everything they control. */
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
 * Beginning Phase, Scoring Step (315.2.b): the Turn Player Holds every
 * Battlefield they Control.
 *
 * Holding is one of the two ways to Score (469.2), and a player may Score a
 * given Battlefield only once per turn by either method (470). The Final Point
 * restriction (471.1.b) applies *only* to Conquer — 471.1.a.1 says points from
 * other sources are not beholden to it — so a Hold can take a player to the
 * Victory Score with no extra condition.
 */
function beginning(state: GameState): ReduceResult {
  const player = state.activePlayer;
  const events: GameEvent[] = [];
  let next = state;

  state.battlefields.forEach((battlefield, index) => {
    if (battlefield.controller !== player || battlefield.scoredBy.includes(player)) {
      return;
    }
    next = markScored(next, index, player);
    next = addPoints(next, player, 1);
    events.push({
      type: 'pointsScored',
      player,
      battlefield: index,
      amount: 1,
      total: getPlayer(next, player).points,
      method: 'hold',
    });
  });

  const won = checkVictory(next);
  if (won !== null) {
    events.push({ type: 'gameEnded', outcome: won });
    return { state: { ...next, outcome: won }, events };
  }

  return advance(next, 'channel', events);
}

/**
 * Channel Phase (315.3): the Turn Player Channels 2 Runes.
 *
 * 315.3.b.1 / 430.3: with fewer than 2 Runes left, Channel as many as possible
 * — an empty Rune Deck is not a Burn Out, unlike an empty Main Deck.
 *
 * 485.7: the player going second Channels an extra Rune during their first
 * Channel Phase of the game.
 */
function channel(state: GameState): ReduceResult {
  const player = state.activePlayer;
  const events: GameEvent[] = [];
  let next = state;

  const bonus =
    player !== state.firstPlayer && isFirstTurnFor(state, player)
      ? state.config.secondPlayerBonusRunes
      : 0;
  const total = state.config.channelPerTurn + bonus;

  for (let i = 0; i < total; i += 1) {
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
 * Draw Phase (315.4): the Turn Player draws 1.
 *
 * With an empty Main Deck the player Burns Out (413.4, 431): they Recycle their
 * trash into the Main Deck, randomised, an opponent gains a point, and then the
 * draw completes. This is what makes a real game terminate — a player who runs
 * out of cards hands away a point every turn until someone wins.
 */
function draw(state: GameState): ReduceResult {
  const player = state.activePlayer;
  const events: GameEvent[] = [];
  let next = state;

  for (let i = 0; i < state.config.drawPerTurn; i += 1) {
    if (zoneOf(next, player, 'mainDeck').length === 0) {
      const burned = burnOut(next, player);
      next = burned.state;
      events.push(...burned.events);

      const won = checkVictory(next);
      if (won !== null) {
        events.push({ type: 'gameEnded', outcome: won });
        return { state: { ...next, outcome: won }, events };
      }
    }

    const top = zoneOf(next, player, 'mainDeck')[0];
    if (top === undefined) {
      // Burned Out with an empty trash as well: nothing left to draw.
      events.push({ type: 'mainDeckEmpty', player });
      continue;
    }
    next = moveEntity(next, top, playerLocation(player, 'hand'));
    events.push({ type: 'cardDrawn', player, entity: top });
  }

  return advance(next, 'main', events);
}

/**
 * Burn Out (431.2): Recycle the trash into the Main Deck randomised, then an
 * opponent of the burning player gains 1 point.
 *
 * 431.2.c has the burning player choose which opponent gains the point. With a
 * single opponent that choice is forced; with more it needs a decision point,
 * so this takes the next player in turn order and says so.
 */
function burnOut(state: GameState, player: PlayerId): ReduceResult {
  const events: GameEvent[] = [];
  let next = state;

  const trash = zoneOf(next, player, 'trash');
  if (trash.length > 0) {
    const rng = Rng.fromState(next.rng);
    for (const id of rng.shuffle(trash)) {
      next = moveEntity(next, id, playerLocation(player, 'mainDeck'), 'bottom');
    }
    next = { ...next, rng: rng.state };
  }

  const beneficiary = nextPlayer(next, player);
  next = addPoints(next, beneficiary, 1);

  events.push({
    type: 'burnedOut',
    player,
    recycled: trash.length,
    beneficiary,
    total: getPlayer(next, beneficiary).points,
  });

  return { state: next, events };
}

/** Ending Phase (317): heal every Unit and expire this turn's effects. */
function ending(state: GameState): ReduceResult {
  let next = state;
  const healed: EntityId[] = [];

  for (const entity of Object.values(state.entities)) {
    if (entity.damage > 0) {
      healed.push(entity.id);
      next = withEntity(next, entity.id, (current) => ({ ...current, damage: 0 }));
    }
  }

  const events: GameEvent[] = [{ type: 'turnEnded', player: state.activePlayer }];
  if (healed.length > 0) {
    events.push({ type: 'healed', entities: healed });
  }

  return passTurn(next, events);
}

function endTurn(state: GameState): ReduceResult {
  if (state.phase !== 'main') {
    throw new IllegalActionError(`Cannot end the turn during the ${state.phase} phase`);
  }
  // 316.9: ending the Main Phase moves play to the Ending Phase.
  return advance(state, 'ending', []);
}

function passTurn(state: GameState, events: GameEvent[]): ReduceResult {
  const turn = state.turn + 1;

  // Harness guard, not a rule.
  if (turn > state.config.maxTurns) {
    const outcome: Outcome = {
      kind: 'draw',
      reason: `Exceeded the ${state.config.maxTurns}-turn engine limit`,
    };
    events.push({ type: 'gameEnded', outcome });
    return { state: { ...state, outcome }, events };
  }

  const upcoming = nextPlayer(state, state.activePlayer);
  // 470 is per turn, so the Scoring record resets as the turn passes.
  const battlefields = state.battlefields.map((battlefield) => ({ ...battlefield, scoredBy: [] }));

  events.push({ type: 'phaseEntered', turn, player: upcoming, phase: 'awaken' });

  return {
    state: { ...state, activePlayer: upcoming, turn, phase: 'awaken', battlefields },
    events,
  };
}

/**
 * Rule 323.1 / 472: at a Cleanup, a player with points greater than or equal to
 * the Victory Score *and* more points than any opponent wins.
 *
 * The "more than any opponent" clause matters: reaching 8 while tied does not
 * win, and 194.2.b has play continue until someone is ahead.
 *
 * This engine has no Cleanup system yet, so victory is checked wherever points
 * change. That is the same set of moments for the effects modelled so far.
 */
function checkVictory(state: GameState): Outcome | null {
  let best: PlayerId | null = null;
  let bestPoints = -1;
  let tied = false;

  for (const player of state.players) {
    if (player.points > bestPoints) {
      bestPoints = player.points;
      best = player.id;
      tied = false;
    } else if (player.points === bestPoints) {
      tied = true;
    }
  }

  if (best === null || tied || bestPoints < state.config.victoryScore) {
    return null;
  }
  return { kind: 'win', winner: best };
}

function markScored(state: GameState, index: number, player: PlayerId): GameState {
  const battlefields = state.battlefields.slice();
  const battlefield = battlefields[index] as BattlefieldState;
  battlefields[index] = { ...battlefield, scoredBy: [...battlefield.scoredBy, player] };
  return { ...state, battlefields };
}

/** True while `player` has yet to complete a full turn of their own. */
function isFirstTurnFor(state: GameState, player: PlayerId): boolean {
  const seats = state.players.length;
  // Turn 1 is the first player's; each seat takes its first turn within the
  // opening round of `seats` turns.
  const seatOffset = (player - state.firstPlayer + seats) % seats;
  return state.turn === seatOffset + 1;
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
