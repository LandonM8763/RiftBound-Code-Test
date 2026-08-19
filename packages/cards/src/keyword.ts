/**
 * Keywords (rules 800-828).
 *
 * Rule 801: a Keyword is "a shorthand for a specific game effect". The glossary
 * says so literally — every entry gives an expansion, "functionally short for
 * ...". That sentence is the whole design here, and it sorts keywords into
 * three kinds:
 *
 * 1. **Shorthand for something already modelled.** Deathknell (808.1.c) is
 *    "When I die, [Effect]" — a `TriggerCondition` this model already has.
 *    Temporary (816.1.b) is a Beginning Phase trigger that kills its source.
 *    Action and Reaction (806, 813) are `SpellCard.timing`. These are
 *    *desugared at ingest* and never reach this type: a card carrying one comes
 *    out with an ordinary ability, because inventing a second way to say the
 *    same thing is how two code paths drift apart.
 * 2. **A genuine engine rule**, changing something no effect can express — what
 *    Might a Unit has while attacking, which Unit must be assigned damage
 *    first, where a Standard Move may go. Those are this type.
 * 3. **Gates on an otherwise ordinary ability**, the rulebook's Dependent
 *    Keywords (801.1, 812, 824). Those are `AbilityDependency` in `ability.ts`,
 *    because what they modify is an ability rather than a card.
 *
 * Keywords the engine deliberately does *not* model are listed at the bottom
 * with the reason, because a card that carries one and is treated as though it
 * did not is a wrong card rather than a simpler one.
 */

/**
 * A keyword that is a rule of the engine (kind 2 above).
 *
 * Rules 807.2, 814.2 and 809.2 all say the same thing about stacking: a second
 * instance of a valued keyword *sums* with the first. Unvalued ones are
 * "redundant" (810.2, 815.2, 826.5) — a second instance does nothing. Both are
 * handled by `keywordValue` and `hasKeyword` rather than by the callers.
 */
export type Keyword =
  /**
   * Assault X (807.1.c): "While I am an attacker, I have +X Might."
   *
   * 807.1.b.3: a printed Assault with no number is Assault 1.
   */
  | { readonly kind: 'assault'; readonly value: number }
  /** Shield X (814.1.c): "While I am a defender, I have +X Might." */
  | { readonly kind: 'shield'; readonly value: number }
  /**
   * Tank (815.1.b): "I must be assigned lethal damage before any other unit
   * with the same controller as me that does not have Tank."
   */
  | { readonly kind: 'tank' }
  /** Backline (826.3): the mirror of Tank — assigned lethal damage *after*. */
  | { readonly kind: 'backline' }
  /**
   * Ganking (810.1.b): "I may move to a battlefield from another battlefield
   * with a standard move."
   *
   * 810.1.c.1-3: it only *adds* a destination. It is not an extra Move, and it
   * has no activation cost of its own.
   */
  | { readonly kind: 'ganking' }
  /**
   * Hidden (811.1.b): permission to take the Hide Discretionary Action (421),
   * and then to play the card from facedown for no Base Cost.
   *
   * A rule of the engine rather than a desugar, because it is the only keyword
   * that adds an *action* — 811.1.c.1 is explicit that Hide is not a subset of
   * Play, so there is no existing action for it to expand into. 811.4 makes a
   * second instance redundant, which is why it carries no value.
   */
  | { readonly kind: 'hidden' };

export type KeywordKind = Keyword['kind'];

/** Keywords that carry a value, which stacks by summing (807.2, 814.2). */
export type ValuedKeywordKind = Extract<Keyword, { value: number }>['kind'];

export function hasKeyword(
  keywords: readonly Keyword[] | undefined,
  kind: KeywordKind,
): boolean {
  return keywords !== undefined && keywords.some((keyword) => keyword.kind === kind);
}

/**
 * The total value of a valued keyword, or 0 if the card has none.
 *
 * Rules 807.2/814.2: multiple instances sum, so this adds rather than taking
 * the first or the largest.
 */
export function keywordValue(
  keywords: readonly Keyword[] | undefined,
  kind: ValuedKeywordKind,
): number {
  if (keywords === undefined) {
    return 0;
  }
  let total = 0;
  for (const keyword of keywords) {
    if (keyword.kind === kind) {
      total += keyword.value;
    }
  }
  return total;
}

/**
 * Keywords the rulebook defines that this engine refuses to model, and why.
 *
 * This is data rather than prose so the ingest parser can cite the reason when
 * it declines a card: a keyword the engine cannot honour must leave the card
 * unparsed, never be silently dropped. Rule 002 makes card text supersede the
 * rules, so a card whose keyword is ignored is being played wrong.
 */
export const UNMODELLED_KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  // Accelerate (805) is *not* here: 805.1.a makes it an Optional Additional
  // Cost plus "if you do, I enter ready", and both halves now exist, so it
  // desugars at ingest like Deathknell and Temporary do.
  //
  // 820.1.d makes Repeat the same shape — an Optional Additional Cost whose
  // payoff is executing the Chain item's instructions a second time — so it is
  // no longer *blocked*. It stays refused because it is not worth building:
  // pretending it exists and re-parsing the corpus unlocks **zero** cards, both
  // alone and alongside every other keyword. Its 10 printings are each blocked
  // on something else as well. Build it when that number moves.
  repeat:
    'Repeat (820) needs the effect executed twice on resolution; measured at 0 cards unlocked, so it is not built',
  // Deflect (809) is not here either. 809.1.c is a Passive cost increase of
  // `[A]` on Spells and Abilities an opponent controls that choose this Game
  // Object — the one modifier that depends on a *choice* rather than on the
  // board, which is why `totalCost` takes the chosen target.
  // Hidden (811) is not here either. It is a rule of the engine rather than a
  // desugar: 811.1.c.1 makes Hide a Discretionary Action of its own, not a
  // subset of Play, so there was nothing for it to expand into.
  // Equip (818) and Quick-Draw (819) are *not* here. Attach exists now, and
  // both desugar into it: 818.1.c.2 makes Equip "[Cost]: Attach this gear to a
  // unit you control" — an Activated Ability — and 819.1.d makes Quick-Draw
  // Reaction timing plus a Play Effect that Attaches.
  //
  // Weaponmaster (821) is not here either. 821.1.c is a Play Effect that
  // chooses an Equipment and pays its Equip cost to Attach it — the one effect
  // that pays something, because the cost is read off a target chosen at
  // 402.2 rather than settled at step 3. 821.1.c.5 makes an unpayable one a
  // no-op, which is what makes that safe.
  // Vision (817) is not here either. 817.1.b makes it "When this is played,
  // predict", and 436.1 makes a Predict a *look* plus an optional Recycle —
  // which is 383.3.a's "you may" and 402.1's decline, both of which exist. The
  // look is a view rule (see `isPredicting`), not a sub-action protocol.
});
