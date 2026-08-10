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
}

export const FREE: Cost = { energy: 0, power: [] };

export function cost(energy: number, ...power: Domain[]): Cost {
  return { energy, power };
}

/** Total number of Runes a cost consumes, exhausted and recycled together. */
export function totalRuneCost(value: Cost): number {
  return value.energy + value.power.length;
}

/** How many Power pips of a given Domain a cost demands. */
export function powerOf(value: Cost, domain: Domain): number {
  return value.power.reduce((count, entry) => (entry === domain ? count + 1 : count), 0);
}
