import type { CardId } from '@riftbound/cards';

import type {
  BattlefieldState,
  EntityId,
  GameState,
  Outcome,
  Phase,
  PlayerId,
} from './state.js';
import { getEntity, getPlayer } from './state.js';

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
  readonly damage: number;
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
  /**
   * Decks are exposed as counts only — never as entity lists. Handing out ids
   * in deck order would let an agent track a card's identity across a shuffle,
   * which is exactly the leak this type exists to prevent.
   */
  readonly mainDeckCount: number;
  readonly runeDeckCount: number;
}

export interface BattlefieldView {
  readonly card: CardId;
  readonly controller: PlayerId | null;
  readonly units: readonly EntityView[];
}

export interface GameView {
  readonly viewer: PlayerId;
  readonly turn: number;
  readonly phase: Phase;
  readonly activePlayer: PlayerId;
  readonly outcome: Outcome | null;
  readonly players: readonly PlayerView[];
  readonly battlefields: readonly BattlefieldView[];
}

/** What `viewer` is entitled to know about the current state. */
export function observe(state: GameState, viewer: PlayerId): GameView {
  const reveal = (id: EntityId, visible: boolean): EntityView => {
    const entity = getEntity(state, id);
    return {
      id: entity.id,
      card: visible ? entity.card : null,
      controller: entity.controller,
      exhausted: entity.exhausted,
      damage: entity.damage,
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
    };
  });

  const battlefields: BattlefieldView[] = state.battlefields.map(
    (battlefield: BattlefieldState) => ({
      card: battlefield.card,
      controller: battlefield.controller,
      units: revealAll(battlefield.units),
    }),
  );

  return {
    viewer,
    turn: state.turn,
    phase: state.phase,
    activePlayer: state.activePlayer,
    outcome: state.outcome,
    players,
    battlefields,
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
