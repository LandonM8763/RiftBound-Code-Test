/**
 * Adapter for the API TCG card export.
 *
 * Published as committed JSON per set at
 * `apitcg/riftbound-tcg-data/cards/en/*.json`, derived from the official Riot
 * card gallery. It carries what the community export does not:
 *
 * - **`might`**, so Units can finally be represented at all (465-466).
 * - **`cardType`** that names the supertypes — `Champion Unit`, `Signature
 *   Spell` — so 103.2.a.2 and 103.2.d become checkable.
 * - **`description`** containing the printed ACTION/REACTION marker, which is
 *   where a Spell's timing comes from (358.4).
 *
 * What it still does not carry: Champion Tags as a field, and the Domains that
 * a multi-Domain card's Power pips demand. Both are handled below — the first
 * by a documented inference from the card name, the second not at all.
 */
import {
  cardId,
  isDomain,
  type CardDefinition,
  type CardId,
  type Cost,
  type Domain,
  type SpellTiming,
} from '@riftbound/cards';

import type { Gap } from './gaps.js';
import type { CardSource, IngestResult } from './source.js';
import { authoredFor } from './authored.js';
import { parseCardText } from './text.js';

/** The source's name for "no Domain", which is the absence of one. */
const NO_DOMAIN = 'None';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

/** Strip the source's HTML and collapse the whitespace it leaves behind. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * The printing qualifiers this export appends to a card's name.
 *
 * All four mark a *printing*, not a different card. Note that `(Signature)` is
 * a printing here and has nothing to do with the Signature supertype, which
 * comes from `cardType` — conflating them would mark the wrong cards.
 */
const PRINTING_QUALIFIERS = /\s*\((?:Alternate Art|Overnumbered|Signature|Starter)\)\s*$/i;

/**
 * Rule 103.2.b.2 makes same-named cards the same card, and these suffixes mark
 * alternate printings rather than different cards — so they come off.
 */
export function canonicalName(name: string): string {
  return name.replace(PRINTING_QUALIFIERS, '').trim();
}

/**
 * The Champion Tag, inferred from the card name.
 *
 * This export has no tag field, but it names Legends and Champion Units alike
 * as `"<Champion> - <Epithet>"` — "Kai'Sa - Daughter of the Void" and "Kai'Sa -
 * Survivor" — and rule 133.8.b says the tag is exactly what links those two. So
 * the leading segment is taken as the tag.
 *
 * It is an *inference*, not a published field, and it works only where the
 * naming does: a Signature card is named for its effect ("Icathian Rain"), not
 * its Champion, so those get a recorded gap instead of a guess.
 */
export function championTagFromName(name: string): string | undefined {
  const [head, ...rest] = canonicalName(name).split(' - ');
  return rest.length > 0 && head !== undefined && head.length > 0 ? head : undefined;
}

/**
 * Spell timing from the printed rules text (rule 358.4).
 *
 * The marker is printed on the card and reproduced in `description`; it is not
 * a separate field. A Spell whose text carries neither word is dropped rather
 * than defaulted, because a Reaction recorded as an Action is unplayable at
 * exactly the moment it matters.
 */
export function timingFromText(description: string): SpellTiming | undefined {
  const upper = description.toUpperCase();
  if (/\bREACTION\b/.test(upper)) {
    return 'reaction';
  }
  return /\bACTION\b/.test(upper) ? 'action' : undefined;
}

interface TypeInfo {
  readonly type: CardDefinition['type'];
  readonly champion: boolean;
  readonly signature: boolean;
}

/** `"Champion Unit"`, `"Signature Spell"`, `"Unit;Token"` -> type + supertypes. */
export function parseCardType(raw: string): TypeInfo | undefined {
  const parts = raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const champion = parts.some((part) => /^Champion /i.test(part));
  const signature = parts.some((part) => /^Signature /i.test(part));

  const base = parts
    .map((part) => part.replace(/^(Champion|Signature)\s+/i, '').trim().toLowerCase())
    .find((part) => ['unit', 'spell', 'gear', 'rune', 'legend', 'battlefield'].includes(part));

  return base === undefined
    ? undefined
    : { type: base as CardDefinition['type'], champion, signature };
}

