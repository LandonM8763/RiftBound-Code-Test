/**
 * Hidden (rule 811) and the Hide action (rule 421).
 *
 * A card with Hidden may be put facedown at a Battlefield its controller
 * controls, and played from there on a later turn for no Base Cost. It is the
 * only keyword that adds an **action** rather than expanding into an existing
 * one — 811.1.c.1 is explicit that Hide is not a subset of Play — which is why
 * it needed a module of its own rather than a desugar at ingest.
 *
 * ## Where a facedown card lives
 *
 * Rule 107.3 gives each Battlefield a **Facedown Zone**, and 107.3.e says that
 * zone **is not a Location**. That sentence is the whole design: a facedown
 * card is not *present at* the Battlefield, it is associated with one. So the
 * card sits in its controller's `facedown` player zone and `Entity.hiddenAt`
 * records which Battlefield — the same shape as `attachedTo`, and for the same
 * reason. Nothing that reads a Battlefield's occupants can see it, which is
 * what keeps a facedown card out of Combat, out of `units`, and out of every
 * sweep that asks who is at a Location.
 *
 * ## What is deliberately not modelled
 *
 * - **811.1.d.2's escape hatch.** A play effect's targets must be chosen from
 *   the Battlefield the card was hidden at, "unless the ability explicitly
 *   restricts targeting in a way that makes this impossible". The restriction
 *   is enforced; the escape is not, because deciding that a restriction "can
 *   never be fulfilled" needs to reason about a target spec's satisfiability
 *   rather than evaluate it. A card that needs the escape is played more
 *   narrowly than printed, which is the safe direction — it can never make an
 *   illegal play legal.
 * - **107.3.b.1's changing occupancy.** No card in the corpus alters a Facedown
 *   Zone's maximum, so it is fixed at 107.3.b's one.
 * - **Hiding from the Champion Zone.** 811.1.b permits it, and the Chosen
 *   Champion is the only card that starts there. It is offered, because the
 *   zone is modelled and the rule is explicit.
 */
import { hasKeyword, isPlayable, type CardDefinition, type Cost } from '@riftbound/cards';

import { keywordsOf } from './statics.js';
import {
  entityCard,
  getEntity,
  getPlayer,
  playerLocation,
  type EntityId,
  type GameState,
  type PlayerId,
} from './state.js';

/** 811.1.b: the cost to Hide a card is one `[A]` — Power of any Domain. */
export const HIDE_COST: Cost = { energy: 0, power: [], anyPower: 1 };

/**
 * Does this card have Hidden?
 *
 * Read through `keywordsOf` rather than off `card.keywords`, because 801.3.a
 * makes a granted keyword do exactly what a printed one does — the same rule
 * that makes a granted Tank a Tank. 811.5 also makes "has Hidden" a
 * characteristic other effects can check, and this is that check.
 */
export function hasHidden(state: GameState, id: EntityId): boolean {
  return hasKeyword(keywordsOf(state, id), 'hidden');
}

/** The card in a Battlefield's Facedown Zone, if any (107.3.a-107.3.b). */
export function facedownAt(state: GameState, battlefield: number): EntityId | undefined {
  for (const seat of state.players) {
    for (const id of seat.zones.facedown) {
      if (getEntity(state, id).hiddenAt === battlefield) {
        return id;
      }
    }
  }
  return undefined;
}

/**
 * Battlefields where `player` may Hide a card right now (811.1.b, 107.3.c).
 *
 * Two conditions, both from the rules rather than convenience: the player must
 * Control the Battlefield (107.3.c, and 811.1.b says so again), and its
 * Facedown Zone must be empty (107.3.b's occupancy of one).
 */
export function hideDestinations(state: GameState, player: PlayerId): number[] {
  const found: number[] = [];
  state.battlefields.forEach((battlefield, index) => {
    if (battlefield.controller === player && facedownAt(state, index) === undefined) {
      found.push(index);
    }
  });
  return found;
}

/**
 * Cards `player` may Hide right now (811.1.b).
 *
 * 811.1.b's own gates — "in your hand or in your Champion Zone", "on your turn
 * during an Open State" — are checked by the caller, which already knows the
 * turn state; this answers the part about the cards.
 */
export function hideableCards(state: GameState, player: PlayerId): EntityId[] {
  const seat = getPlayer(state, player);
  return [...seat.zones.hand, ...seat.zones.championZone].filter((id) => hasHidden(state, id));
}

