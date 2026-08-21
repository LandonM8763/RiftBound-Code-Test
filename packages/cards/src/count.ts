import type { ControlledKind } from './condition.js';
import type { ValuedKeywordKind } from './keyword.js';

/**
 * A number read off the game state.
 *
 * "Draw 1 **for each of your MIGHTY units**", "I have ASSAULT **equal to the
 * number of enemy units here**", "I cost 1 less **for each card in your
 * trash**". One type rather than one per subsystem, for the same measured
 * reason `Condition` is one type: the corpus asks the same arithmetic in three
 * places — a cost discount, an effect's amount, and a static's grant.
 *
 * A `Count` is *asked*, never executed, exactly like a `Condition`. And like a
 * condition, only counts the state can already answer exist: one that needs a
 * mechanic the model lacks is refused at ingest rather than approximated,
 * because a number that is plausible and wrong is worse than a vanilla card.
 */
export type Count =
  /** "for each card in your trash" — the controller's own trash. */
  | { readonly kind: 'cardsInTrash' }
  /** "for each card you've played this turn" — the list Legion reads (812.1.c). */
  | { readonly kind: 'cardsPlayedThisTurn' }
  /**
   * A sweep of the Board: "for each of your MIGHTY units", "the number of enemy
   * units here", "each other battlefield you control".
   *
   * The fields deliberately mirror `Condition`'s `controls`, because they are
   * the same question asked for a number instead of a yes/no — and the engine
   * evaluates both through the same code.
   */
  | {
      readonly kind: 'controlled';
      readonly who: 'you' | 'opponent';
      readonly what: ControlledKind;
      readonly tag?: string | undefined;
      /** "here" (355.9): only at the source's own Battlefield. */
      readonly here?: boolean | undefined;
      /** "each **other** battlefield" — the source does not count itself. */
      readonly excludeSelf?: boolean | undefined;
      /**
       * "Stunned enemy units here" (423.1.a) — a binary status on the Unit.
       *
       * Unlike `mighty`, this is safe inside a `StaticGrant`: being Stunned is
       * stored on the entity rather than computed from statics, so reading it
       * cannot recurse back through `mightOf`.
       */
      readonly stunned?: boolean | undefined;
      /**
       * "MIGHTY" (rules 706-709): a description, not a keyword — 708 makes a
       * Unit Mighty exactly while its Might is 5 or greater.
       *
       * **Never legal inside a `StaticGrant`.** Might is what `mightOf` computes
       * by consulting statics, so a static whose grant counted Mighty Units
       * would recurse through it. The parser refuses that combination; the same
       * reasoning already keeps `Condition` from reading Might.
       */
      readonly mighty?: boolean | undefined;
      /** "each buffed friendly unit" (702) — carries a Buff counter. */
      readonly buffed?: boolean | undefined;
    }
  /**
   * "deal damage equal to **my Might**" (143) — the source's own effective
   * Might, statics and Buffs included.
   *
   * **Never legal inside a `StaticGrant`**, for the same reason `mighty` is
   * not: `mightOf` consults statics, so a static granting Might equal to a
   * Might would recurse straight back through it.
   */
  | { readonly kind: 'sourceMight' }
  /**
   * "deal damage equal to **my ASSAULT**" (807) — the value of a keyword on
   * the source.
   *
   * Also refused inside a `StaticGrant`: `keywordsOf` consults statics, so a
   * static granting a keyword whose value counts a keyword would recurse the
   * same way Might does. `readsMight` answers for both because it is asked at
   * exactly one place — whether this count may appear in a grant.
   *
   * A *kind* rather than a `Keyword`, because only a valued keyword has a
   * number to read: "equal to my TANK" is not a quantity.
   */
  | { readonly kind: 'sourceKeyword'; readonly keyword: ValuedKeywordKind }
  /**
   * "My Might is increased by **your points**" — the controller's score.
   *
   * Safe in a `StaticGrant`: points sit on `PlayerState` and reading them
   * touches neither `mightOf` nor `keywordsOf`.
   */
  | { readonly kind: 'points'; readonly who: 'you' | 'opponent' };

/**
 * Does evaluating this count require reading Might or keywords — and so
 * recursing back through the statics that are asking?
 */
export function readsMight(count: Count): boolean {
  return (
    (count.kind === 'controlled' && count.mighty === true) ||
    count.kind === 'sourceMight' ||
    count.kind === 'sourceKeyword'
  );
}
