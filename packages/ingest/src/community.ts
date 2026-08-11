/**
 * Adapter for the community card export.
 *
 * Shape as published: a flat JSON array of cards carrying `id`, `name`,
 * `publicCode`, `set`, `domains`, `rarity`, `cardType`, `cardImage`, `text`,
 * and — for cards that are paid for — `energy` and `power`.
 *
 * What it does NOT carry, and what that costs us:
 *
 * - **`might`** — the single stat a Unit fights with (rules 465-466). Without
 *   it a Unit cannot be represented at all, so Units are dropped.
 * - **`timing`** — whether a Spell is an Action or a Reaction (rule 358.4).
 *   Defaulting it to Action would make every Reaction silently unplayable at
 *   the only moment it matters, so Spells are dropped rather than guessed at.
 * - **tags, the Champion supertype, and the Signature supertype** — so rules
 *   103.2.a.2 and 103.2.d cannot be checked on anything ingested from here.
 *
 * `power` is published as a *count* of pips, not as the Domains those pips
 * demand. For a single-Domain card the attribution is forced and therefore
 * safe. For a multi-Domain card it is genuinely ambiguous — a 2-Domain card
 * costing 2 Power could want one of each or two of one — so those cards are
 * dropped instead of guessed at.
 */
import {
  cardId,
  isDomain,
  type CardDefinition,
  type CardId,
  type Cost,
  type Domain,
} from '@riftbound/cards';

import type { Gap } from './gaps.js';
import type { CardSource, IngestResult } from './source.js';

/** The source's 7th "domain", which is the absence of one rather than a Domain. */
const COLORLESS = 'colorless';

