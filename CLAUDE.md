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

**Phase 1, in progress.** Eight packages exist and are covered by tests; the rest
of the architecture below is still a plan. **The engine plays complete games
with real Riftbound card data** — 479 cards ingested, a legal deck validated
from them, 300 games simulated. What those cards do not yet have is their rules
text turned into effects: they play as vanilla. See [Card data](#card-data).

What is built:

- **`@riftbound/cards`** — the six Domains, the Energy/Power `Cost` model, card
  definition types (Legend, Unit, Spell, Gear, Rune, Battlefield), the Champion
  and Signature supertypes with Champion Tags, and a duplicate-rejecting
  `CardRegistry`. No real card data yet.
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
  XP, Channel), **the Mulligan**,
  **Activated and Triggered abilities** on an **interruptible phase machine**,
  **rule 356 cost modification**, first-class legal action generation,
  per-player observable views, and a structural invariant checker.

  With Combat in, the engine can play a complete game of Riftbound with vanilla
  cards: contest a Battlefield, fight over it, take Control, and score to 8.
- **`@riftbound/ai`** — the `Agent` interface, a seeded random legal agent, a
  **heuristic agent**, and a single-game runner that keeps agents honest. The
  heuristic wins **~85% against random over 120 alternating-seat games**; the
  random-vs-random control measures ~50%, which is what says the harness is not
  just reporting first-player advantage.
- **`@riftbound/analysis`** — the analytic statistics: a hypergeometric core
  (including the multivariate case), cost curve, draw probabilities by turn,
  Domain/Power consistency, and per-card castability. No engine, no agent, no
  randomness — closed-form and exact.
