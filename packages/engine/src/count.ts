/**
 * Evaluating counts read off the game state (see `cards/count.ts`).
 *
 * Its own module for the same reason `condition.ts` and `dependency.ts` are:
 * cost modifiers, effects and statics all ask these questions, and they sit at
 * different heights in the dependency graph.
 *
 * `Condition`'s `controls` predicate is answered here too — it is the same
 * sweep asked for a yes/no instead of a number, and one implementation is what
 * stops the two drifting.
 */
import { type Count, type ValuedKeywordKind } from '@riftbound/cards';

import {
  entityCard,
  getEntity,
  matchesFilter,
  type EntityId,
  type GameState,
  type PlayerId,
} from './state.js';

/** 708: a Unit is Mighty exactly while its Might is 5 or greater. */
export const MIGHTY_THRESHOLD = 5;

/**
 * How many things this count refers to, right now.
 *
 * `source` is the Game Object the count is printed on. It may be absent — a
 * card whose own cost is being determined is not on the Board yet — in which
 * case a source-relative count (`here`, `excludeSelf`) has nothing to measure
 * from and yields 0, exactly as the equivalent `Condition` does.
 *
 * `might` is injected rather than imported, because Might is computed by
 * consulting statics and this module sits below them. A caller that cannot
 * safely compute Might (a static's own grant, which `mightOf` is in the middle
 * of evaluating) passes nothing, and a Mighty count then yields 0 — but the
 * parser refuses that combination outright, so it never arises in practice.
 */
export function countOf(
  state: GameState,
  player: PlayerId,
  source: EntityId | undefined,
  count: Count,
  might?: (state: GameState, unit: EntityId) => number,
  /**
   * Injected for the same reason `might` is: a keyword's value is computed by
   * consulting statics, and this module sits below them.
   */
  keywordValue?: (state: GameState, unit: EntityId, keyword: ValuedKeywordKind) => number,
): number {
  switch (count.kind) {
    case 'cardsInTrash':
      return state.players[player]?.zones.trash.length ?? 0;

    case 'cardsPlayedThisTurn':
      return state.players[player]?.playedThisTurn.length ?? 0;

    case 'controlled': {
      const seats =
        count.who === 'you'
          ? [player]
          : state.players.map((seat) => seat.id).filter((seat) => seat !== player);
      let total = 0;
      for (const seat of seats) {
        total += countControlled(state, seat, count, source, might);
      }
      return total;
    }

    // A source-relative count with no source, or one asked where Might cannot
    // safely be computed, reads 0 — the same answer `here` and `excludeSelf`
    // already give, and the belt to the parser's braces.
    case 'sourceMight':
      return source === undefined || might === undefined ? 0 : might(state, source);

    case 'sourceKeyword':
      return source === undefined || keywordValue === undefined
        ? 0
        : keywordValue(state, source, count.keyword);

    case 'points': {
      if (count.who === 'you') {
        return state.players[player]?.points ?? 0;
      }
      // 194.2's "any opponent": the one who is doing best, since that is what
      // every printed wording is measuring against.
      return Math.max(
        0,
        ...state.players.filter((seat) => seat.id !== player).map((seat) => seat.points),
      );
    }

    default: {
      const exhaustive: never = count;
      throw new Error(`Unknown count: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** How many things of the named kind `seat` controls right now. */
function countControlled(
  state: GameState,
  seat: PlayerId,
  count: Extract<Count, { kind: 'controlled' }>,
  source: EntityId | undefined,
  might: ((state: GameState, unit: EntityId) => number) | undefined,
): number {
  if (count.what === 'battlefield') {
    return state.battlefields.filter((battlefield, index) => {
      if (battlefield.controller !== seat) {
        return false;
      }
      // "each **other** battlefield" — a Battlefield's own ability does not
      // count the Battlefield it is printed on. 170.5 puts its Game Object at
      // its own index, so this is the source's own Location.
      if (count.excludeSelf === true && source !== undefined) {
        const from = state.entities[source]?.location;
        if (from?.kind === 'battlefield' && from.index === index) {
          return false;
        }
      }
      return true;
    }).length;
  }

  // 355.9: "here" is the source's own Battlefield. A source that names none —
  // one in a Base, or a card still in hand — counts nothing.
  let here: number | undefined;
  if (count.here === true) {
    const at = source === undefined ? undefined : state.entities[source]?.location;
    if (at?.kind !== 'battlefield') {
      return 0;
    }
    here = at.index;
  }

  let total = 0;
  for (const entity of boardEntities(state, seat)) {
    if (count.excludeSelf === true && entity === source) {
      continue;
    }
    if (here !== undefined) {
      const at = state.entities[entity]?.location;
      if (at?.kind !== 'battlefield' || at.index !== here) {
        continue;
      }
    }
    const card = entityCard(state, entity);
    if (card.type !== count.what) {
      continue;
    }
    // 133.8.a gives an ordinary tag no rules meaning of its own, but a card may
    // still ask about one — "another Dragon", "a Poro".
    if (count.tag !== undefined && !hasTag(card.tags, count.tag)) {
      continue;
    }
    // 702: a Buff is a counter on the Unit, so this reads nothing derived and
    // is safe for a static's grant to ask.
    if (count.buffed === true && getEntity(state, entity).buffs < 1) {
      continue;
    }
    // The same narrowing an effect's target takes. Every field of it is a
    // stored status, so a static's grant may ask about it — unlike `mighty`
    // below, which is computed and would recurse.
    if (!matchesFilter(state, entity, count.filter)) {
      continue;
    }
    // 708: Mighty is Might >= 5, and Might is what statics compute — which is
    // why this needs a `might` function handed in rather than imported.
    if (count.mighty === true) {
      if (might === undefined || might(state, entity) < MIGHTY_THRESHOLD) {
        continue;
      }
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
    // 161.1.a keeps a Channelled Rune on the Board until it is Recycled, so it
    // is part of what a player "has" the same way a Unit is.
    found.push(...seat.zones.base, ...seat.zones.legendZone, ...seat.zones.runes);
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
