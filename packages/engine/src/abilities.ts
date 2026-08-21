/**
 * Activated and Triggered abilities (rules 376-395).
 *
 * The split of responsibilities mirrors card effects: the ability data lives in
 * `@riftbound/cards`, and this decides when one may be activated, which ones a
 * game event triggers, and in what order they reach the Chain. Executing the
 * effect itself is still `effects.ts` — an ability's effect is an effect.
 *
 * Triggers are **event-driven**: the reducer raises a `TriggerEventInstance`
 * describing what happened, and every Triggered Ability on the Board is asked
 * whether it cares. The reverse arrangement — look up abilities by a closed set
 * of condition variants — is what the previous shape did, and it could not
 * express "when a *friendly* unit dies" at all, because the lookup only ever
 * consulted the dying Unit.
 */
import {
  activatedAbilities,
  costOf,
  triggeredAbilities,
  type AbilityRef,
  type CardAbilities,
  type ActivatedAbility,
  type CardType,
  type Cost,
  type TriggerCondition,
  type TriggeredAbility,
  type TriggerEvent,
} from '@riftbound/cards';

import { canPayAdditional } from './additional.js';
import { activeAbilities, attachedTextOf } from './attach.js';
import {
  grantedAbilities,
  grantingStatics,
  objectForbidden,
  type ActiveStatic,
} from './statics.js';
import { abilityCost } from './costs.js';
import { dependencyMet } from './dependency.js';
import { canPay } from './play.js';
import {
  entityCard,
  getEntity,
  getPlayer,
  isClosed,
  type EntityId,
  type GameState,
  type PlayerId,
} from './state.js';

/** An ability that is about to go on the Chain. */
export interface PendingTrigger {
  readonly source: EntityId;
  readonly controller: PlayerId;
  readonly ability: AbilityRef;
}

/**
 * Something that happened, which Triggered Abilities may watch for (383.2).
 *
 * Raised by the reducer at the point the rules say the event occurs. Rule
 * 383.2.c evaluates conditions *after* the inciting event has been processed,
 * so the state handed to `triggersFor` is the state after it.
 */
export interface TriggerEventInstance {
  readonly event: TriggerEvent;
  /** The player whose event it is: who played the card, whose turn ended. */
  readonly actor: PlayerId;
  /**
   * The Game Objects the event is about. Often one; sometimes none.
   *
   * A list rather than a single id because some events genuinely are about
   * several things at once: a Combat is won by every surviving Unit on the
   * winning side (466.3), and "When I win a combat" has to match each of them
   * from a single event. Raising one event per Unit instead would fire a
   * "when *you* win a combat" trigger once per survivor.
   *
   * Empty for events that are about no object at all — a phase starting, a
   * discard of cards that are no longer anywhere interesting.
   */
  readonly objects?: readonly EntityId[] | undefined;
  /** Where it happened, for `here` filters and Battlefield-scoped events. */
  readonly battlefield?: number | undefined;
  /**
   * Which occurrence of this event it is for `actor` this turn, counting from
   * 1 — "your second card in a turn".
   */
  readonly ordinal?: number | undefined;
  /**
   * The type of the card that caused this event, when one did — the "with a
   * **spell**" of 355.6's choosing. Absent for an event no card caused.
   */
  readonly byCardType?: CardType | undefined;
  /**
   * Where a Move started (446). `battlefield` is its Destination, so this is
   * the other end — what "when I move **from** a battlefield" asks about.
   */
  readonly origin?: number | undefined;
  /** 811: the card was played out of the Facedown Zone. */
  readonly fromFacedown?: boolean | undefined;
}

/**
 * Resolve a Chain item's ability back to its definition.
 *
 * `ref.from` is 718.3's case: the ability belongs to `source` — the Top-Most
 * Card — but its text is printed on the Attached card, so that is where it has
 * to be read from.
 */
