import { cardId, type CardId } from '@riftbound/cards';

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
  parse(input: string): ParseResult;
}

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
 * Cards are identified by printed id. Resolving human-readable card names needs
 * card data, and belongs in a separate importer once a data source is pinned.
 */
export function parseDeckText(input: string): ParseResult {
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

    sections[current].push({ card: cardId(cardText), count });
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
  importers: readonly DeckImporter[] = DEFAULT_IMPORTERS,
): ParseResult {
  for (const importer of importers) {
    if (importer.canImport(input)) {
      return importer.parse(input);
    }
  }
  return {
    ok: false,
    errors: [{ line: 0, code: 'unrecognised-format', message: 'No importer recognised this list' }],
  };
}
