/**
 * Predicates over the game state.
 *
 * "If you control a Poro", "if an opponent's score is within 3 points of the
 * Victory Score", "if you've discarded a card this turn". One type rather than
 * one per subsystem, because the corpus asks the *same* questions in four
 * different places:
 *
 * - gating a static — "If you've discarded a card this turn, I have ASSAULT"
 * - gating "enters ready" — "I enter ready if you control another Dragon"
 * - gating a cost modifier — "If an enemy unit has died this turn, this costs 2 less"
 * - gating an effect — "When you play me, if you control a Poro, buff me and draw 1"
 *
 * A condition is *asked*, never executed, exactly like a static (365). The two
 * source-relative variants were previously `StaticCondition` and are folded in
 * here so a caller never has to know which kind it is holding.
 *
 * Only predicates the state can already answer exist. One that needs a mechanic
 * the model lacks — "if you control a facedown card", "if I have moved twice
 * this turn" — is refused at ingest rather than approximated, because a
 * condition that silently reads false makes a card quietly weaker than printed.
 */
import type { CardType } from './card.js';

/** What a `controls` predicate counts. */
export type ControlledKind = CardType | 'battlefield';

export type Condition =
  /**
   * "While I'm buffed" (702) — about the source, not the game at large.
   *
   * May not look at Might: `mightOf` consults statics, so a condition that read
   * Might back would recurse.
   */
  | { readonly kind: 'buffed' }
  /** "While I'm at a battlefield". */
  | { readonly kind: 'atBattlefield' }
  /**
   * "If you control a Poro", "if you control two or more gear", "if an opponent
   * controls a battlefield".
   *
   * `tag` matches `CardDefinition.tags`, which is where unit types like Poro,
   * Dragon and Mech live (133.8.a gives them no rules meaning of their own, but
   * a card may still ask about them).
   */
  | {
      readonly kind: 'controls';
      readonly who: 'you' | 'opponent';
      readonly what: ControlledKind;
      /** How many are needed. "a Poro" is 1, "two or more gear" is 2. */
      readonly min: number;
      readonly tag?: string | undefined;
      /** "another Dragon" — the source does not count toward the total. */
      readonly excludeSelf?: boolean | undefined;
      /**
       * "another unit **here**" (355.9) — counted only at the source's own
       * Battlefield.
       *
       * Source-relative, so it needs a source to mean anything; a source in a
       * Base names no Battlefield and the count is 0. The same restriction
       * `StaticScope.here` applies, spelled the same way.
       */
      readonly here?: boolean | undefined;
    }
  /**
   * "If an opponent's score is within 3 points of the Victory Score" (194.3).
   *
   * Measured against the Victory Score rather than a fixed number, so it stays
   * right in a Mode of Play that sets a different one (483.3).
   */
  | { readonly kind: 'scoreWithin'; readonly who: 'you' | 'opponent'; readonly points: number }
  /**
   * "When you play me, **if you paid the additional cost**, buff me" (356.2.b).
   *
   * The most repeated conditional wording in the corpus, and it reads a choice
   * the player made at step 2 rather than anything on the board — which is why
   * `conditionMet` takes a context alongside the state.
   */
  | { readonly kind: 'paidAdditionalCost' }
  /**
   * "If you've discarded a card this turn", "if an enemy unit has died this
   * turn".
   *
   * Counted per turn and cleared in the Ending Phase, the same bookkeeping
   * Legion uses for cards played (812.1.c).
   */
  | {
      readonly kind: 'didThisTurn';
      readonly event: 'discard' | 'dies' | 'played' | 'conquer' | 'hold';
      readonly who: 'you' | 'opponent';
      readonly min: number;
    };

/** True for the conditions that are about the source rather than the state. */
export function isSourceCondition(condition: Condition): boolean {
  return condition.kind === 'buffed' || condition.kind === 'atBattlefield';
}
