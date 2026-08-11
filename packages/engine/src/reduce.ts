import { effectOf, type CardDefinition } from '@riftbound/cards';

import { IllegalActionError, type Action } from './actions.js';
import type { GameEvent } from './events.js';
import { addPoints, moveEntity, withEntity, withPlayer } from './mutate.js';
import {
  assignDamage,
  combatResult,
  combatSides,
  hasLethalDamage,
  sumMight,
  type CombatRole,
} from './combat.js';
import {
  applyContested,
  canStandardMove,
  cleanupControl,
  standardMoveDestinations,
} from './move.js';
import {
  abilityFor,
  activatableAbilities,
  triggerKey,
  triggersFor,
  type PendingTrigger,
  type TriggerEventInstance,
} from './abilities.js';
import { executeEffect, isValidTarget, type EffectContext } from './effects.js';
import { totalCost } from './costs.js';
import { canPay, payFrom, timingAllows, validUnitLocations } from './play.js';
import { Rng } from './rng.js';
import type {
  BattlefieldState,
  ChainItem,
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
  isShowdown,
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
      return playCard(state, action.card, action.location, action.target, action.destination);
    case 'pass':
      return pass(state);
    case 'moveUnits':
      return moveUnits(state, action.units, action.to);
    case 'mulligan':
      return mulligan(state, action.cards);
    case 'activateAbility':
      return activateAbility(state, action.source, action.index, action.target, action.destination);
    case 'resolveTrigger':
      return resolveTrigger(state, action.perform);
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
function playCard(
  state: GameState,
  card: EntityId,
  location: Location | undefined,
  target: EntityId | undefined,
  destination: Location | undefined,
): ReduceResult {
  const player = requirePriority(state);
  const entity = getEntity(state, card);

  if (entity.controller !== player || !sameLocation(entity.location, playerLocation(player, 'hand'))) {
    throw new IllegalActionError(`Entity ${card} is not in ${player}'s hand`);
  }

  const definition = entityCard(state, card);
  const timing = { closed: isClosed(state), showdown: isShowdown(state) };
  if (!timingAllows(definition, timing)) {
    throw new IllegalActionError(
      `${definition.name} cannot be played in a ${timing.showdown ? 'Showdown' : 'Neutral'} ` +
        `${timing.closed ? 'Closed' : 'Open'} state`,
    );
  }

  const cost = totalCost(state, player, definition);
  if (cost === undefined) {
    throw new IllegalActionError(`${definition.name} is not a playable card`);
  }
  if (!canPay(getPlayer(state, player).pool, cost)) {
    throw new IllegalActionError(`Cannot pay for ${definition.name}`);
  }

  // Step 2 (355.6): targets are chosen now, and step 5 (358.1) checks them.
  const effect = effectOf(definition);
  if (effect !== undefined && !isValidTarget(state, player, effect.target, target)) {
    throw new IllegalActionError(`${definition.name} has no valid target ${String(target)}`);
  }
  if (effect === undefined && target !== undefined) {
    throw new IllegalActionError(`${definition.name} does not target`);
  }

  // Step 4: pay (rule 357.1).
  let next = withPlayer(state, player, (current) => ({
    ...current,
    pool: payFrom(current.pool, cost),
  }));

  const events: GameEvent[] = [];

  // 329.2: the card is Finalized here, whatever its type. Recorded before the
  // split below because a Spell is Finalized onto the Chain and a Permanent
  // onto the Board, and Legion (812.1.c) and "when you play a spell" both count
  // the Finalization rather than the arrival.
  next = withPlayer(next, player, (current) => ({
    ...current,
    playedThisTurn: [...current.playedThisTurn, card],
  }));
  const played: TriggerEventInstance = {
    event: 'played',
    actor: player,
    objects: [card],
    ordinal: getPlayer(next, player).playedThisTurn.length,
    ...(location?.kind === 'battlefield' ? { battlefield: location.index } : {}),
  };

  if (definition.type === 'spell') {
    // 359.3: a Spell lingers on the Chain as a Finalized item.
    next = moveEntity(next, card, playerLocation(player, 'chain'));
    next = {
      ...next,
      chain: [
        ...next.chain,
        {
          entity: card,
          controller: player,
          pending: false,
          target: target ?? null,
          destination: destination ?? null,
          ability: null,
        },
      ],
      passes: 0,
      priority: player,
      // 347.1: acting resets the sequence of passes that would end a Showdown.
      ...(next.showdown === null ? {} : { showdown: { ...next.showdown, passes: 0 } }),
    };
    events.push(
      { type: 'cardPlayed', player, entity: card, onChain: true },
      { type: 'chainItemAdded', entity: card, controller: player },
    );
    // A Spell has no Play Effect of its own (383.4.a is about Permanents), but
    // "when you play a spell" watches this same moment. The trigger goes on the
    // Chain above the Spell and so resolves before it.
    next = queueTriggers(next, triggersFor(next, played), events);
    return { state: next, events };
  }

  // 359.2: a Permanent leaves the Chain and becomes a Game Object at once.
  const entersAt = resolvePermanentLocation(next, player, definition, location);
  next = moveEntity(next, card, entersAt);
  // 359.2.c: a Unit enters exhausted; 359.2.d: Gear enters ready at the Base.
  next = withEntity(next, card, (current) => ({
    ...current,
    exhausted: definition.type === 'unit',
  }));

  events.push({ type: 'cardPlayed', player, entity: card, onChain: false });

  // 359.2.b: execute all rules text on the card, top to bottom.
  if (effect !== undefined) {
    next = executeEffect(
      next,
      { controller: player, source: card, choices: { target, destination } },
      effect,
      events,
      EFFECT_CONTEXT,
    );
  }

  // 383.4.a.2: Play Effects go on the Chain as Pending Items once the Permanent
  // has been finalized and entered the Board — that is, right here. The same
  // event also reaches everything else watching, which is what makes "when you
  // play another unit" work.
  next = queueTriggers(
    next,
    triggersFor(next, {
      ...played,
      ...(entersAt.kind === 'battlefield' ? { battlefield: entersAt.index } : {}),
    }),
    events,
  );

  return { state: next, events };
}

/**
 * Activate an Activated Ability (rule 377.3).
 *
 * The ability goes on the Chain with no card to represent it (377.3.a.1), so
 * the source stays exactly where it is and only the *cost* touches it. Like a
 * Spell, it then waits for every player to pass before resolving.
 */
function activateAbility(
  state: GameState,
  source: EntityId,
  index: number,
  target: EntityId | undefined,
  destination: Location | undefined,
): ReduceResult {
  const player = requirePriority(state);
  const available = activatableAbilities(state, player);
  const chosen = available.find(
    (candidate: { source: EntityId; index: number }) =>
      candidate.source === source && candidate.index === index,
  );

  if (chosen === undefined) {
    throw new IllegalActionError(
      `Ability ${index} of ${source} cannot be activated by player ${player} now`,
    );
  }
  if (!isValidTarget(state, player, chosen.ability.effect.target, target)) {
    throw new IllegalActionError(`Ability ${index} of ${source} has no valid target ${String(target)}`);
  }

  const events: GameEvent[] = [];
  let next = state;

  // 377 / 404: pay the Total Cost, which rule 403 has already modified.
  // Exhausting the source is part of it when printed (414).
  next = withPlayer(next, player, (current) => ({
    ...current,
    pool: payFrom(current.pool, chosen.cost),
  }));
  if (chosen.ability.exhaustSelf === true) {
    next = withEntity(next, source, (current) => ({ ...current, exhausted: true }));
  }

  next = {
    ...next,
    chain: [
      ...next.chain,
      {
        entity: source,
        controller: player,
        pending: false,
        target: target ?? null,
        destination: destination ?? null,
        ability: { kind: 'activated', index },
      },
    ],
    passes: 0,
    priority: player,
    ...(next.showdown === null ? {} : { showdown: { ...next.showdown, passes: 0 } }),
  };

  events.push(
    { type: 'abilityActivated', player, source, index },
    { type: 'chainItemAdded', entity: source, controller: player },
  );

  // "When you use an activated ability of a gear" (377.3): the activation is
  // the event, so this fires whether or not the ability ever resolves. The
  // source is the object, which is what a `cardType` filter reads.
  next = queueTriggers(
    next,
    triggersFor(next, { event: 'activateAbility', actor: player, objects: [source] }),
    events,
  );
  return { state: next, events };
}

/**
 * Perform or decline a "you may" Triggered Ability (rule 383.3.a).
 *
 * Declining removes it from the Chain without effect (383.3.e.2.b). Performing
 * resolves it immediately: the choice happens at finalization, after which the
 * ability is an ordinary Chain item that has already been passed on.
 */
function resolveTrigger(state: GameState, perform: boolean): ReduceResult {
  const player = requirePriority(state);
  const top = state.chain[state.chain.length - 1];

  if (top === undefined || !top.pending) {
    throw new IllegalActionError('No Triggered Ability is waiting to be finalized');
  }
  if (top.controller !== player) {
    throw new IllegalActionError(`Player ${player} does not control the pending Triggered Ability`);
  }

  const events: GameEvent[] = [];
  const chain = state.chain.slice(0, -1);

  if (!perform) {
    events.push({ type: 'triggerDeclined', player, source: top.entity });
    return {
      state: { ...state, chain, passes: 0, priority: chainPriority(state, chain) },
      events,
    };
  }

  // Finalized: it stops being pending and waits on the Chain like any item.
  const finalized: ChainItem = { ...top, pending: false };
  return {
    state: {
      ...state,
      chain: [...chain, finalized],
      passes: 0,
      priority: state.activePlayer,
    },
    events,
  };
}

/** Priority after an item leaves the Chain (rule 312.2.a, 312.2.c). */
function chainPriority(state: GameState, chain: readonly ChainItem[]): PlayerId | null {
  const top = chain[chain.length - 1];
  return top === undefined ? afterChainPriority(state) : top.controller;
}

/**
 * Who holds Priority once the Chain is empty.
 *
 * Normally the Turn Player, the state having Opened (312.2.a). But a phase that
 * held itself open for a Triggered Ability is now free to finish: nobody has
 * Priority outside the Main Phase, so handing it back to the phase machine
 * means handing it to nobody, and `legalActions` offers `resolvePhase` again.
 */
function afterChainPriority(state: GameState): PlayerId | null {
  return state.phase === 'main' ? state.activePlayer : null;
}

/**
 * Put newly triggered abilities on the Chain (rule 383.3).
 *
 * An optional ability goes on as a *pending* item, because 383.3.a makes
 * performing it a choice its controller takes at finalization. A mandatory one
 * is finalized straight away.
 */
function queueTriggers(
  state: GameState,
  pending: readonly PendingTrigger[],
  events: GameEvent[],
): GameState {
  if (pending.length === 0) {
    return state;
  }

  let next = state;
  for (const trigger of pending) {
    const ability = abilityFor(next, trigger.source, trigger.ability);
    if (ability === undefined) {
      continue;
    }
    const optional = 'optional' in ability && ability.optional === true;

    next = {
      ...next,
      chain: [
        ...next.chain,
        {
          entity: trigger.source,
          controller: trigger.controller,
          pending: optional,
          // Triggered abilities choose their target on resolution rather than
          // on the way onto the Chain, so nothing is carried here yet.
          target: null,
          destination: null,
          ability: trigger.ability,
        },
      ],
      passes: 0,
    };
    events.push({
      type: 'abilityTriggered',
      player: trigger.controller,
      source: trigger.source,
      index: trigger.ability.index,
    });
  }

  // 312.2.c: Priority sits with the controller of the top Chain item; a pending
  // item needs its controller to finalize it before anyone else can act.
  const top = next.chain[next.chain.length - 1];
  return { ...next, priority: top?.controller ?? next.activePlayer };
}

/**
 * The Mulligan (rule 117).
 *
 * 117.1 sets aside up to two cards, 117.2 draws that many, and only then 117.3
 * Recycles the set-aside cards to the bottom of the Main Deck. The order is
 * load-bearing: drawing first is what stops a player redrawing the very cards
 * they just put back.
 */
function mulligan(state: GameState, cards: readonly EntityId[]): ReduceResult {
  if (state.phase !== 'mulligan') {
    throw new IllegalActionError('The Mulligan happens during setup only (rule 117)');
  }

  const player = requirePriority(state);
  const limit = state.config.mulliganLimit;

  if (cards.length > limit) {
    throw new IllegalActionError(`A Mulligan sets aside at most ${limit} cards (rule 117.1)`);
  }
  if (new Set(cards).size !== cards.length) {
    throw new IllegalActionError('The same card cannot be set aside twice');
  }
  for (const card of cards) {
    if (!zoneOf(state, player, 'hand').includes(card)) {
      throw new IllegalActionError(`Card ${card} is not in player ${player}'s hand`);
    }
  }

  const events: GameEvent[] = [{ type: 'mulliganed', player, setAside: [...cards] }];
  let next = state;

  // 117.1: set the chosen cards aside, out of hand.
  for (const card of cards) {
    next = moveEntity(next, card, playerLocation(player, 'chain'));
  }

  // 117.2: draw as many as were set aside.
  const drawn = drawCards(next, player, cards.length, events);
  next = drawn.state;

  // 117.3: Recycle the set-aside cards to the bottom of the Main Deck (416.1.a).
  for (const card of cards) {
    next = moveEntity(next, card, playerLocation(player, 'mainDeck'), 'bottom');
  }

  const taken = next.mulligansTaken + 1;
  if (taken < next.players.length) {
    const upcoming = nextPlayer(next, player);
    return {
      state: { ...next, mulligansTaken: taken, activePlayer: upcoming, priority: upcoming },
      events,
    };
  }

  // 118: begin play with the First Player taking their turn.
  events.push({
    type: 'phaseEntered',
    turn: next.turn,
    player: next.firstPlayer,
    phase: 'awaken',
  });
  return {
    state: {
      ...next,
      mulligansTaken: taken,
      phase: 'awaken',
      activePlayer: next.firstPlayer,
      priority: null,
    },
    events,
  };
}

/**
 * What `effects.ts` needs from here.
 *
 * Both reach machinery the interpreter deliberately does not import: drawing
 * can cause a Burn Out (431), and a Kill Instruction has to put the dying
 * Unit's Deathknell on the Chain while it is still on the Board (428.1.a.1.b).
 */
const EFFECT_CONTEXT: EffectContext = {
  drawCards: (state, player, count, events) => drawCards(state, player, count, events).state,
  queueDeaths: (state, units, events) => queueDeaths(state, units, events),
  afterMove: (state, player, to, units, events) =>
    afterMove(state, player, to, events, units),
  raise: (state, instance, events) => queueTriggers(state, triggersFor(state, instance), events),
};

/**
 * Queue the death triggers for a set of Units (rule 428).
 *
 * One event per Unit rather than one for the batch: 383.2 makes each death its
 * own event, and "when a friendly unit dies" has to see each of them. The dying
 * Units are named as extra sources because a corpse is no longer on the Board
 * and would otherwise never be asked about its own Deathknell.
 */
function queueDeaths(
  state: GameState,
  units: readonly EntityId[],
  events: GameEvent[],
): GameState {
  let next = state;
  for (const unit of units) {
    const location = next.entities[unit]?.location;
    next = queueTriggers(
      next,
      triggersFor(
        next,
        {
          event: 'dies',
          actor: next.entities[unit]?.controller ?? next.activePlayer,
          objects: [unit],
          ...(location?.kind === 'battlefield' ? { battlefield: location.index } : {}),
        },
        { extraSources: [unit] },
      ),
      events,
    );
  }
  return next;
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

  // Rule 347.2: with a Showdown open and no Chain, passing passes Focus.
  if (!isClosed(state) && state.showdown !== null) {
    const events: GameEvent[] = [{ type: 'priorityPassed', player }];
    const passes = state.showdown.passes + 1;

    // 347.2.a: everyone having passed once in sequence ends the Showdown.
    if (passes >= state.players.length) {
      return closeShowdown(state, events);
    }

    const nextFocus = nextPlayer(state, player);
    return {
      state: {
        ...state,
        showdown: { ...state.showdown, focus: nextFocus, passes },
        priority: nextFocus,
      },
      events,
    };
  }

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

  let next = state;

  if (top.ability !== null) {
    // 377.3.b.3 / 383.3: an ability resolves by executing its effect. It has no
    // card on the Chain (377.3.a.1), so its source stays exactly where it is —
    // the one place an ability differs from a Spell on resolution.
    const ability = abilityFor(next, top.entity, top.ability);
    if (ability !== undefined) {
      next = executeEffect(
        next,
        {
          controller: top.controller,
          // 377.3.a.1: the ability has no card on the Chain, so "me" is the
          // Game Object the ability is printed on.
          source: top.entity,
          choices: { target: top.target ?? undefined, destination: top.destination ?? undefined },
        },
        ability.effect,
        events,
        EFFECT_CONTEXT,
      );
      if (top.ability.kind === 'triggered') {
        // 383.3.e: count it against any "N times each turn" limit.
        const key = triggerKey(top.entity, top.ability.index);
        next = {
          ...next,
          triggersUsed: { ...next.triggersUsed, [key]: (next.triggersUsed[key] ?? 0) + 1 },
        };
      }
    }
  } else {
    // 359.3.d: execute the Spell's rules text, then put the card in the trash.
    const spell = entityCard(next, top.entity);
    const spellEffect = effectOf(spell);
    if (spellEffect !== undefined) {
      next = executeEffect(
        next,
        {
          controller: top.controller,
          source: top.entity,
          choices: { target: top.target ?? undefined, destination: top.destination ?? undefined },
        },
        spellEffect,
        events,
        EFFECT_CONTEXT,
      );
    }
    next = moveEntity(next, top.entity, playerLocation(top.controller, 'trash'));
  }
  const chain = state.chain.slice(0, -1);
  const nextTop = chain[chain.length - 1];

  if (nextTop === undefined && state.showdown !== null) {
    // 346: when the last Chain item resolves during a Showdown, Focus passes
    // and the next player gains both Focus and Priority.
    const nextFocus = nextPlayer(state, state.showdown.focus);
    next = {
      ...next,
      chain,
      passes: 0,
      showdown: { ...state.showdown, focus: nextFocus, passes: 0 },
      priority: nextFocus,
    };
  } else {
    next = {
      ...next,
      chain,
      passes: 0,
      // 312.2.c: Priority goes to the controller of the next item; with an empty
      // Chain the state Opens and the Turn Player acts again (312.2.a).
      priority: nextTop === undefined ? afterChainPriority(state) : nextTop.controller,
    };
    if (nextTop === undefined) {
      // 344.2 opens a Showdown only in a Neutral *Open* state, so an effect
      // that Contested a Battlefield while the Chain was up could not open one
      // then. The Chain has just emptied, which is that Cleanup: check now, or
      // the Battlefield stays Contested forever with nobody taking Control.
      next = openShowdown(next, events);
    }
  }

  events.push({ type: 'chainItemResolved', entity: top.entity });
  return { state: next, events };
}

/**
 * The Standard Move (rule 144).
 *
 * Exhausting each Unit is the cost (144.2), and several Units may move together
 * to a shared destination as one action (144.3). Moving is instantaneous, uses
 * no Chain and cannot be Reacted to (446.3), so this resolves in full and then
 * performs the Move's Cleanup (453).
 */
function moveUnits(
  state: GameState,
  units: readonly EntityId[],
  to: Location,
): ReduceResult {
  const player = requirePriority(state);

  if (units.length === 0) {
    throw new IllegalActionError('A Move needs at least one Unit');
  }
  if (new Set(units).size !== units.length) {
    throw new IllegalActionError('A Unit cannot move twice in the same Move');
  }

  for (const unit of units) {
    if (getEntity(state, unit).controller !== player) {
      throw new IllegalActionError(`Player ${player} does not control unit ${unit}`);
    }
    if (!canStandardMove(state, unit)) {
      throw new IllegalActionError(`Unit ${unit} cannot take its Standard Move now`);
    }
    if (!standardMoveDestinations(state, unit).some((candidate) => sameLocation(candidate, to))) {
      throw new IllegalActionError(`Unit ${unit} cannot move there`);
    }
  }

  let next = state;
  for (const unit of units) {
    // 144.2: exhausting the Unit is the cost, paid simultaneously (144.3.c).
    next = withEntity(next, unit, (current) => ({ ...current, exhausted: true }));
    next = moveEntity(next, unit, to);
  }

  const events: GameEvent[] = [
    {
      type: 'unitsMoved',
      player,
      units: [...units],
      battlefield: to.kind === 'battlefield' ? to.index : null,
    },
  ];

  return { state: afterMove(next, player, to, events, units), events };
}

/**
 * Everything a Move does once the Permanents have changed location.
 *
 * Shared by the Standard Move and by `move` effects, because rules 450-453
 * apply to a Move however it was caused (449) and duplicating them is how the
 * two paths drift apart.
 */
function afterMove(
  state: GameState,
  player: PlayerId,
  to: Location,
  events: GameEvent[],
  moved: readonly EntityId[] = [],
): GameState {
  let next = state;

  // 450: the destination becomes Contested if its controller is someone else.
  if (to.kind === 'battlefield') {
    const contestedBefore = next.battlefields[to.index]?.contestedBy ?? null;
    next = applyContested(next, to.index, player);
    if (contestedBefore === null && next.battlefields[to.index]?.contestedBy === player) {
      events.push({ type: 'battlefieldContested', battlefield: to.index, player });
    }
  }

  // 453: a Move is followed by a Cleanup.
  const before = next.battlefields;
  next = cleanupControl(next);
  next.battlefields.forEach((battlefield, index) => {
    const previous = before[index];
    if (previous?.controller !== null && previous?.controller !== undefined && battlefield.controller === null) {
      events.push({ type: 'controlLost', battlefield: index, player: previous.controller });
    }
  });

  // 383.2: the Move itself is an event. Raised after the Cleanup so a "when I
  // move" trigger sees settled Control, and before the Showdown opens so the
  // trigger is on the Chain when it does.
  for (const unit of moved) {
    next = queueTriggers(
      next,
      triggersFor(next, {
        event: 'move',
        actor: player,
        objects: [unit],
        ...(to.kind === 'battlefield' ? { battlefield: to.index } : {}),
      }),
      events,
    );
  }

  // 344.2: a Contested Battlefield with only one player's Units present opens a
  // Showdown in the next Cleanup.
  return openShowdown(next, events);
}

/**
 * Open a Non-Combat Showdown if one is due (rule 344).
 *
 * 344.2: Control is Contested, there are no Units from different players, and
 * the turn is Neutral Open. 345: the contesting player gains Focus.
 */
function openShowdown(state: GameState, events: GameEvent[]): GameState {
  if (state.showdown !== null || isClosed(state)) {
    return state;
  }

  const index = state.battlefields.findIndex((battlefield) => battlefield.contestedBy !== null);
  if (index < 0) {
    return state;
  }
  const battlefield = state.battlefields[index] as BattlefieldState;
  const contestedBy = battlefield.contestedBy as PlayerId;

  const controllers = new Set(
    battlefield.units.map((unit) => getEntity(state, unit).controller),
  );
  // 344.1: opposing Units make this a Combat Showdown, which runs the Steps of
  // Combat. Not implemented, so refuse rather than resolve it wrongly.
  // 344.1 / 461: opposing Units make this a Combat Showdown.
  const combat = controllers.size > 1;

  // 464.2.c: the Attacker is whoever applied Contested; the Defender is the
  // other player. 464.2.d: the Attacker gains Focus.
  let attacker: PlayerId | null = null;
  let defender: PlayerId | null = null;
  if (combat) {
    attacker = contestedBy;
    defender =
      [...controllers].find((candidate) => candidate !== contestedBy) ?? null;
    if (defender === null) {
      throw new Error('A Combat Showdown needs two opposing players');
    }
    events.push({ type: 'combatOpened', battlefield: index, attacker, defender });
  }

  events.push({ type: 'showdownOpened', battlefield: index, focus: contestedBy });

  return {
    ...state,
    showdown: { battlefield: index, focus: contestedBy, passes: 0, combat, attacker, defender },
    priority: contestedBy,
    passes: 0,
  };
}

/**
 * Close a Non-Combat Showdown (rule 348.2).
 *
 * If exactly one player's Units remain and they do not already Control the
 * Battlefield, they establish Control — which is a Conquer if they have not yet
 * Scored it this turn (348.2.a.1).
 */
function closeShowdown(state: GameState, events: GameEvent[]): ReduceResult {
  const showdown = state.showdown;
  if (showdown === null) {
    return { state, events };
  }

  const index = showdown.battlefield;
  const battlefield = state.battlefields[index] as BattlefieldState;
  const controllers = new Set(
    battlefield.units.map((unit) => getEntity(state, unit).controller),
  );

  events.push({ type: 'showdownClosed', battlefield: index });

  // 348.1: a Combat Showdown proceeds with the remaining Steps of Combat.
  if (showdown.combat && showdown.attacker !== null && showdown.defender !== null) {
    return resolveCombat(state, index, showdown.attacker, showdown.defender, events);
  }

  let next: GameState = { ...state, showdown: null, priority: state.activePlayer, passes: 0 };

  const claimant = controllers.size === 1 ? [...controllers][0] : undefined;
  if (claimant === undefined || battlefield.controller === claimant) {
    // Nobody establishes Control; the Contested status lifts in the Cleanup.
    return { state: cleanupControl(next), events };
  }

  next = withBattlefield(next, index, (current) => ({
    ...current,
    controller: claimant,
    contestedBy: null,
  }));
  events.push({ type: 'controlEstablished', battlefield: index, player: claimant });

  return conquer(next, index, claimant, events);
}

/**
 * Scoring by Conquer (rules 469.1, 471).
 *
 * 470: at most one Score per Battlefield per turn.
 * 471.1.b: a Conquer that would take a player to the Victory Score only scores
 * if they have Scored *every* Battlefield this turn; otherwise they draw a card
 * instead. This restriction applies to Conquer alone — 471.1.a.1 exempts points
 * from every other source, which is why a Hold has no such condition.
 */
function conquer(
  state: GameState,
  index: number,
  player: PlayerId,
  events: GameEvent[],
): ReduceResult {
  const battlefield = state.battlefields[index] as BattlefieldState;
  if (battlefield.scoredBy.includes(player)) {
    return { state, events };
  }

  let next = markScored(state, index, player);

  const onTheBrink = getPlayer(next, player).points >= next.config.victoryScore - 1;
  const scoredEverywhere = next.battlefields.every((candidate) =>
    candidate.scoredBy.includes(player),
  );

  if (onTheBrink && !scoredEverywhere) {
    // 471.1.b.1: no point; the player draws a card instead.
    events.push({ type: 'finalPointDenied', player, battlefield: index });
    const drawn = drawCards(next, player, 1, events);
    if (drawn.outcome !== null) {
      events.push({ type: 'gameEnded', outcome: drawn.outcome });
      return { state: { ...drawn.state, outcome: drawn.outcome }, events };
    }
    return { state: drawn.state, events };
  }

  next = addPoints(next, player, 1);
  events.push({
    type: 'pointsScored',
    player,
    battlefield: index,
    amount: 1,
    total: getPlayer(next, player).points,
    method: 'conquer',
  });

  const won = checkVictory(next);
  if (won !== null) {
    events.push({ type: 'gameEnded', outcome: won });
    return { state: { ...next, outcome: won }, events };
  }

  // "When you conquer here": the Conquer has been processed, so the Trigger's
  // Condition can be evaluated (383.2.c). The Battlefield is carried so a
  // `here` filter can tell this Conquer from one somewhere else.
  next = queueTriggers(
    next,
    triggersFor(next, { event: 'conquer', actor: player, battlefield: index }),
    events,
  );

  return { state: next, events };
}

function withBattlefield(
  state: GameState,
  index: number,
  update: (battlefield: BattlefieldState) => BattlefieldState,
): GameState {
  const battlefields = state.battlefields.slice();
  battlefields[index] = update(battlefields[index] as BattlefieldState);
  return { ...state, battlefields };
}

/**
 * The Combat Damage Step and Resolution Step (rules 465-466).
 *
 * Damage is summed per side, assigned among the *other* side's Units, and dealt
 * simultaneously — there is no Might comparison anywhere in this. The result
 * then falls out of who still has Units at the Battlefield.
 */
function resolveCombat(
  state: GameState,
  index: number,
  attacker: PlayerId,
  defender: PlayerId,
  events: GameEvent[],
): ReduceResult {
  let next: GameState = { ...state, showdown: null, priority: state.activePlayer, passes: 0 };

  const sides = combatSides(next, index, attacker, defender);

  // 464.2.c: the designations, which Assault (807.1.d) and Shield (814.1.d) are
  // conditioned on. Held for the whole resolution because Might is both the
  // damage dealt and the damage survived, so the Cleanup's death check has to
  // use the same numbers the assignment did.
  const roleOf = new Map<EntityId, CombatRole>();
  for (const unit of sides.attackingUnits) {
    roleOf.set(unit, 'attacker');
  }
  for (const unit of sides.defendingUnits) {
    roleOf.set(unit, 'defender');
  }

  // 465.1: damage only happens if both sides still have Units present.
  if (sides.attackingUnits.length > 0 && sides.defendingUnits.length > 0) {
    const attackerMight = sumMight(next, sides.attackingUnits, 'attacker');
    const defenderMight = sumMight(next, sides.defendingUnits, 'defender');

    // 465.2.c: the Attacker assigns first, but assignment is not dealing —
    // both assignments are computed against the pre-damage board and then dealt
    // together (465.2.c.1.a).
    const onDefenders = assignDamage(next, attackerMight, sides.defendingUnits, 'defender');
    const onAttackers = assignDamage(next, defenderMight, sides.attackingUnits, 'attacker');

    const assigned: { unit: EntityId; damage: number }[] = [];
    for (const [unit, damage] of [...onDefenders, ...onAttackers]) {
      assigned.push({ unit, damage });
      next = withEntity(next, unit, (current) => ({
        ...current,
        damage: current.damage + damage,
      }));
    }

    events.push({
      type: 'combatDamage',
      battlefield: index,
      attackerMight,
      defenderMight,
      assigned,
    });
  }

  // 428.4 / 466.1: the Combat Cleanup kills Units with lethal damage, then
  // heals the survivors.
  const killed: EntityId[] = [];
  for (const unit of next.battlefields[index]?.units ?? []) {
    if (hasLethalDamage(next, unit, roleOf.get(unit))) {
      killed.push(unit);
    }
  }
  for (const unit of killed) {
    const owner = getEntity(next, unit).owner;
    next = moveEntity(next, unit, playerLocation(owner, 'trash'));
    // 705: a Unit leaving play loses its Buffs, along with the damage and the
    // turn's Might modifiers, none of which mean anything off the Board.
    next = withEntity(next, unit, (current) => ({
      ...current,
      damage: 0,
      exhausted: false,
      mightBonus: 0,
      buffs: 0,
    }));
  }
  if (killed.length > 0) {
    events.push({ type: 'unitsKilled', units: killed });
    // 383.2.c: a Trigger's Condition is evaluated after the inciting event has
    // been processed, so the deaths are already resolved when these fire.
    //
    // Note this is *after* the move to the trash, unlike a Kill Instruction:
    // 428.1.a.1.b puts the Deathknell on the Chain before the Unit leaves the
    // Board, but that rule is about Active Kills. Death by lethal damage is a
    // Passive Kill (428.1.a.2), which 383.2.c handles the ordinary way.
    next = queueDeaths(next, killed, events);
  }

  // 466.1.a.1: heal all Units.
  for (const unit of next.battlefields[index]?.units ?? []) {
    next = withEntity(next, unit, (current) => ({ ...current, damage: 0 }));
  }

  const after = combatSides(next, index, attacker, defender);
  const defenderHasUnits = after.defendingUnits.length > 0;

  // 466.1.a.2: Recall surviving Attackers if any Defender is still present.
  let attackersRecalled = false;
  if (defenderHasUnits && after.attackingUnits.length > 0) {
    attackersRecalled = true;
    for (const unit of after.attackingUnits) {
      // A Recall is not a Move, and leaves damage and statuses alone (458.1).
      next = moveEntity(next, unit, playerLocation(attacker, 'base'));
    }
    events.push({ type: 'unitsRecalled', units: after.attackingUnits });
  }

  const settled = combatSides(next, index, attacker, defender);
  const result = combatResult(
    settled.attackingUnits.length > 0,
    settled.defendingUnits.length > 0,
    attackersRecalled,
    settled,
  );

  events.push({
    type: 'combatResolved',
    battlefield: index,
    winner: result.kind === 'won' ? result.winner : null,
    reason: result.kind === 'won' ? 'units remaining' : result.reason,
  });

  // "When I win a combat" / "when you win a combat" (466.3).
  //
  // One event carrying every surviving Unit on the winning side, which is what
  // `objects` is a list for: "When I win a combat" has to match each of them,
  // while "when you win a combat" must fire once for the Combat rather than
  // once per survivor.
  if (result.kind === 'won') {
    const survivors =
      result.winner === attacker ? settled.attackingUnits : settled.defendingUnits;
    next = queueTriggers(
      next,
      triggersFor(next, {
        event: 'winCombat',
        actor: result.winner,
        objects: survivors,
        battlefield: index,
      }),
      events,
    );
  }

  // 466.5: establish Control, clearing Contested (466.5.a). With nobody left
  // the Battlefield becomes Uncontrolled (466.5.b).
  next = withBattlefield(next, index, (current) => ({ ...current, contestedBy: null }));

  const holders = new Set(
    (next.battlefields[index]?.units ?? []).map((unit) => getEntity(next, unit).controller),
  );
  const claimant = holders.size === 1 ? [...holders][0] : undefined;

  if (claimant === undefined) {
    if (holders.size === 0) {
      next = withBattlefield(next, index, (current) => ({ ...current, controller: null }));
    }
    return { state: next, events };
  }

  if (next.battlefields[index]?.controller === claimant) {
    return { state: next, events };
  }

  next = withBattlefield(next, index, (current) => ({ ...current, controller: claimant }));
  events.push({ type: 'controlEstablished', battlefield: index, player: claimant });

  // 466.5.d: establishing Control is a Conquer.
  return conquer(next, index, claimant, events);
}

function requirePriority(state: GameState): PlayerId {
  if (state.priority === null) {
    throw new IllegalActionError('No player has Priority right now');
  }
  return state.priority;
}

function resolvePhase(state: GameState): ReduceResult {
  switch (state.phase) {
    case 'mulligan':
      throw new IllegalActionError(
        'The Mulligan is a choice; take the mulligan action instead (rule 117)',
      );
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

  if (next.phaseStep < 1) {
    // 315.2.a, the Beginning Step: "at the start of your Beginning Phase".
    // These resolve before the Scoring Step, so a trigger that takes Control of
    // a Battlefield changes what is Held below.
    next = queueTriggers(
      next,
      triggersFor(next, { event: 'beginningPhase', actor: player }),
      events,
    );
    if (next.chain.length > 0) {
      return { state: { ...next, phaseStep: 1 }, events };
    }
  }

  // 315.2.b, the Scoring Step. Guarded by the step rather than relying on 470's
  // once-per-turn rule to make a re-run harmless: resuming a held phase must not
  // repeat a completed step, and scoring twice is the exact hazard.
  if (next.phaseStep < 2) {
    const held: number[] = [];
    next.battlefields.forEach((battlefield, index) => {
      if (battlefield.controller !== player || battlefield.scoredBy.includes(player)) {
        return;
      }
      held.push(index);
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

    // "When you hold here" (469.2). One event per Battlefield Held, since the
    // `here` filter is what distinguishes them.
    for (const index of held) {
      next = queueTriggers(
        next,
        triggersFor(next, { event: 'hold', actor: player, battlefield: index }),
        events,
      );
    }
    if (next.chain.length > 0) {
      return { state: { ...next, phaseStep: 2 }, events };
    }
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
  const events: GameEvent[] = [];
  const drawn = drawCards(state, state.activePlayer, state.config.drawPerTurn, events);

  if (drawn.outcome !== null) {
    events.push({ type: 'gameEnded', outcome: drawn.outcome });
    return { state: { ...drawn.state, outcome: drawn.outcome }, events };
  }

  return enterMain(drawn.state, events);
}

/**
 * Draw `count` cards, Burning Out as needed (rules 413.4, 431).
 *
 * Returns an outcome when a Burn Out handed someone the game, since Burn Out
 * points can win outright (431.3.c).
 */
function drawCards(
  state: GameState,
  player: PlayerId,
  count: number,
  events: GameEvent[],
): { readonly state: GameState; readonly outcome: Outcome | null } {
  let next = state;

  for (let i = 0; i < count; i += 1) {
    if (zoneOf(next, player, 'mainDeck').length === 0) {
      const burned = burnOut(next, player);
      next = burned.state;
      events.push(...burned.events);

      const won = checkVictory(next);
      if (won !== null) {
        return { state: next, outcome: won };
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

  return { state: next, outcome: null };
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
  const preEvents: GameEvent[] = [];

  if (next.phaseStep < 1) {
    // 317.1: end-of-turn effects, before the 317.2 Cleanup below.
    next = queueTriggers(
      next,
      triggersFor(next, { event: 'endOfTurn', actor: next.activePlayer }),
      preEvents,
    );
    if (next.chain.length > 0) {
      return { state: { ...next, phaseStep: 1 }, events: preEvents };
    }
  }

  const healed: EntityId[] = [];

  for (const entity of Object.values(next.entities)) {
    if (entity.damage > 0) {
      healed.push(entity.id);
      next = withEntity(next, entity.id, (current) => ({ ...current, damage: 0 }));
    }
    // 317.2.c: all "this turn" effects expire simultaneously.
    if (entity.mightBonus !== 0) {
      next = withEntity(next, entity.id, (current) => ({ ...current, mightBonus: 0 }));
    }
  }

  const events: GameEvent[] = [
    ...preEvents,
    { type: 'turnEnded', player: next.activePlayer },
  ];
  if (healed.length > 0) {
    events.push({ type: 'healed', entities: healed });
  }

  // 317.2.e: every Rune Pool empties again at the end of the turn.
  next = emptyPools(next, events);
  // 383.3.e: "N times each turn" counters reset with the turn.
  next = { ...next, triggersUsed: {} };
  // 812.1.c scopes Legion to "the same turn", so the record of what was
  // Finalized resets here too.
  next = {
    ...next,
    players: next.players.map((seat) => ({ ...seat, playedThisTurn: [] })),
  };

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
      phaseStep: 0,
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
    // Entering a phase always starts at its first step.
    state: { ...state, phase, phaseStep: 0 },
    events: [
      ...events,
      { type: 'phaseEntered', turn: state.turn, player: state.activePlayer, phase },
    ],
  };
}
