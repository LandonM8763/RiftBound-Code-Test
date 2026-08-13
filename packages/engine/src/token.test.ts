/**
 * Tokens (rules 179-187).
 *
 * Rule numbers cite the official Riftbound Core Rules, RUP4 of 2026-07-16.
 *
 * The two things worth pinning are the ones that make a Token something other
 * than a cheap card: 186.1 stops it existing the moment it would reach a
 * Non-Board Zone, and 185.3 leaves it without a cost or a domain while 185.2
 * keeps its Might, tags and type doing real work in Combat.
 */
import {
  CardRegistry,
  STANDARD_TOKENS,
  cardId,
  cost,
  isTokenCard,
  tokenByName,
  tokenCardId,
  type CardDefinition,
} from '@riftbound/cards';
import { makeBattlefield, makeLegend, makeRune, makeUnit } from '@riftbound/cards/testing';
import { describe, expect, it } from 'vitest';

import { mightOf } from './combat.js';
import { checkInvariants } from './invariants.js';
import { legalActions } from './legal.js';
import { moveEntity, withPlayer } from './mutate.js';
import { reduce } from './reduce.js';
import { createGame, type DeckList } from './setup.js';
import { createTokens, isToken, sendToNonBoardZone } from './token.js';
import {
  battlefieldLocation,
  entityCard,
  isOver,
  playerLocation,
  type EntityId,
  type GameState,
} from './state.js';

const LEGEND = makeLegend(['fury'], { id: cardId('T-000') });
const CHAMPION = makeUnit(3, ['fury'], { id: cardId('T-001'), champion: true });
const PLAIN = makeUnit(2, ['fury'], { id: cardId('T-010'), name: 'Plain', cost: cost(1) });

/** "When you play me, play a 1 Might Recruit unit token here." */
const DRUMMER = makeUnit(2, ['fury'], {
  id: cardId('T-011'),
  name: 'Drummer',
  cost: cost(1),
  effect: {
    target: { kind: 'none' },
    effects: [{ kind: 'createToken', token: 'recruit', count: 1, where: 'here' }],
  },
});

/** Two at the Base, entering ready — 184.1's override of 359.2.c. */
const MUSTER = makeUnit(2, ['fury'], {
  id: cardId('T-012'),
  name: 'Muster',
  cost: cost(1),
  effect: {
    target: { kind: 'none' },
    effects: [{ kind: 'createToken', token: 'recruit', count: 2, where: 'base', ready: true }],
  },
});

/** 187.2: a Sprite carries Temporary, so it kills itself in the Beginning Phase. */
const SUMMONER = makeUnit(2, ['fury'], {
  id: cardId('T-013'),
  name: 'Summoner',
  cost: cost(1),
  effect: {
    target: { kind: 'none' },
    effects: [{ kind: 'createToken', token: 'sprite', count: 1, where: 'base' }],
  },
});

const RUNE = makeRune('fury', { id: cardId('T-100') });
const BATTLEFIELDS = Array.from({ length: 3 }, (_, i) =>
  makeBattlefield({ id: cardId(`T-20${i}`) }),
);

const REGISTRY = CardRegistry.from([
  LEGEND,
  CHAMPION,
  PLAIN,
  DRUMMER,
  MUSTER,
  SUMMONER,
  RUNE,
  ...BATTLEFIELDS,
] as CardDefinition[]);

function deck(): DeckList {
  return {
    legend: LEGEND.id,
    champion: CHAMPION.id,
    main: [
      ...Array.from({ length: 6 }, () => PLAIN.id),
      ...Array.from({ length: 4 }, () => DRUMMER.id),
      ...Array.from({ length: 4 }, () => MUSTER.id),
      ...Array.from({ length: 4 }, () => SUMMONER.id),
    ],
    runes: Array.from({ length: 8 }, () => RUNE.id),
    battlefields: BATTLEFIELDS.map((battlefield) => battlefield.id),
  };
}

function inMainPhase(seed = 'token', energy = 6): GameState {
  let state = createGame({ decks: [deck(), deck()], registry: REGISTRY, seed }).state;
  while (state.phase === 'mulligan') {
    state = reduce(state, { type: 'mulligan', cards: [] }).state;
  }
  while (state.phase !== 'main' && !isOver(state)) {
    state = reduce(state, { type: 'resolvePhase' }).state;
  }
  return withPlayer(state, state.activePlayer, (seat) => ({
    ...seat,
    pool: { energy, power: seat.pool.power },
  }));
}

