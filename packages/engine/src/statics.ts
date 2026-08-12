/**
 * Static and Passive abilities in play (rules 363-365).
 *
 * A static is never executed. It is *consulted*, every time the thing it
 * modifies is read — which is why this module exposes questions ("what is this
 * Unit's static Might bonus", "which keywords does it have") rather than a
 * reducer. Rule 365.1 makes a Permanent's Passive Abilities active while it is
 * on the Board, and 365 stops them the moment it leaves, so nothing has to be
 * cleaned up when a granter dies: the answer simply changes.
 *
 * The one exception is `entersReady`, which is read off a card still in hand,
 * for the same reason a `self` cost modifier is: it is about the card being
 * played, and by the time that card is on the Board the question is settled.
 */
import {
  hasKeyword,
  keywordValue,
  staticAbilities,
  isSourceCondition,
  type CardDefinition,
  type Keyword,
  type StaticAbility,
  type StaticScope,
  type ValuedKeywordKind,
} from '@riftbound/cards';

import { conditionMet } from './condition.js';
import { dependencyMet } from './dependency.js';
import { entityCard, getEntity, type EntityId, type GameState, type PlayerId } from './state.js';

/** A static in play, with the entity supplying it. */
export interface ActiveStatic {
  readonly source: EntityId;
  readonly controller: PlayerId;
  readonly ability: StaticAbility;
}

/**
 * Every static currently active on the Board.
 *
 * `entersReady` statics with a `self` scope are skipped: those belong to a card
 * in hand and would otherwise say nothing useful about a Permanent that has
 * already entered.
 */
export function activeStatics(state: GameState): readonly ActiveStatic[] {
  const found: ActiveStatic[] = [];

  const collect = (source: EntityId): void => {
    const abilities = staticAbilities(entityCard(state, source).abilities);
    if (abilities.length === 0) {
      return;
    }
    const controller = getEntity(state, source).controller;
    for (const ability of abilities) {
      if (!conditionMet(state, controller, source, ability.condition)) {
        continue;
      }
      if (!dependencyMet(state, source, controller, ability.dependsOn)) {
        continue;
      }
      found.push({ source, controller, ability });
    }
  };

  for (const seat of state.players) {
    for (const entity of [...seat.zones.base, ...seat.zones.legendZone]) {
      collect(entity);
    }
  }
  for (const battlefield of state.battlefields) {
    for (const unit of battlefield.units) {
      collect(unit);
    }
  }

  return found;
}

/** Does `ability` on `source` reach `unit`? */
function reaches(
  state: GameState,
  source: EntityId,
  controller: PlayerId,
  scope: StaticScope,
  unit: EntityId,
): boolean {
  if (scope.who === 'self') {
    return unit === source;
  }
  if (scope.excludeSelf === true && unit === source) {
    return false;
  }

  const target = state.entities[unit];
  if (target === undefined) {
    return false;
  }
  if (scope.who === 'friendly' && target.controller !== controller) {
    return false;
  }
  if (scope.who === 'enemy' && target.controller === controller) {
    return false;
  }

  if (scope.here === true) {
    // 355.9: "here" is the source's own Battlefield. A source in a Base names
    // no Battlefield, so it reaches nothing.
    const from = state.entities[source]?.location;
    if (from?.kind !== 'battlefield') {
      return false;
    }
    if (target.location.kind !== 'battlefield' || target.location.index !== from.index) {
      return false;
    }
  }
  return true;
}

/**
 * The Might a Unit has from statics right now (143.2).
 *
 * Not a Buff and not `mightBonus`: this is not *on* the Unit, so it neither
 * persists across turns nor expires in the Ending Phase. It is true exactly
 * while some source on the Board is saying so.
 */
export function staticMight(state: GameState, unit: EntityId): number {
  let total = 0;
  for (const { source, controller, ability } of activeStatics(state)) {
    const might = ability.grant.might;
    if (might === undefined || might === 0) {
      continue;
    }
    if (reaches(state, source, controller, ability.affects, unit)) {
      total += might;
    }
  }
  return total;
}

/**
 * Every keyword a Game Object has: printed plus granted (801.3.a).
 *
 * The engine must ask this rather than reading `card.keywords`, because a
 * granted Tank is as much a Tank as a printed one — 801.3.a.1 says the
 * keyword's own rules decide what a grant does, and for all five modelled
 * keywords that is "the same as having it".
 */
export function keywordsOf(state: GameState, unit: EntityId): readonly Keyword[] {
  const printed = entityCard(state, unit).keywords ?? [];
  let granted: Keyword[] | undefined;

  for (const { source, controller, ability } of activeStatics(state)) {
    const keywords = ability.grant.keywords;
    if (keywords === undefined || keywords.length === 0) {
      continue;
    }
    if (reaches(state, source, controller, ability.affects, unit)) {
      (granted ??= []).push(...keywords);
    }
  }

  return granted === undefined ? printed : [...printed, ...granted];
}

/** `hasKeyword` over the printed *and* granted set. */
export function unitHasKeyword(
  state: GameState,
  unit: EntityId,
  kind: Parameters<typeof hasKeyword>[1],
): boolean {
  return hasKeyword(keywordsOf(state, unit), kind);
}

/** `keywordValue` over the printed *and* granted set; grants sum (807.2). */
export function unitKeywordValue(
  state: GameState,
  unit: EntityId,
  kind: ValuedKeywordKind,
): number {
  return keywordValue(keywordsOf(state, unit), kind);
}

/**
 * Does this card enter the Board ready, rather than exhausted (359.2.c)?
 *
 * Two sources, and the card's own is the common one. "I enter ready" is printed
 * on the card being played and so has to be read from hand, exactly like a
 * `self` cost modifier; "Other friendly units enter ready" comes off the Board
 * the ordinary way.
 */
export function entersReady(
  state: GameState,
  player: PlayerId,
  card: CardDefinition,
): boolean {
  for (const ability of staticAbilities(card.abilities)) {
    if (ability.grant.entersReady !== true || ability.affects.who !== 'self') {
      continue;
    }
    // A *source-relative* condition cannot hold: the card is not a Game Object
    // on the Board yet, so it is neither buffed nor at a Battlefield. A state
    // predicate is a different matter — "I enter ready if you control another
    // Dragon" is answerable right now, and is the common wording.
    if (ability.condition !== undefined && isSourceCondition(ability.condition)) {
      continue;
    }
    if (
      conditionMet(state, player, undefined, ability.condition) &&
      dependencyMet(state, undefined, player, ability.dependsOn)
    ) {
      return true;
    }
  }

  for (const { source, controller, ability } of activeStatics(state)) {
    if (ability.grant.entersReady !== true || ability.affects.who === 'self') {
      continue;
    }
    // The entering Unit has no id yet, so scope is judged on what can be known
    // now: whose it is. `here` cannot be answered before it has a Location and
    // is deliberately not honoured rather than guessed.
    if (ability.affects.here === true) {
      continue;
    }
    const who = ability.affects.who;
    const friendly = controller === player;
    if ((who === 'friendly' && friendly) || (who === 'enemy' && !friendly) || who === 'any') {
      if (source !== undefined) {
        return true;
      }
    }
  }
  return false;
}
