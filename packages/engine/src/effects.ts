/**
 * Executing card effects.
 *
 * Effects are data (see `@riftbound/cards`), and this is the interpreter. Adding
 * a new primitive means a case here and a variant there — not a new code path
 * per card, which is the whole point of the data-driven design.
 */
import {
  NO_TARGET,
  anyPowerOf,
  costOf,
  isPlayable,
  needsTargetChoice,
  targetCount,
  tokenCardId,
  type Cost,
  type GuardedEffect,
} from '@riftbound/cards';
import type {
  CardEffect,
  Count,
  DestinationSpec,
  Effect,
  ObjectFilter,
  TargetSpec,
} from '@riftbound/cards';

import type { TriggerEventInstance } from './abilities.js';
import { attach, detach, equipAbilityOf } from './attach.js';
import { actualMightOf, mightOf } from './combat.js';
import { conditionMet } from './condition.js';
import { abilityCost } from './costs.js';
import { countOf } from './count.js';
import type { GameEvent } from './events.js';
import { moveEntity, withEntity, withPlayer } from './mutate.js';
import { canPay, payFrom, validUnitLocations } from './play.js';
import {
  bonusDamage,
  entersReady,
  objectForbidden,
  playerForbidden,
  unitKeywordValue,
} from './statics.js';
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
  /**
   * The chosen Targets (355.6). A list because one spec may choose several;
   * a card naming one target holds a list of one, and a card naming none holds
   * an empty list.
   */
  readonly targets?: readonly EntityId[] | undefined;
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
   * The Game Object the triggering event was about, for a `triggerObject`
   * target — "When a friendly unit dies, buff **it**".
   *
   * Carried rather than looked up, because by resolution the event is over:
   * the Unit that died is in the trash and the Move has been superseded. The
   * same reasoning as `noted`, and set at the same moment.
   */
  readonly triggerObject?: EntityId | undefined;
  /**
   * 424: the cards this effect's generator looked at, for a `revealed` target
   * and for "recycle the rest".
   *
   * Noted rather than moved — 424.1.a.2 leaves them in the deck — so a card
   * that has since gone elsewhere is simply no longer among them.
   */
  readonly revealed?: readonly EntityId[] | undefined;
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
    /** 446: where each Unit started, for "when I move from a battlefield". */
    origins?: ReadonlyMap<EntityId, number>,
  ) => GameState;
  /**
   * Rule 383.2: announce that something happened, so Triggered Abilities
   * watching for it reach the Chain.
   *
   * Supplied rather than done here for the same reason as `queueDeaths`: this
   * layer executes effects and the Chain lives above it.
   */
  /**
   * 390.5: put a Delayed Linked Ability on the Chain, carrying the cards its
   * generator looked at.
   *
   * Supplied rather than done here for the same reason `raise` is: this layer
   * executes effects and the Chain lives above it.
   */
  readonly queueLinked: (
    state: GameState,
    controller: PlayerId,
    source: EntityId,
    effect: CardEffect,
    revealed: readonly EntityId[],
    revealedToAll: boolean,
    events: GameEvent[],
  ) => GameState;
  readonly raise: (
    state: GameState,
    instance: TriggerEventInstance,
    events: GameEvent[],
  ) => GameState;
}

