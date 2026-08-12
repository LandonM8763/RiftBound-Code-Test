import type { Condition } from './condition.js';
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
   * The Game Object whose text this is — the "me" of "ready me", "give me +2
   * Might".
   *
   * Not a target *choice*: rule 355.6 is about choosing something, and "me" is
   * already determined by which card the text is printed on. So it is resolved
   * when the effect executes rather than enumerated when the card is played,
   * and `needsTarget` is false for it.
   */
  | { readonly kind: 'self' }
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

/**
 * Where a `move` effect sends its target (rule 449.1).
 *
 * A second choice alongside `target`, made at the same time and for the same
 * reason — rule 355.8 wants every choice settled before the card reaches the
 * Chain. `base` needs no choice at all; `battlefield` is enumerated the way
 * targets are, one action per legal destination.
 */
export type DestinationSpec =
  /** Any Battlefield the Unit may legally reach. */
  | { readonly kind: 'battlefield' }
  /** The controller's own Base. */
  | { readonly kind: 'base' };

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
  | { readonly kind: 'channel'; readonly count: number; readonly exhausted?: boolean | undefined }
  /**
   * Rules 420, 445-453: move the target to the card's chosen Destination.
   *
   * A real Move, unlike `recall`: it Contests the Destination (450), can open
   * a Showdown or a Combat (451-452), and is followed by a Cleanup (453). It
   * costs no exhaust — that is the Standard Move's price (420.3.a), not this
   * one's. The Destination comes from `CardEffect.destination`.
   */
  | { readonly kind: 'move' };

/** The rules text of a card: what it targets, and what it then does. */
export interface CardEffect {
  readonly target: TargetSpec;
  /**
   * Where a `move` effect on this card sends its target (rule 449.1).
   *
   * One per card rather than one per effect, matching `target`: a card that
   * moves something twice to two separately chosen places would need the
   * general sub-action protocol, and none of that exists yet.
   */
  readonly destination?: DestinationSpec | undefined;
  /** Executed in order, which is how rule 359.2.b reads a card top to bottom. */
  readonly effects: readonly Effect[];
  /**
   * "When you play me, **if you control a Poro**, buff me and draw 1."
   *
   * A condition on the whole clause: when it fails, nothing in `effects` runs.
   * Shared with statics and cost modifiers — see `condition.ts`.
   */
  readonly condition?: Condition | undefined;
}

export const NO_TARGET: TargetSpec = { kind: 'none' };

/** True when playing this card requires the player to choose a target. */
export function needsTarget(effect: CardEffect | undefined): boolean {
  return needsTargetChoice(effect?.target);
}

/**
 * True when a spec makes the player choose. `none` and `self` do not: one
 * affects nobody in particular, the other is already determined.
 */
export function needsTargetChoice(spec: TargetSpec | undefined): boolean {
  return spec !== undefined && spec.kind === 'unit';
}

/** True when playing this card requires the player to choose a Destination. */
export function needsDestination(effect: CardEffect | undefined): boolean {
  return effect?.destination?.kind === 'battlefield';
}
