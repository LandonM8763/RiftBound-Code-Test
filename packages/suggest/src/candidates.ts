/**
 * Which edits are worth evaluating.
 *
 * The space of possible edits is far too large to score exhaustively — every
 * card in the pool against every card in the deck — so this proposes a
 * *shortlist* driven by what the deck's own measurements say is wrong. That is
 * also what makes the reasons honest: a candidate exists because a metric
 * pointed at it, so the metric is the reason.
 *
 * Rune edits are ratio changes and main-deck edits are cuts, adds and swaps,
 * which is the four kinds of suggestion the project set out to make.
 */
import { DOMAINS, isPlayable, type CardId, type CardRegistry, type Domain } from '@riftbound/cards';
import { countOf, type Deck } from '@riftbound/deck';
import { analyzeDeck } from '@riftbound/analysis';

import type { DeckEdit } from './suggestion.js';

/** A candidate edit with the observation that produced it. */
export interface Candidate {
  readonly edit: DeckEdit;
  /** What was measured to propose this. Becomes the suggestion's reason. */
  readonly reason: string;
}

export interface CandidateOptions {
  /**
   * Cards the suggester may add. Empty means it can only cut and re-ratio,
   * which is the honest default: proposing a card the owner does not have is
   * not a deck edit, it is shopping.
   */
  readonly pool?: readonly CardId[] | undefined;
  /** Rule 103.2.b: at most 3 copies of a name, the Chosen Champion included. */
  readonly copyLimit?: number | undefined;
}

/**
 * Rune ratio changes: move one Rune from an over-supplied Domain to an
 * under-supplied one.
 *
 * Rule 103.3 fixes the Rune deck at exactly 12, so a Rune edit is always a
 * swap. Adding or cutting one would make the deck illegal, and an edit that
 * cannot be taken is not a suggestion.
 */
function runeRatios(deck: Deck, registry: CardRegistry): Candidate[] {
  const analysis = analyzeDeck(deck, registry);
  const { runeShare, demandShare } = analysis.domains;

  /** Rune cards in the deck, by the Domain they produce. */
  const runeOf = new Map<Domain, CardId>();
  for (const entry of deck.runes) {
    const definition = registry.get(entry.card);
    if (definition?.type === 'rune') {
      runeOf.set(definition.domain, entry.card);
    }
  }

  const surplus: { domain: Domain; gap: number }[] = [];
  const shortfall: { domain: Domain; gap: number }[] = [];
  for (const domain of DOMAINS) {
    const supply = runeShare.get(domain) ?? 0;
    const demand = demandShare.get(domain) ?? 0;
    const gap = supply - demand;
    if (gap > 0.05 && (runeOf.get(domain) ?? null) !== null) {
      surplus.push({ domain, gap });
    } else if (gap < -0.05) {
      shortfall.push({ domain, gap: -gap });
    }
  }

  const candidates: Candidate[] = [];
  for (const over of surplus) {
    for (const under of shortfall) {
      const out = runeOf.get(over.domain);
      const into = runeOf.get(under.domain);
      if (out === undefined || into === undefined || out === into) {
        continue;
      }
      candidates.push({
        edit: { kind: 'swap', list: 'runes', out, in: into, count: 1 },
        reason:
          `${percent(runeShare.get(over.domain) ?? 0)} of your Runes are ${over.domain} ` +
          `but only ${percent(demandShare.get(over.domain) ?? 0)} of your Power demand is, ` +
          `while ${under.domain} demands ${percent(demandShare.get(under.domain) ?? 0)} ` +
          `off ${percent(runeShare.get(under.domain) ?? 0)} of the Runes`,
      });
    }
  }
  return candidates;
}

/**
 * Cuts: the cards the deck is least able to pay for.
 *
 * `powerOnCurve` is the chance a card's Power can be paid by the first turn its
 * cost is affordable at all, so a low value is a card that sits in hand. A cost
 * the Rune deck can never pay (`earliestTurn === null`) is worse still.
 */
function cuts(deck: Deck, registry: CardRegistry): Candidate[] {
  const analysis = analyzeDeck(deck, registry);
  const candidates: Candidate[] = [];

  for (const entry of analysis.castability) {
    if (countOf(deck.main, entry.card) === 0) {
      continue;
    }
    if (entry.earliestTurn === null) {
      candidates.push({
        edit: { kind: 'cut', list: 'main', card: entry.card, count: 1 },
        reason:
          `${entry.name} costs ${entry.runeCost} Runes, which this Rune deck can never supply`,
      });
      continue;
    }
    if (entry.powerOnCurve < 0.75) {
      candidates.push({
        edit: { kind: 'cut', list: 'main', card: entry.card, count: 1 },
        reason:
          `${entry.name} is only ${percent(entry.powerOnCurve)} likely to have its Power ` +
          `available by turn ${entry.earliestTurn}, the first turn its cost is payable`,
      });
    }
  }
  return candidates;
}

/**
 * Additions and swaps from a supplied pool.
 *
 * Restricted to cards already legal for this deck: rule 103.1.b.4 makes a card
 * legal only in an identity containing *all* its Domains, so a card outside the
 * Legend's identity is not an edit this deck can take. Filtering here rather
 * than letting the scorer reject it keeps the shortlist honest.
 */
function fromPool(
  deck: Deck,
  registry: CardRegistry,
  options: CandidateOptions,
): Candidate[] {
  const pool = options.pool ?? [];
  if (pool.length === 0) {
    return [];
  }
  const limit = options.copyLimit ?? 3;
  const legend = registry.get(deck.legend);
  const identity = legend?.type === 'legend' ? new Set<Domain>(legend.domainIdentity) : undefined;

  const analysis = analyzeDeck(deck, registry);
  const weakest = [...analysis.castability]
    .filter((entry) => countOf(deck.main, entry.card) > 0)
    .sort((a, b) => a.powerOnCurve - b.powerOnCurve)[0];

  const candidates: Candidate[] = [];
  for (const card of pool) {
    const definition = registry.get(card);
    if (definition === undefined || !isPlayable(definition)) {
      continue;
    }
    // 103.1.b.4: every Domain on the card must be inside the identity.
    if (identity !== undefined && !definition.domains.every((domain) => identity.has(domain))) {
      continue;
    }
    if (countOf(deck.main, card) >= limit) {
      continue;
    }

    candidates.push({
      edit: { kind: 'add', list: 'main', card, count: 1 },
      reason: `${definition.name} is castable in this identity and the deck has room for it`,
    });

    if (weakest !== undefined && weakest.card !== card) {
      candidates.push({
        edit: { kind: 'swap', list: 'main', out: weakest.card, in: card, count: 1 },
        reason:
          `${weakest.name} is the deck's least castable card at ` +
          `${percent(weakest.powerOnCurve)} on curve; ${definition.name} is a candidate ` +
          `to take its slot`,
      });
    }
  }
  return candidates;
}

/** Every edit worth scoring for this deck. */
export function candidateEdits(
  deck: Deck,
  registry: CardRegistry,
  options: CandidateOptions = {},
): readonly Candidate[] {
  return [...runeRatios(deck, registry), ...cuts(deck, registry), ...fromPool(deck, registry, options)];
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
