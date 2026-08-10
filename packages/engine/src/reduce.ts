import type { CardDefinition } from '@riftbound/cards';

import { IllegalActionError, type Action } from './actions.js';
import type { GameEvent } from './events.js';
import { addPoints, moveEntity, withEntity, withPlayer } from './mutate.js';
import { canPay, payFrom, timingAllows, totalCost, validUnitLocations } from './play.js';
import { Rng } from './rng.js';
import type {
  BattlefieldState,
  EntityId,
  GameState,
  Location,
  Outcome,
  Phase,
  PlayerId,
} from './state.js';
import {
  EMPTY_POOL,
  addEnergyTo,
  addPowerTo,
  entityCard,
  getEntity,
  getPlayer,
  isClosed,
  isOver,
  nextPlayer,
  playerLocation,
  sameLocation,
  zoneOf,
} from './state.js';

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
    case 'addEnergy':
      return addEnergy(state, action.rune);
    case 'addPower':
      return addPower(state, action.rune);
    case 'playCard':
      return playCard(state, action.card, action.location);
    case 'pass':
      return pass(state);
    default: {
      const exhaustive: never = action;
      throw new IllegalActionError(`Unknown action: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A Basic Rune's `[E]: Add [1]` (rule 164.2.a). */
function addEnergy(state: GameState, rune: EntityId): ReduceResult {
  const player = requirePriority(state);
  const entity = getEntity(state, rune);

  if (entity.controller !== player || !sameLocation(entity.location, playerLocation(player, 'runes'))) {
    throw new IllegalActionError(`Entity ${rune} is not a Rune ${player} controls in play`);
  }
  if (entity.exhausted) {
    throw new IllegalActionError(`Rune ${rune} is already exhausted`);
  }

  let next = withEntity(state, rune, (current) => ({ ...current, exhausted: true }));
  next = withPlayer(next, player, (current) => ({
    ...current,
    pool: addEnergyTo(current.pool, 1),
  }));

  return {
    state: next,
    events: [{ type: 'resourcesAdded', player, rune, energy: 1, power: null }],
  };
}

/** A Basic Rune's `Recycle this: Add [C]` (rule 164.2.b). */
function addPower(state: GameState, rune: EntityId): ReduceResult {
  const player = requirePriority(state);
  const entity = getEntity(state, rune);

  if (entity.controller !== player || !sameLocation(entity.location, playerLocation(player, 'runes'))) {
    throw new IllegalActionError(`Entity ${rune} is not a Rune ${player} controls in play`);
  }
  const card = entityCard(state, rune);
  if (card.type !== 'rune') {
    throw new IllegalActionError(`${card.name} is not a Rune`);
  }

  // Recycling returns it to the bottom of the Rune Deck (rule 416.1.b).
  let next = moveEntity(state, rune, playerLocation(player, 'runeDeck'), 'bottom');
  next = withEntity(next, rune, (current) => ({ ...current, exhausted: false }));
  next = withPlayer(next, player, (current) => ({
    ...current,
    pool: addPowerTo(current.pool, card.domain, 1),
  }));

  return {
    state: next,
    events: [{ type: 'resourcesAdded', player, rune, energy: 0, power: card.domain }],
  };
}

/**
 * The Process of Play (rule 353).
 *
 * Steps 1-6 run atomically here. Nothing can interrupt a card between going on
 * the Chain and finalizing: other players only get Priority once an item is
 * Finalized, and a Permanent leaves the Chain at that moment (359.2).
 */
function playCard(state: GameState, card: EntityId, location: Location | undefined): ReduceResult {
  const player = requirePriority(state);
  const entity = getEntity(state, card);

  if (entity.controller !== player || !sameLocation(entity.location, playerLocation(player, 'hand'))) {
    throw new IllegalActionError(`Entity ${card} is not in ${player}'s hand`);
  }

  const definition = entityCard(state, card);
  if (!timingAllows(definition, isClosed(state))) {
    throw new IllegalActionError(
      `${definition.name} cannot be played while the turn is ${isClosed(state) ? 'Closed' : 'Open'}`,
    );
  }

  const cost = totalCost(definition);
  if (cost === undefined) {
    throw new IllegalActionError(`${definition.name} is not a playable card`);
  }
  if (!canPay(getPlayer(state, player).pool, cost)) {
    throw new IllegalActionError(`Cannot pay for ${definition.name}`);
  }

  // Step 4: pay (rule 357.1).
  let next = withPlayer(state, player, (current) => ({
    ...current,
    pool: payFrom(current.pool, cost),
  }));

  const events: GameEvent[] = [];

  if (definition.type === 'spell') {
    // 359.3: a Spell lingers on the Chain as a Finalized item.
    next = moveEntity(next, card, playerLocation(player, 'chain'));
    next = {
      ...next,
      chain: [...next.chain, { entity: card, controller: player, pending: false }],
      passes: 0,
      priority: player,
    };
    events.push(
      { type: 'cardPlayed', player, entity: card, onChain: true },
      { type: 'chainItemAdded', entity: card, controller: player },
    );
    return { state: next, events };
  }

  // 359.2: a Permanent leaves the Chain and becomes a Game Object at once.
  const destination = resolvePermanentLocation(next, player, definition, location);
  next = moveEntity(next, card, destination);
  // 359.2.c: a Unit enters exhausted; 359.2.d: Gear enters ready at the Base.
  next = withEntity(next, card, (current) => ({
    ...current,
    exhausted: definition.type === 'unit',
  }));

  events.push({ type: 'cardPlayed', player, entity: card, onChain: false });
  return { state: next, events };
}

