import {
  DOMAINS,
  type AbilityRef,
  type CardDefinition,
  type CardId,
  type Domain,
  type Keyword,
  type TriggerEvent,
} from '@riftbound/cards';

import type { RngState } from './rng.js';

/** Seat index. Never assume there are exactly two. */
export type PlayerId = number & { readonly __brand: 'PlayerId' };
/** Identity of a single card instance in a game. */
export type EntityId = number & { readonly __brand: 'EntityId' };

export function playerId(value: number): PlayerId {
  return value as PlayerId;
}

export function entityId(value: number): EntityId {
  return value as EntityId;
}

/**
 * Zones belonging to a player.
 *
 * `runes` holds Runes that have been Channelled out of the Rune deck and are in
 * play, ready or exhausted. `base` holds that player's Units that are not at a
 * Battlefield.
 */
export const PLAYER_ZONES = [
  'mainDeck',
  'hand',
  'runeDeck',
  'runes',
  'base',
  'trash',
  'legendZone',
  'championZone',
  /**
   * Cards partway through the Process of Play (rule 328).
   *
   * The Chain itself is a single shared Non-Board Zone, ordered by
   * `GameState.chain`; the cards on it sit here so that zone bookkeeping and
   * the invariant checker need no special case.
   */
  'chain',
  /**
   * Banishment (rule 438.5), and where a Token goes when it stops existing.
   *
   * Rule 186.1 says a Token put into any Non-Board Zone but the Chain ceases to
   * exist immediately. "Ceases to exist" is modelled as permanent occupancy
   * here rather than by deleting the entity, so that a reference held elsewhere
   * — a Chain item, `playedThisTurn`, a trigger source — still resolves instead
   * of throwing. Nothing ever leaves this zone.
   *
   * It is deliberately not the trash: a banished Token must not be counted by
   * "for each card in your trash", recycled by a Burn Out (431.2.b), or read as
   * a card in any other way.
   */
  'banishment',
  /**
   * The Facedown Zones (rule 107.3), flattened into one list per player.
   *
   * 107.3.e says a Facedown Zone is **not a Location**, which is what makes
   * this a player zone rather than a third `Location` variant: a facedown card
   * is not *at* the Battlefield, it is in a sub-zone associated with one. The
   * association is `Entity.hiddenAt`, exactly as `attachedTo` links a Gear to
   * its Top-Most Card without moving it anywhere new.
   *
   * 107.3.f makes the zone Public and the cards in it Private, so `view.ts`
   * shows every player that a card is hidden there and shows only its
   * controller which card it is.
   */
  'facedown',
] as const;

export type PlayerZone = (typeof PLAYER_ZONES)[number];

/** Zones whose contents are hidden from every player, including their owner. */
export const HIDDEN_ZONES: readonly PlayerZone[] = ['mainDeck', 'runeDeck'];

/** Where an entity currently is. */
export type Location =
  | { readonly kind: 'player'; readonly player: PlayerId; readonly zone: PlayerZone }
  | { readonly kind: 'battlefield'; readonly index: number };

export function playerLocation(player: PlayerId, zone: PlayerZone): Location {
  return { kind: 'player', player, zone };
}

export function battlefieldLocation(index: number): Location {
  return { kind: 'battlefield', index };
}

export function sameLocation(a: Location, b: Location): boolean {
  if (a.kind === 'player' && b.kind === 'player') {
    return a.player === b.player && a.zone === b.zone;
  }
  if (a.kind === 'battlefield' && b.kind === 'battlefield') {
    return a.index === b.index;
  }
  return false;
}

