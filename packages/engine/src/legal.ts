import type { Action } from './actions.js';
import { effectOf, needsTargetChoice, type CardEffect, type TargetSpec } from '@riftbound/cards';

import { abilityFor, activatableAbilities } from './abilities.js';
import { legalDestinations, legalTargets } from './effects.js';
import { standardMoves } from './move.js';
import { affordable, playableFromHand, validUnitLocations } from './play.js';
import type { EntityId, GameState, Location, PlayerId } from './state.js';
import { entityCard, getPlayer, isClosed, isOver, isShowdown } from './state.js';

/**
 * Every action `player` may legally take right now.
 *
 * First-class on purpose: agents and the eventual UI both drive the game by
 * enumerating this and choosing from it, so neither has to guess-and-check.
 * An action returned here is guaranteed to be accepted by `reduce`.
 */
export function legalActions(state: GameState, player: PlayerId): readonly Action[] {
  if (isOver(state)) {
    return [];
  }

  // Rule 117: during setup the only choice is which cards to set aside.
  if (state.phase === 'mulligan') {
    return player === state.priority ? mulliganChoices(state, player) : [];
  }

  // Outside the Main Phase nothing has Priority and the phase simply resolves.
  if (state.priority === null) {
    return player === state.activePlayer ? [{ type: 'resolvePhase' }] : [];
  }

  if (player !== state.priority) {
    return [];
  }

  const closed = isClosed(state);
  const showdown = isShowdown(state);
  const actions: Action[] = [];

  // Rule 402, step 2: a pending Ability blocks everything else until its
  // controller makes the choices it needs — the "you may" of 402.1 and the
  // targets of 402.2. Both ride on one action, because the rulebook puts them
  // in one step.
  const top = state.chain[state.chain.length - 1];
  if (top !== undefined && top.pending && top.controller === player) {
    // Only an Ability is ever pending: 359 finalizes a card atomically, so a
    // Chain item with no `ability` cannot be waiting at step 2.
    const ability = top.ability === null ? undefined : abilityFor(state, top.entity, top.ability);
    if (ability === undefined) {
      return [];
    }
    const spec = ability.effect.target;
    const targets = needsTargetChoice(spec) ? legalTargets(state, player, spec) : [undefined];
    const pendingActions: Action[] = [];
    for (const target of targets) {
      for (const destination of choicesOfDestination(state, player, ability.effect)) {
        pendingActions.push({
          type: 'resolveTrigger',
          perform: true,
          ...(target === undefined ? {} : { target }),
          ...(destination === undefined ? {} : { destination }),
        });
      }
    }
    // 402.4.b: declining is offered only for a genuine "you may". A mandatory
    // ability pauses here to choose, and its controller may not refuse.
    if ('optional' in ability && ability.optional === true) {
      pendingActions.push({ type: 'resolveTrigger', perform: false });
    }
    return pendingActions;
  }

  // 377: Activated Abilities. One action per legal target, for the same reason
  // cards get one — 355.8 needs a valid choice before it can go on the Chain.
  for (const { source, index, from, ability } of activatableAbilities(state, player)) {
    const spec = ability.effect.target;
    // `self` needs no choice, so it enumerates as a single action with no
    // target — the effect resolves "me" to the ability's source itself.
    const targets = needsTargetChoice(spec) ? legalTargets(state, player, spec) : [undefined];
    for (const target of targets) {
      for (const destination of choicesOfDestination(state, player, ability.effect)) {
        actions.push({
          type: 'activateAbility',
          source,
          index,
          ...(from === undefined ? {} : { from }),
          ...(target === undefined ? {} : { target }),
          ...(destination === undefined ? {} : { destination }),
        });
      }
    }
  }

  // Rule 164.2: a Basic Rune's two Add abilities are Reactions, so they are
  // available whenever their controller has Priority, Chain or no Chain.
  for (const rune of getPlayer(state, player).zones.runes) {
    const entity = state.entities[rune];
    if (entity === undefined) {
      continue;
    }
    if (!entity.exhausted) {
      actions.push({ type: 'addEnergy', rune });
    }
    if (entityCard(state, rune).type === 'rune') {
      actions.push({ type: 'addPower', rune });
    }
  }

  // Rule 358.4: timing permissions. `playableFromHand` filters to cards this
  // player can both legally play now and afford.
  for (const { entity, check } of playableFromHand(state, player, { closed, showdown })) {
    // A targeting card needs a valid choice before it can be played at all
    // (rule 355.8), so one action is offered per legal target.
    const effect = effectOf(check.card);
    const targets = needsTargetChoice(effect?.target)
      ? legalTargets(state, player, effect?.target as TargetSpec)
      : [undefined];

    for (const target of targets) {
      // 809.1.c: a Deflect makes this card cost more to point at *that* Unit
      // and nothing extra to point elsewhere, so affordability is re-asked per
      // target rather than answered once for the card.
      if (affordable(state, player, check.card, check.payAdditional, target) === undefined) {
        continue;
      }
      // A `move` effect needs its Destination chosen now too (449.1), so the
      // offer is the product of the two choices — the same treatment targets
      // already get, for the same rule 355.8 reason.
      for (const destination of choicesOfDestination(state, player, effect)) {
        const choices = {
          ...(target === undefined ? {} : { target }),
          ...(destination === undefined ? {} : { destination }),
          // 356.2.b.1: the declaration rides on the action, because it is made
          // at step 2 and decides the Total Cost at step 3.
          ...(check.payAdditional ? { payAdditional: true } : {}),
        };
        if (check.card.type === 'unit') {
          for (const location of validUnitLocations(state, player, check.card)) {
            actions.push({ type: 'playCard', card: entity.id, location, ...choices });
          }
        } else {
          actions.push({ type: 'playCard', card: entity.id, ...choices });
        }
      }
    }
  }

  // Rule 144.3 permits moving several Units at once, but enumerating every
  // subset is exponential. Single-Unit moves are offered here; the action
  // itself takes a list, so a heuristic or search agent can build a multi-Unit
  // move directly when it wants one.
  for (const { unit, destinations } of standardMoves(state, player)) {
    for (const to of destinations) {
      actions.push({ type: 'moveUnits', units: [unit], to });
    }
  }

  if (closed || showdown) {
    // Rule 312.2.d with a Chain; rule 347.2 during a Showdown. Passing is
    // always available and is how both eventually resolve.
    actions.push({ type: 'pass' });
  } else if (player === state.activePlayer && state.phase === 'main') {
    actions.push({ type: 'endTurn' });
  }

  return actions;
}

