#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { fetchSets } from './fetch.js';
import { EXIT, SOURCES, run, type FileReader } from './run.js';

/**
 * `ingest --fetch`: download the source's sets and ingest them.
 *
 * Handled here rather than in `run` because `run` is synchronous and pure, and
 * keeping it that way is what lets the command surface be tested with neither a
 * network nor a filesystem. The download is served back through the same
 * `FileReader` a real file goes through, so `run` cannot tell the difference.
 *
 * The flag is stripped and the downloaded sets are appended as positionals, so
 * from here down this is an ordinary multi-file ingest.
 */
async function withFetchedSets(
  argv: readonly string[],
): Promise<{ args: string[]; readFile: FileReader }> {
  const onDisk: FileReader = (path) => readFileSync(path, 'utf8');
  if (argv[0] !== 'ingest' || !argv.includes('--fetch')) {
    return { args: [...argv], readFile: onDisk };
  }

  const named = argv.indexOf('--source');
  const source = SOURCES[named >= 0 ? (argv[named + 1] ?? '') : 'apitcg'];
  if (source === undefined) {
    // Let `run` report the unknown source, with the names it accepts.
    return { args: argv.filter((arg) => arg !== '--fetch'), readFile: onDisk };
  }

  const sets = await fetchSets(source);
  return {
    args: [...argv.filter((arg) => arg !== '--fetch'), ...sets.keys()],
    readFile: (path) => sets.get(path) ?? onDisk(path),
  };
}

async function main(): Promise<number> {
  let args: string[];
  let readFile: FileReader;
  try {
    ({ args, readFile } = await withFetchedSets(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.input;
  }

  const result = run(args, readFile);
  if (result.stdout !== '') {
    process.stdout.write(result.stdout);
  }
  if (result.stderr !== '') {
    process.stderr.write(result.stderr);
  }
  return result.code;
}

process.exitCode = await main();
