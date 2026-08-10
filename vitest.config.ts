import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const src = (pkg: string, file: string): string =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against TypeScript sources so the suite never depends on a
    // prior build. Longest specifier first — these are matched in order.
    alias: [
      { find: '@riftbound/cards/testing', replacement: src('cards', 'testing.ts') },
      { find: '@riftbound/cards', replacement: src('cards', 'index.ts') },
      { find: '@riftbound/deck', replacement: src('deck', 'index.ts') },
      { find: '@riftbound/engine', replacement: src('engine', 'index.ts') },
      { find: '@riftbound/ai', replacement: src('ai', 'index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // The engine is a pure state machine; tests must never need a DOM or network.
    environment: 'node',
  },
});