export function abilityFor(
  state: GameState,
  source: EntityId,
  ref: AbilityRef,
): ActivatedAbility | TriggeredAbility | undefined {
  const abilities =
    ref.granted === true
      ? grantedAbilities(state, source).find((set) => set.from === ref.from)?.abilities
      : ref.from === undefined
        ? entityCard(state, source).abilities
        : attachedTextOf(state, ref.from)?.abilities;
  return ref.kind === 'activated'
    ? activatedAbilities(abilities)[ref.index]
    : triggeredAbilities(abilities)[ref.index];
}

/**
 * Everything a Game Object can do: printed, Attached (718.3) and granted
 * (801.3.a).
 *
 * The single answer both sweeps below ask, so a granted ability cannot be
 * activated but not triggered, or the reverse. `AbilityRef` carries whichever
 * of the two `from` means, because `abilityFor` has to read the text back.
 */
function abilitySets(
  state: GameState,
  entity: EntityId,
  statics: readonly ActiveStatic[],
): readonly { readonly abilities: CardAbilities; readonly ref: Partial<AbilityRef> }[] {
  const sets: { abilities: CardAbilities; ref: Partial<AbilityRef> }[] = activeAbilities(
    state,
    entity,
  ).map((set) => ({
    abilities: set.abilities,
    ref: set.from === undefined ? {} : { from: set.from },
  }));
  for (const set of grantedAbilities(state, entity, statics)) {
    sets.push({ abilities: set.abilities, ref: { from: set.from, granted: true } });
  }
  return sets;
}


/**
 * Can this Triggered Ability's price be met (403, 356.7)?
 *
 * The same three checks an Activated Ability gets — the pool, 414's exhaust,
 * and 416.3/422.3's rule that a non-resource cost must be *completable* — asked
 * at 402.2 rather than at activation, because that is the step of playing where
 * a Triggered Ability settles its choices.
 */
export function triggerCostPayable(
  state: GameState,
  player: PlayerId,
  ability: ActivatedAbility | TriggeredAbility,
  source: EntityId,
): boolean {
  if (!('condition' in ability)) {
    return true;
  }
  if (ability.cost !== undefined && !canPay(getPlayer(state, player).pool, ability.cost)) {
    return false;
  }
  if (ability.exhaustSelf === true && getEntity(state, source).exhausted) {
    return false;
  }
  return (ability.payments ?? []).every((payment) =>
    canPayAdditional(state, player, payment, source),
  );
}

/**
 * Every Activated Ability `player` may use right now (rules 376-381).
 *
 * Four gates, all from the rules rather than convenience:
 * - 381: the controller's own turn, and an Open State only.
 * - 380: the source is on the Board.
 * - 377: the cost is payable, including exhausting the source when that is
 *   part of it (414). The cost is the *Total* Cost (403.2-403.3), so a modifier
 *   that names abilities has already been applied.
 * - 801.1: a Dependent Keyword's condition holds, or the ability is not there.
 */
