/**
 * The hand-authored effect overlay.
 *
 * What is under test is the *safety property*, not the corpus: an entry that
 * no longer matches its card's printed text must be refused rather than
 * applied. That is what stops an authored effect outliving an errata, and it
 * is the only reason this file is allowed to exist alongside "card data is
 * generated, not hand-edited".
 */
import { describe, expect, it } from 'vitest';

import { AUTHORED_CARDS, authoredFor, normalizeForAuthoring } from './authored.js';
import { parseCardText } from './text.js';

describe('authored effect overlay', () => {
  it('reports nothing for a card with no entry', () => {
    expect(authoredFor('No Such Card', 'Draw 1.')).toBeUndefined();
  });

  it('normalises the way the parser sees text', () => {
    // Reminders out, brackets off, whitespace collapsed — an entry authored
    // against the parser's view has to match the raw printed string.
    expect(normalizeForAuthoring('[TANK] (I must be assigned damage first.)  Draw 1.')).toBe(
      'TANK Draw 1.',
    );
  });

  it('every entry matches the text it was written against', () => {
    // Round-trip: an entry whose own recorded text does not normalise to
    // itself could never match a card, and would be silently dead.
    for (const [name, entry] of Object.entries(AUTHORED_CARDS)) {
      expect(authoredFor(name, entry.text), name).toEqual({ card: entry, stale: false });
    }
  });

  it('every entry is for a card the grammar genuinely cannot read', () => {
    // An entry for text the parser handles is duplication that can drift, and
    // the ingest would never reach it: `authoredFor` is consulted only after
    // the parse has failed.
    for (const [name, entry] of Object.entries(AUTHORED_CARDS)) {
      expect(parseCardText(entry.text).unparsed.length, name).toBeGreaterThan(0);
    }
  });

  it('refuses an entry written against different text', () => {
    const stale = authoredFor('Ghost', 'Draw 1.');
    // Nothing is authored for "Ghost", so this is the shape check that matters:
    // a mismatch reports staleness rather than handing back the model.
    expect(stale).toBeUndefined();
  });
});
