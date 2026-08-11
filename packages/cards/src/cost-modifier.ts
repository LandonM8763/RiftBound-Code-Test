/**
 * Cost modification as data (rule 356).
 *
 * A card that changes what other cards cost does so with a Passive Ability
 * (363), and Passive Abilities of Permanents are active while on the Board
 * (365.1). So a modifier is a standing statement carried by a card, not an
 * effect that fires — which is why it lives beside the ability model rather
 * than inside `Effect`.
 */
import type { CardType } from './card.js';
import type { Cost } from './cost.js';
import type { Domain } from './domain.js';

/**
 * What a cost modifier can be about.
 *
 * Abilities have costs too, and rule 403.2-403.3 sends them through the same
 * modification machinery as cards, so they need to be nameable here.
 */
export type CostTarget = CardType | 'ability';

/**
 * Which costs a modifier applies to.
 *
 * `scope` is about who is paying, not who controls the modifier's source:
 * "units *you* play cost 1 less" is `friendly`, a symmetric tax is `any`.
 *
 * Omitting `types` means every *card* type but not abilities — "cards cost 1
 * less" does not discount an Activated Ability, so an ability-cost modifier has
 * to name `'ability'` explicitly.
 */
export interface CostFilter {
  readonly types?: readonly CostTarget[] | undefined;
  readonly scope: 'friendly' | 'any';
}

/**
 * What a modifier does, tagged by the rule 356 layer it belongs to.
 *
 * The layer is the whole point: 356 applies base-cost modifications, then
 * additional costs, then increases, then discounts, then total modifications,
 * and the order changes the answer. Encoding the layer in the data means the
 * interpreter sorts by it rather than trusting the order cards were found in.
 */
export type CostChange =
  /** 356.1.a: "play it for [Cost]" — the Base Cost is replaced outright. */
  | { readonly kind: 'replaceBase'; readonly cost: Cost }
  /**
   * 356.1.b: "ignoring its cost" sets the named Base Cost components to zero.
   * 356.1.b.3 lets later layers raise the total back above zero.
   */
  | { readonly kind: 'ignoreBase'; readonly component: 'energy' | 'power' | 'both' }
  /** 356.3: a cost increase. */
  | { readonly kind: 'increase'; readonly energy?: number | undefined; readonly power?: readonly Domain[] | undefined }
  /**
   * 356.4: a discount.
   *
   * `minimumEnergy` is rule 356.4.e's per-discount floor — "reduced by 1, to a
   * minimum of 1" — and it deliberately binds only this discount, not the
   * running total. Another discount applied afterwards can still go below it.
   */
  | {
      readonly kind: 'discount';
      readonly energy?: number | undefined;
      readonly power?: readonly Domain[] | undefined;
      readonly minimumEnergy?: number | undefined;
    }
  /** 356.5.a: "ignoring any and all costs" sets the Total Cost to zero. */
  | { readonly kind: 'ignoreAll' };

export interface CostModifier {
  readonly applies: CostFilter;
  readonly change: CostChange;
}

/** Rule 356's layer order. Lower numbers are applied first. */
export function layerOf(change: CostChange): number {
  switch (change.kind) {
    case 'replaceBase':
    case 'ignoreBase':
      return 1; // 356.1
    case 'increase':
      return 3; // 356.3
    case 'discount':
      return 4; // 356.4
    case 'ignoreAll':
      return 5; // 356.5
    default: {
      const exhaustive: never = change;
      throw new Error(`Unknown cost change: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/*
 * Layer 2 — additional costs (356.2) — is absent on purpose.
 *
 * Both the mandatory and optional forms are paid with *non-standard* costs
 * (356.7): "kill a friendly unit", "discard 1". None of those are expressible
 * as effects yet, so an additional cost could be added to the total and then
 * never paid, which is worse than not offering it. It also needs a decision
 * point during the Announce step for the optional form (356.2.b.1), since
 * choosing to pay changes the total. It belongs with the kill/discard effect
 * primitives, not here.
 */

/** True when `modifier` applies to this kind of cost, paid by this player. */
export function modifierApplies(
  filter: CostFilter,
  target: CostTarget,
  paidByModifierController: boolean,
): boolean {
  if (filter.scope === 'friendly' && !paidByModifierController) {
    return false;
  }
  const types = filter.types;
  if (types === undefined || types.length === 0) {
    // An unqualified modifier speaks about cards. Abilities opt in by name.
    return target !== 'ability';
  }
  return types.includes(target);
}
