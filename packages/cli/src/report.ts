import { probabilityOfCard, type DeckAnalysis, type DrawModel } from '@riftbound/analysis';
import type { CardId, CardRegistry } from '@riftbound/cards';
import type { Deck, Format, ValidationResult } from '@riftbound/deck';
import { summarizeGaps, type CardSource, type IngestResult } from '@riftbound/ingest';
import { marginOf, type SimulationResult } from '@riftbound/sim';
import { describeEdit, type SuggestionReport } from '@riftbound/suggest';

/**
 * Presentation lives here and nowhere else.
 *
 * The engine and the analysis packages emit structured data with no formatting
 * in it. This is the consumer that turns that into something a person reads,
 * which is exactly the split that lets a UI replace this later without any of
 * the layers below noticing.
 */
export interface ReportInput {
  readonly deck: Deck;
  readonly registry: CardRegistry;
  readonly format: Format;
  readonly validation: ValidationResult;
  readonly analysis: DeckAnalysis;
  readonly model: DrawModel;
  /** Turn used for the "by turn N" draw column. */
  readonly turn: number;
}

const BAR_WIDTH = 24;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function bar(count: number, max: number): string {
  if (max <= 0 || count <= 0) {
    return '';
  }
  return '█'.repeat(Math.max(1, Math.round((count / max) * BAR_WIDTH)));
}

type Align = 'left' | 'right';

function table(headers: readonly string[], rows: readonly (readonly string[])[], align: readonly Align[] = []): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => {
        const width = widths[column] ?? cell.length;
        return (align[column] ?? 'left') === 'right' ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return [line(headers), line(widths.map((width) => '-'.repeat(width))), ...rows.map(line)];
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}

function heading(text: string): string[] {
  return ['', text, '='.repeat(text.length)];
}

function curveSection(title: string, counts: ReadonlyMap<number, number>): string[] {
  if (counts.size === 0) {
    return [];
  }
  const max = Math.max(...counts.values());
  const highest = Math.max(...counts.keys());
  const lines = heading(title);

  for (let cost = 0; cost <= highest; cost += 1) {
    const count = counts.get(cost) ?? 0;
    lines.push(`  ${String(cost).padStart(2)} | ${bar(count, max).padEnd(BAR_WIDTH)} ${count || ''}`.trimEnd());
  }
  return lines;
}

export function formatReport(input: ReportInput): string {
  const { analysis, deck, registry, format, validation, model, turn } = input;
  const legend = registry.get(deck.legend);
  const champion = registry.get(deck.champion);

  const lines: string[] = [];

  lines.push(`Legend:   ${legend?.name ?? deck.legend}`);
  lines.push(`Champion: ${champion?.name ?? deck.champion}`);
  if (legend?.type === 'legend') {
    lines.push(`Domains:  ${legend.domainIdentity.join(', ')}`);
  }
  lines.push(`Format:   ${format.name}`);
  lines.push(`Legality: ${validation.legal ? 'LEGAL' : 'ILLEGAL'}`);
  lines.push(
    `Cards:    ${analysis.mainDeckSize} main · ${analysis.runeDeckSize} Runes · ` +
      `${deck.battlefields.reduce((sum, entry) => sum + entry.count, 0)} Battlefields`,
  );

  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  const warnings = validation.issues.filter((issue) => issue.severity === 'warning');

  if (errors.length > 0) {
    lines.push(...heading('Legality problems'));
    lines.push(...errors.map((issue) => `  [${issue.code}] ${issue.message}`));
  }
  // Warnings are shown even for a legal deck: they say a rule could not be
  // checked, which is exactly what a silent pass would hide.
  if (warnings.length > 0) {
    lines.push(...heading('Warnings'));
    lines.push(...warnings.map((issue) => `  [${issue.code}] ${issue.message}`));
  }

  lines.push(...curveSection('Cost curve (Energy)', analysis.curve.byEnergy));
  lines.push(...curveSection('Cost curve (total Runes: Energy + Power)', analysis.curve.byTotalCost));

  lines.push(...heading('Domains'));
  const domainRows: string[][] = [];
  const domains = new Set([
    ...analysis.domains.runeCounts.keys(),
    ...analysis.domains.powerDemand.keys(),
  ]);
  for (const domain of domains) {
    const runes = analysis.domains.runeCounts.get(domain) ?? 0;
    const demand = analysis.domains.powerDemand.get(domain) ?? 0;
    domainRows.push([
      domain,
      String(runes),
      percent(analysis.domains.runeShare.get(domain) ?? 0),
      String(demand),
      percent(analysis.domains.demandShare.get(domain) ?? 0),
    ]);
  }
  if (domainRows.length === 0) {
    lines.push('  No Runes and no Power costs.');
  } else {
    lines.push(
      ...table(
        ['Domain', 'Runes', 'Supply', 'Pips', 'Demand'],
        domainRows,
        ['left', 'right', 'right', 'right', 'right'],
      ).map((row) => `  ${row}`),
    );
  }

  lines.push(...heading(`Opening hand (${analysis.openingHand.handSize} cards)`));
  const handRows = [...analysis.openingHand.expectedByType].map(([type, expected]) => [
    type,
    expected.toFixed(2),
    percent(analysis.openingHand.atLeastOneByType.get(type) ?? 0),
  ]);
  lines.push(
    ...table(['Type', 'Expected', 'At least one'], handRows, ['left', 'right', 'right']).map(
      (row) => `  ${row}`,
    ),
  );

  lines.push(...heading('Castability'));
  lines.push(
    '  Earliest is the first turn with enough Runes Channelled; Power is the',
    '  chance the Domains cooperate by then. Recycling is not modelled.',
    '',
  );
  const castRows = analysis.castability
    .slice()
    .sort((a, b) => a.runeCost - b.runeCost || a.name.localeCompare(b.name))
    .map((entry) => [
      truncate(entry.name, 24),
      String(entry.copies),
      String(entry.energy),
      String(entry.runeCost),
      entry.earliestTurn === null ? 'never' : String(entry.earliestTurn),
      entry.earliestTurn === null ? '-' : percent(entry.powerOnCurve),
    ]);
  lines.push(
    ...table(
      ['Card', 'Copies', 'Energy', 'Runes', 'Earliest', 'Power'],
      castRows,
      ['left', 'right', 'right', 'right', 'right', 'right'],
    ).map((row) => `  ${row}`),
  );

  lines.push(...heading(`Draw odds (at least one copy)`));
  const seen = new Set<CardId>();
  const drawRows: string[][] = [];
  for (const entry of deck.main) {
    if (seen.has(entry.card)) {
      continue;
    }
    seen.add(entry.card);
    drawRows.push([
      truncate(registry.get(entry.card)?.name ?? entry.card, 24),
      String(entry.count),
      percent(probabilityOfCard({ deck, card: entry.card, turn: 0, model })),
      percent(probabilityOfCard({ deck, card: entry.card, turn, model })),
    ]);
  }
  lines.push(
    ...table(
      ['Card', 'Copies', 'Opening', `By turn ${turn}`],
      drawRows,
      ['left', 'right', 'right', 'right'],
    ).map((row) => `  ${row}`),
  );

  return `${lines.join('\n')}\n`;
}

