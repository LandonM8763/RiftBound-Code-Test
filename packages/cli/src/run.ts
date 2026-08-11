import { parseArgs } from 'node:util';

import { DEFAULT_DRAW_MODEL, analyzeDeck } from '@riftbound/analysis';
import {
  CONSTRUCTED_BO1,
  CONSTRUCTED_BO3,
  parseDeckList,
  validateDeck,
  type Format,
} from '@riftbound/deck';

import { COMMUNITY_SOURCE } from '@riftbound/ingest';

import { CardDataError, loadCardRegistry } from './cards-file.js';
import { analysisToJson, formatIngest, formatReport, formatValidation } from './report.js';

export type FileReader = (path: string) => string;

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Exit codes, chosen so a script can tell the cases apart:
 * 0 success, 1 the deck is illegal, 2 bad usage, 3 could not read the input.
 */
export const EXIT = { ok: 0, illegal: 1, usage: 2, input: 3 } as const;

export const USAGE = `riftbound — deck testing tools

Usage:
  riftbound analyze  <deck-file> --cards <cards.json> [options]
  riftbound validate <deck-file> --cards <cards.json> [options]
  riftbound ingest   <raw-file> [--json]
  riftbound help

Options:
  --cards <path>   Card data: a JSON array of card definitions. Required.
  --format <name>  bo1 (default) or bo3. Only bo3 permits a sideboard.
  --turn <n>       Turn used for the draw-odds column. Default 3.
  --json           Emit machine-readable JSON instead of a text report.
  -h, --help       Show this help.

ingest normalizes a raw community card export into this project's schema and
writes it to stdout. It drops any card whose source is missing a field the
rules need rather than inventing one, and reports every such gap on stderr.

Exit codes:
  0  success
  1  the deck is illegal for the format
  2  bad usage
  3  a file could not be read or parsed

Statistics are analytic: exact, closed-form, and computed without simulating
a game. Win rates need the engine, an agent, and rules that are not settled
yet, so they are deliberately absent.
`;

function fail(message: string, code: number): CliResult {
  return { stdout: '', stderr: `${message}\n`, code };
}

