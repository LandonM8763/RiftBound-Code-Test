# CLAUDE.md

Guidance for Claude Code and other AI assistants working in this repository.

## What we are building

A **deck testing application for Riftbound** (Riot Games' League of Legends trading
card game). The application has four capabilities:

1. **Deck list ingest** — accept a full deck list (Champion Legend, Chosen
   Champion, a main deck of at least 40 cards, a 12-card Rune deck, 3
   Battlefields), parse it, and validate it for format legality.
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
  pluggable importer interface, and format legality validation (main deck minimum
  of 40, 12 Runes, 3 distinct Battlefields, the 3-copy limit including the Chosen
  Champion, and Domain Identity).
- **`@riftbound/engine`** — a deterministic seeded PRNG, the game state model,
  the full turn phase machine (Awaken, Beginning, Channel, Draw, Main, Ending),
  Scoring by Hold, Burn Out, the win condition, Rune Pools, the Chain with
  Priority, the Process of Play, the Standard Move and Contested status,
  Showdowns with Focus, the full Steps of Combat, Scoring by Conquer including
  the Final Point restriction, and **data-driven card effects**, first-class
  legal action generation, per-player observable views, and a structural
  invariant checker.

  With Combat in, the engine can play a complete game of Riftbound with vanilla
  cards: contest a Battlefield, fight over it, take Control, and score to 8.
- **`@riftbound/ai`** — the `Agent` interface, a seeded random legal agent, and a
  single-game runner that keeps agents honest.
- **`@riftbound/analysis`** — the analytic statistics: a hypergeometric core
  (including the multivariate case), cost curve, draw probabilities by turn,
  Domain/Power consistency, and per-card castability. No engine, no agent, no
  randomness — closed-form and exact.
- **`@riftbound/cli`** — `riftbound analyze|validate <deck> --cards <cards.json>`,
  with text or `--json` output. This is where presentation lives; nothing below
  it formats anything. `packages/cli/examples/` holds invented sample cards and a
  legal deck list so the tool runs today, and the suite reads them so a broken
  example fails CI.

**The engine is now reconciled against the official Core Rules** (RUP4,
2026-07-16), and there are no `UNVERIFIED` placeholders left in it. Every rule
quantity in `GameConfig` cites its rule number.

What is **not** built yet, in rough dependency order:

1. **More effect primitives.** The effect system exists (`cards/effect.ts` for
   the data, `engine/effects.ts` for the interpreter) with draw, deal damage,
   heal, give Might, and add resources. Adding a primitive is a variant plus a
   case — no new code path per card. Still absent: killing, recalling, moving,
   counters, XP, and every triggered or activated ability (rules 376-395), which
   need a trigger system rather than another primitive.
2. **Cost modification** (rule 356's layers: base-cost replacement, additional
   costs, increases, discounts). `totalCost` in `play.ts` returns the printed
   cost and is the seam.
3. **The Mulligan** (rule 117) — verified but unimplemented: it is a player
   choice, so it needs a setup-time decision point rather than a config value.
4. **Signature card limits and champion tag matching** (103.2.a.2, 103.2.d) —
   both need card data that carries champion tags.

Focus (rule 313) *is* implemented, as part of Non-Combat Showdowns: granted to
the contesting player (345), passing on a pass (347.2.b) and when the last Chain
item resolves (346). What is still missing there is the Combat Showdown's
handling of it (464.2.c.1.a-b).

### Simplifications in the Process of Play

Both are documented at their call sites and reach the same states as the rules
would with the cards that exist today:

- **Adding resources is a separate action from playing a card.** Rule 357.1.a
  lets a controller activate Add Reactions *during* the Pay step. Basic Runes
  are the only resource source (164.2) and their abilities are Reactions usable
  whenever resources are needed (429.3), so filling the pool first is equivalent.
- **Steps 1-6 of rule 353 run atomically.** No player can act between a card
  going on the Chain and finalizing, and a Permanent leaves the Chain at that
  moment (359.2), so only Spells ever linger and only they open a response
  window.
- **Combat damage assignment order is fixed, not chosen.** Rule 465.2.c lets the
  assigning player pick the order, which decides *which* enemy Units die.
  `assignDamage` in `combat.ts` walks the targets in a fixed order instead. Every
  constraint is still obeyed — lethal-first (465.2.c.3), no overkill while others
  remain (465.2.c.4) — so totals and death counts are right, but the choice is
  not yet exposed. Making it one needs a sub-action protocol during the Damage
  Step.

