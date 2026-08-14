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

import { attachedKeywords, attachedMight } from './attach.js';
import { conditionMet, type ConditionContext } from './condition.js';
import { countOf } from './count.js';
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
    // 170.8: a Battlefield can have Passive Abilities, and 170.5 puts its own
    // Game Object at its Location — so `here` on one of its statics resolves to
    // itself with no special case.
    collect(battlefield.entity);
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
  // 718.4: every Attached card's Might Bonus modulates its Top-Most Card's
  // Might. Counted here rather than in `mightOf` so that every caller which
  // already consults statics picks it up without a second lookup.
  let total = attachedMight(state, unit);
  for (const { source, controller, ability } of activeStatics(state)) {
    const might = ability.grant.might;
    if (might === undefined || might === 0) {
      continue;
    }
    if (reaches(state, source, controller, ability.affects, unit)) {
      total += might * grantMultiplier(state, source, controller, ability);
    }
  }
  return total;
}

/**
 * How many times a static's grant applies — 1 unless it reads a count.
 *
 * "I have +1 Might for each friendly gear" is `might: 1` with a `per`. No
 * `might` function is handed to `countOf` here, and that is the point: this is
 * called from inside `mightOf`, so a count that read Might back would recurse
 * forever. The parser refuses that combination outright (see `Count`), and this
 * is the belt to its braces — such a count would read 0 rather than hang.
 */
function grantMultiplier(
  state: GameState,
  source: EntityId,
  controller: PlayerId,
  ability: StaticAbility,
): number {
  return ability.grant.per === undefined
    ? 1
    : countOf(state, controller, source, ability.grant.per);
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
      const times = grantMultiplier(state, source, controller, ability);
      // "I have ASSAULT equal to the number of enemy units here" — the printed
      // value is per-unit, so the count scales it. 807.2 sums instances anyway,
      // so a scaled value and N copies mean the same thing; one keyword is
      // cheaper to read.
      for (const keyword of keywords) {
        (granted ??= []).push(
          'value' in keyword ? { ...keyword, value: keyword.value * times } : keyword,
        );
      }
    }
  }

  // 718.3: an Attached card's Effect Text keywords read as though printed on
  // the Top-Most Card — "EQUIP Fury / ASSAULT 2" gives the equipped Unit
  // Assault, not the Gear.
  const lent = attachedKeywords(state, unit);
  if (lent.length > 0) {
    (granted ??= []).push(...lent);
  }

  // "Give a unit ASSAULT 3 this turn" (801.3.a). Unlike a static this is *on*
  // the Unit, because the card that granted it is in the trash by now; 317.2.c
  // is what takes it away again.
  const untilEndOfTurn = getEntity(state, unit).grantedKeywords;
  if (untilEndOfTurn.length > 0) {
    (granted ??= []).push(...untilEndOfTurn);
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
  context: ConditionContext = {},
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
    // 805.1.a: Accelerate desugars to exactly this — an Optional Additional
    // Cost plus "if you do, I enter ready". The declaration was made at step 2
    // and cannot be read off the board, so it rides in on the context.
    if (
      conditionMet(state, player, undefined, ability.condition, context) &&
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
