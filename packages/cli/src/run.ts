import { parseArgs } from 'node:util';

import { DEFAULT_DRAW_MODEL, analyzeDeck } from '@riftbound/analysis';
import {
  CONSTRUCTED_BO1,
  CONSTRUCTED_BO3,
  byIdOrName,
  parseDeckList,
  toCardLists,
  validateDeck,
  type Format,
} from '@riftbound/deck';

import { HeuristicAgent, RandomAgent } from '@riftbound/ai';
import { APITCG_SOURCE, COMMUNITY_SOURCE, type CardSource } from '@riftbound/ingest';
import { simulate } from '@riftbound/sim';
import { OBJECTIVES, suggestEdits } from '@riftbound/suggest';

import { CardDataError, loadCardRegistry } from './cards-file.js';
import {
  analysisToJson,
  formatIngest,
  formatReport,
  formatSimulation,
  formatSuggestions,
  formatValidation,
} from './report.js';

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

Getting started:
  riftbound ingest --fetch > cards.json     download the card pool, once
  riftbound analyze mydeck.txt              then work on a deck

Usage:
  riftbound analyze  <deck-file> [--cards <cards.json>] [options]
  riftbound validate <deck-file> [--cards <cards.json>] [options]
  riftbound ingest   [--fetch | <raw-file>...] [--source <name>] [--json]
  riftbound sim      <deck-file> [--cards <cards.json>] [options]
  riftbound suggest  <deck-file> [--cards <cards.json>] [options]
  riftbound help

Options:
  --cards <path>   Card data: a JSON array of card definitions.
                   Default "cards.json" in the working directory.
  --fetch          ingest: download the source's sets instead of reading files.
  --format <name>  bo1 (default) or bo3. Only bo3 permits a sideboard.
  --turn <n>       Turn used for the draw-odds column. Default 3.
  --games <n>      Games to simulate. Default 200.
  --seed <text>    Simulation seed. Default "riftbound".
  --source <name>  Card data source for ingest: apitcg (default) or community.
  --objective <n>  What suggest optimizes for. Default consistency.
  --limit <n>      Suggestions to return. Default 5.
  --pool none      Suggest only cuts and ratio changes, never additions.
  --json           Emit machine-readable JSON instead of a text report.
  -h, --help       Show this help.

ingest normalizes a raw card export into this project's schema and writes it to
stdout. It drops any card whose source is missing a field the rules need rather
than inventing one, and reports every such gap on stderr. The apitcg source
carries Might, the supertypes and printed Spell timing; the community source
carries none of those and yields no Units or Spells at all.

Give ingest several files to take in more than one set at once — the card data
is published one file per set, and a deck is not limited to one set. --fetch
downloads every set the source publishes, which is that same list without the
manual step; it fails rather than ingesting a partial pool if any set is
unreachable.

A deck list names cards by printed name or by collector number, whichever you
have. Names are matched ignoring case and extra spaces.

sim plays the deck against itself, heuristic agent versus random, and reports
win rates with 95% intervals. Seats rotate each game so the result is not
measuring the extra Rune the player going second Channels.

Exit codes:
  0  success
  1  the deck is illegal for the format
  2  bad usage
  3  a file could not be read or parsed

analyze reports analytic statistics: exact, closed-form, and computed without
playing a game. sim reports simulated ones, which need the engine and an agent
and therefore carry a sample size and an interval. The two answer different
questions; neither replaces the other.

suggest proposes deck edits and reports, for each, how far it moved the chosen
objective and the measurement that motivated it. It never proposes an edit that
would make the deck illegal for the format.
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

/** Adapters the CLI can ingest through, by `--source` name. */
/** Where `riftbound ingest` is documented to write, and so where to look. */
const DEFAULT_CARDS = 'cards.json';

export const SOURCES: Readonly<Record<string, CardSource>> = {
  apitcg: APITCG_SOURCE,
  community: COMMUNITY_SOURCE,
};

/**
 * Normalize a raw card export onto stdout, with the gap report on stderr.
 *
 * Split that way on purpose: `riftbound ingest raw.json > cards.json` writes
 * usable card data to the file while the operator still sees, on the terminal,
 * exactly which cards the source could not supply and why.
 */
function runIngest(
  rawPaths: readonly string[],
  readFile: FileReader,
  asJson: boolean,
  source: CardSource,
): CliResult {
  // Several files because the card data is published one file per set, and a
  // deck is not limited to one set. Concatenating before normalizing rather
  // than merging afterwards is what lets 103.2.b.2's same-name-is-the-same-card
  // rule collapse a reprint that appears in two sets.
  const records: unknown[] = [];
  for (const rawPath of rawPaths) {
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
    if (!Array.isArray(raw)) {
      // One file that is not an array is the source's problem to report, and it
      // words the message better than this layer could.
      return normalized(source, raw, asJson);
    }
    records.push(...raw);
  }

  return normalized(source, records, asJson);
}

