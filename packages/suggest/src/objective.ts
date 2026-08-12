/**
 * What a suggestion is trying to improve.
 *
 * This is the open question the project owner has not settled — raw win rate
 * against a fixed AI, a named matchup, or consistency — so it is deliberately
 * *not* decided here. An `Objective` is a function from a deck to a score, and
 * `suggestEdits` ranks candidate edits by how much they move it. Swapping the
 * objective swaps what the suggester is for, without touching the search.
 *
 * The default is `CONSISTENCY`, and the reason is not taste:
 *
 * **A simulated objective is not trustworthy yet.** 400 of the 468 cards in the
 * corpus that have rules text still play as vanilla, so a simulator cannot see
 * what most cards do. Optimizing against it would produce suggestions that are
 * confidently wrong — it would cut the card whose text the engine ignores and
 * keep the vanilla body with better stats. Consistency metrics have no such
 * problem: they depend on cost and Domain, which are exact for all 479 cards.
 *
 * A simulated objective becomes viable as text coverage rises. The seam is
 * here and needs no change to anything else: `sim` already measures win rates,
 * so such an objective is a function that calls it.
 */
import { analyzeDeck, type DeckAnalysis } from '@riftbound/analysis';
import type { CardRegistry } from '@riftbound/cards';
import type { Deck } from '@riftbound/deck';

/** A deck scored on some axis. Higher is better, always. */
export interface Score {
  readonly total: number;
  /**
   * The parts the total is made of, so a suggestion can say *which* axis it
   * improved rather than only that the number went up.
   */
  readonly components: Readonly<Record<string, number>>;
}

export interface Objective {
  readonly id: string;
  readonly describe: string;
  readonly score: (deck: Deck, registry: CardRegistry) => Score;
}

/**
 * How far a curve is from a target shape, as a penalty in [0, 1].
 *
 * Riftbound decks Channel 2 Runes a turn (315.3.b) plus one in the Draw Phase's
 * wake, so the resources available on turn N are roughly 2N. A deck whose mass
 * sits far above that curve spends early turns unable to act. This measures the
 * share of the deck that cannot be paid for by the turn its cost implies, which
 * is a statement about tempo rather than an opinion about the right shape.
 */
function curvePenalty(analysis: DeckAnalysis): number {
  const total = analysis.curve.totalCards;
  if (total === 0) {
    return 0;
  }
  let unreachable = 0;
  for (const entry of analysis.castability) {
    // 315.3.b Channels 2 per turn, so a cost of N is payable around turn N/2.
    // `earliestTurn` is null when the Rune deck can never supply the cost at
    // all, which is the worst case rather than a missing value.
    if (entry.earliestTurn === null) {
      unreachable += entry.copies;
    }
  }
  return unreachable / total;
}

/**
 * How badly Rune supply matches Power demand, as a penalty in [0, 1].
 *
 * Rule 416: Power is Domain-specific and paid by Recycling a Rune of that
 * Domain, so a deck demanding 80% Fury pips off a 50/50 Rune deck will hold
 * uncastable cards. The penalty is the total absolute mismatch between each
 * Domain's share of supply and its share of demand, halved so that a complete
 * mismatch scores 1.
 */
function domainPenalty(analysis: DeckAnalysis): number {
  const { runeShare, demandShare } = analysis.domains;
  if (analysis.domains.totalPips === 0) {
    return 0;
  }
  const domains = new Set([...runeShare.keys(), ...demandShare.keys()]);
  let mismatch = 0;
  for (const domain of domains) {
    mismatch += Math.abs((runeShare.get(domain) ?? 0) - (demandShare.get(domain) ?? 0));
  }
  return Math.min(1, mismatch / 2);
}

/**
 * How often the cards a deck holds cannot be paid for when they come up.
 *
 * `powerOnCurve` is the chance the Runes Channelled by a card's earliest
 * payable turn are the right *Domains*. Averaged over copies, so three copies
 * of an uncastable card count three times.
 */
function castabilityScore(analysis: DeckAnalysis): number {
  let weighted = 0;
  let copies = 0;
  for (const entry of analysis.castability) {
    weighted += entry.powerOnCurve * entry.copies;
    copies += entry.copies;
  }
  return copies === 0 ? 1 : weighted / copies;
}

/**
 * The default objective: how reliably the deck can do what it is built to do.
 *
 * Three components, each in [0, 1] and each independently meaningful:
 *
 * - `castable` — the chance a card's Power can actually be paid on curve.
 * - `domains`  — how well the Rune deck matches what the main deck demands.
 * - `curve`    — the share of the deck that is payable at all.
 *
 * Weights are equal, and that is a guess a better measurement could falsify —
 * the same status as the heuristic agent's weights. They live here, in one
 * place, for the same reason.
 */
export const CONSISTENCY: Objective = {
  id: 'consistency',
  describe:
    'How reliably the deck can pay for what it holds: Power on curve, Rune ' +
    'supply against Domain demand, and the share of the deck that is payable ' +
    'at all. Analytic and exact — no simulation, no sample size.',
  score(deck, registry) {
    const analysis = analyzeDeck(deck, registry);
    const castable = castabilityScore(analysis);
    const domains = 1 - domainPenalty(analysis);
    const curve = 1 - curvePenalty(analysis);
    return {
      total: (castable + domains + curve) / 3,
      components: { castable, domains, curve },
    };
  },
};

export const OBJECTIVES: Readonly<Record<string, Objective>> = Object.freeze({
  [CONSISTENCY.id]: CONSISTENCY,
});
