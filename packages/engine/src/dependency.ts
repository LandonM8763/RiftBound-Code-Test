/**
 * Dependent Keywords (rules 801.1, 812, 824).
 *
 * Its own module rather than part of `abilities.ts` because both abilities
 * *and* cost modifiers can be gated, and `costs.ts` sits below `abilities.ts` —
 * `abilities.ts` asks it for an ability's Total Cost, so the dependency check
 * cannot live there without a cycle.
 */
import type { AbilityDependency } from '@riftbound/cards';

import { getPlayer, type EntityId, type GameState, type PlayerId } from './state.js';

/**
 * Is a Dependent Keyword's condition currently met?
 *
 * An unmet dependency makes the gated thing *absent*, not merely unusable:
 * 812.1.c says the Dependent Ability is Active only while the condition holds,
 * so a Legion trigger whose condition fails never goes on the Chain at all, and
 * a Legion discount is not part of the Total Cost.
 *
 * `source` is the Game Object carrying the dependency, and is `undefined` when
 * that object is not on the Board yet — a card whose own cost is being
 * determined during the Process of Play. That case is not a special rule: the
 * card is Finalized at step 6 (329.2) and its cost settled at step 3, so it is
 * genuinely not among the cards played this turn when this is asked.
 */
export function dependencyMet(
  state: GameState,
  source: EntityId | undefined,
  controller: PlayerId,
  dependency: AbilityDependency | undefined,
): boolean {
  if (dependency === undefined) {
    return true;
  }
  const seat = getPlayer(state, controller);
  if (dependency.kind === 'legion') {
    // 812.1.c: "a card different than the one with the Legion ability has been
    // Finalized by you on the same turn". The card carrying Legion is itself in
    // this list when its own Play Effect is being checked, which is exactly why
    // this compares identities rather than counting.
    return seat.playedThisTurn.some((played) => played !== source);
  }
  // 824.1.c: Level N is satisfied while the controller has at least N XP.
  return seat.xp >= dependency.xp;
}