function resolvePermanentLocation(
  state: GameState,
  player: PlayerId,
  definition: CardDefinition,
  location: Location | undefined,
): Location {
  if (definition.type !== 'unit') {
    // 359.2.d: non-Unit Gear always enters at the player's Base.
    return playerLocation(player, 'base');
  }
  const allowed = validUnitLocations(state, player);
  if (location === undefined) {
    return allowed[0] as Location;
  }
  if (!allowed.some((candidate) => sameLocation(candidate, location))) {
    throw new IllegalActionError(`Units may not be played to that location`);
  }
  return location;
}

/**
 * Pass Priority (rule 312.2.d).
 *
 * With a Chain, passing all the way around resolves the top item. With no
 * Chain, passing is how the Turn Player declines to act — the Main Phase then
 * has nothing left to do but end, so `pass` is only offered while a Chain
 * exists.
 */
function pass(state: GameState): ReduceResult {
  const player = requirePriority(state);
  if (!isClosed(state)) {
    throw new IllegalActionError('There is nothing to pass Priority on: the Chain is empty');
  }

  const events: GameEvent[] = [{ type: 'priorityPassed', player }];
  const passes = state.passes + 1;

  if (passes < state.players.length) {
    return {
      state: { ...state, passes, priority: nextPlayer(state, player) },
      events,
    };
  }

  // Everyone passed in succession: the top Chain item resolves (359.3.d).
  const top = state.chain[state.chain.length - 1];
  if (top === undefined) {
    throw new IllegalActionError('The Chain is empty');
  }

  // No card has effects yet, so resolution is the Spell going to the trash.
  let next = moveEntity(state, top.entity, playerLocation(top.controller, 'trash'));
  const chain = state.chain.slice(0, -1);
  const nextTop = chain[chain.length - 1];

  next = {
    ...next,
    chain,
    passes: 0,
    // 312.2.c: Priority goes to the controller of the next item; with an empty
    // Chain the state Opens and the Turn Player acts again (312.2.a).
    priority: nextTop === undefined ? state.activePlayer : nextTop.controller,
  };

  events.push({ type: 'chainItemResolved', entity: top.entity });
  return { state: next, events };
}

function requirePriority(state: GameState): PlayerId {
  if (state.priority === null) {
    throw new IllegalActionError('No player has Priority right now');
  }
  return state.priority;
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

  return enterMain(next, events);
}

/**
 * Enter the Main Phase (rule 316).
 *
 * 316.3: every player's Rune Pool empties first and unspent resources are lost.
 * 312.2.a: the Turn Player then has Priority for as long as the state is
 * Neutral Open.
 */
function enterMain(state: GameState, events: GameEvent[]): ReduceResult {
  let next = emptyPools(state, events);
  next = { ...next, phase: 'main', priority: next.activePlayer, passes: 0 };
  events.push({ type: 'phaseEntered', turn: next.turn, player: next.activePlayer, phase: 'main' });
  return { state: next, events };
}

function emptyPools(state: GameState, events: GameEvent[]): GameState {
  let next = state;
  for (const player of state.players) {
    if (player.pool.energy === 0 && Object.values(player.pool.power).every((n) => n === 0)) {
      continue;
    }
    next = withPlayer(next, player.id, (current) => ({ ...current, pool: EMPTY_POOL }));
    events.push({ type: 'poolEmptied', player: player.id });
  }
  return next;
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

  // 317.2.e: every Rune Pool empties again at the end of the turn.
  next = emptyPools(next, events);

  return passTurn(next, events);
}

function endTurn(state: GameState): ReduceResult {
  if (state.phase !== 'main') {
    throw new IllegalActionError(`Cannot end the turn during the ${state.phase} phase`);
  }
  if (isClosed(state)) {
    throw new IllegalActionError('Cannot end the turn while the Chain still holds items');
  }
  // 316.9: ending the Main Phase moves play to the Ending Phase.
  return advance({ ...state, priority: null }, 'ending', []);
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
    state: {
      ...state,
      activePlayer: upcoming,
      turn,
      phase: 'awaken',
      battlefields,
      // No player has Priority outside the Main Phase (rule 312.2.a).
      priority: null,
      passes: 0,
    },
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