function domainsOf(raw: string): Domain[] | undefined {
  const domains: Domain[] = [];
  for (const part of raw.split(';').map((entry) => entry.trim())) {
    if (part === '' || part === NO_DOMAIN) {
      continue;
    }
    const lower = part.toLowerCase();
    if (!isDomain(lower)) {
      return undefined;
    }
    domains.push(lower);
  }
  return domains;
}

/**
 * Does this card's parsed model narrow anything to a tag (133.8)?
 *
 * A structural walk rather than a list of the places a tag may appear:
 * `StaticScope`, `Condition` and `Count` each carry one, and a fourth will
 * arrive without this needing to know about it. The key name is the contract —
 * every one of them spells it `tag`.
 */
function namesTag(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => namesTag(entry));
  }
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value['tag'] === 'string' && value['tag'] !== '') {
    return true;
  }
  return Object.values(value).some((entry) => namesTag(entry));
}

function normalizeCard(
  raw: unknown,
  index: number,
  problems: string[],
): { card?: CardDefinition; gaps: Gap[] } {
  const gaps: Gap[] = [];

  if (!isRecord(raw)) {
    problems.push(`card ${index}: not an object`);
    return { gaps };
  }

  const rawId = text(raw['id']);
  const rawName = text(raw['name']);
  if (rawId === '' || rawName === '') {
    problems.push(`card ${index}: missing "id" or "name"`);
    return { gaps };
  }

  const id = cardId(rawId) as CardId;
  const name = canonicalName(rawName);
  const rawType = text(raw['cardType']);

  // Sealed products — booster packs, displays, precon decks — share the export
  // with the cards and carry no cardType. They are not cards and are not gaps.
  if (rawType === '') {
    return { gaps };
  }

  const info = parseCardType(rawType);
  if (info === undefined) {
    // A bare Token is created by an effect, never drawn or deckbuilt, so it is
    // no more a deck card than a booster pack is.
    if (/^token$/i.test(rawType.trim())) {
      return { gaps };
    }
    problems.push(`${rawId}: unrecognised cardType "${rawType}"`);
    return { gaps };
  }

  const gap = (field: string, reason: string, severity: Gap['severity']): void => {
    gaps.push({ card: id, name, field, reason, severity });
  };

  const domains = domainsOf(text(raw['domain']));
  if (domains === undefined) {
    problems.push(`${rawId}: unrecognised domain "${text(raw['domain'])}"`);
    return { gaps };
  }

  const description = plainText(text(raw['description']));
  const championTag = championTagFromName(rawName);

  // The printed text becomes the effect model where the grammar covers it.
  // All-or-nothing per card: a partially understood card would play, look
  // right and be wrong, so anything left over leaves the card vanilla and is
  // recorded instead. See `text.ts`.
  // 805.1.a.1 pays Accelerate's Power with the Unit's own Domain, which is not
  // in the printed line — the one fact the grammar cannot read off the text.
  const parsed = parseCardText(description, { domains });
  const parsedWhole = parsed.unparsed.length === 0;

  // A card the grammar cannot read may still have a hand-authored model. The
  // parser is always tried first: an authored entry is the fallback for wording
  // no shared rule covers, never a way to override what the grammar reads.
  const authored = parsedWhole ? undefined : authoredFor(name, description);
  const model = authored?.stale === false ? authored.card : undefined;
  const understood = parsedWhole || model !== undefined;

  const abilities = parsedWhole ? parsed.abilities : model?.abilities;
  const base = {
    id,
    name,
    domains,
    text: description,
    tags: [] as readonly string[],
    signature: info.signature,
    ...(championTag === undefined ? {} : { championTag }),
    ...(abilities === undefined ? {} : { abilities }),
    // Keywords ride on the same all-or-nothing rule as everything else. A card
    // whose other clause is unreadable keeps neither: half a card is the
    // failure mode this design exists to avoid, and Assault without the
    // Deathknell next to it is still the wrong card.
    ...(parsedWhole && parsed.keywords !== undefined ? { keywords: parsed.keywords } : {}),
  };
  const cardEffect = parsedWhole ? parsed.effect : model?.effect;

  if (authored?.stale === true) {
    // The card's text changed since the entry was written, so the authored
    // model may no longer describe it. Refusing is the same discipline the
    // parser follows: a plausible-but-wrong card is worse than a vanilla one.
    gap(
      'text',
      'A hand-authored effect exists for this card but was written against ' +
        'different printed text, so it is refused and the card plays as vanilla',
      'degraded',
    );
  } else if (!understood) {
    gap(
      'text',
      `Rules text not covered by the effect grammar, so the card plays as vanilla: ` +
        parsed.unparsed.map((clause) => `"${clause}"`).join('; '),
      'degraded',
    );
  }

  // 133.8: a card may narrow a scope or a predicate to a tag — "Your Mechs
  // have +1 Might", "I enter ready if you control another Dragon". This export
  // publishes no tag field at all, so every card comes out with an empty tag
  // list and such a clause reaches nothing. The clause is still read, because
  // the model is right and the *data* is what is short: a source that carries
  // tags makes these cards work with no code change. The shortfall is recorded
  // rather than left silent, which is the same treatment `championTag` gets.
  if (understood && (namesTag(abilities) || namesTag(cardEffect))) {
    gap(
      'tags',
      'The export publishes no tag field, so this card\'s tag-scoped clause ' +
        'matches nothing and it plays weaker than printed',
      'degraded',
    );
  }

  // 103.2.d.2 needs every Signature card's tag, and this export names those
  // cards for their effect rather than their Champion, so it cannot be read.
  if (info.signature && championTag === undefined) {
    gap(
      'championTag',
      'The export publishes no tag field, and a Signature card is named for its ' +
        'effect rather than its Champion, so rule 103.2.d.2 cannot be checked',
      'degraded',
    );
  }

  const costOf = (): Cost | undefined => {
    const energy = integer(raw['energyCost']) ?? 0;
    const pips = integer(raw['powerCost']) ?? 0;
    if (pips === 0) {
      return { energy, power: [] };
    }
    const only = domains[0];
    if (domains.length !== 1 || only === undefined) {
      gap(
        'cost.power',
        `Costs ${pips} Power across ${domains.length} Domains; the export publishes a ` +
          'pip count rather than which Domains they demand, so the cost is ambiguous',
        'blocking',
      );
      return undefined;
    }
    return { energy, power: Array.from({ length: pips }, () => only) };
  };

  switch (info.type) {
    case 'legend': {
      if (domains.length === 0) {
        gap('domainIdentity', 'A Legend with no Domains has no Domain Identity', 'blocking');
        return { gaps };
      }
      // 103.1.b.2: the Domain Identity comes from the Champion Legend, and a
      // Legend's printed Domains are that identity.
      return { card: { ...base, type: 'legend', domainIdentity: domains }, gaps };
    }
    case 'unit': {
      const might = integer(raw['might']);
      if (might === undefined) {
        gap('might', 'The export publishes no Might for this Unit (rules 465-466)', 'blocking');
        return { gaps };
      }
      const cost = costOf();
      return cost === undefined
        ? { gaps }
        : {
            card: {
              ...base,
              type: 'unit',
              cost,
              might,
              champion: info.champion,
              ...(cardEffect === undefined ? {} : { effect: cardEffect }),
            },
            gaps,
          };
    }
    case 'spell': {
      const timing = timingFromText(description);
      if (timing === undefined) {
        gap(
          'timing',
          'The printed text carries neither ACTION nor REACTION (358.4); defaulting to ' +
            'Action would make a Reaction unplayable when it matters',
          'blocking',
        );
        return { gaps };
      }
      const cost = costOf();
      return cost === undefined
        ? { gaps }
        : {
            card: {
              ...base,
              type: 'spell',
              cost,
              timing,
              ...(cardEffect === undefined ? {} : { effect: cardEffect }),
            },
            gaps,
          };
    }
    case 'gear': {
      const cost = costOf();
      return cost === undefined
        ? { gaps }
        : {
            card: {
              ...base,
              type: 'gear',
              cost,
              ...(cardEffect === undefined ? {} : { effect: cardEffect }),
              // 136.1's Effect Text and 819.1.b's inherent Reaction. Both ride
              // the all-or-nothing rule with everything else: a Gear whose
              // Equip line reads but whose Effect Text does not keeps neither,
              // because a Gear that Attaches and then lends nothing is a
              // different card from the one printed.
              ...(parsedWhole && parsed.attached !== undefined
                ? { attached: parsed.attached }
                : {}),
              ...(parsedWhole && parsed.reaction === true
                ? { timing: 'reaction' as const }
                : {}),
            },
            gaps,
          };
    }
    case 'rune': {
      const domain = domains[0];
      if (domain === undefined || domains.length !== 1) {
        gap('domain', 'A Rune must have exactly one Domain', 'blocking');
        return { gaps };
      }
      return { card: { ...base, type: 'rune', domain }, gaps };
    }
    case 'battlefield':
      // 170 makes a Battlefield a Game Object with its own entity, so 170.8's
      // Passive, 170.9's Triggered and 170.10's Activated abilities all have
      // something to hang off and are kept. They used to be dropped and
      // recorded, because `BattlefieldState` held only a card id.
      return { card: { ...base, type: 'battlefield' }, gaps };
    default:
      problems.push(`${rawId}: unhandled card type "${info.type}"`);
      return { gaps };
  }
}