Now that damage prevention and Might modifiers are expressible, note that **a
Recall (466.1.a.2) is still unreachable with vanilla Units.** Might is both the damage a Unit deals and the damage it
survives, so one side outlives the other exactly when it has more Might — the
comparison cannot go both ways, and Attacker and Defender can never both
survive. Damage prevention or healing is what makes Recalls possible.

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

Try the CLI against the sample data:

```bash
npm run build
node packages/cli/dist/main.js analyze packages/cli/examples/deck.txt \
  --cards packages/cli/examples/cards.json
```

### Adding a package

Only **one** config file needs editing: add a `references` entry to the root
`tsconfig.json`, which `tsc --build` requires to be explicit. `vitest.config.ts`
and `tsconfig.test.json` resolve `@riftbound/*` by pattern and need no change —
that is deliberate, so two people (or two sessions) adding packages at the same
time do not collide in shared config.

Then add the package to the status list above and the table in `README.md`.

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

> **Source: the official Riftbound Core Rules, RUP4, last updated 2026-07-16.**
> The PDF is committed at the repository root (split in two parts) and a plain
> text extraction makes it greppable. Cite rule numbers when you encode a rule,
> and check the rulebook rather than this summary for anything load-bearing —
> this section is a map, not the territory.
>
> Community guides got several things wrong that are corrected below. Do not
> reintroduce them, and do not let a model's training recollection of Riftbound
> override the rulebook.

### Win condition

Rule 323.1 / 472: **at a Cleanup, a player with points greater than or equal to
the Victory Score _and more points than any opponent_ wins.** The Victory Score
is 8 by default (194.3) and is set by the Mode of Play (483.3).

The "more than any opponent" clause is load-bearing: reaching 8 while tied does
not win, and 194.2.b has play continue until someone is ahead in a Cleanup.

### Scoring (rules 467-471)

A player Scores by one of exactly two methods:

- **Conquer** (469.1) — gaining Control of a Battlefield not yet Scored this turn.
- **Hold** (469.2) — keeping Control, during your Beginning Phase, of a
  Battlefield not yet Scored this turn.

Rule 470: **a player may Score a given Battlefield only once per turn**, by
either method.

**The Final Point restriction applies only to Conquer.** Rule 471.1.a.1 says
points gained from sources that are not Conquer are not beholden to it. Rule
471.1.b: when a player would Conquer while already within one point of the
Victory Score, they gain the point only if they have Scored *every* Battlefield
this turn; otherwise **they draw a card instead**. A Hold has no such condition
and can take a player to 8 on its own.

### Deck construction (rules 101-103)

| Component | Requirement | Rule |
|---|---|---|
| Champion Legend | 1, in the Legend Zone all game; sets Domain Identity | 103.1 |
| Chosen Champion | A Champion Unit whose champion tag matches the Legend's | 103.2.a.2 |
| Main deck | **At least 40 cards** — a floor, not an exact size | 103.2 |
| Copy limit | At most 3 of a given card *name*, Chosen Champion included | 103.2.b |
| Signature cards | At most 3 in total, all matching the Legend's champion tag | 103.2.d |
| Rune deck | Exactly 12, all within the Domain Identity | 103.3 |
| Battlefields | Count set by the Mode of Play; all names distinct | 103.4 |

Cards with more than one Domain are legal only in an identity containing *all*
of them (103.1.b.4).

**The Core Rules describe no sideboard.** Rule 486 defines the best-of-three
Match without one. The 8-card sideboard this codebase validates comes from
community sources and is presumably a tournament rule in a document we have not
seen — treat that number as unverified.

### Setup (rules 110-118)

Legend to the Legend Zone, Chosen Champion to the Champion Zone, Battlefields set
aside, both decks shuffled separately, turn order by any fair random method, then
**each player draws 4** (116) and takes a **Mulligan** (117): set aside up to 2
cards, draw that many, then Recycle the set-aside cards to the bottom of the deck.

### Modes of Play (rules 481-486)

A Mode defines player count, Victory Score, Battlefield Count, setup, format and
first-turn adjustments (483). The sanctioned **1v1 Duel** (485):

- 2 players, Victory Score 8, **Battlefield Count 2**
- Each player brings 3 Battlefields and **randomly selects one** at setup; the
  other two are removed (485.5). One Battlefield per player ends up in play.
- **The player going second Channels one extra Rune during their first Channel
  Phase** (485.7).

### Domains

Six: **Fury, Calm, Mind, Body, Chaos, Order.**

