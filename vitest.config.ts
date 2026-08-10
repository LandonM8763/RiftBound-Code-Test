import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const packages = fileURLToPath(new URL('./packages', import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve every workspace package to its TypeScript source, so the suite
    // never depends on a prior build. These are patterns rather than a list
    // per package: adding a package needs no edit here, which keeps parallel
    // work on different packages from colliding in this file.
    //
    // Subpath rule first — aliases are matched in order, and the bare-package
    // rule would otherwise swallow `@riftbound/cards/testing`.
    alias: [
      { find: /^@riftbound\/([^/]+)\/(.+)$/, replacement: `${packages}/$1/src/$2.ts` },
      { find: /^@riftbound\/([^/]+)$/, replacement: `${packages}/$1/src/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // The engine is a pure state machine; tests must never need a DOM or network.
    environment: 'node',
  },
});
