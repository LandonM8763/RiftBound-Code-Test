# Example data

**These are invented cards, not real Riftbound cards.** Names, ids, costs, and
Might values here were made up so the CLI has something to run against before a
card data source is chosen and an ingest exists. Do not treat any of it as
information about the actual game, and do not use it as a seed for real card
data — real data must come from the ingest, as `CLAUDE.md` describes.

`cards.json` is shaped exactly like the card data the CLI expects: a JSON array
of card definitions. `deck.txt` is a legal 40-card best-of-one deck list built
from those cards.

Run them together:

```bash
npm run build
node packages/cli/dist/main.js analyze packages/cli/examples/deck.txt \
  --cards packages/cli/examples/cards.json
```

The CLI test suite reads both files, so if the example ever stops parsing or
stops being legal, CI fails.
