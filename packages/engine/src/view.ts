import type { AbilityRef, CardEffect, CardId, Keyword } from '@riftbound/cards';

import type {
  BattlefieldState,
  DelayedPassive,
  EntityId,
  GameState,
  Outcome,
  Phase,
  PlayerId,
  RunePool,
} from './state.js';
import { abilityFor } from './abilities.js';
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
  /**
   * Rule 702: Buff counters, which are physical markers on the Unit and so
   * public. Exposed separately from `might` because they are spendable
   * (702.2.b) — an agent needs to know a Buff is there, not only that Might is
   * one higher.
   */
  readonly buffs: number;
  /** 801.3.a: keywords granted this turn. Indistinguishable from printed ones. */
  readonly grantedKeywords: readonly Keyword[];
  /** 718: the Top-Most Card this one is Attached to, if any. Visible at the table. */
  readonly attachedTo?: EntityId | undefined;
}

/**
 * One item on the Chain (rule 327).
 *
 * Rule 328 makes the Chain public, so everything about an item is exposed
 * except the identity of a card the viewer may not see — which for a Chain item
 * is nothing, since a played card is revealed as it goes on.
 */
export interface ChainItemView {
  readonly entity: EntityView;
  readonly controller: PlayerId;
  /** Rule 400: still working through the steps of playing, awaiting 402.2. */
  readonly pending: boolean;
  readonly targets: readonly EntityId[];
  /** The "it" of a Triggered Ability's effect — public like the rest (328). */
  readonly triggerObject: EntityId | null;
  /** 390.5: the Linked Ability's effect, when this item is one. */
  readonly linked: CardEffect | null;
  /**
   * 424: the cards this item looked at. Their *identities* are redacted unless
   * 424.1 presented them to all players or the viewer did the looking (128.4);
   * how many there are is public either way, because the act is visible.
   */
  readonly revealed: readonly EntityView[];
  readonly revealedToAll: boolean;
  /** 377.3.a.1: which ability, when this item is one rather than a card. */
  readonly ability: AbilityRef | null;
  /**
   * 808.1.d.3's noted Battlefield.
   *
   * Public like the rest of the Chain (328) — where a Unit was when it died is
   * something the whole table saw — and exposed so `determinize` can rebuild a
   * Chain that resolves the same way the real one will.
   */
  readonly noted: number | null;
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
  /**
   * The top card of this player's own Main Deck, while they are Predicting.
   *
   * 436.1 makes Predicting "the act of **looking at** a single card from the
   * top of the Main Deck and choosing whether or not to Recycle it" — so the
   * look is part of the action, and a controller who had to decide blind would
   * be playing a strictly weaker card than the one printed.
   *
   * Revealed only to that player, and only while they control a pending Chain
   * item whose ability Recycles from the top. `null` at every other moment,
   * which is what keeps the Main Deck otherwise hidden from everyone.
   */
  readonly predicting: EntityView | null;
}

/** A card in a Facedown Zone: its Battlefield is public, its face is not. */
export interface FacedownView extends EntityView {
  readonly battlefield: number | null;
  /** 811.1.b: the turn it was Hidden, which decides when it becomes playable. */
  readonly hiddenOnTurn: number | null;
}

export interface BattlefieldView {
  readonly card: CardId;
  /** 170: the Battlefield's own Game Object, which carries its abilities. */
  readonly entity: EntityId;
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
  readonly chain: readonly ChainItemView[];
  /**
   * 390.4's Delayed Passive Abilities for this turn.
   *
   * Public: creating one is announced at the table, and an agent that could not
   * see "opponents can't play cards this turn" would keep offering plays the
   * reducer then refuses.
   */
  readonly turnEffects: readonly DelayedPassive[];
  /** Rule 115.1.b.1, and 485.7's extra Rune for the player going second. */
  readonly firstPlayer: PlayerId;
  /**
   * Public bookkeeping a determinizing search agent needs to rebuild a state
   * it can search on, and which no rule makes secret: how far through an
   * interruptible phase the turn is, how many players have passed in a row,
   * how many Mulligans have been taken (117), and 383.3.e's per-turn trigger
   * tally. All of it happens face-up at a table.
   */
  readonly phaseStep: number;
  readonly passes: number;
  readonly mulligansTaken: number;
  readonly triggersUsed: Readonly<Record<string, number>>;
  /** Rule 331: a Chain existing means the turn is in a Closed State. */
  readonly closed: boolean;
  readonly priority: PlayerId | null;
  /** Rule 341: the Showdown in progress, or `null` in a Neutral State. */
  readonly showdown: ShowdownView | null;
}

/**
 * Is `player` mid-Predict — that is, do they control the pending Chain item,
 * and does its ability Recycle from the top of a deck?
 *
 * Narrow on purpose. The Main Deck is hidden from everyone (128), and this is
 * the one rule that opens a window into it; anything broader would leak.
 */
function isPredicting(state: GameState, player: PlayerId): boolean {
  const top = state.chain[state.chain.length - 1];
  if (top === undefined || !top.pending || top.controller !== player || top.ability === null) {
    return false;
  }
  const ability = abilityFor(state, top.entity, top.ability);
  return ability?.effect.effects.some((effect) => effect.kind === 'recycleTop') === true;
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
      buffs: entity.buffs,
      grantedKeywords: entity.grantedKeywords,
      ...(entity.attachedTo === undefined ? {} : { attachedTo: entity.attachedTo }),
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
      // 436.1: the look that a Predict is half made of.
      predicting:
        own && isPredicting(state, player.id)
          ? (firstOrNull(player.zones.mainDeck, reveal) ?? null)
          : null,
      facedown: player.zones.facedown.map((id) => ({
        ...reveal(id, own),
        battlefield: getEntity(state, id).hiddenAt ?? null,
        // 811.1.b's "beginning on the next turn": which turn it went down is
        // as public as the fact that it did.
        hiddenOnTurn: getEntity(state, id).hiddenOnTurn ?? null,
      })),
    };
  });

  const battlefields: BattlefieldView[] = state.battlefields.map(
    (battlefield: BattlefieldState) => ({
      card: battlefield.card,
      entity: battlefield.entity,
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
    // 328: the Chain is public, so every item is exposed in full.
    turnEffects: state.turnEffects,
    chain: state.chain.map((item) => ({
      entity: reveal(item.entity, true),
      controller: item.controller,
      pending: item.pending,
      targets: item.targets,
      triggerObject: item.triggerObject,
      linked: item.linked,
      revealedToAll: item.revealedToAll,
      // 128.4: a look is Private to the looking player; 424.1's reveal is not.
      revealed: item.revealed.map((id) =>
        reveal(id, item.revealedToAll || item.controller === viewer),
      ),
      ability: item.ability,
      noted: item.noted,
    })),
    closed: isClosed(state),
    priority: state.priority,
    firstPlayer: state.firstPlayer,
    phaseStep: state.phaseStep,
    passes: state.passes,
    mulligansTaken: state.mulligansTaken,
    triggersUsed: state.triggersUsed,
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