/** A single card instance. */
export interface Entity {
  readonly id: EntityId;
  readonly card: CardId;
  /** Whose deck this came from. Fixed for the whole game. */
  readonly owner: PlayerId;
  /** Who controls it now. May differ from `owner` once effects exist. */
  readonly controller: PlayerId;
  readonly location: Location;
  /** Exhausted cards are turned sideways; Awaken readies them. */
  readonly exhausted: boolean;
  /**
   * Rule 423.1.a: Stunned is a binary state a Unit is in or is not.
   *
   * 423.1.b is the whole of what it does — a Stunned Unit "does not contribute
   * its might to damage in the combat damage step" — and 423.1.c is what it
   * deliberately does *not* do: the Unit still needs damage equal to its full
   * Might to die. So `sumMight` reads this and `lethalRemaining` does not,
   * which is the same split Assault and Shield already live on.
   *
   * 423.1.a.2 clears it in the end-of-turn Cleanup, beside `mightBonus`.
   */
  readonly stunned: boolean;
  /** Damage marked on a Unit. A Unit is destroyed once this reaches its Might. */
  readonly damage: number;
  /**
   * Might granted until the end of the turn.
   *
   * Rule 317.2.c expires every "this turn" effect in the Ending Phase, which is
   * where this is cleared. Not a Buff — see the note on `giveMight`.
   */
  readonly mightBonus: number;
  /**
   * Keywords granted to this object until the end of the turn (801.3.a).
   *
   * "Give a unit ASSAULT 3 this turn" — the exact counterpart of `mightBonus`,
   * and cleared beside it by 317.2.c. Deliberately *not* a static: a static is
   * consulted from its source and stops the moment that source leaves the Board
   * (365), whereas this grant outlives the Spell that made it, which has gone
   * to the trash by the time the keyword matters.
   *
   * Read through `keywordsOf`, never directly — 801.3.a makes a granted keyword
   * exactly as real as a printed one.
   */
  readonly grantedKeywords: readonly Keyword[];
  /**
   * The Top-Most Card this one is Attached to (716-719), if any.
   *
   * 718.5.d allows only one at a time, which is why this is a single id rather
   * than a list — the reverse direction is a sweep, not a stored list, so the
   * two can never disagree about who is attached to whom.
   *
   * 719.3 keeps a Top-Most Card and everything Attached to it at the same
   * Location, and 719.3.a moves them together; `location` is still the single
   * source of truth for where each one is, and `attach.ts` is what keeps them
   * equal.
   */
  readonly attachedTo?: EntityId | undefined;
  /**
   * The Battlefield whose Facedown Zone this card occupies (107.3.a).
   *
   * Set exactly while the card is in the `facedown` zone. Not a `Location`,
   * because 107.3.e says a Facedown Zone is not one — the card is associated
   * with the Battlefield, not present at it, so it is not among its `units`
   * and no rule that reads a Battlefield's occupants can see it.
   */
  readonly hiddenAt?: number | undefined;
  /**
   * The turn on which this card was Hidden (811.1.b).
   *
   * 811.1.b makes a hidden card playable "beginning on the next turn", so the
   * turn it went down has to be remembered rather than inferred. Stored rather
   * than a boolean flag flipped at end of turn, because the flip would be one
   * more thing for the Ending Phase to remember and one more way to drift.
   */
  readonly hiddenOnTurn?: number | undefined;
  /**
   * Buff counters on a Unit (rules 701-705).
   *
   * A real counter, unlike `mightBonus`: each Buff contributes +1 Might (703)
   * and it persists across turns rather than expiring in the Ending Phase.
   * Rule 702.3 allows at most one at a time, so this is 0 or 1 — kept as a
   * number because 704 lets effects count them, and a second Buff being
   * *refused* (702.3.a) is easier to state against a count than a flag.
   */
  readonly buffs: number;
}

/**
 * Power held in the Rune Pool, by Domain.
 *
 * Every Domain is always present so callers never deal with `undefined`; a
 * Domain the player holds none of simply reads 0.
 */
export type PowerPool = Readonly<Record<Domain, number>>;

/**
 * A player's available Energy and Power (rule 166).
 *
 * Rule 167: every player's Rune Pool empties at the start of each Main Phase
 * and at the end of each turn, and anything unspent is lost.
 */
