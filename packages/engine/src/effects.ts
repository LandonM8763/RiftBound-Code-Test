/**
 * Executing card effects.
 *
 * Effects are data (see `@riftbound/cards`), and this is the interpreter. Adding
 * a new primitive means a case here and a variant there — not a new code path
 * per card, which is the whole point of the data-driven design.
 */
import type { CardEffect, DestinationSpec, Effect, TargetSpec } from '@riftbound/cards';

import type { TriggerEventInstance } from './abilities.js';
import { conditionMet } from './condition.js';
import type { GameEvent } from './events.js';
import { moveEntity, withEntity, withPlayer } from './mutate.js';
import { createTokens, sendToNonBoardZone } from './token.js';
import type { EntityId, GameState, Location, PlayerId } from './state.js';
import {
  addEnergyTo,
  addPowerTo,
  battlefieldLocation,
  entityCard,
  getEntity,
  getPlayer,
  playerLocation,
  sameLocation,
} from './state.js';

/**
 * The choices a card's controller made when playing it (rule 355.8).
 *
 * Bundled rather than passed one by one so adding a third kind of choice does
 * not ripple through every caller.
 */
export interface EffectChoices {
  readonly target?: EntityId | undefined;
  /** Where a `move` effect sends its target. */
  readonly destination?: Location | undefined;
}

