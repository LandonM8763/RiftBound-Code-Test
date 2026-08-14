/**
 * Determining Total Cost (rule 356).
 *
 * Step 3 of the Process of Play. The rule is a sequence of layers, and the
 * order between them is not negotiable: base-cost modifications (356.1), then
 * additional costs (356.2, absent — see `cost-modifier.ts`), then increases
 * (356.3), then discounts (356.4), then modifications to the total (356.5),
 * with Energy and Power floored at 0 throughout (356.6).
 *
 * Applying them in any other order gives different answers, which is why the
 * layer is carried in the data rather than inferred from where a modifier was
 * found.
 */
import {
  anyPowerOf,
  isPlayable,
  layerOf,
  modifierApplies,
  type CardDefinition,
  type Cost,
  type CostChange,
  type CostCount,
  type CostModifier,
  type CostPayer,
  type CostTarget,
} from '@riftbound/cards';

import { mightOf } from './combat.js';
import { conditionMet, type ConditionContext } from './condition.js';
import { countOf } from './count.js';
import { activeAbilities } from './attach.js';
import { dependencyMet } from './dependency.js';
import { getEntity, type EntityId, type GameState, type PlayerId } from './state.js';

/** A modifier in play, with the player whose Passive Ability is supplying it. */
export interface ActiveModifier {
  readonly controller: PlayerId;
  readonly modifier: CostModifier;
  /**
   * True when this came off the very card whose cost is being determined, which
   * is what a `self` filter asks about. Board modifiers are never `self`.
   */
  readonly own?: boolean | undefined;
}

/**
 * Every cost modifier currently active.
 *
 * Rule 365.1: a Permanent's Passive Abilities are active while it is on the
 * Board, so this walks the Bases, the Battlefields and the Legend Zone — a
 * modifier on a card in hand or trash does nothing.
 *
 * `self` modifiers are deliberately skipped here. "I cost 2 less" is about the
 * cost of playing *that* card, so it has already been paid by the time the card
 * reaches the Board; leaving it in would discount every other card instead.
 * `modifiersFor` picks it up from the card being played.
 */
export function activeModifiers(state: GameState): readonly ActiveModifier[] {
  const found: ActiveModifier[] = [];

  const collect = (entity: EntityId): void => {
    const controller = getEntity(state, entity).controller;
    // 718.2/718.3, exactly as for statics: an Attached card's own Passives stop
    // and its Top-Most Card carries the Effect Text's instead.
    for (const set of activeAbilities(state, entity)) {
      for (const modifier of set.abilities.costModifiers ?? []) {
        if (modifier.applies.scope === 'self') {
          continue;
        }
        if (!dependencyMet(state, entity, controller, modifier.dependsOn)) {
          continue;
        }
        if (!conditionMet(state, controller, entity, modifier.condition)) {
          continue;
        }
        found.push({ controller, modifier });
      }
    }
  };

  for (const seat of state.players) {
    for (const entity of [...seat.zones.base, ...seat.zones.legendZone]) {
      collect(entity);
    }
  }
  for (const battlefield of state.battlefields) {
    for (const unit of battlefield.units) {
      collect(unit);
    }
  }

  return found;
}

/**
 * The modifiers bearing on one card's cost: everything on the Board, plus the
 * card's own `self` modifiers.
 *
 * The card is in hand at this point, which is why its own modifiers cannot come
 * from the board sweep. `source` is `undefined` for the same reason — the card
 * is not a Game Object on the Board yet, and `dependencyMet` documents what that
 * means for Legion.
 */
function modifiersFor(
  state: GameState,
  player: PlayerId,
  card: CardDefinition,
  context: ConditionContext,
): readonly ActiveModifier[] {
  const own: ActiveModifier[] = [];
  for (const modifier of card.abilities?.costModifiers ?? []) {
    if (modifier.applies.scope !== 'self') {
      continue;
    }
    if (!dependencyMet(state, undefined, player, modifier.dependsOn)) {
      continue;
    }
    // The card is still in hand, so a source-relative condition is false and a
    // state predicate is answerable — the same split `entersReady` makes.
    if (!conditionMet(state, player, undefined, modifier.condition, context)) {
      continue;
    }
    own.push({ controller: player, modifier, own: true });
  }
  return own.length === 0 ? activeModifiers(state) : [...activeModifiers(state), ...own];
}

