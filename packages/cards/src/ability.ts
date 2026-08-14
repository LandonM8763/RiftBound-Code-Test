/**
 * Abilities as data (rules 376-395).
 *
 * Card *effects* answer "what does this do"; abilities answer "when, and at
 * what price". Both stay data for the same reason: a pool in the thousands is
 * unmaintainable as hand-written control flow.
 */
import type { CardType } from './card.js';
import type { Cost } from './cost.js';
import type { AdditionalCost } from './additional-cost.js';
import type { CostModifier } from './cost-modifier.js';
import type { CardEffect } from './effect.js';
import type { StaticAbility } from './static.js';

/**
 * A gate on an otherwise ordinary ability — the rulebook's Dependent Keywords
 * (801.1, 812.1, 824.1).
 *
 * 812.1.b: "Starting from the Keyword to the end of the clause, the entire
 * statement is the Legion Ability", and 812.1.b.1 expands it to "If you have
 * played another card this turn, this card gains [Text]". So a Dependent
 * Keyword does not change *what* the ability does or *when* it fires — it
 * decides whether the ability is there at all. That is why it sits on the
 * ability rather than in `Keyword`.
 */
export type AbilityDependency =
  /**
   * Legion (812.1.c): satisfied while a card *other than this one* has been
   * Finalized by the controller this turn.
   *
   * 812.2: one card satisfies every Legion on everything that player controls.
   */
  | { readonly kind: 'legion' }
  /** Level N (824.1.c): satisfied while the controller has at least N XP. */
  | { readonly kind: 'level'; readonly xp: number };

/**
 * A repeatable effect with a cost (rule 377).
 *
 * Printed with a colon — "[2]: Draw 1" — the cost before it and the effect
 * after (377.1). Rule 381 restricts activation to the controller's own turn
 * during an Open State, and 380 to sources on the Board.
 */
export interface ActivatedAbility {
  readonly cost: Cost;
  /**
   * Whether exhausting the source is part of the cost, printed as the exhaust
   * symbol (rule 414). Separate from `cost` because it is paid with the source
   * itself rather than out of the Rune Pool.
   */
  readonly exhaustSelf?: boolean | undefined;
  /** A Dependent Keyword gating this ability (801.1). */
  readonly dependsOn?: AbilityDependency | undefined;
  readonly effect: CardEffect;
}

/**
 * The kind of thing that happened (rule 383.2).
 *
 * Deliberately an *event*, not a condition: the engine raises one of these when
 * something occurs, and each ability's `TriggerCondition` decides whether it
 * cares. The previous shape put the whole condition in the variant, which meant
 * every new wording on a real card was a new variant — and measuring the card
 * corpus showed that tail is flat, so 23 more variants would have bought 23
 * cards and no structure. An event plus a filter is what generalizes.
 *
 * Only events the engine actually raises appear here. A wording the engine has
 * no event for is refused at ingest rather than approximated.
 */
export type TriggerEvent =
  /** A card was Finalized and entered the Board (383.4.a, a Play Effect). */
  | 'played'
  /** A Unit died (428). */
  | 'dies'
  /** Scoring by Conquer (469.1). */
  | 'conquer'
  /** Scoring by Hold (469.2), in the Beginning Phase's Scoring Step. */
  | 'hold'
  /** A Move completed (446). Not a Recall, which is not a Move (456). */
  | 'move'
  /** A Combat resolved with this player as the winner (466.3). */
  | 'winCombat'
  /** A Buff was placed (702). */
  | 'buffed'
  /** One or more cards were discarded (422). */
  | 'discard'
  /** An Activated Ability was used (377.3). */
  | 'activateAbility'
  /**
   * The controller's Beginning Phase started (315.2.a).
   *
   * Fires in the Beginning Step, *before* the Scoring Step, so a trigger that
   * changes who Controls a Battlefield changes what gets Held that turn.
   */
  | 'beginningPhase'
  /** The end-of-turn effects of 317.1. */
  | 'endOfTurn';

/**
 * Whose event it has to be, relative to the ability's source.
 *
 * This is the half of a trigger condition that the old shape could not say at
 * all: "When I die" and "When a friendly unit dies" watch the same event and
 * differ only here.
 */
export type TriggerSubject =
  /** The source itself: "When I die", "When I move from a battlefield". */
  | 'self'
  /** The source's controller did it: "When you play a spell". */
  | 'you'
  /** Anything that player controls: "When a friendly unit dies". */
  | 'friendly'
  /** Anything an opponent controls: "When one or more enemy units die". */
  | 'enemy'
  /** Anyone's: "When a unit dies". */
  | 'any';

/**
 * Extra requirements on the event's object (383.1).
 *
 * Every field is a conjunct: all present ones must hold. An absent field
 * imposes nothing.
 */
