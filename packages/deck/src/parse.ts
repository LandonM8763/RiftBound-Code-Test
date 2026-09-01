import { cardId, type CardId, type CardRegistry } from '@riftbound/cards';

import { mergeEntries, type Deck, type DeckEntry } from './deck.js';

export interface ParseIssue {
  /** 1-based line number, or 0 when the problem is with the list as a whole. */
  readonly line: number;
  readonly code: string;
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly deck: Deck }
  | { readonly ok: false; readonly errors: readonly ParseIssue[] };

/**
 * One way of reading a deck list.
 *
 * The deck list input format is still an open question, so importers are
 * pluggable: a Piltover Archive URL importer, or a name-based importer once
 * card data exists, slots in beside the plain-text one without changing callers.
 */
export interface DeckImporter {
  readonly name: string;
  /** Cheap check for whether this importer recognises the input at all. */
  canImport(input: string): boolean;
  parse(input: string, resolve?: CardResolver): ParseResult;
}

/**
 * Turn one card token from a deck list into a `CardId`.
 *
 * A list written by a person names cards by printed *name*; one exported by a
 * tool names them by printed id. Only card data can tell the two apart, so an
 * importer is handed the lookup rather than owning one — which is also what
 * keeps this package free of a dependency on any particular card pool.
 *
 * `undefined` means the token names no card the pool knows. The importer then
 * keeps it as a literal id, so an unreadable token is reported by validation
 * the ordinary way instead of the parser growing a second error path that says
 * the same thing.
 */
export type CardResolver = (token: string) => CardId | undefined;

type Section = 'legend' | 'champion' | 'main' | 'runes' | 'battlefields' | 'sideboard';

const SECTION_ALIASES = new Map<string, Section>([
  ['legend', 'legend'],
  ['legends', 'legend'],
  ['champion', 'champion'],
  ['champions', 'champion'],
  ['chosen champion', 'champion'],
  ['main', 'main'],
  ['main deck', 'main'],
  ['maindeck', 'main'],
  ['deck', 'main'],
  ['rune', 'runes'],
  ['runes', 'runes'],
  ['rune deck', 'runes'],
  ['runedeck', 'runes'],
  ['battlefield', 'battlefields'],
  ['battlefields', 'battlefields'],
  ['sideboard', 'sideboard'],
  ['side', 'sideboard'],
  ['side board', 'sideboard'],
]);

/** `3 OGN-100`, `3x OGN-100`, or a bare `OGN-100`. */
const COUNTED_LINE = /^(\d+)\s*[xX]?\s+(.+)$/;

function lookupSection(text: string): Section | undefined {
  const key = text
    .trim()
    .replace(/[:：]+$/, '')
    .trim()
    .toLowerCase();
  return SECTION_ALIASES.get(key);
}

/**
 * Read the plain-text deck list format.
 *
 * Sections are named by a header line; card lines are `<count> <card id>` with
 * the count optional. `//` starts a comment, and a `#` line that is not a
 * recognised header is treated as one too. Blank lines are ignored.
 *
 * ```
 * # Legend
 * 1 OGN-001
 *
 * # Main
 * 3 OGN-100
 * OGN-101
 * ```
 *
 * Cards are named by printed id, or by printed name when a `resolve` is given
 * — see `CardResolver`. The format is the same either way, which is why this
 * is one importer taking a lookup rather than two importers.
 */