export interface RunePool {
  readonly energy: number;
  readonly power: PowerPool;
  /**
   * Power of any Domain held in the pool — the `[A]` of 135.2.e.5.
   *
   * 135.2.e.5.b: once Added, it "can be spent to pay a Power cost of any
   * Domain", so it is a wildcard pip rather than Power of a *chosen* Domain
   * fixed at the moment it arrives. That is why it is its own count instead of
   * `addPowerTo` with a Domain picked for the player: choosing early would
   * strand it when a later cost wants a different Domain.
   *
   * Not to be confused with `Cost.anyPower`, which is the same symbol on the
   * paying side.
   */
  readonly anyPower: number;
}

export const EMPTY_POWER: PowerPool = Object.freeze(
  Object.fromEntries(DOMAINS.map((domain) => [domain, 0])) as Record<Domain, number>,
);

export const EMPTY_POOL: RunePool = Object.freeze({ energy: 0, power: EMPTY_POWER, anyPower: 0 });

export function powerIn(pool: RunePool, domain: Domain): number {
  return pool.power[domain];
}

export function addEnergyTo(pool: RunePool, amount: number): RunePool {
  return { ...pool, energy: pool.energy + amount };
}

export function addPowerTo(pool: RunePool, domain: Domain, amount: number): RunePool {
  return { ...pool, power: { ...pool.power, [domain]: pool.power[domain] + amount } };
}

/** 135.2.e.5.b: Add `amount` Power of any Domain. */
export function addAnyPowerTo(pool: RunePool, amount: number): RunePool {
  return { ...pool, anyPower: pool.anyPower + amount };
}

export interface PlayerState {
  readonly id: PlayerId;
  readonly points: number;
  /** Ordered entity lists. Order is meaningful for decks. */
  readonly zones: Readonly<Record<PlayerZone, readonly EntityId[]>>;
  readonly pool: RunePool;
  /**
   * XP (rules 728-733): a player resource, accrued and spent.
   *
   * Not a Game Object (731) — it cannot be targeted, readied or exhausted —
   * so it lives on the player rather than as an entity. There is no cap (733).
   */
  readonly xp: number;
  /**
   * Cards this player has Finalized this turn, in order (rule 329.2).
   *
   * Kept as identities rather than a count because Legion (812.1.c) asks
   * whether "a card *different than* the one with the Legion ability" has been
   * played — a card's own Play Effect is being checked while that card is
   * already in this list, so a count would satisfy every Legion trigger on the
   * first card played. Cleared in the Ending Phase.
   */
  readonly playedThisTurn: readonly EntityId[];
  /**
   * How many times each kind of event this player was the actor of has happened
   * this turn.
   *
   * What "if you've discarded a card this turn" and "if an enemy unit has died
   * this turn" are answered from. Keyed by `TriggerEvent`, counted where the
   * events are raised, and cleared in the Ending Phase alongside
   * `playedThisTurn` — 812.1.c's "the same turn" is the same scope.
   */
  readonly turnEvents: Readonly<Partial<Record<TriggerEvent, number>>>;
}

/**
 * An item on the Chain (rules 328-329).
 *
 * Items are Pending while the Process of Play is still running for them, and
 * become Finalized at the Check Legality step (329.2). This engine completes
 * that process atomically, so an item is only ever observed Finalized — the
 * flag exists so the distinction survives when Pending windows arrive.
 */
