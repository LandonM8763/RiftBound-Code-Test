import type { CardId } from '@riftbound/cards';

import type {
  BattlefieldState,
  EntityId,
  GameState,
  Outcome,
  Phase,
  PlayerId,
  RunePool,
} from './state.js';
import { definitionOf, getEntity, getPlayer, isClosed } from './state.js';

/**
 * Hidden information is modelled explicitly.
 *
 * Agents are handed a view, never the state. An agent physically cannot read a
 * card it should not see, so it cannot cheat by accident — and a determinizing
 * search agent has a well-defined thing to sample completions of.
 */
export interface EntityView {
  readonly id: EntityId;
  /** `null` when the viewer may not see which card this is. */
  readonly card: CardId | null;
  readonly controller: PlayerId;
  readonly exhausted: boolean;
  /** 423.1.a: Stunned, which suppresses this Unit's combat damage (423.1.b). */
  readonly stunned: boolean;
  readonly damage: number;
  /**
   * Effective Might, modifiers included (rule 143.2.b), or `null` when this is
   * not a Unit or the viewer cannot see the card.
   *
   * Printed on the card and therefore public, but derived rather than printed:
   * it is `might + mightBonus + buffs` (703), which is what Combat uses
   * (465-466). Exposed so an agent evaluating a board does not have to
   * reimplement `mightOf` against a card registry and get it subtly wrong.
   */
  readonly might: number | null;
}

export interface PlayerView {
  readonly id: PlayerId;
  readonly points: number;
  /** Cards are revealed only in the viewer's own hand. */
  readonly hand: readonly EntityView[];
  readonly runes: readonly EntityView[];
  readonly base: readonly EntityView[];
  readonly trash: readonly EntityView[];
  readonly legend: EntityView | null;
  readonly champion: EntityView | null;
  // Banishment is deliberately absent. Rule 186.1 has a Token there stop
  // existing, and the zone holds nothing else, so exposing it would show an
  // agent objects that are not in the game.
  /**
   * Decks are exposed as counts only — never as entity lists. Handing out ids
   * in deck order would let an agent track a card's identity across a shuffle,
   * which is exactly the leak this type exists to prevent.
   */
  readonly mainDeckCount: number;
  readonly runeDeckCount: number;
  /** Rune Pools are public: rule 166.3 gives them no hidden component. */
  readonly pool: RunePool;
  /**
   * The Facedown Zones (107.3), which are Public zones holding Private cards.
   *
   * So both halves are exposed, deliberately: `battlefield` says *where* a card
   * is hidden, which every player can see, and `card` is `null` for everyone but
   * its controller (128.4). An agent needs the first to reason about a threat it
   * cannot identify — which is the whole point of the mechanic.
   */
  readonly facedown: readonly FacedownView[];
}

/** A card in a Facedown Zone: its Battlefield is public, its face is not. */
export interface FacedownView extends EntityView {
  readonly battlefield: number | null;
}

export interface BattlefieldView {
  readonly card: CardId;
  readonly controller: PlayerId | null;
  readonly units: readonly EntityView[];
  /** Rule 190.3.a: who applied Contested status, if anyone. Public. */
  readonly contestedBy: PlayerId | null;
  /** Rule 470: players who have already Scored here this turn. */
  readonly scoredBy: readonly PlayerId[];
}

/**
 * The open Showdown (rule 341), which is public in its entirety.
 *
 * Agents need it to tell a Combat Showdown from a Non-Combat one and to know
 * which side of it they are on; none of it is hidden from either player.
 */
export interface ShowdownView {
  readonly battlefield: number;
  readonly focus: PlayerId;
  /** Rule 344.1: opposing Units are present, so this resolves as Combat. */
  readonly combat: boolean;
  readonly attacker: PlayerId | null;
  readonly defender: PlayerId | null;
}

export interface GameView {
  readonly viewer: PlayerId;
  readonly turn: number;
  readonly phase: Phase;
  readonly activePlayer: PlayerId;
  readonly outcome: Outcome | null;
  readonly players: readonly PlayerView[];
  readonly battlefields: readonly BattlefieldView[];
  /** The Chain, bottom to top. Its contents are public (rule 328). */
  readonly chain: readonly EntityView[];
  /** Rule 331: a Chain existing means the turn is in a Closed State. */
  readonly closed: boolean;
  readonly priority: PlayerId | null;
  /** Rule 341: the Showdown in progress, or `null` in a Neutral State. */
  readonly showdown: ShowdownView | null;
}

