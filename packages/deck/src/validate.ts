import {
  withinIdentity,
  type CardDefinition,
  type CardId,
  type CardRegistry,
  type DomainIdentity,
} from '@riftbound/cards';

import { totalCount, uniqueCards, type Deck, type DeckEntry } from './deck.js';
import { DEFAULT_FORMAT, type Format } from './format.js';

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  /** Stable machine-readable code; the message is for humans. */
  readonly code: string;
  readonly severity: Severity;
  readonly message: string;
  /** Cards the issue is about, empty when it concerns the deck as a whole. */
  readonly cards: readonly CardId[];
}

export interface ValidationResult {
  readonly legal: boolean;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Check a deck against a format's construction rules.
 *
 * Reports every problem it finds rather than stopping at the first, so a deck
 * builder can show them all at once.
 */
export function validateDeck(
  deck: Deck,
  registry: CardRegistry,
  format: Format = DEFAULT_FORMAT,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  const error = (code: string, message: string, cards: readonly CardId[] = []): void => {
    issues.push({ code, severity: 'error', message, cards });
  };

  const unknown = uniqueCards(deck).filter((card) => !registry.has(card));
  if (unknown.length > 0) {
    error('unknown-card', `Not present in the card data: ${unknown.join(', ')}`, unknown);
  }

  checkSizes(deck, format, error);
  const identity = checkLegendAndChampion(deck, registry, error);
  checkPileTypes(deck, registry, error);
  checkCopyLimit(deck, format, error);

  if (identity !== undefined) {
    checkDomainIdentity(deck, registry, identity, error);
  }

  return { legal: !issues.some((issue) => issue.severity === 'error'), issues };
}

type Report = (code: string, message: string, cards?: readonly CardId[]) => void;

function checkSizes(deck: Deck, format: Format, error: Report): void {
  const main = totalCount(deck.main);
  if (main !== format.mainDeckSize) {
    error(
      'main-deck-size',
      `Main deck has ${main} cards; ${format.name} requires exactly ${format.mainDeckSize}`,
    );
  }

  const runes = totalCount(deck.runes);
  if (runes !== format.runeDeckSize) {
    error(
      'rune-deck-size',
      `Rune deck has ${runes} cards; ${format.name} requires exactly ${format.runeDeckSize}`,
    );
  }

  const battlefields = totalCount(deck.battlefields);
  if (battlefields !== format.battlefieldCount) {
    error(
      'battlefield-count',
      `Deck has ${battlefields} Battlefields; ${format.name} requires exactly ${format.battlefieldCount}`,
    );
  }

  const sideboard = totalCount(deck.sideboard);
  if (sideboard > 0 && !format.allowSideboard) {
    error('sideboard-not-allowed', `${format.name} does not use a sideboard`);
  } else if (sideboard > 0 && sideboard !== format.sideboardSize) {
    error(
      'sideboard-size',
      `Sideboard has ${sideboard} cards; ${format.name} requires exactly ${format.sideboardSize}`,
    );
  }
}

/** Returns the Legend's Domain Identity when it can be determined. */
function checkLegendAndChampion(
  deck: Deck,
  registry: CardRegistry,
  error: Report,
): DomainIdentity | undefined {
  const legend = registry.get(deck.legend);
  const champion = registry.get(deck.champion);

  if (champion !== undefined && (champion.type !== 'unit' || !champion.champion)) {
    error(
      'champion-not-a-champion',
      `${champion.name} is not a Champion Unit and cannot be the Chosen Champion`,
      [deck.champion],
    );
  }

  if (legend === undefined) {
    return undefined;
  }
  if (legend.type !== 'legend') {
    error('legend-not-a-legend', `${legend.name} is not a Legend`, [deck.legend]);
    return undefined;
  }
  if (legend.domainIdentity.length === 0) {
    error('legend-no-identity', `${legend.name} declares no Domain Identity`, [deck.legend]);
    return undefined;
  }
  return legend.domainIdentity;
}

function checkPileTypes(deck: Deck, registry: CardRegistry, error: Report): void {
  const wrongPile = (
    entries: readonly DeckEntry[],
    pile: string,
    allowed: (card: CardDefinition) => boolean,
  ): void => {
    const offenders = entries
      .map((entry) => registry.get(entry.card))
      .filter((card): card is CardDefinition => card !== undefined && !allowed(card));

    for (const card of offenders) {
      error('wrong-pile', `${card.name} is a ${card.type} and cannot go in the ${pile}`, [card.id]);
    }
  };

  const mainDeckCard = (card: CardDefinition): boolean =>
    card.type === 'unit' || card.type === 'spell' || card.type === 'gear';

  wrongPile(deck.main, 'main deck', mainDeckCard);
  wrongPile(deck.sideboard, 'sideboard', mainDeckCard);
  wrongPile(deck.runes, 'Rune deck', (card) => card.type === 'rune');
  wrongPile(deck.battlefields, 'Battlefield list', (card) => card.type === 'battlefield');
}

/**
 * At most `maxCopies` of any unique card, counting the Chosen Champion.
 *
 * Runes are exempt: a 12-card Rune deck of two Domains necessarily runs far
 * more than three copies of a Rune.
 *
 * UNVERIFIED: whether the sideboard shares the limit with the main deck (as in
 * most trading card games) or is counted separately. Shared is assumed here.
 *
 * UNVERIFIED: whether the three Battlefields must be distinct. Not enforced.
 */
function checkCopyLimit(deck: Deck, format: Format, error: Report): void {
  const copies = new Map<CardId, number>();
  const add = (card: CardId, count: number): void => {
    copies.set(card, (copies.get(card) ?? 0) + count);
  };

  add(deck.champion, 1);
  for (const entry of [...deck.main, ...deck.sideboard]) {
    add(entry.card, entry.count);
  }

  for (const [card, count] of copies) {
    if (count > format.maxCopies) {
      error(
        'copy-limit',
        `${count} copies of ${card}; at most ${format.maxCopies} are allowed` +
          (card === deck.champion ? ' (the Chosen Champion counts as one)' : ''),
        [card],
      );
    }
  }
}

/**
 * Every card must sit inside the Legend's Domain Identity.
 *
 * UNVERIFIED: whether Battlefields are constrained by Domain Identity. They are
 * not checked here.
 */
function checkDomainIdentity(
  deck: Deck,
  registry: CardRegistry,
  identity: DomainIdentity,
  error: Report,
): void {
  const cards = [deck.champion, ...deck.main.map((e) => e.card), ...deck.sideboard.map((e) => e.card)];
  const runes = deck.runes.map((entry) => entry.card);

  for (const card of new Set(cards)) {
    const definition = registry.get(card);
    if (definition === undefined) {
      continue;
    }
    if (!withinIdentity(definition.domains, identity)) {
      error(
        'outside-identity',
        `${definition.name} (${definition.domains.join(', ')}) is outside the Legend's Domain Identity (${identity.join(', ')})`,
        [card],
      );
    }
  }

  for (const card of new Set(runes)) {
    const definition = registry.get(card);
    if (definition === undefined || definition.type !== 'rune') {
      continue;
    }
    if (!identity.includes(definition.domain)) {
      error(
        'rune-outside-identity',
        `${definition.name} is a ${definition.domain} Rune, outside the Legend's Domain Identity (${identity.join(', ')})`,
        [card],
      );
    }
  }
}