function normalized(source: CardSource, raw: unknown, asJson: boolean): CliResult {
  const result = source.normalize(raw);
  if (result.problems.length > 0 && result.cards.length === 0) {
    return fail(`Card data is not usable:\n  ${result.problems.join('\n  ')}`, EXIT.input);
  }

  const stdout = asJson
    ? `${JSON.stringify({ source: source.id, cards: result.cards, gaps: result.gaps }, null, 2)}\n`
    : `${JSON.stringify(result.cards, null, 2)}\n`;

  return { stdout, stderr: formatIngest(result, source), code: EXIT.ok };
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
        games: { type: 'string' },
        seed: { type: 'string' },
        source: { type: 'string' },
        objective: { type: 'string' },
        limit: { type: 'string' },
        pool: { type: 'string' },
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
    const rawPaths = positionals.slice(1);
    if (rawPaths.length === 0) {
      return usageError('ingest needs at least one raw card data file.');
    }
    const name = typeof values['source'] === 'string' ? values['source'] : 'apitcg';
    const source = SOURCES[name];
    if (source === undefined) {
      return usageError(
        `Unknown source "${name}". Use one of: ${Object.keys(SOURCES).join(', ')}.`,
      );
    }
    return runIngest(rawPaths, readFile, values['json'] === true, source);
  }
  if (
    command !== 'analyze' &&
    command !== 'validate' &&
    command !== 'sim' &&
    command !== 'suggest'
  ) {
    return usageError(`Unknown command "${command}".`);
  }

  const deckPath = positionals[1];
  if (deckPath === undefined) {
    return usageError(`${command} needs a deck list file.`);
  }

  // `cards.json` in the working directory is where `ingest` is documented to
  // write, so the common flow needs no flag at all. Named explicitly the moment
  // a second pool is in play.
  const cardsOption = values['cards'];
  const cardsPath = typeof cardsOption === 'string' && cardsOption !== '' ? cardsOption : DEFAULT_CARDS;

  const format = resolveFormat(typeof values['format'] === 'string' ? values['format'] : undefined);
  if (format === undefined) {
    return usageError(`Unknown format "${String(values['format'])}". Use bo1 or bo3.`);
  }

  const turnText = typeof values['turn'] === 'string' ? values['turn'] : '3';
  const turn = Number.parseInt(turnText, 10);
  if (!Number.isInteger(turn) || turn < 0) {
    return usageError(`--turn must be a non-negative integer, got "${turnText}".`);
  }

  const gamesText = typeof values['games'] === 'string' ? values['games'] : '200';
  const games = Number.parseInt(gamesText, 10);
  if (!Number.isInteger(games) || games < 1) {
    return usageError(`--games must be a positive integer, got "${gamesText}".`);
  }

  const limitText = typeof values['limit'] === 'string' ? values['limit'] : '5';
  const limit = Number.parseInt(limitText, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    return usageError(`--limit must be a positive integer, got "${limitText}".`);
  }

  const objectiveName = typeof values['objective'] === 'string' ? values['objective'] : undefined;
  const objective = objectiveName === undefined ? undefined : OBJECTIVES[objectiveName];
  if (objectiveName !== undefined && objective === undefined) {
    return usageError(
      `Unknown objective "${objectiveName}". Use one of: ${Object.keys(OBJECTIVES).join(', ')}.`,
    );
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

  // Card data is loaded first so the list may name cards by printed name as
  // well as by id — a deck a person typed uses names, and only the pool can
  // tell one from the other.
  const parsed = parseDeckList(deckText, { resolve: byIdOrName(registry) });
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

  if (command === 'suggest') {
    // The whole card pool is offerable by default. `candidateEdits` filters it
    // down to what this deck could legally take (103.1.b.4, 103.2.b), so the
    // shortlist is still small.
    const pool = values['pool'] === 'none' ? [] : [...registry.all()].map((card) => card.id);
    const report = suggestEdits(deck, registry, {
      format,
      pool,
      limit,
      ...(objective === undefined ? {} : { objective }),
    });
    const stdout = asJson
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatSuggestions(report, (card) => registry.get(card)?.name ?? String(card));
    return { stdout, stderr: '', code: EXIT.ok };
  }

  // Statistics read card definitions, so an unknown card would mean reporting
  // numbers computed from a deck we cannot actually see. Refuse instead.
  if (validation.issues.some((issue) => issue.code === 'unknown-card')) {
    return fail(
      `${formatValidation(validation, format).trimEnd()}\n\nCannot analyse a deck containing unknown cards.`,
      EXIT.illegal,
    );
  }

  if (command === 'sim') {
    // A mirror match: the same deck in both seats, so the difference measured
    // is the agents rather than the decks. Deck-vs-deck needs two lists and is
    // a separate command when there is a reason to want it.
    const lists = toCardLists(deck);
    const result = simulate({
      decks: [lists, lists],
      registry,
      games,
      seed: typeof values['seed'] === 'string' ? values['seed'] : 'riftbound',
      entrants: [
        { name: 'heuristic', create: (agentSeed) => new HeuristicAgent({ seed: agentSeed }) },
        { name: 'random', create: (agentSeed) => new RandomAgent(agentSeed) },
      ],
    });

    return {
      stdout: asJson ? `${JSON.stringify(result, null, 2)}\n` : formatSimulation(result),
      stderr: '',
      code: validation.legal ? EXIT.ok : EXIT.illegal,
    };
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