/** What `viewer` is entitled to know about the current state. */
export function observe(state: GameState, viewer: PlayerId): GameView {
  const reveal = (id: EntityId, visible: boolean): EntityView => {
    const entity = getEntity(state, id);
    // Might rides on card identity: revealing it for a face-down card would
    // leak exactly what `visible` exists to withhold.
    const card = visible ? definitionOf(state, entity.card) : undefined;
    return {
      id: entity.id,
      card: visible ? entity.card : null,
      controller: entity.controller,
      exhausted: entity.exhausted,
      // 423.1.a: Stunned is a public status — rule 274 lists it beside
      // Exhausted among the statuses presented on the Board — and it decides
      // whether a Unit deals damage, so an agent cannot fight without it.
      stunned: entity.stunned,
      damage: entity.damage,
      might:
        card?.type === 'unit'
          ? Math.max(0, card.might + entity.mightBonus + entity.buffs)
          : null,
    };
  };

  const revealAll = (ids: readonly EntityId[]): EntityView[] =>
    ids.map((id) => reveal(id, true));

  const players: PlayerView[] = state.players.map((player) => {
    const own = player.id === viewer;
    return {
      id: player.id,
      points: player.points,
      hand: player.zones.hand.map((id) => reveal(id, own)),
      runes: revealAll(player.zones.runes),
      base: revealAll(player.zones.base),
      trash: revealAll(player.zones.trash),
      legend: firstOrNull(player.zones.legendZone, reveal),
      champion: firstOrNull(player.zones.championZone, reveal),
      mainDeckCount: player.zones.mainDeck.length,
      runeDeckCount: player.zones.runeDeck.length,
      pool: player.pool,
      // 107.3.f: a Facedown Zone is a *public* zone whose contents are
      // Private, and 128.4 gives that Privacy to the card's controller rather
      // than its owner. So every player sees that something is hidden and at
      // which Battlefield, and only its controller sees which card it is.
      facedown: player.zones.facedown.map((id) => ({
        ...reveal(id, own),
        battlefield: getEntity(state, id).hiddenAt ?? null,
      })),
    };
  });

  const battlefields: BattlefieldView[] = state.battlefields.map(
    (battlefield: BattlefieldState) => ({
      card: battlefield.card,
      controller: battlefield.controller,
      units: revealAll(battlefield.units),
      contestedBy: battlefield.contestedBy,
      scoredBy: [...battlefield.scoredBy],
    }),
  );

  const showdown = state.showdown;

  return {
    viewer,
    turn: state.turn,
    phase: state.phase,
    activePlayer: state.activePlayer,
    outcome: state.outcome,
    players,
    battlefields,
    chain: state.chain.map((item) => reveal(item.entity, true)),
    closed: isClosed(state),
    priority: state.priority,
    showdown:
      showdown === null
        ? null
        : {
            battlefield: showdown.battlefield,
            focus: showdown.focus,
            combat: showdown.combat,
            attacker: showdown.attacker,
            defender: showdown.defender,
          },
  };
}

function firstOrNull(
  ids: readonly EntityId[],
  reveal: (id: EntityId, visible: boolean) => EntityView,
): EntityView | null {
  const id = ids[0];
  return id === undefined ? null : reveal(id, true);
}

/** Total cards the viewer can actually identify. Handy in tests and heuristics. */
export function knownCardCount(view: GameView): number {
  let count = 0;
  for (const player of view.players) {
    for (const entity of [
      ...player.hand,
      ...player.runes,
      ...player.base,
      ...player.trash,
    ]) {
      if (entity.card !== null) {
        count += 1;
      }
    }
  }
  return count;
}

/** Present so callers do not reach past the view to the state. */
export function opponentsOf(state: GameState, player: PlayerId): readonly PlayerId[] {
  return state.players.filter((candidate) => candidate.id !== player).map((candidate) => candidate.id);
}

/** Points held by a player, read from state rather than a view. */
export function pointsOf(state: GameState, player: PlayerId): number {
  return getPlayer(state, player).points;
}
