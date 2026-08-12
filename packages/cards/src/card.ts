import type { CardAbilities } from './ability.js';
import type { Cost } from './cost.js';
import type { CardEffect } from './effect.js';
import type { Domain, DomainIdentity } from './domain.js';
import type { Keyword } from './keyword.js';

/**
 * Printed card identifier, e.g. `OGN-296` (set code + collector number).
 * Branded so a raw string cannot be passed where a card id is expected.
 */
export type CardId = string & { readonly __brand: 'CardId' };

export function cardId(value: string): CardId {
  return value as CardId;
}

export type CardType = 'legend' | 'unit' | 'spell' | 'gear' | 'rune' | 'battlefield';

/**
 * When a Spell may be played.
 *
 * - `action`: during your action phase, or during a Showdown.
 * - `reaction`: everywhere an Action may be played, plus in response to a Spell
 *   or ability — and it resolves *before* the thing it responds to.
 */
export type SpellTiming = 'action' | 'reaction';

interface CardBase {
  readonly id: CardId;
  readonly name: string;
  /** The card's own Domains. Must fall within a deck's Domain Identity. */
  readonly domains: readonly Domain[];
  /** Rules text as printed. Not parsed — effects are modelled separately. */
  readonly text: string;
  /** Free-form classifiers from the card (unit types, keywords, and so on). */
  readonly tags: readonly string[];
  /**
   * The card's Champion Tag (rule 133.8.b), when it carries one.
   *
   * Champion Tags are the tags that link a Champion Legend to its Champion
   * Units and Signature cards, and they are the only tags with rules meaning —
   * 133.8.a gives ordinary tags none. They are kept in their own field rather
   * than left inside `tags` precisely because of that: deck validation has to
   * know *which* tag is the Champion Tag, and picking one out of an untyped
   * string list would be a guess.
   *
   * Modelled as a single tag because rules 103.2.a.2 and 103.2.d.2 both speak
   * of "the tag on your Champion Legend". If real card data ever shows a card
   * carrying two, this becomes an array and the matches become intersections.
   */
  readonly championTag?: string | undefined;
  /**
   * The Signature supertype (rule 133.7.b), which may apply to a card of *any*
   * type — hence its place here rather than on `UnitCard`.
   *
   * Rule 103.2.d limits a deck to 3 Signature cards in total, all matching the
   * Legend's Champion Tag, and 103.2.d.3 says a Signature card is never a
   * Champion Unit.
   */
  readonly signature?: boolean | undefined;
  /**
   * Activated and Triggered abilities (rules 376-395).
   *
   * On the base rather than on the playable cards because a Battlefield can
   * carry a Triggered Ability ("When you hold here, ...") and a Legend carries
   * one as often as a Unit does.
   */
  readonly abilities?: CardAbilities | undefined;
  /**
   * Keywords that are rules of the engine (rules 800-828).
   *
   * Only the ones the engine actually honours appear — see `keyword.ts` for the
   * three kinds a keyword can be and why the other two are not here. `tags` is
   * not the place for these for the same reason `championTag` is not: the
   * engine has to know *which* keyword it is holding, and picking one out of an
   * untyped string list would be a guess.
   */
  readonly keywords?: readonly Keyword[] | undefined;
  /**
   * This definition describes a **Token**, not a card (rules 179-187).
   *
   * Tokens are Game Objects with a type, a Might and tags, so they are read
   * through the same definition table as cards and share every engine read
   * site. Rule 185 makes them a different category all the same, and the
   * difference is load-bearing in three places: 186.1 makes a token cease to
   * exist rather than reach a Non-Board Zone, 350.2 keeps "played" from meaning
   * "played a card" (so a token never satisfies Legion), and deck construction
   * has no place for one at all.
   *
   * See `token.ts`. Nothing reads this field directly — `isTokenCard` does.
   */
  readonly token?: boolean | undefined;
}

/** Occupies the Legend Zone for the whole game and never leaves it. */
export interface LegendCard extends CardBase {
  readonly type: 'legend';
  /** The Domains this Legend unlocks for deck construction. */
  readonly domainIdentity: DomainIdentity;
}

/**
 * A fighter. `might` is a single stat used for damage dealt *and* damage
 * sustained: a 5-Might unit hits for 5 and is destroyed by 5.
 *
 * A deck's Chosen Champion is a Unit that begins in the Champion Zone; it is
 * flagged here rather than given its own card type.
 */
export interface UnitCard extends CardBase {
  readonly type: 'unit';
  readonly cost: Cost;
  readonly might: number;
  readonly champion: boolean;
  /** Rules text run when the Unit is played (rule 359.2.b). */
  readonly effect?: CardEffect | undefined;
}

export interface SpellCard extends CardBase {
  readonly type: 'spell';
  readonly cost: Cost;
  readonly timing: SpellTiming;
  /** Rules text run when the Spell resolves off the Chain (rule 359.3.d). */
  readonly effect?: CardEffect | undefined;
}

export interface GearCard extends CardBase {
  readonly type: 'gear';
  readonly cost: Cost;
  /** Rules text run when the Gear is played (rule 359.2.b). */
  readonly effect?: CardEffect | undefined;
}

/** Lives in the 12-card Rune deck and is Channelled to produce resources. */
export interface RuneCard extends CardBase {
  readonly type: 'rune';
  readonly domain: Domain;
}

/** A location fought over. Holding one at the start of your turn scores. */
export interface BattlefieldCard extends CardBase {
  readonly type: 'battlefield';
}

export type CardDefinition =
  | LegendCard
  | UnitCard
  | SpellCard
  | GearCard
  | RuneCard
  | BattlefieldCard;

/** Cards that are paid for. Legends, Runes and Battlefields are not. */
export type PlayableCard = UnitCard | SpellCard | GearCard;

export function isPlayable(card: CardDefinition): card is PlayableCard {
  return card.type === 'unit' || card.type === 'spell' || card.type === 'gear';
}

export function costOf(card: CardDefinition): Cost | undefined {
  return isPlayable(card) ? card.cost : undefined;
}

/** The card's rules text, if it has any. */
export function effectOf(card: CardDefinition): CardEffect | undefined {
  return isPlayable(card) ? card.effect : undefined;
}

/** Rule 133.7.b: does the Signature supertype apply to this card? */
export function isSignature(card: CardDefinition): boolean {
  return card.signature === true;
}

/**
 * Rule 133.7.a: the Champion supertype, which applies exclusively to Units.
 *
 * Only a Champion Unit may be a Chosen Champion (103.2.a.2).
 */
export function isChampionUnit(card: CardDefinition): card is UnitCard {
  return card.type === 'unit' && card.champion;
}