function inHand(state: GameState, id: CardDefinition['id']): [GameState, EntityId] {
  const player = state.activePlayer;
  const held = state.players[player]!.zones.hand.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (held !== undefined) {
    return [state, held];
  }
  const card = state.players[player]!.zones.mainDeck.find(
    (candidate) => state.entities[candidate]!.card === id,
  );
  if (card === undefined) {
    throw new Error(`No ${id} left in the deck`);
  }
  return [moveEntity(state, card, playerLocation(player, 'hand')), card];
}

describe('rule 187: the tokens that exist', () => {
  it('gives each one the characteristics the rulebook states', () => {
    // 187.1, 187.2, 187.3, 187.4, 187.6, 187.10.
    expect(STANDARD_TOKENS['recruit']).toMatchObject({ might: 1, tags: ['Recruit'] });
    expect(STANDARD_TOKENS['sprite']).toMatchObject({ might: 3, tags: ['Fae'] });
    expect(STANDARD_TOKENS['sand soldier']).toMatchObject({ might: 2, tags: ['Shurima'] });
    expect(STANDARD_TOKENS['mech']).toMatchObject({ might: 3, tags: ['Mech'] });
    expect(STANDARD_TOKENS['reflection']).toMatchObject({ might: 0, tags: [] });
    expect(STANDARD_TOKENS['tentacle']).toMatchObject({ might: 1, tags: ['Bilgewater'] });
  });

  it('185.3: leaves every token domainless', () => {
    for (const key of Object.keys(STANDARD_TOKENS)) {
      expect(entityCardFor(key).domains).toEqual([]);
    }
  });

  it('refuses a name rule 187 does not define', () => {
    expect(tokenByName('Recruit')).toBeDefined();
    expect(tokenByName('Dragon')).toBeUndefined();
  });
});

/** The registered definition for a token key, read the way the engine does. */
function entityCardFor(key: string): CardDefinition {
  const state = inMainPhase();
  const definition = state.definitions[tokenCardId(key)];
  if (definition === undefined) {
    throw new Error(`No definition for token ${key}`);
  }
  return definition;
}

describe('rules 180-184: creating tokens', () => {
  it('182-183: the creating effect\'s controller owns and controls it', () => {
    const [state, card] = inHand(inMainPhase('create'), DRUMMER.id);
    const player = state.activePlayer;
    const before = state.players[player]!.zones.base.length;

    const played = reduce(state, { type: 'playCard', card }).state;
    const base = played.players[player]!.zones.base;

    // The Drummer itself plus its Recruit.
    expect(base.length).toBe(before + 2);
    const token = base.find((id) => isToken(played, id));
    expect(token).toBeDefined();
    expect(played.entities[token!]!.controller).toBe(player);
    expect(played.entities[token!]!.owner).toBe(player);
    checkInvariants(played);
  });

  it('359.2.c: a token enters exhausted unless 184.1 says otherwise', () => {
    const [plain, drummer] = inHand(inMainPhase('exhausted'), DRUMMER.id);
    const player = plain.activePlayer;
    const afterDrummer = reduce(plain, { type: 'playCard', card: drummer }).state;
    const summoned = afterDrummer.players[player]!.zones.base.find((id) => isToken(afterDrummer, id));
    expect(afterDrummer.entities[summoned!]!.exhausted).toBe(true);

    const [ready, muster] = inHand(inMainPhase('ready'), MUSTER.id);
    const afterMuster = reduce(ready, { type: 'playCard', card: muster }).state;
    const tokens = afterMuster.players[ready.activePlayer]!.zones.base.filter((id) =>
      isToken(afterMuster, id),
    );
    expect(tokens).toHaveLength(2);
    for (const id of tokens) {
      expect(afterMuster.entities[id]!.exhausted).toBe(false);
    }
  });

  it('185.2.b: a token unit has the Might rule 187 gives it', () => {
    const [state, card] = inHand(inMainPhase('might'), DRUMMER.id);
    const played = reduce(state, { type: 'playCard', card }).state;
    const token = played.players[played.activePlayer]!.zones.base.find((id) => isToken(played, id));

    expect(mightOf(played, token!)).toBe(1);
  });

  it('185: a token is not a card, and a card is not a token', () => {
    const [state, card] = inHand(inMainPhase('nature'), DRUMMER.id);
    const played = reduce(state, { type: 'playCard', card }).state;
    const token = played.players[played.activePlayer]!.zones.base.find((id) => isToken(played, id));

    expect(isTokenCard(entityCard(played, token!))).toBe(true);
    expect(isTokenCard(entityCard(played, card))).toBe(false);
  });

  it('creates them at a Battlefield when the source is there', () => {
    let state = inMainPhase('here');
    const player = state.activePlayer;
    const events: never[] = [];
    const { state: withToken, created } = createTokens(
      state,
      player,
      'recruit',
      1,
      battlefieldLocation(0),
      false,
      events,
    );
    state = withToken;

    expect(state.battlefields[0]!.units).toContain(created[0]);
    checkInvariants(state);
  });

  it('throws for a token rule 187 does not define', () => {
    const state = inMainPhase('unknown');
    expect(() =>
      createTokens(state, state.activePlayer, 'dragon', 1, playerLocation(state.activePlayer, 'base'), false, []),
    ).toThrow(/Unknown token/);
  });
});

