import type { CardType } from './card.js';
import type { Condition } from './condition.js';
import type { Count } from './count.js';
import type { Domain } from './domain.js';
import type { Keyword } from './keyword.js';

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
    }
  /**
   * A card in the controller's own trash — "return a unit from your trash to
   * your hand".
   *
   * A separate variant rather than a `zone` field on `unit`, because the two
   * differ in what they may be: a Unit target is a Game Object on the Board
   * (355.9.a.1) and can be damaged, killed or moved, while this is a *card* in
   * a Non-Board Zone and the only thing that can be done with it is to move it
   * somewhere else. Keeping them apart is what stops "deal 3 to a unit" being
   * pointed at the trash.
   *
   * `cardType` narrows to "a **unit** from your trash", which is how the corpus
   * prints it; omitted, any card qualifies.
   */
  | { readonly kind: 'trashCard'; readonly cardType?: CardType | undefined };

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
  /**
   * "Draw 1", or "draw 1 **for each of your MIGHTY units**".
   *
   * `per` multiplies: the amount is `count` when it is absent, and
   * `count * <the count>` when it is present. Written that way rather than as a
   * union so the plain form stays a plain number, which is what almost every
   * card prints.
   */
  | { readonly kind: 'draw'; readonly count: number; readonly per?: Count | undefined }
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
  | { readonly kind: 'move' }
  /**
   * Rules 179-187: Create Token Game Objects on the Board.
   *
   * `token` keys `STANDARD_TOKENS`, because rule 187 defines the tokens that
   * exist by name and a token whose characteristics were guessed would be a
   * Unit on the Board that no rule describes.
   *
   * `where` is rule 184.2's restriction on the location a token may be played
   * to — `here` is the source's own location, which is the common printing
   * ("play a Recruit token **here**"), and `base` is the controller's Base. It
   * is deliberately not a `DestinationSpec`: that is a choice the player makes
   * for a `move`, whereas this one is fixed by the card doing the creating.
   *
   * 184.1 lets the creating effect override the default entry state, which is
   * what `ready` carries; without it a Unit enters exhausted (359.2.c).
   */
  | {
      readonly kind: 'createToken';
      readonly token: string;
      readonly count: number;
      readonly where: 'here' | 'base';
      readonly ready?: boolean | undefined;
    }
  /**
   * Put the target into its owner's hand.
   *
   * One primitive for two printings, because they differ only in what is
   * targeted: "return a unit at a battlefield to its owner's hand" bounces a
   * Permanent off the Board, and "return a unit from your trash to your hand"
   * retrieves a card. Both end in the same zone, and the destination is fixed
   * by the wording rather than chosen, so it is not a `DestinationSpec`.
   *
   * Rule 412 lists no "Return" action, so this is an ordinary zone move rather
   * than a named Game Action — which is exactly why it is *not* a Recall (456):
   * a Recall relocates a Permanent to its owner's **Base**, keeping it on the
   * Board with its damage and statuses intact (458.1). This takes it off the
   * Board entirely, so 705 strips its Buffs like any other departure.
   */
  | { readonly kind: 'toHand' }
  /**
   * "Give a unit ASSAULT 3 this turn" — grant a keyword until end of turn.
   *
   * Rule 801.3.a makes a granted keyword do exactly what a printed one does, so
   * the engine reads both through `keywordsOf` and nothing downstream can tell
   * them apart. 317.2.c expires it, which is why it is stored on the receiving
   * Unit beside `mightBonus` rather than as a static on the granting card: the
   * Spell that said it is in the trash by the time the keyword matters, and a
   * static stops the moment its source leaves the Board (365).
   *
   * Only the "this turn" wording is read. A grant with no stated duration would
   * have to persist, which is a different mechanic with different storage, so
   * the parser refuses it rather than guessing at an expiry.
   */
  | { readonly kind: 'grantKeyword'; readonly keyword: Keyword }
  /**
   * Rule 434: Attach the source to the chosen Unit, which becomes the Top-Most
   * Card (818.1.b.2).
   *
   * The direction reads backwards from the card text and is worth stating: a
   * Gear's "Equip a unit" attaches the *Gear* to the *Unit*, so the Unit is the
   * Top-Most Card and the Gear's Effect Text then reads as though printed on
   * it (718.3). `TargetSpec` names the Unit; the thing being attached is always
   * the effect's own source, because 818.1.c.2 makes Equip "attach **this
   * gear** to a unit you control".
   */
  | { readonly kind: 'attach' }
  /** Rule 435: unlink the source from whatever it is Attached to. */
  | { readonly kind: 'detach' };

/**
 * Recycle (rule 416) is deliberately **not** an effect primitive.
 *
 * It is a real Game Action and the engine already performs it in the two places
 * the rules demand — a Basic Rune's `Recycle this: Add [C]` (164.2.b) and the
 * Burn Out of 431.2.b — but as a *card effect* it measured +0. The targeted
 * form the grammar could read ("recycle me") appears once, on a card blocked by
 * the rest of its own sentence; 416.6's "Recycle X from [Zone]" appears on
 * cards blocked by their ability *cost* rather than their effect.
 *
 * It was built, measured at +0, and removed — the same evidence that keeps
 * Repeat (820) out. Add it when a counterfactual re-parse moves the number.
 */

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
  return spec !== undefined && (spec.kind === 'unit' || spec.kind === 'trashCard');
}

/** True when playing this card requires the player to choose a Destination. */
export function needsDestination(effect: CardEffect | undefined): boolean {
  return effect?.destination?.kind === 'battlefield';
}