/**
 * The Total Cost of playing `card` as `player` (rule 356).
 *
 * Returns `undefined` for a card that is never paid for — Legends, Runes and
 * Battlefields — which is the same contract the printed-cost version had.
 */
export function totalCost(
  state: GameState,
  player: PlayerId,
  card: CardDefinition,
  /** 356.2.b: whether the optional Additional Cost was declared at step 2. */
  context: ConditionContext = {},
): Cost | undefined {
  if (!isPlayable(card)) {
    return undefined;
  }
  return applyModifiers(
    card.cost,
    card.type,
    player,
    modifiersFor(state, player, card, context),
    state,
  );
}

/**
 * The Total Cost of an Activated Ability (rule 403).
 *
 * Rule 403.2-403.3 sends an ability's base cost through the same increases and
 * decreases as a card's, so it runs the same layers — but only modifiers that
 * name abilities apply, since "cards cost 1 less" is not about abilities.
 */
export function abilityCost(
  state: GameState,
  player: PlayerId,
  base: Cost,
  /**
   * 821.1.c's "reduced by [A]": a discount applied *alongside* rule 356's
   * layers rather than instead of them, because Weaponmaster reduces the Equip
   * cost as it would be if the ability were being activated (821.1.c.2) — so
   * every ordinary modifier still applies first.
   */
  reduce: { readonly anyPower?: number } = {},
): Cost {
  const modified = applyModifiers(base, 'ability', player, activeModifiers(state), state);
  const anyPower = Math.max(0, anyPowerOf(modified) - (reduce.anyPower ?? 0));
  // Rebuilt rather than spread, so a reduction to zero actually clears the
  // field instead of leaving the pre-reduction one behind.
  return { energy: modified.energy, power: modified.power, ...(anyPower === 0 ? {} : { anyPower }) };
}

/**
 * Resolve a counted amount against the state (rule 356.4's "for each …").
 *
 * `of` is the modifier's controller, because "your trash" on a card is that
 * card's controller's trash.
 */
export function countFor(state: GameState, of: PlayerId, count: CostCount): number {
  // Might is safe to read here, unlike inside a static's grant: `mightOf`
  // consults statics and cost modifiers, not costs, so there is no cycle back.
  return countOf(state, of, undefined, count, mightOf);
}

/**
 * Turn a counted discount into a fixed one before the layers run.
 *
 * Kept separate so rule 356's layer machinery stays a pure function of numbers
 * and the counting is one step that can be tested on its own.
 */
function resolveCount(
  change: CostChange,
  controller: PlayerId,
  state: GameState | undefined,
): CostChange {
  if (change.kind !== 'discount' || change.per === undefined || state === undefined) {
    return change;
  }
  const counted = change.per.energy * countFor(state, controller, change.per.count);
  return { ...change, energy: (change.energy ?? 0) + counted };
}

/** The printed cost, ignoring everything in play. Rule 356.1.c's "Base Cost". */
export function baseCost(card: CardDefinition): Cost | undefined {
  return isPlayable(card) ? card.cost : undefined;
}

/**
 * Walk rule 356's layers over a base cost.
 *
 * Split out from `totalCost` so it can be exercised directly, and so an
 * ability's cost can be run through the same machine when abilities start
 * carrying modifiable costs.
 */
