/**
 * Abilities as data (rules 376-395).
 *
 * Card *effects* answer "what does this do"; abilities answer "when, and at
 * what price". Both stay data for the same reason: a pool in the thousands is
 * unmaintainable as hand-written control flow.
 */
import type { Cost } from './cost.js';
import type { CardEffect } from './effect.js';

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
  readonly effect: CardEffect;
}

/**
 * What makes a Triggered Ability fire (rule 383.1).
 *
 * A deliberately small set: the conditions that are both common on real cards
 * and reachable with the events the engine already emits. Rule 383.1 also
 * allows "the Nth time" conditions, which need per-turn counters keyed by
 * event instance and are not modelled — see `limitPerTurn` for the part of
 * that which is.
 */
export type TriggerCondition =
  /** Rule 383.4.a, a Play Effect: "When you play me". */
  | { readonly kind: 'played' }
  /** "When I die" — evaluated after the death is processed (383.2.c). */
  | { readonly kind: 'dies' }
  /** "When you conquer here" — Scoring by Conquer (469.1). */
  | { readonly kind: 'conquer' }
  /**
   * "At the start of your Beginning Phase" (315.2.a).
   *
   * Fires in the Beginning Step, *before* the Scoring Step, so a trigger that
   * changes who Controls a Battlefield changes what gets Held that turn.
   */
  | { readonly kind: 'beginningPhase' }
  /** "At the end of your turn" — the end-of-turn effects of 317.1. */
  | { readonly kind: 'endOfTurn' };

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
  readonly effect: CardEffect;
}

/** Which ability of a source a Chain item refers to. */
export interface AbilityRef {
  readonly kind: 'activated' | 'triggered';
  readonly index: number;
}

export interface CardAbilities {
  readonly activated?: readonly ActivatedAbility[] | undefined;
  readonly triggered?: readonly TriggeredAbility[] | undefined;
}

export function activatedAbilities(abilities: CardAbilities | undefined): readonly ActivatedAbility[] {
  return abilities?.activated ?? [];
}

export function triggeredAbilities(abilities: CardAbilities | undefined): readonly TriggeredAbility[] {
  return abilities?.triggered ?? [];
}

/** True when the two conditions are the same trigger. */
export function sameCondition(a: TriggerCondition, b: TriggerCondition): boolean {
  return a.kind === b.kind;
}