export function parseDeckText(input: string, resolve?: CardResolver): ParseResult {
  const errors: ParseIssue[] = [];
  const sections: Record<Section, DeckEntry[]> = {
    legend: [],
    champion: [],
    main: [],
    runes: [],
    battlefields: [],
    sideboard: [],
  };

  let current: Section | undefined;
  const lines = input.split(/\r?\n/);

  lines.forEach((raw, index) => {
    const lineNumber = index + 1;
    let line = raw.trim();
    if (line === '') {
      return;
    }

    const comment = line.indexOf('//');
    if (comment >= 0) {
      line = line.slice(0, comment).trim();
      if (line === '') {
        return;
      }
    }

    if (line.startsWith('#')) {
      const header = line.replace(/^#+/, '').trim();
      const section = lookupSection(header);
      if (section !== undefined) {
        current = section;
      }
      // A `#` line that names no section is just a comment.
      return;
    }

    const asHeader = lookupSection(line);
    if (asHeader !== undefined) {
      current = asHeader;
      return;
    }

    if (current === undefined) {
      errors.push({
        line: lineNumber,
        code: 'card-before-section',
        message: `"${line}" appears before any section header`,
      });
      return;
    }

    const match = COUNTED_LINE.exec(line);
    const countText = match?.[1];
    const cardText = (match?.[2] ?? line).trim();

    let count = 1;
    if (countText !== undefined) {
      count = Number.parseInt(countText, 10);
      if (!Number.isFinite(count) || count < 1) {
        errors.push({
          line: lineNumber,
          code: 'invalid-count',
          message: `"${countText}" is not a positive copy count`,
        });
        return;
      }
    }

    if (cardText === '') {
      errors.push({
        line: lineNumber,
        code: 'missing-card',
        message: 'Card id is missing',
      });
      return;
    }

    sections[current].push({ card: resolve?.(cardText) ?? cardId(cardText), count });
  });

  const legend = singleCard(sections.legend, 'legend', errors);
  const champion = singleCard(sections.champion, 'champion', errors);

  if (errors.length > 0 || legend === undefined || champion === undefined) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    deck: {
      legend,
      champion,
      main: mergeEntries(sections.main),
      runes: mergeEntries(sections.runes),
      battlefields: mergeEntries(sections.battlefields),
      sideboard: mergeEntries(sections.sideboard),
    },
  };
}

function singleCard(
  entries: readonly DeckEntry[],
  section: 'legend' | 'champion',
  errors: ParseIssue[],
): CardId | undefined {
  const merged = mergeEntries(entries);
  const first = merged[0];

  if (first === undefined) {
    errors.push({
      line: 0,
      code: `missing-${section}`,
      message: `The deck list has no ${section}`,
    });
    return undefined;
  }
  if (merged.length > 1 || first.count !== 1) {
    errors.push({
      line: 0,
      code: `multiple-${section}s`,
      message: `A deck has exactly one ${section}`,
    });
    return undefined;
  }
  return first.card;
}

/**
 * Resolve a token as a printed id first, then as a printed name.
 *
 * Id first because a list exported by a tool uses ids and they are exact; the
 * name pass is the fallback for a list a person typed. The order only matters
 * for a card literally named after an id, which no printing is.
 *
 * A token that is neither is left alone, so `validateDeck` reports it as the
 * unknown card it is.
 */
export function byIdOrName(registry: CardRegistry): CardResolver {
  return (token) => {
    const id = cardId(token);
    return registry.has(id) ? id : registry.byName(token)?.id;
  };
}

/** The plain-text importer. Accepts any non-empty input, so it reads as the fallback. */
export const textImporter: DeckImporter = {
  name: 'text',
  canImport: (input) => input.trim() !== '',
  parse: parseDeckText,
};

export const DEFAULT_IMPORTERS: readonly DeckImporter[] = [textImporter];

/** Parse with the first importer that recognises the input. */
export function parseDeckList(
  input: string,
  options: {
    readonly importers?: readonly DeckImporter[] | undefined;
    /** How a card token becomes an id — see `CardResolver`. */
    readonly resolve?: CardResolver | undefined;
  } = {},
): ParseResult {
  const importers = options.importers ?? DEFAULT_IMPORTERS;
  for (const importer of importers) {
    if (importer.canImport(input)) {
      return importer.parse(input, options.resolve);
    }
  }
  return {
    ok: false,
    errors: [{ line: 0, code: 'unrecognised-format', message: 'No importer recognised this list' }],
  };
}