/**
 * Destinations to enumerate for a card, or `[undefined]` when it moves nothing.
 *
 * A card that needs a Destination but has none available offers no actions at
 * all, which is rule 355.8 again: without a legal choice it cannot be played.
 */
function choicesOfDestination(
  state: GameState,
  player: PlayerId,
  effect: CardEffect | undefined,
): (Location | undefined)[] {
  const spec = effect?.destination;
  return spec === undefined ? [undefined] : legalDestinations(state, player, spec);
}

/**
 * Every subset of the hand a player may set aside, up to the Mulligan limit
 * (rule 117.1). Keeping none is always an option.
 */
function mulliganChoices(state: GameState, player: PlayerId): Action[] {
  const hand = getPlayer(state, player).zones.hand;
  const limit = Math.min(state.config.mulliganLimit, hand.length);
  const choices: Action[] = [{ type: 'mulligan', cards: [] }];

  const build = (start: number, chosen: EntityId[]): void => {
    if (chosen.length >= limit) {
      return;
    }
    for (let i = start; i < hand.length; i += 1) {
      const next = [...chosen, hand[i] as EntityId];
      choices.push({ type: 'mulligan', cards: next });
      build(i + 1, next);
    }
  };
  build(0, []);

  return choices;
}

/** Convenience wrapper for the player who may act right now. */
export function currentLegalActions(state: GameState): readonly Action[] {
  return legalActions(state, state.priority ?? state.activePlayer);
}