describe('rule 186.1: a token that leaves the Board stops existing', () => {
  it('goes to Banishment rather than the trash when killed', () => {
    const [state, card] = inHand(inMainPhase('death'), DRUMMER.id);
    const player = state.activePlayer;
    const played = reduce(state, { type: 'playCard', card }).state;
    const token = played.players[player]!.zones.base.find((id) => isToken(played, id))!;
    const trashBefore = played.players[player]!.zones.trash.length;

    const gone = sendToNonBoardZone(played, token, playerLocation(player, 'trash'));

    expect(gone.players[player]!.zones.trash.length).toBe(trashBefore);
    expect(gone.players[player]!.zones.banishment).toContain(token);
    checkInvariants(gone);
  });

  it('leaves a card alone: it still reaches the trash', () => {
    const [state, card] = inHand(inMainPhase('card-death'), PLAIN.id);
    const player = state.activePlayer;
    const onBoard = moveEntity(state, card, playerLocation(player, 'base'));

    const dead = sendToNonBoardZone(onBoard, card, playerLocation(player, 'trash'));

    expect(dead.players[player]!.zones.trash).toContain(card);
    expect(dead.players[player]!.zones.banishment).not.toContain(card);
  });

  it('187.2: a Sprite carries Temporary and kills itself in the Beginning Phase', () => {
    const [state, card] = inHand(inMainPhase('sprite'), SUMMONER.id);
    const player = state.activePlayer;
    let next = reduce(state, { type: 'playCard', card }).state;
    const sprite = next.players[player]!.zones.base.find((id) => isToken(next, id))!;

    // Run to this player's next Beginning Phase, where 816.1.b fires.
    let guard = 0;
    while (next.players[player]!.zones.banishment.length === 0 && !isOver(next) && guard < 400) {
      const actions = legalFor(next);
      const action = actions[0];
      if (action === undefined) {
        break;
      }
      next = reduce(next, action).state;
      guard += 1;
    }

    // It stopped existing rather than filling the trash (186.1).
    expect(next.players[player]!.zones.banishment).toContain(sprite);
    expect(next.players[player]!.zones.trash).not.toContain(sprite);
  });
});

/** Whatever the engine will accept next, preferring to advance the turn. */
function legalFor(state: GameState): { type: 'resolvePhase' | 'endTurn' | 'pass' }[] {
  const actions: { type: 'resolvePhase' | 'endTurn' | 'pass' }[] = [];
  if (state.chain.length > 0) {
    actions.push({ type: 'pass' });
  } else if (state.phase === 'main') {
    actions.push({ type: 'endTurn' });
  } else {
    actions.push({ type: 'resolvePhase' });
  }
  return actions;
}

