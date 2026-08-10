# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

## What we are building

A **deck testing application for Riftbound** (Riot Games' League of Legends trading
card game). The application has four capabilities:

1. **Deck list ingest** — accept a full deck list (Legend, Champion, 40-card main
   deck, 12-card rune deck, 3 battlefields, optional 8-card sideboard), parse it,
   and validate it for format legality.
2. **Deck suggestions** — propose edits to a deck: cuts, additions, ratio changes,
   and consistency fixes, with a stated reason for each suggestion.
3. **Performance statistics** — quantify how a deck is expected to perform: cost
   curve, domain/rune consistency, opening-hand quality, probability of hitting
   key cards by a given turn, and simulated win rates.
4. **Game simulation** — play out full games against an AI opponent, both
   interactively (one game, inspectable) and in batch (thousands of games for
   statistics).

## Current status

**Greenfield. No application code exists yet.** The repository contains only this
file. Nothing below describes code that has been written — it describes the plan
and the conventions to build against. Keep this section honest: update it as real
code lands, and delete it once the structure below actually exists.

## Scope and phasing

**Build the engine and logic first. The UI comes later.** This is an explicit
decision from the project owner, and it shapes everything:

- **Phase 1 (current): rules engine.** A complete, deterministic Riftbound game
  engine with no interface beyond a programmatic API.
- **Phase 2: deck model and analysis.** Deck parsing, validation, and the
  statistics that can be computed without simulation (curve, draw probabilities).
- **Phase 3: AI opponents.** Agents that can legally and competently play a full
  game, used both as a sparring partner and as the substrate for win-rate stats.
- **Phase 4: suggestions.** Deck edit recommendations, informed by phases 2–3.
- **Phase 5: UI.** Not now. Do not add UI frameworks, components, styling, or
  rendering concerns to the codebase during phases 1–4.

The practical rule: **if a change only makes sense once there is a UI, it is out of
scope.** Keep the engine free of presentation concerns so the eventual UI is a pure
consumer of it.

## Domain primer: how Riftbound works

This section exists so an assistant can reason about the code without reading a
rulebook first. It is a summary, not a specification.

