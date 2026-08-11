/**
 * Executing card effects.
 *
 * Effects are data (see `@riftbound/cards`), and this is the interpreter. Adding
 * a new primitive means a case here and a variant there — not a new code path
 * per card, which is the whole point of the data-driven design.
 */
import type { CardEffect, Effect, TargetSpec } from '@riftbound/cards';

import type { GameEvent } from './events.js';
import { moveEntity, withEntity, withPlayer } from './mutate.js';
import type { EntityId, GameState, PlayerId } from './state.js';
import { addEnergyTo, addPowerTo, entityCard, getEntity, getPlayer, playerLocation } from './state.js';

/**
 * What the interpreter needs from the reducer.
 *
 * Both callbacks reach machinery that lives above this module: drawing can
 * cause a Burn Out (431), and killing has to put Deathknells on the Chain
 * before the Unit reaches the trash (428.1.a.1.b). Passing them in keeps
 * `effects.ts` free of the Chain and the turn structure.
 */
export interface EffectContext {
  readonly drawCards: (
    state: GameState,
    player: PlayerId,
    count: number,
    events: GameEvent[],
  ) => GameState;
  /** 428.1.a.1.b: queue each dying Unit's own death triggers, before it moves. */
  readonly queueDeaths: (
    state: GameState,
    units: readonly EntityId[],
    events: GameEvent[],
  ) => GameState;
}

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
  context: EffectContext,
): GameState {
  let next = state;
  for (const step of effect.effects) {
    next = applyEffect(next, controller, step, target, events, context);
  }
  return next;
}

function applyEffect(
  state: GameState,
  controller: PlayerId,
  effect: Effect,
  target: EntityId | undefined,
  events: GameEvent[],
  context: EffectContext,
): GameState {
  switch (effect.kind) {
    case 'draw':
      return context.drawCards(state, controller, effect.count, events);

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

    // 428: a Kill Instruction. The Unit's own Deathknell goes on the Chain
    // first, while it is still on the Board (428.1.a.1.b), which is why the
    // trigger queue runs before the move to the trash.
    case 'kill': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      const withTriggers = context.queueDeaths(state, [target], events);
      const owner = getEntity(withTriggers, target).owner;
      events.push({ type: 'unitsKilled', units: [target] });
      return clearCounters(
        moveEntity(withTriggers, target, playerLocation(owner, 'trash')),
        target,
      );
    }

    // 455: relocated to its Base without being a Move. 458.1 leaves damage and
    // statuses alone, so nothing is reset here.
    case 'recall': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      const owner = getEntity(state, target).controller;
      events.push({ type: 'unitsRecalled', units: [target] });
      return moveEntity(state, target, playerLocation(owner, 'base'));
    }

    // 415.1.c: readying something already ready does nothing at all.
    case 'ready': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      return withEntity(state, target, (current) => ({ ...current, exhausted: false }));
    }

    case 'exhaust': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      return withEntity(state, target, (current) => ({ ...current, exhausted: true }));
    }

    // 702.3.a: a Unit that already has a Buff does not get a second one.
    case 'buff': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      if (getEntity(state, target).buffs >= 1) {
        return state;
      }
      events.push({ type: 'buffAdded', unit: target });
      return withEntity(state, target, (current) => ({ ...current, buffs: current.buffs + 1 }));
    }

    // 702.2.b.1: a Buff cannot be spent from a Unit that has none.
    // 702.2.b.2: only from a Unit its controller controls.
    case 'spendBuff': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      const entity = getEntity(state, target);
      if (entity.buffs < 1 || entity.controller !== controller) {
        return state;
      }
      events.push({ type: 'buffSpent', unit: target });
      return withEntity(state, target, (current) => ({ ...current, buffs: current.buffs - 1 }));
    }

    // 422: hand to trash, without the card doing anything on the way.
    // 422.4: discard as many as possible when the hand is short.
    case 'discard': {
      const hand = getPlayer(state, controller).zones.hand;
      // 422.1.a lets the discarding player choose which cards. The choice is
      // not exposed — it needs the same sub-action protocol as trigger
      // ordering — so this takes from the front of the hand, deterministically.
      const chosen = hand.slice(0, Math.max(0, effect.count));
      if (chosen.length === 0) {
        return state;
      }
      let next = state;
      for (const card of chosen) {
        next = moveEntity(next, card, playerLocation(controller, 'trash'));
      }
      events.push({ type: 'cardsDiscarded', player: controller, cards: chosen });
      return next;
    }

    // 733: there is no limit to the XP a player can accrue.
    case 'gainXp':
      if (effect.amount <= 0) {
        return state;
      }
      events.push({ type: 'xpChanged', player: controller, amount: effect.amount });
      return withPlayer(state, controller, (current) => ({
        ...current,
        xp: current.xp + effect.amount,
      }));

    // 730.2: spending reduces the value. Floored at 0 — a player cannot spend
    // XP they do not have.
    case 'spendXp': {
      const available = getPlayer(state, controller).xp;
      const spent = Math.min(available, Math.max(0, effect.amount));
      if (spent === 0) {
        return state;
      }
      events.push({ type: 'xpChanged', player: controller, amount: -spent });
      return withPlayer(state, controller, (current) => ({ ...current, xp: current.xp - spent }));
    }

    // 430.3: too few Runes means channelling as many as possible. Deliberately
    // not a Burn Out — that is what an empty *Main* Deck causes (431).
    case 'channel': {
      let next = state;
      for (let i = 0; i < effect.count; i += 1) {
        const top = getPlayer(next, controller).zones.runeDeck[0];
        if (top === undefined) {
          events.push({ type: 'runeDeckEmpty', player: controller });
          break;
        }
        next = moveEntity(next, top, playerLocation(controller, 'runes'));
        // 430.2.a: Runes are Channelled ready unless the effect says otherwise.
        if (effect.exhausted === true) {
          next = withEntity(next, top, (current) => ({ ...current, exhausted: true }));
        }
        events.push({ type: 'runeChannelled', player: controller, entity: top });
      }
      return next;
    }

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

/**
 * Rule 705: a Unit that leaves play loses its Buffs.
 *
 * Damage and the turn's Might modifiers go with it, since neither means
 * anything off the Board and a returning card must not carry them back.
 */
function clearCounters(state: GameState, entity: EntityId): GameState {
  return withEntity(state, entity, (current) => ({
    ...current,
    buffs: 0,
    damage: 0,
    mightBonus: 0,
  }));
}