/** Every Power pip a printed cost demands, `[A]` included (135.2.e). */
function totalPowerOf(cost: Cost | undefined): number {
  return cost === undefined ? 0 : cost.power.length + anyPowerOf(cost);
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
  /** The effect's source, for the source-relative `here` and `excludeSelf`. */
  source?: EntityId | undefined,
  /** 424: the cards this effect's generator looked at (390.5). */
  revealed?: readonly EntityId[] | undefined,
): EntityId[] {
  // 390.5: one of the cards the generating look revealed. The set exists only
  // on the Chain item, which is why it is passed in rather than swept for.
  if (spec.kind === 'revealed') {
    return (revealed ?? []).filter((card) => {
      if (state.entities[card] === undefined) {
        return false;
      }
      return (
        spec.cardTypes === undefined || spec.cardTypes.includes(entityCard(state, card).type)
      );
    });
  }

  // "A unit from your trash" — a card in a Non-Board Zone, not a Game Object on
  // the Board, so this walks the trash rather than the Battlefields and Bases.
  if (spec.kind === 'trashCard') {
    return getPlayer(state, controller).zones.trash.filter((card) => {
      const definition = entityCard(state, card);
      if (spec.cardTypes !== undefined && !spec.cardTypes.includes(definition.type)) {
        return false;
      }
      // 356.1.c: "costs no more than 3" reads the *printed* cost, never what it
      // happened to cost to play — the same reading `chainItem` takes.
      const cost = costOf(definition);
      if (spec.maxEnergy !== undefined && (cost?.energy ?? 0) > spec.maxEnergy) {
        return false;
      }
      if (spec.maxPower !== undefined && (cost?.power.length ?? 0) > spec.maxPower) {
        return false;
      }
      return true;
    });
  }

  // 425.3: "a card or ability on the chain". 359.2 takes a Permanent off the
  // Chain the moment it is Finalized, so what lingers is Spells and abilities —
  // and an ability is named by its *source*, which may still be on the Board.
  if (spec.kind === 'chainItem') {
    const found: EntityId[] = [];
    for (const item of state.chain) {
      // A card cannot Counter itself: it is the item resolving, and 425.1
      // negates "the execution … of a card or ability by a player".
      if (item.entity === source) {
        continue;
      }
      const card = entityCard(state, item.entity);
      // An ability has no card of its own (377.3.a.1), so a `cardType` filter
      // names a played card and only a played card.
      if (spec.cardType !== undefined && (item.ability !== null || card.type !== spec.cardType)) {
        continue;
      }
      // 356.1.c: "Base Cost" is the printed cost, never the modified one.
      const printed = isPlayable(card) ? card.cost : undefined;
      if (spec.maxEnergy !== undefined && (printed?.energy ?? 0) > spec.maxEnergy) {
        continue;
      }
      if (spec.maxPower !== undefined && totalPowerOf(printed) > spec.maxPower) {
        continue;
      }
      found.push(item.entity);
    }
    return found;
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

  // 355.9's "here": the source's own Battlefield, and none at all when the
  // source is not at one. Judged once rather than per candidate.
  let here: number | undefined;
  if (spec.here === true) {
    const location = source === undefined ? undefined : getEntity(state, source).location;
    if (location?.kind !== 'battlefield') {
      return [];
    }
    here = location.index;
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
      if (here !== undefined) {
        const at = getEntity(state, unit).location;
        if (at.kind !== 'battlefield' || at.index !== here) {
          return false;
        }
      }
      // "another": never the source itself.
      if (spec.excludeSelf === true && unit === source) {
        return false;
      }
      // 143: the bound is on *effective* Might, which is what the card asks
      // about when the choice is made. 358.1 re-checks it on resolution.
      if (spec.maxMight !== undefined && mightOf(state, unit) > spec.maxMight) {
        return false;
      }
      const owner = getEntity(state, unit).controller;
      if (spec.scope === 'friendly' && owner !== controller) {
        return false;
      }
      if (spec.scope === 'enemy' && owner === controller) {
        return false;
      }
      // 355.6 with rule 002: "I can't be chosen by enemy spells and abilities"
      // removes the choice rather than pricing it, which is what separates it
      // from Deflect (809). Its own controller may still choose it.
      if (owner !== controller && objectForbidden(state, unit, 'chosenByOpponent')) {
        return false;
      }
      return matchesFilter(state, unit, spec.filter);
    })
    .map(({ unit }) => unit);
}

/**
 * Does this Game Object match the spec's narrowing (see `ObjectFilter`)?
 *
 * One implementation for both sweeps: `legalTargets` asks it when the choice
 * is made (355.6) and `allTargets` when the effect resolves (355.5.a), and the
 * two must never disagree about what "damaged" means.
 */
