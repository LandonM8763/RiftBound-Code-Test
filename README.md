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
| `@riftbound/ai` | Agent interface, random legal agent, single-game runner |

More packages (analysis, suggestions, batch simulation harness) are planned; see
`CLAUDE.md` for the architecture and phasing.

## Contributing notes

`CLAUDE.md` is the guide for both humans and AI assistants working here. It covers
the domain primer, engine design principles, conventions, and the open questions
that still need answering — most importantly that the rules are currently sourced
from community references rather than the official rulebook, and anything marked
UNVERIFIED must be checked before it is relied on.