export function activatableAbilities(
  state: GameState,
  player: PlayerId,
): readonly {
  readonly source: EntityId;
  readonly index: number;
  readonly ability: ActivatedAbility;
  /** Rule 403: the cost after modification, which is what gets paid. */
  readonly cost: Cost;
  /**
   * How the source came to have this ability: printed, Attached (718.3) or
   * granted by a static (801.3.a). Rides onto the Chain item so `abilityFor`
   * can read the text back, and keys 383.3.e's per-turn limit.
   */
  readonly ref: Partial<AbilityRef>;
}[] {
  // 381: "only ... on the Controlling Player's Turn and during an Open State".
  if (state.activePlayer !== player || isClosed(state) || state.showdown !== null) {
    return [];
  }

  const found: {
    source: EntityId;
    index: number;
    /** How the source came to have it: Attached (718.3) or granted (801.3.a). */
    ref: Partial<AbilityRef>;
    ability: ActivatedAbility;
    cost: Cost;
  }[] = [];
  const granting = grantingStatics(state);
  for (const source of boardEntities(state, player)) {
    const entity = getEntity(state, source);
    // Rule 002 with 377: "Use my abilities only while I'm at a battlefield"
    // removes the permission rather than changing what the ability does, so it
    // is asked here, where 381's other permissions are.
    if (objectForbidden(state, source, 'activateAbility')) {
      continue;
    }
    // 718.2/718.3: an Attached card's own abilities are Inactive and its
    // Top-Most Card gains the Effect Text's instead, so what a Game Object can
    // do is asked rather than read straight off its card.
    for (const set of abilitySets(state, source, granting)) {
      activatedAbilities(set.abilities).forEach((ability, index) => {
        // 414: an exhaust cost cannot be paid by something already exhausted.
        if (ability.exhaustSelf === true && entity.exhausted) {
          return;
        }
        if (!dependencyMet(state, source, player, ability.dependsOn)) {
          return;
        }
        const cost = abilityCost(state, player, ability.cost);
        if (!canPay(getPlayer(state, player).pool, cost)) {
          return;
        }
        // 356.7 / 416.3: a non-resource part of the cost must be completable,
        // or the ability cannot be activated at all — the rulebook's own Vi
        // Destructive example, where an empty trash makes it unusable.
        if (
          (ability.payments ?? []).some(
            (payment) => !canPayAdditional(state, player, payment, source),
          )
        ) {
          return;
        }
        found.push({ source, index, ref: set.ref, ability, cost });
      });
    }
  }
  return found;
}

/**
 * Does `condition` care about `instance`, for an ability on `source`?
 *
 * Three checks, all of which must hold:
 *
 * 1. The same kind of event.
 * 2. The requirements that are about the event as a whole — "you" as the actor,
 *    "here" as the place, the ordinal.
 * 3. The requirements that are about an *object*. Those are satisfied by a
 *    single object satisfying all of them at once, not by different objects
 *    satisfying them separately: "another friendly unit" has to be one Unit
 *    that is both.
 */
export function matchesTrigger(
  state: GameState,
  instance: TriggerEventInstance,
  source: EntityId,
  controller: PlayerId,
  condition: TriggerCondition,
): boolean {
  if (condition.event !== instance.event) {
    return false;
  }
  if (!matchesEvent(state, instance, source, controller, condition)) {
    return false;
  }

  const filter = condition.filter;
  const objectSubject =
    condition.subject === 'self' ||
    condition.subject === 'friendly' ||
    condition.subject === 'enemy';
  const objectFilter =
    filter !== undefined &&
    (filter.excludeSelf === true ||
      filter.cardType !== undefined ||
      filter.minEnergy !== undefined ||
      filter.minPower !== undefined ||
      filter.buffed !== undefined ||
      filter.excludeTag !== undefined);

  if (!objectSubject && !objectFilter) {
    return true;
  }
  return (instance.objects ?? []).some(
    (object) =>
      matchesObjectSubject(state, object, source, controller, condition.subject) &&
      matchesObjectFilter(state, object, source, filter),
  );
}

/** The parts of a condition that are about the event rather than its objects. */
function matchesEvent(
  state: GameState,
  instance: TriggerEventInstance,
  source: EntityId,
  controller: PlayerId,
  condition: TriggerCondition,
): boolean {
  if (condition.subject === 'you' && instance.actor !== controller) {
    return false;
  }
  const filter = condition.filter;
  if (filter === undefined) {
    return true;
  }
  // "When **you** choose me": an actor constraint alongside an object subject,
  // which `subject` alone cannot express — it says one or the other.
  if (filter.byController === true && instance.actor !== controller) {
    return false;
  }
  // "with a **spell**": the type of what caused the event, not of its object.
  if (filter.bySource !== undefined && instance.byCardType !== filter.bySource) {
    return false;
  }
  if (filter.ordinal !== undefined && instance.ordinal !== filter.ordinal) {
    return false;
  }
  if (filter.fromFacedown !== undefined && (instance.fromFacedown === true) !== filter.fromFacedown) {
    return false;
  }
  // 314: whose turn it is is state, so it is read rather than carried.
  if (filter.onOpponentTurn === true && instance.actor === state.activePlayer) {
    return false;
  }
  if (filter.here === true || filter.notHere === true) {
    // 355.9: "here" is the source's own Location. `direction` picks which end
    // of a Move the comparison is against — the Destination by default.
    const location = state.entities[source]?.location;
    const at = location?.kind === 'battlefield' ? location.index : undefined;
    const where = filter.direction === 'from' ? instance.origin : instance.battlefield;
    if (at === undefined) {
      return false;
    }
    if (filter.here === true && at !== where) {
      return false;
    }
    if (filter.notHere === true && (where === undefined || at === where)) {
      return false;
    }
  } else if (filter.direction === 'from' && instance.origin === undefined) {
    // "When I move from a battlefield" with no origin recorded is not a Move
    // this condition can be about.
    return false;
  }
  return true;
}

