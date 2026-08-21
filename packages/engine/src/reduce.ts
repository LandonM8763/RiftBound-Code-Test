import {
  FREE,
  effectOf,
  isMandatory,
  needsTargetChoice,
  type AdditionalCost,
  type ActivatedAbility,
  type CardDefinition,
  type CardType,
  type CostPayment,
  type TriggeredAbility,
  type Cost,
} from '@riftbound/cards';

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
  triggerCostPayable,
  triggerKey,
  triggersFor,
  type PendingTrigger,
  type TriggerEventInstance,
} from './abilities.js';
import {
  executeEffect,
  isValidTarget,
  legalTargets,
  type EffectContext,
} from './effects.js';
import { totalCost } from './costs.js';
import { canPay, payFrom, timingAllows, validUnitLocations } from './play.js';
import { canPayAdditional, payAdditional as performPayment } from './additional.js';
import { moveAttachments } from './attach.js';
import {
  HIDE_COST,
  allowedFromFacedown,
  expireFacedown,
  facedownEntersAt,
  hasHidden,
  hide,
  hideDestinations,
  playableFromFacedown,
  unhide,
} from './hidden.js';
import { entersReady, placeForbidden, playerForbidden } from './statics.js';
import { sendToNonBoardZone } from './token.js';
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
  battlefieldLocation,
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
      return playCard(
        state,
        action.card,
        action.location,
        action.targets,
        action.destination,
        action.payAdditional === true,
      );
    case 'pass':
      return pass(state);
    case 'moveUnits':
      return moveUnits(state, action.units, action.to);
    case 'mulligan':
      return mulligan(state, action.cards);
    case 'hide':
      return hideCard(state, action.card, action.battlefield);
    case 'activateAbility':
      return activateAbility(
        state,
        action.source,
        action.index,
        action.from,
        action.targets,
        action.destination,
      );
    case 'resolveTrigger':
      return resolveTrigger(state, action.perform, action.targets, action.destination);
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

/**
 * 107.3.d: a facedown card whose controller has lost Control of its Battlefield
 * is removed during the next Cleanup.
 *
 * Called at both Cleanup sites rather than folded into `cleanupControl`,
 * because that function lives below this one and returns no events — and 421.4
 * makes the removal a *reveal*, which is exactly the thing worth reporting.
 * "Removed" is read as the trash, following 107.3.b.2, the other rule that
 * empties a Facedown Zone.
 */
function cleanupFacedown(state: GameState, events: GameEvent[]): GameState {
  return expireFacedown(state, (current, card) => {
    const entity = getEntity(current, card);
    events.push({
      type: 'facedownRevealed',
      player: entity.controller,
      card,
      battlefield: getEntity(state, card).hiddenAt ?? -1,
    });
    return moveEntity(current, card, playerLocation(entity.owner, 'trash'));
  });
}

/**
 * Hide a card facedown at a Battlefield (rules 421, 811.1.b).
 *
 * A Discretionary Action of its own rather than a play: 811.1.c.1 says Hide is
 * not a subset of Play, and 811.1.c.2 that it opens no Chain — so nothing goes
 * on the Chain, nobody responds, and Priority does not move.
 */