### Resources

Two distinct resources, both mediated by the Rune deck — model them separately:

- **Energy** — the generic cost resource, paid by **exhausting** Runes (414).
- **Power** — Domain-specific, paid by **recycling** Runes to the bottom of the
  Rune deck (416).

Rune Pools empty at the start of the Main Phase (316.3) and again in the Ending
Phase (317.2.e); unspent Energy and Power are lost.

### Turn structure (rules 314-317)

Start of Turn is four phases, then the Main Phase, then the Ending Phase:

- **Awaken** (315.1) — the Turn Player readies everything they control.
- **Beginning** (315.2) — Beginning Step, then Scoring Step: the Turn Player
  **Holds every Battlefield they Control**.
- **Channel** (315.3) — Channel 2 Runes; fewer than 2 left means Channel as many
  as possible, which is *not* a Burn Out.
- **Draw** (315.4) — draw 1. An empty Main Deck is a **Burn Out**.
- **Main** (316) — no defined structure; the Turn Player takes Discretionary
  Actions until they end the turn.
- **Ending** (317) — end-of-turn effects, then heal all Units and expire every
  "this turn" effect.

### Burn Out (rules 413.4, 431)

Attempting to move more cards out of the Main Deck than it holds causes a Burn
Out: do as much as possible, **Recycle your trash into your Main Deck randomised**,
**choose an opponent to gain 1 point**, then finish the original action.

This is what makes real games terminate. A player with an empty deck and empty
trash burns out every turn, handing a point away each time, until someone reaches
the Victory Score (431.3.a).

### Combat and Showdowns (rules 341, 459-466)

**Community summaries get this badly wrong. There is no "compare total Might,
higher total wins" step, and no "a tie destroys everything" rule.** What actually
happens:

1. **Combat Showdown Step** (464) — establish Attacker (whoever applied Contested
   to the Battlefield) and Defender; the Attacker gains Focus; triggered abilities
   go on the Chain.
2. **Combat Damage Step** (465) — sum each side's Might, then **each player
   assigns damage equal to their summed Might among the *other* side's Units**.
   Assignment must give a Unit lethal damage before moving to the next (465.2.c.3)
   and may not overkill while other Units remain (465.2.c.4). Assignment is not
   dealing: **all assigned damage is dealt simultaneously** (465.2.c.1.a).
3. **Resolution Step** (466) — a Combat Cleanup heals all Units and **Recalls
   surviving Attackers if any Defender is still present** (466.1.a.2). The result
   is then decided by *who has Units remaining*, not by Might totals: you win if
   you are the only player with Units there, lose if you are the only one without,
   and it is **No Result** if both or neither have Units left, or Attackers were
   Recalled (466.3). Establishing Control then produces a **Conquer** if that
   Battlefield has not been Scored by that player this turn (466.5.d).

A Showdown at an *empty* Battlefield is a **Non-Combat Showdown** and a
stand-alone phase; it becomes a Combat Showdown if an opposing Unit arrives
(316.8.b.1).

### Timing, the Chain, Priority and Focus (rules 307-313, 327)

The turn is always in one of four states (310): Neutral/Showdown crossed with
Open/Closed. A Chain existing makes the state Closed, where **only Reaction
cards may be played** (309.1.a); a Showdown in progress restricts play to
**Action or Reaction** (308.1.a).

**Priority** is the exclusive right to take Discretionary Actions (312).
**Focus** is the permission to act during a Showdown Open state (313); gaining
Focus also grants Priority, and passing Priority retains Focus.

## Proposed architecture

A monorepo of focused packages, ordered by dependency (each may depend only on
those above it):

