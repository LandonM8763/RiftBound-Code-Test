/**
 * Static and Passive abilities (rules 363-365).
 *
 * A Passive Ability is a standing statement rather than something that fires:
 * "Other friendly units here have +1 Might", "I enter ready". Rule 365.1 makes a
 * Permanent's Passive Abilities active while it is on the Board, so a static is
 * not executed — it is *consulted*, every time the thing it modifies is read.
 *
 * That is the whole reason this is its own type rather than an `Effect`. An
 * effect changes the state once; a static changes what the state *means* for as
 * long as its source is there, and stops meaning it the moment the source
 * leaves. Modelling "other units here have +1 Might" as an effect would leave
 * the +1 behind when the granter died.
 *
 * `CostModifier` is the same idea for costs and came first; this is the same
 * shape for Might and keywords, and the two are deliberately separate because
 * rule 356 gives cost modification its own layered ordering that Might does not
 * have.
 */
import type { AbilityDependency } from './ability.js';
import type { Condition } from './condition.js';
import type { Keyword } from './keyword.js';

/**
 * Which Game Objects a static reaches.
 *
 * Judged from the *source's* point of view: `friendly` is the source's
 * controller's, `enemy` is anyone else's. That is what card text means by
 * "friendly", and it is not the same question as who is taking an action.
 */
export interface StaticScope {
  readonly who: 'self' | 'friendly' | 'enemy' | 'any';
  /**
   * "here" (355.9): the same Battlefield as the source.
   *
   * A source at a Base reaches nothing when this is set, which is correct —
   * "units here" on a Unit in your Base names no Battlefield.
   */
  readonly here?: boolean | undefined;
  /** "Other friendly units …" — never the source itself. */
  readonly excludeSelf?: boolean | undefined;
}

/** What a static does to the objects in its scope. */
export interface StaticGrant {
  /**
   * A Might modifier, positive or negative (143.2).
   *
   * Not a Buff and not `mightBonus`: it neither persists nor expires, because
   * it is not *on* the Unit at all. It applies exactly while the source is on
   * the Board saying so.
   */
  readonly might?: number | undefined;
  /**
   * Keywords granted (801.3.a).
   *
   * 801.3.a.3: a grant with no stated duration lasts as long as the granting
   * effect does, which for a static is "while the source is on the Board".
   */
  readonly keywords?: readonly Keyword[] | undefined;
  /**
   * "I enter ready" — replaces 359.2.c, which enters a Unit exhausted.
   *
   * Read off the card being played, so a `self` static of this kind is
   * consulted while the card is still in hand.
   */
  readonly entersReady?: boolean | undefined;
}

export interface StaticAbility {
  readonly affects: StaticScope;
  readonly grant: StaticGrant;
  /**
   * "While I'm buffed …", "If you control another Dragon …" — a condition on
   * the *source* or on the game state, never on the objects it affects.
   *
   * Shared with cost modifiers and effects, because the corpus asks the same
   * questions in all three places. See `condition.ts`.
   */
  readonly condition?: Condition | undefined;
  /** A Dependent Keyword gating the whole statement (801.1, 812, 824). */
  readonly dependsOn?: AbilityDependency | undefined;
}
