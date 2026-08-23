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
import type { AbilityDependency, CardAbilities } from './ability.js';
import type { Condition } from './condition.js';
import type { Count } from './count.js';
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
  /**
   * "Your **Mechs** have +1 Might" — narrowed to a tag (133.8).
   *
   * 133.8.a gives an ordinary tag no rules meaning *of its own*, which is not
   * the same as being unreferenceable: a card may name one, and this is how.
   * Matched case-insensitively, like `Condition`'s own tag comparison.
   *
   * **The card data available today publishes no tags**, so a static scoped
   * this way reaches nothing. That is a shortfall of the source rather than of
   * the model — `apitcg.ts` records a `tags` gap for every card that names one
   * — and a source that carries tags makes these work with no code change.
   */
  readonly tag?: string | undefined;
  /**
   * "Your **tokens** enter ready" — narrowed to Tokens (185).
   *
   * A separate flag rather than a tag, because 185 makes being a Token a
   * property of the Game Object rather than something printed in a tag line:
   * `STANDARD_TOKENS` gives them no tag to match on. It is also the one
   * narrowing of this kind the data can answer today.
   */
  readonly token?: boolean | undefined;
}

/**
 * Something a static *forbids*, rather than grants.
 *
 * Rule 002 makes card text supersede the rules, so a card that removes a
 * permission is doing the same kind of thing as one that adds it — which is why
 * this rides on `StaticGrant` beside `keywords` and `playTo` rather than
 * becoming a parallel mechanism. Each variant names one rule the engine already
 * enforces, so honouring it is a check at the one place that rule lives.
 *
 * **The scope means different things for different variants**, and it has to:
 * `moveToBase`, `chosenByOpponent` and `readyByEffect` are about a Game Object
 * and read `affects` the ordinary way; `score` and `playAwayFromBase` are about
 * a *player*, so only `affects.who` is consulted; `playHere` is about a
 * *place*, and the place is the static's own source Location. Every printed
 * card matches one of those three readings — a Battlefield says "here" about
 * itself, a Unit says "opponents" about players — so the alternative was a
 * scope grammar with three unused halves.
 */
export type Restriction =
  /** "Units can't move to base" (449.1). Object-facing. */
  | { readonly kind: 'moveToBase' }
  /** "Units can't be played here" (355.2). Place-facing: the source's Location. */
  | { readonly kind: 'playHere' }
  /**
   * "I can't be chosen by enemy spells and abilities" (355.6).
   *
   * Object-facing, and the mirror of Deflect (809): where Deflect makes the
   * choice cost more, this removes it altogether.
   */
  | { readonly kind: 'chosenByOpponent' }
  /** "Opponents can't score points" (467). Player-facing. */
  | { readonly kind: 'score' }
  /** "Spells and abilities can't ready enemy units and gears" (419). Object-facing. */
  | { readonly kind: 'readyByEffect' }
  /**
   * "Opponents can only play units to their base" (355.2). Player-facing.
   *
   * The inverse of `playTo`: that widens 355.2.a's default, this narrows it to
   * the Base alone.
   */
  | { readonly kind: 'playAwayFromBase' }
  /**
   * "Use my abilities only while I'm at a battlefield" (377, 380). Object-facing.
   *
   * Stated as a restriction gated by a `StaticAbility.condition` rather than as
   * a condition on the ability itself, because that is what the card says: a
   * permission removed while something holds. `Condition.not` is what turns the
   * printed "only while X" into the "while not X" a restriction wants.
   *
   * It reaches *every* ability on its scope. "Use **this** ability only …" is
   * printed as a separate sentence with nothing tying it to one ability, and no
   * card in the corpus has two Activated Abilities with only one gated — so
   * narrowing it would need an index the text does not supply.
   */
  | { readonly kind: 'activateAbility' }
  /**
   * "Opponents can't play cards this turn" (358.4 with rule 002).
   * Player-facing, like `score`.
   */
  | { readonly kind: 'playCards' };

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
   * "Stunned enemy units here have -8 Might, **to a minimum of 1 Might**"
   * (143.2).
   *
   * The floor the reduction stops at, measured against the Unit's *actual*
   * Might — 143.2.b.1 is explicit that a negative Might "is not 0" and that
   * effects calculating Might use the actual value, so a Unit already below the
   * floor loses nothing rather than being raised to it.
   *
   * Only meaningful on a negative grant, which is why it is refused on a
   * positive one at ingest rather than quietly ignored.
   */
  readonly minimumMight?: number | undefined;
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
  /**
   * 355.2.b: permission to play a Unit to a Location that is not normally
   * Valid — "You may play me to an open battlefield."
   *
   * 355.2.a's default is the controller's Base or a Battlefield they Control,
   * and 170.11 names the two states cards widen it to: `open` is unoccupied
   * *and* uncontrolled (170.11.c), `occupiedEnemy` is one an opponent Controls
   * with a Unit present (170.11.a).
   *
   * A permission rather than a restriction, so several stack by union and none
   * can take a Location away. Read off the card in hand for a `self` static,
   * the same as `entersReady` — "you may play **me**" has to be answerable
   * before the card is anywhere.
   */
  readonly playTo?: readonly ('open' | 'occupiedEnemy')[] | undefined;
  /**
   * Abilities and cost modifiers granted to everything in scope (801.3.a).
   *
   * This is what "Other friendly units have VISION" and "Friendly units have
   * DEFLECT" need: both keywords *desugar*, so what the scope gains is a
   * Triggered Ability and a `CostModifier` rather than a `Keyword`. 801.3.a
   * makes a granted keyword indistinguishable from a printed one, so the
   * grammar produces the same shapes it would have produced on the card.
   *
   * **A granted static is deliberately not honoured.** `activeStatics` reads a
   * Permanent's printed and Attached abilities only, so a static in here would
   * have to be gathered by the very sweep that produced it. Nothing in the
   * corpus grants one.
   */
  readonly abilities?: CardAbilities | undefined;
  /**
   * Permissions this static takes away (rule 002).
   *
   * A list, because one card prints two — "opponents can only play units to
   * their base" and "spells and abilities can't ready enemy units and gears"
   * are one Unit's two clauses.
   */
  readonly forbid?: readonly Restriction[] | undefined;
  /**
   * A value read off the state, multiplying everything numeric in this grant.
   *
   * "I have +1 Might **for each friendly gear**" is `might: 1` with this set;
   * "I have ASSAULT **equal to the number of enemy units here**" is
   * `keywords: [ASSAULT 1]` with the same. One field rather than one per grant
   * kind, because "equal to N" and "+1 for each N" are the same arithmetic.
   *
   * **A count that reads Might is refused here**, because `mightOf` consults
   * statics and would recurse through this. See `Count`.
   */
  readonly per?: Count | undefined;
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