function matchesObjectSubject(
  state: GameState,
  object: EntityId,
  source: EntityId,
  controller: PlayerId,
  subject: TriggerCondition['subject'],
): boolean {
  if (subject === 'self') {
    return object === source;
  }
  if (subject !== 'friendly' && subject !== 'enemy') {
    return true;
  }
  // Judged by the *object's* controller, not the actor's: a Unit you control
  // can die to an opponent's Spell and still be friendly.
  const owner = state.entities[object]?.controller;
  if (owner === undefined) {
    return false;
  }
  return subject === 'friendly' ? owner === controller : owner !== controller;
}

function matchesObjectFilter(
  state: GameState,
  object: EntityId,
  source: EntityId,
  filter: TriggerCondition['filter'],
): boolean {
  if (filter === undefined) {
    return true;
  }
  if (filter.excludeSelf === true && object === source) {
    return false;
  }
  if (state.entities[object] === undefined) {
    return false;
  }
  const card = entityCard(state, object);
  if (filter.cardType !== undefined && card.type !== filter.cardType) {
    return false;
  }

  // 356.1.c: "Base Cost" is the printed cost, which is what a card's text means
  // by "a spell that costs 5 or more" — not what it happened to cost to play.
  const cost = costOf(card);
  if (filter.minEnergy !== undefined && (cost?.energy ?? 0) < filter.minEnergy) {
    return false;
  }
  if (filter.minPower !== undefined && (cost?.power.length ?? 0) < filter.minPower) {
    return false;
  }
  // 702: "a **buffed** friendly unit". Read off the entity, which for a Unit
  // that just died is the pre-move copy `extraSources` kept alive.
  if (filter.buffed !== undefined && (state.entities[object]?.buffs ?? 0) > 0 !== filter.buffed) {
    return false;
  }
  // 133.8: "another **non-Recruit** unit". Matches nothing to exclude while the
  // export carries no tags, which makes the condition *wider* than printed —
  // the same shortfall `ObjectFilter.tag` records as a gap.
  if (filter.excludeTag !== undefined && card.tags.includes(filter.excludeTag)) {
    return false;
  }
  return true;
}

/**
 * Triggered Abilities that `instance` fires, in the order they go on the Chain.
 *
 * Rule 383.3.d has each player order their own simultaneous triggers, starting
 * with the Turn Player and proceeding in turn order. The per-player *ordering
 * choice* is not exposed: this walks each player's sources in a fixed order
 * instead. Turn order between players is honoured, so the interleaving is
 * right; only the tie-break within one player's own triggers is decided for
 * them. Making it a choice needs a sub-action protocol, the same one the Combat
 * damage assignment order needs.
 */
