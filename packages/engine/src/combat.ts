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
import { staticMight, unitHasKeyword, unitKeywordValue } from './statics.js';
import type { EntityId, GameState, PlayerId } from './state.js';
import { entityCard, getEntity } from './state.js';

/**
 * The designation a Unit has gained in a Combat (rule 464.2.c).
 *
 * Assault and Shield are conditioned on it — 807.1.d and 814.1.d both say the
 * keyword applies while the Unit *has the designation*, not while a Combat is
 * merely happening. So it is a parameter rather than something read off the
 * state: a Unit's Might outside Combat is not its Might inside one, and the
 * view, the heuristic and the invariant checker all want the plain number.
 */
export type CombatRole = 'attacker' | 'defender';

/**
 * Might of a Unit, floored at 0 for summing purposes (rule 143.2.b).
 *
 * `role` adds the Combat-only keywords. Might is both the damage a Unit deals
 * and the damage it survives, so Assault and Shield have to reach every use of
 * this — summing, lethal thresholds and the death check alike. Passing the role
 * through rather than defaulting it is what stops one of those being missed.
 */
export function mightOf(state: GameState, unit: EntityId, role?: CombatRole): number {
  const card = entityCard(state, unit);
  if (card.type !== 'unit') {
    return 0;
  }
  const entity = getEntity(state, unit);
  // 807.1.c: "While I am an attacker, I have +X Might." 814.1.c is the mirror
  // for a defender. 807.2/814.2: multiple instances sum, and the value is read
  // over granted keywords as well as printed ones — a granted Assault is an
  // Assault (801.3.a).
  const designation =
    role === 'attacker'
      ? unitKeywordValue(state, unit, 'assault')
      : role === 'defender'
        ? unitKeywordValue(state, unit, 'shield')
        : 0;
  // Rule 703: each Buff contributes +1 Might. 143.2.b: a Might below 0 counts
  // as 0 when summing for damage. Static Might (363) is not on the Unit at all,
  // which is why it is asked for rather than stored.
  return Math.max(
    0,
    card.might + entity.mightBonus + entity.buffs + designation + staticMight(state, unit),
  );
}

export function sumMight(state: GameState, units: readonly EntityId[], role?: CombatRole): number {
  return units.reduce(
    // 423.1.b: "A Stunned Unit does not contribute its might to damage in the
    // combat damage step." Only here — 423.1.c keeps its full Might as the
    // damage needed to kill it, which is why `lethalRemaining` below reads
    // `mightOf` directly and this does not.
    (total, unit) => total + (getEntity(state, unit).stunned ? 0 : mightOf(state, unit, role)),
    0,
  );
}

/**
 * Damage still needed to kill a Unit (rules 142.4.b, 143.2.a).
 *
 * 423.1.c is explicit that a Stunned Unit "must still have damage applied to it
 * equal to, or greater than, its full might value to be killed", so being
 * Stunned deliberately changes nothing here.
 */
export function lethalRemaining(state: GameState, unit: EntityId, role?: CombatRole): number {
  return Math.max(1, mightOf(state, unit, role) - getEntity(state, unit).damage);
}

/** True once marked damage equals or exceeds Might, and is non-zero. */
export function hasLethalDamage(state: GameState, unit: EntityId, role?: CombatRole): boolean {
  const damage = getEntity(state, unit).damage;
  return damage > 0 && damage >= mightOf(state, unit, role);
}

/**
 * The order damage must be assigned in, by rule (815, 826).
 *
 * Tank (815.1.b) must be assigned lethal damage *before* any same-controller
 * Unit without it; Backline (826.3) must be assigned it *after*. They are exact
 * mirrors, so one rank function states both: everything Tank outranks,
 * everything Backline is outranked by.
 *
 * A Unit with both is a contradiction the rulebook does not address. Ranking it
 * with the Tanks follows 815's "before any other unit ... that does not have
 * Tank" literally, and is noted rather than hidden.
 */
function assignmentRank(state: GameState, unit: EntityId): number {
  if (unitHasKeyword(state, unit, 'tank')) {
    return 0;
  }
  return unitHasKeyword(state, unit, 'backline') ? 2 : 1;
}

/**
 * Assign `total` damage among `targets` (rule 465.2.c).
 *
 * 465.2.c.3: a Unit must be assigned lethal damage in full before any is
 * assigned to a different Unit.
 * 465.2.c.4: a Unit cannot be assigned more than the minimum lethal amount
 * while other Units remain to be assigned to.
 *
 * Tank (815) and Backline (826) constrain that order and *are* honoured: they
 * are rules rather than preferences, so they sort the targets before the walk.
 *
 * SIMPLIFICATION: within a rank the *order* of assignment is still the
 * assigning player's choice, and a real one — it decides which enemy Units die.
 * This walks the targets in a fixed order instead. Every constraint above is
 * obeyed, so the totals and the number of deaths are right, but which Units die
 * is not yet a decision. Making it one needs a sub-action protocol during the
 * Damage Step; that is the seam.
 */
export function assignDamage(
  state: GameState,
  total: number,
  targets: readonly EntityId[],
  role?: CombatRole,
): Map<EntityId, number> {
  const assignment = new Map<EntityId, number>();
  let remaining = total;

  // 815.1.c / 826.4: the keywords alter which assignments are *valid*, not
  // merely which are wise. Array.prototype.sort is stable, so the caller's
  // order survives within a rank.
  const ordered = targets
    .slice()
    .sort((a, b) => assignmentRank(state, a) - assignmentRank(state, b));

  for (let i = 0; i < ordered.length && remaining > 0; i += 1) {
    const unit = ordered[i] as EntityId;
    const needed = lethalRemaining(state, unit, role);

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
