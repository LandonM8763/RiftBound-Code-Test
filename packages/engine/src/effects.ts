/**
 * Executing card effects.
 *
 * Effects are data (see `@riftbound/cards`), and this is the interpreter. Adding
 * a new primitive means a case here and a variant there — not a new code path
 * per card, which is the whole point of the data-driven design.
 */
import type { CardEffect, Effect, TargetSpec } from '@riftbound/cards';

import type { GameEvent } from './events.js';
import { withEntity, withPlayer } from './mutate.js';
import type { EntityId, GameState, PlayerId } from './state.js';
import { addEnergyTo, addPowerTo, entityCard, getEntity } from './state.js';

/**
 * Units that satisfy a target spec right now (rule 355.9).
 *
 * "Unit" means a Unit on the Board (355.9.a.1), so this walks the Battlefields
 * and every player's Base — a Unit in hand or trash is not a legal target.
 */
export function legalTargets(
  state: GameState,
  controller: PlayerId,
  spec: TargetSpec,
): EntityId[] {
  if (spec.kind === 'none') {
    return [];
  }

  const candidates: { unit: EntityId; atBattlefield: boolean }[] = [];
  for (const battlefield of state.battlefields) {
    for (const unit of battlefield.units) {
      candidates.push({ unit, atBattlefield: true });
    }
  }
  for (const player of state.players) {
    for (const unit of player.zones.base) {
      candidates.push({ unit, atBattlefield: false });
    }
  }

  return candidates
    .filter(({ unit, atBattlefield }) => {
      if (entityCard(state, unit).type !== 'unit') {
        return false;
      }
      if (spec.atBattlefield === true && !atBattlefield) {
        return false;
      }
      const owner = getEntity(state, unit).controller;
      if (spec.scope === 'friendly' && owner !== controller) {
        return false;
      }
      if (spec.scope === 'enemy' && owner === controller) {
        return false;
      }
      return true;
    })
    .map(({ unit }) => unit);
}

/** Whether a chosen target is still valid (rule 358.1, the Check Legality step). */
export function isValidTarget(
  state: GameState,
  controller: PlayerId,
  spec: TargetSpec,
  target: EntityId | undefined,
): boolean {
  if (spec.kind === 'none') {
    return target === undefined;
  }
  return target !== undefined && legalTargets(state, controller, spec).includes(target);
}

/**
 * Run a card's rules text.
 *
 * Effects execute in order, which is how rule 359.2.b reads a card from top to
 * bottom. A target that has left the board since it was chosen simply means the
 * targeted effects do nothing — the rest of the card still runs.
 */
export function executeEffect(
  state: GameState,
  controller: PlayerId,
  effect: CardEffect,
  target: EntityId | undefined,
  events: GameEvent[],
  drawCards: (state: GameState, player: PlayerId, count: number, events: GameEvent[]) => GameState,
): GameState {
  let next = state;
  for (const step of effect.effects) {
    next = applyEffect(next, controller, step, target, events, drawCards);
  }
  return next;
}

function applyEffect(
  state: GameState,
  controller: PlayerId,
  effect: Effect,
  target: EntityId | undefined,
  events: GameEvent[],
  drawCards: (state: GameState, player: PlayerId, count: number, events: GameEvent[]) => GameState,
): GameState {
  switch (effect.kind) {
    case 'draw':
      return drawCards(state, controller, effect.count, events);

    case 'dealDamage': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      // 417.1.e: only a positive amount is Valid Damage, and only Valid Damage
      // is Dealt.
      if (effect.amount < 1) {
        return state;
      }
      events.push({ type: 'damageDealt', unit: target, amount: effect.amount });
      return withEntity(state, target, (current) => ({
        ...current,
        damage: current.damage + effect.amount,
      }));
    }

    case 'heal': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      events.push({ type: 'healed', entities: [target] });
      return withEntity(state, target, (current) => ({ ...current, damage: 0 }));
    }

    case 'giveMight': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      events.push({ type: 'mightGranted', unit: target, amount: effect.amount });
      return withEntity(state, target, (current) => ({
        ...current,
        mightBonus: current.mightBonus + effect.amount,
      }));
    }

    case 'addEnergy':
      events.push({
        type: 'resourcesAdded',
        player: controller,
        rune: null,
        energy: effect.count,
        power: null,
      });
      return withPlayer(state, controller, (current) => ({
        ...current,
        pool: addEnergyTo(current.pool, effect.count),
      }));

    case 'addPower':
      events.push({
        type: 'resourcesAdded',
        player: controller,
        rune: null,
        energy: 0,
        power: effect.domain,
      });
      return withPlayer(state, controller, (current) => ({
        ...current,
        pool: addPowerTo(current.pool, effect.domain, effect.count),
      }));

    default: {
      const exhaustive: never = effect;
      throw new Error(`Unknown effect: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** A Unit is a legal recipient only while it is on the Board (rule 141.1.a). */
function onBoard(state: GameState, unit: EntityId): boolean {
  const location = getEntity(state, unit).location;
  return location.kind === 'battlefield' || location.zone === 'base';
}