- **`@riftbound/ingest`** — card data source adapters behind a `CardSource`
  interface, plus the gap model. Two exist: **`APITCG_SOURCE`** (the default,
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
- **`@riftbound/cli`** — `riftbound analyze|validate|sim <deck> --cards <cards.json>`
  and `riftbound ingest <raw> > cards.json`, with text or `--json` output.
  Ingest writes cards to stdout and its gap report to stderr, so the redirect
  above yields data while the shortfall stays visible. This is where
  presentation lives; nothing below
  it formats anything. `packages/cli/examples/` holds invented sample cards and a
  legal deck list so the tool runs today, and the suite reads them so a broken
  example fails CI.

**The engine is now reconciled against the official Core Rules** (RUP4,
2026-07-16), and there are no `UNVERIFIED` placeholders left in it. Every rule
quantity in `GameConfig` cites its rule number.

What is **not** built yet, in rough dependency order:

1. **Additional costs** (rule 356.2), the one layer of cost modification left
   out. The non-standard costs it is paid with (356.7) — "kill a friendly
   unit", "discard 1" — are now expressible, so what remains is the *payment
   protocol*: a cost has to be provably payable before the card can be played
   (compare 422.3 for Discard), and the optional form needs a decision point
   during the Announce step (356.2.b.1) because choosing to pay changes the
   total.
2. **Choices for Triggered Abilities.** A Triggered Ability's target is not
   chosen on the way onto the Chain — `queueTriggers` carries `null` — so a
   trigger whose effect targets currently does nothing. Rule 402.2 makes those
   choices at the Make Relevant Choices step of resolution, which needs the
   sub-action protocol. Activated abilities and played cards are unaffected:
   both choose at play time, as 355.8 requires.
3. **Card text as effects.** Ingested cards carry their printed text but no
   `effect`, `abilities` or `costModifiers`, so a real pool plays as vanilla
   cards. This is now the largest gap between the engine's capabilities and
   what real cards do — everything the primitives, abilities and cost modifiers
   can express is unreachable from data until the text is parsed into them.

Focus (rule 313) *is* implemented, as part of Non-Combat Showdowns: granted to
the contesting player (345), passing on a pass (347.2.b) and when the last Chain
item resolves (346). What is still missing there is the Combat Showdown's
handling of it (464.2.c.1.a-b).

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
  choice needs the same sub-action protocol as the next item.
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
  suggest/    planned Deck edit recommendations
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
| `costs.ts` | Rule 356's layers: what a card or ability actually costs to play |
| `legal.ts` | `legalActions(state, player)` |
| `view.ts` | Per-player observable view; redacts hidden zones |
| `invariants.ts` | `checkInvariants(state)`, run after every action when fuzzing |
| `setup.ts` | `createGame` — entity creation, shuffles, opening hands, opens in the Mulligan |

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
- **Activated abilities are gated by three rules, not convenience**: 381 (the
  controller's own turn, Open State only), 380 (source on the Board) and 377
  (the cost is payable, exhausting the source included when printed — 414).
- **An optional trigger goes on the Chain *pending*.** Rule 383.3.a makes
  performing a "you may" its controller's choice at finalization, and
  383.3.e.2.b removes it from the Chain if they decline, so a pending item is
  the only thing `legalActions` will offer its controller until they answer.
- **`triggersUsed` counts per-turn limits** (383.3.e), keyed by source and
  ability index and cleared in the Ending Phase.

`TriggerCondition` covers `played` (383.4.a), `dies`, `conquer`,
`beginningPhase` (315.2.a) and `endOfTurn` (317.1).

### Effect primitives

`cards/effect.ts` holds the data, `engine/effects.ts` the interpreter. Adding a
primitive is a variant plus a case — never a code path per card.

Four of them encode a rule that is easy to get backwards:

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
- **A `move` is a real Move, and a Recall is not.** `move` Contests its
  Destination (450), can open a Showdown or Combat (451-452), and is followed
  by a Cleanup (453) — the same tail the Standard Move runs, shared as
  `afterMove` rather than duplicated. It costs no exhaust: that is the Standard
  Move's price (420.3.a), not an instructed Move's.
- **Channelling an empty Rune Deck is not a Burn Out.** Rule 430.3 channels as
  many as possible and stops; 431's Burn Out, and the point it hands an
  opponent, belongs to the *Main* Deck alone.

`XP` (728-733) sits on `PlayerState` rather than being an entity, because 731
says it is not a Game Object and cannot be targeted, readied or exhausted. It
has no cap (733).

`executeEffect` takes an `EffectContext` rather than reaching for the reducer:
drawing can cause a Burn Out, killing has to touch the Chain, and a Move runs
the Contest/Cleanup/Showdown tail — all of which live above this layer.

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

Layer 2, additional costs, is absent; see the list under Current status for why.

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
3. **Search agent** — MCTS or similar with determinization over hidden information.

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

The head-to-head loop lives in `heuristic.test.ts`, not in `ai/` — `playGame`
runs one game, and batch simulation belongs to the planned `sim` package. It
alternates seats, because the player going second Channels an extra Rune (485.7)
and a fixed seating would measure that alongside the agents.

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

## Card data

**A usable source exists.** `apitcg/riftbound-tcg-data` commits one JSON file
per set at `cards/en/`, derived from the official Riot gallery, and is
reachable on `raw.githubusercontent.com`. It carries **Might**, the **Champion
and Signature supertypes**, and **printed Spell timing** — the three things the
older community export lacked.

Ingest it with the default source:

```bash
curl -sO https://raw.githubusercontent.com/apitcg/riftbound-tcg-data/main/cards/en/origins.json
node packages/cli/dist/main.js ingest origins.json > cards.json
```

### What it yields

541 card records in (699 minus sealed products and tokens), **479 cards out**,
covering every card type including 322 Units and 157 Champion Units. A legal
deck builds and validates from it with no issues, and the engine plays complete
games with it — 300 games, all decided, heuristic 61.7% ± 5.5 against random.

What it still cannot supply:

| Missing | Cards lost | Why |
|---|---|---|
| Spell `timing` | 43 | The ACTION/REACTION marker is not printed in that card's text |
| Power pip Domains | 18 | `powerCost` is a pip *count*, so a multi-Domain card's cost is ambiguous |
| `might` | 1 | One Unit record has none |
| Champion Tag on Signature cards | 0 dropped, 30 degraded | See the inference below |

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

**The rules text is captured but not parsed.** Cards arrive with their printed
text in `text` and no `effect`, `abilities` or `costModifiers` — so an ingested
pool plays as vanilla cards. Turning text into the effect model is the next
large piece of work, and it is what makes the primitives, abilities and cost
modifiers actually reachable from real cards.

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