function usageError(message: string): CliResult {
  return { stdout: '', stderr: `${message}\n\n${USAGE}`, code: EXIT.usage };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveFormat(name: string | undefined): Format | undefined {
  switch (name ?? 'bo1') {
    case 'bo1':
      return CONSTRUCTED_BO1;
    case 'bo3':
      return CONSTRUCTED_BO3;
    default:
      return undefined;
  }
}

/**
 * Normalize a raw card export onto stdout, with the gap report on stderr.
 *
 * Split that way on purpose: `riftbound ingest raw.json > cards.json` writes
 * usable card data to the file while the operator still sees, on the terminal,
 * exactly which cards the source could not supply and why.
 */
function runIngest(rawPath: string, readFile: FileReader, asJson: boolean): CliResult {
  let text: string;
  try {
    text = readFile(rawPath);
  } catch (error) {
    return fail(`Cannot read card data "${rawPath}": ${messageOf(error)}`, EXIT.input);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return fail(`"${rawPath}" is not valid JSON: ${messageOf(error)}`, EXIT.input);
  }

  const result = COMMUNITY_SOURCE.normalize(raw);
  if (result.problems.length > 0 && result.cards.length === 0) {
    return fail(`Card data is not usable:\n  ${result.problems.join('\n  ')}`, EXIT.input);
  }

  const stdout = asJson
    ? `${JSON.stringify({ source: COMMUNITY_SOURCE.id, cards: result.cards, gaps: result.gaps }, null, 2)}\n`
    : `${JSON.stringify(result.cards, null, 2)}\n`;

  return { stdout, stderr: formatIngest(result, COMMUNITY_SOURCE), code: EXIT.ok };
}

export function run(argv: readonly string[], readFile: FileReader): CliResult {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        cards: { type: 'string' },
        format: { type: 'string' },
        turn: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    return usageError(messageOf(error));
  }

  const command = positionals[0];

  if (values['help'] === true || command === 'help') {
    return { stdout: USAGE, stderr: '', code: EXIT.ok };
  }
  if (command === undefined) {
    return usageError('No command given.');
  }
  if (command === 'ingest') {
    const rawPath = positionals[1];
    if (rawPath === undefined) {
      return usageError('ingest needs a raw card data file.');
    }
    return runIngest(rawPath, readFile, values['json'] === true);
  }
  if (command !== 'analyze' && command !== 'validate') {
    return usageError(`Unknown command "${command}".`);
  }

  const deckPath = positionals[1];
  if (deckPath === undefined) {
    return usageError(`${command} needs a deck list file.`);
  }

  const cardsPath = values['cards'];
  if (typeof cardsPath !== 'string' || cardsPath === '') {
    return usageError('--cards is required: card data is needed to read a deck list.');
  }

  const format = resolveFormat(typeof values['format'] === 'string' ? values['format'] : undefined);
  if (format === undefined) {
    return usageError(`Unknown format "${String(values['format'])}". Use bo1 or bo3.`);
  }

  const turnText = typeof values['turn'] === 'string' ? values['turn'] : '3';
  const turn = Number.parseInt(turnText, 10);
  if (!Number.isInteger(turn) || turn < 0) {
    return usageError(`--turn must be a non-negative integer, got "${turnText}".`);
  }

  const asJson = values['json'] === true;

  let deckText: string;
  let cardsText: string;
  try {
    deckText = readFile(deckPath);
  } catch (error) {
    return fail(`Cannot read deck list "${deckPath}": ${messageOf(error)}`, EXIT.input);
  }
  try {
    cardsText = readFile(cardsPath);
  } catch (error) {
    return fail(`Cannot read card data "${cardsPath}": ${messageOf(error)}`, EXIT.input);
  }

  let registry;
  try {
    registry = loadCardRegistry(cardsText);
  } catch (error) {
    if (error instanceof CardDataError) {
      return fail(error.message, EXIT.input);
    }
    return fail(`Cannot load card data "${cardsPath}": ${messageOf(error)}`, EXIT.input);
  }

  const parsed = parseDeckList(deckText);
  if (!parsed.ok) {
    const detail = parsed.errors
      .map((issue) => (issue.line > 0 ? `  line ${issue.line}: ${issue.message}` : `  ${issue.message}`))
      .join('\n');
    return fail(`Cannot read deck list "${deckPath}":\n${detail}`, EXIT.input);
  }

  const deck = parsed.deck;
  const validation = validateDeck(deck, registry, format);

  if (command === 'validate') {
    const stdout = asJson
      ? `${JSON.stringify({ legal: validation.legal, format: format.name, issues: validation.issues }, null, 2)}\n`
      : formatValidation(validation, format);
    return { stdout, stderr: '', code: validation.legal ? EXIT.ok : EXIT.illegal };
  }

  // Statistics read card definitions, so an unknown card would mean reporting
  // numbers computed from a deck we cannot actually see. Refuse instead.
  if (validation.issues.some((issue) => issue.code === 'unknown-card')) {
    return fail(
      `${formatValidation(validation, format).trimEnd()}\n\nCannot analyse a deck containing unknown cards.`,
      EXIT.illegal,
    );
  }

  const analysis = analyzeDeck(deck, registry, DEFAULT_DRAW_MODEL);
  const stdout = asJson
    ? `${JSON.stringify(analysisToJson(analysis, validation, format), null, 2)}\n`
    : formatReport({
        deck,
        registry,
        format,
        validation,
        analysis,
        model: DEFAULT_DRAW_MODEL,
        turn,
      });

  return { stdout, stderr: '', code: validation.legal ? EXIT.ok : EXIT.illegal };
}
