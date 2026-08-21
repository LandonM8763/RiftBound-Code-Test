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
/**
 * How many objects one target spec chooses (rule 355.6).
 *
 * `min` below `max` is the "**up to** 2" wording, where choosing fewer — or
 * none — is legal; equal bounds are the "give **two** friendly units each"
 * wording, where the card does nothing if the board cannot supply them (355.8).
 */
export interface TargetCount {
  readonly min: number;
  readonly max: number;
}

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
      /**
       * "an enemy unit **here**" — 355.9's here, the source's own Battlefield.
       *
       * Source-relative, like `StaticScope.here` and the `all` spec's: a source
       * that is not at a Battlefield names none, so nothing qualifies and 355.8
       * makes the card unplayable rather than letting it reach the whole Board.
       * Distinct from `atBattlefield`, which admits every Battlefield.
       */
      readonly here?: boolean | undefined;
      /**
       * "**another** friendly unit" — never the effect's own source.
       *
       * The same word `StaticScope.excludeSelf` reads, and load-bearing for the
       * same reason: without it "when you play me, buff another friendly unit"
       * would offer the card itself, which the printed text forbids.
       */
      readonly excludeSelf?: boolean | undefined;
      /**
       * "an enemy unit **with 3 Might or less**" — an upper bound on effective
       * Might (143), not on printed Might.
       *
       * Effective because that is what the card asks about at the moment it is
       * chosen: a Unit buffed past the bound is not a legal choice, and 358.1
       * re-checks it when the effect resolves.
       */
      readonly maxMight?: number | undefined;
      /**
       * "Kill a gear", "return a gear to its owner's hand".
       *
       * Defaults to `unit`. A Gear is a Permanent like a Unit (428 kills either
       * one), so the same spec covers both and only the sweep differs; what a
       * Gear cannot be is *damaged*, and a card that says "deal 3 to a gear"
       * does not exist to be read wrong.
       */
      readonly cardType?: 'unit' | 'gear' | undefined;
      /**
       * "**up to 2** friendly units", "give **two** friendly units each +1
       * Might" — one choice of several objects rather than several choices.
       *
       * Omitted means exactly one, which is what every other spec here means.
       * Rule 355.6 makes each chosen object a Target, so a counted spec is
       * still choosing: 355.8 wants the whole set settled before the card
       * reaches the Chain, and 358.1 re-checks every member of it.
       *
       * Bounded on purpose. `legalActions` enumerates the combinations, so an
       * unbounded "any number of" would be 2^n actions — and the corpus only
       * prints that alongside damage splitting, which is a mechanic of its
       * own.
       */
      readonly count?: TargetCount | undefined;
    }
  /**
   * **Every** Game Object matching the criteria — "deal 2 to all enemy units",
   * "kill all gear".
   *
   * Rule 355.5.a is why this is a separate variant rather than a flag on
   * `unit`: choosing is what makes something a Target, and "cards that affect
   * one or more Game Objects based on criteria" are explicitly *not* choosing.
   * So this needs no choice at play time, is enumerated at resolution instead,
   * and 358.1's re-check does not apply to it.
   *
   * `inCombat` is the "all enemy units in combat" wording: the Units present at
   * the Battlefield where a Combat is running (464).
   */
  | {
      readonly kind: 'all';
      readonly scope: 'any' | 'friendly' | 'enemy';
      readonly cardType?: 'unit' | 'gear' | undefined;
      readonly atBattlefield?: boolean | undefined;
      readonly inCombat?: boolean | undefined;
      /**
       * "all units at **my** battlefield" — 355.9's "here", the same
       * source-relative scope `StaticScope.here` uses.
       *
       * A source at a Base names no Battlefield, so the set is empty rather
       * than the whole Board. Distinct from `atBattlefield`, which is "at *a*
       * battlefield" and covers all of them.
       */
      readonly here?: boolean | undefined;
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
  | { readonly kind: 'trashCard'; readonly cardType?: CardType | undefined }
  /**
   * A card or ability on the Chain — 425.3's "Counter [a card or ability on the
   * chain]".
   *
   * Its own variant rather than a `zone` on `unit`, for the same reason
   * `trashCard` is: what may be done with it is different. A Chain item is not
   * a Game Object on the Board (359.2 takes a Permanent off the Chain at once,
   * so only Spells and abilities ever linger), so it cannot be damaged, killed
   * or moved — only Countered.
   *
   * `cardType` narrows to "a **spell** on the chain", which is how the corpus
   * prints it; omitted, an ability qualifies too. `maxEnergy` and `maxPower`
   * are the "that costs no more than 4" wordings, read against the printed
   * cost (356.1.c).
   */
  | {
      readonly kind: 'chainItem';
      readonly cardType?: CardType | undefined;
      readonly maxEnergy?: number | undefined;
      readonly maxPower?: number | undefined;
    }
  /**
   * A Gear on the Board its controller owns — 821.1.c's "a Card you control
   * with the Equipment tag".
   *
   * Separate from `unit` rather than a `cardType` on it, because the two admit
   * different things: a Unit target can be damaged, killed, moved and healed,
   * and a Gear can be none of those. Keeping them apart is what stops "deal 3
   * to a unit" reaching an Equipment.
   *
   * 821.1.c.1 chooses an Equipment "whether it has an Equip ability or not",
   * so nothing here requires one; what happens to a Gear without one is the
   * `equip` effect's business (821.1.c.4: the cost cannot be paid).
   */
  | { readonly kind: 'gear'; readonly scope: 'friendly' };

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
/**
 * One step of a card's rules text, with an optional guard on it.
 *
 * `Effect` is the verb; this is the verb plus "if …". Two shapes needed it:
 * "If it is stunned, kill it. **Otherwise**, stun it" is two guarded steps
 * rather than a branch tree, and "if it was an enemy unit, …" is one.
 *
 * **Every guard is evaluated once, before any step runs.** A step's condition
 * asks about the situation the card is responding to, not about what the card's
 * own earlier steps did — so "if it is stunned, kill it. Otherwise, stun it"
 * cannot stun the Unit it just killed. Reading an earlier step's *outcome* is a
 * different mechanic (an outcome register) and is deliberately not this one.
 */
export type GuardedEffect = Effect & { readonly condition?: Condition | undefined };

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
   * Change the target's Might until the end of turn. Signed: "+2 Might this
   * turn" and "-2 Might this turn" are one effect with opposite amounts.
   *
   * Deliberately not a Buff: rule 702.3 caps Buffs at one counter per Unit and
   * 703 fixes each at +1 Might, so a "+2 Might this turn" effect is a Might
   * modifier, not a Buff. Buffs are a separate mechanic of their own.
   *
   * `minimum` is the printed "to a minimum of 1 Might": the reduction stops
   * there rather than continuing past it. **Measured against the Unit's actual
   * Might, not its floored one** — 143.2.b.1 says a Might treated as 0 "is not
   * 0" and that effects calculating increases and decreases use the actual
   * value, so a Unit already below the floor is not *raised* by a reduction.
   * Only meaningful with a negative `amount`.
   */
  | {
      readonly kind: 'giveMight';
      readonly amount: number;
      readonly minimum?: number | undefined;
    }
  /** Rule 429: Add resources to the controller's Rune Pool. */
  | { readonly kind: 'addEnergy'; readonly count: number }
  | { readonly kind: 'addPower'; readonly domain: Domain; readonly count: number }
  /**
   * "Add [A]" — Power of any Domain (135.2.e.5).
   *
   * Separate from `addPower` rather than a seventh Domain, because 135.2.e.5.b
   * makes it a wildcard *in the pool*: it "can be spent to pay a Power cost of
   * any Domain", so the Domain is settled when it is spent rather than when it
   * arrives. Adding it as some chosen Domain would strand it the moment a later
   * cost wanted a different one.
   */
  | { readonly kind: 'addAnyPower'; readonly count: number }
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
   * Rule 423: render the target Unit Stunned.
   *
   * 423.1.b is all it does — the Unit contributes no Might to combat damage —
   * and 423.1.c is what it pointedly does not: killing it still takes damage
   * equal to its full Might. 423.1.a.1 makes stunning an already-Stunned Unit
   * legal but inert, and specifically *not* an event, which is why the reducer
   * raises the trigger only when the status actually changes.
   */
  | { readonly kind: 'stun' }
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
  /**
   * Recycle the top `count` cards of the controller's own Main Deck (436.1).
   *
   * The performing half of Predict, and the only place a Recycle appears as a
   * card *effect*: 416.6's "Recycle N from your trash" is a cost, and a plain
   * targeted Recycle measured +0 and was removed. This one earns its place
   * because Predict is not expressible without it.
   *
   * 436.4: Predicting more cards than the deck holds Predicts as many as
   * possible, and 436.4.a is explicit that it is **not** a Burn Out — which is
   * what distinguishes this from drawing.
   */
  | { readonly kind: 'recycleTop'; readonly count: number }
  /**
   * "You score 1 point" (467-471).
   *
   * 468.1 makes every Score an instance of gaining points, and 471.1.a.1 says
   * points from sources that are not Conquer are **not** beholden to the Final
   * Point restriction (471.1.b) — so this is a plain gain with no extra
   * condition, unlike the Conquer path in the reducer.
   *
   * 470's once-per-Battlefield-per-turn cap does not apply either: that rule is
   * about Scoring *a Battlefield*, and this names none.
   */
  | { readonly kind: 'score'; readonly amount: number }
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
   * 184.1 lets the creating effect override the default entry state "if that
   * state is contrary to the default for the token's type", which is exactly
   * what `ready` carries — and why it is a tri-state rather than a boolean.
   * Absent, 185.2.d gives the token its type's default: a Unit enters exhausted
   * (359.2.c) and a Gear enters ready (359.2.d). That is why the corpus prints
   * "play a Gold gear token **exhausted**": for a Gear, exhausted is the
   * override.
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
  | { readonly kind: 'detach' }
  /**
   * Counter the chosen Chain item (425).
   *
   * 425.1.a: it "does nothing and is cleared from the chain", and 425.1.a.1
   * sends a cleared *card* to the trash — an ability has none to send. 425.1.b
   * is what makes this more than a removal: a Countered card "is not considered
   * to have been played", so nothing that watches for cards being played sees
   * it. 425.1.c refunds nothing, which needs no code: the cost was paid when
   * the item went on the Chain and this touches no pool.
   */
  | { readonly kind: 'counter' }
  /**
   * Rule 821: pay the chosen Equipment's own Equip cost and Attach it to the
   * source. Weaponmaster, and nothing else.
   *
   * **The direction is the opposite of `attach`.** `attach` links the source to
   * the chosen Unit — the Gear's own Equip ability. This links the chosen *Gear*
   * to the source Unit, because 821.1.c is printed on the Unit.
   *
   * It is also the one effect that *pays* something. The cost is read off the
   * target, so it cannot be settled at step 3 the way every other cost is —
   * 402.2 chooses the target, and only then is there a cost to work out.
   * 821.1.c.5 makes an unpayable one a no-op rather than an error, which is why
   * that is safe: the Equipment "stays in its current location, Attached to
   * anything it was already Attached to".
   *
   * `discountAnyPower` is 821.1.c's "reduced by [A]". 821.1.c.3 needs no code:
   * a cost with no `[A]` in it simply has none to remove.
   */
  | { readonly kind: 'equip'; readonly discountAnyPower?: number | undefined };

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
  /**
   * Executed in order, which is how rule 359.2.b reads a card top to bottom.
   *
   * Each step may carry its own guard — see `GuardedEffect`.
   */
  readonly effects: readonly GuardedEffect[];
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
  return (
    spec !== undefined &&
    (spec.kind === 'unit' ||
      spec.kind === 'trashCard' ||
      spec.kind === 'gear' ||
      spec.kind === 'chainItem')
  );
}

/**
 * How many objects a spec chooses. Everything but a counted `unit` chooses
 * exactly one, so this is where the default lives rather than at each caller.
 */
export function targetCount(spec: TargetSpec | undefined): TargetCount {
  return spec?.kind === 'unit' && spec.count !== undefined ? spec.count : { min: 1, max: 1 };
}

/** True when playing this card requires the player to choose a Destination. */
export function needsDestination(effect: CardEffect | undefined): boolean {
  return effect?.destination?.kind === 'battlefield';
}
