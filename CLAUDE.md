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

**Phase 1, in progress.** Two packages exist and are covered by tests; the rest of
the architecture below is still a plan.

What is built:

- **`@riftbound/cards`** — the six Domains, the Energy/Power `Cost` model, card
  definition types (Legend, Unit, Spell, Gear, Rune, Battlefield), and a
  duplicate-rejecting `CardRegistry`. No real card data yet.
- **`@riftbound/deck`** — the deck model, a plain-text deck list parser behind a
  pluggable importer interface, and format legality validation (40-card main deck,
  12 Runes, 3 Battlefields, the 3-copy limit including the Chosen Champion, Domain
  Identity, and the best-of-three sideboard).
- **`@riftbound/engine`** — a deterministic seeded PRNG, the game state model,
  the A/B/C/D turn phase machine, first-class legal action generation, per-player
  observable views, and a structural invariant checker.
- **`@riftbound/ai`** — the `Agent` interface, a seeded random legal agent, and a
  single-game runner that keeps agents honest.

What is deliberately **not** built, and why: playing cards, moving Units,
Showdowns, and combat. Those depend on rules not yet verified against the official
rulebook. Guessing them would bake wrong behaviour into the layer every statistic
this application reports is measured against. See [Open questions](#open-questions).

Anything in the code marked `UNVERIFIED` is a placeholder chosen so the engine can
run, not a rule that has been confirmed. Most are `GameConfig` fields rather than
constants, so correcting them is a one-line change.

## Development

```bash
npm install
npm test           # vitest, all packages
npm run typecheck  # tsc --build, then the test files separately
npm run build      # emit dist/ per package
```

Node 22+. Tests run against TypeScript sources via aliases in `vitest.config.ts`,
so no build step is needed before testing. Test files are excluded from the
package builds and typechecked by `tsconfig.test.json` instead — that is why
`typecheck` runs `tsc` twice.

CI (`.github/workflows/ci.yml`) runs the typecheck and the suite, which includes
the random-agent fuzz run.

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
  cards/      EXISTS  Card definition schema, Domains, cost model, registry
  deck/       EXISTS  Deck list parsing, deck model, format legality validation
  engine/     EXISTS  The rules engine: state, legal actions, resolution
  ai/         EXISTS  Agents (random → heuristic → search-based)
  analysis/   planned Statistics: curve, consistency, draw probabilities, win rates
  suggest/    planned Deck edit recommendations
  sim/        planned Batch simulation harness
  cli/        planned Developer-facing entry point until the UI exists
```

Deck *construction* rules (40 cards, 12 Runes, the 3-copy limit, Domain Identity)
belong to `deck/`, not `engine/`. The engine deliberately accepts any deck list so
that its own tests can use three-card decks.

`deck/` does not import `engine/`. `toCardLists` returns a `CardLists` that is
structurally identical to the engine's `DeckList`, so it can be handed straight to
`createGame` with no dependency between the two — keep it that way.

Batch simulation and the statistics that go with it belong in the planned `sim/`
package. `ai/` runs single games only; `playGame` is there to exercise an agent,
not to produce win rates. Win rates are meaningless until cards can be played —
every game currently ends in the `maxTurns` draw.

### Engine map

| File | Responsibility |
|---|---|
| `rng.ts` | sfc32 seeded by splitmix32; unbiased bounded ints, Fisher-Yates shuffle, serializable state |
| `state.ts` | Ids, zones, entities, `GameConfig`, `GameState`, accessors |
| `mutate.ts` | Structural-sharing update helpers; the only place zone lists and `entity.location` are written |
| `actions.ts` | The `Action` union and `IllegalActionError` |
| `reduce.ts` | `(state, action) -> { state, events }`, the phase machine |
| `legal.ts` | `legalActions(state, player)` |
| `view.ts` | Per-player observable view; redacts hidden zones |
| `invariants.ts` | `checkInvariants(state)`, run after every action when fuzzing |
| `setup.ts` | `createGame` — entity creation, shuffles, opening hands |

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

**Confirmed by the project owner; implementation has started against it.**
Concretely: npm workspaces, `tsc --build` project references, and vitest. The
strict flags in `tsconfig.base.json` include `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` — do not loosen them to make a change compile.

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

Resolve these and record the answers here.

1. **Obtain the official comprehensive rulebook** and reconcile it against the
   domain primer. Highest priority — everything else depends on it. The official
   site is blocked by this environment's egress proxy; a local copy works just as
   well.
2. **Choose a card data source** and pin a set/version. Which sets must be supported?
3. **Define the deck list input format(s).** Partly answered: importers are
   pluggable via `DeckImporter`, and a plain-text importer exists that reads
   `<count> <card id>` lines under section headers. Still open — is a Piltover
   Archive URL or export the canonical import format, and should card *names* be
   accepted? Name resolution needs card data, so it waits on question 2.
4. **Player count.** Riftbound supports 2–4 players; the engine's state model is
   materially simpler if scoped to 1v1. Assume **1v1 unless told otherwise**, but do
   not hard-code a two-player assumption where a list would do. The current code
   keeps players in a list and takes `playerCount` from the deck list count.
5. **What "suggest edits" should optimize for** — raw win rate against a fixed AI, a
   specific matchup, or consistency metrics? This determines whether the suggestion
   engine needs simulation in the loop.

### Rules the code currently guesses

Each of these is marked `UNVERIFIED` at its definition. They are the first things
to check against the rulebook, roughly in order of how much damage a wrong answer
does.

| Question | Current placeholder | Where |
|---|---|---|
| Can the final (8th) point be scored by any means? | Not implemented — 8 points simply wins | `reduce.ts`, `beginning` |
| Is Beginning-phase scoring one point per Battlefield held, or one total? | One per Battlefield | `reduce.ts`, `beginning` |
| How many Battlefields are contested at once? | `battlefieldCount: 2` | `state.ts`, `DEFAULT_CONFIG` |
| How are the Battlefields in play chosen from the players' three each? | Round-robin by seat | `setup.ts`, `placeBattlefields` |
| Opening hand size, and whether a mulligan exists | `openingHandSize: 5`, no mulligan | `state.ts`, `DEFAULT_CONFIG` |
| What happens on an empty main deck | Emits `mainDeckEmpty`, game continues | `reduce.ts`, `draw` |
| Who takes the first turn, and does turn 1 skip anything? | Random, no first-turn adjustment | `setup.ts`, `createGame` |
| Does the sideboard share the 3-copy limit with the main deck? | Yes, shared | `deck/validate.ts`, `checkCopyLimit` |
| Must the three Battlefields be distinct? | Not enforced | `deck/validate.ts`, `checkCopyLimit` |
| Are Battlefields constrained by Domain Identity? | Not enforced | `deck/validate.ts`, `checkDomainIdentity` |

`maxTurns` is *not* in this table: it is an explicit harness guard so fuzzing
terminates, not a rule, and real simulations should raise it.

Deck construction quantities — 40, 12, 3 Battlefields, 3 copies, 8 sideboard — are
**not** in this table. Multiple community sources agree on them.

## Maintaining this file

Update this file as decisions are made and code lands: replace plans with
descriptions of what exists, move resolved items out of Open Questions, and keep the
accuracy warning on the domain primer until the rules are verified against the
official rulebook. Prefer specifics that are hard to infer from a quick skim over
generic advice. Accuracy beats length — delete anything that stops being true.
