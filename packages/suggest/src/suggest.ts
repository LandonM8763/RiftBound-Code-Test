/**
 * Proposing deck edits.
 *
 * The loop is deliberately simple and deliberately *measured*: build the deck
 * each candidate edit would produce, score it with the objective, and keep the
 * ones that improve it. No edit is proposed because it looks sensible — it is
 * proposed because the number moved, and the amount it moved is reported.
 *
 * Two properties this buys, both of which matter more than cleverness:
 *
 * - **Every suggestion is falsifiable.** `delta` and `components` say exactly
 *   what improved and by how much, against a stated objective.
 * - **An illegal edit is never proposed.** The candidate deck is validated
 *   before it is scored, so a suggestion that would break rule 103 is dropped
 *   rather than ranked.
 */
import type { CardRegistry } from '@riftbound/cards';
import { validateDeck, type Deck, type Format } from '@riftbound/deck';

import { candidateEdits, type CandidateOptions } from './candidates.js';
import { CONSISTENCY, type Objective, type Score } from './objective.js';
import { applyEdit, type Suggestion } from './suggestion.js';

export interface SuggestOptions extends CandidateOptions {
  /** What to optimize for. Defaults to `CONSISTENCY`; see `objective.ts`. */
  readonly objective?: Objective | undefined;
  /**
   * The format an edited deck must remain legal for.
   *
   * Omitting it skips the legality check, which is only right for a caller that
   * has its own — the engine accepts any deck list, but a *suggestion* that
   * makes a deck unplayable is not a suggestion.
   */
  readonly format?: Format | undefined;
  /** How many suggestions to return. Defaults to 5. */
  readonly limit?: number | undefined;
  /**
   * The smallest improvement worth reporting. Defaults to 0.001.
   *
   * Guards against proposing an edit whose entire effect is floating-point
   * noise, which would read as a real recommendation.
   */
  readonly minimumDelta?: number | undefined;
}

export interface SuggestionReport {
  readonly objective: string;
  /** The deck as it stands, so a caller can show what is being improved on. */
  readonly baseline: Score;
  readonly suggestions: readonly Suggestion[];
  /**
   * Candidates that were evaluated and rejected, and why the deck is already
   * fine on that axis. Reported because "nothing to change here" is a useful
   * answer, and silence does not distinguish it from "nothing was tried".
   */
  readonly considered: number;
}

/**
 * Rank the edits that improve `deck` under `options.objective`.
 *
 * Single-step: each suggestion is measured against the *current* deck, not
 * against a deck with the other suggestions already applied. Two suggestions
 * that individually help may not compose, which is why they are returned as a
 * ranked list to choose from rather than as a patch to apply wholesale.
 */
export function suggestEdits(
  deck: Deck,
  registry: CardRegistry,
  options: SuggestOptions = {},
): SuggestionReport {
  const objective = options.objective ?? CONSISTENCY;
  const limit = options.limit ?? 5;
  const minimumDelta = options.minimumDelta ?? 0.001;

  const baseline = objective.score(deck, registry);
  const candidates = candidateEdits(deck, registry, options);
  const suggestions: Suggestion[] = [];

  for (const candidate of candidates) {
    const edited = applyEdit(deck, candidate.edit);

    // A suggestion that breaks the format is not a suggestion. Checked before
    // scoring, since an illegal deck's metrics are not comparable anyway.
    if (options.format !== undefined) {
      const validation = validateDeck(edited, registry, options.format);
      if (!validation.legal) {
        continue;
      }
    }

    const score = objective.score(edited, registry);
    const delta = score.total - baseline.total;
    if (delta < minimumDelta) {
      continue;
    }

    const components: Record<string, number> = {};
    for (const [key, value] of Object.entries(score.components)) {
      components[key] = value - (baseline.components[key] ?? 0);
    }

    suggestions.push({ edit: candidate.edit, reason: candidate.reason, delta, components });
  }

  // Ties broken by the edit's own description so the order is deterministic:
  // the same deck must always produce the same report.
  suggestions.sort(
    (a, b) => b.delta - a.delta || JSON.stringify(a.edit).localeCompare(JSON.stringify(b.edit)),
  );

  return {
    objective: objective.id,
    baseline,
    suggestions: distinct(suggestions).slice(0, limit),
    considered: candidates.length,
  };
}

/**
 * One suggestion per decision, keeping the best.
 *
 * Twenty ways to replace the same card are not twenty suggestions — the
 * decision is "cut this card", and which card takes the slot is the *answer* to
 * it rather than a separate question. Without this the ranked list fills with
 * variations of one move and crowds out the structurally different ones, which
 * makes a longer report less useful than a shorter one.
 *
 * Keyed on what *leaves* the deck for a cut or swap and what enters for an add.
 * Input is already sorted by delta, so the first of each key is the best.
 */
function distinct(suggestions: readonly Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  const kept: Suggestion[] = [];

  for (const suggestion of suggestions) {
    const edit = suggestion.edit;
    const key =
      edit.kind === 'add'
        ? `add:${edit.list}:${edit.card}`
        : edit.kind === 'cut'
          ? `out:${edit.list}:${edit.card}`
          : `out:${edit.list}:${edit.out}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(suggestion);
  }
  return kept;
}
