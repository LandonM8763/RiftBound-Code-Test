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
  isTokenCard,
  keywordValue,
  staticAbilities,
  isSourceCondition,
  type CardAbilities,
  type CardDefinition,
  type Restriction,
  type CardId,
  type Keyword,
  type StaticAbility,
  type StaticScope,
  type ValuedKeywordKind,
} from '@riftbound/cards';

import { activeAbilities, attachedKeywords, attachedMight } from './attach.js';
import { conditionMet, type ConditionContext } from './condition.js';
import { countOf } from './count.js';
import { dependencyMet } from './dependency.js';
import { entityCard, getEntity, type EntityId, type GameState, type PlayerId } from './state.js';

/** Case-insensitive tag match (133.8), the same comparison `count.ts` makes. */
function hasTag(tags: readonly string[], tag: string): boolean {
  const wanted = tag.toLowerCase();
  return tags.some((candidate) => candidate.toLowerCase() === wanted);
}

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
    const controller = getEntity(state, source).controller;
    // 718.2/718.3: an Attached card's own Passives are Inactive and its
    // Top-Most Card carries the Effect Text's instead. The *source* stays this
    // entity either way, which is what makes "units here have +1 Might" on an
    // Equipment measure from the Unit it is attached to.
    for (const set of activeAbilities(state, source)) {
      for (const ability of staticAbilities(set.abilities)) {
        if (!conditionMet(state, controller, source, ability.condition)) {
          continue;
        }
        if (!dependencyMet(state, source, controller, ability.dependsOn)) {
          continue;
        }
        found.push({ source, controller, ability });
      }
    }
  };

  for (const seat of state.players) {
    for (const entity of [...seat.zones.base, ...seat.zones.legendZone]) {
      collect(entity);
    }
  }
  // 390.4: a Delayed Passive is an ordinary Passive with a window, so it joins
  // the sweep rather than being consulted separately. Its condition and
  // dependency are asked here for the same reason a Board static's are — both
  // can stop holding after the effect that created it resolved.
  for (const delayed of state.turnEffects) {
    if (delayed.ability === undefined || delayed.uses === 0) {
      continue;
    }
    if (!conditionMet(state, delayed.controller, delayed.source, delayed.ability.condition)) {
      continue;
    }
    found.push({
      source: delayed.source,
      controller: delayed.controller,
      ability: delayed.ability,
    });
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
  // 133.8: "your Mechs", "friendly Poros". A tag has no rules meaning of its
  // own, but a card may name one, and this is where that is answered.
  if (scope.tag !== undefined && !hasTag(entityCard(state, unit).tags, scope.tag)) {
    return false;
  }
  // 185: being a Token is a property of the Game Object, not a printed tag.
  if (scope.token === true && !isTokenCard(entityCard(state, unit))) {
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

  // 143.2.b.1: a printed floor is measured against the *actual* Might, so the
  // reduction has to know what it is reducing. That is why the grants are
  // applied in two passes — every unfloored one first, then the floored ones
  // against the running total. Within a pass the order does not matter, since
  // only a floored grant is order-sensitive.
  //
  // The base deliberately excludes the Assault/Shield designation (807, 814):
  // reading it goes through `keywordsOf`, which consults statics, which is
  // what this function is in the middle of computing. A Unit whose Might is
  // raised by a designation is therefore floored slightly early — the safe
  // direction, since it reduces *less* than printed rather than more.
  const card = entityCard(state, unit);
  const entity = getEntity(state, unit);
  const base = card.type === 'unit' ? card.might + entity.mightBonus + entity.buffs : 0;

  const floored: { change: number; minimum: number }[] = [];
  for (const { source, controller, ability } of activeStatics(state)) {
    const might = ability.grant.might;
    if (might === undefined || might === 0) {
      continue;
    }
    if (!reaches(state, source, controller, ability.affects, unit)) {
      continue;
    }
    const change = might * grantMultiplier(state, source, controller, ability);
    const minimum = ability.grant.minimumMight;
    if (minimum === undefined || change >= 0) {
      total += change;
      continue;
    }
    floored.push({ change, minimum });
  }

  for (const { change, minimum } of floored) {
    // The floor binds this grant alone, the way 356.4.e binds a discount's
    // minimum to its own discount rather than to the running total.
    const room = base + total - minimum;
    total += Math.min(0, Math.max(change, -Math.max(0, room)));
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
 * Abilities and cost modifiers granted *to* `entity` by statics on the Board
 * (801.3.a).
 *
 * "Other friendly units have VISION" and "Friendly units have DEFLECT" both
 * grant something that desugars — a Play Effect and a cost increase — rather
 * than a `Keyword` the engine has a rule for. 801.3.a makes the grant
 * indistinguishable from printing it, so the sweeps that ask what a Game Object
 * can do have to include this.
 *
 * **`activeStatics` deliberately does not.** It reads printed and Attached
 * abilities only, so a static in a grant would be gathered by the sweep that
 * produced it — an unbounded recursion for a shape no card prints. The parser
 * refuses it too.
 *
 * `from` names the *granting* Permanent, which is what lets `abilityFor` find
 * the ability's text again when a Chain item refers to it.
 */
/**
 * Could *any* card in this game grant an ability (801.3.a)?
 *
 * A cheap pre-pass over the definitions rather than over the Board, and sound
 * because a static in play has to be printed on some definition the game
 * carries. It exists because the honest answer — `activeStatics` — evaluates
 * every static's condition and dependency, and asking it on every trigger
 * sweep when nothing in the deck grants anything is most of a Monte Carlo
 * agent's time. Almost every game answers `false` here in one pass.
 */
export function anyAbilityGrant(state: GameState): boolean {
  // Written without `Object.values` or a spread on purpose: this runs on every
  // trigger and cost-modifier sweep, so it allocates nothing and stops early.
  for (const key in state.definitions) {
    const definition = state.definitions[key as CardId];
    if (definition === undefined) {
      continue;
    }
    if (grantsAbility(definition.abilities?.statics)) {
      return true;
    }
    if (definition.type === 'gear' && grantsAbility(definition.attached?.abilities?.statics)) {
      return true;
    }
  }
  return false;
}

function grantsAbility(statics: readonly StaticAbility[] | undefined): boolean {
  if (statics === undefined) {
    return false;
  }
  for (const ability of statics) {
    if (ability.grant.abilities !== undefined) {
      return true;
    }
  }
  return false;
}

/** The statics that grant abilities, or nothing at all when none can. */
export function grantingStatics(state: GameState): readonly ActiveStatic[] {
  return anyAbilityGrant(state)
    ? activeStatics(state).filter((entry) => entry.ability.grant.abilities !== undefined)
    : [];
}

export function grantedAbilities(
  state: GameState,
  entity: EntityId,
  /**
   * A precomputed `activeStatics`, for a caller sweeping many entities.
   *
   * The sweep is over the whole Board, so recomputing it per entity makes an
   * O(n) walk O(n²) — and the trigger sweep runs on every event. Callers that
   * ask about one entity can leave it out.
   */
  statics: readonly ActiveStatic[] = grantingStatics(state),
): readonly { readonly abilities: CardAbilities; readonly from: EntityId }[] {
  const found: { abilities: CardAbilities; from: EntityId }[] = [];
  for (const { source, controller, ability } of statics) {
    if (ability.grant.abilities === undefined) {
      continue;
    }
    if (!reaches(state, source, controller, ability.affects, entity)) {
      continue;
    }
    found.push({ abilities: ability.grant.abilities, from: source });
  }
  return found;
}

/**
 * Is `unit` forbidden from `kind` by a static on the Board (rule 002)?
 *
 * The object-facing reading: `affects` is judged against the Unit itself, the
 * same sweep `mightOf` and `keywordsOf` make.
 */
export function objectForbidden(
  state: GameState,
  unit: EntityId,
  kind: Restriction['kind'],
): boolean {
  for (const { source, controller, ability } of activeStatics(state)) {
    if (!(ability.grant.forbid ?? []).some((one) => one.kind === kind)) {
      continue;
    }
    if (reaches(state, source, controller, ability.affects, unit)) {
      return true;
    }
  }
  return false;
}

/**
 * Is `player` forbidden from `kind` (rule 002)?
 *
 * The player-facing reading: only `affects.who` is consulted, and it is read
 * relative to the *static's* controller — "opponents can't score" on my Unit
 * forbids you, not me. `here` and `excludeSelf` name objects and so have
 * nothing to say about a player; a static that sets them alongside a
 * player-facing restriction is refused at ingest rather than half-honoured.
 */
export function playerForbidden(
  state: GameState,
  player: PlayerId,
  kind: Restriction['kind'],
): boolean {
  for (const { controller, ability } of activeStatics(state)) {
    if (!(ability.grant.forbid ?? []).some((one) => one.kind === kind)) {
      continue;
    }
    const who = ability.affects.who;
    const friendly = controller === player;
    if (who === 'any' || (who === 'friendly' && friendly) || (who === 'enemy' && !friendly)) {
      return true;
    }
  }
  return false;
}

/**
 * Is `battlefield` forbidden to `player` for `kind` (rule 002)?
 *
 * The place-facing reading: the place is the static's own source Location,
 * because every card that prints one of these says "here" on a Battlefield's
 * own ability (170.5 puts its Game Object at its own index). `affects.who` then
 * says which players it binds.
 */
export function placeForbidden(
  state: GameState,
  battlefield: number,
  player: PlayerId,
  kind: Restriction['kind'],
): boolean {
  for (const { source, controller, ability } of activeStatics(state)) {
    if (!(ability.grant.forbid ?? []).some((one) => one.kind === kind)) {
      continue;
    }
    const at = getEntity(state, source).location;
    if (at.kind !== 'battlefield' || at.index !== battlefield) {
      continue;
    }
    const who = ability.affects.who;
    const friendly = controller === player;
    if (who === 'any' || (who === 'friendly' && friendly) || (who === 'enemy' && !friendly)) {
      return true;
    }
  }
  return false;
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
    // "Your tokens enter ready" reaches only Tokens (185). Unlike `here`, this
    // *is* knowable before the card is on the Board: 185 makes it a property of
    // the definition, which is exactly what this function is handed.
    if (ability.affects.token === true && !isTokenCard(card)) {
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

/**
 * Extra Locations this card may be played to (rule 355.2.b).
 *
 * 355.2.a's default is the controller's Base or a Battlefield they Control;
 * this is the permission that widens it, and 170.11 names the two states cards
 * ask for. Gathered from the same two places `entersReady` is: the card's own
 * `self` static, read from hand because "you may play **me**" has to be
 * answerable before the card is anywhere, and the Board for the wider wording
 * ("Friendly units may be played to open battlefields").
 *
 * A permission, so several union rather than intersect and none can take a
 * Location away.
 */
export function extraPlayLocations(
  state: GameState,
  player: PlayerId,
  card: CardDefinition,
): ReadonlySet<'open' | 'occupiedEnemy'> {
  const allowed = new Set<'open' | 'occupiedEnemy'>();

  for (const ability of staticAbilities(card.abilities)) {
    if (ability.grant.playTo === undefined || ability.affects.who !== 'self') {
      continue;
    }
    // Same split as `entersReady`: a source-relative condition cannot hold for
    // a card still in hand, but a state predicate is answerable.
    if (ability.condition !== undefined && isSourceCondition(ability.condition)) {
      continue;
    }
    if (
      conditionMet(state, player, undefined, ability.condition) &&
      dependencyMet(state, undefined, player, ability.dependsOn)
    ) {
      for (const where of ability.grant.playTo) {
        allowed.add(where);
      }
    }
  }

  for (const { controller, ability } of activeStatics(state)) {
    if (ability.grant.playTo === undefined || ability.affects.who === 'self') {
      continue;
    }
    // `here` cannot be answered before the Unit has a Location, exactly as in
    // `entersReady`, so it is not honoured rather than guessed at.
    if (ability.affects.here === true) {
      continue;
    }
    const friendly = controller === player;
    const who = ability.affects.who;
    if ((who === 'friendly' && friendly) || (who === 'enemy' && !friendly) || who === 'any') {
      for (const where of ability.grant.playTo) {
        allowed.add(where);
      }
    }
  }

  return allowed;
}