/** One execution of a card's or ability's rules text. */
export interface EffectInvocation {
  readonly controller: PlayerId;
  /**
   * The Game Object whose text this is: the played card, or an ability's
   * source. What a `self` target resolves to.
   */
  readonly source: EntityId;
  readonly choices: EffectChoices;
  /**
   * 356.2.b: whether the optional Additional Cost was declared at step 2.
   *
   * Carried on the invocation because "if you paid the additional cost" is a
   * condition about a choice, and the choice is not readable off the board.
   */
  readonly paidAdditionalCost?: boolean | undefined;
}

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
  /**
   * Rules 450-453: Contest the Destination, run the Cleanup, and open a
   * Showdown if one is due. The same tail the Standard Move runs, which is why
   * it is supplied rather than reimplemented here.
   */
  readonly afterMove: (
    state: GameState,
    player: PlayerId,
    to: Location,
    units: readonly EntityId[],
    events: GameEvent[],
  ) => GameState;
  /**
   * Rule 383.2: announce that something happened, so Triggered Abilities
   * watching for it reach the Chain.
   *
   * Supplied rather than done here for the same reason as `queueDeaths`: this
   * layer executes effects and the Chain lives above it.
   */
  readonly raise: (
    state: GameState,
    instance: TriggerEventInstance,
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
  // "A unit from your trash" — a card in a Non-Board Zone, not a Game Object on
  // the Board, so this walks the trash rather than the Battlefields and Bases.
  if (spec.kind === 'trashCard') {
    return getPlayer(state, controller).zones.trash.filter(
      (card) => spec.cardType === undefined || entityCard(state, card).type === spec.cardType,
    );
  }

  // Neither makes the player choose: `none` affects nobody in particular and
  // `self` is already determined by which card the text is printed on.
  if (spec.kind !== 'unit') {
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
  // A self-targeting card takes no chosen target; supplying one is an error,
  // not a different reading.
  if (spec.kind !== 'unit' && spec.kind !== 'trashCard') {
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
  invocation: EffectInvocation,
  effect: CardEffect,
  events: GameEvent[],
  context: EffectContext,
): GameState {
  // "When you play me, **if you control a Poro**, buff me and draw 1" — the
  // condition gates the whole clause, so nothing runs when it fails. Asked
  // here, at resolution, because that is when the rules ask it.
  if (
    !conditionMet(state, invocation.controller, invocation.source, effect.condition, {
      paidAdditionalCost: invocation.paidAdditionalCost === true,
    })
  ) {
    return state;
  }

  // 355.6 is about choices; "me" is not one, so it is resolved here rather
  // than enumerated when the card was played.
  const choices: EffectChoices =
    effect.target.kind === 'self'
      ? { ...invocation.choices, target: invocation.source }
      : invocation.choices;

  let next = state;
  for (const step of effect.effects) {
    next = applyEffect(next, invocation.controller, invocation.source, step, choices, events, context);
  }
  return next;
}

function applyEffect(
  state: GameState,
  controller: PlayerId,
  source: EntityId,
  effect: Effect,
  choices: EffectChoices,
  events: GameEvent[],
  context: EffectContext,
): GameState {
  const target = choices.target;
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
        sendToNonBoardZone(withTriggers, target, playerLocation(owner, 'trash')),
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
      const buffed = withEntity(state, target, (current) => ({
        ...current,
        buffs: current.buffs + 1,
      }));
      // 702.3.a refuses the *second* Buff, so only a placement that actually
      // happened raises the event — "when you buff me" must not fire on a no-op.
      return context.raise(
        buffed,
        { event: 'buffed', actor: controller, objects: [target] },
        events,
      );
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
      // "When you discard one or more cards" is one event however many cards
      // went, which is why this is raised once outside the loop.
      return context.raise(next, { event: 'discard', actor: controller }, events);
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

    // 449: an effect-driven Move. Unlike the Standard Move it costs no exhaust
    // (420.3.a is the Standard Move's price), but the tail is identical: the
    // Destination is Contested (450), a Cleanup follows (453), and a Showdown
    // or Combat may open (451-452).
    case 'move': {
      const destination = choices.destination;
      if (target === undefined || destination === undefined || !onBoard(state, target)) {
        return state;
      }
      if (sameLocation(getEntity(state, target).location, destination)) {
        return state;
      }
      const moved = moveEntity(state, target, destination);
      events.push({
        type: 'unitsMoved',
        player: controller,
        units: [target],
        battlefield: destination.kind === 'battlefield' ? destination.index : null,
      });
      return context.afterMove(moved, controller, destination, [target], events);
    }

    // "Return it to its owner's hand." Rule 412 lists no Return action, so this
    // is a plain zone move — and deliberately not a Recall (455), which keeps
    // the Permanent on the Board at its owner's Base with damage and statuses
    // intact (458.1).
    case 'toHand': {
      if (target === undefined) {
        return state;
      }
      const entity = getEntity(state, target);
      // Already in a hand, or on the Chain partway through being played: there
      // is nothing to return, and moving it would corrupt the Process of Play.
      if (entity.location.kind === 'player' && ['hand', 'chain'].includes(entity.location.zone)) {
        return state;
      }
      const owner = entity.owner;
      events.push({ type: 'returnedToHand', player: owner, cards: [target] });
      // 186.1: a Token reaching a Non-Board Zone stops existing instead — it
      // never becomes a card in a hand, because it is not a card (185).
      return clearCounters(
        sendToNonBoardZone(state, target, playerLocation(owner, 'hand')),
        target,
      );
    }

    // 180-184: Create Tokens. Not a Move and not a play from hand — a Token is
    // Created directly on the Board (186), so nothing is Contested and no
    // Showdown opens. A card that wants the token to arrive fighting says
    // "play … here", which is `where: 'here'` resolved against the source.
    case 'createToken': {
      const where =
        effect.where === 'base'
          ? playerLocation(controller, 'base')
          : getEntity(state, source).location;
      // 186: a Token can only exist on the Board. A source that has already
      // left it — a resolving Spell sitting on the Chain — has no "here" to
      // speak of, so the Base is the only Board location its controller has.
      const location =
        where.kind === 'battlefield' || (where.kind === 'player' && where.zone === 'base')
          ? where
          : playerLocation(controller, 'base');
      return createTokens(
        state,
        controller,
        effect.token,
        effect.count,
        location,
        effect.ready === true,
        events,
      ).state;
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
 * Locations a `move` on this card may send its target to (rule 449.1).
 *
 * Enumerated for the same reason targets are: rule 355.8 needs every choice
 * settled before the card goes on the Chain, so `legalActions` offers one
 * action per destination rather than asking mid-resolution.
 */
export function legalDestinations(
  state: GameState,
  controller: PlayerId,
  spec: DestinationSpec | undefined,
): Location[] {
  if (spec === undefined) {
    return [];
  }
  if (spec.kind === 'base') {
    return [playerLocation(controller, 'base')];
  }
  return state.battlefields.map((_battlefield, index) => battlefieldLocation(index));
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
    // Exhaustion is a state of a Game Object on the Board (414-415) and means
    // nothing in a hand, deck or trash. The Combat and Kill sites in `reduce`
    // already cleared it by hand; clearing it here too is what makes every
    // departure from the Board look the same however it happened.
    exhausted: false,
  }));
}