export function triggersFor(
  state: GameState,
  instance: TriggerEventInstance,
  options: {
    /**
     * Sources to consider *in addition* to everything on the Board.
     *
     * A Unit that just died is no longer on the Board, so its own "When I die"
     * would never be found. Naming it here keeps it a candidate without making
     * it the only one — which is what lets another Unit's "when a friendly unit
     * dies" see the same death.
     */
    readonly extraSources?: readonly EntityId[] | undefined;
  } = {},
): readonly PendingTrigger[] {
  // Candidates as (source, controller) pairs, gathered once and deduplicated:
  // an extra source may also still be on the Board.
  const candidates: { source: EntityId; controller: PlayerId }[] = [];
  const seen = new Set<EntityId>();

  const add = (source: EntityId): void => {
    if (seen.has(source)) {
      return;
    }
    const entity = state.entities[source];
    if (entity === undefined) {
      return;
    }
    seen.add(source);
    candidates.push({ source, controller: entity.controller });
  };

  for (const seat of state.players) {
    for (const source of boardEntities(state, seat.id)) {
      add(source);
    }
  }
  for (const source of options.extraSources ?? []) {
    add(source);
  }

  // 383.3.d.1: each player orders their own, starting with the Turn Player and
  // proceeding in turn order. Array.prototype.sort is stable, so the fixed
  // within-player order above survives this.
  const order = turnOrder(state);
  candidates.sort((a, b) => order.indexOf(a.controller) - order.indexOf(b.controller));

  const pending: PendingTrigger[] = [];
  const granting = grantingStatics(state);
  for (const { source, controller } of candidates) {
    for (const set of abilitySets(state, source, granting)) {
      triggeredAbilities(set.abilities).forEach((ability, index) => {
        if (!matchesTrigger(state, instance, source, controller, ability.condition)) {
          return;
        }
        if (!dependencyMet(state, source, controller, ability.dependsOn)) {
          return;
        }
        if (!withinTurnLimit(state, source, index, ability, set.ref.from)) {
          return;
        }
        pending.push({
          source,
          controller,
          ability: { kind: 'triggered', index, ...set.ref },
        });
      });
    }
  }

  return pending;
}

/**
 * Rule 383.3.e: an ability that triggers "N times each turn" stops triggering
 * once it has been performed that many times.
 *
 * Counted per source entity and ability index, and cleared at end of turn.
 */
export function withinTurnLimit(
  state: GameState,
  source: EntityId,
  index: number,
  ability: TriggeredAbility,
  from?: EntityId | undefined,
): boolean {
  const limit = ability.limitPerTurn;
  if (limit === undefined) {
    return true;
  }
  return (state.triggersUsed[triggerKey(source, index, from)] ?? 0) < limit;
}

/**
 * Stable key for the per-turn trigger counter.
 *
 * `from` is part of it because 718.3 can give one Unit abilities from several
 * Gear, and two of them at the same index would otherwise share a counter —
 * one "once each turn" would silently spend the other's use.
 */
export function triggerKey(source: EntityId, index: number, from?: EntityId | undefined): string {
  return from === undefined ? `${source}:${index}` : `${source}:${from}:${index}`;
}

/** Everything `player` controls that is on the Board (rule 380). */
function boardEntities(state: GameState, player: PlayerId): EntityId[] {
  const found: EntityId[] = [];
  const seat = state.players[player];
  if (seat !== undefined) {
    found.push(...seat.zones.base, ...seat.zones.legendZone);
  }
  for (const battlefield of state.battlefields) {
    // 170.9-170.10: Battlefields can carry Triggered and Activated abilities,
    // and they belong to whoever Controls the Battlefield — every one the
    // corpus prints speaks of holding or conquering it. An Uncontrolled
    // Battlefield (170.11.b) therefore offers nobody its abilities.
    //
    // Its *Passive* abilities are a different matter and are swept by
    // `activeStatics` regardless of Control: "Units here have +1 Might" is a
    // property of the Location (170.5), not of who holds it.
    if (battlefield.controller === player) {
      found.push(battlefield.entity);
    }
    for (const unit of battlefield.units) {
      if (getEntity(state, unit).controller === player) {
        found.push(unit);
      }
    }
  }
  return found;
}

/** Turn order starting from the Turn Player (rule 383.3.d.1). */
function turnOrder(state: GameState): PlayerId[] {
  const count = state.players.length;
  return Array.from({ length: count }, (_, offset) => ((state.activePlayer + offset) % count) as PlayerId);
}