function matchesFilter(
  state: GameState,
  id: EntityId,
  filter: ObjectFilter | undefined,
): boolean {
  if (filter === undefined) {
    return true;
  }
  const entity = getEntity(state, id);
  if (filter.damaged !== undefined && entity.damage > 0 !== filter.damaged) {
    return false;
  }
  if (filter.exhausted !== undefined && entity.exhausted !== filter.exhausted) {
    return false;
  }
  if (filter.stunned !== undefined && entity.stunned !== filter.stunned) {
    return false;
  }
  if (filter.buffed !== undefined && entity.buffs > 0 !== filter.buffed) {
    return false;
  }
  // 133.8. The export carries no tags, so this matches nothing today and the
  // shortfall is recorded as a gap rather than hidden by refusing the clause.
  if (filter.tag !== undefined && !entityCard(state, id).tags.includes(filter.tag)) {
    return false;
  }
  return true;
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
    if (!matchesFilter(state, id, spec.filter)) {
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
    case 'play':
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

/**
 * Every legal set of Targets for a card's *whole* choice — both slots (355.5).
 *
 * The product of the two, because 355.8 wants every choice settled before the
 * card reaches the Chain and the two are independent except for
 * `second.sameLocation`.
 */
export function allTargetChoices(
  state: GameState,
  player: PlayerId,
  effect: CardEffect | undefined,
  source: EntityId,
  filter?: (target: EntityId) => boolean,
  revealed?: readonly EntityId[],
): readonly (readonly EntityId[])[] {
  const first = targetChoices(state, player, effect?.target, source, filter, revealed);
  const second = effect?.second;
  if (second === undefined) {
    return first;
  }
  const pairs: EntityId[][] = [];
  for (const one of first) {
    for (const two of targetChoices(state, player, second, source, filter, revealed)) {
      // 355.6 chooses distinct objects, across the slots as much as within one.
      if (two.some((id) => one.includes(id))) {
        continue;
      }
      // "at the same battlefield": a constraint between the slots, which is
      // why it is asked here rather than inside either sweep.
      if (
        second.kind === 'unit' &&
        second.sameLocation === true &&
        !shareLocation(state, one, two)
      ) {
        continue;
      }
      pairs.push([...one, ...two]);
    }
  }
  return pairs;
}

/** Are every one of these Game Objects at the same Location (355.9)? */
function shareLocation(
  state: GameState,
  first: readonly EntityId[],
  second: readonly EntityId[],
): boolean {
  const at = first[0] === undefined ? undefined : state.entities[first[0]]?.location;
  if (at?.kind !== 'battlefield') {
    return false;
  }
  return [...first, ...second].every((id) => {
    const where = state.entities[id]?.location;
    return where?.kind === 'battlefield' && where.index === at.index;
  });
}

/**
 * Every legal set of Targets for one spec (rule 355.6).
 *
 * A spec that chooses nothing yields one empty set, so callers take the
 * product with destinations without a special case. A counted spec yields
 * every combination within its bounds — `min` below `max` is "up to N", where
 * choosing fewer is itself a legal choice.
 *
 * Order within a set does not matter and is fixed by `legalTargets`, so the
 * combinations are generated by index and never permuted: two actions offering
 * the same two Units in different orders would be the same choice twice.
 */
export function targetChoices(
  state: GameState,
  player: PlayerId,
  spec: TargetSpec | undefined,
  source: EntityId,
  filter?: (target: EntityId) => boolean,
  /** 424: the cards a Linked Ability's generator looked at (390.5). */
  revealed?: readonly EntityId[],
): readonly (readonly EntityId[])[] {
  if (!needsTargetChoice(spec)) {
    return [[]];
  }
  const pool = legalTargets(state, player, spec as TargetSpec, source, revealed).filter(
    (one) => filter === undefined || filter(one),
  );
  const { min, max } = targetCount(spec);
  const sets: EntityId[][] = [];
  const build = (start: number, chosen: EntityId[]): void => {
    if (chosen.length >= min) {
      sets.push([...chosen]);
    }
    if (chosen.length === max) {
      return;
    }
    for (let i = start; i < pool.length; i += 1) {
      const one = pool[i];
      if (one === undefined) {
        continue;
      }
      chosen.push(one);
      build(i + 1, chosen);
      chosen.pop();
    }
  };
  build(0, []);
  return sets;
}

/**
 * Whether a card's *whole* choice is still valid across both slots (358.1).
 *
 * Split at the first slot's count, because that is what fixed the arrival
 * order: `allTargetChoices` concatenates slot 0's set and slot 1's.
 */
export function isValidChoice(
  state: GameState,
  controller: PlayerId,
  effect: CardEffect | undefined,
  targets: readonly EntityId[] | undefined,
  source?: EntityId | undefined,
  revealed?: readonly EntityId[] | undefined,
): boolean {
  const spec = effect?.target;
  const second = effect?.second;
  if (second === undefined) {
    return isValidTarget(state, controller, spec ?? NO_TARGET, targets, source, revealed);
  }
  const chosen = targets ?? [];
  const { min, max } = targetCount(spec);
  // A slot whose bounds differ would make the split ambiguous, and no card
  // prints one: "a friendly unit and an enemy unit" is one each.
  if (min !== max) {
    return false;
  }
  const first = chosen.slice(0, min);
  const rest = chosen.slice(min);
  if (!isValidTarget(state, controller, spec ?? NO_TARGET, first, source, revealed)) {
    return false;
  }
  if (!isValidTarget(state, controller, second, rest, source, revealed)) {
    return false;
  }
  // 355.6 chooses distinct objects, across the slots as much as within one.
  if (new Set(chosen).size !== chosen.length) {
    return false;
  }
  if (second.kind === 'unit' && second.sameLocation === true) {
    const at = first[0] === undefined ? undefined : getEntity(state, first[0]).location;
    if (at?.kind !== 'battlefield') {
      return false;
    }
    if (
      !rest.every((id) => {
        const where = state.entities[id]?.location;
        return where?.kind === 'battlefield' && where.index === at.index;
      })
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the chosen Targets are still valid (rule 358.1, the Check Legality
 * step).
 *
 * Every member is checked, because 355.6 makes each one a Target in its own
 * right — a set with one invalid member is not a partially legal choice.
 */
export function isValidTarget(
  state: GameState,
  controller: PlayerId,
  spec: TargetSpec,
  targets: readonly EntityId[] | undefined,
  source?: EntityId | undefined,
  /** 424: the cards a Linked Ability's generator looked at (390.5). */
  revealed?: readonly EntityId[] | undefined,
): boolean {
  const chosen = targets ?? [];
  // A self-targeting card takes no chosen target; supplying one is an error,
  // not a different reading.
  if (!needsTargetChoice(spec)) {
    return chosen.length === 0;
  }
  const { min, max } = targetCount(spec);
  if (chosen.length < min || chosen.length > max) {
    return false;
  }
  // 355.6 chooses distinct objects: naming one twice would apply the effect to
  // it twice from a single choice.
  if (new Set(chosen).size !== chosen.length) {
    return false;
  }
  const legal = legalTargets(state, controller, spec, source, revealed);
  return chosen.every((one) => legal.includes(one));
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

  // 355.6 is about *choosing*; neither "me" nor "it" is a choice, so both are
  // resolved here rather than enumerated when the card was played.
  const choices: EffectChoices =
    effect.target.kind === 'self'
      ? { ...invocation.choices, targets: [invocation.source] }
      : effect.target.kind === 'triggerObject'
        ? {
            ...invocation.choices,
            // An object that has left the Board resolves to nothing rather
            // than to a stale id: 705 strips a departed Unit's counters and
            // most verbs check `onBoard` anyway, but an empty set says it once.
            targets:
              invocation.triggerObject === undefined ? [] : [invocation.triggerObject],
          }
        : invocation.choices;

  // 820.1.d: Repeat executes "the instructions of this chain item one
  // additional time" when its optional Additional Cost was paid. Two runs of
  // the same steps rather than a doubled amount, because the instructions may
  // be anything — a Token creation, a draw, a Move.
  //
  // 820.2.a lets the second execution make *different* choices. This engine
  // settles every choice when the card is played (355.8), so both runs use the
  // one set: narrower than printed rather than wrong, the same direction every
  // other choice simplification takes.
  const runs = effect.repeat === true && invocation.paidAdditionalCost === true ? 2 : 1;

  let next = state;
  for (let run = 0; run < runs; run += 1) {
    next = executeOnce(next, invocation, effect, choices, events, context);
  }
  return next;
}

/** One execution of a card's instructions — see 820.1.d for why this is separate. */
function executeOnce(
  state: GameState,
  invocation: EffectInvocation,
  effect: CardEffect,
  choices: EffectChoices,
  events: GameEvent[],
  context: EffectContext,
): GameState {
  let next = state;
  // Every step's guard is asked against the state as it was on entry, so an
  // "otherwise" cannot see what the branch above it did. A step reading an
  // earlier step's *outcome* is a different mechanic — see `GuardedEffect`.
  //
  // "On entry" is per execution: a Repeat's second run reads the board its
  // first run left, which is what running the instructions again means.
  const before = next;
  const guarded = (step: GuardedEffect, target: EntityId | undefined): boolean =>
    conditionMet(before, invocation.controller, invocation.source, step.condition, {
      ...(invocation.paidAdditionalCost === undefined
        ? {}
        : { paidAdditionalCost: invocation.paidAdditionalCost }),
      ...(target === undefined ? {} : { target }),
    });

  for (const step of effect.effects) {
    // A target-consuming step runs once per object; a step that takes no
    // target — a draw, a Score — runs once whatever the spec chose. That is
    // one rule covering two different ways to reach a set: 355.5.a's criteria,
    // which choose nothing and are enumerated here at resolution, and a
    // counted spec, whose set was chosen when the card was played.
    if (consumesTarget(step.kind)) {
      const every =
        effect.target.kind === 'all'
          ? allTargets(
              next,
              invocation.controller,
              effect.target,
              invocation.source,
              invocation.noted,
            )
          : (choices.targets ?? []);
      // A spec that chooses nothing at all still runs its steps once, with no
      // target — "draw 1" is not skipped for want of one.
      if (every.length === 0 && effect.target.kind !== 'all') {
        if (guarded(step, undefined)) {
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
        continue;
      }
      for (const one of every) {
        if (!guarded(step, one)) {
          continue;
        }
        next = applyEffect(
          next,
          invocation.controller,
          invocation.source,
          step,
          { ...choices, targets: [one] },
          events,
          context,
          invocation.noted,
          invocation.revealed,
        );
      }
      continue;
    }
    if (!guarded(step, choices.targets?.[0])) {
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
      invocation.revealed,
    );
  }
  return next;
}

/**
 * What a dynamic amount multiplies by (see `Count`).
 *
 * `mightOf` and `unitKeywordValue` are safe to consult from here: an effect
 * *executes*, and neither of them consults an executing effect back. That is
 * exactly the asymmetry that keeps the same counts out of a static's grant.
 */
function scale(
  state: GameState,
  controller: PlayerId,
  source: EntityId | undefined,
  per: Count | undefined,
): number {
  return per === undefined
    ? 1
    : countOf(state, controller, source, per, mightOf, (at, unit, keyword) =>
        unitKeywordValue(at, unit, keyword),
      );
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
  /** 424: the cards this effect's generator looked at (390.5). */
  invocationRevealed: readonly EntityId[] = [],
): GameState {
  const target = choices.targets?.[0];
  switch (effect.kind) {
    case 'draw': {
      // "Draw 1 for each of your MIGHTY units": the printed number is per-unit,
      // so the count multiplies it. `mightOf` is safe to consult here — an
      // effect executes, it is not something `mightOf` consults back.
      const times = scale(state, controller, source, effect.per);
      return context.drawCards(state, controller, effect.count * times, events);
    }

    case 'dealDamage': {
      if (target === undefined || !onBoard(state, target)) {
        return state;
      }
      // "Deal damage equal to my Might": the printed number is per-thing and
      // the count scales it, exactly as `draw`'s does.
      const dealt = effect.amount * scale(state, controller, source, effect.per);
      // 417.1.e: only a positive amount is Valid Damage, and only Valid Damage
      // is Dealt. 715.4 hangs off the same check — no damage Dealt means no
      // Bonus Damage either.
      if (dealt < 1) {
        return state;
      }
      // 715.2: Bonus Damage applies to each target of a multi-target Deal
      // individually, which is what asking here — inside the per-target loop —
      // gives for free.
      const total = dealt + bonusDamage(state, controller, target);
      events.push({ type: 'damageDealt', unit: target, amount: total });
      return withEntity(state, target, (current) => ({
        ...current,
        damage: current.damage + total,
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
      // "to a minimum of 1 Might": the reduction stops at the floor rather than
      // continuing past it. 143.2.b.1 makes that a comparison against the
      // *actual* Might — a Unit already below the floor keeps its value rather
      // than being raised to it, which is what clamping to `>= 0` would do.
      let amount = effect.amount * scale(state, controller, source, effect.per);
      if (effect.minimum !== undefined && amount < 0) {
        const room = actualMightOf(state, target) - effect.minimum;
        amount = Math.min(0, Math.max(amount, -Math.max(0, room)));
      }
      if (amount === 0) {
        return state;
      }
      events.push({ type: 'mightGranted', unit: target, amount });
      return withEntity(state, target, (current) => ({
        ...current,
        mightBonus: current.mightBonus + amount,
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
      // 419 with rule 002: "Spells and abilities can't ready enemy units and
      // gears". Checked when the effect *runs* rather than when the target is
      // chosen, because it forbids the readying rather than the choosing —
      // 358.1's re-check is exactly this kind of question.
      if (objectForbidden(state, target, 'readyByEffect')) {
        return state;
      }
      // 415.1.c: readying something already ready does nothing, so the event is
      // raised on the *change* — the same rule `stun` follows for 423.1.a.1.
      if (!getEntity(state, target).exhausted) {
        return state;
      }
      return context.raise(
        withEntity(state, target, (current) => ({ ...current, exhausted: false })),
        { event: 'ready', actor: controller, objects: [target] },
        events,
      );
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
      let moved = 0;
      for (let i = 0; i < Math.max(0, effect.count); i += 1) {
        const top = getPlayer(next, controller).zones.mainDeck[0];
        if (top === undefined) {
          break;
        }
        next = moveEntity(next, top, playerLocation(controller, 'mainDeck'), 'bottom');
        moved += 1;
      }
      // 416: "when you recycle one or more cards" is one event however many
      // moved, and none at all when the deck had nothing left (436.4.a).
      return moved === 0
        ? next
        : context.raise(next, { event: 'recycle', actor: controller }, events);
    }

    // 467-471: gain points outright. 471.1.a.1 exempts this from the Final
    // Point restriction, which is Conquer's alone, so there is no condition to
    // check — the win is then decided at the next Cleanup by 323.1.
    case 'score': {
      const amount = Math.max(0, effect.amount);
      if (amount === 0) {
        return state;
      }
      // Rule 002: "opponents can't score points" binds every source of points,
      // not only Conquer and Hold — 471.1.a.1's exemption is about the Final
      // Point restriction, not about a card that forbids scoring outright.
      if (playerForbidden(state, controller, 'score')) {
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
      return context.raise(
        withEntity(state, target, (current) => ({ ...current, buffs: current.buffs - 1 })),
        { event: 'spendBuff', actor: controller, objects: [target] },
        events,
      );
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
      // 446: noted before the move, because afterwards it is at `destination`.
      const from = getEntity(state, target).location;
      const origins =
        from.kind === 'battlefield' ? new Map([[target, from.index]]) : new Map<EntityId, number>();
      const moved = moveEntity(state, target, destination);
      events.push({
        type: 'unitsMoved',
        player: controller,
        units: [target],
        battlefield: destination.kind === 'battlefield' ? destination.index : null,
      });
      return context.afterMove(moved, controller, destination, [target], events, origins);
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

    /**
     * "They deal damage equal to their Mights to each other" (417, 143).
     *
     * Both amounts are read *before* either is applied, which is 465.2.c.1.a's
     * reading of Combat carried over: a Unit that dies to the exchange still
     * dealt its damage. Consumes no target — it reads the pair — so looping it
     * would have each damage the other twice.
     */
    case 'mutualDamage': {
      const pair = effect.self === true ? [source, target] : [target, choices.targets?.[1]];
      const [left, right] = pair;
      if (left === undefined || right === undefined) {
        return state;
      }
      if (!onBoard(state, left) || !onBoard(state, right)) {
        return state;
      }
      const toRight = mightOf(state, left);
      const toLeft = mightOf(state, right);
      let next = state;
      // 417.1.e: only a positive amount is Valid Damage.
      if (toRight > 0) {
        events.push({ type: 'damageDealt', unit: right, amount: toRight });
        next = withEntity(next, right, (current) => ({
          ...current,
          damage: current.damage + toRight,
        }));
      }
      if (toLeft > 0) {
        events.push({ type: 'damageDealt', unit: left, amount: toLeft });
        next = withEntity(next, left, (current) => ({
          ...current,
          damage: current.damage + toLeft,
        }));
      }
      return next;
    }

    /**
     * 424 with 390.5: look at (or reveal) the top cards, then queue the Linked
     * Ability that acts on them.
     *
     * 424.1.a.2 keeps the cards where they are, so nothing moves here: the set
     * is noted onto the Chain item, and the choice among it is made at 402.2
     * through the machinery a Triggered Ability already uses.
     *
     * 431.1.c: running short looks at as many as possible and is explicitly
     * **not** a Burn Out — which is why this takes what it can and stops.
     */
    case 'look': {
      const deck = getPlayer(state, controller).zones.mainDeck;
      const looked: EntityId[] = [];
      for (const card of deck) {
        if (looked.length >= Math.max(0, effect.count)) {
          break;
        }
        looked.push(card);
        // "Reveal cards … until you reveal a unit": the count is a cap, and
        // the first match ends the look.
        if (effect.until !== undefined && entityCard(state, card).type === effect.until) {
          break;
        }
      }
      if (looked.length === 0) {
        return state;
      }
      events.push({
        type: 'cardsLookedAt',
        player: controller,
        count: looked.length,
        revealed: effect.reveal === true,
      });
      return context.queueLinked(
        state,
        controller,
        source,
        effect.then,
        looked,
        effect.reveal === true,
        events,
      );
    }

    // 416.1: to the bottom of its *owner's* Main Deck — 416.1.c is explicit
    // that each player Recycles to their own deck however the instruction read.
    case 'recycle': {
      if (target === undefined || state.entities[target] === undefined) {
        return state;
      }
      const owner = getEntity(state, target).controller;
      return sendToNonBoardZone(state, target, playerLocation(owner, 'mainDeck'), 'bottom');
    }

    // "Then recycle the rest": everything looked at that was not chosen. The
    // complement of a choice, which no `TargetSpec` can name.
    case 'recycleRest': {
      const chosen = new Set(choices.targets ?? []);
      let next = state;
      for (const card of invocationRevealed) {
        if (chosen.has(card) || next.entities[card] === undefined) {
          continue;
        }
        const owner = getEntity(next, card).controller;
        next = sendToNonBoardZone(next, card, playerLocation(owner, 'mainDeck'), 'bottom');
      }
      return next;
    }

    /**
     * 354 with 355.2: play the chosen card out of the trash.
     *
     * Rule 354 moves a card to the Chain "from its current zone", so this is
     * the ordinary Process of Play with a different starting zone. The engine's
     * documented simplification carries: 359.2 takes a Permanent off the Chain
     * the instant it is Finalized, so a Unit reaches the Board atomically and
     * no player can respond in between.
     *
     * Only a Permanent is supported. A Spell played this way would linger on
     * the Chain (359.3) and make its own choices there, which is a decision
     * point during resolution the engine does not have — so the parser refuses
     * that wording rather than resolving it into nothing.
     */
    case 'play': {
      if (target === undefined) {
        return state;
      }
      const definition = entityCard(state, target);
      if (definition.type !== 'unit' && definition.type !== 'gear') {
        return state;
      }
      // 355.2: the Location was chosen alongside the target. A Gear has none —
      // 359.2.d puts it at its controller's Base.
      const entersAt =
        definition.type === 'gear'
          ? playerLocation(controller, 'base')
          : (choices.destination ?? playerLocation(controller, 'base'));
      // 359.2.c: a Unit enters exhausted; 359.2.d: a Gear enters ready. A
      // static saying "I enter ready" replaces the first (363), and is asked
      // *before* the move for the reason `playCard` asks it there.
      const ready = definition.type === 'gear' || entersReady(state, controller, definition);
      let next = moveEntity(state, target, entersAt);
      next = withEntity(next, target, (current) => ({ ...current, exhausted: !ready }));
      events.push({ type: 'cardPlayed', player: controller, entity: target, onChain: false });
      // 383.4.a: the card was Finalized and entered the Board, so everything
      // watching a play sees it — including its own Play Effect.
      return context.raise(
        next,
        {
          event: 'played',
          actor: controller,
          objects: [target],
          ...(entersAt.kind === 'battlefield' ? { battlefield: entersAt.index } : {}),
        },
        events,
      );
    }

    /**
     * 390.4: register a Delayed Passive Ability for the rest of this turn.
     *
     * Nothing is written onto any Game Object — a Passive is *consulted*, and
     * that discipline is what makes the window work: 317.2.c drops the entry
     * and every effect it was having stops at once, with nothing to unwind.
     */
    case 'thisTurn': {
      return {
        ...state,
        turnEffects: [
          ...state.turnEffects,
          {
            source,
            controller,
            ...(effect.static === undefined ? {} : { ability: effect.static }),
            ...(effect.costModifier === undefined ? {} : { costModifier: effect.costModifier }),
            uses: effect.uses ?? null,
          },
        ],
      };
    }

    // 180-184: Create Tokens. Not a Move and not a play from hand — a Token is
    // Created directly on the Board (186), so nothing is Contested and no
    // Showdown opens. A card that wants the token to arrive fighting says
    // "play … here", which is `where: 'here'` resolved against the source.
    // 425: negate a Chain item. 425.1.a clears it and 425.1.a.1 sends a cleared
    // *card* to the trash — an ability has none, so its source stays put, the
    // same asymmetry an ability resolving normally has (377.3.a.1).
    //
    // 425.1.b needs no code and is the point of doing it here rather than by
    // resolving the item into nothing: the `played` event was raised when the
    // card went on the Chain and this raises none, so a Countered card was
    // never played for anything that watches.
    case 'counter': {
      if (target === undefined) {
        return state;
      }
      const index = state.chain.findIndex((item) => item.entity === target);
      if (index < 0) {
        return state;
      }
      const item = state.chain[index] as (typeof state.chain)[number];
      const next: GameState = {
        ...state,
        chain: [...state.chain.slice(0, index), ...state.chain.slice(index + 1)],
      };
      events.push({ type: 'countered', entity: target, controller: item.controller });
      return item.ability === null
        ? sendToNonBoardZone(next, target, playerLocation(getEntity(next, target).owner, 'trash'))
        : next;
    }

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
  // 355.2.a: a Unit played by an effect enters the controller's Base or a
  // Battlefield they Control — a narrower set than a Move's destinations, and
  // the same one `playCard` uses for a Unit played from hand.
  if (spec.kind === 'unitEntry') {
    return [...validUnitLocations(state, controller)];
  }
  const battlefields = state.battlefields.map((_battlefield, index) => battlefieldLocation(index));
  // 449.1: an unstated Destination is any of them, Base included.
  return spec.kind === 'any' ? [playerLocation(controller, 'base'), ...battlefields] : battlefields;
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
