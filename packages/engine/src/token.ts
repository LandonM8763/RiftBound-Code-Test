/**
 * Tokens (rules 179-187).
 *
 * A Token is a Game Object, not a card (185), and this module holds the two
 * places that distinction is load-bearing at runtime: Creating one, and 186.1's
 * rule that one leaving the Board stops existing rather than reaching a
 * Non-Board Zone.
 *
 * Everything else about a token is deliberately *not* here. A token unit has a
 * Might, keywords, abilities and a controller, so combat, statics and the
 * trigger sweep all read it through the same definition table as a card and
 * need no special case. The data lives in `@riftbound/cards/token.ts`.
 */
import { TOKEN_DEFINITIONS, isTokenCard, tokenCardId } from '@riftbound/cards';

import type { GameEvent } from './events.js';
import { attachmentsOf, detach } from './attach.js';
import { moveEntity, type DeckEnd } from './mutate.js';
import {
  entityCard,
  entityId,
  getEntity,
  playerLocation,
  type EntityId,
  type GameState,
  type Location,
  type PlayerId,
} from './state.js';

/** Rule 185: is this Game Object a Token rather than a card? */
export function isToken(state: GameState, id: EntityId): boolean {
  return isTokenCard(entityCard(state, id));
}

/**
 * Send a Game Object to a Non-Board Zone.
 *
 * A card goes where it was headed. A Token goes to Banishment instead, because
 * 186.1 has it cease to exist the moment it would occupy any Non-Board Zone but
 * the Chain — so it never reaches a trash to be counted, recycled or revived.
 *
 * Every site that moves something off the Board funnels through here for that
 * reason: a token killed in Combat, a token killed by a Kill Instruction and a
 * token leaving the Chain must all stop existing, and those are three unrelated
 * pieces of code that would otherwise each need to remember.
 */
export function sendToNonBoardZone(
  state: GameState,
  id: EntityId,
  to: Location,
  end: DeckEnd = 'bottom',
): GameState {
  // 719.5: when a Top-Most Card leaves the Board, everything Attached to it
  // goes too — an Equipment cannot stay behind on an empty Battlefield.
  let next = state;
  for (const attached of attachmentsOf(state, id)) {
    next = detach(next, attached);
    next = sendToNonBoardZone(next, attached, to, end);
  }
  // 435.1: leaving the Board also ends this card's own Attached state.
  next = detach(next, id);

  if (!isToken(next, id)) {
    return moveEntity(next, id, to, end);
  }
  return moveEntity(next, id, playerLocation(getEntity(next, id).owner, 'banishment'));
}

/**
 * Create `count` Tokens of one kind at `where` (rules 180-184).
 *
 * 182 and 183 make the creating effect's controller both the controller and the
 * owner of what it creates, which is why only one player id is taken.
 *
 * 184.1 lets the effect say a token enters ready; without that it enters
 * exhausted, the same as any Unit reaching the Board (359.2.c). The default is
 * therefore exhausted rather than ready — an inverted default here would hand
 * every token an extra Standard Move on the turn it arrives.
 */
export function createTokens(
  state: GameState,
  controller: PlayerId,
  key: string,
  count: number,
  where: Location,
  ready: boolean,
  events: GameEvent[],
): { readonly state: GameState; readonly created: readonly EntityId[] } {
  const card = tokenCardId(key);
  if (TOKEN_DEFINITIONS[card] === undefined) {
    // Rule 187 defines the tokens that exist; ingest refuses any other name, so
    // reaching here means a card definition was built by hand and is wrong.
    throw new Error(`Unknown token: ${key}`);
  }

  let next = state;
  const created: EntityId[] = [];

  for (let i = 0; i < Math.max(0, count); i += 1) {
    const id = entityId(next.nextEntityId);
    next = {
      ...next,
      nextEntityId: next.nextEntityId + 1,
      entities: {
        ...next.entities,
        [id]: {
          id,
          card,
          owner: controller,
          controller,
          // Placed at the Base first and moved, so that the zone list and
          // `entity.location` are only ever written by `moveEntity`.
          location: playerLocation(controller, 'base'),
          exhausted: !ready,
          damage: 0,
          mightBonus: 0,
          grantedKeywords: [],
          buffs: 0,
        },
      },
    };
    next = moveEntity(next, id, where);
    created.push(id);
  }

  if (created.length > 0) {
    events.push({ type: 'tokensCreated', player: controller, token: key, entities: created });
  }
  return { state: next, created };
}