export interface ChainItem {
  /** The played card, or the source of the ability. */
  readonly entity: EntityId;
  readonly controller: PlayerId;
  readonly pending: boolean;
  /**
   * The targets chosen when the card was played (rule 355.8), carried until it
   * resolves. Empty for a card that does not target.
   *
   * A list because one spec may choose several objects — "up to 2 friendly
   * units" is one choice of a *set*, and 355.6 makes each member a Target. A
   * card naming one target holds a list of one.
   */
  readonly targets: readonly EntityId[];
  /**
   * The Game Object the triggering event was about, for a `triggerObject`
   * target — "When a friendly unit dies, buff **it**".
   *
   * Recorded when the trigger is queued rather than looked up on resolution,
   * because by then the event is over: the Unit that died is in the trash and
   * the Move that happened has been superseded. `null` for a played card and
   * for a trigger whose event was about no object.
   */
  readonly triggerObject: EntityId | null;
  /**
   * The Destination chosen for a `move` effect (449.1), carried alongside the
   * target for the same reason. `null` when the card moves nothing.
   */
  readonly destination: Location | null;
  /**
   * Which ability this item is, or `null` when the item is a played card.
   *
   * Rule 377.3.a.1: an ability on the Chain "has no card to represent it", so
   * `entity` points at its *source* and the source stays wherever it is. That
   * is the difference that matters on resolution — a resolved Spell goes to the
   * trash, a resolved ability leaves its source alone.
   */
  readonly ability: AbilityRef | null;
  /**
   * Rule 356.2.b: whether the optional Additional Cost was declared when this
   * was played.
   *
   * Carried here because a Spell's effect resolves off the Chain later, and
   * "if you paid the additional cost" is asked then rather than at play time.
   */
  readonly paidAdditionalCost?: boolean | undefined;
  /**
   * 808.1.d.3: the Battlefield this ability's source was at when the trigger
   * was queued.
   *
   * "Before the card is moved to the Trash, note its location … to process the
   * trigger after it has been Finalized" — without it a Deathknell reading "my
   * battlefield" would resolve against a corpse, which 359.3.e.12 gives no
   * location at all. `null` when the event named no Battlefield.
   */
  readonly noted: number | null;
}

/**
 * An open Showdown (rule 341).
 *
 * A Showdown is a Window of Opportunity: players act in an alternating fashion,
 * passing Focus rather than Priority, until everyone passes in sequence (347.2)
 * and it Closes (348).
 */
export interface ShowdownState {
  readonly battlefield: number;
  /** Rule 345: the player who applied Contested status gains Focus first. */
  readonly focus: PlayerId;
  /** Consecutive Focus passes; equal to the player count ends the Showdown. */
  readonly passes: number;
  /** Rule 344.1: a Showdown with opposing Units present is a Combat Showdown. */
  readonly combat: boolean;
  /** Rule 464.2.c.1: whoever applied Contested. `null` outside Combat. */
  readonly attacker: PlayerId | null;
  /** Rule 464.2.c.2: the player who did not apply Contested. */
  readonly defender: PlayerId | null;
}

export interface BattlefieldState {
  readonly card: CardId;
  /**
   * The Battlefield as a Game Object (rule 170).
   *
   * 170.8-170.10 give Battlefields Passive, Triggered and Activated abilities,
   * and every one of those needs a Game Object to hang off — a source for
   * `activeStatics` and `triggersFor` to find, and the "me" an effect resolves
   * against. A bare `CardId` cannot be any of those.
   *
   * Its `location` is its own `battlefieldLocation`, because 170.5 makes a
   * Battlefield *a Location*. It is deliberately **not** in `units`: that list
   * is who is present *at* the Battlefield (170.6), and the Battlefield is not
   * present at itself. Nothing moves it either — 170.4 says Battlefields cannot
   * be Moved, and 170.3 that they cannot be Killed.
   */
  readonly entity: EntityId;
  /** `null` while Uncontrolled (rule 466.5.b). */
  readonly controller: PlayerId | null;
  readonly units: readonly EntityId[];
  /**
   * Who applied the Contested status, or `null` if the Battlefield is not
   * Contested (rule 190.3.a).
   *
   * Contested is a temporary status applied when a Unit becomes present at a
   * Battlefield its controller does not control. It is what tells the engine a
   * Showdown or Combat is due (190.3.c), and it persists until Control is
   * established or the contesting player has no Units left there (190.3.b).
   */
  readonly contestedBy: PlayerId | null;
  /**
   * Players who have already Scored this Battlefield this turn.
   *
   * Rule 470: a player may only Score a given Battlefield once per turn, by
   * either method, so Conquering a Battlefield you already Held this turn
   * scores nothing.
   */
  readonly scoredBy: readonly PlayerId[];
}