```
packages/
  cards/      EXISTS  Card definition schema, Domains, cost model, registry
  deck/       EXISTS  Deck list parsing, deck model, format legality validation
  engine/     EXISTS  The rules engine: state, legal actions, resolution
  ai/         EXISTS  Agents (random → heuristic → search-based)
  analysis/   EXISTS  Statistics: curve, consistency, draw probabilities
  suggest/    planned Deck edit recommendations
  sim/        planned Batch simulation harness
  cli/        EXISTS  Developer-facing entry point until the UI exists
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

The analytic side is built in `analysis/`. Two things to know before extending it:

- **Sampling is without replacement**, so the hypergeometric distribution is the
  model, not the binomial. Multi-Domain Power costs are a *joint* question —
  every Fury Rune Channelled is one fewer slot for a Calm Rune — so
  `multivariateAtLeast` solves them together. Multiplying per-Domain
  probabilities overstates the answer, and there is a test that pins that down.
- **Power availability ignores Recycling.** Paying Power puts Runes on the bottom
  of the Rune deck, which changes the population mid-game. The model is exact
  until the first Recycle and a first-order estimate after it. Fine for the early
  turns that decide most games; do not quote it as a whole-game figure.

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

- **Test the rules against the rulebook.** Engine tests cite the specific rule
  they encode, in the `describe` name or a comment. Prioritize the fiddly cases:
  simultaneous damage assignment, Recalls, reaction ordering, the Conquer-only
  Final Point restriction, and the "more points than any opponent" clause.
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

### The rulebook

**`Riftbound-Core-Rules-RUP4-July-16-2026-compressed-{1,2}.pdf` at the repository
root is the authority.** It is the official Core Rules, split across two files,
120 pages, rules 000-829, with a real text layer.

`playriftbound.com` is egress-blocked in this environment, so work from the
committed PDF. To grep it, extract the text first:

```bash
pip install pypdf cffi   # the image's cryptography package is broken without cffi
python3 -c "
from pypdf import PdfReader; import glob
print(''.join(p.extract_text() or '' for f in sorted(glob.glob('*.pdf')) for p in PdfReader(f).pages))
" > /tmp/rules.txt
```

Community rules sites (learnriftbound.gg, riftboundfaq.com, riftbound.zone,
runesandrift.com, riftbound.gg, riftmana.com, mobalytics.gg, riftboundguide.com)
are **secondary and demonstrably unreliable** — see the correction table under
[Open questions](#open-questions). Do not encode a rule from them.

## Open questions

The rulebook resolved the ones that were blocking. What remains:

1. **Choose a card data source** and pin a set/version. Which sets must be
   supported? Every hosted API in [Reference sources](#reference-sources) is
   blocked by this environment's egress proxy; only `raw.githubusercontent.com`
   is reachable, so a GitHub-hosted dataset is currently the only open route.
2. **Find the tournament/competitive rules document.** The Core Rules describe no
   sideboard, so the 8-card sideboard this codebase validates is unverified.
3. **Is the deck list format canonical?** Importers are pluggable via
   `DeckImporter` and a plain-text one exists that reads `<count> <card id>`
   lines under section headers. Whether a Piltover Archive URL or export should
   be the canonical format, and whether card *names* should be accepted, both
   wait on question 1.
4. **What "suggest edits" should optimize for** — raw win rate against a fixed
   AI, a specific matchup, or consistency metrics? This determines whether the
   suggestion engine needs simulation in the loop.
5. **Rule 103.4.b** makes Battlefields "subject to Domain Identity if
   applicable". The qualifier is not defined anywhere in the Core Rules, so
   validation leaves Battlefields unchecked rather than guessing.
6. **Burn Out beneficiary with 3+ players.** Rule 431.2.c has the burning player
   *choose* which opponent gains the point. The engine takes the next player in
   turn order, which is forced in 1v1 but a real decision in FFA3 and needs a
   choice point.

### What the rulebook corrected

Worth recording, because community sources are confidently wrong about all of
these and a future session may be tempted to "fix" the code back:

| Community claim | What the rules actually say |
|---|---|
| Main deck is exactly 40 | **At least** 40 (103.2) |
| Opening hand of 5, no mulligan | Draw 4 (116), then a mulligan of up to 2 (117) |
| Reaching 8 points wins | 8 **and more than any opponent**, at a Cleanup (323.1) |
| The final point can never be scored by any means | The restriction applies **only to Conquer** (471.1.a.1) |
| Combat: sum Might, higher total wins | No comparison step; damage is assigned and dealt, and the result is who has Units left (465-466) |
| A tie destroys all units on both sides | No such rule; surviving Attackers are Recalled if any Defender lives (466.1.a.2) |
| Battlefields: 3 per deck, all in play | 3 per deck, **one chosen at random** per player, 2 in play in 1v1 (485.4, 485.5) |
| Nothing special about the first turn | The player going second Channels an extra Rune (485.7) |
| An empty deck does nothing in particular | Burn Out: recycle trash, **give an opponent a point** (431) |

## Maintaining this file

Update this file as decisions are made and code lands: replace plans with
descriptions of what exists, move resolved items out of Open Questions, and keep the
accuracy warning on the domain primer until the rules are verified against the
official rulebook. Prefer specifics that are hard to infer from a quick skim over
generic advice. Accuracy beats length — delete anything that stops being true.