/**
 * Battlefields as Game Objects (rules 169-172).
 *
 * 170 makes a Battlefield a Game Object, 170.5 makes it a Location, and
 * 170.8-170.10 give it Passive, Triggered and Activated abilities. Before this
 * `BattlefieldState` held only a card id, so ingest dropped every one of them
 * rather than ship a card the engine would silently never run.
 */
describe('Battlefields as Game Objects (rules 169-172)', () => {
  /** "Units here have +1 Might." — 170.8, and a property of the Location. */
  const WAR_CAMP = makeBattlefield({
    id: cardId('T-210'),
    name: 'War Camp',
    abilities: {
      statics: [{ affects: { who: 'any', here: true }, grant: { might: 1 } }],
    },
  });

  const REGISTRY = CardRegistry.from([
    LEGEND,
    CHAMPION,
    PLAIN,
    RUNE,
    WAR_CAMP,
    ...BATTLEFIELDS,
  ] as CardDefinition[]);

  function game(seed: string): GameState {
    const list: DeckList = {
      legend: LEGEND.id,
      champion: CHAMPION.id,
      main: Array.from({ length: 12 }, () => PLAIN.id),
      runes: Array.from({ length: 8 }, () => RUNE.id),
      // Every choice is the War Camp, so 485.5's random pick lands on it.
      battlefields: [WAR_CAMP.id, WAR_CAMP.id, WAR_CAMP.id],
    };
    let state = createGame({ decks: [list, list], registry: REGISTRY, seed }).state;
    while (state.phase === 'mulligan') {
      state = reduce(state, { type: 'mulligan', cards: [] }).state;
    }
    while (state.phase !== 'main' && !isOver(state)) {
      state = reduce(state, { type: 'resolvePhase' }).state;
    }
    return state;
  }

  it('170: each Battlefield has its own Game Object', () => {
    const state = game('bf-entity');
    for (const battlefield of state.battlefields) {
      expect(state.entities[battlefield.entity]).toBeDefined();
    }
    // 170.5: the Battlefield *is* a Location, so its object sits at its own
    // index rather than in a player zone.
    expect(state.entities[state.battlefields[0]!.entity]!.location).toEqual(
      battlefieldLocation(0),
    );
    checkInvariants(state);
  });

  it('170.6: it is not among the Units present at itself', () => {
    const state = game('bf-not-unit');
    expect(state.battlefields[0]!.units).not.toContain(state.battlefields[0]!.entity);
  });

  it('170.8: its Passive reaches the Units at it', () => {
    let state = game('bf-static');
    const player = state.activePlayer;
    const unit = state.players[player]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === PLAIN.id,
    )!;

    // At a Base, out of the Battlefield's reach.
    state = moveEntity(state, unit, playerLocation(player, 'base'));
    expect(mightOf(state, unit)).toBe(2);

    // 355.9's "here" resolves to the Battlefield's own Location, so the +1
    // applies once the Unit is present.
    state = moveEntity(state, unit, battlefieldLocation(0));
    expect(mightOf(state, unit)).toBe(3);
    checkInvariants(state);
  });

  it('its Passive applies regardless of who Controls it', () => {
    // A Passive is a property of the Location (170.5), not of Control — unlike
    // a Triggered ability, which speaks of holding or conquering.
    let state = game('bf-uncontrolled');
    const player = state.activePlayer;
    const unit = state.players[player]!.zones.mainDeck.find(
      (id) => state.entities[id]!.card === PLAIN.id,
    )!;
    state = moveEntity(state, unit, battlefieldLocation(0));

    expect(state.battlefields[0]!.controller).toBeNull();
    expect(mightOf(state, unit)).toBe(3);
  });

  it('170.4 / 170.3: it is never moved and never killed', () => {
    // Nothing in the engine relocates a Battlefield's object, so it stays at
    // its own index for the whole game.
    let state = game('bf-fixed');
    const entity = state.battlefields[0]!.entity;
    let guard = 0;
    while (!isOver(state) && guard < 200) {
      const actions = legalActions(state, state.priority ?? state.activePlayer);
      const action = actions[0];
      if (action === undefined) {
        break;
      }
      state = reduce(state, action).state;
      guard += 1;
    }
    expect(state.entities[entity]!.location).toEqual(battlefieldLocation(0));
    checkInvariants(state);
  });
});
