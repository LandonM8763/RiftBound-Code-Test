/**
 * Evaluating state predicates (see `cards/condition.ts` for the shape).
 *
 * Its own module for the same reason `dependency.ts` is: statics, cost
 * modifiers and effects all ask these questions, and `costs.ts` sits below
 * `statics.ts`, so the evaluator cannot live in either without a cycle.
 *
 * Every predicate here is answered from state the engine already keeps. That is
 * a constraint rather than a coincidence — a predicate the state cannot answer
 * is refused at ingest, because one that silently reads false makes a card
 * quietly weaker than printed.
 */
import { isSourceCondition, type Condition } from '@riftbound/cards';

import { countOf } from './count.js';
import { getPlayer, type EntityId, type GameState, type PlayerId } from './state.js';

/**
 * Is `condition` satisfied for `player`?
 *
 * `source` is the Game Object the condition is printed on, and may be absent —
 * a card whose own cost or "enters ready" is being determined is not on the
 * Board yet. A *source-relative* condition ("while I'm buffed") is therefore
 * false without one, which is correct rather than a limitation: a card in hand
 * is not buffed and is not at a Battlefield.
 */
export interface ConditionContext {
  /**
   * Whether the optional Additional Cost was paid (356.2.b).
   *
   * A choice the player made at step 2 rather than anything readable off the
   * board, which is why it arrives alongside the state rather than in it.
   */
  readonly paidAdditionalCost?: boolean | undefined;
}

export function conditionMet(
  state: GameState,
  player: PlayerId,
  source: EntityId | undefined,
  condition: Condition | undefined,
  context: ConditionContext = {},
): boolean {
  if (condition === undefined) {
    return true;
  }

  if (condition.kind === 'paidAdditionalCost') {
    return context.paidAdditionalCost === true;
  }

  if (isSourceCondition(condition)) {
    const entity = source === undefined ? undefined : state.entities[source];
    if (entity === undefined) {
      return false;
    }
    return condition.kind === 'buffed'
      ? entity.buffs > 0
      : entity.location.kind === 'battlefield';
  }

  switch (condition.kind) {
    case 'controls':
      // The same sweep a `Count` does, asked for a yes/no. One implementation,
      // in `count.ts`, so the two can never disagree about what "another unit
      // here" means.
      return (
        countOf(state, player, source, {
          kind: 'controlled',
          who: condition.who,
          what: condition.what,
          ...(condition.tag === undefined ? {} : { tag: condition.tag }),
          ...(condition.here === undefined ? {} : { here: condition.here }),
          ...(condition.excludeSelf === undefined ? {} : { excludeSelf: condition.excludeSelf }),
        }) >= condition.min
      );

    case 'scoreWithin': {
      // 194.3: measured against the Victory Score, so a Mode of Play that sets
      // a different one (483.3) still reads correctly.
      const target = state.config.victoryScore;
      const seats =
        condition.who === 'you'
          ? [player]
          : state.players.map((seat) => seat.id).filter((seat) => seat !== player);
      return seats.some((seat) => target - getPlayer(state, seat).points <= condition.points);
    }

    case 'didThisTurn': {
      const seats =
        condition.who === 'you'
          ? [player]
          : state.players.map((seat) => seat.id).filter((seat) => seat !== player);
      let total = 0;
      for (const seat of seats) {
        total += getPlayer(state, seat).turnEvents[condition.event] ?? 0;
      }
      return total >= condition.min;
    }

    default:
      // `isSourceCondition`has already handled 'buffed' and 'atBattlefield' above; the
      // compiler cannot see that through a helper, so this stays a runtime
      // guard rather than an exhaustiveness assertion.
      throw new Error(`Unknown condition: ${JSON.stringify(condition)}`);
  }
}
