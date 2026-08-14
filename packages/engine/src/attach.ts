/**
 * Attachment (rules 434-435, 716-719, 724-725).
 *
 * Attaching links two cards on the Board so their effects combine. One becomes
 * **Attached**, the other the **Top-Most Card**, and from then on the Top-Most
 * Card reads as though the attached card's Effect Text were printed on it:
 * 718.3 appends its abilities, 718.4 adds its Might Bonus.
 *
 * The direction is worth stating once because the card text reads backwards
 * from it. A Gear is what gets Attached; the *Unit* becomes the Top-Most Card
 * (818.1.b.2). So "Equip a unit" attaches the Gear **to** the Unit, and every
 * ability in the Gear's Effect Text then belongs to that Unit — "me" in the
 * Gear's Effect Text is the Unit, not the Gear.
 *
 * Rule 724 is what keeps the two halves apart: a card's Effect Text is Inactive
 * unless it is Attached, and 434.1.e makes its printed Rules Text Inactive
 * while it is. They are never both live, which is why `GearCard.attached` is a
 * separate field rather than more entries in `abilities`.
 */
import type { AttachedText, CardAbilities, Keyword } from '@riftbound/cards';

import { moveEntity } from './mutate.js';
import {
  entityCard,
  getEntity,
  sameLocation,
  type EntityId,
  type GameState,
  type Location,
} from './state.js';

/** Everything currently Attached to `topMost`, in entity order. */
export function attachmentsOf(state: GameState, topMost: EntityId): readonly EntityId[] {
  const found: EntityId[] = [];
  for (const entity of Object.values(state.entities)) {
    if (entity.attachedTo === topMost) {
      found.push(entity.id);
    }
  }
  return found;
}

/** The Effect Text a card lends its Top-Most Card, or `undefined` if it has none. */
export function attachedTextOf(state: GameState, attached: EntityId): AttachedText | undefined {
  const card = entityCard(state, attached);
  return card.type === 'gear' ? card.attached : undefined;
}

/** 718.4: the Might every Attached card adds to its Top-Most Card. */
export function attachedMight(state: GameState, topMost: EntityId): number {
  let total = 0;
  for (const attached of attachmentsOf(state, topMost)) {
    total += attachedTextOf(state, attached)?.mightBonus ?? 0;
  }
  return total;
}

/** 718.3: keywords the Attached cards lend their Top-Most Card. */
export function attachedKeywords(state: GameState, topMost: EntityId): readonly Keyword[] {
  const found: Keyword[] = [];
  for (const attached of attachmentsOf(state, topMost)) {
    found.push(...(attachedTextOf(state, attached)?.keywords ?? []));
  }
  return found;
}

/**
 * 718.3: the abilities an Attached card appends to its Top-Most Card.
 *
 * Returned per attachment rather than merged, because an ability has to be
 * findable by its *source* — and 377.3.a.1 makes the source the Game Object the
 * ability is printed on, which is still the Gear.
 */
export function attachedAbilities(
  state: GameState,
  topMost: EntityId,
): readonly { readonly source: EntityId; readonly abilities: CardAbilities }[] {
  const found: { source: EntityId; abilities: CardAbilities }[] = [];
  for (const attached of attachmentsOf(state, topMost)) {
    const abilities = attachedTextOf(state, attached)?.abilities;
    if (abilities !== undefined) {
      found.push({ source: attached, abilities });
    }
  }
  return found;
}

/**
 * Attach `card` to `topMost` (434).
 *
 * 434.1.f: attaching to a new Top-Most Card detaches it from its current one,
 * which falls out of storing a single `attachedTo` rather than needing its own
 * step. 719.3 puts the two at the same Location, so the attached card moves to
 * the Top-Most Card's.
 */
export function attach(state: GameState, card: EntityId, topMost: EntityId): GameState {
  // 434.1.g: attaching to the card it is already Attached to does nothing.
  if (getEntity(state, card).attachedTo === topMost) {
    return state;
  }
  // A card cannot be its own Top-Most Card, and a cycle would make
  // `attachmentsOf` describe an impossible board.
  if (card === topMost || wouldCycle(state, card, topMost)) {
    return state;
  }

  const destination = getEntity(state, topMost).location;
  let next = sameLocation(getEntity(state, card).location, destination)
    ? state
    : moveEntity(state, card, destination);
  return {
    ...next,
    entities: { ...next.entities, [card]: { ...getEntity(next, card), attachedTo: topMost } },
  };
}

/** 435: unlink `card` from whatever it is Attached to. */
export function detach(state: GameState, card: EntityId): GameState {
  const entity = getEntity(state, card);
  // 435.1.a.1: detaching something that is not Attached does nothing.
  if (entity.attachedTo === undefined) {
    return state;
  }
  const { attachedTo: _gone, ...rest } = entity;
  return { ...state, entities: { ...state.entities, [card]: rest } };
}

/**
 * 719.3.a: everything Attached follows its Top-Most Card to a new Location.
 *
 * Called after the Top-Most Card itself has moved, so the attachments catch up.
 * 718.5.c is the rule this enforces — an Attached card cannot be moved
 * separately from what it is Attached to.
 */
export function moveAttachments(state: GameState, topMost: EntityId, to: Location): GameState {
  let next = state;
  for (const attached of attachmentsOf(state, topMost)) {
    if (!sameLocation(getEntity(next, attached).location, to)) {
      next = moveEntity(next, attached, to);
    }
  }
  return next;
}

/** Would attaching `card` to `topMost` close a loop? */
function wouldCycle(state: GameState, card: EntityId, topMost: EntityId): boolean {
  let cursor: EntityId | undefined = topMost;
  const seen = new Set<EntityId>();
  while (cursor !== undefined) {
    if (cursor === card) {
      return true;
    }
    if (seen.has(cursor)) {
      return true;
    }
    seen.add(cursor);
    cursor = state.entities[cursor]?.attachedTo;
  }
  return false;
}
