import {
  isChampionUnit,
  isSignature,
  withinIdentity,
  type CardDefinition,
  type CardId,
  type CardRegistry,
  type DomainIdentity,
  type LegendCard,
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
  const warn = (code: string, message: string, cards: readonly CardId[] = []): void => {
    issues.push({ code, severity: 'warning', message, cards });
  };

  const unknown = uniqueCards(deck).filter((card) => !registry.has(card));
  if (unknown.length > 0) {
    error('unknown-card', `Not present in the card data: ${unknown.join(', ')}`, unknown);
  }

  checkSizes(deck, format, error);
  const legend = checkLegendAndChampion(deck, registry, error);
  checkChampionTag(deck, registry, legend, error, warn);
  checkSignatures(deck, registry, legend, format, error, warn);
  checkPileTypes(deck, registry, error);
  checkCopyLimit(deck, format, error);
  checkDistinctBattlefields(deck, registry, error);

  if (legend !== undefined) {
    checkDomainIdentity(deck, registry, legend.domainIdentity, error);
  }

  return { legal: !issues.some((issue) => issue.severity === 'error'), issues };
}

type Report = (code: string, message: string, cards?: readonly CardId[]) => void;

function checkSizes(deck: Deck, format: Format, error: Report): void {
  // Rule 103.2: "A Main Deck of at least 40 cards" — a floor, not an exact size.
  const main = totalCount(deck.main);
  if (main < format.mainDeckMinimum) {
    error(
      'main-deck-size',
      `Main deck has ${main} cards; ${format.name} requires at least ${format.mainDeckMinimum}`,
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

/** Returns the Champion Legend when the deck has a usable one. */
function checkLegendAndChampion(
  deck: Deck,
  registry: CardRegistry,
  error: Report,
): LegendCard | undefined {
  const legend = registry.get(deck.legend);
  const champion = registry.get(deck.champion);

  if (champion !== undefined && !isChampionUnit(champion)) {
    error(
      'champion-not-a-champion',
      `${champion.name} is not a Champion Unit and cannot be the Chosen Champion`,
      [deck.champion],
    );
  }

  // Rule 103.2.d.3: a Signature card is never a Champion Unit, so it can never
  // occupy the Champion Zone — the rulebook's own Tibbers/Annie example.
  if (champion !== undefined && isSignature(champion)) {
    error(
      'champion-is-signature',
      `${champion.name} is a Signature card; Signature cards are not Champion Units ` +
        'and cannot be the Chosen Champion',
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
  return legend;
}

/**
 * Rule 103.2.a.2: the Chosen Champion must be a Champion Unit whose Champion
 * Tag matches the tag on the Champion Legend.
 *
 * The rule is only checkable when both cards carry a `championTag`. Card data
 * that omits it gets a warning rather than an error: a missing field is a gap
 * in the data, not an illegal deck, and failing every deck built from tagless
 * data would make the validator useless against the sample set. The warning is
 * there so the gap is visible instead of silently passing.
 */
function checkChampionTag(
  deck: Deck,
  registry: CardRegistry,
  legend: LegendCard | undefined,
  error: Report,
  warn: Report,
): void {
  const champion = registry.get(deck.champion);
  if (legend === undefined || champion === undefined || !isChampionUnit(champion)) {
    return;
  }

  const legendTag = legend.championTag;
  const championTag = champion.championTag;

  if (legendTag === undefined || championTag === undefined) {
    const missing = legendTag === undefined ? legend : champion;
    warn(
      'champion-tag-unknown',
      `${missing.name} carries no Champion Tag, so rule 103.2.a.2 could not be checked`,
      [missing.id],
    );
    return;
  }

  if (legendTag !== championTag) {
    error(
      'champion-tag-mismatch',
      `${champion.name} has the Champion Tag "${championTag}" but ${legend.name} has ` +
        `"${legendTag}"; a Chosen Champion must match its Legend`,
      [deck.champion, deck.legend],
    );
  }
}

/**
 * Rule 103.2.d: Signature cards.
 *
 * 103.2.d.1 caps them at 3 in total "regardless of name" — a sum across the
 * deck, not a per-name limit, which is why this is counted separately from the
 * 3-copy rule. 103.2.d.2 requires every one of them to carry the Legend's
 * Champion Tag.
 *
 * Counted over the same population as the copy limit (Chosen Champion, main
 * deck, sideboard) so the two rules never disagree about what "your deck"
 * means. A Signature Chosen Champion is already an error from 103.2.d.3.
 */
function checkSignatures(
  deck: Deck,
  registry: CardRegistry,
  legend: LegendCard | undefined,
  format: Format,
  error: Report,
  warn: Report,
): void {
  const entries = [{ card: deck.champion, count: 1 }, ...deck.main, ...deck.sideboard];
  const signatures: { card: CardDefinition; count: number }[] = [];

  for (const entry of entries) {
    const card = registry.get(entry.card);
    if (card !== undefined && isSignature(card)) {
      signatures.push({ card, count: entry.count });
    }
  }

  if (signatures.length === 0) {
    return;
  }

  const total = signatures.reduce((sum, entry) => sum + entry.count, 0);
  if (total > format.maxSignatureCards) {
    error(
      'signature-limit',
      `Deck contains ${total} Signature cards; at most ${format.maxSignatureCards} are allowed ` +
        'in total, regardless of name',
      signatures.map((entry) => entry.card.id),
    );
  }

  // Rule 103.2.d.3: the Champion supertype and the Signature supertype are
  // mutually exclusive, so a card claiming both is contradictory card data.
  for (const { card } of signatures) {
    if (isChampionUnit(card)) {
      error(
        'signature-champion-unit',
        `${card.name} is marked as both a Signature card and a Champion Unit; ` +
          'rule 103.2.d.3 makes those mutually exclusive',
        [card.id],
      );
    }
  }

  if (legend === undefined) {
    return;
  }

  const legendTag = legend.championTag;
  if (legendTag === undefined) {
    warn(
      'signature-tag-unknown',
      `${legend.name} carries no Champion Tag, so rule 103.2.d.2 could not be checked`,
      [legend.id],
    );
    return;
  }

  for (const { card } of signatures) {
    if (card.championTag === undefined) {
      warn(
        'signature-tag-unknown',
        `${card.name} carries no Champion Tag, so rule 103.2.d.2 could not be checked`,
        [card.id],
      );
    } else if (card.championTag !== legendTag) {
      error(
        'signature-tag-mismatch',
        `${card.name} has the Champion Tag "${card.championTag}" but ${legend.name} has ` +
          `"${legendTag}"; every Signature card must match the Legend`,
        [card.id, legend.id],
      );
    }
  }
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
 * Rule 103.2.b: at most 3 copies of the same named card in the Main Deck,
 * counting the Chosen Champion (103.2.b.1).
 *
 * Runes are exempt: rule 103.3 sets no copy limit on the Rune Deck, and a
 * 12-card Rune Deck across two Domains necessarily runs more than three of one.
 *
 * The sideboard is not in the Core Rules at all, so whether it shares this
 * limit is unknown. Shared is assumed, matching the convention elsewhere.
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
 * Rule 103.4.c: a deck cannot include more than one Battlefield of the same
 * name when it is required to bring more than one.
 *
 * Checked by name rather than by card id, because two printings of the same
 * Battlefield share a name and are the same card for this rule.
 */
function checkDistinctBattlefields(deck: Deck, registry: CardRegistry, error: Report): void {
  const seen = new Map<string, CardId>();

  for (const entry of deck.battlefields) {
    if (entry.count > 1) {
      error(
        'duplicate-battlefield',
        `${registry.get(entry.card)?.name ?? entry.card} appears ${entry.count} times; ` +
          'a deck may include only one Battlefield of a given name',
        [entry.card],
      );
      continue;
    }
    const name = registry.get(entry.card)?.name;
    if (name === undefined) {
      continue;
    }
    const existing = seen.get(name);
    if (existing !== undefined) {
      error(
        'duplicate-battlefield',
        `Two Battlefields named "${name}"; a deck may include only one of a given name`,
        [existing, entry.card],
      );
      continue;
    }
    seen.set(name, entry.card);
  }
}

/**
 * Rule 103.1.b.1: cards in the deck must abide by the Domain Identity, which
 * 103.1.b.2 takes from the Champion Legend.
 *
 * Rule 103.4.b makes Battlefields "subject to Domain Identity if applicable".
 * The qualifier is not defined anywhere in the Core Rules, so Battlefields are
 * left unchecked rather than guessed at.
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
