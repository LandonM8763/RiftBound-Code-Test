/**
 * Rebuilding a searchable `GameState` from a `GameView` (rule 128).
 *
 * A search agent cannot be handed the state — the whole point of the view is
 * that an agent physically cannot read what it should not see. So it builds its
 * own: everything public is copied across exactly, and everything Private is
 * *sampled* from what the viewer legitimately knows. That is determinization,
 * and it is what CLAUDE.md's hidden-information design exists to enable.
 *
 * ## What is exact and what is guessed
 *
 * Exact: the board, both trashes, the Chain, the Showdown, points, pools, and
 * the viewer's own hand and facedown cards. Rule 128.5 makes all of it Public,
 * or 128.4 Private to this viewer.
 *
 * Guessed: the opponent's hand, both Main Decks and both Rune Decks. These are
 * filled from `unseen` — the cards the viewer believes are still unaccounted
 * for — shuffled with the supplied generator. One determinization is one
 * plausible world; a search agent averages over several.
 *
 * ## Why the identities are preserved
 *
 * Every entity keeps the id it had in the real game. A search agent's whole
 * output is an `Action`, and an action names entities — so an action chosen in
 * a determinized world has to be meaningful in the real one. Sampling fresh ids
 * for hidden cards would produce actions the real engine rejects.
 */
import { TOKEN_DEFINITIONS, type CardDefinition, type CardId } from '@riftbound/cards';

import { Rng } from './rng.js';
import type { ChainItemView, EntityView, GameView } from './view.js';
import {
  DEFAULT_CONFIG,
  battlefieldLocation,
  entityId,
  playerLocation,
  type BattlefieldState,
  type ChainItem,
  type Entity,
  type EntityId,
  type GameConfig,
  type GameState,
  type PlayerId,
  type PlayerState,
  type PlayerZone,
} from './state.js';

/** What the viewer knows beyond the view itself. */
export interface Knowledge {
  /**
   * Every card definition in the game.
   *
   * Not secret: a player can read every card in their own deck and any the
   * opponent has shown. Supplied rather than derived because a view names only
   * the cards it can see.
   */
  readonly definitions: Readonly<Record<string, CardDefinition>>;
  /**
   * Cards the viewer believes are hidden, as a multiset to draw from.
   *
   * Used to fill the opponent's hand and both decks. A viewer who knows only
   * their own deck list supplies that; a deck-testing harness that owns both
   * can supply both, which is the honest case here because the whole point is
   * measuring two known decks against each other.
   *
   * Too few, and the remainder is filled with `filler`.
   */
  readonly unseen?: readonly CardId[] | undefined;
  /**
   * The card to use when `unseen` runs out.
   *
   * A determinized world must have *something* in every hidden slot, because
   * the counts are public and a deck of the wrong size changes what Burn Out
   * does (431). Defaults to the first definition, which is arbitrary and
   * deliberately so — a search agent should be sampling, not trusting this.
   */
  readonly filler?: CardId | undefined;
  readonly config?: GameConfig | undefined;
}

const ZONES: readonly PlayerZone[] = [
  'mainDeck',
  'hand',
  'runeDeck',
  'runes',
  'base',
  'trash',
  'legendZone',
  'championZone',
  'chain',
  'banishment',
  'facedown',
];

/**
 * Build a `GameState` consistent with `view`.
 *
 * `seed` drives the sampling of hidden cards, so the same view and seed give
 * the same world — a determinizing agent stays as reproducible as the engine.
 */
