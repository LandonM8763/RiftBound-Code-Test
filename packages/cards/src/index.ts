export { DOMAINS, isDomain, withinIdentity } from './domain.js';
export type { Domain, DomainIdentity } from './domain.js';

export { FREE, cost, powerOf, totalRuneCost } from './cost.js';
export type { Cost } from './cost.js';

export { cardId, costOf, effectOf, isChampionUnit, isPlayable, isSignature } from './card.js';

export { activatedAbilities, sameCondition, triggeredAbilities } from './ability.js';
export type {
  AbilityRef,
  ActivatedAbility,
  CardAbilities,
  TriggerCondition,
  TriggeredAbility,
} from './ability.js';

export { layerOf, modifierApplies } from './cost-modifier.js';
export type { CostChange, CostFilter, CostModifier, CostTarget } from './cost-modifier.js';

export { NO_TARGET, needsDestination, needsTarget } from './effect.js';
export type { CardEffect, DestinationSpec, Effect, TargetSpec } from './effect.js';
export type {
  BattlefieldCard,
  CardDefinition,
  CardId,
  CardType,
  GearCard,
  LegendCard,
  PlayableCard,
  RuneCard,
  SpellCard,
  SpellTiming,
  UnitCard,
} from './card.js';

export { CardRegistry } from './registry.js';