interface RawLabelled {
  readonly id?: unknown;
  readonly label?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `"OGN-007a/298"` -> `"OGN-007a"`, matching this project's card id form. */
function idFromPublicCode(publicCode: string): CardId {
  const slash = publicCode.indexOf('/');
  return cardId(slash === -1 ? publicCode : publicCode.slice(0, slash));
}

/**
 * Rules text as printed, with the source's HTML markup removed.
 *
 * The `:rb_energy_1:` style symbol tokens are left alone: rendering them is a
 * presentation concern, and `text` is explicitly not parsed by anything.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function labelledIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is RawLabelled => isRecord(entry))
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string');
}

/** Per-card normalization. Returns the card, or the gaps that prevented it. */
function normalizeCard(raw: unknown, index: number, problems: string[]): {
  card?: CardDefinition;
  gaps: Gap[];
} {
  const gaps: Gap[] = [];

  if (!isRecord(raw)) {
    problems.push(`card ${index}: not an object`);
    return { gaps };
  }

  const publicCode = raw['publicCode'];
  const name = raw['name'];
  if (typeof publicCode !== 'string' || publicCode === '') {
    problems.push(`card ${index}: missing "publicCode"`);
    return { gaps };
  }
  if (typeof name !== 'string' || name === '') {
    problems.push(`card ${index} (${publicCode}): missing "name"`);
    return { gaps };
  }

  const id = idFromPublicCode(publicCode);
  const types = labelledIds(raw['cardType']);
  const type = types[0];
  if (type === undefined) {
    problems.push(`${publicCode}: no "cardType"`);
    return { gaps };
  }

  const gap = (field: string, reason: string, severity: Gap['severity']): void => {
    gaps.push({ card: id, name, field, reason, severity });
  };

  const rawDomains = labelledIds(raw['domains']);
  const domains: Domain[] = [];
  for (const domain of rawDomains) {
    if (domain === COLORLESS) {
      continue;
    }
    if (!isDomain(domain)) {
      problems.push(`${publicCode}: "${domain}" is not a Domain`);
      return { gaps };
    }
    domains.push(domain);
  }

  const text = typeof raw['text'] === 'string' ? stripHtml(raw['text']) : '';
  // The source carries no tags at all, so the two supertypes that drive deck
  // construction are unknowable from it. Recorded per card that could carry
  // one, so the summary shows the true scale of the gap.
  const base = { id, name, domains, text, tags: [] as readonly string[] };

  const costOf = (): Cost | undefined => {
    const energy = raw['energy'];
    const power = raw['power'];

    if (energy !== undefined && (typeof energy !== 'number' || !Number.isInteger(energy))) {
      problems.push(`${publicCode}: "energy" is not an integer`);
      return undefined;
    }
    if (power !== undefined && (typeof power !== 'number' || !Number.isInteger(power))) {
      problems.push(`${publicCode}: "power" is not an integer`);
      return undefined;
    }

    if (energy === undefined) {
      gap('cost.energy', 'The source publishes no Energy cost for this card', 'blocking');
      return undefined;
    }

    const pips = typeof power === 'number' ? power : 0;
    if (pips === 0) {
      return { energy, power: [] };
    }

    // Power is a pip *count*; the Domains it demands have to come from the
    // card's own Domains, which is only forced when there is exactly one.
    const only = domains[0];
    if (domains.length !== 1 || only === undefined) {
      gap(
        'cost.power',
        `Costs ${pips} Power but has ${domains.length} Domains; the source publishes a pip ` +
          'count rather than which Domains they demand, so the cost is ambiguous',
        'blocking',
      );
      return undefined;
    }
    return { energy, power: Array.from({ length: pips }, () => only) };
  };

  switch (type) {
    case 'legend': {
      // Rule 103.1.b.2 takes the Domain Identity from the Champion Legend, and
      // a Legend's printed Domains are that identity — an inference, but a
      // forced one rather than a guess.
      if (domains.length === 0) {
        gap('domainIdentity', 'A Legend with no printed Domains has no Domain Identity', 'blocking');
        return { gaps };
      }
      gap('championTag', 'The source publishes no tags, so rule 103.2.a.2 cannot be checked', 'degraded');
      return { card: { ...base, type: 'legend', domainIdentity: domains }, gaps };
    }
    case 'unit': {
      gap(
        'might',
        'The source publishes no Might. Might is both the damage a Unit deals and the ' +
          'damage it survives (rules 465-466), so the Unit cannot be represented',
        'blocking',
      );
      return { gaps };
    }
    case 'spell': {
      gap(
        'timing',
        'The source does not say whether this is an Action or a Reaction (rule 358.4); ' +
          'defaulting to Action would make a Reaction unplayable when it matters',
        'blocking',
      );
      return { gaps };
    }
    case 'gear': {
      const cost = costOf();
      return cost === undefined ? { gaps } : { card: { ...base, type: 'gear', cost }, gaps };
    }
    case 'rune': {
      const domain = domains[0];
      if (domain === undefined || domains.length !== 1) {
        gap('domain', 'A Rune must have exactly one Domain', 'blocking');
        return { gaps };
      }
      return { card: { ...base, type: 'rune', domain }, gaps };
    }
    case 'battlefield': {
      return { card: { ...base, type: 'battlefield' }, gaps };
    }
    default:
      problems.push(`${publicCode}: unknown card type "${type}"`);
      return { gaps };
  }
}

export const COMMUNITY_SOURCE: CardSource = {
  id: 'community-json',
  description:
    'Community card export (flat JSON array; no Might, tags, or supertypes). ' +
    'Mirrored on raw.githubusercontent.com, which is the only card host this ' +
    'environment can reach.',
  normalize(raw: unknown): IngestResult {
    const problems: string[] = [];

    if (!Array.isArray(raw)) {
      return { cards: [], gaps: [], dropped: 0, problems: ['Expected a JSON array of cards'] };
    }

    const cards: CardDefinition[] = [];
    const gaps: Gap[] = [];
    let dropped = 0;

    raw.forEach((entry, index) => {
      const result = normalizeCard(entry, index, problems);
      gaps.push(...result.gaps);
      if (result.card === undefined) {
        dropped += 1;
      } else {
        cards.push(result.card);
      }
    });

    // Sorted so regenerating against an unchanged source produces no diff.
    cards.sort((a, b) => a.id.localeCompare(b.id));

    return { cards, gaps, dropped, problems };
  },
};
