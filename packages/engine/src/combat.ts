/**
 * The Steps of Combat (rules 459-466).
 *
 * The single most misreported part of Riftbound. There is **no** "compare total
 * Might, higher total wins" step and **no** "a tie destroys everything" rule.
 * What actually happens:
 *
 * 1. Each side sums its Might (465.2.a-b).
 * 2. Each player assigns damage equal to their summed Might among the *other*
 *    side's Units, lethal-first (465.2.c.3) and without overkill while other
 *    Units remain (465.2.c.4).
 * 3. Assignment is not dealing: all assigned damage is dealt simultaneously
 *    (465.2.c.1.a), so both sides can wipe each other out.
 * 4. The Combat Cleanup heals survivors and Recalls surviving Attackers if any
 *    Defender is still present (466.1.a.2).
 * 5. The result is decided by who has Units remaining, not by Might (466.3).
 */
import type { EntityId, GameState, PlayerId } from './state.js';
import { entityCard, getEntity } from './state.js';

/** Might of a Unit, floored at 0 for summing purposes (rule 143.2.b). */
export function mightOf(state: GameState, unit: EntityId): number {
  const card = entityCard(state, unit);
  if (card.type !== 'unit') {
    return 0;
  }
  // Rule 143.2.b: a Might below 0 counts as 0 when summing for damage.
  return Math.max(0, card.might + getEntity(state, unit).mightBonus);
}

export function sumMight(state: GameState, units: readonly EntityId[]): number {
  return units.reduce((total, unit) => total + mightOf(state, unit), 0);
}

/** Damage still needed to kill a Unit (rules 142.4.b, 143.2.a). */
export function lethalRemaining(state: GameState, unit: EntityId): number {
  return Math.max(1, mightOf(state, unit) - getEntity(state, unit).damage);
}

/** True once marked damage equals or exceeds Might, and is non-zero. */
export function hasLethalDamage(state: GameState, unit: EntityId): boolean {
  const damage = getEntity(state, unit).damage;
  return damage > 0 && damage >= mightOf(state, unit);
}

/**
 * Assign `total` damage among `targets` (rule 465.2.c).
 *
 * 465.2.c.3: a Unit must be assigned lethal damage in full before any is
 * assigned to a different Unit.
 * 465.2.c.4: a Unit cannot be assigned more than the minimum lethal amount
 * while other Units remain to be assigned to.
 *
 * SIMPLIFICATION: the *order* of assignment is the assigning player's choice,
 * and a real one — it decides which enemy Units die. This walks the targets in
 * a fixed order instead. Every constraint above is still obeyed, so the totals
 * and the number of deaths are right, but which Units die is not yet a
 * decision. Making it one needs a sub-action protocol during the Damage Step;
 * that is the seam.
 */
export function assignDamage(
  state: GameState,
  total: number,
  targets: readonly EntityId[],
): Map<EntityId, number> {
  const assignment = new Map<EntityId, number>();
  let remaining = total;

  for (let i = 0; i < targets.length && remaining > 0; i += 1) {
    const unit = targets[i] as EntityId;
    const needed = lethalRemaining(state, unit);

    if (remaining >= needed) {
      assignment.set(unit, needed);
      remaining -= needed;
      continue;
    }

    // Not enough left for lethal. 465.2.c.4 only forbids exceeding lethal, so
    // the remainder lands here and this Unit survives.
    assignment.set(unit, remaining);
    remaining = 0;
  }

  return assignment;
}

export interface CombatSides {
  readonly attacker: PlayerId;
  readonly defender: PlayerId;
  readonly attackingUnits: readonly EntityId[];
  readonly defendingUnits: readonly EntityId[];
}

/** Split the Units at a Battlefield by Attacker and Defender (rule 464.2.c). */
export function combatSides(
  state: GameState,
  battlefield: number,
  attacker: PlayerId,
  defender: PlayerId,
): CombatSides {
  const units = state.battlefields[battlefield]?.units ?? [];
  const attackingUnits: EntityId[] = [];
  const defendingUnits: EntityId[] = [];

  for (const unit of units) {
    const controller = getEntity(state, unit).controller;
    if (controller === attacker) {
      attackingUnits.push(unit);
    } else if (controller === defender) {
      defendingUnits.push(unit);
    }
  }

  return { attacker, defender, attackingUnits, defendingUnits };
}

export type CombatResult =
  | { readonly kind: 'won'; readonly winner: PlayerId; readonly loser: PlayerId }
  | { readonly kind: 'noResult'; readonly reason: 'recalled' | 'both' | 'neither' };

/**
 * Decide the outcome (rule 466.3).
 *
 * A player wins if they are the only one with Units remaining; loses if they
 * are the only one without. It is No Result if Attackers were Recalled, or if
 * both or neither side has Units left.
 */
export function combatResult(
  attackerHasUnits: boolean,
  defenderHasUnits: boolean,
  attackersRecalled: boolean,
  sides: CombatSides,
): CombatResult {
  if (attackersRecalled) {
    return { kind: 'noResult', reason: 'recalled' };
  }
  if (attackerHasUnits && !defenderHasUnits) {
    return { kind: 'won', winner: sides.attacker, loser: sides.defender };
  }
  if (defenderHasUnits && !attackerHasUnits) {
    return { kind: 'won', winner: sides.defender, loser: sides.attacker };
  }
  return { kind: 'noResult', reason: attackerHasUnits ? 'both' : 'neither' };
}
