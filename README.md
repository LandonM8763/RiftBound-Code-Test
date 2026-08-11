# Riftbound deck testing

A deck testing application for [Riftbound](https://playriftbound.com), Riot Games'
League of Legends trading card game: import a deck list, get statistics on how it
should perform, receive suggested edits, and simulate games against an AI opponent.

**Status: early. The rules engine is under construction and there is no UI yet.**

## Getting started

```bash
npm install
npm test          # run the suite
npm run typecheck # typecheck packages and tests
npm run build     # emit dist/ for each package
```

Requires Node 22 or newer.

## Packages

| Package | What it does |
|---|---|
| `@riftbound/cards` | Card definition schema, Domains, the Energy/Power cost model, card registry |
| `@riftbound/deck` | Deck model, deck list parsing, format legality validation |
| `@riftbound/engine` | Rules engine: seeded RNG, game state, turn phases, legal action generation, observable views |
| `@riftbound/ai` | Agent interface, random and heuristic agents, single-game runner |
| `@riftbound/analysis` | Cost curve, draw probabilities, Domain/Power consistency, castability |
| `@riftbound/sim` | Batch simulation: win rates with Wilson intervals, game length, points |
| `@riftbound/ingest` | Card data source adapters: normalize a raw export, report what it is missing |
| `@riftbound/cli` | `riftbound analyze` / `validate` / `sim` / `ingest` |

A suggestions package is still planned; see `CLAUDE.md` for the architecture and
phasing.

## Try it

```bash
npm run build
node packages/cli/dist/main.js analyze packages/cli/examples/deck.txt \
  --cards packages/cli/examples/cards.json
```

The example cards are invented placeholders, not real Riftbound cards — see
`packages/cli/examples/README.md`.

## Contributing notes

`CLAUDE.md` is the guide for both humans and AI assistants working here. It covers
the domain primer, engine design principles, conventions, and the open questions
that still need answering — most importantly that the rules are currently sourced
from community references rather than the official rulebook, and anything marked
UNVERIFIED must be checked before it is relied on.
