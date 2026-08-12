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
import { isSourceCondition, type Condition, type ControlledKind } from '@riftbound/cards';

import {
  entityCard,
  getPlayer,
  type EntityId,
  type GameState,
  type PlayerId,
} from './state.js';

/**
 * Is `condition` satisfied for `player`?
 *
 * `source` is the Game Object the condition is printed on, and may be absent —
 * a card whose own cost or "enters ready" is being determined is not on the
 * Board yet. A *source-relative* condition ("while I'm buffed") is therefore
 * false without one, which is correct rather than a limitation: a card in hand
 * is not buffed and is not at a Battlefield.
 */
export function conditionMet(
  state: GameState,
  player: PlayerId,
  source: EntityId | undefined,
  condition: Condition | undefined,
): boolean {
  if (condition === undefined) {
    return true;
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
    case 'controls': {
      const seats =
        condition.who === 'you'
          ? [player]
          : state.players.map((seat) => seat.id).filter((seat) => seat !== player);
      let total = 0;
      for (const seat of seats) {
        total += countControlled(state, seat, condition, source);
      }
      return total >= condition.min;
    }

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

/** How many things of the named kind `seat` controls right now. */
function countControlled(
  state: GameState,
  seat: PlayerId,
  condition: Extract<Condition, { kind: 'controls' }>,
  source: EntityId | undefined,
): number {
  if (condition.what === 'battlefield') {
    // A Battlefield is not an entity here, so it is counted off the board state
    // rather than swept for. Tags on a Battlefield are unreachable for the same
    // reason, and a tagged Battlefield predicate is refused at ingest.
    return state.battlefields.filter((battlefield) => battlefield.controller === seat).length;
  }

  let total = 0;
  for (const entity of boardEntities(state, seat)) {
    if (condition.excludeSelf === true && entity === source) {
      continue;
    }
    const card = entityCard(state, entity);
    if (card.type !== (condition.what as ControlledKind)) {
      continue;
    }
    // 133.8.a gives an ordinary tag no rules meaning of its own, but a card may
    // still ask about one — "another Dragon", "a Poro".
    if (condition.tag !== undefined && !hasTag(card.tags, condition.tag)) {
      continue;
    }
    total += 1;
  }
  return total;
}

function hasTag(tags: readonly string[], tag: string): boolean {
  const wanted = tag.toLowerCase();
  return tags.some((candidate) => candidate.toLowerCase() === wanted);
}

/** Everything `player` controls that is on the Board (rule 380). */
function boardEntities(state: GameState, player: PlayerId): EntityId[] {
  const found: EntityId[] = [];
  const seat = state.players[player];
  if (seat !== undefined) {
    found.push(...seat.zones.base, ...seat.zones.legendZone);
  }
  for (const battlefield of state.battlefields) {
    for (const unit of battlefield.units) {
      if (state.entities[unit]?.controller === player) {
        found.push(unit);
      }
    }
  }
  return found;
}
