/**
 * Fixture builders for tests.
 *
 * These are deliberately *not* real Riftbound cards. Real card data is ingested
 * and versioned; these exist so engine tests can construct decks without
 * depending on a card set.
 */
import type {
  BattlefieldCard,
  CardId,
  GearCard,
  LegendCard,
  RuneCard,
  SpellCard,
  UnitCard,
} from './card.js';
import { cardId } from './card.js';
import { FREE, type Cost } from './cost.js';
import type { Domain, DomainIdentity } from './domain.js';

let counter = 0;

/** Fresh, collision-free test card id. */
export function nextCardId(prefix = 'TEST'): CardId {
  counter += 1;
  return cardId(`${prefix}-${counter}`);
}

/** Reset the id counter so a test can assert on exact ids. */
export function resetCardIds(): void {
  counter = 0;
}

export function makeLegend(
  domainIdentity: DomainIdentity,
  overrides: Partial<Omit<LegendCard, 'type' | 'domainIdentity'>> = {},
): LegendCard {
  return {
    id: overrides.id ?? nextCardId('LGD'),
    name: overrides.name ?? 'Test Legend',
    domains: overrides.domains ?? domainIdentity,
    text: overrides.text ?? '',
    tags: overrides.tags ?? [],
    championTag: overrides.championTag,
    signature: overrides.signature,
    abilities: overrides.abilities,
    keywords: overrides.keywords,
    type: 'legend',
    domainIdentity,
  };
}

export function makeUnit(
  might: number,
  domains: readonly Domain[],
  overrides: Partial<Omit<UnitCard, 'type' | 'might' | 'domains'>> = {},
): UnitCard {
  return {
    id: overrides.id ?? nextCardId('UNI'),
    name: overrides.name ?? `Test Unit ${might}`,
    domains,
    text: overrides.text ?? '',
    tags: overrides.tags ?? [],
    championTag: overrides.championTag,
    signature: overrides.signature,
    abilities: overrides.abilities,
    keywords: overrides.keywords,
    type: 'unit',
    cost: overrides.cost ?? ({ energy: might, power: [] } satisfies Cost),
    might,
    champion: overrides.champion ?? false,
    effect: overrides.effect,
  };
}

export function makeSpell(
  domains: readonly Domain[],
  overrides: Partial<Omit<SpellCard, 'type' | 'domains'>> = {},
): SpellCard {
  return {
    id: overrides.id ?? nextCardId('SPL'),
    name: overrides.name ?? 'Test Spell',
    domains,
    text: overrides.text ?? '',
    tags: overrides.tags ?? [],
    championTag: overrides.championTag,
    signature: overrides.signature,
    abilities: overrides.abilities,
    keywords: overrides.keywords,
    type: 'spell',
    cost: overrides.cost ?? FREE,
    timing: overrides.timing ?? 'action',
    effect: overrides.effect,
  };
}

export function makeGear(
  domains: readonly Domain[],
  overrides: Partial<Omit<GearCard, 'type' | 'domains'>> = {},
): GearCard {
  return {
    id: overrides.id ?? nextCardId('GER'),
    name: overrides.name ?? 'Test Gear',
    domains,
    text: overrides.text ?? '',
    tags: overrides.tags ?? [],
    championTag: overrides.championTag,
    signature: overrides.signature,
    abilities: overrides.abilities,
    keywords: overrides.keywords,
    type: 'gear',
    cost: overrides.cost ?? FREE,
    effect: overrides.effect,
    attached: overrides.attached,
    timing: overrides.timing,
  };
}

export function makeRune(
  domain: Domain,
  overrides: Partial<Omit<RuneCard, 'type' | 'domain'>> = {},
): RuneCard {
  return {
    id: overrides.id ?? nextCardId('RUN'),
    name: overrides.name ?? `${domain} Rune`,
    domains: overrides.domains ?? [domain],
    text: overrides.text ?? '',
    tags: overrides.tags ?? [],
    championTag: overrides.championTag,
    signature: overrides.signature,
    abilities: overrides.abilities,
    keywords: overrides.keywords,
    type: 'rune',
    domain,
  };
}

export function makeBattlefield(
  overrides: Partial<Omit<BattlefieldCard, 'type'>> = {},
): BattlefieldCard {
  return {
    id: overrides.id ?? nextCardId('BTL'),
    name: overrides.name ?? 'Test Battlefield',
    domains: overrides.domains ?? [],
    text: overrides.text ?? '',
    tags: overrides.tags ?? [],
    championTag: overrides.championTag,
    signature: overrides.signature,
    abilities: overrides.abilities,
    keywords: overrides.keywords,
    type: 'battlefield',
  };
}