export const APITCG_SOURCE: CardSource = {
  id: 'apitcg-json',
  description:
    'API TCG card export (apitcg/riftbound-tcg-data, one committed JSON per set, ' +
    'derived from the official Riot gallery). Carries Might, the Champion and ' +
    'Signature supertypes, and printed Spell timing.',
  normalize(raw: unknown): IngestResult {
    const problems: string[] = [];

    // Each set is published as its own file, so accept either one set's array
    // or several concatenated.
    if (!Array.isArray(raw)) {
      return { cards: [], gaps: [], dropped: 0, problems: ['Expected a JSON array of cards'] };
    }

    const cards: CardDefinition[] = [];
    const gaps: Gap[] = [];
    let dropped = 0;

    raw.forEach((entry, index) => {
      const result = normalizeCard(entry, index, problems);
      // A card that is dropped does not "play as vanilla" — it does not play at
      // all — so its unmodelled-text gap would be noise on top of the reason it
      // was actually dropped.
      gaps.push(
        ...(result.card === undefined
          ? result.gaps.filter((entry_) => entry_.field !== 'text')
          : result.gaps),
      );
      if (result.card === undefined) {
        // Only count it as dropped if something was actually missing; sealed
        // products are simply not cards.
        if (result.gaps.length > 0) {
          dropped += 1;
        }
      } else {
        cards.push(result.card);
      }
    });

    cards.sort((a, b) => a.id.localeCompare(b.id));

    // Variant printings share a collector number in this export, so `id` is not
    // unique across it — "Kai'Sa - Daughter of the Void" and its (Overnumbered)
    // printing are both `origins-299-298`. Rule 103.2.b.2 makes same-named
    // cards the same card anyway, so one printing is kept per name.
    //
    // The id guard is belt and braces: `CardRegistry` throws on a duplicate id
    // and tells the caller to fix the ingest, so generated data must never
    // contain one even if two printings somehow disagree about their name.
    // Sorting first makes which printing survives deterministic.
    const byName = new Map<string, CardDefinition>();
    const usedIds = new Set<string>();
    for (const card of cards) {
      if (byName.has(card.name) || usedIds.has(card.id)) {
        continue;
      }
      byName.set(card.name, card);
      usedIds.add(card.id);
    }

    return { cards: [...byName.values()], gaps, dropped, problems };
  },
};