/**
 * Cards `player` may play from facedown right now (811.1.b, 811.6).
 *
 * 811.1.b's "beginning on the next turn" is why the turn it went down is
 * recorded: a card hidden this turn cannot be played this turn, however many
 * priority windows pass. 811.6 gives it Reaction while facedown, so timing is
 * never the reason one of these is unavailable.
 */
export function playableFromFacedown(state: GameState, player: PlayerId): EntityId[] {
  return getPlayer(state, player)
    .zones.facedown.filter((id) => {
      const entity = getEntity(state, id);
      if (entity.hiddenOnTurn === undefined || state.turn <= entity.hiddenOnTurn) {
        return false;
      }
      return isPlayable(entityCard(state, id));
    })
    .slice();
}

/**
 * Put `card` facedown at `battlefield` (421.1).
 *
 * The caller pays the cost and checks the gates; this performs the move and
 * records the two things the zone needs — which Battlefield's Facedown Zone
 * this is, and the turn, for 811.1.b's "beginning on the next turn".
 */
export function hide(
  state: GameState,
  card: EntityId,
  battlefield: number,
): GameState {
  const controller = getEntity(state, card).controller;
  const next: GameState = {
    ...state,
    players: state.players.map((player) =>
      player.id === controller
        ? {
            ...player,
            zones: {
              ...player.zones,
              hand: player.zones.hand.filter((id) => id !== card),
              championZone: player.zones.championZone.filter((id) => id !== card),
              facedown: [...player.zones.facedown, card],
            },
          }
        : player,
    ),
  };
  return {
    ...next,
    entities: {
      ...next.entities,
      [card]: {
        ...getEntity(next, card),
        location: playerLocation(controller, 'facedown'),
        hiddenAt: battlefield,
        hiddenOnTurn: state.turn,
      },
    },
  };
}

/**
 * Clear the facedown bookkeeping as a card leaves the Facedown Zone.
 *
 * 421.4 reveals it to all players on the way out, which this model gets for
 * free: the card's identity is only concealed while it is *in* the zone, so
 * removing the association is the reveal.
 */
export function unhide(state: GameState, card: EntityId): GameState {
  const entity = getEntity(state, card);
  if (entity.hiddenAt === undefined && entity.hiddenOnTurn === undefined) {
    return state;
  }
  const { hiddenAt: _where, hiddenOnTurn: _when, ...rest } = entity;
  return { ...state, entities: { ...state.entities, [card]: rest } };
}

/**
 * 107.3.d: a facedown card whose controller no longer Controls its Battlefield
 * is removed at the next Cleanup.
 *
 * "Removed" is read as the trash, following 107.3.b.2 — the other rule that
 * removes a card from a Facedown Zone says trash explicitly, and there is no
 * reason for these two to differ. The card is revealed on the way (421.4).
 */
export function expireFacedown(
  state: GameState,
  send: (state: GameState, card: EntityId) => GameState,
): GameState {
  let next = state;
  for (const seat of state.players) {
    for (const id of seat.zones.facedown) {
      const entity = getEntity(next, id);
      if (entity.hiddenAt === undefined) {
        continue;
      }
      if (next.battlefields[entity.hiddenAt]?.controller === entity.controller) {
        continue;
      }
      next = send(unhide(next, id), id);
    }
  }
  return next;
}

/**
 * 811.1.d.2: is `target` a legal choice for a card played from facedown?
 *
 * The choices a hidden card makes are restricted to the Battlefield it was
 * hidden at. Applied to Game Objects on the Board only — a card in a trash is
 * at no Battlefield, and 811.1.d.2 is about "options at that battlefield", so a
 * `trashCard` choice is left alone rather than being made impossible.
 */
export function allowedFromFacedown(
  state: GameState,
  battlefield: number,
  target: EntityId,
): boolean {
  const location = getEntity(state, target).location;
  return location.kind !== 'battlefield' || location.index === battlefield;
}

/**
 * 811.1.d.1: a Permanent played from facedown must enter at that Battlefield.
 *
 * 811.1.d.1.a is explicit that this overrides the normal restriction keeping
 * Gear at a Base, so this is asked of every Permanent rather than only Units.
 */
export function facedownEntersAt(card: CardDefinition, battlefield: number): number | undefined {
  return card.type === 'unit' || card.type === 'gear' ? battlefield : undefined;
}