export function determinize(view: GameView, knowledge: Knowledge, seed: number | string): GameState {
  const rng = Rng.fromSeed(seed);
  // 181: Token definitions come with the game rather than out of a deck, so
  // `createGame` seeds them into every state and a determinized world needs
  // them too — a rollout that Creates one would otherwise fail to read it.
  const definitions = { ...TOKEN_DEFINITIONS, ...knowledge.definitions };
  const filler = knowledge.filler ?? (Object.keys(definitions)[0] as CardId | undefined);
  if (filler === undefined) {
    throw new Error('determinize needs at least one card definition');
  }

  // The pool of hidden cards, shuffled once so every hidden slot draws from the
  // same world rather than each being independently plausible.
  const pool = rng.shuffle([...(knowledge.unseen ?? [])]);
  let drawn = 0;
  const nextHidden = (): CardId => (pool[drawn++] ?? filler) as CardId;

  const entities: Record<number, Entity> = {};
  let maxId = 0;

  /** Copy a visible entity across exactly, or invent one for a hidden card. */
  const place = (seen: EntityView, location: Entity['location'], owner: PlayerId): EntityId => {
    maxId = Math.max(maxId, seen.id);
    entities[seen.id] = {
      id: seen.id,
      // 128.4: `null` means this viewer may not read the face, so a plausible
      // card is put there instead. The *id* is real either way, which is what
      // keeps a chosen action meaningful outside the determinized world.
      card: seen.card ?? nextHidden(),
      owner,
      controller: seen.controller,
      location,
      exhausted: seen.exhausted,
      damage: seen.damage,
      // The view publishes effective Might rather than its parts, so the whole
      // modifier lands in `mightBonus` and the Buff count is copied across.
      // 702.3 caps Buffs at one and `checkInvariants` enforces it, so this
      // cannot invent an impossible Unit.
      mightBonus: mightBonusOf(seen, definitions),
      grantedKeywords: [...seen.grantedKeywords],
      buffs: seen.buffs,
      stunned: seen.stunned,
      ...(seen.attachedTo === undefined ? {} : { attachedTo: seen.attachedTo }),
    };
    return seen.id;
  };

  const players: PlayerState[] = view.players.map((seat) => {
    const zones: Record<PlayerZone, EntityId[]> = Object.fromEntries(
      ZONES.map((zone) => [zone, [] as EntityId[]]),
    ) as Record<PlayerZone, EntityId[]>;

    const into = (zone: PlayerZone, seen: readonly EntityView[]): void => {
      for (const card of seen) {
        zones[zone].push(place(card, playerLocation(seat.id, zone), seat.id));
      }
    };
    into('hand', seat.hand);
    into('runes', seat.runes);
    into('base', seat.base);
    into('trash', seat.trash);
    if (seat.legend !== null) {
      into('legendZone', [seat.legend]);
    }
    if (seat.champion !== null) {
      into('championZone', [seat.champion]);
    }
    for (const card of seat.facedown) {
      const id = place(card, playerLocation(seat.id, 'facedown'), seat.id);
      zones.facedown.push(id);
      entities[id] = {
        ...entities[id]!,
        ...(card.battlefield === null ? {} : { hiddenAt: card.battlefield }),
        ...(card.hiddenOnTurn === null ? {} : { hiddenOnTurn: card.hiddenOnTurn }),
      };
    }

    return {
      id: seat.id,
      points: seat.points,
      zones: zones as PlayerState['zones'],
      pool: seat.pool,
      xp: 0,
      playedThisTurn: [],
      turnEvents: {},
    };
  });

  // The Chain is public (328), so its items copy across whole.
  const chain: ChainItem[] = view.chain.map((item: ChainItemView) => {
    const owner = item.entity.controller;
    place(item.entity, playerLocation(owner, 'chain'), owner);
    (players[owner]!.zones.chain as EntityId[]).push(item.entity.id);
    return {
      noted: item.noted,
      entity: item.entity.id,
      controller: item.controller,
      pending: item.pending,
      targets: item.targets,
      destination: null,
      ability: item.ability,
    };
  });

  const battlefields: BattlefieldState[] = view.battlefields.map((battlefield, index) => {
    const units = battlefield.units.map((unit) =>
      place(unit, battlefieldLocation(index), unit.controller),
    );
    // 170.5 puts a Battlefield's own Game Object at its own Location. It has no
    // owner in the rules; the first seat stands in, and nothing reads it.
    maxId = Math.max(maxId, battlefield.entity);
    entities[battlefield.entity] = {
      id: battlefield.entity,
      card: battlefield.card,
      owner: 0 as PlayerId,
      controller: (battlefield.controller ?? 0) as PlayerId,
      location: battlefieldLocation(index),
      exhausted: false,
      damage: 0,
      mightBonus: 0,
      grantedKeywords: [],
      buffs: 0,
      stunned: false,
    };
    return {
      card: battlefield.card,
      entity: battlefield.entity,
      controller: battlefield.controller,
      units,
      contestedBy: battlefield.contestedBy,
      scoredBy: [...battlefield.scoredBy],
    };
  });

  // Decks last: their contents are unknown, so they take whatever the pool has
  // left. The *counts* are public, which is what has to be right — a deck of
  // the wrong size changes when a Burn Out happens (431).
  let nextId = maxId + 1;
  const deckInto = (seat: PlayerState, zone: 'mainDeck' | 'runeDeck', count: number): void => {
    for (let i = 0; i < count; i += 1) {
      const id = entityId(nextId++);
      entities[id] = {
        id,
        card: nextHidden(),
        owner: seat.id,
        controller: seat.id,
        location: playerLocation(seat.id, zone),
        exhausted: false,
        damage: 0,
        mightBonus: 0,
        grantedKeywords: [],
        buffs: 0,
        stunned: false,
      };
      (seat.zones[zone] as EntityId[]).push(id);
    }
  };
  view.players.forEach((seat, index) => {
    deckInto(players[index]!, 'mainDeck', seat.mainDeckCount);
    deckInto(players[index]!, 'runeDeck', seat.runeDeckCount);
  });

  return {
    config: knowledge.config ?? DEFAULT_CONFIG,
    rng: Rng.fromSeed(`${seed}-play`).state,
    turn: view.turn,
    activePlayer: view.activePlayer,
    firstPlayer: view.firstPlayer,
    phase: view.phase,
    players,
    battlefields,
    entities,
    nextEntityId: nextId,
    definitions,
    chain,
    priority: view.priority,
    showdown:
      view.showdown === null
        ? null
        : {
            battlefield: view.showdown.battlefield,
            focus: view.showdown.focus,
            combat: view.showdown.combat,
            attacker: view.showdown.attacker,
            defender: view.showdown.defender,
            passes: 0,
          },
    mulligansTaken: view.mulligansTaken,
    triggersUsed: view.triggersUsed,
    phaseStep: view.phaseStep,
    passes: view.passes,
    outcome: view.outcome,
  };
}

/**
 * The Might modifier implied by the view (143.2).
 *
 * The view publishes effective Might rather than its parts, so this recovers
 * the difference from the printed value. A card the viewer cannot see has no
 * published Might, and gets none.
 */
function mightBonusOf(
  seen: EntityView,
  definitions: Readonly<Record<string, CardDefinition>>,
): number {
  if (seen.card === null || seen.might === null) {
    return 0;
  }
  const card = definitions[seen.card];
  if (card === undefined || card.type !== 'unit') {
    return 0;
  }
  // Statics are recomputed from the board, and Buffs are copied separately, so
  // only the printed value and the Buffs come off the published total.
  return seen.might - card.might - seen.buffs;
}
