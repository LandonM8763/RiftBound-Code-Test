import type { Domain } from './domain.js';

/**
 * The two-part cost of a card.
 *
 * Riftbound separates its resources, and a card may demand both:
 *
 * - **Energy** is generic and is paid by *exhausting* Runes (turning them
 *   sideways). Modelled as a count.
 * - **Power** is Domain-specific and is paid by *recycling* Runes (putting them
 *   on the bottom of the Rune deck). Modelled as a list of Domains, so a cost
 *   of two Fury Power is `['fury', 'fury']`.
 *
 * Keeping these separate is what lets deck analysis notice that a deck is on
 * curve for Energy while still unable to pay Power of the right Domain.
 */
export interface Cost {
  readonly energy: number;
  readonly power: readonly Domain[];
  /**
   * `[A]`: Power pips payable by Power of **any** Domain (rule 135.2.e.5.a).
   *
   * A count rather than more entries in `power`, because the Domain is not
   * merely unknown — there is none to record. 809.1.c.1 says the Power paying a
   * Deflect cost "may always be of any Domain", and 821 discounts an Equip cost
   * by one of these; neither names a Domain and neither is Energy, which is
   * paid by exhausting rather than recycling (414 against 416).
   *
   * Optional so that every cost written before this existed still reads, and
   * absent means zero.
   */
  readonly anyPower?: number | undefined;
}

export const FREE: Cost = { energy: 0, power: [] };

export function cost(energy: number, ...power: Domain[]): Cost {
  return { energy, power };
}

/** How many `[A]` pips a cost demands (135.2.e.5). */
export function anyPowerOf(value: Cost): number {
  return value.anyPower ?? 0;
}

/** Total number of Runes a cost consumes, exhausted and recycled together. */
export function totalRuneCost(value: Cost): number {
  return value.energy + value.power.length + anyPowerOf(value);
}

/** How many Power pips of a given Domain a cost demands. */
export function powerOf(value: Cost, domain: Domain): number {
  return value.power.reduce((count, entry) => (entry === domain ? count + 1 : count), 0);
}
