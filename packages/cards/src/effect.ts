import type { Domain } from './domain.js';

/**
 * Card effects as data, not code.
 *
 * A card pool in the thousands is unmaintainable if each card is hand-written
 * control flow, so rules text is represented as small composable primitives
 * that the engine interprets. A minority of genuinely unique cards will need an
 * escape hatch eventually; this is deliberately not that.
 */

/**
 * What a card chooses to affect (rule 355.6).
 *
 * Targets are picked when the card is played — rule 355.8 requires valid
 * choices for every target before it can go on the Chain — and re-checked at
 * the Check Legality step (358.1).
 */
export type TargetSpec =
  /** Affects the controller, or nothing in particular. No choice to make. */
  | { readonly kind: 'none' }
  /**
   * A Unit on the Board (355.9.a.1).
   *
   * `scope` narrows by controller: `friendly` is the card's controller,
   * `enemy` is anyone else. `atBattlefield` restricts to Units at a
   * Battlefield rather than at a Base, the "unit at a battlefield" wording
   * rule 355.9.b gives as an example.
   */
  | {
      readonly kind: 'unit';
      readonly scope: 'any' | 'friendly' | 'enemy';
      readonly atBattlefield?: boolean | undefined;
    };

/** A single thing a card does. */
export type Effect =
  | { readonly kind: 'draw'; readonly count: number }
  /** Rule 417: mark damage on the target. */
  | { readonly kind: 'dealDamage'; readonly amount: number }
  /** Rule 418: clear marked damage from the target. */
  | { readonly kind: 'heal' }
  /**
   * Raise the target's Might until the end of turn.
   *
   * Deliberately not a Buff: rule 702.3 caps Buffs at one counter per Unit and
   * 703 fixes each at +1 Might, so a "+2 Might this turn" effect is a Might
   * modifier, not a Buff. Buffs are a separate mechanic and are not modelled.
   */
  | { readonly kind: 'giveMight'; readonly amount: number }
  /** Rule 429: Add resources to the controller's Rune Pool. */
  | { readonly kind: 'addEnergy'; readonly count: number }
  | { readonly kind: 'addPower'; readonly domain: Domain; readonly count: number }
  /**
   * Rule 428: send the target Permanent from the Board to the trash.
   *
   * A Kill Instruction, not lethal damage — 428.1.a.1 distinguishes the two,
   * and only this one is an effect. Rule 428.1.a.1.b puts a dying Unit's own
   * Deathknell on the Chain *before* it reaches the trash.
   */
  | { readonly kind: 'kill' }
  /**
   * Rules 454-458: relocate the target Permanent to its controller's Base.
   *
   * Explicitly not a Move (456): it triggers nothing that watches for Moves,
   * and cannot be blocked by anything that restricts Movement (456.3). Damage
   * and statuses survive it (458.1).
   */
  | { readonly kind: 'recall' }
  /** Rule 415: mark the target ready. Readying a ready object does nothing (415.1.c). */
  | { readonly kind: 'ready' }
  /** Rule 414: mark the target exhausted. */
  | { readonly kind: 'exhaust' }
  /**
   * Rules 701-705: place a Buff counter on the target Unit.
   *
   * Each Buff is +1 Might (703) and persists until the Unit leaves play (705).
   * Rule 702.3 permits only one at a time; a second is simply not placed
   * (702.3.a) rather than being an error.
   */
  | { readonly kind: 'buff' }
  /** Rule 702.2.b: remove a Buff from a friendly Unit. Nothing happens without one. */
  | { readonly kind: 'spendBuff' }
  /** Rule 422: the controller discards from hand to trash. */
  | { readonly kind: 'discard'; readonly count: number }
  /** Rules 728-733: XP is a player resource with no cap (733). */
  | { readonly kind: 'gainXp'; readonly amount: number }
  | { readonly kind: 'spendXp'; readonly amount: number }
  /**
   * Rule 430: put Runes from the top of the Rune Deck onto the Board.
   *
   * Too few Runes means channelling as many as possible (430.3) — deliberately
   * *not* a Burn Out, which is what an empty Main Deck causes (431).
   */
  | { readonly kind: 'channel'; readonly count: number; readonly exhausted?: boolean | undefined };

/*
 * Deliberately absent: `move` (rule 420).
 *
 * A Move needs two choices — which Game Object, and which Location it goes to —
 * and `CardEffect` carries exactly one target. Supporting it means letting a
 * target spec name a Location and letting an effect ask for more than one
 * choice, which is the sub-action protocol that trigger ordering and Combat
 * damage assignment also want. `recall` covers the case with no destination to
 * choose, since a Recall always goes to the controller's Base.
 */

/** The rules text of a card: what it targets, and what it then does. */
export interface CardEffect {
  readonly target: TargetSpec;
  /** Executed in order, which is how rule 359.2.b reads a card top to bottom. */
  readonly effects: readonly Effect[];
}

export const NO_TARGET: TargetSpec = { kind: 'none' };

/** True when playing this card requires the player to choose a target. */
export function needsTarget(effect: CardEffect | undefined): boolean {
  return effect !== undefined && effect.target.kind !== 'none';
}
