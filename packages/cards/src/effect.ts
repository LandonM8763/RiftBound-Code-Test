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
  | { readonly kind: 'addPower'; readonly domain: Domain; readonly count: number };

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
