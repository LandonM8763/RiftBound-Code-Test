/**
 * Riftbound's six Domains.
 *
 * A Legend's Domain Identity constrains which cards a deck may contain, and
 * Power costs are paid with Runes of a specific Domain.
 */
export const DOMAINS = ['fury', 'calm', 'mind', 'body', 'chaos', 'order'] as const;

export type Domain = (typeof DOMAINS)[number];

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);

export function isDomain(value: string): value is Domain {
  return DOMAIN_SET.has(value);
}

/**
 * The set of Domains a deck may draw its cards from, granted by its Legend.
 *
 * Community sources describe this as two Domains. It is modelled as a list
 * rather than a fixed pair so that a single-Domain or three-Domain Legend in a
 * future set does not require reshaping the type.
 */
export type DomainIdentity = readonly Domain[];

/** True when every Domain in `cardDomains` is covered by `identity`. */
export function withinIdentity(cardDomains: readonly Domain[], identity: DomainIdentity): boolean {
  return cardDomains.every((domain) => identity.includes(domain));
}
