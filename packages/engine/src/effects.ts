/**
 * Executing card effects.
 *
 * Effects are data (see `@riftbound/cards`), and this is the interpreter. Adding
 * a new primitive means a case here and a variant there — not a new code path
 * per card, which is the whole point of the data-driven design.
 */
import { tokenCardId } from '@riftbound/cards';
import type { CardEffect, DestinationSpec, Effect, TargetSpec } from '@riftbound/cards';

import type { TriggerEventInstance } from './abilities.js';
import { attach, detach, equipAbilityOf } from './attach.js';
import { mightOf } from './combat.js';
import { conditionMet } from './condition.js';
import { abilityCost } from './costs.js';
import { countOf } from './count.js';
import type { GameEvent } from './events.js';
import { moveEntity, withEntity, withPlayer } from './mutate.js';
import { canPay, payFrom } from './play.js';
import { entersReady } from './statics.js';
import { createTokens, sendToNonBoardZone } from './token.js';
import type { EntityId, GameState, Location, PlayerId } from './state.js';
import {
  addAnyPowerTo,
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
  /**
   * 808.1.d.3: the Battlefield noted when this ability's source left the Board.
   *
   * "Deal 4 to all units at my battlefield" printed as a Deathknell resolves
   * after the Unit has reached the trash, where 359.3.e.12 gives it no
   * location at all. 808.1.d.3 is the rule that saves it: "before the card is
   * moved to the Trash, note its location … to process the trigger after it
   * has been Finalized". So the note rides on the invocation, and is consulted
   * only when the source is no longer at a Battlefield.
   */
  readonly noted?: number | undefined;
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

  // 821.1.c: "a Card you control with the Equipment tag" — a Gear on the Board,
  // whether it is already Attached to something or not (the reminder's "even if
  // it's already attached", and 434.1.f handles the move).
  if (spec.kind === 'gear') {
    const found: EntityId[] = [];
    for (const id of boardEntitiesOf(state, controller)) {
      if (entityCard(state, id).type === 'gear') {
        found.push(id);
      }
    }
    return found;
  }

  // None of these make the player choose: `none` affects nobody in particular,
  // `self` is already determined by which card the text is printed on, and
  // 355.5.a says affecting objects "based on criteria" is not choosing — so an
  // `all` spec is resolved at execution rather than enumerated here.
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

  const wanted = spec.cardType ?? 'unit';
  return candidates
    .filter(({ unit, atBattlefield }) => {
      if (entityCard(state, unit).type !== wanted) {
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

/**
 * Every Game Object an `all` spec covers, at the moment the effect runs.
 *
 * Resolved here rather than at play time because 355.5.a makes this not a
 * choice: the set is whatever matches when the effect executes, so a Unit that
 * arrived since the card was played is included and one that died is not.
 */
export function allTargets(
  state: GameState,
  controller: PlayerId,
  spec: Extract<TargetSpec, { kind: 'all' }>,
  source?: EntityId | undefined,
  /** 808.1.d.3's noted Battlefield, used when the source has left the Board. */
  noted?: number | undefined,
): EntityId[] {
  const wanted = spec.cardType ?? 'unit';
  const found: EntityId[] = [];

  // 355.9's "here": the source's own Battlefield. A source at a Base names
  // none, so the set is empty rather than the whole Board — the same reading
  // `StaticScope.here` takes.
  let here: number | undefined;
  if (spec.here === true) {
    const location = source === undefined ? undefined : getEntity(state, source).location;
    here = location?.kind === 'battlefield' ? location.index : noted;
    if (here === undefined) {
      return [];
    }
  }

  const consider = (id: EntityId, atBattlefield: boolean): void => {
    if (entityCard(state, id).type !== wanted) {
      return;
    }
    if (spec.atBattlefield === true && !atBattlefield) {
      return;
    }
    const owner = getEntity(state, id).controller;
    if (spec.scope === 'friendly' && owner !== controller) {
      return;
    }
    if (spec.scope === 'enemy' && owner === controller) {
      return;
    }
    found.push(id);
  };

  state.battlefields.forEach((battlefield, index) => {
    // "all enemy units in combat" — 464 runs a Combat at one Battlefield, so
    // the set is who is present there.
    if (spec.inCombat === true && state.showdown?.battlefield !== index) {
      return;
    }
    if (here !== undefined && here !== index) {
      return;
    }
    for (const unit of battlefield.units) {
      consider(unit, true);
    }
  });
  if (spec.inCombat !== true && here === undefined) {
    for (const player of state.players) {
      for (const id of player.zones.base) {
        consider(id, false);
      }
    }
  }
  return found;
}

/**
 * Does this effect act on the chosen object, rather than on the controller?
 *
 * Only these are repeated when a spec covers many objects; "deal 2 to all
 * enemy units and draw 1" deals damage N times and draws once.
 */
function consumesTarget(kind: Effect['kind']): boolean {
  switch (kind) {
    case 'dealDamage':
    case 'heal':
    case 'giveMight':
    case 'kill':
    case 'recall':
    case 'ready':
    case 'exhaust':
    case 'stun':
    case 'buff':
    case 'spendBuff':
    case 'move':
    case 'toHand':
    case 'grantKeyword':
    case 'attach':
    case 'equip':
      return true;
    default:
      return false;
  }
}

/** Everything `player` controls that is on the Board (rule 380). */
function boardEntitiesOf(state: GameState, player: PlayerId): EntityId[] {
  const found: EntityId[] = [...getPlayer(state, player).zones.base];
  for (const battlefield of state.battlefields) {
    for (const id of battlefield.units) {
      if (getEntity(state, id).controller === player) {
        found.push(id);
      }
    }
  }
  return found;
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
  if (spec.kind !== 'unit' && spec.kind !== 'trashCard' && spec.kind !== 'gear') {
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
    // 355.5.a: an `all` spec affects every matching object rather than one
    // chosen one, so a target-consuming effect runs once per object while the
    // rest — a draw, a Score — still run once.
    if (effect.target.kind === 'all' && consumesTarget(step.kind)) {
      const every = allTargets(
        next,
        invocation.controller,
        effect.target,
        invocation.source,
        invocation.noted,
      );
      for (const one of every) {
        next = applyEffect(
          next,
          invocation.controller,
          invocation.source,
          step,
          { ...choices, target: one },
          events,
          context,
          invocation.noted,
        );
      }
      continue;
    }
    next = applyEffect(
      next,
      invocation.controller,
      invocation.source,
      step,
      choices,
      events,
      context,
      invocation.noted,
    );
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
  /** 808.1.d.3's noted Battlefield, for a "here" whose source has left the Board. */
  noted?: number | undefined,
): GameState {
  const target = choices.target;
  switch (effect.kind) {
    case 'draw': {
      // "Draw 1 for each of your MIGHTY units": the printed number is per-unit,
      // so the count multiplies it. `mightOf` is safe to consult here — an
      // effect executes, it is not something `mightOf` consults back.
      const times =
        effect.per === undefined ? 1 : countOf(state, controller, source, effect.per, mightOf);
      return context.drawCards(state, controller, effect.count * times, events);
    }

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

    case 'addAnyPower':
      events.push({
        type: 'resourcesAdded',
        player: controller,
        rune: null,
        energy: 0,
        power: null,
        anyPower: effect.count,
      });
      return withPlayer(state, controller, (current) => ({
        ...current,
        pool: addAnyPowerTo(current.pool, effect.count),
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

    // 436.1: the Recycle half of a Predict. 416.1 puts the cards on the bottom
    // of their owner's Main Deck; 436.4.a is explicit that running short is not
    // a Burn Out, which is why this takes what it can and stops.
    case 'recycleTop': {
      let next = state;
      for (let i = 0; i < Math.max(0, effect.count); i += 1) {
        const top = getPlayer(next, controller).zones.mainDeck[0];
        if (top === undefined) {
          break;
        }
        next = moveEntity(next, top, playerLocation(controller, 'mainDeck'), 'bottom');
      }
      return next;
    }

    // 467-471: gain points outright. 471.1.a.1 exempts this from the Final
    // Point restriction, which is Conquer's alone, so there is no condition to
    // check — the win is then decided at the next Cleanup by 323.1.
    case 'score': {
      const amount = Math.max(0, effect.amount);
      if (amount === 0) {
        return state;
      }
      const total = getPlayer(state, controller).points + amount;
      events.push({
        type: 'pointsScored',
        player: controller,
        battlefield: null,
        amount,
        total,
        method: 'effect',
      });
      return withPlayer(state, controller, (current) => ({ ...current, points: total }));
    }

    // 423: Stun the target. 423.1.a.1 makes stunning an already-Stunned Unit
    // legal but inert — and pointedly *not* an event, which is the rulebook's
    // own Eclipse Herald example, so the trigger is raised on the change.
    case 'stun': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      if (getEntity(state, target).stunned) {
        return state;
      }
      events.push({ type: 'stunned', unit: target });
      const next = withEntity(state, target, (current) => ({ ...current, stunned: true }));
      return context.raise(
        next,
        { event: 'stun', actor: controller, objects: [target] },
        events,
      );
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

    // 801.3.a: a granted keyword is as real as a printed one. Stored on the
    // recipient because 317.2.c expires it there, alongside `mightBonus`.
    case 'grantKeyword': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      events.push({ type: 'keywordGranted', unit: target, keyword: effect.keyword });
      return withEntity(state, target, (current) => ({
        ...current,
        // 807.2/814.2 sum valued keywords and 810.2/815.2 make unvalued ones
        // redundant. Both are `keywordValue`/`hasKeyword`'s job, so this
        // appends rather than deduplicating.
        grantedKeywords: [...current.grantedKeywords, effect.keyword],
      }));
    }

    // 434 / 818.1.c.2: attach the *source* to the chosen Unit, which becomes
    // the Top-Most Card. The target is the Unit; what gets attached is never a
    // choice, because Equip says "attach this gear".
    case 'attach': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      events.push({ type: 'attached', card: source, topMost: target });
      return attach(state, source, target);
    }

    case 'detach':
      return detach(state, source);

    // 821: Weaponmaster. The chosen Equipment's *own* Equip cost is paid, and
    // the Equipment is Attached to the source — the opposite direction from
    // `attach` above, because 821.1.c is printed on the Unit rather than on the
    // Gear.
    case 'equip': {
      if (target === undefined || !onBoard(state, target) || !onBoard(state, source)) {
        return state;
      }
      const equip = equipAbilityOf(state, target);
      // 821.1.c.4: a chosen card with no Equip cost cannot pay one, so nothing
      // happens — 821.1.c.5 leaves it exactly where it was.
      if (equip === undefined) {
        return state;
      }
      const owed = abilityCost(state, controller, equip.cost, {
        anyPower: effect.discountAnyPower ?? 0,
      });
      if (!canPay(getPlayer(state, controller).pool, owed)) {
        return state;
      }
      let next = withPlayer(state, controller, (current) => ({
        ...current,
        pool: payFrom(current.pool, owed),
      }));
      events.push({ type: 'attached', card: target, topMost: source });
      return attach(next, target, source);
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
          : // 808.1.d.3: a Deathknell's "here" is the Battlefield noted before
            // the Unit left the Board, since 359.3.e.12 leaves the corpse none.
            noted !== undefined && getEntity(state, source).location.kind !== 'battlefield'
            ? battlefieldLocation(noted)
            : getEntity(state, source).location;
      // 186: a Token can only exist on the Board. A source that has already
      // left it — a resolving Spell sitting on the Chain — has no "here" to
      // speak of, so the Base is the only Board location its controller has.
      const location =
        where.kind === 'battlefield' || (where.kind === 'player' && where.zone === 'base')
          ? where
          : playerLocation(controller, 'base');
      // 184.1's explicit "ready"/"exhausted" is about *this* token, so it wins
      // over a static that only replaces the type's default — "Your tokens
      // enter ready" supplies the default when the creating effect says
      // nothing. The rulebook settles neither order; this is the reading that
      // keeps a card's own instruction meaning what it says.
      const definition = state.definitions[tokenCardId(effect.token)];
      const ready =
        effect.ready ??
        (definition !== undefined && entersReady(state, controller, definition) ? true : undefined);
      return createTokens(state, controller, effect.token, effect.count, location, ready, events)
        .state;
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
    stunned: false,
    damage: 0,
    mightBonus: 0,
    // A keyword granted "this turn" is as much a thing the Board was doing to
    // this object as its Buffs are, so 705's reasoning covers it: leaving play
    // ends it, rather than it waiting in the trash for 317.2.c.
    grantedKeywords: [],
    // Exhaustion is a state of a Game Object on the Board (414-415) and means
    // nothing in a hand, deck or trash. The Combat and Kill sites in `reduce`
    // already cleared it by hand; clearing it here too is what makes every
    // departure from the Board look the same however it happened.
    exhausted: false,
  }));
}