/**
 * The phases of a turn (rule 314).
 *
 * Start of Turn is four phases:
 *   Awaken    — ready everything you control (315.1)
 *   Beginning — Hold every Battlefield you Control (315.2)
 *   Channel   — Channel 2 Runes (315.3)
 *   Draw      — draw 1 (315.4)
 * then the Main Phase (316), then the Ending Phase (317).
 *
 * The A/B/C/D naming used by community guides maps onto the four Start of Turn
 * phases; the rulebook names them, and the rulebook is the naming authority.
 */
export const PHASES = [
  /**
   * Setup only (rule 117), before the first turn begins.
   *
   * Each player in turn order sets aside up to two cards, draws that many, then
   * Recycles the set-aside cards. It is a player choice, which is why it is a
   * phase with a decision point rather than a config value.
   */
  'mulligan',
  'awaken',
  'beginning',
  'channel',
  'draw',
  'main',
  'ending',
] as const;

export type Phase = (typeof PHASES)[number];

export type Outcome =
  | { readonly kind: 'win'; readonly winner: PlayerId }
  | { readonly kind: 'draw'; readonly reason: string };

/**
 * The variables a Mode of Play must define (rule 483), plus one harness guard.
 *
 * Defaults are the sanctioned 1v1 Duel mode (rule 485). Every value here is
 * taken from the official Core Rules, RUP4 of 2026-07-16, with the rule number
 * cited; none of them is a guess any more.
 */
export interface GameConfig {
  /** Rule 483.1. */
  readonly playerCount: number;
  /** Rule 483.3 / 485.3: the point total needed to win. 8 in the Duel mode. */
  readonly victoryScore: number;
  /** Rule 483.4 / 485.4: Battlefields in play. 2 in the Duel mode. */
  readonly battlefieldCount: number;
  /** Rule 485.4.a: Battlefields each player brings, of which one is used. */
  readonly battlefieldsPerPlayer: number;
  /** Rule 315.3.b: the Turn Player Channels 2 Runes in the Channel Phase. */
  readonly channelPerTurn: number;
  /** Rule 315.4.b: the Turn Player draws 1 in the Draw Phase. */
  readonly drawPerTurn: number;
  /** Rule 116: each player draws 4. */
  readonly openingHandSize: number;
  /** Rule 117.1: a player may set aside up to 2 cards when they Mulligan. */
  readonly mulliganLimit: number;
  /**
   * Rule 485.7: the player going second Channels this many extra Runes during
   * their first Channel Phase of the game.
   */
  readonly secondPlayerBonusRunes: number;
  /**
   * Harness guard, NOT a Riftbound rule. Fuzzing must not hang, so a game that
   * exceeds this many turns ends in a draw. Raise it for real simulations.
   *
   * Real games terminate on their own: an empty Main Deck causes a Burn Out
   * (rule 431), which hands an opponent a point, repeatedly, until someone
   * reaches the Victory Score.
   */
  readonly maxTurns: number;
}

export const DEFAULT_CONFIG: GameConfig = {
  playerCount: 2,
  victoryScore: 8,
  battlefieldCount: 2,
  battlefieldsPerPlayer: 3,
  channelPerTurn: 2,
  drawPerTurn: 1,
  openingHandSize: 4,
  mulliganLimit: 2,
  secondPlayerBonusRunes: 1,
  maxTurns: 200,
};

/**
 * The complete game state.
 *
 * Plain readonly data throughout: it serializes for golden-game tests, and
 * reducers rebuild it with structural sharing rather than deep cloning.
 */