export function formatValidation(validation: ValidationResult, format: Format): string {
  const errors = validation.issues.filter((issue) => issue.severity === 'error');
  const warnings = validation.issues.filter((issue) => issue.severity === 'warning');

  if (validation.legal && warnings.length === 0) {
    return `LEGAL for ${format.name}\n`;
  }

  const lines = [`${validation.legal ? 'LEGAL' : 'ILLEGAL'} for ${format.name}`, ''];
  lines.push(...errors.map((issue) => `  [${issue.code}] ${issue.message}`));
  if (warnings.length > 0) {
    if (errors.length > 0) {
      lines.push('');
    }
    // A warning means a rule could not be checked, not that the deck is
    // illegal — it is reported so the gap in the card data is visible.
    lines.push('  Warnings:');
    lines.push(...warnings.map((issue) => `  [${issue.code}] ${issue.message}`));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The ingest gap report.
 *
 * Deliberately loud. A card data file that silently covers 30% of the pool
 * looks exactly like one that covers all of it, right up until a deck fails to
 * build for reasons nobody can see — so the shortfall is stated in cards, by
 * field, with the reason attached.
 */
export function formatIngest(result: IngestResult, source: CardSource): string {
  const total = result.cards.length + result.dropped;
  const summary = summarizeGaps(result.gaps);
  const lines = [
    `Ingested ${result.cards.length} of ${total} cards from ${source.id}.`,
  ];

  if (result.problems.length > 0) {
    lines.push('', `Malformed source records (${result.problems.length}):`);
    lines.push(...result.problems.slice(0, 10).map((problem) => `  ${problem}`));
    if (result.problems.length > 10) {
      lines.push(`  ... and ${result.problems.length - 10} more`);
    }
  }

  if (result.dropped > 0) {
    lines.push('', `Dropped ${result.dropped} cards the source cannot describe:`);
    for (const { field, count } of summary.byField) {
      const example = result.gaps.find((gap) => gap.field === field);
      if (example?.severity !== 'blocking') {
        continue;
      }
      lines.push(`  ${field} (${count}) — ${example.reason}`);
    }
  }

  const degraded = summary.byField.filter(({ field }) =>
    result.gaps.some((gap) => gap.field === field && gap.severity === 'degraded'),
  );
  if (degraded.length > 0) {
    lines.push('', 'Kept, but with a rule left unchecked:');
    for (const { field, count } of degraded) {
      const example = result.gaps.find(
        (gap) => gap.field === field && gap.severity === 'degraded',
      );
      lines.push(`  ${field} (${count}) — ${example?.reason ?? ''}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Simulated results.
 *
 * Every rate is printed with its sample size and its interval, never alone:
 * "83%" and "83% ± 2.3 over 1000 games" support very different decisions, and
 * the first one silently invites the wrong one.
 */
export function formatSimulation(
  result: SimulationResult,
  /**
   * What the entrants are, for the first column's heading.
   *
   * A mirror match pits two agents against each other and a matchup pits two
   * decks, and the reader needs to know which they are looking at — the rows
   * are named the same way either way.
   */
  entrantLabel: 'Agent' | 'Deck' = 'Agent',
): string {
  const lines = [
    `${result.games} games — ${result.decided} decided, ${result.draws} drawn`,
    '',
  ];

  const rows = result.entrants.map((entrant) => [
    entrant.name,
    String(entrant.wins),
    percent(entrant.winRate),
    `± ${percent(marginOf(entrant.interval))}`,
    `[${percent(entrant.interval.low)}, ${percent(entrant.interval.high)}]`,
    entrant.points.mean.toFixed(2),
  ]);

  const level = Math.round(confidenceLevel(result) * 100);
  lines.push(
    ...table(
      [entrantLabel, 'Wins', 'Rate', '', `${level}% CI`, 'Avg points'],
      rows,
      ['left', 'right', 'right', 'right', 'right', 'right'],
    ).map((row) => `  ${row}`),
  );

  lines.push('');
  lines.push(
    `  Game length: ${result.turns.mean.toFixed(1)} turns on average ` +
      `(sd ${result.turns.stdev.toFixed(1)}, range ${result.turns.min}-${result.turns.max})`,
  );

  if (result.decided === 0) {
    lines.push('', '  No game was decided, so the rates above carry no information.');
  }

  return `${lines.join('\n')}\n`;
}

function confidenceLevel(result: SimulationResult): number {
  return result.entrants[0]?.interval.level ?? 0.95;
}

function mapToObject<V>(map: ReadonlyMap<string | number, V>): Record<string, V> {
  const result: Record<string, V> = {};
  for (const [key, value] of map) {
    result[String(key)] = value;
  }
  return result;
}

/**
 * JSON-safe view of an analysis.
 *
 * The analysis uses `Map` throughout, and `JSON.stringify` turns a Map into
 * `{}` without complaining — so the conversion has to be explicit or the
 * machine-readable output would silently be empty.
 */
export function analysisToJson(
  analysis: DeckAnalysis,
  validation: ValidationResult,
  format: Format,
): unknown {
  return {
    format: format.name,
    legal: validation.legal,
    issues: validation.issues,
    mainDeckSize: analysis.mainDeckSize,
    runeDeckSize: analysis.runeDeckSize,
    curve: {
      totalCards: analysis.curve.totalCards,
      byEnergy: mapToObject(analysis.curve.byEnergy),
      byTotalCost: mapToObject(analysis.curve.byTotalCost),
      byType: mapToObject(analysis.curve.byType),
      powerPips: mapToObject(analysis.curve.powerPips),
      averageEnergy: analysis.curve.averageEnergy,
      averageTotalCost: analysis.curve.averageTotalCost,
      maxTotalCost: analysis.curve.maxTotalCost,
    },
    domains: {
      totalRunes: analysis.domains.totalRunes,
      totalPips: analysis.domains.totalPips,
      runeCounts: mapToObject(analysis.domains.runeCounts),
      runeShare: mapToObject(analysis.domains.runeShare),
      powerDemand: mapToObject(analysis.domains.powerDemand),
      demandShare: mapToObject(analysis.domains.demandShare),
    },
    castability: analysis.castability,
    openingHand: {
      handSize: analysis.openingHand.handSize,
      expectedByType: mapToObject(analysis.openingHand.expectedByType),
      atLeastOneByType: mapToObject(analysis.openingHand.atLeastOneByType),
    },
  };
}

/**
 * A suggestion report.
 *
 * Every line carries the measurement that produced it, because a deck edit
 * proposed without a reason the reader can check is an opinion rather than a
 * suggestion.
 */
export function formatSuggestions(
  report: SuggestionReport,
  nameOf: (card: CardId) => string,
): string {
  const lines: string[] = [
    'Suggestions',
    '===========',
    `  Objective: ${report.objective}`,
    `  Current:   ${report.baseline.total.toFixed(3)}` +
      `  (${componentLine(report.baseline.components)})`,
    `  Evaluated: ${report.considered} candidate edit${report.considered === 1 ? '' : 's'}`,
    '',
  ];

  if (report.suggestions.length === 0) {
    lines.push(
      report.considered === 0
        ? '  Nothing to suggest: no candidate edit was worth evaluating.'
        : '  Nothing to suggest: no candidate edit improved the objective.',
    );
    return `${lines.join('\n')}\n`;
  }

  for (const suggestion of report.suggestions) {
    lines.push(
      `  ${describeEdit(suggestion.edit, nameOf)}  (+${suggestion.delta.toFixed(3)})`,
      `    ${suggestion.reason}.`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function componentLine(components: Readonly<Record<string, number>>): string {
  return Object.entries(components)
    .map(([key, value]) => `${key} ${value.toFixed(2)}`)
    .join(', ');
}
