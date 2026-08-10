#!/usr/bin/env node
import { readFileSync } from 'node:fs';

import { run } from './run.js';

const result = run(process.argv.slice(2), (path) => readFileSync(path, 'utf8'));

if (result.stdout !== '') {
  process.stdout.write(result.stdout);
}
if (result.stderr !== '') {
  process.stderr.write(result.stderr);
}

process.exitCode = result.code;
