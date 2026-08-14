/**
 * Cost modification as data (rule 356).
 *
 * A card that changes what other cards cost does so with a Passive Ability
 * (363), and Passive Abilities of Permanents are active while on the Board
 * (365.1). So a modifier is a standing statement carried by a card, not an
 * effect that fires — which is why it lives beside the ability model rather
 * than inside `Effect`.
 */
import type { AbilityDependency } from './ability.js';
import type { CardType } from './card.js';
import type { Condition } from './condition.js';
import type { Cost } from './cost.js';
import type { Count } from './count.js';
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
 * `self` is the odd one and the common one: "I cost 2 less" is a modifier that
 * applies to exactly one cost, the cost of playing the card it is printed on.
 * That makes it the only kind that is read off a card in *hand* — every other
 * modifier comes from a Permanent on the Board (365.1) — so `costs.ts` gathers
 * it from the card being played rather than from the board sweep.
 *
 * Omitting `types` means every *card* type but not abilities — "cards cost 1
 * less" does not discount an Activated Ability, so an ability-cost modifier has
 * to name `'ability'` explicitly.
 */
export interface CostFilter {
  readonly types?: readonly CostTarget[] | undefined;
  readonly scope: 'self' | 'friendly' | 'opponent' | 'any';
  /**
   * 809.1.c: applies only to a Spell or Ability that **chooses this modifier's
   * own source** — Deflect, and nothing else so far.
   *
   * The only filter that depends on a choice rather than on the board, which is
   * why `totalCost` takes the chosen target: a Deflect makes one card cost more
   * to point at this Unit and nothing at all to point elsewhere, so a cost
   * computed per card rather than per target would be wrong both ways.
   *
   * Deflect pairs it with `scope: 'opponent'`, because 809.1.c is about
   * "Spells and abilities **an opponent controls**" — `any` would tax the
   * Deflecting player's own spells for choosing their own Unit.
   */
  readonly choosesSource?: boolean | undefined;
}

/**
 * Whose cost is being determined, relative to the modifier's source.
 *
 * Three cases rather than a boolean because `self` is not "the controller is
 * paying" — a player can hold two copies of the same card, and only the one
 * being played carries its own discount.
 */
export type CostPayer =
  /** The very card carrying the modifier is the one being paid for. */
  | 'self'
  /** The modifier's controller is paying, for something else. */
  | 'controller'
  | 'opponent';

/**
 * A quantity read off the game state — the "for each …" of rule 356.4.
 *
 * Only counts the state already holds are here. A count of something the model
 * cannot see (a Mighty Unit, say) is refused at ingest rather than approximated,
 * for the same reason a missing card field is: a discount that is plausible and
 * wrong makes a card playable at the wrong time.
 */
/**
 * A counted amount for a discount.
 *
 * An alias of the shared `Count` rather than a type of its own: "for each card
 * in your trash" is the same arithmetic a static's grant and an effect's amount
 * ask for, and one vocabulary is what stops the three drifting.
 */
export type CostCount = Count;

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
  | {
      readonly kind: 'increase';
      readonly energy?: number | undefined;
      readonly power?: readonly Domain[] | undefined;
      /** `[A]` (135.2.e.5): Power of any Domain — what 809.1.c's Deflect adds. */
      readonly anyPower?: number | undefined;
    }
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
      /**
       * `[A]` pips removed (135.2.e.5) — 821's "reduced by [A]".
       *
       * 821.1.c.3 falls straight out of removing pips that are there: a cost
       * that contains no `[A]` "can still be paid, but will not be reduced",
       * which is what subtracting from zero does.
       */
      readonly anyPower?: number | undefined;
      /**
       * "1 less **for each** card in your trash" — an amount counted off the
       * state rather than printed.
       *
       * Resolved to a fixed `energy` before rule 356's layers run, so the layer
       * machinery stays a pure function of numbers and the counting is one
       * separately testable step.
       */
      readonly per?: { readonly count: CostCount; readonly energy: number } | undefined;
    }
  /** 356.5.a: "ignoring any and all costs" sets the Total Cost to zero. */
  | { readonly kind: 'ignoreAll' };

export interface CostModifier {
  readonly applies: CostFilter;
  readonly change: CostChange;
  /**
   * A Dependent Keyword gating this modifier (801.1) — "LEGION > I cost 2 less".
   *
   * 812.1.b makes the whole clause after the keyword the Legion Ability, and a
   * passive is as gateable as a triggered one. An unmet dependency makes the
   * modifier absent, not merely inert.
   */
  readonly dependsOn?: AbilityDependency | undefined;
  /**
   * "If an enemy unit has died this turn, this costs 2 less."
   *
   * A modifier whose condition fails is *absent* from the Total Cost rather
   * than applied as zero, which is the same treatment an unmet dependency gets.
   */
  readonly condition?: Condition | undefined;
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
  payer: CostPayer,
): boolean {
  // A self modifier speaks about one cost only: its own card's.
  if (filter.scope === 'self') {
    return payer === 'self' && (filter.types === undefined || filter.types.includes(target));
  }
  if (filter.scope === 'friendly' && payer === 'opponent') {
    return false;
  }
  // The mirror, and 809.1.c's "Spells and abilities an opponent controls".
  if (filter.scope === 'opponent' && payer !== 'opponent') {
    return false;
  }
  const types = filter.types;
  if (types === undefined || types.length === 0) {
    // An unqualified modifier speaks about cards. Abilities opt in by name.
    return target !== 'ability';
  }
  return types.includes(target);
}