> **⚠️ Accuracy warning — read before encoding any of this.**
> The official rules site (`playriftbound.com`) is blocked by this environment's
> network egress proxy, so the rules below were assembled from **community
> sources** (see [Reference sources](#reference-sources)) and cross-checked
> between them. They are directionally right but **not authoritative**. Before
> implementing any rule, verify it against the official comprehensive rulebook and
> cite the rule number in the test. Do not treat this section as a spec, and do not
> let an AI assistant's training recollection of Riftbound override the official
> document.

### Win condition

Score **8 points** to win. Points come from controlling and holding battlefields.
The final point cannot be scored by any means — it must come from *holding* a
battlefield or from conquering both battlefields in the same turn; otherwise the
player draws a card instead of winning. **Verify this edge case carefully**, it is
exactly the kind of rule that a naive engine gets wrong.

### Deck construction

| Component | Requirement |
|---|---|
| Legend | 1, occupies the Legend Zone all game, never leaves |
| Champion Unit | Starts in the Champion Zone |
| Main deck | Exactly 40 cards, max 3 copies of any unique card |
| Rune deck | Exactly 12 cards, must match the Legend's Domain Identity |
| Battlefields | 3 |
| Sideboard | 8 cards, best-of-three only, same construction constraints |

The Legend defines the **Domain Identity** — the two domains the deck may use — and
grants a Legend Ability. The Chosen Champion counts toward the 3-copy limit for that
card (so up to two additional copies may be added).

### Domains

Six: **Fury, Calm, Mind, Body, Chaos, Order.** A deck's legal card pool is
constrained by its Legend's two-domain identity.

### Resources

Two distinct resources, both mediated by the rune deck — model them separately:

- **Energy** — the general cost resource. Paid by **exhausting** runes (turning
  them sideways).
- **Power** — the domain-specific resource for stronger effects. Paid by
  **recycling** runes (putting them on the bottom of the rune deck).

A card's cost may require both. This dual system is central to deck consistency
analysis: a deck can be "on curve" for Energy and still fail on Power of the right
domain.

### Turn structure

Phases **A / B / C / D**, then the action phase:

- **A — Awaken:** turn player readies all cards, including runes.
- **B — Beginning:** if holding a battlefield, score a point.
- **C — Channeling:** channel 2 runes from the rune deck.
- **D — Draw:** draw 1 card from the main deck.

### Board and combat

The board is **positional**: units occupy a player's base or one of the
battlefields, and players move units between them. Over-committing to one
battlefield can win short-term points while leaving others open — positional
evaluation is a real part of AI quality, not an afterthought.

Moving units to a battlefield begins a **Showdown**:

- **Open Showdown** — moving onto an uncontrolled battlefield takes control
  immediately, with no Might comparison.
- **Combat Showdown** — moving onto an opponent-controlled battlefield triggers the
  comparison.

**Units have Might**, a single stat serving as both damage dealt and damage
sustained (a 5-Might unit hits for 5 and dies to 5). Combat sequence: both players
may play spells before comparison → Might is summed → lethal damage is assigned
**simultaneously** → higher total wins → healing → claim. **A tie destroys all units
on both sides.** Simultaneity and the tie rule matter — an engine that resolves
sequentially will produce subtly wrong results.

Control vs. holding: destroying all defenders claims the battlefield; still
controlling it at the start of your next turn is **holding**, which scores.

### Timing

**Actions** may be played during your action phase or during combat/showdowns.
**Reactions** may additionally be played in response to spells or abilities, and
resolve *before* the thing they respond to. This implies a **chain/stack structure**
with priority passing — build it into the engine from the start rather than
retrofitting it.

## Proposed architecture

A monorepo of focused packages, ordered by dependency (each may depend only on
those above it):

```
packages/
  cards/      Card data ingest, normalization, and the card definition schema
  deck/       Deck list parsing, deck model, format legality validation
  engine/     The rules engine: game state, legal action generation, resolution
  ai/         Agents (random → heuristic → search-based)
  analysis/   Statistics: curve, consistency, draw probabilities, win rates
  suggest/    Deck edit recommendations
  sim/        Batch simulation harness
  cli/        Developer-facing entry point until the UI exists
```

### Engine design principles

These are the decisions most expensive to reverse later. Follow them.

1. **The engine is a pure state machine.** `(state, action) -> state`. No I/O, no
   logging side effects, no clock access, no global state.
2. **Determinism is mandatory.** All randomness comes from an injected, seeded PRNG.
   The same seed and the same action sequence must always produce an identical game.
   This is what makes simulation reproducible and bugs debuggable — a
   non-deterministic engine is nearly impossible to test.
3. **Legal action generation is a first-class API.** The engine must be able to
   enumerate every legal action from a given state. Both the AI and the eventual UI
   depend on this; without it, agents resort to guess-and-check.
4. **Hidden information is modeled explicitly.** Maintain the full state plus a
   per-player *observable view*. Agents receive only their view. This prevents the
   AI from accidentally cheating and enables determinization for search-based
   agents.
5. **State must be cheap to copy or roll back.** Search agents explore thousands of
   futures per decision. Prefer immutable/structural-sharing updates or an explicit
   undo log; avoid deep-cloning a large mutable object per node.
6. **Card effects are data-driven, not bespoke code.** Represent effects as small
   composable primitives referenced by card definitions. A card pool in the
   thousands is unmaintainable if each card is hand-written control flow. Expect a
   minority of genuinely unique cards to need escape-hatch scripting — design for
   that, but make it the exception.
7. **Separate rules from card data.** Card data is ingested and versioned; the rules
   engine is code. New set releases should be a data update, not an engine rewrite.

### AI design

Build agents in increasing order of strength, keeping earlier ones as test
baselines:

1. **Random legal agent** — the fuzz-testing workhorse. Invaluable for finding
   illegal states and engine crashes long before it is a useful opponent.
2. **Heuristic agent** — scripted evaluation (tempo, board presence, battlefield
   position, points).
3. **Search agent** — MCTS or similar with determinization over hidden information.

A new agent must beat the previous tier convincingly over a large sample, or it is
not an improvement. Agents implement a common interface and must never access state
outside their observable view.

### Statistics

Two distinct kinds — do not conflate them:

- **Analytic** — computed in closed form or by cheap draw sampling: cost curve,
  domain balance, probability of holding card X by turn N, opening-hand keepability.
  Fast, exact, no engine needed.
- **Simulated** — measured by playing games: win rate, average game length, points
  over time, per-card impact. Requires the engine and an AI, and needs enough
  iterations for meaningful confidence intervals. **Always report the sample size
  and an uncertainty measure** — a win rate with no confidence interval is not a
  statistic.

## Tech stack

**Decision: TypeScript on Node, strict mode, monorepo of packages.**

Rationale: one language across the engine and the eventual web UI; the engine can
run in the browser directly, so deck testing needs no server round-trip; structural
typing models card and effect data well; performance is adequate for Monte Carlo
provided the engine uses flat data structures and avoids per-node allocation churn.

Should simulation throughput become the binding constraint, the engine package is
the isolated piece to port to a faster language — another reason to keep it pure.

**This is a reasoned default, not a mandate from the project owner. Confirm it
before writing implementation code**, since it is the most expensive decision to
reverse.

## Conventions

Until real code establishes precedent, follow these:

- **Test the rules against the rulebook.** Engine tests should cite the specific
  rule they encode. Prioritize the fiddly cases: simultaneous damage, the tie rule,
  reaction ordering, the final-point restriction.
- **Fuzz continuously.** Run random-agent games in CI; any crash, illegal state, or
  non-terminating game is a bug. This catches more than hand-written tests.
- **Golden-game regression tests.** Store seed + action sequence + expected final
  state. These catch unintended rule changes precisely because the engine is
  deterministic.
- **No presentation logic in the engine.** No string formatting for display, no
  colors, no layout. The engine emits structured events; consumers render them.
- **Card data is generated, not hand-edited.** Ingest from a source, normalize, and
  commit the result with the ingest script. Never hand-patch generated card data —
  fix the ingest.
- **Prefer explicit domain vocabulary.** Use the game's terms (Might, Showdown,
  Channel, Recycle, Exhaust, Hold, Conquer, Domain, Legend) in code. Do not invent
  synonyms; the rulebook is the naming authority.

## Reference sources

Card and deck data (evaluate before committing to one — licensing, completeness,
and update cadence for new sets all matter):

- Scrydex API — Riftbound card endpoints, card IDs of the form `OGN-296`
- `riftbound-api.com` — REST/JSON card API
- API TCG (`apitcg.com`) — open-source multi-TCG database including Riftbound
- `vikkumar2021/RiftboundCardDatabase` (GitHub) — card fetch scripts emitting
  `cards.json` / `cards_full.json`
- Piltover Archive — community deckbuilder; its deck URL/list format is a strong
  candidate for the canonical import format
- Riftseer API — used by community tooling for card data and images

Rules references used to write the domain primer above (community-sourced,
**secondary**): learnriftbound.gg, riftboundfaq.com, riftbound.zone, runesandrift.com,
riftbound.gg, riftmana.com, mobalytics.gg, riftboundguide.com.

**The official rulebook at `playriftbound.com` is the authority and is currently
egress-blocked in this environment.** Obtaining it — or a local copy — is a
prerequisite for engine work.

## Open questions

Resolve these before or during early implementation; record the answers here.

1. **Confirm the tech stack** (see above).
2. **Obtain the official comprehensive rulebook** and reconcile it against the
   domain primer. Highest priority — everything else depends on it.
3. **Choose a card data source** and pin a set/version. Which sets must be supported?
4. **Define the deck list input format(s).** Plain text? Piltover Archive URL or
   export? Multiple importers behind one interface?
5. **Player count.** Riftbound supports 2–4 players; the engine's state model is
   materially simpler if scoped to 1v1. Assume **1v1 unless told otherwise**, but do
   not hard-code a two-player assumption where a list would do.
6. **What "suggest edits" should optimize for** — raw win rate against a fixed AI, a
   specific matchup, or consistency metrics? This determines whether the suggestion
   engine needs simulation in the loop.

## Maintaining this file

Update this file as decisions are made and code lands: replace plans with
descriptions of what exists, move resolved items out of Open Questions, and keep the
accuracy warning on the domain primer until the rules are verified against the
official rulebook. Prefer specifics that are hard to infer from a quick skim over
generic advice. Accuracy beats length — delete anything that stops being true.
