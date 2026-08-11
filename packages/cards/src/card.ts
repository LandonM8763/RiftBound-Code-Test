import type { Cost } from './cost.js';
import type { CardEffect } from './effect.js';
import type { Domain, DomainIdentity } from './domain.js';

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
