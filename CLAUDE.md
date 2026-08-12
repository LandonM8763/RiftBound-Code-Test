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
with damage spells, draw and Play Effects firing. 95 of the 468 cards with text
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
  XP, Channel, Tokens), **the Mulligan**,
  **Activated and Triggered abilities** on an **interruptible phase machine**,
  **event-driven trigger conditions**, **rule 356 cost modification** including
  **Additional Costs**, **static and passive abilities**, **state predicates**,
  **Tokens** (179-187), the **keywords** Assault, Shield, Tank,
  Backline and Ganking, the **Dependent Keywords** Legion and Level,
  first-class legal action generation, per-player observable views, and a
  structural invariant checker.

  With Combat in, the engine can play a complete game of Riftbound: contest a
  Battlefield, fight over it, take Control, and score to 8.
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

1. **Choices for Triggered Abilities.** A Triggered Ability's target is not
   chosen on the way onto the Chain — `queueTriggers` carries `null` — so a
   trigger whose effect targets currently does nothing. Rule 402.2 makes those
   choices at the Make Relevant Choices step of resolution, which needs the
   sub-action protocol. Activated abilities and played cards are unaffected:
   both choose at play time, as 355.8 requires.
2. **The keywords that need mechanics the engine has no representation for.**
   Assault, Shield, Tank, Backline and Ganking are built as engine rules and
   **Accelerate desugars** (805.1.a is an Optional Additional Cost plus "if you
   do, I enter ready", and both halves now exist). The rest are refused with a
   stated reason in `UNMODELLED_KEYWORDS`, and each reason is a mechanic rather
   than a keyword: Deflect wants a Power cost of any Domain that `Cost` cannot
   express, Hidden wants facedown cards, Equip and Weaponmaster want Attach,
   Vision wants Predict (436) — a choice made during resolution, so item 1's
   protocol. **Repeat is the exception: it is no longer blocked** — 820.1.d is
   the same optional-cost shape — but it measured **+0 cards** and so is not
   built. Its reason in `UNMODELLED_KEYWORDS` records that rather than a
   blocker, which is the honest thing for it to say.
3. **Statics that are not a scope plus a grant.** Might modifiers, granted
   keywords and "enters ready" are built; a *dynamic* Might ("increased by your
   points"), a duration ("units you play this turn enter ready") and a rule
   change ("opponents can only play units to their base") are not.
4. **Abilities on Battlefields.** A Battlefield is not a Game Object here —
   `BattlefieldState` holds a card id, not an entity — so nothing sweeps one for
   abilities. Ingest drops them and records a gap rather than shipping a card
   that looks modelled and silently never runs. 12 cards in the corpus. The same
   gap is why `TokenSpec.type` excludes the Battlefield tokens of 187.8-187.9.
5. **Conditional and modal effects** — "if this kills it", "unless its
   controller…", "choose one •…", "for each…". *State* predicates and "if you
   paid the additional cost" are built; what is left is a condition on an
   effect's own outcome, counting, and modes.

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
| `additional.ts` | Additional Costs (356.2): what can be paid, and paying it |
| `statics.ts` | Static and Passive abilities: Might, granted keywords, entering ready |
| `costs.ts` | Rule 356's layers: what a card or ability actually costs to play |
| `legal.ts` | `legalActions(state, player)` |
| `view.ts` | Per-player observable view; redacts hidden zones |
| `token.ts` | Tokens (179-187): Creating them, and 186.1's rule that one leaving the Board stops existing |
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
- **Activated abilities are gated by four rules, not convenience**: 381 (the
  controller's own turn, Open State only), 380 (source on the Board), 377
  (the cost is payable, exhausting the source included when printed — 414) and
  801.1 (a Dependent Keyword's condition holds).
- **An optional trigger goes on the Chain *pending*.** Rule 383.3.a makes
  performing a "you may" its controller's choice at finalization, and
  383.3.e.2.b removes it from the Chain if they decline, so a pending item is
  the only thing `legalActions` will offer its controller until they answer.
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
| `event` | 383.2 | What happened: `played`, `dies`, `conquer`, `hold`, `move`, `winCombat`, `buffed`, `discard`, `activateAbility`, `beginningPhase`, `endOfTurn` |
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

`filter.ordinal` and `limitPerTurn` are different things and both exist: the
ordinal picks *which* occurrence fires ("your second card in a turn"), the limit
caps *how often* the ability may ("the first time … each turn").

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
| `affects` | `self` / `friendly` / `enemy` / `any`, plus `here` (355.9) and `excludeSelf` for "other" |
| `grant` | `might`, `keywords` (801.3.a), `entersReady` (replacing 359.2.c) |
| `condition` | "While I'm buffed", "While I'm at a battlefield" — about the **source**, not its objects |

Four things are load-bearing:

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
- **A `self` static is read off the card in hand**, exactly like a `self` cost
  modifier, because that is where the card still is when the question matters.

**Battlefields cannot carry any of this.** `BattlefieldState` holds a card id
rather than an entity, so there is no Game Object for `activeStatics` or
`triggersFor` to find. Ingest therefore *drops* a Battlefield's abilities and
records a gap: shipping them would leave a card that looks modelled while the
engine silently never ran it, which is precisely the plausible-and-wrong outcome
the gap model exists to prevent.

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

### Keywords

Rules 800-828, with the data in `cards/keyword.ts`. Rule 801 says a Keyword is
"a shorthand for a specific game effect", and the glossary means it literally —
every entry gives an expansion, "functionally short for …". That sentence is the
whole design, and it sorts keywords into three kinds:

| Kind | Where it lives | Examples |
|---|---|---|
| Shorthand for something already modelled | **desugared at ingest**, never reaches the engine as a keyword | Deathknell → a `dies` trigger (808.1.c); Temporary → a Beginning Phase self-kill (816.1.b); Action/Reaction → `SpellCard.timing` |
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

- **A keyword granted by an effect is refused, not read as the card having it.**
  "Give a unit ASSAULT 3 this turn" is a static ability the effect model cannot
  express, and mistaking it would give the wrong Unit the keyword, permanently.
  The keyword patterns are anchored to a whole line for exactly this reason.
- **Keywords ride the same all-or-nothing rule as everything else.** A card
  whose other clause is unreadable keeps neither. That is why only 11 ingested
  cards carry a keyword while 55 parse fully.

`Keyword` stacking follows the rules rather than the callers: valued keywords
sum (807.2, 814.2) and unvalued ones are redundant (810.2, 815.2, 826.5), which
is what `keywordValue` and `hasKeyword` are for.

**Legion needs identities, not a count.** 812.1.c satisfies it when "a card
*different than* the one with the Legion ability" has been Finalized this turn —
and a card's own Play Effect is checked while that card is already in the list.
So `PlayerState.playedThisTurn` holds entity ids; a count would satisfy every
Legion trigger on the first card played. It clears in the Ending Phase, because
812.1.c scopes it to "the same turn".

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
- **A token enters exhausted unless 184.1 says otherwise.** 359.2.c is the
  default for any Unit reaching the Board, so `ready` defaults to false.
  Inverted, every token would arrive with a free Standard Move.
- **185.3 leaves a token with no cost and no domain.** `FREE` and `[]` are the
  closest this model can state and neither is ever read: a token is Created on
  the Board (186), never played from a hand, so its cost is never paid and its
  domains never checked against a Domain Identity.

**Battlefield tokens (187.8, 187.9) are excluded**, for the same reason
Battlefield abilities are: `BattlefieldState` holds a card id rather than an
entity, so one could be created and then never consulted.

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
- **A `move` is a real Move, and a Recall is not.** `move` Contests its
  Destination (450), can open a Showdown or Combat (451-452), and is followed
  by a Cleanup (453) — the same tail the Standard Move runs, shared as
  `afterMove` rather than duplicated. It costs no exhaust: that is the Standard
  Move's price (420.3.a), not an instructed Move's.
- **Channelling an empty Rune Deck is not a Burn Out.** Rule 430.3 channels as
  many as possible and stops; 431's Burn Out, and the point it hands an
  opponent, belongs to the *Main* Deck alone.
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

### Suggestions

`packages/suggest`. Rules the recommendations obey are rule 103's; the design
decisions are these.

**The objective is pluggable, and that is the point.** Open question 4 — what
"suggest edits" should optimize for — is not answered in the code. An
`Objective` is a function from a deck to a score, `suggestEdits` ranks candidate
edits by how far they move it, and swapping the objective swaps what the tool is
for without touching the search.

**The default is `CONSISTENCY`, and the reason is not taste.** A *simulated*
objective is not trustworthy yet: 373 of the 468 cards with rules text still
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
covering every card type including 322 Units and 157 Champion Units. A legal
deck builds and validates from it with no issues, and the engine plays complete
games with it — 300 games, all decided, heuristic 58.7% ± 5.5 against random.

72 of those cards carry an ability and 14 a keyword. The keyword figure is low
against the 95 that parse because keywords ride the same all-or-nothing rule:
a card whose other clause is unreadable keeps neither. 11 create Tokens and 6
carry Accelerate.

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

### Turning text into effects

`ingest/text.ts` parses printed text into the effect model over a known
grammar. **The parse is all-or-nothing per card**: if every clause is
understood the card gets its effect and abilities, and if one clause is not the
card stays vanilla and the clause is recorded as a `text` gap. A partial parse
would be worse than none — "Deal 6 to it unless its controller has you draw 2"
reduced to "deal 6" is a card that plays, looks right, and is wrong.

It covers `Draw N`, `Deal N to a unit [at a battlefield]`, `Give a unit +N
Might this turn`, `Kill`, `Ready`, `Buff`, `Heal`, `Discard N`, `Channel N
rune(s) [exhausted]`, `ADD` resources and `Gain N XP`; the self-targeting forms
(`Ready/Buff/Heal/Exhaust/Recall me`, `Give me +N Might this turn`); sequences
joined by "then" or "and"; the trigger grammar below; `Play [N] [ready] <M>
Might <Name> unit token [here|in your base]`; the modelled keywords and the
desugared ones (`DEATHKNELL - <effects>`, `TEMPORARY`, `ACCELERATE`,
`LEGION - <ability>`); and Activated abilities written `[N,] Exhaust: <effects>`.

`parseCardText` takes a second argument, `CardFacts`, and it holds exactly one
field. Almost every clause is readable from the words alone and the grammar is
better for not having the whole card to reach into; the one exception is
Accelerate, whose Power is the Unit's *own* Domain (805.1.a.1) and appears
nowhere in the printed line.

Trigger conditions are parsed as an event plus a subject plus a filter rather
than one pattern per sentence — see [Abilities](#abilities) for the shape. The
grammar strips two orthogonal wrappers first: "the first time … each turn" is
rule 383.3.e's per-turn limit, and "when"/"whenever" is noise.

**Coverage is 95 of the 468 cards that have text**, and the shape of what is
left is the finding rather than the number:

| | Cards |
|---|---|
| With printed text | 468 |
| Fully parsed | 95 |
| Blocked | 373 |

At the level of literal clause strings the unparsed tail is **flat** — the most
common clause the grammar misses appears 3 or 4 times, everything else once or
twice. More regexes buy roughly one card each. The head is one level up, in the
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

**Tokens took it 78 → 89**, and **Accelerate 89 → 95.**

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

Re-measured by counterfactual from the 89 baseline (tokens in, Accelerate not),
one mechanic at a time and then in build order:

| Mechanic | Alone |
|---|---|
| **Tokens (179-187)** — now built | **+9 projected, +11 delivered** |
| The 8 refused keywords | +11 |
| **Accelerate (805)** — now built | **+5 projected, +6 delivered** |
| Zone movement (bounce to hand, recycle from trash) | +5 |
| Statics beyond scope-plus-grant | +4 |
| Keywords granted by an effect ("give a unit ASSAULT 3") | +4 |
| Durations and delayed effects ("the next spell you play…") | +3 |
| Counting / dynamic values | +2 |
| Non-standard ability costs | +2 |
| Effect-outcome predicates ("if this kills it") | +1 |
| Modal effects ("choose one •…") | +0 |

**Projections run optimistic, except when they do not.** Additional Costs
projected +8 and delivered +4; tokens projected +9 and delivered +11. A
counterfactual rewrite proves a *clause* stops blocking, which is neither an
upper nor a lower bound on what a real implementation reaches — treat these as
a ranking, not a forecast.

**The keyword figure is still a trap**, and now more so. Accelerate was +5 of
the +11 and it is built. What remains is Hidden +3, Vision +2, Deflect +1 and
four at +0, each wanting a *different* deep mechanic (facedown cards, Predict,
Power of any Domain, Attach). Repeat is not blocked at all any more — 820.1.d is
the optional-cost shape that now exists — but it measures **+0**, so it stays
refused with that as its stated reason.

Additional Costs and state predicates were the two best single investments and
**do not overlap**: together they measured +14 and delivered +10. The shortfall
is the payments that are still refused — "kill *any number of* friendly units",
"spend any number of buffs" — where a variable count is a choice as well as a
quantity, so the cost cannot be proven payable before the card is played.

**The trigger tail is now genuinely spent.** The 8 cards a wider condition would
still buy want 8 *distinct* wordings, and most need a mechanic that does not
exist — Stun, Hidden, and an event for choosing a target. There is no third
round of this to do.

What the corpus is blocked on now, in the order measurement puts them:

1. **Zone movement** — "Return me to my owner's hand", "recycle 3 from your
   trash", "play it from your trash". +5, and the largest coherent one left.
   The effect model can move a Permanent around the Board and to the trash; it
   cannot move a card *back* out of a Non-Board Zone, and bounce-to-hand is a
   distinct primitive from `recall` (which is Board-to-Base, 455).
2. **Statics beyond a scope plus a grant** — "My Might is increased by your
   points" (dynamic), "Units you play this turn enter ready" (a duration),
   "opponents can only play units to their base" (a rule change). +4. The
   scope-plus-grant form is built and took the corpus from 58 to 68; what is
   left in this category each wants a different mechanic.
3. **Keywords granted by an effect** — "Give a unit ASSAULT 3 this turn". +4.
   A static with a duration and a chosen subject, which is why it is refused
   today rather than read as the card having the keyword itself.
4. **The seven still-refused keywords**, each blocked on a mechanic: facedown
   cards (Hidden), Attach (Equip, Weaponmaster, Quick-Draw), Predict (Vision),
   Power of any Domain (Deflect). Repeat is blocked on nothing and worth +0.
5. **Conditional and modal effects** — "if this kills it", "unless its
   controller…", "choose one •…", "for each…". The effect model has no
   outcome conditions, no counting and no modes.
6. **Non-standard ability costs** — "Spend my buff:", "Recycle 1 from your
   trash:", "you may exhaust me to …". `ActivatedAbility.cost` is Energy, Power
   and the exhaust; 16 cards want more.

Self-targeting was on this list before keywords and triggers, and unlocked
**nothing** — every self-targeting card was blocked on something else. That is
the reason for the measure-first rule here: a mechanic's worth is what it
unlocks *in combination*, not that real cards use it. Do not add a mechanic to
this engine because the corpus mentions it; add it because deleting it from the
corpus moves the number.

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
