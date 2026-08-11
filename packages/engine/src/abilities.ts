/**
 * Activated and Triggered abilities (rules 376-395).
 *
 * The split of responsibilities mirrors card effects: the ability data lives in
 * `@riftbound/cards`, and this decides when one may be activated, which ones a
 * game event triggers, and in what order they reach the Chain. Executing the
 * effect itself is still `effects.ts` — an ability's effect is an effect.
 */
import {
  activatedAbilities,
  triggeredAbilities,
  type AbilityRef,
  type ActivatedAbility,
  type TriggerCondition,
  type TriggeredAbility,
} from '@riftbound/cards';

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

/** Resolve a Chain item's ability back to its definition. */
export function abilityFor(
  state: GameState,
  source: EntityId,
  ref: AbilityRef,
): ActivatedAbility | TriggeredAbility | undefined {
  const card = entityCard(state, source);
  return ref.kind === 'activated'
    ? activatedAbilities(card.abilities)[ref.index]
    : triggeredAbilities(card.abilities)[ref.index];
}

/**
 * Every Activated Ability `player` may use right now (rules 376-381).
 *
 * Three gates, all from the rules rather than convenience:
 * - 381: the controller's own turn, and an Open State only.
 * - 380: the source is on the Board.
 * - 377: the cost is payable, including exhausting the source when that is
 *   part of it (414).
 */
export function activatableAbilities(
  state: GameState,
  player: PlayerId,
): readonly { readonly source: EntityId; readonly index: number; readonly ability: ActivatedAbility }[] {
  // 381: "only ... on the Controlling Player's Turn and during an Open State".
  if (state.activePlayer !== player || isClosed(state) || state.showdown !== null) {
    return [];
  }

  const found: { source: EntityId; index: number; ability: ActivatedAbility }[] = [];
  for (const source of boardEntities(state, player)) {
    const entity = getEntity(state, source);
    const abilities = activatedAbilities(entityCard(state, source).abilities);

    abilities.forEach((ability, index) => {
      // 414: an exhaust cost cannot be paid by something already exhausted.
      if (ability.exhaustSelf === true && entity.exhausted) {
        return;
      }
      if (!canPay(getPlayer(state, player).pool, ability.cost)) {
        return;
      }
      found.push({ source, index, ability });
    });
  }
  return found;
}

/**
 * Triggered Abilities that `condition` fires, in the order they go on the Chain.
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
  condition: TriggerCondition,
  options: {
    /** Restrict to sources controlled by this player, e.g. an end-of-*your*-turn trigger. */
    readonly controller?: PlayerId | undefined;
    /** Restrict to these sources, for a condition about specific entities. */
    readonly sources?: readonly EntityId[] | undefined;
    /** Battlefield index, for a Battlefield-scoped condition such as Conquer. */
    readonly battlefield?: number | undefined;
  } = {},
): readonly PendingTrigger[] {
  // Candidates as (source, controller) pairs, gathered once. Gathering them
  // per player instead would emit an explicitly-passed source once per seat.
  const candidates: { source: EntityId; controller: PlayerId }[] = [];

  if (options.sources !== undefined) {
    for (const source of options.sources) {
      const entity = state.entities[source];
      if (entity === undefined) {
        continue;
      }
      candidates.push({ source, controller: options.controller ?? entity.controller });
    }
  } else {
    for (const seat of state.players) {
      if (options.controller !== undefined && seat.id !== options.controller) {
        continue;
      }
      for (const source of boardEntities(state, seat.id)) {
        candidates.push({ source, controller: seat.id });
      }
    }
    for (const source of battlefieldCards(state, options.battlefield)) {
      candidates.push({ source, controller: getEntity(state, source).controller });
    }
  }

  // 383.3.d.1: each player orders their own, starting with the Turn Player and
  // proceeding in turn order. Array.prototype.sort is stable, so the fixed
  // within-player order below survives this.
  const order = turnOrder(state);
  candidates.sort(
    (a, b) => order.indexOf(a.controller) - order.indexOf(b.controller),
  );

  const pending: PendingTrigger[] = [];
  for (const { source, controller } of candidates) {
    triggeredAbilities(entityCard(state, source).abilities).forEach((ability, index) => {
      if (ability.condition.kind !== condition.kind) {
        return;
      }
      if (!withinTurnLimit(state, source, index, ability)) {
        return;
      }
      pending.push({ source, controller, ability: { kind: 'triggered', index } });
    });
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
): boolean {
  const limit = ability.limitPerTurn;
  if (limit === undefined) {
    return true;
  }
  return (state.triggersUsed[triggerKey(source, index)] ?? 0) < limit;
}

/** Stable key for the per-turn trigger counter. */
export function triggerKey(source: EntityId, index: number): string {
  return `${source}:${index}`;
}

/** Everything `player` controls that is on the Board (rule 380). */
function boardEntities(state: GameState, player: PlayerId): EntityId[] {
  const found: EntityId[] = [];
  const seat = state.players[player];
  if (seat !== undefined) {
    found.push(...seat.zones.base, ...seat.zones.legendZone);
  }
  for (const battlefield of state.battlefields) {
    for (const unit of battlefield.units) {
      if (getEntity(state, unit).controller === player) {
        found.push(unit);
      }
    }
  }
  return found;
}

/**
 * Battlefield cards are not entities, so a Battlefield's own Triggered Ability
 * has no entity to hang off. Returns nothing today; the hook is here so the
 * one place that would need it is obvious when Battlefield abilities land.
 */
function battlefieldCards(_state: GameState, _battlefield: number | undefined): EntityId[] {
  return [];
}

/** Turn order starting from the Turn Player (rule 383.3.d.1). */
function turnOrder(state: GameState): PlayerId[] {
  const count = state.players.length;
  return Array.from({ length: count }, (_, offset) => ((state.activePlayer + offset) % count) as PlayerId);
}