export interface GameState {
  readonly config: GameConfig;
  /** Position of the seeded PRNG. Advancing it is part of the state. */
  readonly rng: RngState;
  /** 1-based; increments each time the active player changes. */
  readonly turn: number;
  readonly activePlayer: PlayerId;
  /** Rule 115.1.b.1: the player who became the Turn Player first. */
  readonly firstPlayer: PlayerId;
  readonly phase: Phase;
  readonly players: readonly PlayerState[];
  readonly battlefields: readonly BattlefieldState[];
  readonly entities: Readonly<Record<number, Entity>>;
  readonly nextEntityId: number;
  /**
   * Card definitions for every card in the game, denormalised at setup.
   *
   * The engine needs costs and card types to decide what may be played, but
   * keeping a `CardRegistry` on the state would make it unserializable and
   * would couple every reducer to card data. Copying the definitions in once
   * keeps `reduce` a pure function of the state alone, and keeps a saved game
   * self-describing.
   */
  readonly definitions: Readonly<Record<string, CardDefinition>>;
  /**
   * The Chain (rule 327). Empty means the turn is in an Open State (331.2).
   * The last element is the top: the next item to resolve.
   */
  readonly chain: readonly ChainItem[];
  /** Who may take Discretionary Actions right now (rule 312). */
  readonly priority: PlayerId | null;
  /** The open Showdown, if any (rule 341). */
  readonly showdown: ShowdownState | null;
  /**
   * How many players have taken their Mulligan (rule 117).
   *
   * Setup bookkeeping: once it reaches the player count, play begins with the
   * First Player (118).
   */
  readonly mulligansTaken: number;
  /**
   * How many times each Triggered Ability has been performed this turn, keyed
   * by `${source}:${abilityIndex}` (rule 383.3.e).
   *
   * Cleared in the Ending Phase. A plain record rather than a Map so the state
   * stays JSON-serializable for golden-game tests.
   */
  readonly triggersUsed: Readonly<Record<string, number>>;
  /**
   * How far through the current phase's steps the turn has got.
   *
   * A phase that puts a Triggered Ability on the Chain cannot simply finish and
   * advance — the Chain has to drain first, and players may respond while it
   * does (383.3.c). So a phase runs as a sequence of steps: it does a step's
   * work, and if that put anything on the Chain it *holds*, recording here
   * which step to resume from. The phase advances only once its last step has
   * run with an empty Chain.
   *
   * 0 for every phase that has nothing to interrupt, which is all of them
   * except Beginning (315.2) and Ending (317).
   */
  readonly phaseStep: number;
  /** Consecutive passes since the last Chain item was added or resolved. */
  readonly passes: number;
  /** `null` while the game is still running. */
  readonly outcome: Outcome | null;
}

/** Rule 331: a Chain existing puts the turn in a Closed State. */
export function isClosed(state: GameState): boolean {
  return state.chain.length > 0;
}

/** Rule 343.1: a Showdown or Combat in progress puts the turn in a Showdown State. */
export function isShowdown(state: GameState): boolean {
  return state.showdown !== null;
}

export function definitionOf(state: GameState, card: CardId): CardDefinition {
  const definition = state.definitions[card];
  if (definition === undefined) {
    throw new Error(`No card definition for ${card}`);
  }
  return definition;
}

/** The definition of the card an entity is an instance of. */
export function entityCard(state: GameState, id: EntityId): CardDefinition {
  return definitionOf(state, getEntity(state, id).card);
}

export function isOver(state: GameState): boolean {
  return state.outcome !== null;
}

export function getEntity(state: GameState, id: EntityId): Entity {
  const entity = state.entities[id];
  if (entity === undefined) {
    throw new Error(`Unknown entity id: ${id}`);
  }
  return entity;
}

export function getPlayer(state: GameState, id: PlayerId): PlayerState {
  const player = state.players[id];
  if (player === undefined) {
    throw new Error(`Unknown player id: ${id}`);
  }
  return player;
}

export function zoneOf(state: GameState, player: PlayerId, zone: PlayerZone): readonly EntityId[] {
  return getPlayer(state, player).zones[zone];
}

/** Seat that acts after `player`. */
export function nextPlayer(state: GameState, player: PlayerId): PlayerId {
  return playerId((player + 1) % state.players.length);
}