export interface TriggerFilter {
  /** "a spell", "a gear" — the type of the card the event is about. */
  readonly cardType?: CardType | undefined;
  /** "another unit" — the object must not be the ability's own source. */
  readonly excludeSelf?: boolean | undefined;
  /** "a spell that costs 5 or more" — against the object's printed Energy. */
  readonly minEnergy?: number | undefined;
  /** "a card with power cost 2 runes or more" — against its printed Power pips. */
  readonly minPower?: number | undefined;
  /** "here" (355.9) — the event happened at the source's own Location. */
  readonly here?: boolean | undefined;
  /**
   * "your second card in a turn" — the event must be the Nth of its kind for
   * that actor this turn, counting from 1.
   *
   * Distinct from `TriggeredAbility.limitPerTurn`, which caps how often the
   * ability may fire; this picks out *which* occurrence fires it.
   */
  readonly ordinal?: number | undefined;
}

/**
 * What makes a Triggered Ability fire (rule 383.1).
 *
 * Rule 383.1 also allows "the Nth time" conditions; `filter.ordinal` covers the
 * "your second X" form and `limitPerTurn` covers "the first time ... each
 * turn".
 */
export interface TriggerCondition {
  readonly event: TriggerEvent;
  /**
   * Required rather than defaulted. "When I die" and "When a friendly unit
   * dies" are both plausible readings of an absent subject, and guessing
   * between them silently is exactly the kind of wrong-but-plausible card the
   * ingest gap model exists to prevent.
   */
  readonly subject: TriggerSubject;
  readonly filter?: TriggerFilter | undefined;
}

export interface TriggeredAbility {
  readonly condition: TriggerCondition;
  /**
   * Rule 383.3.a: a "you may" as the first part of the effect makes performing
   * it the controller's choice at finalization, and 383.3.e.2.b removes it from
   * the Chain if they decline.
   */
  readonly optional?: boolean | undefined;
  /**
   * Rule 383.3.e: "once each turn" and friends. Once the ability has been
   * performed this many times in a turn, the condition stops triggering it.
   */
  readonly limitPerTurn?: number | undefined;
  /** A Dependent Keyword gating this ability (801.1) — "Legion > When ...". */
  readonly dependsOn?: AbilityDependency | undefined;
  readonly effect: CardEffect;
}

/** Which ability of a source a Chain item refers to. */
export interface AbilityRef {
  readonly kind: 'activated' | 'triggered';
  readonly index: number;
  /**
   * The Attached card lending this ability, when 718.3 is why the source has
   * it — the entity id of the Gear, not of the Top-Most Card.
   *
   * The two are deliberately separate. 718.3 appends the Effect Text's
   * abilities *to the Rules Text of the Top-Most Card*, so the ability belongs
   * to that card: "when I conquer, buff me" on an Equipment means the equipped
   * Unit conquering and the equipped Unit being buffed. But the ability's
   * *text* lives on the Gear, so finding it again needs to know which card to
   * read — which is what this is for. It also keys 383.3.e's per-turn limit,
   * so two Gear at the same ability index do not share one counter.
   */
  readonly from?: EntityId | undefined;
}

/**
 * An entity id, as an opaque number.
 *
 * Declared here rather than imported: `@riftbound/cards` sits below the engine
 * and must not depend on it, and an `AbilityRef` has to be able to name the
 * card an ability came from. The engine's own `EntityId` is the same branded
 * number and the two unify.
 */
export type EntityId = number & { readonly __brand: 'EntityId' };

export interface CardAbilities {
  readonly activated?: readonly ActivatedAbility[] | undefined;
  readonly triggered?: readonly TriggeredAbility[] | undefined;
  /**
   * Passive cost modifiers this card applies while on the Board (rules 356,
   * 363, 365.1). A standing statement, not something that fires.
   */
  readonly costModifiers?: readonly CostModifier[] | undefined;
  /**
   * Static abilities: Might modifiers and granted keywords (363-365).
   *
   * Separate from `costModifiers` because rule 356 gives cost modification a
   * layered ordering that Might and keywords do not have.
   */
  readonly statics?: readonly StaticAbility[] | undefined;
  /**
   * Additional Costs to play this card (356.2), layer 2 of Total Cost.
   *
   * On the card being played rather than in `CostModifier`, because they are
   * paid with actions rather than applied as arithmetic — see
   * `additional-cost.ts`.
   */
  readonly additionalCosts?: readonly AdditionalCost[] | undefined;
}

export function staticAbilities(abilities: CardAbilities | undefined): readonly StaticAbility[] {
  return abilities?.statics ?? [];
}

export function activatedAbilities(abilities: CardAbilities | undefined): readonly ActivatedAbility[] {
  return abilities?.activated ?? [];
}

export function triggeredAbilities(abilities: CardAbilities | undefined): readonly TriggeredAbility[] {
  return abilities?.triggered ?? [];
}

/** Shorthand for the common "when you play me" Play Effect condition (383.4.a). */
export const ON_PLAY: TriggerCondition = Object.freeze({ event: 'played', subject: 'self' });
