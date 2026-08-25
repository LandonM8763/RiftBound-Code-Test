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

**Phase 1, in progress.** Nine packages exist and are covered by tests; the rest
of the architecture below is still a plan. **The engine plays complete games
with real Riftbound card data, including cards whose printed text is modelled**
— 479 cards ingested, a legal deck validated from them, 300 games simulated
with damage spells, draw and Play Effects firing. 266 of the 468 cards with text
are covered so far, and [Card data](#card-data) explains why that number is a
statement about the engine's mechanics rather than about the parser.

What is built:

- **`@riftbound/cards`** — the six Domains, the Energy/Power `Cost` model, card
  definition types (Legend, Unit, Spell, Gear, Rune, Battlefield), the Champion
  and Signature supertypes with Champion Tags, **keywords** (rules 800-828) and
  a duplicate-rejecting `CardRegistry`. No real card data yet.
- **`@riftbound/deck`** — the deck model, a plain-text deck list parser behind a
  pluggable importer interface, and format legality validation (main deck minimum
  of 40, 12 Runes, 3 distinct Battlefields, the 3-copy limit including the Chosen
  Champion, Domain Identity, Champion Tag matching, and the 3-card Signature
  budget).
- **`@riftbound/engine`** — a deterministic seeded PRNG, the game state model,
  the full turn phase machine (Awaken, Beginning, Channel, Draw, Main, Ending),
  Scoring by Hold, Burn Out, the win condition, Rune Pools, the Chain with
  Priority, the Process of Play, the Standard Move and Contested status,
  Showdowns with Focus, the full Steps of Combat, Scoring by Conquer including
  the Final Point restriction, **data-driven card effects** (draw, damage,
  heal, Might, resources, kill, recall, move, ready/exhaust, Buffs, discard,
  Stun, XP, Channel, Tokens, returning cards to hand, granting keywords),
  targets that **choose nothing and affect everything matching a criterion**
  (355.5.a), **the
  Mulligan**,
  **Activated and Triggered abilities** on an **interruptible phase machine**,
  **event-driven trigger conditions**, **rule 356 cost modification** including
  **Additional Costs**, **static and passive abilities**, **state predicates**,
  **Tokens** (179-187) including the Gold token's `[A]` in the Rune Pool
  (135.2.e.5.b), **Attachment** (434-435, 716-719), the **Facedown Zone**
  (107.3, 421), the **keywords**
  Assault, Shield, Tank, Backline, Ganking and Hidden, the **Dependent
  Keywords** Legion
  and Level, first-class legal action generation, per-player observable views,
  and a structural invariant checker.

  With Combat in, the engine can play a complete game of Riftbound: contest a
  Battlefield, fight over it, take Control, and score to 8.
- **`@riftbound/ai`** — the `Agent` interface, a seeded random legal agent, a
  **heuristic agent**, a **determinizing search agent**, and a single-game
  runner that keeps agents honest. The heuristic wins **~85% against random over
  120 alternating-seat games**, and the search agent wins **90.8% [84.3%, 94.8%]
  against the heuristic** over 120 games with real card data. Both controls —
  random-vs-random and search-vs-search — measure ~50%, which is what says the
  harness is not just reporting first-player advantage.
- **`@riftbound/analysis`** — the analytic statistics: a hypergeometric core
  (including the multivariate case), cost curve, draw probabilities by turn,
  Domain/Power consistency, and per-card castability. No engine, no agent, no
  randomness — closed-form and exact.
- **`@riftbound/ingest`** — card data source adapters behind a `CardSource`
  interface, a **card-text parser** that turns printed text into the effect
  model, plus the gap model. Two exist: **`APITCG_SOURCE`** (the default,
  and the one that works) and `COMMUNITY_SOURCE`. Neither **ever invents a
  missing field**: a card whose source lacks something the rules need is
  dropped and recorded, because card data that looks complete and is not
  produces statistics that are plausible and wrong. See
  [Card data](#card-data).
- **`@riftbound/sim`** — batch simulation. `simulate` plays N games, rotates
  entrants through the seats and reports per-entrant win rates as **Wilson
  score intervals**, plus game-length and points summaries. Reproducible: each
  game's seed derives from the batch seed, so any single game replays on its
  own with `playGame`.
- **`@riftbound/suggest`** — deck edit recommendations: cuts, additions, swaps
  and Rune ratio changes, each carrying the measurement that motivated it and
  how far it moved a stated objective. **What it optimizes for is pluggable and
  deliberately undecided** — see [Suggestions](#suggestions).
- **`@riftbound/cli`** — `riftbound analyze|validate|sim|suggest <deck> --cards <cards.json>`
  and `riftbound ingest <raw> > cards.json`, with text or `--json` output.
  Ingest writes cards to stdout and its gap report to stderr, so the redirect
  above yields data while the shortfall stays visible. This is where
  presentation lives; nothing below
  it formats anything. `packages/cli/examples/` holds invented sample cards and a
  legal deck list so the tool runs with no setup at all, plus `real-deck.txt`
  for use against ingested real data; the suite reads all three, so a broken
  example fails CI.

**The engine is now reconciled against the official Core Rules** (RUP4,
2026-07-16), and there are no `UNVERIFIED` placeholders left in it. Every rule
quantity in `GameConfig` cites its rule number.

What is **not** built yet, in rough dependency order:

1. **Repeat (820), the last keyword, and it is not blocked — it is not worth
   building.** Every other keyword the rulebook defines is now modelled:
   Assault, Shield, Tank, Backline, Ganking and Hidden as engine rules, and
   Accelerate, Equip, Quick-Draw, Deathknell, Temporary, Weaponmaster, Deflect
   and Vision as desugars into machinery that exists. 820.1.d makes Repeat the
   same optional-cost shape as Accelerate, so the mechanic is expressible; it
   has measured **+0 cards from three separate baselines**, because its ten
   printings are each blocked on something else as well. Its reason in
   `UNMODELLED_KEYWORDS` records that rather than a blocker, which is the honest
   thing for it to say.
2. **Statics that are not a scope plus a grant.** Might modifiers, granted
   keywords and "enters ready" are built; a *dynamic* Might ("increased by your
   points"), a duration ("units you play this turn enter ready") and a rule
   change ("opponents can only play units to their base") are not.
3. **Conditional and modal effects** — "if this kills it", "unless its
   controller…", "choose one •…", "for each…". *State* predicates and "if you
   paid the additional cost" are built; what is left is a condition on an
   effect's own outcome, counting, and modes.

Focus (rule 313) is implemented for both kinds of Showdown: granted to the
contesting player (345), passing on a pass (347.2.b) and when the last Chain
item resolves (346), and handed to the Attacker when a Combat opens (464.2.d).

**A Non-Combat Showdown becomes a Combat Showdown when an opposing Unit
arrives** (316.8.b.1.a), in the Cleanup that follows. That is rule 464.1's
second way for Combat to open, and the Attacker stays whoever applied Contested
(464.2.c.1) rather than whoever arrived second. It takes a card effect to reach:
144 restricts the Standard Move to the Turn Player and `canStandardMove` refuses
it while a Showdown is running.

**464.2.c.1.b and 464.2.d appear to conflict** — the first says a Showdown that
was already ongoing keeps its current Focus holder, the second is a numbered
Task saying the Attacker gains Focus. 464.2.e.1 settles it by calling the
Attacker "the Attacking player, who has Focus", so c.1.b is read as describing
the instant Combat opens and d as the Task that then moves Focus. This engine
performs the step atomically, so only the outcome is observable.

### Simplifications in the Process of Play

These are documented at their call sites and reach the same states as the rules
would with the cards that exist today:

- **Adding resources is a separate action from playing a card.** Rule 357.1.a
  lets a controller activate Add Reactions *during* the Pay step. Basic Runes
  are the only resource source (164.2) and their abilities are Reactions usable
  whenever resources are needed (429.3), so filling the pool first is equivalent.
- **Steps 1-6 of rule 353 run atomically.** No player can act between a card
  going on the Chain and finalizing, and a Permanent leaves the Chain at that
  moment (359.2), so only Spells ever linger and only they open a response
  window.
- **A player does not order their own simultaneous triggers.** Rule 383.3.d.1
  has each player order their own triggers, starting with the Turn Player and
  proceeding in turn order. `triggersFor` honours the *between-player* order and
  decides the within-player tie-break for them, deterministically. Making it a
  choice needs a decision point *between* queueing and finalizing, which is a
  different thing from rule 402's step 2 — that one belongs to a single ability
  and is built.
- **Discount order is chosen for the player, not by them.** Rule 356.4.c.1 lets
  a player order the discounts on a component, and 356.4.e makes that choice
  matter. `costs.ts` applies bounded discounts before unbounded ones, which is
  the player-favourable order in the rulebook's own worked example.
- **Which cards get discarded is chosen for the player.** Rule 422.1.a lets the
  discarding player choose, and 422.1.a lets them use Private Information to do
  it. `effects.ts` takes from the front of the hand instead, deterministically.
- **Combat damage assignment order is fixed, not chosen.** Rule 465.2.c lets the
  assigning player pick the order, which decides *which* enemy Units die.
  `assignDamage` in `combat.ts` walks the targets in a fixed order instead. Every
  constraint is still obeyed — lethal-first (465.2.c.3), no overkill while others
  remain (465.2.c.4), and Tank and Backline (815, 826), which are rules rather
  than preferences and so sort the targets — but *within* a rank the choice is
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

**Champion Tags and the two supertypes.** Rule 133.8.b: a Champion Tag is the
tag that links a Champion Legend to its Champion Units and Signature cards, and
it is the only kind of tag with rules meaning — 133.8.a gives ordinary tags
none. **Champion** (133.7.a) is a supertype applying exclusively to Units;
**Signature** (133.7.b) applies to a card of *any* type, which is why
`signature` sits on the card base rather than on `UnitCard`. The two are
mutually exclusive: 103.2.d.3 says a Signature card is never a Champion Unit and
cannot occupy the Champion Zone — the rulebook's own Tibbers/Annie example.

The Signature budget is a **sum, not a per-name limit**: 103.2.d.1 caps a deck
at 3 Signature cards "regardless of name", so three *different* Signature cards
exhaust it exactly as three copies of one do. It is counted separately from the
3-copy rule for that reason.

`championTag` is its own field on the card rather than a string inside `tags`,
because validation has to know *which* tag is the Champion Tag and picking one
out of an untyped list would be a guess. It is modelled as a single tag, since
103.2.a.2 and 103.2.d.2 both speak of "the tag" on the Legend; if real card data
ever shows a card carrying two, it becomes an array and the matches become
intersections.

Card data that omits the tag gets a **warning**, not an error: a missing field
is a gap in the data, not an illegal deck, and erroring would fail every deck
built from a tagless ingest. The warning exists so the gap is visible rather
than silently passing — and the CLI prints warnings even for a legal deck, which
is the whole point of raising them.

**The Core Rules describe no sideboard.** Rule 486 defines the best-of-three
Match without one. The 8-card sideboard this codebase validates comes from
community sources and is presumably a tournament rule in a document we have not
seen — treat that number as unverified.

### Setup (rules 110-118)

Legend to the Legend Zone, Chosen Champion to the Champion Zone, Battlefields set
aside, both decks shuffled separately, turn order by any fair random method, then
**each player draws 4** (116) and takes a **Mulligan** (117): set aside up to 2
cards, draw that many, then Recycle the set-aside cards to the bottom of the deck.

The Mulligan is a **player choice**, so it is modelled as a phase (`'mulligan'`,
before `'awaken'`) with a real decision point, not as a config value.
`createGame` deals the opening hands and stops there, with Priority on the First
Player; `legalActions` enumerates every subset of the hand up to the limit, and
each `mulligan` action passes the choice to the next player in turn order until
`mulligansTaken` reaches the player count, at which point rule 118 begins play
with the First Player. **The 117.2-then-117.3 order is load-bearing** — drawing
before Recycling is what stops a player redrawing what they just set aside — and
`mulligan.test.ts` pins it with a near-empty deck, the only case where the two
orders diverge.

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

**`[A]` is a third thing, and it is in the pool as well as in a cost.**
135.2.e.5 is Power of any Domain: 135.2.e.5.a is the *cost* side, which
`Cost.anyPower` states, and **135.2.e.5.b is the pool side** — once Added, an
`[A]` "can be spent to pay a Power cost of any Domain". So `RunePool.anyPower`
is a wildcard pip rather than Power of a Domain chosen when it arrives; fixing
the Domain on arrival would strand it the moment a later cost wanted a
different one. `canPay` draws on it to cover a Domain the player is short of
before counting it towards an `[A]` on the cost, and `payFrom` spends it
**last** — a specific pip pays one Domain or an `[A]`, a wildcard pays
anything, so the wildcard is the one worth keeping. The Gold token (187.5) is
what produces it.

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
  ingest/     EXISTS  Card data source adapters: normalize and report gaps
  suggest/    EXISTS  Deck edit recommendations
  sim/        EXISTS  Batch simulation: win rates with intervals
  cli/        EXISTS  Developer-facing entry point until the UI exists
```

Deck *construction* rules (40 cards, 12 Runes, the 3-copy limit, Domain Identity)
belong to `deck/`, not `engine/`. The engine deliberately accepts any deck list so
that its own tests can use three-card decks.

`deck/` does not import `engine/`. `toCardLists` returns a `CardLists` that is
structurally identical to the engine's `DeckList`, so it can be handed straight to
`createGame` with no dependency between the two — keep it that way.

Batch simulation and the statistics that go with it live in `sim/`. `ai/` runs
single games only; `playGame` is there to exercise an agent, and `simulate`
builds the batch on top of it. Keep that split — a win rate computed inside
`ai/` would put the statistics next to the thing being measured.

### Engine map

| File | Responsibility |
|---|---|
| `rng.ts` | sfc32 seeded by splitmix32; unbiased bounded ints, Fisher-Yates shuffle, serializable state |
| `state.ts` | Ids, zones, entities, `GameConfig`, `GameState`, accessors |
| `mutate.ts` | Structural-sharing update helpers; the only place zone lists and `entity.location` are written |
| `actions.ts` | The `Action` union and `IllegalActionError` |
| `reduce.ts` | `(state, action) -> { state, events }`, the interruptible phase machine |
| `abilities.ts` | Activated/Triggered abilities: what may be activated, what a game event triggers |
| `dependency.ts` | Dependent Keywords (812, 824); its own module because both abilities and cost modifiers are gateable and `costs.ts` sits below `abilities.ts` |
| `condition.ts` | State predicates, asked by statics, cost modifiers, effects and "enters ready" alike |
| `count.ts` | Numbers read off the state, asked by the same three; also answers `Condition`'s `controls` |
| `additional.ts` | Additional Costs (356.2): what can be paid, and paying it |
| `statics.ts` | Static and Passive abilities: Might, granted keywords, entering ready, and rule 002's restrictions |
| `costs.ts` | Rule 356's layers: what a card or ability actually costs to play |
| `legal.ts` | `legalActions(state, player)`, and `targetChoices` — every legal *set* of Targets for a spec (355.6) |
| `view.ts` | Per-player observable view; redacts hidden zones |
| `token.ts` | Tokens (179-187): Creating them, and 186.1's rule that one leaving the Board stops existing |
| `attach.ts` | Attachment (434-435, 716-719): the link, and `activeAbilities`, which is the one honest answer to what a Game Object can do |
| `hidden.ts` | Hidden (811) and Hide (421): the Facedown Zone, and 107.3.e's rule that it is not a Location |
| `determinize.ts` | Rebuilding a searchable `GameState` from a `GameView` (128): public copied, Private sampled |
| `invariants.ts` | `checkInvariants(state)`, run after every action when fuzzing |
| `setup.ts` | `createGame` — entity creation (Units, Runes and a Game Object per Battlefield, 170), shuffles, opening hands, opens in the Mulligan |

The view exposes **effective Might, the Showdown, Contested status and
per-turn Scoring** because all of it is public at the table — a Unit's Might is
printed on its card and a Showdown happens in the open. `might` is `null`
exactly when `card` is, so redaction stays a single decision rather than two
that can drift apart. It is derived (`might + mightBonus`, floored at 0 per
143.2.b) so agents do not reimplement `mightOf` and get Combat subtly wrong.

### Abilities

Rules 376-395. The data lives in `cards/ability.ts`, the timing and trigger
logic in `engine/abilities.ts`, and execution reuses `effects.ts` — an ability's
effect is just an effect.

- **An ability on the Chain has no card representing it** (377.3.a.1). That is
  why `ChainItem.ability` exists: `entity` points at the ability's *source*, and
  the source stays exactly where it is. A resolved Spell goes to the trash; a
  resolved ability leaves its source alone.
- **Activated abilities are gated by four rules, not convenience**: 381 (the
  controller's own turn, Open State only), 380 (source on the Board), 377
  (the cost is payable, exhausting the source included when printed — 414) and
  801.1 (a Dependent Keyword's condition holds).
- **A trigger with anything to decide goes on the Chain *pending*, and rule 402
  is why.** Rule 400 keeps an Ability a Pending Item until it has completed the
  steps of playing, and step 2 (402) holds *both* decisions: 402.1 is the "you
  may" and 402.2 is "all choices required for this ability, such as targets,
  modes, or other relevant decisions". So one `resolveTrigger` action carries
  both, `legalActions` offers one per legal target, and a pending item is the
  only thing its controller may do until they answer.

  **This is the one decision point a Triggered Ability has, and it is not
  mid-resolution.** An earlier version of this file claimed 402.2 needed the
  sub-action protocol; it does not — the protocol is for choices *inside* a
  resolving multi-step effect, and this one is a step of playing the ability.
  Getting that wrong left `queueTriggers` carrying `null`, which made every
  targeting trigger resolve into nothing: 8 of the 45 in the real corpus were
  silently doing so, cards that ingested cleanly and looked modelled.

  Two rules fall out of the same step. **402.4**: an ability with no legal
  choice available is removed at step 2 and never becomes a Finalized Chain
  Item — 402.4.a is explicit that this is *not* being countered, so nothing
  observes it. **402.4.b**: its controller may not decline this stage, so
  `perform: false` is offered only for a genuine "you may" (383.3.e.2.b).
- **`triggersUsed` counts per-turn limits** (383.3.e), keyed by source and
  ability index and cleared in the Ending Phase.

#### Triggers are event-driven

**The reducer raises a `TriggerEventInstance`, and every ability on the Board is
asked whether it cares.** The reverse arrangement — look abilities up by a
closed set of condition variants — is what this used to do, and it could not
express "when a *friendly* unit dies" at all, because the lookup only ever
consulted the dying Unit.

A `TriggerCondition` is three things rather than one variant:

| Field | Rule | What it says |
|---|---|---|
| `event` | 383.2 | What happened: `played`, `dies`, `conquer`, `hold`, `move`, `winCombat`, `attack`, `defend`, `buffed`, `stun`, `discard`, `activateAbility`, `ready`, `recycle`, `spendBuff`, `chosen`, `beginningPhase`, `endOfTurn` |
| `subject` | 383.1 | Whose: `self`, `you`, `friendly`, `enemy`, `any` |
| `filter` | 383.1 | Which: card type, `excludeSelf`, a cost floor, `here`, an ordinal |

This shape came out of measuring the corpus, not from taste. At the level of
literal wordings the tail is **flat** — the most common condition a narrower
grammar missed appeared *twice* — so 23 more variants would have bought 23
cards and no structure. The category is the win.

Four things about it are load-bearing:

- **`subject` is required, not defaulted.** "When I die" and "When a friendly
  unit dies" are both plausible readings of an absent subject, and guessing
  silently is the wrong-but-plausible card the gap model exists to prevent.
- **`objects` is a list.** A Combat is won by *every* surviving Unit on the
  winning side (466.3), so "When I win a combat" must match each of them from a
  single event while "when you win a combat" fires once. One event per Unit
  would fire the second one per survivor.
- **Subject and filter are satisfied by the *same* object.** "Another friendly
  unit" has to be one Unit that is both, not one that is friendly and a
  different one that is another.
- **`triggersFor` takes `extraSources`.** A corpse is off the Board, so its own
  Deathknell would never be found; naming it keeps it a candidate *without*
  making it the only one, which is what lets a bystander see the same death.

**A trigger filter may be about the event rather than its object**, and two of
them have to be. `byController` constrains the *actor* where `subject`
constrains the object — "when **you** choose me" needs both, and an opponent
pointing a spell at the same Unit is a different event. `bySource` is the type
of the card that *caused* the event: read as `cardType`, "with a spell" would
ask whether the chosen Unit is a Spell and never hold, which is a card that
never fires rather than a card that fires wrongly.

**A Move carries both its ends** (446). `battlefield` is the Destination and
`origin` is where the Unit started, noted before the move because afterwards it
is already at the Destination. `filter.direction` picks which one a Location
filter is about, and `notHere` is the mirror of `here` — its own field rather
than `here: false`, because an absent field has to keep meaning "impose
nothing".

**`attack` and `defend` are rule 464.2.c.3's designations, not the Move that
caused them.** They are raised when Combat opens, for every Unit the Attacker or
Defender controls at the Contested Battlefield, which is the moment the
designation applies and 464.2.e collects what it triggered. The Attacker's event
goes first, which is 464.2.e.1's order. 464.2.c.3.a is not modelled: a Unit that
arrives *later* gains its designation in the following Cleanup and raises
nothing — `mightOf` still reads the role off the Showdown, so Assault and Shield
are unaffected and only a "when I attack" on a latecomer is missed.

`filter.ordinal` and `limitPerTurn` are different things and both exist: the
ordinal picks *which* occurrence fires ("your second card in a turn"), the limit
caps *how often* the ability may ("the first time … each turn").

**A clause naming two conditions is two abilities, not one disjunction.** 383.2
gives a Triggered Ability exactly one condition, so "When I attack **or**
defend, …" parses into two abilities sharing one effect — and a card printing
two trigger *sentences* is two as well, which is why `parseLine` returns a list.
Reading it as a disjunction would need a `TriggerCondition` shape no rule
describes.

Three things keep that split from eating cards it should not:

- **The whole clause is tried first.** "When you play a unit or gear" is one
  condition, and splitting it would lose the card. The split is a fallback,
  never a rewrite.
- **The subject is carried over.** "When I attack or defend" prints it once, so
  a half that does not parse alone is retried with the first half's subject in
  front — and only on failure, so a half that already reads is left alone.
- **A missing comma is a last resort.** "When I conquer play a Gold gear token
  exhausted" prints none, so a line that opens with the trigger wording and
  contains no comma at all offers each word boundary as the split, taking the
  first that yields *both* a condition and an effect.

### Static and passive abilities

Rules 363-365, data in `cards/static.ts`, engine in `engine/statics.ts`.

**A static is never executed. It is *consulted*.** That one sentence is the
design. Rule 365.1 makes a Permanent's Passive Abilities active while it is on
the Board, and 365 stops them the instant it leaves — so `mightOf` asks "what do
the statics say" every time it is called, and nothing is ever written onto the
Unit being modified. Model "other units here have +1 Might" as an effect instead
and the +1 stays behind when the granter dies.

A static is a **scope plus a grant**, the same shape the trigger grammar
settled on and for the same measured reason: the literal wordings are flat (108
distinct clauses over 113 occurrences) while the categories are few.

| Field | What it says |
|---|---|
| `affects` | `self` / `friendly` / `enemy` / `any`, plus `here` (355.9), `excludeSelf` for "other", `tag` (133.8) for "your Mechs" and `token` (185) for "your tokens" |
| `grant` | `might`, `keywords` (801.3.a), `abilities` (801.3.a, for a keyword that *is* one), `entersReady` (replacing 359.2.c), `playTo` (355.2.b) |
| `condition` | "While I'm buffed", "While I'm at a battlefield" — about the **source**, not its objects |

Five things are load-bearing:

- **The engine must never read `card.keywords` directly.** A granted Tank is as
  much a Tank as a printed one, so `combat.ts` and `move.ts` go through
  `unitHasKeyword` / `unitKeywordValue`, which consult `keywordsOf` — printed
  plus granted. There are exactly three such read sites and they are the reason
  this was cheap to add.
- **A static condition may not look at Might.** `mightOf` consults statics, so a
  condition that read Might back would recurse. `StaticCondition` is deliberately
  narrow for that reason, not for lack of ambition.
- **`entersReady` is asked *before* the card moves to the Board.** "Other
  friendly units enter ready" must not reach the card carrying it, and once that
  card is on the Board the sweep cannot tell it apart from the units it is
  talking about. 359.2.c is about how a card enters, so before the move is also
  when the rules ask.
- **A grant may be an *ability*, and that is what "Friendly units have DEFLECT"
  needs.** 801.3.a makes a granted keyword do exactly what a printed one does —
  so a keyword the ingest *desugars* has to be granted as the thing it desugars
  into: 809.1.c is a `CostModifier` and 817.1.b is a Play Effect, neither of
  which is a `Keyword`. `desugarKeyword` in `ingest/text.ts` is that expansion,
  written once and read by both the printed line and the grant, because two
  expansions of one keyword would eventually disagree.

  In the engine, `grantedAbilities` answers "what does this static give *this*
  Game Object", and the three sweeps that ask what a Game Object can do —
  activation, triggers and cost modifiers — all include it. `AbilityRef.granted`
  is what lets `abilityFor` read the text back off the *granting* card once the
  ability is on the Chain.

  **A granted static is deliberately not honoured**, and the reason is a cycle:
  `activeStatics` would have to gather what it had just produced. It reads
  printed and Attached abilities only, and the parser refuses the shape.

  It also costs measurably: `grantedAbilities` is a Board sweep and the trigger
  sweep runs on every event, so `anyAbilityGrant` checks the game's *definitions*
  first — a single allocation-free pass that answers `false` for almost every
  deck. Without it the search agent's suite ran 60% slower.
- **A `self` static is read off the card in hand**, exactly like a `self` cost
  modifier, because that is where the card still is when the question matters.
- **`tag` and `token` are the same idea and only one of them works today.**
  Both narrow a scope to a kind of Game Object rather than to a controller.
  `token` is answerable because 185 makes being a Token a property of the object
  and `isTokenCard` reads it; `tag` is answerable in the *engine* and not in the
  *data*, because the export publishes no tag field. Both are parsed, and
  `apitcg.ts` records a `tags` gap for the second — refusing the clause instead
  would hardcode one source's shortfall into a parser shared across sources.
  See [Card data](#card-data).

**Battlefields carry these too** (170.8). `BattlefieldState.entity` is the Game
Object `activeStatics` finds, and 170.5 makes a Battlefield *a Location*, so its
own entity sits at its own index — which means `here` on one of its statics
resolves to itself with no special case at all. "Units here have +1 Might" is
one scope-plus-grant static like any other.

A Battlefield's Passive is swept regardless of who Controls it, because 170.5
makes it a property of the Location. Its *Triggered* and *Activated* abilities
are scoped to the controller instead: every one the corpus prints speaks of
holding or conquering, so an Uncontrolled Battlefield (170.11.b) offers nobody
its abilities.

### Dynamic values

`cards/count.ts` holds the data, `engine/count.ts` evaluates it.

**One `Count` type, for the same measured reason `Condition` is one type**: the
corpus asks the same arithmetic in three places — a cost discount ("I cost 1
less **for each card in your trash**"), an effect's amount ("draw 1 **for each
of your MIGHTY units**") and a static's grant ("I have ASSAULT **equal to the
number of enemy units here**"). `CostCount` is now an alias of it, and
`Condition`'s `controls` predicate is answered by the same sweep asked for a
yes/no — one implementation, so the two can never disagree about what "another
unit here" means.

A count is *asked*, never executed, exactly like a condition.

Four things are load-bearing:

- **"Equal to N" and "+1 for each N" are the same arithmetic**, so `per` is one
  field that multiplies whatever the grant or effect gives. 807.1.b.3 makes a
  bare ASSAULT 1, which is exactly the per-unit value a count then scales.
- **A count that reads Might may never appear in a static's grant.** MIGHTY is
  rules 706-709 — a *description*, not a keyword, true exactly while Might is 5
  or greater — so counting Mighty Units calls `mightOf`, which consults statics,
  which would recurse straight back. The parser refuses that combination, and
  `staticMight` hands `countOf` no Might function as the belt to that braces:
  such a count reads 0 rather than hanging. The same reasoning already keeps
  `Condition` from reading Might.
- **A cost discount *may* read Might.** `mightOf` consults statics and cost
  modifiers, not costs, so there is no cycle back — which is why `countFor`
  passes `mightOf` through where `staticMight` does not.
- **"You or allies" reads as "you".** The engine models no teams and no
  sanctioned Mode of Play has any (485 is the 1v1 Duel), so a player's allies
  are nobody and the two readings coincide everywhere this engine can be played.
- **The source is a count too, and that is what "deal damage equal to my Might"
  needs.** `sourceMight`, `sourceKeyword` and `points` read off the effect's own
  source and its controller rather than off a Board sweep — the same arithmetic
  in a different place, so `dealDamage` and `giveMight` took the `per` field
  `draw` already had rather than each growing an amount type.

  `readsMight` answers for `sourceKeyword` as well as `sourceMight`, because
  `keywordsOf` consults statics exactly as `mightOf` does: a static granting a
  keyword whose value counts a keyword would recurse the same way. `points` is
  safe in a grant — it sits on `PlayerState` and touches neither.
- **`COUNTS` is first-match-wins, and its last rule reads any unknown noun as a
  tag.** So a new count has to be ordered *before* that one: "your points"
  added at the end became a count of Units tagged "point", which parses, looks
  right, and is always 0. That is the plausible-and-wrong card the gap model
  exists to prevent, produced by rule order rather than by a missing mechanic.

### State predicates

`cards/condition.ts` holds the data, `engine/condition.ts` evaluates it.

**One `Condition` type, because the corpus asks the same questions in four
places**: gating a static ("If you've discarded a card this turn, I have
ASSAULT"), gating "enters ready" ("I enter ready if you control another
Dragon"), gating a cost modifier ("If an enemy unit has died this turn, this
costs 2 less") and gating an effect ("When you play me, if you control a Poro,
buff me and draw 1"). Four subsystems that already existed, one predicate.

A condition is *asked*, never executed — the same discipline as a static.

| Variant | What it reads |
|---|---|
| `controls` | Board sweep: card type or `tag`, a `min`, whose, and `excludeSelf` for "another" |
| `scoreWithin` | Points against `config.victoryScore`, so a Mode of Play that changes it (483.3) still reads right |
| `didThisTurn` | `PlayerState.turnEvents`, a per-turn tally cleared alongside `playedThisTurn` |
| `buffed` / `atBattlefield` | The source. These were `StaticCondition` and are folded in so callers need not know which kind they hold |

Three things are load-bearing:

- **A source-relative condition is false without a source, and that is correct
  rather than a limitation.** A card in hand is not buffed and is not at a
  Battlefield. A *state* predicate has no such problem, which is what lets "I
  enter ready if you control another Dragon" work from hand.
- **`turnEvents` is counted in one place.** `raiseEvent` in `reduce.ts` both
  queues the triggers and increments the tally, because two things must happen
  for every event and splitting them is how one gets forgotten.
- **A predicate the state cannot answer is refused at ingest**, never read as a
  condition that quietly never holds — that would make the card permanently
  weaker than printed. "If you control a facedown card", "if I have moved twice
  this turn" and "if you've spent at least 2 Runes this turn" are all refused.
- **`controls` counts the whole Board, Runes included.** 161.1.a keeps a
  Channelled Rune on the Board until it is Recycled, so "while you have 8+
  runes" is an ordinary `controls` count rather than a predicate of its own —
  the Rune zone was simply missing from the sweep, which made that question
  quietly answer 0.
- **`controls` takes `here` (355.9)**, so "another unit here" is one predicate
  that is both. Source-relative like `StaticScope.here`: a source in a Base
  names no Battlefield, so the count is 0 rather than the whole Board.
- **A "While …" the grammar cannot read fails the card.** `parseStatic` routes
  every "While <predicate>," through the shared state-predicate grammar, naming
  only `buffed` and `atBattlefield` specially because those are about the source
  rather than the state. Dropping an unreadable one would make the static
  unconditional, which is strictly stronger than printed.

### Guarded effect steps

`GuardedEffect` in `cards/effect.ts`, evaluated in `engine/effects.ts`.

**A branch is a guard on a step, not a tree.** "Deal 2 to a unit. If it's
stunned, kill it. Otherwise, stun it." is two steps carrying opposite
conditions, not an if/else node — which is why this needed no new executor and
no new shape in the effect model, only an optional `condition` on each entry of
`CardEffect.effects`. `Condition.not` is what makes the "otherwise" expressible
without a second field.

It reuses the state-predicate grammar wholesale, so a guard can ask anything a
static or a cost modifier can. What it adds is one variant, and that variant is
the reason the feature exists at all:

- **`targetIs` asks about the *chosen target*, which nothing else could.**
  Stunned, exhausted, damaged, buffed, a card type, an Attacker or Defender
  designation, friendly or enemy. `ConditionContext.target` carries it, and the
  pronoun is what the parser keys on — "if **it** is stunned" names the target
  where every other predicate names a player or a count.
- **`parseStatic` refuses a `targetIs`.** A static has no chosen target, so the
  predicate could only ever be false — the same rule that refuses a
  source-relative condition with no source, and for the same reason: a condition
  that quietly never holds is a card that plays weaker than printed.

Two things are load-bearing about *when* the guards are asked:

- **Every guard is evaluated against the state on entry**, before any step
  runs. Otherwise the "otherwise" branch would see what the branch above it did
  — stun a Unit in step one and the `not stunned` guard on step two stops
  holding, so both branches fire or neither does depending on their order.
  `effects.test.ts` pins that with a spell whose two steps would both apply if
  the guards were asked in sequence.
- **A guard is asked once per target**, inside the `all` loop rather than
  outside it, so "deal 2 to all enemy units, killing any that were already
  damaged" reads each Unit's own state.

The parser produces guards only through the state-predicate grammar it already
had; the full "Choose X. If Y, A. Otherwise, B." sentence shape is left to the
authored overlay, because it is a lot of grammar for a handful of cards and
[the tail is flat](#turning-text-into-effects).

### Counted targets

`TargetCount` in `cards/effect.ts`, enumerated by `targetChoices` in
`engine/legal.ts`.

**A counted target is one choice of a *set*, and that is why `targets` is a
list everywhere.** "Give two friendly units each +2 Might", "buff up to 2
friendly units" — rule 355.6 makes each chosen object a Target in its own
right, so the Action, the Chain item, the view and `EffectChoices` all carry
`readonly EntityId[]` rather than one id. A card naming one target holds a list
of one; a card naming none holds an empty list.

One field rather than a single `target` plus an `extraTargets`, for the reason
this codebase refuses second sources of truth everywhere else: two fields that
can disagree eventually do.

Four things are load-bearing:

- **The executor already had the loop.** 355.5.a's criteria set and a counted
  set reach the same place — a target-consuming step runs once per object while
  a step that takes no target runs once — so `executeEffect` asks
  `consumesTarget` and then walks whichever set it has. Nothing new executes.
- **The bounds mean different things and both are printed.** `min` equal to
  `max` is "**two** friendly units", which 355.8 makes unplayable when the
  board cannot supply them; `min` below `max` is "**up to** 2", where choosing
  fewer — or none — is itself a legal choice, and `legalActions` offers the
  empty set as an action.
- **Combinations, never permutations.** `legalTargets` fixes the order, so
  `targetChoices` generates by ascending index and never reorders: two actions
  naming the same two Units in different orders would be one choice offered
  twice. `isValidTarget` rejects a repeat for the mirror reason — naming one
  object twice would apply the effect to it twice from a single choice.
- **An unbounded count is refused, not approximated.** "Any number of friendly
  units" is 2^n actions, and the parser records it as a gap rather than
  guessing a bound. Every printing of it in the corpus is blocked on something
  else as well.

The parser reads the count off the *article*, which is what makes "two **other**
friendly units" one phrase rather than two captures: `unitTarget` already read
"another", and "other" is the same word with a number in front of it.

**"You may kill a gear" is the same mechanic.** An optional instruction with a
chosen target is a choice of *zero or one*, which `TargetCount` already states —
so the wording needed no `optional` flag on a step. It is refused on a clause
that chooses nothing: "you may draw 1" read as a bare draw would be mandatory,
which is a different and stronger card than the one printed.

### Object filters

`ObjectFilter` in `cards/effect.ts`, applied by `matchesFilter` in
`engine/effects.ts`.

**Both Board sweeps narrow the same way, and that is the whole point.** "Buff an
**exhausted** friendly unit" is a choice (355.6) and "kill all **damaged** enemy
units here" is a criterion (355.5.a), so `unit` and `all` ask at different
moments — but a filter that meant two things would be two sweeps drifting apart,
so there is one shape and one implementation.

Three things are load-bearing:

- **Every field is a state stored on the entity, never a computed one.**
  `mightOf` is deliberately absent, so a filter can be asked from anywhere —
  including places a Might read would recurse. `maxMight` stays on `unit` alone
  for that reason: it is asked only at play time.
- **The parser reads the adjectives out of the scope capture**, so every clause
  that already names a scope gained the narrowing without a pattern change. An
  adjective the table does not know **refuses the phrase**: read as noise it
  would widen the card past what it prints.
- **A capitalised noun that is not a card type is a tag** (133.8), which is how
  the corpus prints one. A *lowercase* unknown noun is a shape the grammar has
  not read rather than a tag it should invent, so only the capital qualifies.
  The tag matches nothing while the export carries none — see
  [Card data](#card-data) — and `apitcg.ts` records the gap.

This landed with a real bug of exactly the kind it exists to prevent: three
clause rules assembled the `all` spec inline, and none of them honoured the
adjective, so "kill all damaged enemy units here" parsed cleanly as "kill all
enemy units here". `allTarget` is now the single builder, the counterpart to
`unitTarget` and there for the same reason.

### Keywords

Rules 800-828, with the data in `cards/keyword.ts`. Rule 801 says a Keyword is
"a shorthand for a specific game effect", and the glossary means it literally —
every entry gives an expansion, "functionally short for …". That sentence is the
whole design, and it sorts keywords into three kinds:

| Kind | Where it lives | Examples |
|---|---|---|
| Shorthand for something already modelled | **desugared at ingest**, never reaches the engine as a keyword | Deathknell → a `dies` trigger (808.1.c); Temporary → a Beginning Phase self-kill (816.1.b); Action/Reaction → `SpellCard.timing`; Equip → an Activated Ability that Attaches (818.1.c.2); Quick-Draw → Reaction plus a Play Effect that Attaches (819.1.d) |
| A genuine engine rule | `Keyword` on the card | Assault, Shield, Tank, Backline, Ganking |
| A gate on an ordinary ability | `AbilityDependency` on the ability | Legion (812), Level (824) |

**Desugaring is not a shortcut, it is the point.** Giving the engine a second
way to say "when I die" is how two code paths drift apart, so a keyword that
*is* an ability becomes that ability and nothing else.

The five modelled as engine rules are the ones no effect can express:

- **Assault X / Shield X** (807.1.c, 814.1.c) are Might while the Unit holds the
  Attacker or Defender designation. `mightOf` takes a `CombatRole` rather than
  reading the Showdown off the state, because 807.1.d conditions the keyword on
  the *designation*, and the view, the heuristic and the invariant checker all
  want the plain number. The role is threaded through `sumMight`,
  `lethalRemaining` **and** `hasLethalDamage`: Might is one stat for damage
  dealt and damage survived, so a Shield that only raised the damage dealt would
  be half a keyword.
- **Tank / Backline** (815.1.b, 826.3) are exact mirrors — assigned lethal
  damage before, or after, every same-controller Unit without the keyword — so
  one rank function states both, and it sorts `assignDamage`'s targets. 815.1.c.1
  keeps 465.2.c.3 intact: they reorder the targets, they do not relax lethal-first.
- **Ganking** (810.1.b) adds Battlefield-to-Battlefield to the Standard Move.
  810.1.c.1-3: it only *adds* a destination, is not an extra Move, and has no
  cost of its own — the exhaust of 144.2 is still the whole price.

**Everything else is refused with a stated reason**, in `UNMODELLED_KEYWORDS`, so
the parser can cite it. Rule 002 makes card text supersede the rules, so a card
whose keyword is ignored is being played wrong — a Tank that forgets it is a
Tank is a wrong card, not a simpler one.

Two consequences worth knowing:

- **A keyword granted by an effect is never read as the card having it.** "Give
  a unit ASSAULT 3 this turn" is a `grantKeyword` effect on a chosen Unit, not
  a keyword on the card that says it — mistaking the two would give the wrong
  Unit the keyword, permanently. The keyword patterns stay anchored to a whole
  line for exactly that reason, and the grant is a separate clause rule. See
  [Effect primitives](#effect-primitives).
- **Only keywords the engine models can be granted.** `keywordNamed` reads the
  same `MODELLED_KEYWORDS` table the printed form does, so "give a unit DEFLECT
  this turn" is refused: 801.3.a makes a granted keyword do exactly what a
  printed one does, and granting one the engine ignores is the same wrong card
  as printing it.
- **Keywords ride the same all-or-nothing rule as everything else.** A card
  whose other clause is unreadable keeps neither. That is why only 14 ingested
  cards carry a keyword while 105 parse fully.

`Keyword` stacking follows the rules rather than the callers: valued keywords
sum (807.2, 814.2) and unvalued ones are redundant (810.2, 815.2, 826.5), which
is what `keywordValue` and `hasKeyword` are for.

**Legion needs identities, not a count.** 812.1.c satisfies it when "a card
*different than* the one with the Legion ability" has been Finalized this turn —
and a card's own Play Effect is checked while that card is already in the list.
So `PlayerState.playedThisTurn` holds entity ids; a count would satisfy every
Legion trigger on the first card played. It clears in the Ending Phase, because
812.1.c scopes it to "the same turn".

### Attachment

Rules 434-435 and 716-719, with `GearCard.attached` in `cards/card.ts` and the
engine in `engine/attach.ts`.

**The direction reads backwards from the card text, and getting it wrong
inverts everything else.** A Gear is what gets *Attached*; the **Unit** becomes
the Top-Most Card (818.1.b.2). So "Equip a unit" attaches the Gear **to** the
Unit, and from then on 718.3 appends the Gear's Effect Text abilities to *the
Unit's* Rules Text and 718.4 adds its Might Bonus to the Unit's Might. "Me" in
a Gear's Effect Text is the Unit.

Five things are load-bearing:

- **A card has two halves that are never live at once.** 718.2 makes an
  Attached card's printed Rules Text Inactive and 724 makes its Effect Text
  Inactive unless Attached. That is why `GearCard.attached` is a separate field
  rather than more entries in `abilities`: collapsing them would give an
  unattached Gear abilities it does not have, and let an Equipped one
  re-activate its own Equip and walk itself onto another Unit.
- **`activeAbilities` is the single answer to "what can this Game Object do".**
  Four sweeps used to read `entityCard(state, id).abilities` directly — the
  activation sweep, the trigger sweep, the static sweep and the cost-modifier
  sweep — and all four now go through it. Adding a fifth reader that skips it
  is how an Equipment silently stops working.
- **`AbilityRef.from` separates whose ability it is from where the text is.**
  The *source* is the Top-Most Card, because 718.3 makes the ability part of
  that card's Rules Text — so "when I conquer, buff me" on an Equipment means
  the equipped Unit conquering and the equipped Unit being buffed. `from` names
  the Gear, because the ability's text is still printed there and has to be
  findable. It also keys 383.3.e's per-turn limit, so two Gear at the same
  ability index do not share one counter.
- **719.5 takes attachments off the Board with their Top-Most Card**, which is
  why `sendToNonBoardZone` recurses. A token attachment still stops existing
  (186.1) on the way, because that funnel is the same one.
- **The Might Bonus is a bonus, not a Buff.** 137.3.a applies it only while
  Attached and stops the instant it is not, so `attachedMight` is *consulted* by
  `mightOf` the way a static is, and nothing is ever written onto the Unit.

**Weaponmaster (821) is the one effect that pays something.** 821.1.c is a Play
Effect that chooses an Equipment you control and pays *that card's* Equip cost,
reduced by `[A]`, to Attach it to the Unit — the opposite direction from
`attach`, because the text is printed on the Unit rather than on the Gear. The
cost is read off a target chosen at 402.2, so it cannot be settled at step 3
the way every other cost is; 821.1.c.5 makes an unpayable one leave the
Equipment exactly where it was, which is what makes paying at resolution safe
rather than a way to strand the game. `equipAbilityOf` finds the Equip ability
by what it *does* — the Activated Ability whose effect is an `attach` — because
818.1.c.2 defines Equip as exactly that, and a separate marker would be a
second source of truth.

**Deflect (809) is the one cost modifier that depends on a choice.** 809.1.c
makes a Spell or Ability an opponent controls cost `[A]` more *for choosing this
Game Object*, so the same card in the same hand has two Total Costs depending on
where it is pointed. That is why `totalCost` takes the chosen target and
`CostFilter` gained `choosesSource` — and why `legalActions` re-asks
`affordable` per target instead of once per card. `playableFromHand` still gates
on the untargeted cost, which is a *lower* bound because every `choosesSource`
modifier is an increase; a choice-dependent discount would need that gate to
move rather than this one.

**`[A]` is Power of any Domain (135.2.e.5), and it is a `Cost` field of its
own.** Not more entries in `power`: the Domain is not unknown, there is none.
`canPay` asks it as one question about the *surplus* across every Domain once
the named ones are covered, because asking each Domain separately would let one
spare pip pay two `[A]`. 821.1.c.3 — "a cost that does not contain `[A]` will
not be reduced" — needs no code at all: subtracting from zero is already that.

**Ingest reads the two halves out of one flat string.** The export publishes
Rules Text and Effect Text as one `description` with no marker between them, so
the split is inferred from the Equip line: 818 makes Equip an Activated
Ability, which 724 would make Inactive if it were Effect Text, so everything
printed *below* Equip is the Effect Text. 137.1's Might Bonus is peeled off the
last line only when that line does not otherwise parse — which is what keeps
"give a unit +2 Might this turn" intact while still reading "TANK +1 Might",
"Might +0" and "When I conquer, buff me.+1 Might".

### Hidden and the Facedown Zone

Rules 811 and 421, with the engine in `engine/hidden.ts`. The only keyword that
adds an **action** rather than expanding into one that exists — 811.1.c.1 says
Hide is not a subset of Play — which is why it is a rule of the engine rather
than a desugar at ingest.

**Rule 107.3.e is the whole design: a Facedown Zone is not a Location.** A
facedown card is not *present at* the Battlefield, it is associated with one. So
the card lives in its controller's `facedown` player zone and `Entity.hiddenAt`
names the Battlefield — the same shape as `attachedTo`, and for the same reason.
Nothing that reads a Battlefield's occupants can see it, which is what keeps a
facedown card out of Combat, out of `units`, and out of every sweep that asks
who is somewhere. Adding a third `Location` variant would have put it in all of
them.

| Rule | What it says | Where |
|---|---|---|
| 811.1.b | Your turn, Open State, from hand or Champion Zone, pay `[A]` | `hideCard` in `reduce.ts` |
| 107.3.b | One card per Facedown Zone | `hideDestinations`, and an invariant |
| 107.3.c | Only at a Battlefield you Control | `hideDestinations` |
| 811.1.b | Playable "beginning on the next turn" | `hiddenOnTurn`, against `state.turn` |
| 811.1.b | Played "ignoring its base cost" | `totalCost` over a `FREE` base |
| 811.6 | Reaction while facedown | `timingAllows` is skipped |
| 811.1.d.1 | A Permanent enters at *that* Battlefield | `facedownEntersAt` |
| 811.1.d.2 | Choices restricted to that Battlefield | `allowedFromFacedown` |
| 107.3.d | Lose Control, removed at the next Cleanup | `cleanupFacedown` |
| 107.3.f, 128.4 | Zone public, card Private to its controller | `view.ts` |

Four things are load-bearing:

- **The base cost is ignored, not the total.** 811.1.b plays a facedown card
  "ignoring its base cost", so `totalCost` runs rule 356's layers over a `FREE`
  base rather than skipping them. 356.1.b.3 is explicit that an ignored Base
  Cost is not a floor, so a Deflect increase (356.3) still applies — the card is
  free to play but not free to point at a Deflecting Unit.
- **The view exposes *where*, and redacts *what*.** 107.3.f makes the Facedown
  Zone a Public zone holding Private cards, and 128.4 gives that privacy to the
  card's **controller** rather than its owner. So every player sees that
  something is hidden and at which Battlefield, and only its controller sees
  which card. An agent needs the first half to reason about a threat it cannot
  identify, which is the entire point of the mechanic.
- **811.1.d.2's escape hatch is not modelled.** A hidden card's choices are
  restricted to its Battlefield "unless the ability explicitly restricts
  targeting in a way that makes this impossible" — deciding that needs to reason
  about a target spec's *satisfiability* rather than evaluate it. The
  restriction is enforced without the escape, so such a card is played more
  narrowly than printed. That is the safe direction: it can never make an
  illegal play legal.
- **Hidden is a permission, not a restriction.** 811.3 keeps the ordinary play
  from hand available at its printed cost and timing, so nothing about this
  takes an option away.

### A Triggered Ability can cost something

Rule 403 with 356.7. "When I conquer, **you may pay 1 to** ready me", "When a
friendly unit dies, **you may exhaust me to** draw 1" — the most-printed shape
left in the corpus once the keywords were spent, and it needed no new
vocabulary: `TriggeredAbility` gained the same `cost` / `exhaustSelf` /
`payments` an `ActivatedAbility` has always carried.

**What differs is *when* it is paid.** An Activated Ability pays at activation;
a Triggered one has no activation, so the price is settled at **402.2**, the
same step that settles its target. That is the one place a Triggered Ability
makes choices, so putting the payment anywhere else would need a second
decision point that does not exist.

Three things follow:

- **A price is always paired with `optional`.** A mandatory one would have to
  strand the game when it could not be paid; the corpus prints none, and
  `legalActions` offers only the decline when an optional one is unaffordable.
  402.4.b then makes declining the only move, which is right — there is nothing
  else to do.
- **Every price verb is also an effect verb**, so the parser splits only on a
  " to " whose lead parses *entirely* as a payment. "You may kill a gear" is an
  effect and "you may kill me to move an attacking unit" is a price; without
  that rule the first became an unreadable card, which is how it was caught.
- **A Play Effect cannot cost an exhaust.** 359.2.c enters a Unit exhausted, so
  the price is unpayable the moment it would be paid. The engine refuses it
  rather than waiving it, which is the same direction every other refusal takes.

### Non-resource ability costs

Rule 356.7 and 377.1, with the payments in `cards/additional-cost.ts` and the
engine in `additional.ts`.

**An ability's cost and an Additional Cost are the same thing**, so they share
`CostPayment` rather than each having a vocabulary: both are an action
performed to pay rather than a number subtracted, and both are gated by the
same rule — 416.3 and 422.3 each say such a cost must be *completable* before
it counts as paid. So an ability whose payment cannot be performed is simply
not offered, which is the rulebook's own worked example: Vi Destructive with an
empty trash "can't activate the ability, because they can't pay its cost".

Two payments were added for it. `recycle` is 416.6's "Recycle N from your
trash", and 416.1 sends the cards to the **bottom of their owner's** Main Deck
— 416.1.c is explicit that each player Recycles to their own deck regardless of
who was instructed, which matters the moment an effect puts an opponent's card
in a trash. `killSelf` is "Kill this", separate from `kill` for the same reason
`exhaustLegend` is separate from exhausting a Unit: naming a specific Game
Object is what makes a cost expressible with no choice point.

**416.5's random ordering is not modelled**, and the reason is that it is
unobservable: two or more cards Recycled together go to the bottom "in a random
order", but the deck is shuffled on a Burn Out (431.2.b) and drawn from the top,
so a fixed order among a few cards at the bottom cannot be distinguished until
then. Doing it properly would put the RNG on the payment signature for no
reachable difference.

The cost *lead* is now read by the same `parseResourceCost` an Equip cost uses,
which is what let Power into an ability's cost — `ActivatedAbility.cost` was
always a full `Cost`, and only the parser's regex was Energy-only. That change
measured +0 cards on its own and was kept anyway, because it deletes a special
case rather than adding one. That is the distinction from the Recycle *effect*
primitive, which measured +0 and was removed: it added surface area.

### Predict, and the second window into hidden information

Rule 436, with Vision (817) desugaring into it and the reveal in `view.ts`.

**436.1 makes a Predict two things: a look and an optional Recycle.** The
Recycle half is `recycleTop`, the one place a Recycle appears as a card
*effect* — 416.6's "Recycle N from your trash" is a cost, and a plain targeted
Recycle measured +0 and was removed. The optional half needed nothing new:
383.3.a's "you may" and 402.1's decline already exist, so Vision is an
`optional: true` Play Effect and declining *is* 436.1's "or not Recycle it".

**The look is the part that had to be built, and it is a view rule.** The Main
Deck is hidden from everyone including its owner (128), and 436.1 opens a
one-card window into it. `PlayerView.predicting` is that window: the top card
of a player's own deck, revealed to them alone, and only while they control a
pending Chain item whose ability Recycles from the top. Anything broader would
leak the deck; anything narrower would make the controller decide blind, which
is a strictly weaker card than the one printed.

436.4.a is worth stating because it inverts the usual rule: Predicting with too
few cards Predicts as many as possible and is explicitly **not** a Burn Out. So
`recycleTop` takes what it can and stops, where a draw would hand an opponent a
point (431.2.c).

This left **Repeat as the only keyword still refused**, and its reason has been
a measurement rather than a blocker since the Accelerate round.

### Stun

Rule 423, with `Entity.stunned` in `state.ts` and the effect in `effects.ts`.

**The asymmetry is the whole mechanic, and it is easy to get backwards.**
423.1.b stops a Stunned Unit *dealing* combat damage; 423.1.c leaves the damage
needed to *kill* it at its full Might. So `sumMight` reads the status and
`lethalRemaining` and `hasLethalDamage` deliberately do not — the same split
Assault and Shield already live on, where one number answers two questions.

Three other things are load-bearing:

- **423.1.a.1 makes the trigger fire on the *change*, not the instruction.**
  Stunning an already-Stunned Unit is legal and does nothing, and the
  rulebook's own Eclipse Herald example says it must not trigger. So
  `executeEffect` returns early on an already-Stunned target, before raising
  the event. Eclipse Herald is a real card in the corpus and now ingests.
- **It expires with the "this turn" effects.** 423.1.a.2 puts Stunned in the
  same end-of-turn Cleanup as `mightBonus` and `grantedKeywords`, so it clears
  in that sweep rather than one of its own.
- **A `stunned` count is safe inside a static's grant**, unlike `mighty`.
  Being Stunned is stored on the entity, so reading it cannot recurse back
  through `mightOf` the way counting Mighty Units would.

Building this surfaced a bug that had nothing to do with Stun: **the Chain was
rebuilt from the pre-resolution copy**, so every Triggered Ability a resolving
effect queued (383.3.c) was created, reported in the event log, and then thrown
away. A Deathknell from a Kill Instruction and "when you buff" from a Buff were
both doing it. `resolveTop` now splices the resolved item out of `next.chain`
by its index instead of slicing `state.chain`, which keeps whatever resolution
appended. The fuzz harness's count of triggers finalized with a chosen target
went from 377 to 655 across the same 300 games.

### Static restrictions

Rule 002 with `Restriction` in `cards/static.ts` and three lookups in
`engine/statics.ts`.

**A static is a scope plus a grant; a restriction is the same shape with the
opposite sign.** "Units can't move to base", "opponents can't score points", "I
can't be chosen by enemy spells and abilities" — rule 002 makes card text
supersede the rules, so removing a permission is the same kind of statement as
adding one, which is why `forbid` sits on `StaticGrant` beside `keywords` and
`playTo` rather than becoming a parallel mechanism.

Each variant names one rule the engine already enforces, so honouring it is a
check at the one place that rule lives:

| Restriction | Rule | Where it is asked |
|---|---|---|
| `moveToBase` | 449.1 | `standardMoveDestinations` |
| `playHere` | 355.2 | `validUnitLocations` |
| `chosenByOpponent` | 355.6 | `legalTargets` |
| `score` | 467 | `conquer`, the Scoring Step, and the `score` effect |
| `readyByEffect` | 419 | the `ready` effect |
| `playAwayFromBase` | 355.2 | `validUnitLocations` |
| `playCards` | 358.4 | `playableFromHand` |
| `activateAbility` | 377, 380 | `activatableAbilities` |

Three things are load-bearing:

- **The scope means different things for different variants, and it has to.**
  `moveToBase`, `chosenByOpponent` and `readyByEffect` are about a Game Object
  and read `affects` the ordinary way (`objectForbidden`); `score` and
  `playAwayFromBase` are about a *player*, so only `affects.who` is consulted
  (`playerForbidden`); `playHere` is about a *place*, and the place is the
  static's own source Location (`placeForbidden`). Every printed card matches
  one of those three readings — a Battlefield says "here" about itself, a Unit
  says "opponents" about players — so the alternative was a scope grammar with
  three unused halves.
- **`chosenByOpponent` is the mirror of Deflect, not a variant of it.** 809
  makes the choice cost more; this removes it. Its own controller may still
  choose it, which is what the `owner !== controller` guard says.
- **`RESTRICTIONS` in the parser is a closed table on purpose.** A wording that
  is *nearly* one of these — "units can't move from here to a battlefield" — is
  a different restriction the engine does not have, and reading it as the
  nearest match would forbid the wrong thing. Three of the nine restriction
  cards stay refused for exactly that reason: one wants a per-player turn count,
  one wants a reveal mechanic, and one is turn-scoped rather than static.

A forbidden Score does not happen at all, so 470's once-per-turn mark is not set
either — the Battlefield stays available on a later turn. And a Unit at a
Battlefield with `moveToBase` forbidden and no Ganking has *nowhere to go*: a
state the engine had never reached before. 250 fuzz games, 65,717 actions, all
decided, invariants holding.

### Where a Unit may be played

Rule 355.2. 355.2.a's default is the controller's Base or a Battlefield they
Control; **355.2.b lets a card widen that**, and 170.11 defines the two states
cards name — `open` is unoccupied *and* uncontrolled (170.11.c), `occupiedEnemy`
is one an opponent Controls with a Unit present (170.11.a).

It is a `StaticGrant`, so it is the same scope-plus-grant shape as Might and
keywords, and read from the same two places `entersReady` is: the card's own
`self` static from hand, because "you may play **me**" has to be answerable
before the card is anywhere, and the Board for the wider "friendly units may be
played to open battlefields". Three things follow:

- **It is a permission, so grants union and none can subtract.** The Base stays
  valid whatever a card says, and two permissions add two kinds of Location.
- **`validUnitLocations` takes the card, optionally.** Callers asking the plain
  355.2.a question pass nothing; `legalActions` and the reducer pass the card
  being played, and those two must agree or the reducer would refuse an action
  `legalActions` offered.
- **`here` is not honoured on one of these**, exactly as in `entersReady`: the
  entering Unit has no Location yet, so the scope cannot be judged rather than
  being guessed at.

### Flattened reminder text

Reminder text is parenthesised and stripped before parsing, but the export
sometimes publishes it *without* the parentheses — and then the glossary wording
for a keyword arrives where the keyword would be. 815.1.b and 826.3 are the
sentences "I must be assigned combat damage first/last", so those read as Tank
and Backline; a line that only restates a rule (702.3's one-buff cap, on a token
reference card) is understood and grants nothing.

`RULES_RESTATEMENTS` is a closed list of exact sentences on purpose. A *near*
restatement — "no more than **two** buffs" — is how a real ability gets silently
dropped, so anything not on the list stays unparsed.

### Tokens

Rules 179-187, data in `cards/token.ts`, engine in `engine/token.ts`.

**A Token is a Game Object but not a card (185), and every design decision here
is about which of those two halves a given caller needs.** A token carries a
synthesized `CardDefinition` registered in `state.definitions`, so `mightOf`,
`keywordsOf`, combat, statics and the trigger sweep read it exactly like a Unit
and need no second code path — that is what made this cheap. `isTokenCard` is
how the places that must tell them apart still can, and there are only three.

Four things are load-bearing:

- **186.1: a Token that reaches any Non-Board Zone but the Chain stops
  existing.** Modelled as permanent occupancy of `banishment` (438.5) rather
  than by deleting the entity, so a reference held on the Chain, in
  `playedThisTurn` or as a trigger source still resolves instead of throwing.
  It is deliberately *not* the trash: a banished token must not be counted by
  "for each card in your trash" or recycled by a Burn Out (431.2.b). Every site
  that moves something off the Board goes through `sendToNonBoardZone` for this
  — there are four, and a token has to stop existing at all four.
- **Rule 187 defines the tokens that exist, so `STANDARD_TOKENS` is a closed
  table and the parser *checks* the card against it rather than believing it.**
  A printed "4 Might Recruit" does not describe the Recruit of 187.1, so it is
  refused and recorded. Inventing one would put a Unit on the Board that no
  rule describes — the plausible-and-wrong outcome the gap model exists for.
- **A token's entry state is its *type's* default unless 184.1 overrides it,
  and that is why `ready` is a tri-state rather than a boolean.** 184.1 lets the
  creating effect name a state "if that state is contrary to the default for the
  token's type", and 185.2.d supplies the default: a Unit enters exhausted
  (359.2.c), a **Gear enters ready** (359.2.d). That is exactly why the corpus
  prints "play a Gold gear token **exhausted**" — for a Gear, exhausted is the
  override. Read as a boolean defaulting to exhausted, every Gold token would
  arrive asleep and the word would look like a restatement; read as one
  defaulting to ready, every Recruit would arrive with a free Standard Move.
  A static ("Your tokens enter ready") supplies the default when the creating
  effect names none, and loses to it when it does — the rulebook settles neither
  order, and this is the reading that keeps a card's own instruction meaning
  what it says.
- **185.3 leaves a token with no cost and no domain.** `FREE` and `[]` are the
  closest this model can state and neither is ever read: a token is Created on
  the Board (186), never played from a hand, so its cost is never paid and its
  domains never checked against a Domain Identity.

**The Gold token (187.5) is the one whose text is a mechanic.** Its whole
printing is "[Reaction] Kill this, [E]: Add [A]", which needs `[A]` *in the
pool* — see [Resources](#resources). Its Reaction tag is deliberately not
carried: 429.3 lets a Reaction Add be activated whenever resources are needed,
which this engine already approximates by making the pool fillable before a
play rather than during the Pay step, and an ordinary Activated Ability is
*narrower* than printed (381 confines it to the controller's own turn in an Open
State) — the safe direction, since it can never make an illegal play legal.

The Bird token (187.7) is in the table too, and its Deflect lands in
`costModifiers` rather than `keywords`, because 809.1.c makes Deflect a cost
increase rather than a `Keyword`.

**Battlefield tokens (187.8, 187.9) are still excluded**, but no longer for want
of a Game Object — Battlefields have one now. They need rule 438's Replace,
which swaps a card or token in place of another, and 652.2.a's rule that a
Battlefield leaving play is Replaced by a token Battlefield with no abilities.
None of that is built.

Token definitions are seeded into every game by `createGame` rather than
discovered from a deck list, because 181 supplies them with the game and they
appear in no deck.

### Effect primitives

`cards/effect.ts` holds the data, `engine/effects.ts` the interpreter. Adding a
primitive is a variant plus a case — never a code path per card.

Five of them encode a rule that is easy to get backwards:

- **A Kill Instruction queues the dying Unit's Deathknell *before* it reaches
  the trash** (428.1.a.1.b), because the trigger has to see it on the Board.
  Death by lethal damage is a *Passive* Kill (428.1.a.2) and does not follow
  that rule — combat queues its triggers after the move, the ordinary way of
  383.2.c. The two paths differ on purpose.
- **A Recall is not a Move** (456). It triggers nothing that watches Moves,
  cannot be blocked by anything restricting Movement (456.3), and leaves damage
  and statuses alone (458.1) — so it is not a heal and not a ready.
- **A Buff is a counter, not a Might modifier.** Each is +1 Might (703) and
  persists across turns, where `mightBonus` expires in the Ending Phase
  (317.2.c). Rule 702.3 caps a Unit at one, and a second is silently *not
  placed* (702.3.a) rather than being an error. `checkInvariants` enforces the
  cap. A Unit leaving play loses them (705).
- **A Might reduction with a printed floor measures against the *actual*
  Might, not the floored one.** 143.2.b treats a negative Might as 0, but
  143.2.b.1 is explicit that it "is not 0" and that "effects that calculate
  Might increases and decreases use the actual value" — so `actualMightOf` is
  the unfloored sibling of `mightOf`, and "-2 Might, to a minimum of 1" takes
  *nothing* from a Unit already below the floor rather than raising it to 1.
  Clamping the result to `>= 0` would have done exactly that.
- **A `move` is a real Move, and a Recall is not.** `move` Contests its
  Destination (450), can open a Showdown or Combat (451-452), and is followed
  by a Cleanup (453) — the same tail the Standard Move runs, shared as
  `afterMove` rather than duplicated. It costs no exhaust: that is the Standard
  Move's price (420.3.a), not an instructed Move's.
- **Channelling an empty Rune Deck is not a Burn Out.** Rule 430.3 channels as
  many as possible and stops; 431's Burn Out, and the point it hands an
  opponent, belongs to the *Main* Deck alone.
- **A granted keyword lives on the recipient, not on the granter.** "Give a
  unit ASSAULT 3 this turn" is `grantKeyword`, stored in
  `Entity.grantedKeywords` and expired by 317.2.c exactly like `mightBonus`.
  Modelling it as a static instead would be wrong twice over: a static grants
  to a *scope* rather than to a chosen Unit, and 365 stops it the moment its
  source leaves the Board — which for a Spell is immediately. Rule 801.3.a
  makes it indistinguishable from a printed keyword once granted, so
  `keywordsOf` returns printed, static-granted and this, and no caller can tell
  which is which. Only the "this turn" wording is read: a grant with no printed
  duration would have to persist, which is different storage.
- **A bounce is not a Recall, and both differ from a Kill.** Rule 412 lists no
  "Return" Game Action, so `toHand` is an ordinary zone move — which is exactly
  what separates it from a Recall (455), where the Permanent stays on the Board
  at its owner's Base and 458.1 leaves its damage and statuses alone. `toHand`
  takes it off the Board, so 705 strips its Buffs like any other departure, and
  it goes to the **owner's** hand rather than the returning player's.
- **Bounce and retrieve are one primitive with two targets.** "Return a unit at
  a battlefield to its owner's hand" and "return a unit from your trash to your
  hand" end in the same zone; only what they choose differs, which is why
  `TargetSpec` gained a `trashCard` variant rather than `Effect` gaining a
  second move. A Unit target is a Game Object on the Board (355.9.a.1) and can
  be damaged or killed; a `trashCard` is a card in a Non-Board Zone and can only
  be moved. Keeping them apart is what stops "deal 3 to a unit" reaching the
  trash. An empty trash yields no legal target, so 355.8 makes the card
  unplayable with no extra check.
- **A Counter is a removal from the Chain, and 425.1.b is the half that is not
  obvious.** 425.1.a clears the item and 425.1.a.1 trashes a cleared *card* —
  an ability has none to trash, the same asymmetry a resolving ability has
  (377.3.a.1). But a Countered card "is not considered to have been played",
  and that falls out of doing it here rather than by resolving the item into
  nothing: the `played` event was raised when the card went on the Chain, and
  Countering raises none. 425.1.c refunds nothing, which needs no code at all.

  It is also the one effect that can remove a Chain item *below* the one
  resolving, which is why `resolveTop` finds its own item by identity rather
  than by index. Chain items are never mutated in place, so that is sound —
  and by index it would splice out the wrong item.
- **A Token is Created, not played.** `createToken` puts it straight on the
  Board (186), so nothing is Contested and no Showdown opens — unlike `move`.
  Its `where` is rule 184.2's restriction and is fixed by the creating card, so
  it is not a `DestinationSpec`: that is a choice, and this is not one. See
  [Tokens](#tokens).

`XP` (728-733) sits on `PlayerState` rather than being an entity, because 731
says it is not a Game Object and cannot be targeted, readied or exhausted. It
has no cap (733).

`executeEffect` takes an `EffectContext` rather than reaching for the reducer:
drawing can cause a Burn Out, killing has to touch the Chain, and a Move runs
the Contest/Cleanup/Showdown tail — all of which live above this layer.

**"All units at a battlefield" is not a target choice either, and 355.5.a is
why.** An effect reaching Game Objects "based on criteria" is explicitly *not*
choosing, so `TargetSpec.all` is a separate variant rather than a flag on
`unit`: it is enumerated at *resolution* rather than at play time, needs no
choice, and 358.1's re-check does not apply to it. `legalActions` therefore
offers one action rather than one per Unit, and a Unit that arrived since the
card was played is included while one that died is not.

Three things follow:

- **The executor loops the `all` set over each *consuming* step.** "Deal 2 to
  all enemy units, then draw 1" must damage everything and draw once, so
  `consumesTarget` is what separates the two — a step that takes no target runs
  once whatever the spec says.
- **"at battlefields" and "at a battlefield" are different statements**, and
  the parser reads only the plural. The singular names *one* Battlefield the
  player picks, which `TargetSpec` has no variant for; reading it as the plural
  would hit every Battlefield on the board rather than the chosen one.
- **808.1.d.3 is what makes a Deathknell's "at my battlefield" work.** The
  ability resolves once its source is in the trash, where 359.3.e.12 leaves it
  no location at all, so the rulebook has the engine "note its location …
  before the card is moved to the Trash". That note is `ChainItem.noted`, set
  when the trigger is queued and consulted only when the source is no longer at
  a Battlefield. It has to be supplied twice over: a Kill Instruction queues
  before the move (428.1.a.1.b) so the Unit's own location still serves, but a
  Passive Kill (428.1.a.2) queues *after* it, so `combat.ts` names the
  Battlefield explicitly. Miss the second and the card is a silent no-op.

**Every clause that takes a target builds it with one function.** The phrase is
four orthogonal parts — an article (`a` / `another`), a controller scope, a noun
(`unit` / `gear`) and a place (`at a battlefield` / `here`) — and eight clause
rules used to assemble their own, which is how "another" came to be honoured
nowhere and "here" nowhere else. `unitTarget` in `ingest/text.ts` builds all of
them. `parseEffects` also tries a **whole-line** clause before splitting on
"and", because "and" is both a sequence joiner and part of single clauses:
"give a unit SHIELD 3 and TANK this turn" is one grant, not two halves.

**A Gear is a legal target for anything that moves or kills it, and for nothing
else.** `TargetSpec.unit` takes a `cardType`, defaulting to `unit`, because 428
kills any Permanent and 412's zone move does not care which — only the sweep
narrows. What a Gear cannot be is *damaged*, and no card says "deal 3 to a
gear", so the narrowing lives on the spec rather than on each effect. This is
separate from `TargetSpec.gear`, which is 821.1.c's "a Card **you control** with
the Equipment tag" and admits an already-Attached one.

### Bonus Damage

Rules 712-715, with `StaticGrant.bonusDamage` and `bonusDamage` in
`engine/statics.ts`.

**The scope reads differently from `might`'s, and has to.** `who` is about the
player *dealing* — "**Your** spells and abilities deal 1 Bonus Damage" — while
`here` is about where the *damaged* Unit is, as in "spells and abilities
affecting units **here**". That is the same split `objectForbidden` and
`placeForbidden` already make for restrictions, and a fourth reading of the same
scope shape.

Four rules land as one line each:

- **714**: every instance sums and applies once, which is what a single summing
  sweep gives.
- **714.1**: only a positive total applies, so `Math.max(0, …)`.
- **715.2**: a multi-target Deal gets the bonus *per target*, which falls out of
  asking inside the executor's per-target loop rather than outside it.
- **715.4**: no damage Dealt means no Bonus Damage — the same `dealt < 1` guard
  417.1.e already needed, so a 0-damage Deal is not turned into a 1.

**It reaches `dealDamage` and nothing else**, which is exactly the "spells and
abilities" every printing scopes it to: combat damage is assigned in
`combat.ts` and never passes through the effect interpreter.

**"The next spell you play deals 1 Bonus Damage" is a Delayed Passive with no
"this turn" printed**, and the rulebook says so in as many words — "The next
spell is a specific time, and the 1 Bonus Damage is a passive ability". So it
reuses `thisTurn` with `uses: 1`, and `spendDelayed` closes the window when the
spell is *played* rather than when it deals damage: a window on a spell that
deals none would otherwise never close.

Adding it also widened `parseStatic`'s verb list to include "deal", because
712 states this grant as a verb where every other is a possession. An effect
clause cannot be caught by that: "Deal 2 to a unit" has nothing before the verb
to read as a scope, and a test pins it.

### Looking at the top of the deck

Rules 424 and 390.5, with `Effect.look` and `TargetSpec.revealed` in
`cards/effect.ts` and `ChainItem.linked` in the engine.

**424.1.a.2 is the whole design: revealed cards stay in the zone they were
revealed from.** So a look moves nothing — it *notes* which cards, and the note
rides on the Chain item its Linked Ability becomes. Modelled as a zone the
cards move into, every question about the deck would then have to remember to
look in two places.

**The choice among them is not a decision point during resolution**, which is
why this needed no resumable executor. 390.5 makes "look at the top 3, put one
into your hand" two abilities — one that looks, and a *Delayed Linked Ability*
that references what it affected — and the second goes on the Chain Pending,
where 402.2 settles its target through the machinery a Triggered Ability
already uses. `legalActions` offers one action per card looked at, exactly as it
does for any other pending item.

Five things are load-bearing:

- **A Linked Ability has no card to look its text up on**, so `ChainItem.linked`
  carries the effect inline. That is the same asymmetry 377.3.a.1 already gives
  an ability on the Chain, one step further: not only no card *representing* it,
  but no ability index either.
- **A look is Private and a reveal is Public** (128.4 versus 424.1). The view
  redacts on `revealedToAll`: every player sees *that* three cards were looked
  at, because the act happens at the table, and only the looking player sees
  which. An agent needs the first half to reason about what just happened.
- **"Recycle the rest" is the complement of a choice**, which no `TargetSpec`
  can name — a spec says what may be chosen, and this is what was not. So it is
  its own verb reading `EffectInvocation.revealed` minus the chosen set.
- **431.1.c: looking at more cards than the deck holds is not a Burn Out.** It
  looks at as many as possible and proceeds, which is why `look` takes what it
  can and stops where a draw would hand an opponent a point (431.2.c).
- **`Effect.play` is zone-agnostic**, and this is what proved it: 354 moves a
  card to the Chain "from its current zone", so the verb that plays a card out
  of the trash plays one off the top of the deck unchanged. It was named
  `playFromTrash` until a second zone wanted it.

The parser reads the look and its disposition as **one statement across
sentences**, because 390.5 makes the second a Linked Ability *generated by* the
first — `parseSentences` would otherwise merge them as siblings and lose the
link. Three ordering rules fell out of that:

- **A whole-line read is tried before the sentence split**, since some
  statements span sentences.
- **A whole *sentence* is tried before the joiner split**, because "and" and a
  comma are each part of single clauses as well as separators: "reveal a gear
  from among them and draw it" is one clause.
- **"Otherwise" negates the sentence before it**, which is what `Condition.not`
  is for. Without the back-reference the branch would be unconditional and both
  halves would run.

### Delayed Passive Abilities

Rule 390.4, with `Effect.thisTurn` in `cards/effect.ts` and
`GameState.turnEffects` in the engine.

**A duration is a Passive with a window, and 390.1 is why that is the whole
design.** "A Delayed Ability can be any other type of Ability, and contains all
of the properties of that type in addition to the properties of Delayed
Abilities" — so `thisTurn` carries the ordinary `StaticAbility` or
`CostModifier` it *is*, and the window is the only thing it adds. Everything a
Board static can already say became turn-scopable with no second vocabulary:
`activeStatics` and `activeModifiers` each grew one branch rather than a
parallel system.

Four things are load-bearing:

- **Nothing is written onto any Game Object, and that is what makes expiry
  free.** A Passive is *consulted*, so 317.2.c drops the entry and every effect
  it was having stops at once, with nothing to unwind. The same discipline
  `staticMight` follows.
- **"The next" is a counted window and the count is never dropped.** Read as
  uncounted, "the next spell you play this turn costs 5 less" becomes every
  spell — strictly stronger than printed. `uses` is spent by `spendDelayed`
  when the entry *would have applied*, asked with the same predicates the cost
  machinery and `entersReady` use, because a discount that hits an already-zero
  cost still applied.
- **A use is spent before the played card's own rules text runs.** Otherwise a
  Play Effect that opens a window ("the next unit you play this turn enters
  ready") would immediately spend it on the card that created it.
- **A `self` window is refused.** It would be about the card that opened it,
  which for a Spell is in the trash before anything reads it — a Passive that
  can never apply.

**The clause rule is listed last in `CLAUSES`, and that is not tidiness.** Its
pattern matches almost any line containing "this turn", and `matchClause` takes
the first rule that consumes the line whole — so ordered earlier it shadowed
eleven cards that were already parsing, dropping coverage from 254 to 243
before the order was fixed. A test pins that an ordinary "+2 Might this turn"
still wins.

**Playing a card out of the trash is the ordinary Process of Play**, not a new
action: 354 moves a card to the Chain "from its current zone", so the only
difference is where it starts. `Effect.playFromTrash` takes a `trashCard`
target and the engine's existing simplification carries — 359.2 takes a
Permanent off the Chain the instant it is Finalized, so a Unit reaches the
Board atomically and nothing can respond in between.

Three things are load-bearing:

- **The cost must be *ignored*, and a card that does not say so is refused.**
  356.1.b's ignored Base Cost is the only supported form. A card whose
  controller has to pay at resolution needs a payment step that does not exist,
  and reading it as free would make the card stronger than printed.
- **A Spell is refused for the same class of reason.** 359.3 leaves a Spell on
  the Chain making its own choices, which is a decision point *during*
  resolution. Only Permanents go through this.
- **`DestinationSpec.unitEntry` is its own variant** because 355.2.a's set is
  narrower than a Move's: the controller's Base or a Battlefield they *Control*,
  where a Move may go anywhere the Unit is allowed to be. It rides the same
  enumeration path every other Destination does, so the Location is settled at
  402.2 alongside the target.

`TargetSpec.trashCard` takes a *list* of card types, because the corpus prints
"a unit **or gear** from your trash" — one field rather than a singular beside
a plural, for the reason this codebase refuses second sources of truth
everywhere else.

**"It" is not a target choice either, and it is not "me".** `TargetSpec` has a
`triggerObject` variant for the "it" of "When a friendly unit dies, buff **it**"
— the Game Object the *event* was about, where `self` is the Game Object the
*text is printed on*. Confusing the two buffs the card watching instead of the
Unit that died.

Three things are load-bearing:

- **Which object, when the event carries several.** A Combat is won by every
  survivor (466.3), so `matchesTrigger` reports *which* object satisfied the
  condition rather than a bare yes, and `PendingTrigger` carries it.
- **It is recorded when the trigger is queued, not looked up on resolution.**
  By then the event is over: the Unit that died is in the trash and the Move
  has been superseded. Exactly the reasoning behind 808.1.d.3's `noted`, set at
  the same moment and for the same reason.
- **A pronoun outside a Triggered Ability is refused.** A Spell and an
  Activated Ability have no triggering event, so "it" would resolve to nothing
  and the card would silently do nothing. A pronoun that refers *back within
  the run* — "move a friendly unit and ready **it**" — is a different thing and
  stays an ordinary target.

**"Me" is not a target choice.** `TargetSpec` has a `self` variant for the "me"
of "ready me" and "give me +2 Might". Rule 355.6 is about *choosing* something,
and which Game Object "me" refers to is already settled by which card the text
is printed on — so `self` is resolved when the effect executes, not enumerated
when the card is played. That is the one asymmetry with `unit` targets, and it
is why `needsTargetChoice` exists alongside `needsTarget`: `legalActions` offers
a self-targeting card as a single action carrying no target, and `reduce`
rejects one that arrives with a target attached.

Resolving it needs the effect's own source, so `executeEffect` takes an
`EffectInvocation { controller, source, choices }` rather than loose arguments.
For a played card `source` is the card; for an ability it is the ability's
source, because 377.3.a.1 puts no card on the Chain for an ability and "me" has
to mean the Game Object the ability is printed on.

**A `move` needs a second choice, and it is made the same way a target is.**
`CardEffect.destination` names the kind of Location wanted, `legalActions`
offers one action per (target, destination) pair, and both ride on the Chain
item until the effect resolves. Rule 355.8 wants every choice settled before a
card reaches the Chain, so enumerating beats asking mid-resolution.

**A Showdown owed by an effect opens when the Chain empties.** Rule 344.2 only
opens one in a Neutral *Open* state, so an effect that Contests a Battlefield
during Chain resolution cannot open it there. `pass` re-checks once the Chain
drains — without that the Battlefield stays Contested forever and nobody ever
takes Control.

### Cost modification

Rule 356, in `engine/costs.ts` with the data in `cards/cost-modifier.ts`. The
rule is a sequence of layers and **the order between them decides the answer**,
so each modifier carries its layer in the data rather than having it inferred
from where the modifier was found:

| Layer | Rule | What it does |
|---|---|---|
| 1 | 356.1 | Replace or ignore the Base Cost |
| 3 | 356.3 | Increases |
| 4 | 356.4 | Discounts |
| 5 | 356.5 | "Ignoring any and all costs" — total to zero |

Three things are easy to get wrong:

- **A discount's minimum binds only that discount** (356.4.e), not the running
  total, so a later discount can still go under it. The rulebook's own example
  gives 0 or 1 for the same two discounts depending on order. 356.4.c.1 lets
  the player pick that order; the choice is not exposed, so the engine applies
  bounded discounts first, which is the player-favourable order in that example.
- **Ignoring a Base Cost is not a floor** (356.1.b.3). A later increase raises
  the total back above zero, which is the rulebook's Legion Rearguard case.
- **"Base Cost" means the printed cost** (356.1.c), never the modified one, so
  `baseCost` stays separate from `totalCost`.

Abilities go through the same machine (403.2-403.3), but only via modifiers that
name `'ability'` — "cards cost 1 less" is not a statement about Activated
Abilities, so an unqualified modifier deliberately does not reach them.

### Additional Costs (rule 356.2)

Layer 2, and the last one built. The data is `cards/additional-cost.ts`, the
payment `engine/additional.ts`.

The delay was never the arithmetic — it is that an Additional Cost is paid with
a *non-standard* cost (356.7): "kill a friendly unit", "discard 1", "spend a
buff". Those are actions, so the layer needs a payment protocol rather than a
subtraction.

**The optional form is a play-time choice, not a mid-resolution one.** Rule
356.2.b.1 declares it at *step 2*, before the Total Cost is worked out at step
3 — because choosing to pay changes it. So it rides on the `playCard` action as
`payAdditional`, and `legalActions` offers a card with an optional cost
**twice**: paying and not paying are genuinely different plays with different
totals. That is why this needed no sub-action protocol.

Four things are load-bearing:

- **Payability is proven before the card is played, not discovered during.**
  356.2.a makes a Mandatory cost part of what playing the card *is*, so an
  unpayable one makes the card unplayable — the same shape as 422.3 for a
  Discard that cannot be performed. `playableFromHand` drops such a card
  entirely rather than offering a play that would strand the game.
- **A card can never pay its own cost with itself.** The played card is still in
  hand when 357.2 runs here, so a "discard a card" cost would take the card
  being played, leaving the cost unpaid and the card played anyway. It is
  excluded explicitly, in both the check and the payment.
- **Resources are one question, not two.** An Additional Cost paid in Energy or
  Power comes out of the same Rune Pool as the Total Cost (357.1), so
  affordability is checked against their *sum* — two separate checks would each
  say yes to money that can only be spent once.
- **"If you paid the additional cost" is a `Condition`, not a special case.** It
  reads the step-2 choice rather than the board, which is why `conditionMet`
  takes a context alongside the state and a Spell's declaration rides the Chain
  to its resolution. It is the most repeated conditional wording in the corpus.

**A variable count is refused.** "Kill any number of friendly units" and "spend
any number of buffs" are a choice as well as a quantity, and a cost that might
not be payable in full cannot be proven payable in advance.

#### Where a modifier is read from

Almost all of them come off the Board, because 365.1 makes a Permanent's Passive
Abilities active while it is there. **`scope: 'self'` is the exception, and it is
the common wording on real cards**: "I cost 2 less" is about the cost of playing
*that* card, so it has to be read off a card still in hand. `activeModifiers`
sweeps the Board and deliberately skips `self`; `totalCost` adds the played
card's own.

Skipping it in the sweep is not tidiness. A `self` modifier left in would apply
once the card reached the Board — where its own cost has already been paid — and
silently discount everything else its controller played afterwards.

`self` is also why `CostPayer` has three cases rather than being a boolean. A
player can hold two copies of the same card, and only the one being played
carries its own discount, so "the controller is paying" is not the same question.

#### Counted amounts

"I cost 1 less **for each** card in your trash" is a discount whose size is read
off the state. `CostChange.discount.per` carries the count, and `costs.ts`
resolves it to a fixed number *before* rule 356's layers run — so the layer
machinery stays a pure function of numbers, and the counting is one step that
can be tested on its own. Only counts the state already holds exist
(`cardsInTrash`, `cardsPlayedThisTurn`); a count of something the model cannot
see is refused at ingest rather than approximated.

A counted discount is still floored at 0 by 356.6, and `minimumEnergy` still
binds only itself per 356.4.e — which is what makes "for each card you've played
this turn, to a minimum of 1" stop at 1.

#### Cost modifiers can be gated

`CostModifier.dependsOn` takes the same `AbilityDependency` as an ability, so
"LEGION - I cost 2 less" works: 812.1.b makes the whole clause after the keyword
the Legion Ability, and a passive is as gateable as a triggered one. An unmet
dependency makes the modifier *absent* rather than inert, so it never enters the
Total Cost.

Because both abilities and cost modifiers can be gated, `dependencyMet` lives in
its own `dependency.ts` — `abilities.ts` asks `costs.ts` for an ability's Total
Cost, so it cannot also own the check without a cycle.

For a card whose own cost is being determined, `dependencyMet` gets no source
entity: the card is Finalized at step 6 (329.2) and its cost settled at step 3,
so it genuinely is not yet among the cards played this turn. That is not a
special case, it is the timing.

### The interruptible phase machine

A phase that puts a Triggered Ability on the Chain cannot just finish and
advance: the Chain has to drain first, and players may respond while it does
(383.3.c). So a phase is a **sequence of steps**, and `phaseStep` records how
far through them the turn has got.

A step does its work and queues its triggers. If that put anything on the
Chain, the phase **holds** — it returns with `phaseStep` pointing at the step to
resume from, and the phase does not advance. When the Chain finally empties,
`afterChainPriority` hands Priority to nobody rather than to the Turn Player,
because outside the Main Phase nobody holds it (312.2.a); `legalActions` then
offers `resolvePhase` again, and the phase picks up at the recorded step.

Two steps exist today, both where the rules put a boundary:

| Phase | Step 0 | Step 1 |
|---|---|---|
| Beginning (315.2) | Beginning Step: `beginningPhase` triggers | Scoring Step: Hold every Battlefield Controlled |
| Ending (317) | 317.1 end-of-turn effects | 317.2 Cleanup, then the turn passes |

**The step order is load-bearing in the Beginning Phase**: the trigger resolves
*before* Scoring, so an ability that takes Control of a Battlefield changes what
gets Held that turn. Resuming must also not re-run a completed step — scoring
twice is the exact hazard — which is what `phaseStep` guards and what
`abilities.test.ts` pins.

Awaken, Channel and Draw have no trigger conditions, so they still resolve in a
single action and never leave `phaseStep` set; `checkInvariants` enforces that,
and that a held phase with an empty Chain leaves Priority with nobody.

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
2. **Heuristic agent** — BUILT. `HeuristicAgent` scores the position from a
   `GameView` and adds a per-action bonus for what the action achieves.
3. **Search agent** — BUILT. `SearchAgent` rebuilds a plausible `GameState`
   from its view with `determinize`, plays each candidate action out in several
   sampled worlds, and averages. See [The search agent](#the-search-agent).

A new agent must beat the previous tier convincingly over a large sample, or it is
not an improvement. Agents implement a common interface and must never access state
outside their observable view.

**The heuristic cannot look ahead, and that is deliberate.** It is handed a
`GameView`, not a `GameState`, so it cannot call `reduce` to see where an action
leads — widening that signature is how an agent starts cheating. It therefore
scores the *current* position and adds a bonus per action type. Real lookahead
is the search agent's job, and it needs to hold its own determinized state.

Its weights live in one `HeuristicWeights` struct rather than scattered through
the scoring code, because every one of them is a guess a win rate can falsify.
Tune them by playing tiers against each other, not by intuition. Ties are broken
with the agent's own seeded RNG, never by list order: `legalActions` enumerates
in a fixed order, so taking the first would make the agent replay one rut and
hide bugs on the paths it never walks.

### The search agent

`ai/search.ts`, with `engine/determinize.ts` underneath it. Measured at **90.8%
[84.3%, 94.8%] against the heuristic** over 120 games of real card data; the
search-vs-search control measures ~50%, which is what says that is the agent
rather than the seat.

**Determinization is what makes search possible at all under hidden
information.** An agent gets a `GameView`, and a view cannot be played forward —
so the agent builds its own state from it. Everything public is copied across
exactly; the opponent's hand and both decks are *sampled* from what the viewer
legitimately knows. That is why `GameView` had to be widened: it was rich enough
to *evaluate* a position and not rich enough to *rebuild* one, so Buffs, granted
keywords, what is Equipped to what, the Chain's controllers and targets, and the
turn's own bookkeeping are all exposed now. None of it is secret — 328 makes the
Chain public and a Buff counter sits face-up on the table.

Five things are load-bearing:

- **Entity ids are preserved.** The agent's whole output is an `Action`, and an
  action names entities — so an action chosen in a determinized world has to
  mean the same thing in the real one. Sampling fresh ids for hidden cards would
  produce actions the real engine rejects.
- **Worlds, not depth.** Under hidden information a single tree is a tree over
  one guess at the opponent's hand, so the budget goes on averaging several
  determinizations rather than on deeper selection in one. That is Monte Carlo
  over determinizations rather than UCT, and it is a measured choice: rollouts
  here are dominated by `reduce`.
- **The rollout policy is random, not the heuristic.** A rollout that shares the
  evaluation's biases reinforces them.
- **Both tiers share `scorePosition`.** So "the search agent is stronger" is a
  claim about *lookahead*, not about a second, differently-tuned evaluation.
- **A bad world is a bad sample, not a bad action.** The whole evaluation is
  guarded and falls back to the heuristic tier, because a search that throws is
  strictly worse than no search. The test for that caught a real escape: the
  guard originally covered `determinize` but not the rollout.

181 puts Token definitions in every game rather than in a deck, so `determinize`
seeds them too — a rollout that Creates one would otherwise fail to read it.

The head-to-head loop lives in `heuristic.test.ts`, not in `ai/` — `playGame`
runs one game, and batch simulation belongs to the planned `sim` package. It
alternates seats, because the player going second Channels an extra Rune (485.7)
and a fixed seating would measure that alongside the agents.

### Suggestions

`packages/suggest`. Rules the recommendations obey are rule 103's; the design
decisions are these.

**The objective is pluggable, and that is the point.** Open question 4 — what
"suggest edits" should optimize for — is not answered in the code. An
`Objective` is a function from a deck to a score, `suggestEdits` ranks candidate
edits by how far they move it, and swapping the objective swaps what the tool is
for without touching the search.

**The default is `CONSISTENCY`, and the reason is not taste.** A *simulated*
objective is not trustworthy yet: 311 of the 468 cards with rules text still
play as vanilla, so a simulator cannot see what most cards do. Optimizing
against it would cut the card whose text the engine ignores and keep the vanilla
body with better stats — confidently wrong advice. Consistency depends on cost
and Domain, which are exact for all 479 cards. A simulated objective becomes
viable as text coverage rises, and the seam needs no other change: `sim` already
measures win rates, so such an objective is a function that calls it.

Five things are load-bearing:

- **A suggestion is measured, not reasoned.** Every candidate is applied, the
  resulting deck is scored, and the delta is reported. Nothing is proposed
  because it looks sensible.
- **The reason states the measurement.** "50% of your Runes are mind but only 0%
  of your Power demand is" — a reader can check it. A reason that only says a
  number improved is not a reason.
- **An illegal edit is never proposed.** The candidate deck is validated before
  it is scored, so an edit that would break rule 103 is dropped rather than
  ranked. This is also why a `swap` is one edit rather than a cut plus an add:
  103.3 fixes the Rune deck at 12, so half a swap always scores an illegal deck.
- **One suggestion per decision.** Twenty ways to replace the same card are not
  twenty suggestions — the decision is "cut this card" and the replacement is
  the answer to it. Without deduplication the ranked list fills with variations
  of one move and crowds out the structurally different ones.
- **The empty pool is the default.** Proposing a card the owner does not have is
  shopping, not a deck edit, so additions require an explicit pool. The CLI
  passes the whole card pool; `--pool none` restricts it to cuts and ratios.

One property worth knowing rather than hiding: **the Domain component is
symmetric.** A deck with 6 Mind Runes and no Mind cards can be fixed by cutting
the Runes *or* by adding Mind cards, and both genuinely improve consistency, so
both are proposed. Which one is right depends on what the deck is trying to be,
which is a question the metric cannot answer and the reader can.

Suggestions are single-step: each is measured against the current deck, not
against a deck with the others already applied. Two that individually help may
not compose, which is why they are a ranked list to choose from rather than a
patch to apply wholesale.

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

The simulated side is `sim/`. Three decisions in it are load-bearing:

- **Intervals are Wilson score, not `p ± z·√(p(1-p)/n)`.** The normal
  approximation fails exactly where simulation results live: near 0 or 1 it
  puts bounds outside [0, 1], and at exactly 0 or 1 it collapses to zero width
  and claims certainty. An agent that wins 40 of 40 is not 100% ± 0%.
- **Entrants rotate through the seats**, because 485.7 gives the player going
  second an extra Rune and a fixed seating measures that alongside the agents.
  Turn rotation off only to measure the seat advantage itself.
- **Agents come from a factory, not an instance.** They carry RNG state, so
  reusing one makes game N depend on game N-1 and a single game stops being
  reproducible from its seed — which is most of what a batch run is for. Each
  game's seed derives from the batch seed, so `onGame` hands back something
  `playGame` can replay on its own.

Draws are reported but never counted as half a win: the win rate's denominator
is decided games only, and no decided games yields the whole [0, 1] interval
rather than a 0% that looks like evidence.

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
- **Golden-game regression tests.** `engine/golden.test.ts` replays four fixed
  seeds through whole games and pins a readable digest — turns, points, winner,
  zone sizes — rather than a hash, so a break says *what* changed. A change
  there is a result, not a failure: check the rule change was intended, then
  re-record. The same file asserts the four engine-wide properties nothing else
  covers end to end: `reduce` never mutates its input, the same seed and actions
  replay identically, every action `legalActions` offers is accepted by `reduce`,
  and no view names a card the viewer may not see.
- **No presentation logic in the engine.** No string formatting for display, no
  colors, no layout. The engine emits structured events; consumers render them.
- **Card data is generated, not hand-edited.** Ingest from a source, normalize, and
  commit the result with the ingest script. Never hand-patch generated card data —
  fix the ingest.
- **Prefer explicit domain vocabulary.** Use the game's terms (Might, Showdown,
  Channel, Recycle, Exhaust, Hold, Conquer, Domain, Legend) in code. Do not invent
  synonyms; the rulebook is the naming authority.

## Card data

**A usable source exists.** `apitcg/riftbound-tcg-data` commits one JSON file
per set at `cards/en/`, derived from the official Riot gallery, and is
reachable on `raw.githubusercontent.com`. It carries **Might**, the **Champion
and Signature supertypes**, and **printed Spell timing** — the three things the
older community export lacked.

Ingest it with the default source. `ingest` takes several files, because the
data is published one file per set and a deck is not limited to one set:

```bash
base=https://raw.githubusercontent.com/apitcg/riftbound-tcg-data/main/cards/en
curl -sO $base/origins.json
curl -sO $base/spiritforged.json
curl -sO $base/origins-proving-grounds.json
node packages/cli/dist/main.js ingest *.json > cards.json
```

`packages/cli/examples/real-deck.txt` is a legal deck of real collector numbers
to point the tools at once that has run. It lists ids only — no card text — so
it sidesteps the licensing half of open question 1.

### What it yields

541 card records in (699 minus sealed products and tokens), **479 cards out**,
covering every card type including 255 Units and 90 Champion Units. A legal
deck builds and validates from it with no issues, and the engine plays complete
games with it — 300 games, all decided, heuristic 59.0% ± 5.5 against random.

153 of those cards carry an ability and 24 a keyword. The keyword figure is low
against the 188 that parse because keywords ride the same all-or-nothing rule:
a card whose other clause is unreadable keeps neither. 37 carry a static, 22
create Tokens, 15 an Additional Cost, 15 carry Effect Text a Gear lends its
Top-Most Card, 13 a cost modifier, 8 carry Accelerate, 8 choose a Gear, 7 return
a card to hand, 5 affect every Unit matching a criterion and 4 grant a keyword.

What it still cannot supply:

| Missing | Cards lost | Why |
|---|---|---|
| Spell `timing` | 43 | The ACTION/REACTION marker is not printed in that card's text |
| Power pip Domains | 18 | `powerCost` is a pip *count*, so a multi-Domain card's cost is ambiguous |
| `might` | 1 | One Unit record has none |
| Champion Tag on Signature cards | 0 dropped, 30 degraded | See the inference below |
| Tags of any kind | 0 dropped, 6 degraded | The export has no tag field, so "Your Mechs have +1 Might" and "if you control another Dragon" match nothing |

Battlefield abilities used to appear here too; 170 gives each Battlefield a
Game Object now, so the six whose text the grammar reads keep their abilities
and actually run them.

**The `tags` row is a shortfall of the data, not of the model.** 133.8 lets a
card narrow a scope or a predicate to a tag, `StaticScope.tag` and
`Condition.controls`'s `tag` both state it, and the engine honours both — but
every card comes out of this export with an empty tag list, so such a clause
reaches nothing and the card plays weaker than printed. The clause is still
read, because refusing it would hardcode today's data shortfall into a parser
that is shared across sources: a source that carries tags makes these cards work
with no code change. The gap is what keeps that visible.

### The inferences it makes

Three, each forced by the data rather than guessed:

- **A Legend's printed Domains are its Domain Identity** (103.1.b.2).
- **A single-Domain card's Power pips must be of that Domain.** Multi-Domain
  cards are dropped rather than split arbitrarily.
- **A Champion Tag is the leading segment of the card name.** The export has no
  tag field, but names Legends and Champion Units alike as
  `"<Champion> - <Epithet>"` — "Kai'Sa - Daughter of the Void" and "Kai'Sa -
  Survivor" — and 133.8.b says the tag is exactly what links those two. It
  works only where the naming does: a Signature card is named for its effect
  ("Icathian Rain"), so those get a recorded gap rather than a guess, and
  103.2.d.2 goes unchecked on them.

**Alternate printings are collapsed by name.** The export appends `(Alternate
Art)`, `(Overnumbered)`, `(Signature)` or `(Starter)` and *reuses the collector
number*, so `id` is not unique across it. Rule 103.2.b.2 makes same-named cards
the same card, so one printing is kept per name. Note `(Signature)` there is a
printing, unrelated to the Signature supertype, which comes from `cardType`.

### Turning text into effects

`ingest/text.ts` parses printed text into the effect model over a known
grammar. **The parse is all-or-nothing per card**: if every clause is
understood the card gets its effect and abilities, and if one clause is not the
card stays vanilla and the clause is recorded as a `text` gap. A partial parse
would be worse than none — "Deal 6 to it unless its controller has you draw 2"
reduced to "deal 6" is a card that plays, looks right, and is wrong.

It covers `Draw N`, `Deal N to a unit [at a battlefield]`, `Give a unit +N
Might this turn`, `Give a unit <KEYWORD> [N] this turn`, `Draw N for each <count>`, `Kill`, `Ready`, `Buff`, `Heal`, `Discard N`, `Channel N
rune(s) [exhausted]`, `ADD` resources including `ADD Rune` for `[A]`, `Give
[a unit|units|me] ±N Might this turn [, to a minimum of N Might]`, `Counter
a spell [that costs no more than N [and no more than M Power]]`, `Gain N XP` and
`Return <a unit|a gear|me|a <type> from your trash> to <its|my|your> owner's hand`; the self-targeting forms
(`Ready/Buff/Heal/Exhaust/Recall me`, `Give me +N Might this turn`); the
criteria forms that choose nothing (`Deal N to all [friendly|enemy] units
[here|at battlefields|at my battlefield|in combat]`, `Kill/Buff all …`);
sequences
joined by "then" or "and"; the trigger grammar below; `Play [N] [ready] [<M>
Might] <Name> <unit|gear> token [here|in your base] [exhausted]`; the modelled
keywords and the desugared ones (`DEATHKNELL - <effects>`, `TEMPORARY`,
`ACCELERATE`, `LEGION - <ability>`); and Activated abilities written
`[N,] Exhaust: <effects>`.

`parseCardText` takes a second argument, `CardFacts`, and it holds exactly one
field. Almost every clause is readable from the words alone and the grammar is
better for not having the whole card to reach into; the one exception is
Accelerate, whose Power is the Unit's *own* Domain (805.1.a.1) and appears
nowhere in the printed line.

Trigger conditions are parsed as an event plus a subject plus a filter rather
than one pattern per sentence — see [Abilities](#abilities) for the shape. The
grammar strips two orthogonal wrappers first: "the first time … each turn" is
rule 383.3.e's per-turn limit, and "when"/"whenever" is noise.

**Coverage is 266 of the 468 cards that have text** — 258 parsed and 8 hand-authored, and the shape of what is
left is the finding rather than the number:

| | Cards |
|---|---|
| With printed text | 468 |
| Fully parsed | 258 |
| Hand-authored | 8 |
| Blocked | 202 |

At the level of literal clause strings the unparsed tail is **flat** — the most
common clause the grammar misses appears 4 times, the next 2, and every one of
the remaining 325 shapes appears exactly once. More regexes buy roughly one card
each. The head is one level up, in the
mechanics the clauses need, and each one's worth is measurable: pretend the
mechanic exists, re-parse the corpus, count what goes from blocked to whole.

That measurement is what ranked keywords and trigger conditions as one piece of
work — projected +46 together against +19 and +23 apart, because many cards need
both ("LEGION - When you play me, ready me." is one clause blocked twice over).
**The delivered figure is +33, 22 → 55**, and the gap is entirely the eight
keywords still refused: the projection modelled *all* of them, and Accelerate,
Deflect, Hidden, Weaponmaster, Vision, Equip, Repeat and Quick-Draw each turned
out to want a mechanic of its own rather than a keyword slot. Re-measured from
the new baseline:

| Mechanic | Cards it unlocks |
|---|---|
| The eight remaining keywords | +11 (55 → 66) |
| `TriggerCondition` widened further | +8 (55 → 63) |
| Both together | +21 (55 → 76) |

Self cost modifiers were then added on top of that baseline for **+3, 55 → 58**
— and that number was known before the work started, which is the point. Of the
24 clauses in the corpus that mention a cost, *every one is distinct*, and only
three are about the card's own cost in a way the state can answer. The rest want
a duration, a condition, a Battlefield static, or a count of something invisible
— so they are refused. See [Cost modification](#cost-modification).

**Static abilities then took it 58 → 68**, the largest single step since the
keyword and trigger work, and the one whose category was measured furthest in
advance. See [Static and passive abilities](#static-and-passive-abilities).

**State predicates took it 68 → 74**, again matching the measurement exactly.
See [State predicates](#state-predicates).

**Additional Costs then took it 74 → 78**, the last of the two best-measured
investments. See [Additional Costs](#additional-costs-rule-3562).

**Tokens took it 78 → 89**, **Accelerate 89 → 95**, **zone movement 95 → 100**, and
**effect-granted keywords plus two wider conditions 100 → 105**, and **dynamic
values 105 → 110.** **Multi-sentence rules text took it 110 → 112**, and
**Equip with the Effect Text 112 → 124** — the largest single step since tokens,
and the one whose engine half (Attach) was already built — **Weaponmaster with
`[A]` 124 → 130**, **Deflect 130 → 134**, and **play-location permissions with
the reminder text the export flattens 134 → 140**, and **rule 429.5's
multi-resource Add 140 → 141**, **Hidden with the Facedown Zone 141 → 145**, and
**Stun (423) 145 → 148**, **non-resource ability costs 148 → 152**, and
**scoring by effect plus Vision and Predict 152 → 157**, and **four small
extensions together 157 → 166** — criteria targets (355.5.a), Gear as a chosen
target, tag- and token-scoped statics — plus **the tag scope's data gap 166 →
167**, and **the Gold token (187.5) with `[A]` in the Rune Pool (135.2.e.5.b)
167 → 173**.

A second reading of the shortest blocked cards then took it **173 → 184**, and
it is the same lesson twice: none of what it added is a mechanic either. "An
enemy unit **here**" and "**another** friendly unit" are two fields on the
target spec (355.9); "when I attack" is rule 464.2.c.3's designation raised as
an event; "SHIELD 3 **and** TANK" is one grant the sequence splitter was
cutting in half; and "+1 Might **here**" is the same static as "units here have
+1 Might" with the word at the other end. **+11 together, and the parts overlap
heavily** — the attack event alone measured +1 and measured +4 once "here"
targets existed with it, because the cards that want one want both.

Statics that grant a *desugaring* keyword then took it **184 → 188**, and that
one is a mechanic — the only entry in the recent rounds that is. "Friendly units
have DEFLECT" and "Other friendly units have VISION" grant something that is not
a `Keyword` at all: 809.1.c is a cost modifier and 817.1.b is a Play Effect. See
[Static and passive abilities](#static-and-passive-abilities).

Three of these are worth reading as method rather than as results:

- **The four small extensions came from reading the shortest blocked cards, not
  from the mechanic table.** None of them is a mechanic — "all enemy units in
  combat" is a target variant, "kill a gear" is one word in a regex — and
  together they beat every subsystem left on the list, which topped out at +3.
  When the tail is flat, look at the *cards* again rather than at the ranking.
- **The target phrase is now built once and shared.** Eight clause rules each
  assembled their own `TargetSpec` from the same four parts, which is why
  "another" was honoured nowhere and "here" nowhere else. `unitTarget` builds
  all of them, so widening the phrase is one edit rather than eight — and a
  ninth verb inherits it for free. `parseEffects` also tries a **whole-line**
  clause before splitting on "and", because "and" is both a sequence joiner and
  part of single clauses.
- **The Gold token is the counter-example to "the corpus mentions it a lot".**
  Its wording is the most-printed token clause in the corpus by a wide margin —
  ~20 distinct clauses — and a first counterfactual measured it at **+0**,
  because every card carrying it was blocked on something else as well. The
  rewrite was wrong: it dropped the token but left the "exhausted" that 184.1
  makes an override for a *Gear* (359.2.d enters one ready), so those cards
  stayed blocked on a dangling word. Corrected, it measured +6 and delivered
  +6. **A counterfactual that measures +0 is worth re-reading before it is
  believed** — the rewrite has to leave a clause the grammar genuinely accepts.

#### How the ranking was measured wrong, and what fixed it

Worth reading before trusting any number below it.

The ranking that stood here until tokens were built **attributed a blocked
clause by its opening word**. Anything starting "When…" was counted against
trigger conditions — including cards whose trigger the grammar already parses
perfectly and whose *effect* is the blocker. That put "trigger/static shape" at
110 solely-blocked cards against the ≈8 a wider condition actually buys, and it
hid tokens completely: every "When you play me, play a Recruit token" was
filed as a missing trigger.

The fix is to attribute by **asking the parser's own sub-parsers which stage
refused the clause** — if some comma prefix parses as a condition, the blocker
is downstream of it. Doing that surfaced tokens (+9 projected, **+11
delivered**) as the largest single coherent mechanic left, from a standing
start of not being on the list at all.

So: **never rank by what a clause looks like. Rank by what the parser rejected,
then confirm with a counterfactual re-parse.** The scratch harness for both is
worth rebuilding if it is not to hand — it is about fifty lines.

#### What is left, ranked by measurement

Re-measured by counterfactual from the **173** baseline, one mechanic at a time.
Every keyword the earlier tables ranked is now built, so what is left is four
rows and they are all small:

| Mechanic | Alone |
|---|---|
| Durations and delayed effects ("the next spell you play…") | +2 |
| Effect-outcome predicates ("if this kills it", "unless its controller…") | +1 |
| Statics beyond scope-plus-grant ("while I'm attacking alone") | +1 |
| Symmetric effects ("each player kills one of their gear") | +1 |
| An optional first clause ("you may kill a gear. Draw 1.") | +1 |
| Conditions about the source at death ("if I died alone") | +1 |
| A granted tag ("I am a mech") | +1 |
| Modal effects ("choose one •…") | +0 |
| Repeat (820) | +0 |

Building **all** of them reaches 197, measured. Nothing left is worth its own
round; the authored overlay is the cheaper route past here.

**Repeat has now measured +0 from three separate baselines** (55, 124 and 173).
Its ten printings are each blocked on something else as well, and that is what
its entry in `UNMODELLED_KEYWORDS` records — a measurement rather than a
blocker, because 820.1.d's optional-cost shape has been expressible since
Additional Costs landed.

What each round actually delivered, for calibrating the next projection:

| Mechanic | Result |
|---|---|
| Tokens (179-187) | +9 projected, **+11** delivered |
| Zone movement | +8 projected, **+5** delivered |
| Accelerate (805) | +5 projected, **+6** delivered |
| Keywords granted by an effect | +2 projected, **+3** delivered |
| Wider `controls` predicates | **+2** delivered |
| Counting / dynamic values | +3 projected, **+5** delivered |
| Multi-sentence rules text | not projected, **+2** delivered |
| Equip, Quick-Draw and the Effect Text | +11 projected, **+12** delivered |
| Weaponmaster (821) with `[A]` | +6 projected, **+6** delivered |
| Deflect (809) | +3 projected, **+4** delivered |
| Play permissions (355.2.b) and flattened reminders | +5 projected, **+6** delivered |
| Hidden (811) and the Hide action (421) | +4 projected, **+4** delivered |
| Stun (423) | +3 projected, **+3** delivered |
| Non-resource ability costs (356.7, 416.6) | +4 projected, **+4** delivered |
| Scoring by effect (467-471) | +1 projected, **+2** delivered |
| Vision (817) and Predict (436) | +3 projected, **+3** delivered |
| Criteria targets, Gear targets, tag/token scopes | +9 projected, **+10** delivered |
| The Gold token (187.5) with `[A]` in the pool | +6 projected, **+6** delivered |
| Shared target phrase, attack/defend events, trailing `here` | +12 projected, **+11** delivered |
| Statics granting a desugaring keyword (801.3.a) | +4 projected, **+4** delivered |
| Counter (425) | +2 projected, **+2** delivered |
| Triggered abilities with a price (403, 356.7) | +4 projected, **+5** delivered |
| Might bounds, bare plurals, Base destinations | **+5** delivered |
| The first authored entries | **+4** delivered |
| Signed Might with a printed floor (143.2) | +5 projected, **+5** delivered |
| Static restrictions (rule 002) | +8 projected, **+6** delivered |
| Guarded effect steps and four more authored entries | **+4** delivered |
| Counted targets (355.6) | +2 projected, **+3** delivered |
| Dynamic amounts off the source (143, 807) | **+3** delivered |
| Seven shared clause shapes, read once rather than per card | **+7** delivered |
| Object filters and ability-use restrictions (002, 377) | **+6** delivered |
| Five trigger events and six trigger filters | **+10** delivered |
| The triggering object as a target, and a floored static grant | **+3** delivered |
| Playing a card out of the trash (354, 355.2) | +5 projected, **+3** delivered |
| Delayed Passive Abilities (390.4) | +5 projected, **+4** delivered |
| Looking at the deck, with a Linked Ability to choose (424, 390.5) | +8 projected, **+5** delivered |
| Bonus Damage (712-715) | +3 projected, **+3** delivered |

**Projections run optimistic, except when they do not.** Additional Costs
projected +8 and delivered +4; tokens projected +9 and delivered +11, dynamic
values +3 against +5, and the Equip cluster +11 against +12 — those beat their
projections because building the mechanic properly also picked up wordings the
counterfactual's crude rewrite had mangled rather than unlocked. A
counterfactual rewrite proves a *clause* stops blocking, which is neither an
upper nor a lower bound on what a real implementation reaches — treat these as
a ranking, not a forecast.

**A rewrite for a mechanic that is now built measures nonsense, not zero.** The
EQUIP row of the keyword counterfactual reads **−10** against this baseline,
because the rewrite replaces a line the real parser now reads with a stand-in
that loses it. Delete a rewrite when its mechanic lands; leaving it in makes the
next re-measurement quietly wrong.

**The keyword tail is spent.** Equip, Quick-Draw, Weaponmaster, Deflect, Vision
and Hidden are all built. Repeat is the only one left and it measures +0.

Additional Costs and state predicates were the two best single investments and
**do not overlap**: together they measured +14 and delivered +10. The shortfall
is the payments that are still refused — "kill *any number of* friendly units",
"spend any number of buffs" — where a variable count is a choice as well as a
quantity, so the cost cannot be proven payable before the card is played.

**The trigger tail was declared spent once and was not.** The claim rested on a
count of *wordings*, and the wordings genuinely are all distinct — but several
of them wanted the same missing thing underneath, which is an **event** rather
than a phrasing. Five were missing: `ready` (415), `recycle` (416),
`spendBuff` (702), `chosen` (355.6) and, still unbuilt, a Permanent leaving the
Board. Adding them plus six filters delivered +10.

Two of those filters exist because a subject cannot say what they say:

- **`byController` constrains the *actor* while `subject` constrains the
  object.** "When **you** choose me with a spell" needs both at once — an
  opponent pointing a spell at the same Unit is a different event — and
  `subject` says one or the other.
- **`bySource` is the type of the card that *caused* the event**, not of the
  object it happened to. Read as `cardType`, "with a spell" would ask whether
  the chosen Unit is a Spell, which is never true: a filter that can only be
  false is a card that never fires.

The lesson generalises past triggers: **count the mechanics the wordings need,
not the wordings.** A flat tail of distinct phrasings can still sit on a short
list of missing verbs.

What the corpus is blocked on now, in the order measurement puts them:

1. **Durations proper — a restriction or a modifier scoped to *this turn*.**
   "Opponents can't play cards this turn", "the next spell you play this turn
   costs 5 less". The *static* half of what used to be filed here is built (see
   [Static restrictions](#static-restrictions)); what is left needs turn-scoped
   state rather than a standing statement, and it is +2.
2. **The rest of statics beyond a scope plus a grant** — "While I'm attacking
   or defending alone" needs a combat-role predicate that `Condition`
   deliberately cannot express, because a condition that reads Might back would
   recurse through `mightOf`. +1.
3. **Non-standard ability costs beyond the four modelled.** "You may exhaust
   me to …" and "Banish this:" are what is left; Recycle, Kill this, Discard
   and Spend a buff are built.
4. **Conditional and modal effects** — "if this kills it", "unless its
   controller…", "choose one •…". +1 and +0. The effect model has no outcome
   conditions and no modes.

**The tail is now literally flat.** Past `REPEAT 2` (4 cards), *every remaining
unparsed shape appears on exactly one card* — 309 shapes, 309 cards — and **251
of the 278 blocked cards are blocked by exactly one clause**. Building every
mechanic in the table above reaches **197 of 468**,
measured, and there is no further mechanic to find: the rest is one card per
unit of work whichever route is taken, a parser rule or an authored entry.

**This is where the curve flattens.** The rounds after Additional Costs
delivered +11, +6, +5, +5, +2, +12, +6, +4, +4, +3, +4, +5, +10, +6, +11, +4
and +2; everything left is +2 or less, and the largest of them needs a subsystem
rather than an extension. Coverage past ~190 means paying subsystem prices for
one or two cards at a time — which is the
point at which a hand-authored overlay stops being an admission of defeat and
starts being cheaper than the mechanic. `ingest/authored.ts` is that seam: it
supplies an effect model for a named card, refuses itself if the card's printed
text has changed since the entry was written, and touches no printed field.

**But an authored entry cannot route around a missing mechanic**, and that is
the finding that decides what the remaining work is. The overlay supplies an
effect *model*, so it can only say what the model can express — an entry for
"choose one •…" is as impossible to write as it is to parse. The measured
authoring rate against the model as it stood was about **1 blocked card in
40**; every round that widens the model widens that rate too, which is why the
work past here is engine mechanics *for the overlay's sake* rather than for the
parser's. Guarded steps were the first move under that framing: the parser
gained nothing from `Condition.targetIs` on its own, and four cards became
authorable that were not before.

Self-targeting was on this list before keywords and triggers, and unlocked
**nothing** — every self-targeting card was blocked on something else. That is
the reason for the measure-first rule here: a mechanic's worth is what it
unlocks *in combination*, not that real cards use it. Do not add a mechanic to
this engine because the corpus mentions it; add it because deleting it from the
corpus moves the number.

**That rule has been applied against this codebase's own work.** Recycle (416)
was built as an effect primitive during the zone-movement round, measured at
+0 cards, and removed again — the engine still performs the action where the
rules demand it (164.2.b, 431.2.b), but there is no card effect for it. Keeping
it would have been dead code justified by "a real card might want it later",
which is the same argument this rule exists to refuse.

So the next investment is engine mechanics, not parser rules.

### What is reachable

Measured, not assumed. Do not re-run the survey without reading this.

| Host | Result |
|---|---|
| `raw.githubusercontent.com` | **reachable** — the only open card host |
| `github.com` | reachable via WebFetch only, not curl |
| `codeload.github.com` | intercepted; whole-repo download needs `add_repo` |
| `riftbound.leagueoflegends.com` (official gallery) | 403, policy denial |
| `gist.githubusercontent.com` | 403 — note this differs from `raw.` |
| `piltoverarchive.com`, `tcgodds.com`, `riftbound.gg`, `riftmana.com` | 403 |
| `api.scrydex.com`, `riftbound-api.com`, `apitcg.com`, `api.riftcodex.com` | 403 |
| `api.riftseer.com`, `playriftbound.com`, `cmsassets.rgpub.io` | 403 |

WebFetch is subject to the same egress policy as curl; it reaches `github.com`
because that host is allowed, not because it bypasses the proxy.

### Other sources

- `vikkumar2021/RiftboundCardDatabase` — does **not** commit its `cards.json`;
  it ships a fetcher pointed at the blocked official gallery.
- `oriondean/Rifty` — commits `src/assets/origins-set.json`, a mirror of the
  OwenMelbz community gist. That is what `COMMUNITY_SOURCE` adapts, kept as a
  second adapter and as the worked example of a source that is *not* good
  enough: 394 cards in, 118 out, **zero Units and zero Spells**, so no legal
  deck can be built from it.
- Piltover Archive — community deckbuilder; its deck URL/list format is a
  strong candidate for the canonical import format (blocked here).

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

1. **Should ingested card data be committed?** `apitcg/riftbound-tcg-data` is
   reachable and yields 479 usable cards (see [Card data](#card-data)), so the
   blocker is gone. What is undecided is whether to commit the generated
   `cards.json` to this repository — which pins a version and makes CI
   reproducible — or to re-ingest on demand. Licensing of the card text is the
   other half of that question.
2. **Find the tournament/competitive rules document.** The Core Rules describe no
   sideboard, so the 8-card sideboard this codebase validates is unverified.
3. **Is the deck list format canonical?** Importers are pluggable via
   `DeckImporter` and a plain-text one exists that reads `<count> <card id>`
   lines under section headers. Whether a Piltover Archive URL or export should
   be the canonical format, and whether card *names* should be accepted, both
   wait on question 1.
4. **What "suggest edits" should optimize for** — raw win rate against a fixed
   AI, a specific matchup, or consistency metrics? Still open, but no longer
   blocking: `Objective` is pluggable and `packages/suggest` ships with
   `CONSISTENCY` as the default. See [Suggestions](#suggestions) for why a
   simulated objective is not trustworthy until card-text coverage rises.
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
