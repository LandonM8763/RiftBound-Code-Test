import type { CardAbilities } from './ability.js';
import type { CardDefinition, CardId } from './card.js';
import { cardId } from './card.js';
import { FREE } from './cost.js';
import type { Keyword } from './keyword.js';

/**
 * Tokens (rules 179-187).
 *
 * A Token is a Game Object created by a spell or ability during play (180). It
 * is emphatically **not a card** (185): 185.1.a and 185.1.b make the two
 * categories permanent and disjoint, so nothing may turn one into the other.
 *
 * Rule 187 lists the tokens that exist by name and gives each one's
 * characteristics, which is why `STANDARD_TOKENS` below is a closed table
 * rather than a parser guessing from wording. A card that asks for a token the
 * rulebook does not define is refused at ingest, the same way every other
 * unknown is: inventing a 4-Might token because a card mentions one would put a
 * unit on the board that no rule describes.
 */
export interface TokenSpec {
  /** How rule 187 names it, e.g. `Recruit`. Not a card name (762.2). */
  readonly name: string;
  /**
   * Rule 185.2.d: a Token has a type and follows all rules for it.
   *
   * Battlefield tokens (187.8, 187.9) are deliberately absent — a Battlefield
   * is not a Game Object in this engine, so one could be created and then never
   * consulted for its abilities. See the note on Battlefield abilities in
   * CLAUDE.md; the same reasoning applies.
   */
  readonly type: 'unit' | 'gear';
  /** Rule 185.2.b: Token units have a Might. */
  readonly might?: number | undefined;
  /** Rule 185.2.c: Tokens may have one or more tags. */
  readonly tags: readonly string[];
  readonly keywords?: readonly Keyword[] | undefined;
  readonly abilities?: CardAbilities | undefined;
}

/**
 * Rule 816.1.b, spelled out here rather than imported from the parser.
 *
 * The Sprite token is printed "with Temporary" (187.2), and Temporary is
 * shorthand for a Beginning Phase trigger that kills its source. The parser
 * desugars the printed keyword the same way; this is the same expansion for a
 * token, whose characteristics come from the rulebook rather than from text.
 */
const TEMPORARY: CardAbilities = {
  triggered: [
    {
      condition: { event: 'beginningPhase', subject: 'you' },
      effect: { target: { kind: 'self' }, effects: [{ kind: 'kill' }] },
    },
  ],
};

/**
 * The tokens rule 187 defines, keyed by the name a card prints.
 *
 * Every entry is domainless, because 185.3.b says Tokens have no domains — the
 * rulebook states it for each one individually as well.
 */
export const STANDARD_TOKENS: Readonly<Record<string, TokenSpec>> = {
  // 187.1: a domainless unit token with 1 Might and the Recruit tag.
  recruit: { name: 'Recruit', type: 'unit', might: 1, tags: ['Recruit'] },
  // 187.2: 3 Might, the Fae tag, and the Temporary keyword.
  sprite: { name: 'Sprite', type: 'unit', might: 3, tags: ['Fae'], abilities: TEMPORARY },
  // 187.3: 2 Might and the Shurima tag.
  'sand soldier': { name: 'Sand Soldier', type: 'unit', might: 2, tags: ['Shurima'] },
  // 187.4: 3 Might and the Mech tag.
  mech: { name: 'Mech', type: 'unit', might: 3, tags: ['Mech'] },
  // 187.6: 0 Might, no tags.
  reflection: { name: 'Reflection', type: 'unit', might: 0, tags: [] },
  // 187.10: 1 Might and the Bilgewater tag.
  tentacle: { name: 'Tentacle', type: 'unit', might: 1, tags: ['Bilgewater'] },
};

/** The synthetic `CardId` a token's definition is registered under. */
export function tokenCardId(key: string): CardId {
  return cardId(`token:${key}`);
}

/**
 * The `CardDefinition` an engine entity for this token points at.
 *
 * Tokens are not cards, so this is a representation choice rather than a claim:
 * every read site in the engine — `mightOf`, `keywordsOf`, combat, statics —
 * goes through the definition table, and giving a token a definition is what
 * lets all of them treat it as the Unit it is without a parallel code path.
 * `token: true` is how the places that must tell them apart still can, and
 * `isToken` is the only way they ask.
 *
 * The two fields that are a compromise are called out by 185.3: a Token has no
 * cost and no domain. `FREE` and `[]` are the closest this model can state, and
 * neither is ever read — a token is Created on the Board (186), never played
 * from a hand, so its cost is never paid and its domains never checked against
 * a Domain Identity.
 */
export function tokenDefinition(key: string, spec: TokenSpec): CardDefinition {
  const base = {
    id: tokenCardId(key),
    name: spec.name,
    domains: [],
    text: '',
    tags: spec.tags,
    token: true,
    ...(spec.keywords === undefined ? {} : { keywords: spec.keywords }),
    ...(spec.abilities === undefined ? {} : { abilities: spec.abilities }),
  } as const;

  if (spec.type === 'gear') {
    return { ...base, type: 'gear', cost: FREE };
  }
  return { ...base, type: 'unit', cost: FREE, might: spec.might ?? 0, champion: false };
}

/** Every standard token's definition, keyed by card id. */
export const TOKEN_DEFINITIONS: Readonly<Record<CardId, CardDefinition>> = Object.fromEntries(
  Object.entries(STANDARD_TOKENS).map(([key, spec]) => [tokenCardId(key), tokenDefinition(key, spec)]),
);

/** Rule 185: is this definition a Token rather than a card? */
export function isTokenCard(card: CardDefinition): boolean {
  return card.token === true;
}

/**
 * Look a token up by the name a card prints, e.g. `"Sand Soldier"`.
 *
 * Returns `undefined` for anything rule 187 does not define, which the parser
 * turns into a recorded gap rather than an invented token.
 */
export function tokenByName(name: string): { key: string; spec: TokenSpec } | undefined {
  const key = name.trim().toLowerCase();
  const spec = STANDARD_TOKENS[key];
  return spec === undefined ? undefined : { key, spec };
}

/** A token unit's Might, for the parser to check a printed value against. */
export function tokenMight(spec: TokenSpec): number {
  return spec.might ?? 0;
}