export function applyModifiers(
  base: Cost,
  target: CostTarget,
  player: PlayerId,
  active: readonly ActiveModifier[],
  /** Needed only to resolve counted amounts; omit for fixed-amount modifiers. */
  state?: GameState,
): Cost {
  const relevant = active
    .filter(({ controller, modifier, own }) =>
      modifierApplies(modifier.applies, target, payerFor(controller, player, own)),
    )
    .map(({ controller, modifier }) => resolveCount(modifier.change, controller, state));

  // Sort by rule 356's layer, then put bounded discounts before unbounded ones.
  //
  // 356.4.c.1 lets the player apply discounts to a component in any order, and
  // 356.4.e makes that choice matter: a minimum binds only its own discount, so
  // spending the bounded one first and the unbounded one after reduces the cost
  // furthest. That is exactly the rulebook's Eager Apprentice / Sky Splitter
  // example, where the two orders give 0 and 1. The *choice* is not exposed —
  // it needs the same sub-action protocol as trigger ordering — so the engine
  // takes the player-favourable order rather than an arbitrary one.
  const ordered = [...relevant].sort(
    (a, b) => layerOf(a) - layerOf(b) || boundedFirst(a) - boundedFirst(b),
  );

  let cost: Cost = base;

  for (const change of ordered) {
    switch (change.kind) {
      // 356.1.a: replace the Base Cost outright.
      case 'replaceBase':
        cost = change.cost;
        break;

      // 356.1.b: set the named Base Cost components to zero. 356.1.b.3 lets
      // later layers raise the total back above zero, so this is not a floor.
      case 'ignoreBase':
        cost = {
          energy: change.component === 'power' ? cost.energy : 0,
          // `[A]` is Power (135.2.e.5), so ignoring the Power cost ignores it.
          power: change.component === 'energy' ? cost.power : [],
          ...(change.component === 'energy' ? { anyPower: anyPowerOf(cost) } : {}),
        };
        break;

      // 356.3: increases.
      case 'increase':
        cost = {
          energy: cost.energy + (change.energy ?? 0),
          power: [...cost.power, ...(change.power ?? [])],
          anyPower: anyPowerOf(cost) + (change.anyPower ?? 0),
        };
        break;

      // 356.4: discounts, floored per rule 356.6 and per 356.4.e.
      case 'discount':
        cost = discount(cost, change);
        break;

      // 356.5.a: "ignoring any and all costs".
      case 'ignoreAll':
        cost = { energy: 0, power: [] };
        break;

      default: {
        const exhaustive: never = change;
        throw new Error(`Unknown cost change: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // 356.6: Energy and Power costs can't be reduced below 0.
  return {
    energy: Math.max(0, cost.energy),
    power: cost.power,
    ...(anyPowerOf(cost) === 0 ? {} : { anyPower: Math.max(0, anyPowerOf(cost)) }),
  };
}

/** Which of rule 356's three payer cases this modifier is looking at. */
function payerFor(
  controller: PlayerId,
  player: PlayerId,
  own: boolean | undefined,
): CostPayer {
  if (own === true) {
    return 'self';
  }
  return controller === player ? 'controller' : 'opponent';
}

/** Bounded discounts sort ahead of unbounded ones; see the note in `applyModifiers`. */
function boundedFirst(change: CostChange): number {
  return change.kind === 'discount' && change.minimumEnergy !== undefined ? 0 : 1;
}

/**
 * One discount (rule 356.4).
 *
 * `minimumEnergy` is 356.4.e: the floor belongs to *this* discount alone, so a
 * later discount can still take the cost below it. That is what makes the
 * rulebook's Eager Apprentice / Sky Splitter example order-dependent.
 */
function discount(
  cost: Cost,
  change: Extract<CostChange, { kind: 'discount' }>,
): Cost {
  let energy = cost.energy;
  const reduction = change.energy ?? 0;

  if (reduction > 0) {
    const floor = change.minimumEnergy ?? 0;
    // The minimum binds only this discount: never push the cost *up* to it.
    energy = Math.max(Math.min(energy, floor), energy - reduction);
  }

  let power = cost.power;
  for (const domain of change.power ?? []) {
    const index = power.indexOf(domain);
    if (index !== -1) {
      power = [...power.slice(0, index), ...power.slice(index + 1)];
    }
  }

  // 821.1.c.3: a cost with no `[A]` in it "will not be reduced", which is what
  // taking pips off zero already does — no special case needed.
  const anyPower = Math.max(0, anyPowerOf(cost) - (change.anyPower ?? 0));

  return { energy, power, ...(anyPower === 0 ? {} : { anyPower }) };
}