function hideCard(state: GameState, card: EntityId, battlefield: number): ReduceResult {
  const player = requirePriority(state);
  const entity = getEntity(state, card);

  // 811.1.b: "while this card is in your hand or in your Champion Zone".
  const zone = entity.location;
  const inHand =
    zone.kind === 'player' &&
    zone.player === player &&
    (zone.zone === 'hand' || zone.zone === 'championZone');
  if (entity.controller !== player || !inHand) {
    throw new IllegalActionError(`Entity ${card} is not in ${player}'s hand or Champion Zone`);
  }
  if (!hasHidden(state, card)) {
    throw new IllegalActionError(`${entityCard(state, card).name} does not have Hidden`);
  }
  // 811.1.b: "on your turn during an Open State".
  if (state.activePlayer !== player || isClosed(state) || isShowdown(state)) {
    throw new IllegalActionError('Hiding needs your own turn and an Open State');
  }
  // 107.3.c and 107.3.b: a Battlefield you Control, whose Facedown Zone is empty.
  if (!hideDestinations(state, player).includes(battlefield)) {
    throw new IllegalActionError(`Battlefield ${battlefield} cannot take a hidden card`);
  }
  if (!canPay(getPlayer(state, player).pool, HIDE_COST)) {
    throw new IllegalActionError('Cannot pay the cost to hide');
  }

  let next = withPlayer(state, player, (current) => ({
    ...current,
    pool: payFrom(current.pool, HIDE_COST),
  }));
  next = hide(next, card, battlefield);

  return { state: next, events: [{ type: 'cardHidden', player, battlefield }] };
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
  targets: readonly EntityId[] | undefined,
  destination: Location | undefined,
  payAdditional: boolean,
): ReduceResult {
  const player = requirePriority(state);
  const entity = getEntity(state, card);

  // 811.1.b: a card played from facedown comes out of the Facedown Zone rather
  // than the hand, and 811.1.d restricts what it may choose once it is out.
  const fromFacedown =
    entity.controller === player &&
    sameLocation(entity.location, playerLocation(player, 'facedown'))
      ? entity.hiddenAt
      : undefined;
  if (fromFacedown !== undefined && !playableFromFacedown(state, player).includes(card)) {
    // 811.1.b: "beginning on the next turn" — the turn it went down is not one.
    throw new IllegalActionError(`Entity ${card} was hidden this turn and cannot be played yet`);
  }

  if (
    fromFacedown === undefined &&
    (entity.controller !== player || !sameLocation(entity.location, playerLocation(player, 'hand')))
  ) {
    throw new IllegalActionError(`Entity ${card} is not in ${player}'s hand`);
  }

  const definition = entityCard(state, card);
  const timing = { closed: isClosed(state), showdown: isShowdown(state) };
  // 811.6: a card played from facedown has Reaction, so timing never refuses it.
  if (fromFacedown === undefined && !timingAllows(definition, timing)) {
    throw new IllegalActionError(
      `${definition.name} cannot be played in a ${timing.showdown ? 'Showdown' : 'Neutral'} ` +
        `${timing.closed ? 'Closed' : 'Open'} state`,
    );
  }

  // 356.2: Additional Costs are settled before the Total Cost, because the
  // optional one's declaration changes it (356.2.b.1).
  const additional = definition.abilities?.additionalCosts ?? [];
  const mandatory = additional.filter(isMandatory);
  const optional = additional.filter((entry) => !isMandatory(entry));
  const owed = payAdditional ? [...mandatory, ...optional] : mandatory;

  if (payAdditional && optional.length === 0) {
    throw new IllegalActionError(`${definition.name} has no optional additional cost to pay`);
  }
  // 356.2.a: a Mandatory cost that cannot be paid makes the card unplayable.
  for (const entry of owed) {
    if (!canPayAdditional(state, player, entry.pay, card)) {
      throw new IllegalActionError(
        `Cannot pay the additional cost to play ${definition.name}`,
      );
    }
  }

  // 809.1.c: the chosen Game Object is part of what the card costs, because a
  // Deflect taxes a Spell for choosing the Unit it is printed on.
  //
  // 811.1.b plays a facedown card "ignoring its base cost", so the Base Cost is
  // zero and rule 356's layers run over that — which keeps a Deflect increase
  // (356.3) applying, exactly as 356.1.b.3 says an ignored Base Cost is not a
  // floor.
  const cost =
    fromFacedown === undefined
      ? totalCost(state, player, definition, { paidAdditionalCost: payAdditional }, targets?.[0])
      : totalCost(
          state,
          player,
          { ...definition, cost: FREE } as CardDefinition,
          { paidAdditionalCost: payAdditional },
          targets?.[0],
        );
  if (cost === undefined) {
    throw new IllegalActionError(`${definition.name} is not a playable card`);
  }
  if (!canPay(getPlayer(state, player).pool, withAdditionalResources(cost, owed))) {
    throw new IllegalActionError(`Cannot pay for ${definition.name}`);
  }

  // Step 2 (355.6): targets are chosen now, and step 5 (358.1) checks them.
  const effect = effectOf(definition);
  if (effect !== undefined && !isValidTarget(state, player, effect.target, targets, card)) {
    throw new IllegalActionError(`${definition.name} has no valid target ${String(targets)}`);
  }
  if (effect === undefined && targets !== undefined && targets.length > 0) {
    throw new IllegalActionError(`${definition.name} does not target`);
  }
  // 811.1.d.2: what a card played from facedown chooses must be at the
  // Battlefield it was hidden at.
  if (
    fromFacedown !== undefined &&
    targets !== undefined &&
    targets.some((one) => !allowedFromFacedown(state, fromFacedown, one))
  ) {
    throw new IllegalActionError(
      `${definition.name} was played from facedown and may only choose at that battlefield`,
    );
  }

  // Step 4: pay (rule 357.1).
  let next = withPlayer(state, player, (current) => ({
    ...current,
    pool: payFrom(current.pool, cost),
  }));

  // 421.4: a facedown card leaving its zone is revealed, which here is simply
  // dropping the association — the identity was only concealed while it was in
  // the Facedown Zone, and `moveEntity` below takes it out.
  if (fromFacedown !== undefined) {
    next = unhide(next, card);
  }

  const events: GameEvent[] = [];

  // 357.2: pay the Additional Costs. After the Total Cost so a resource
  // payment comes out of the pool the Total Cost already drew from.
  for (const entry of owed) {
    next = payAdditionalCost(next, player, entry.pay, card, events);
  }
  if (owed.length > 0) {
    events.push({ type: 'additionalCostPaid', player, entity: card, optional: payAdditional });
  }

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
    ...(fromFacedown === undefined ? {} : { fromFacedown: true }),
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
          targets: targets ?? [],
          destination: destination ?? null,
          // 808.1.d.3's note is for a source that leaves the Board before its
          // ability resolves; a played card is on the Chain and has not.
          noted: null,
          // A played card is not a trigger, so there is no "it" to refer to.
          triggerObject: null,
          ability: null,
          // 356.2.b: a Spell resolves off the Chain later, so the declaration
          // has to travel with it — "if you paid the additional cost" is asked
          // at resolution, long after the choice was made.
          ...(payAdditional ? { paidAdditionalCost: true } : {}),
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
    next = raiseEvent(next, played, events);
    next = raiseChosen(next, player, targets, events, definition.type);
    return { state: next, events };
  }

  // 359.2.c: a Unit enters exhausted; 359.2.d: Gear enters ready at the Base.
  // A static saying "I enter ready" replaces 359.2.c (363).
  //
  // Asked *before* the move, which is load-bearing: "Other friendly units enter
  // ready" must not reach the card carrying it, and once that card is on the
  // Board the sweep can no longer tell it apart from the units it is talking
  // about. 359.2.c is about how the card enters, so this is also when the rules
  // ask the question.
  const ready = entersReady(next, player, definition, { paidAdditionalCost: payAdditional });

  // 359.2: a Permanent leaves the Chain and becomes a Game Object at once.
  const entersAt = resolvePermanentLocation(next, player, definition, location, fromFacedown);
  next = moveEntity(next, card, entersAt);
  next = withEntity(next, card, (current) => ({
    ...current,
    exhausted: definition.type === 'unit' && !ready,
  }));

  events.push({ type: 'cardPlayed', player, entity: card, onChain: false });

  // 359.2.b: execute all rules text on the card, top to bottom.
  if (effect !== undefined) {
    next = executeEffect(
      next,
      {
        controller: player,
        source: card,
        choices: { targets, destination },
        paidAdditionalCost: payAdditional,
      },
      effect,
      events,
      EFFECT_CONTEXT,
    );
  }

  // 383.4.a.2: Play Effects go on the Chain as Pending Items once the Permanent
  // has been finalized and entered the Board — that is, right here. The same
  // event also reaches everything else watching, which is what makes "when you
  // play another unit" work.
  next = raiseEvent(
    next,
    { ...played, ...(entersAt.kind === 'battlefield' ? { battlefield: entersAt.index } : {}) },
    events,
  );
  next = raiseChosen(next, player, targets, events, definition.type);

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
  from: EntityId | undefined,
  targets: readonly EntityId[] | undefined,
  destination: Location | undefined,
): ReduceResult {
  const player = requirePriority(state);
  const available = activatableAbilities(state, player);
  const chosen = available.find(
    (candidate) =>
      candidate.source === source && candidate.index === index && candidate.ref.from === from,
  );

  if (chosen === undefined) {
    throw new IllegalActionError(
      `Ability ${index} of ${source} cannot be activated by player ${player} now`,
    );
  }
  if (!isValidTarget(state, player, chosen.ability.effect.target, targets, source)) {
    throw new IllegalActionError(
      `Ability ${index} of ${source} has no valid target ${String(targets)}`,
    );
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
  // 356.7: the non-resource parts of the cost. After the resources, so a
  // payment that also spends from the pool draws on what is left — the same
  // order 357.2 puts an Additional Cost in.
  for (const payment of chosen.ability.payments ?? []) {
    next = payAdditionalCost(next, player, payment, source, events);
  }

  next = {
    ...next,
    chain: [
      ...next.chain,
      {
        entity: source,
        controller: player,
        pending: false,
        noted: null,
        triggerObject: null,
        targets: targets ?? [],
        destination: destination ?? null,
        ability: { ...chosen.ref, kind: 'activated', index },
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
  next = raiseEvent(next, { event: 'activateAbility', actor: player, objects: [source] }, events);
  // 377.3.a.1 puts no card on the Chain for an ability, so nothing chose
  // "with a spell" here.
  next = raiseChosen(next, player, targets, events, undefined);
  return { state: next, events };
}

/**
 * Perform or decline a "you may" Triggered Ability (rule 383.3.a).
 *
 * Declining removes it from the Chain without effect (383.3.e.2.b). Performing
 * resolves it immediately: the choice happens at finalization, after which the
 * ability is an ordinary Chain item that has already been passed on.
 */
function resolveTrigger(
  state: GameState,
  perform: boolean,
  targets: readonly EntityId[] | undefined,
  destination: Location | undefined,
): ReduceResult {
  const player = requirePriority(state);
  const top = state.chain[state.chain.length - 1];

  if (top === undefined || !top.pending) {
    throw new IllegalActionError('No Triggered Ability is waiting to be finalized');
  }
  if (top.controller !== player) {
    throw new IllegalActionError(`Player ${player} does not control the pending Triggered Ability`);
  }

  const ability = top.ability === null ? undefined : abilityFor(state, top.entity, top.ability);
  if (ability === undefined) {
    throw new IllegalActionError('The pending ability no longer exists');
  }

  const events: GameEvent[] = [];
  const chain = state.chain.slice(0, -1);

  if (!perform) {
    // 402.4.b: only a genuine "you may" may be declined. A mandatory ability
    // pauses here to make choices, not to be refused.
    if (!('optional' in ability) || ability.optional !== true) {
      throw new IllegalActionError('This Triggered Ability is not optional and cannot be declined');
    }
    events.push({ type: 'triggerDeclined', player, source: top.entity });
    return {
      state: { ...state, chain, passes: 0, priority: chainPriority(state, chain) },
      events,
    };
  }

  // 402.2: the choices are made now, and 358.1's legality check applies to them
  // exactly as it does to a played card's.
  if (!isValidTarget(state, player, ability.effect.target, targets, top.entity)) {
    throw new IllegalActionError('Invalid target for the Triggered Ability');
  }
  if (!triggerCostPayable(state, player, ability, top.entity)) {
    throw new IllegalActionError('The Triggered Ability`s cost cannot be paid');
  }

  // 403: an ability's cost is paid when the ability is played, and 402.2 is the
  // step of playing where this one is settled — the same place its target is.
  let next = payTriggerCost(state, player, ability, top.entity, events);

  // Finalized: it stops being pending and waits on the Chain like any item,
  // now carrying the choices its controller just made.
  const finalized: ChainItem = {
    ...top,
    pending: false,
    targets: targets ?? [],
    destination: destination ?? null,
  };
  return {
    state: {
      ...next,
      chain: [...chain, finalized],
      passes: 0,
      priority: state.activePlayer,
    },
    events,
  };
}

/** Pay it. Assumes `triggerCostPayable`. */
function payTriggerCost(
  state: GameState,
  player: PlayerId,
  ability: ActivatedAbility | TriggeredAbility,
  source: EntityId,
  events: GameEvent[],
): GameState {
  if (!('condition' in ability)) {
    return state;
  }
  let next = state;
  if (ability.cost !== undefined) {
    const cost = ability.cost;
    next = withPlayer(next, player, (current) => ({ ...current, pool: payFrom(current.pool, cost) }));
  }
  if (ability.exhaustSelf === true) {
    next = withEntity(next, source, (current) => ({ ...current, exhausted: true }));
  }
  // 357.2 puts the non-resource parts after the resources, so a payment that
  // also spends from the pool draws on what is left.
  for (const payment of ability.payments ?? []) {
    next = payAdditionalCost(next, player, payment as CostPayment, source, events);
  }
  return next;
}

/**
 * Is this Score forbidden (rule 002)?
 *
 * Two readings of one restriction, and both are printed: "opponents can't score
 * points" binds a *player* wherever they are, and "players can't score here"
 * binds a *place*. Asked together because a Score always has both.
 */
function scoringForbidden(state: GameState, battlefield: number, player: PlayerId): boolean {
  return (
    playerForbidden(state, player, 'score') || placeForbidden(state, battlefield, player, 'score')
  );
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
/**
 * Announce that something happened (rule 383.2).
 *
 * One function rather than a `queueTriggers(triggersFor(...))` pair at every
 * site, because two things have to happen for every event and splitting them
 * is how one gets forgotten: the Triggered Abilities watching it reach the
 * Chain, *and* the per-turn tally that state predicates read gets incremented.
 */
/**
 * 355.6: announce that Game Objects were chosen as Targets.
 *
 * One event carrying every chosen object rather than one per object, for the
 * reason `winCombat` gives: "when you choose a unit" must fire once for a card
 * that names two, and a per-object event would fire it twice.
 *
 * `actor` is the chooser, which is what `filter.byController` reads for the
 * "when **you** choose me" wording — an opponent choosing the same Unit is a
 * different event and must not fire it.
 */
function raiseChosen(
  state: GameState,
  player: PlayerId,
  targets: readonly EntityId[] | undefined,
  events: GameEvent[],
  /** The type of the card doing the choosing — "with a spell" (355.6). */
  byCardType: CardType | undefined,
): GameState {
  const chosen = (targets ?? []).filter((id) => state.entities[id] !== undefined);
  return chosen.length === 0
    ? state
    : raiseEvent(
        state,
        {
          event: 'chosen',
          actor: player,
          objects: chosen,
          ...(byCardType === undefined ? {} : { byCardType }),
        },
        events,
      );
}

function raiseEvent(
  state: GameState,
  instance: TriggerEventInstance,
  events: GameEvent[],
  options: { readonly extraSources?: readonly EntityId[] | undefined } = {},
): GameState {
  const counted = withPlayer(state, instance.actor, (seat) => ({
    ...seat,
    turnEvents: {
      ...seat.turnEvents,
      [instance.event]: (seat.turnEvents[instance.event] ?? 0) + 1,
    },
  }));
  return queueTriggers(counted, triggersFor(counted, instance, options), events, instance);
}

function queueTriggers(
  state: GameState,
  pending: readonly PendingTrigger[],
  events: GameEvent[],
  /** The event being queued, for 808.1.d.3's noted location. */
  instance: TriggerEventInstance,
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
    const choosesTarget = needsTargetChoice(ability.effect.target);

    // 402.4: an ability with no legal choice available never becomes a
    // Finalized Chain Item — it is removed at step 2 instead. 402.4.a is
    // explicit that this is not the ability being countered, so nothing else
    // observes it; it simply does not go on.
    if (
      choosesTarget &&
      legalTargets(next, trigger.controller, ability.effect.target, trigger.source).length === 0
    ) {
      continue;
    }

    next = {
      ...next,
      chain: [
        ...next.chain,
        {
          entity: trigger.source,
          controller: trigger.controller,
          // 400: an Ability is a Pending Item until it completes the steps of
          // playing. Step 2 (402) is where the "you may" is answered and where
          // targets are chosen, so anything with either to settle waits here.
          // One with neither has nothing to do at step 2 and goes straight on.
          pending: optional || choosesTarget,
          // 402.2 chooses these; until then there is nothing to carry.
          targets: [],
          destination: null,
          ability: trigger.ability,
          // 808.1.d.3: note where the source was, so a Deathknell reading "my
          // battlefield" still has one once the Unit is in the trash.
          noted: instance.battlefield ?? null,
          // The "it" of "when a friendly unit dies, buff it" — recorded now,
          // for the same reason `noted` is: by resolution the event is over.
          triggerObject: trigger.object ?? null,
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
  afterMove: (state, player, to, units, events, origins) =>
    afterMove(state, player, to, events, units, origins),
  raise: (state, instance, events) => raiseEvent(state, instance, events),
};

/**
 * Rule 357.1: an Additional Cost's resources come out of the same Rune Pool as
 * the Total Cost, so affordability is one question about their sum.
 */
function withAdditionalResources(cost: Cost, owed: readonly AdditionalCost[]): Cost {
  let energy = cost.energy;
  let power = [...cost.power];
  for (const entry of owed) {
    if (entry.pay.kind === 'resources') {
      energy += entry.pay.cost.energy;
      power = [...power, ...entry.pay.cost.power];
    }
  }
  return { energy, power };
}

/**
 * Pay one Additional Cost (357.2).
 *
 * The kill and discard payments are handed the reducer's own machinery, because
 * a Kill Instruction has to queue Deathknells before the Unit reaches the trash
 * (428.1.a.1.b) and a Discard is an ordinary effect.
 */
function payAdditionalCost(
  state: GameState,
  player: PlayerId,
  payment: AdditionalCost['pay'],
  source: EntityId,
  events: GameEvent[],
): GameState {
  return performPayment(
    state,
    player,
    payment,
    source,
    (current, unit) => {
      const queued = queueDeaths(current, [unit], events);
      const owner = getEntity(queued, unit).owner;
      events.push({ type: 'unitsKilled', units: [unit] });
      return withEntity(sendToNonBoardZone(queued, unit, playerLocation(owner, 'trash')), unit, (e) => ({
        ...e,
        damage: 0,
        exhausted: false,
        mightBonus: 0,
        grantedKeywords: [],
        buffs: 0,
        stunned: false,
      }));
    },
    (current, who, cards) => {
      let next = current;
      for (const discarded of cards) {
        next = moveEntity(next, discarded, playerLocation(who, 'trash'));
      }
      events.push({ type: 'cardsDiscarded', player: who, cards: [...cards] });
      // 383.2: a Discard is a Discard however it was caused, so "when you
      // discard" watches a cost payment as much as an effect.
      return raiseEvent(next, { event: 'discard', actor: who }, events);
    },
    // 416.1: Recycled Main Deck cards go to the bottom of the Main Deck, and
    // 416.1.c sends each to *its own owner's* deck rather than the recycling
    // player's — which matters the moment an effect puts an opponent's card in
    // a trash.
    (current, who, cards) => {
      let next = current;
      for (const card of cards) {
        const owner = getEntity(next, card).owner;
        next = moveEntity(next, card, playerLocation(owner, 'mainDeck'), 'bottom');
      }
      events.push({ type: 'cardsRecycled', player: who, cards: [...cards] });
      return next;
    },
  );
}

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
  /**
   * 808.1.d.3's noted location, for the Passive Kill path.
   *
   * A Kill Instruction queues before the move (428.1.a.1.b), so the Unit's own
   * location is still the Board and this is not needed. Death by lethal damage
   * queues *after* it, where 359.3.e.12 leaves the corpse with no location at
   * all — so the Battlefield has to be named by the caller that still knows it.
   */
  at?: number | undefined,
): GameState {
  let next = state;
  for (const unit of units) {
    const location = at !== undefined ? battlefieldLocation(at) : next.entities[unit]?.location;
    next = raiseEvent(
      next,
      {
        event: 'dies',
        actor: next.entities[unit]?.controller ?? next.activePlayer,
        objects: [unit],
        ...(location?.kind === 'battlefield' ? { battlefield: location.index } : {}),
      },
      events,
      { extraSources: [unit] },
    );
  }
  return next;
}

function resolvePermanentLocation(
  state: GameState,
  player: PlayerId,
  definition: CardDefinition,
  location: Location | undefined,
  /** 811.1.d.1: the Battlefield a facedown Permanent must enter at. */
  fromFacedown?: number | undefined,
): Location {
  if (fromFacedown !== undefined) {
    const forced = facedownEntersAt(definition, fromFacedown);
    if (forced !== undefined) {
      // 811.1.d.1.a is explicit that this overrides the rule keeping Gear at a
      // Base, so it is applied before that rule rather than after it.
      return battlefieldLocation(forced);
    }
  }
  if (definition.type !== 'unit') {
    // 359.2.d: non-Unit Gear always enters at the player's Base.
    return playerLocation(player, 'base');
  }
  // 355.2.b: the card itself may widen where it is Valid to play — "You may
  // play me to an open battlefield".
  const allowed = validUnitLocations(state, player, definition);
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
          choices: { targets: top.targets, destination: top.destination ?? undefined },
          // 808.1.d.3: the Battlefield noted when this trigger was queued, so
          // "at my battlefield" still names one after the source has died.
          ...(top.noted === null ? {} : { noted: top.noted }),
          // The "it" of "when a friendly unit dies, buff it".
          ...(top.triggerObject === null ? {} : { triggerObject: top.triggerObject }),
        },
        ability.effect,
        events,
        EFFECT_CONTEXT,
      );
      if (top.ability.kind === 'triggered') {
        // 383.3.e: count it against any "N times each turn" limit.
        const key = triggerKey(top.entity, top.ability.index, top.ability.from);
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
          choices: { targets: top.targets, destination: top.destination ?? undefined },
          // 356.2.b: the declaration was made when the Spell was played, and
          // rode the Chain to here.
          paidAdditionalCost: top.paidAdditionalCost === true,
        },
        spellEffect,
        events,
        EFFECT_CONTEXT,
      );
    }
    next = sendToNonBoardZone(next, top.entity, playerLocation(top.controller, 'trash'));
  }
  // Rebuild from `next.chain`, not from `state.chain`. 383.3.c puts a
  // Triggered Ability on the Chain *as the item that woke it resolves* — a
  // Deathknell from a Kill Instruction, "when you buff" from a Buff, "when you
  // stun" from a Stun — and those land after the resolving item. Slicing the
  // pre-resolution copy discarded every one of them: the ability fired, the
  // event was reported, and nothing ever resolved.
  //
  // Found by *identity*, not by index. `queueTriggers` only appends, so the
  // index would normally still be right — but a Counter (425) clears an item
  // from anywhere on the Chain, which shifts everything above it. Chain items
  // are never mutated in place, so the resolving one is the same object.
  const resolvedAt = next.chain.indexOf(top);
  const chain =
    resolvedAt < 0
      ? [...next.chain]
      : [...next.chain.slice(0, resolvedAt), ...next.chain.slice(resolvedAt + 1)];
  const nextTop = chain[chain.length - 1];

  // Read the Showdown back off `next`, not off `state`, for the same reason.
  // The item that just resolved may have changed it — a Move can convert a
  // Non-Combat Showdown into a Combat one (316.8.b.1.a).
  const ongoing = next.showdown;
  if (nextTop === undefined && state.showdown !== null && ongoing !== null) {
    // 346: when the last Chain item resolves during a Showdown, Focus passes
    // and the next player gains both Focus and Priority.
    //
    // Except when this resolution opened the Combat: 464.2.d has just given
    // the Attacker Focus, and 464.2.e.1 has "the Attacking player, who has
    // Focus" act first — so passing it on immediately would contradict both.
    const becameCombat = !state.showdown.combat && ongoing.combat;
    const nextFocus = becameCombat ? ongoing.focus : nextPlayer(state, ongoing.focus);
    next = {
      ...next,
      chain,
      passes: 0,
      showdown: { ...ongoing, focus: nextFocus, passes: 0 },
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
  // 446: noted before the move, because afterwards the Unit is at `to`.
  const origins = new Map<EntityId, number>();
  for (const unit of units) {
    const from = getEntity(state, unit).location;
    if (from.kind === 'battlefield') {
      origins.set(unit, from.index);
    }
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

  return { state: afterMove(next, player, to, events, units, origins), events };
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
  /**
   * Where each moved Unit started (446), keyed by id.
   *
   * Passed in because by the time this runs the Unit is already at `to`, so
   * the origin cannot be read off the state — and "when I move **from** a
   * battlefield" is a question about exactly that end of the Move.
   */
  origins: ReadonlyMap<EntityId, number> = new Map(),
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

  // 719.3.a: everything Attached follows its Top-Most Card, and 718.5.c stops
  // it moving separately. Done before the Cleanup so Control is settled with
  // the attachments already where they belong.
  for (const unit of moved) {
    next = moveAttachments(next, unit, to);
  }

  // 453: a Move is followed by a Cleanup.
  const before = next.battlefields;
  next = cleanupControl(next);
  next = cleanupFacedown(next, events);
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
    next = raiseEvent(
      next,
      {
        event: 'move',
        actor: player,
        objects: [unit],
        ...(to.kind === 'battlefield' ? { battlefield: to.index } : {}),
        ...(origins.get(unit) === undefined ? {} : { origin: origins.get(unit) as number }),
      },
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
  // 316.8.b.1.a: a Non-Combat Showdown that gains an opposing Unit becomes a
  // Combat Showdown in the following Cleanup — this one.
  if (state.showdown !== null) {
    return becomeCombatShowdown(state, events);
  }
  if (isClosed(state)) {
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

  const opened: GameState = {
    ...state,
    showdown: { battlefield: index, focus: contestedBy, passes: 0, combat, attacker, defender },
    priority: contestedBy,
    passes: 0,
  };
  // 464.2.c.3 applies the designations once the Showdown exists, so the sweep
  // sees the Combat it is describing.
  return attacker === null || defender === null
    ? opened
    : designateCombatants(opened, index, attacker, defender, events);
}


/**
 * 464.2.c.3: Units at the Contested Battlefield gain the Attacker or Defender
 * designation, and 464.2.e collects whatever that triggered.
 *
 * The Attacker's event is raised first, which is 464.2.e.1's order: "the
 * Attacking player, who has Focus, places Triggered Abilities on the Chain
 * first … followed by the Defending Player".
 *
 * 464.2.c.3.a is not modelled: a Unit that becomes present *after* this moment
 * gains its designation in the following Cleanup, and that later designation
 * raises nothing here. `mightOf` still reads the role off the Showdown, so
 * Assault and Shield are unaffected — only a "when I attack" trigger on a
 * latecomer is missed.
 */
function designateCombatants(
  state: GameState,
  index: number,
  attacker: PlayerId,
  defender: PlayerId,
  events: GameEvent[],
): GameState {
  let next = state;
  for (const player of [attacker, defender]) {
    const units = (next.battlefields[index]?.units ?? []).filter(
      (unit) => getEntity(next, unit).controller === player,
    );
    if (units.length === 0) {
      continue;
    }
    next = raiseEvent(
      next,
      {
        event: player === attacker ? 'attack' : 'defend',
        actor: player,
        objects: units,
        battlefield: index,
      },
      events,
    );
  }
  return next;
}

/**
 * Turn an ongoing Non-Combat Showdown into a Combat Showdown (316.8.b.1.a).
 *
 * Rule 464.1 gives Combat two ways to open. One is a Showdown that opens as a
 * Combat Showdown, which `openShowdown` already handles. The other is this: a
 * Non-Combat Showdown is ongoing and a Unit controlled by a different player
 * becomes present, which 316.8.b.1.a converts "in the following cleanup".
 * Without this the Showdown stayed non-combat and closed by establishing
 * Control, so the two sides never fought.
 *
 * **The Attacker is still whoever applied Contested (464.2.c.1)**, not whoever
 * arrived second. `applyContested` leaves `contestedBy` with the first player
 * to contest, which is what keeps that right.
 */
function becomeCombatShowdown(state: GameState, events: GameEvent[]): GameState {
  const showdown = state.showdown;
  if (showdown === null || showdown.combat) {
    return state;
  }

  const battlefield = state.battlefields[showdown.battlefield];
  if (battlefield === undefined) {
    return state;
  }
  const controllers = new Set(
    battlefield.units.map((unit) => getEntity(state, unit).controller),
  );
  // 461: Combat is Staged only once two opposing players have Units here.
  if (controllers.size <= 1) {
    return state;
  }

  const attacker = battlefield.contestedBy;
  if (attacker === null) {
    return state;
  }
  const defender = [...controllers].find((candidate) => candidate !== attacker);
  if (defender === undefined) {
    return state;
  }

  events.push({
    type: 'combatOpened',
    battlefield: showdown.battlefield,
    attacker,
    defender,
  });

  const escalated: GameState = {
    ...state,
    // 464.2.d, step 3 of the Combat Showdown Step: the Attacker gains Focus.
    //
    // 464.2.c.1.b reads the other way — "the player who has Focus maintains
    // their Focus" when a Showdown was already ongoing — and the two cannot
    // both be the final word. 464.2.d is a numbered Task performed *during* the
    // step, where c.1.b describes the instant the Combat opens, and 464.2.e.1
    // settles it by calling the Attacker "the Attacking player, who has Focus".
    // So c.1.b holds for step 1's start-of-combat effects and step 3 then moves
    // Focus. This engine runs the step atomically, so only the outcome shows.
    showdown: { ...showdown, combat: true, attacker, defender, focus: attacker, passes: 0 },
    priority: attacker,
    passes: 0,
  };
  return designateCombatants(escalated, showdown.battlefield, attacker, defender, events);
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
    return { state: cleanupFacedown(cleanupControl(next), events), events };
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
  // Rule 002: "opponents can't score points", "players can't score here". A
  // forbidden Score does not happen at all, so 470's once-per-turn mark is not
  // set either — the Battlefield stays available for a later turn.
  if (scoringForbidden(state, index, player)) {
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
  next = raiseEvent(next, { event: 'conquer', actor: player, battlefield: index }, events);

  return { state: next, events };
}

function withBattlefield(
  state: GameState,
  index: number,
  update: (battlefield: BattlefieldState) => BattlefieldState,
): GameState {
  const battlefields = state.battlefields.slice();
  const before = battlefields[index] as BattlefieldState;
  const after = update(before);
  battlefields[index] = after;
  const next = { ...state, battlefields };

  // A Battlefield's Game Object (170) has to follow the Battlefield's Control,
  // or its abilities would keep answering to whoever brought it. This is the
  // only place Control is written, so syncing here is what stops the two
  // representations drifting — the same discipline `moveEntity` applies to a
  // location and its zone list.
  if (before.controller === after.controller) {
    return next;
  }
  // 170.1 owns a Battlefield to a player even while it is Uncontrolled
  // (170.11.b), and `Entity.controller` is not nullable, so an Uncontrolled
  // Battlefield answers to its owner. Nothing reads it in that state: its
  // abilities all speak of holding or conquering, which need a controller.
  const controller = after.controller ?? getEntity(next, after.entity).owner;
  return withEntity(next, after.entity, (current) => ({ ...current, controller }));
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
    next = sendToNonBoardZone(next, unit, playerLocation(owner, 'trash'));
    // 705: a Unit leaving play loses its Buffs, along with the damage and the
    // turn's Might modifiers, none of which mean anything off the Board.
    next = withEntity(next, unit, (current) => ({
      ...current,
      damage: 0,
      exhausted: false,
      mightBonus: 0,
      grantedKeywords: [],
      buffs: 0,
      stunned: false,
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
    next = queueDeaths(next, killed, events, index);
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
    next = raiseEvent(
      next,
      { event: 'winCombat', actor: result.winner, objects: survivors, battlefield: index },
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

  const events: GameEvent[] = [{ type: 'readied', player, entities: readied }];
  // 315.1 readies by the same rule 415 an effect does, so "when you ready a
  // friendly unit" sees the Awaken too. One event carrying every Unit woken,
  // the way `winCombat` carries every survivor — one per Unit would fire a
  // "when you ready" ability once for each.
  if (readied.length > 0) {
    next = raiseEvent(next, { event: 'ready', actor: player, objects: readied }, events);
  }
  return advance(next, 'beginning', events);
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
    next = raiseEvent(next, { event: 'beginningPhase', actor: player }, events);
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
      if (scoringForbidden(next, index, player)) {
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
      next = raiseEvent(next, { event: 'hold', actor: player, battlefield: index }, events);
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
    // 167 empties everything, so the "already empty" shortcut has to ask about
    // everything too — an `[A]` left in the pool (135.2.e.5.b) is unspent Power
    // and is lost with the rest.
    if (
      player.pool.energy === 0 &&
      player.pool.anyPower === 0 &&
      Object.values(player.pool.power).every((n) => n === 0)
    ) {
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
    next = raiseEvent(next, { event: 'endOfTurn', actor: next.activePlayer }, preEvents);
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
    // 317.2.c: all "this turn" effects expire simultaneously — the Might a
    // card granted and the keywords it granted go together. 423.1.a.2 puts the
    // Stunned status in the same Cleanup, so it clears alongside them rather
    // than in a sweep of its own.
    if (entity.mightBonus !== 0 || entity.grantedKeywords.length > 0 || entity.stunned) {
      next = withEntity(next, entity.id, (current) => ({
        ...current,
        mightBonus: 0,
        grantedKeywords: [],
        stunned: false,
      }));
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
    players: next.players.map((seat) => ({ ...seat, playedThisTurn: [], turnEvents: {} })),
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
