import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseDeckList, toCardLists } from "@riftbound/deck";
import { describe, expect, it } from "vitest";

import { CardDataError, parseCardsJson } from "./cards-file.js";
import { EXIT, run, type FileReader } from "./run.js";

const examples = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../examples/${name}`, import.meta.url)),
    "utf8",
  );

const CARDS = examples("cards.json");
const DECK = examples("deck.txt");

/** Serves the example files by name; anything else is a missing file. */
const files: FileReader = (path) => {
  if (path === "deck.txt") return DECK;
  if (path === "cards.json") return CARDS;
  throw new Error(`ENOENT: no such file or directory, open '${path}'`);
};

const analyze = (...args: string[]) =>
  run(["analyze", "deck.txt", "--cards", "cards.json", ...args], files);

describe("card data loading", () => {
  it("reads the example card file", () => {
    const cards = parseCardsJson(CARDS);
    expect(cards.length).toBeGreaterThan(15);
    expect(cards.filter((card) => card.type === "rune")).toHaveLength(2);
    expect(cards.filter((card) => card.type === "battlefield")).toHaveLength(3);
  });

  it("rejects input that is not JSON", () => {
    expect(() => parseCardsJson("{ nope")).toThrow(CardDataError);
  });

  it("rejects a JSON object that is not an array", () => {
    expect(() => parseCardsJson('{"id":"X"}')).toThrow(
      /array of card definitions/,
    );
  });

  it("reports every problem at once rather than the first", () => {
    try {
      parseCardsJson(
        '[{"id":"","name":"","type":"nope"},{"type":"rune","id":"R","name":"R"}]',
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CardDataError);
      expect((error as CardDataError).problems.length).toBeGreaterThan(1);
    }
  });

  it("rejects an invalid Domain", () => {
    expect(() =>
      parseCardsJson(
        '[{"id":"X","name":"X","type":"battlefield","domains":["shadow"]}]',
      ),
    ).toThrow(/not a Domain/);
  });

  it("rejects a malformed cost", () => {
    expect(() =>
      parseCardsJson(
        '[{"id":"X","name":"X","type":"unit","might":1,"cost":{"energy":-1}}]',
      ),
    ).toThrow(/non-negative integer/);
  });

  it("rejects a Legend with no Domain Identity", () => {
    expect(() =>
      parseCardsJson('[{"id":"L","name":"L","type":"legend"}]'),
    ).toThrow(/domainIdentity/);
  });

  it("rejects a Rune with no Domain", () => {
    expect(() =>
      parseCardsJson('[{"id":"R","name":"R","type":"rune"}]'),
    ).toThrow(/needs a "domain"/);
  });

  it("rejects a Spell with an unknown timing", () => {
    expect(() =>
      parseCardsJson(
        '[{"id":"S","name":"S","type":"spell","cost":{"energy":1},"timing":"soon"}]',
      ),
    ).toThrow(/action.*reaction/);
  });

  it("reads the Champion Tag and Signature supertype (rules 133.7.b, 133.8.b)", () => {
    const [card] = parseCardsJson(
      '[{"id":"S","name":"S","type":"spell","cost":{"energy":1},"timing":"action",' +
        '"championTag":"Jinx","signature":true}]',
    );
    expect(card?.championTag).toBe("Jinx");
    expect(card?.signature).toBe(true);
  });

  it("leaves the Champion Tag undefined when the data omits it", () => {
    const [card] = parseCardsJson(
      '[{"id":"B","name":"B","type":"battlefield"}]',
    );
    expect(card?.championTag).toBeUndefined();
    expect(card?.signature).toBe(false);
  });

  it("rejects a malformed Champion Tag or Signature flag", () => {
    expect(() =>
      parseCardsJson(
        '[{"id":"B","name":"B","type":"battlefield","championTag":7}]',
      ),
    ).toThrow(/"championTag" must be a non-empty string/);
    expect(() =>
      parseCardsJson(
        '[{"id":"B","name":"B","type":"battlefield","signature":"yes"}]',
      ),
    ).toThrow(/"signature" must be a boolean/);
  });

  it("rejects duplicate ids through the registry", () => {
    const duplicate =
      '[{"id":"B","name":"One","type":"battlefield"},{"id":"B","name":"Two","type":"battlefield"}]';
    const result = run(
      ["validate", "deck.txt", "--cards", "dup.json"],
      (path) => (path === "deck.txt" ? DECK : duplicate),
    );
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toMatch(/Duplicate card id/);
  });
});

describe("usage", () => {
  it("prints help on request", () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const result = run(argv, files);
      expect(result.code).toBe(EXIT.ok);
      expect(result.stdout).toMatch(/riftbound — deck testing tools/);
    }
  });

  it("reports no command as a usage error", () => {
    const result = run([], files);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/No command given/);
  });

  it("rejects an unknown command", () => {
    const result = run(["simulate", "deck.txt"], files);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/Unknown command "simulate"/);
  });

  it("rejects an unknown option", () => {
    const result = run(["analyze", "deck.txt", "--nonsense"], files);
    expect(result.code).toBe(EXIT.usage);
  });

  it("requires a deck file", () => {
    const result = run(["analyze", "--cards", "cards.json"], files);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/needs a deck list file/);
  });

  it("requires card data", () => {
    const result = run(["analyze", "deck.txt"], files);
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/--cards is required/);
  });

  it("rejects an unknown format", () => {
    const result = analyze("--format", "commander");
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/Use bo1 or bo3/);
  });

  it("rejects a bad turn number", () => {
    expect(analyze("--turn", "soon").code).toBe(EXIT.usage);
    expect(analyze("--turn", "-2").code).toBe(EXIT.usage);
  });
});

describe("missing input", () => {
  it("reports an unreadable deck file", () => {
    const result = run(["analyze", "nope.txt", "--cards", "cards.json"], files);
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toMatch(/Cannot read deck list "nope.txt"/);
  });

  it("reports unreadable card data", () => {
    const result = run(["analyze", "deck.txt", "--cards", "nope.json"], files);
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toMatch(/Cannot read card data "nope.json"/);
  });

  it("reports deck list parse errors with line numbers", () => {
    const result = run(
      ["analyze", "bad.txt", "--cards", "cards.json"],
      (path) => (path === "cards.json" ? CARDS : "3 SAMPLE-010\n"),
    );
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toMatch(/line 1:/);
  });
});

describe("validate", () => {
  it("accepts the example deck", () => {
    const result = run(
      ["validate", "deck.txt", "--cards", "cards.json"],
      files,
    );
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/^LEGAL for Constructed \(best-of-one\)/);
  });

  it("rejects the example deck when a sideboard is required to be absent", () => {
    // The example has no sideboard, so best-of-three is legal too.
    const result = run(
      ["validate", "deck.txt", "--cards", "cards.json", "--format", "bo3"],
      files,
    );
    expect(result.code).toBe(EXIT.ok);
  });

  it("exits 1 and lists the problems for an illegal deck", () => {
    const short = DECK.replace("3 SAMPLE-010\n", "");
    const result = run(
      ["validate", "short.txt", "--cards", "cards.json"],
      (path) => (path === "cards.json" ? CARDS : short),
    );

    expect(result.code).toBe(EXIT.illegal);
    expect(result.stdout).toMatch(/ILLEGAL/);
    expect(result.stdout).toMatch(/main-deck-size/);
  });

  it("emits JSON on request", () => {
    const result = run(
      ["validate", "deck.txt", "--cards", "cards.json", "--json"],
      files,
    );
    const parsed = JSON.parse(result.stdout) as {
      legal: boolean;
      issues: unknown[];
    };

    expect(parsed.legal).toBe(true);
    expect(parsed.issues).toEqual([]);
  });

  it("shows warnings on a deck that is still legal", () => {
    // `replace` hits the first occurrence only, which is the Legend's tag.
    // Without it rule 103.2.a.2 cannot be checked — a gap worth surfacing.
    const untagged = CARDS.replace(',\n    "championTag": "Ember Warden"', "");
    const result = run(
      ["validate", "deck.txt", "--cards", "untagged.json"],
      (path) => (path === "deck.txt" ? DECK : untagged),
    );

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/^LEGAL/);
    expect(result.stdout).toMatch(/Warnings:/);
    expect(result.stdout).toMatch(/champion-tag-unknown/);
  });
});

describe("ingest", () => {
  /** Two cards in the community export's shape: one usable, one not. */
  const RAW = JSON.stringify([
    {
      publicCode: "OGN-275/298",
      name: "Altar to Unity",
      domains: [{ id: "colorless", label: "Colorless" }],
      cardType: [{ id: "battlefield", label: "Battlefield" }],
      text: "<p>When you hold here, play a unit token.</p>",
    },
    {
      publicCode: "OGN-001/298",
      name: "Blazing Scorcher",
      domains: [{ id: "fury", label: "Fury" }],
      cardType: [{ id: "unit", label: "Unit" }],
      text: "<p>[Accelerate]</p>",
      energy: 5,
    },
  ]);

  const ingest = (...args: string[]) =>
    run(["ingest", "raw.json", "--source", "community", ...args], (path) => {
      if (path === "raw.json") return RAW;
      throw new Error(`ENOENT: ${path}`);
    });

  it("writes normalized cards to stdout", () => {
    const result = ingest();
    const cards = JSON.parse(result.stdout) as { id: string; type: string }[];

    expect(result.code).toBe(EXIT.ok);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe("OGN-275");
    expect(cards[0]?.type).toBe("battlefield");
  });

  it("reports the dropped cards on stderr, not stdout", () => {
    // stdout has to stay pipeable into a cards.json file.
    const result = ingest();
    expect(result.stderr).toMatch(/Ingested 1 of 2 cards/);
    expect(result.stderr).toMatch(/might \(1\)/);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("emits the gaps alongside the cards in JSON mode", () => {
    const result = ingest("--json");
    const parsed = JSON.parse(result.stdout) as {
      source: string;
      gaps: { field: string }[];
    };

    expect(parsed.source).toBe("community-json");
    expect(parsed.gaps.map((gap) => gap.field)).toContain("might");
  });

  it("produces card data the loader accepts", () => {
    // The two ends of the pipeline have to agree on the schema.
    const cards = parseCardsJson(ingest().stdout);
    expect(cards[0]?.name).toBe("Altar to Unity");
  });

  it("needs a file to read", () => {
    expect(run(["ingest"], files).code).toBe(EXIT.usage);
  });

  it("reports a file it cannot read", () => {
    const result = run(["ingest", "missing.json"], files);
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toMatch(/Cannot read card data/);
  });

  it("defaults to the apitcg source, which carries Might", () => {
    // The one field that decides whether Units survive at all (465-466).
    const apitcg = JSON.stringify([
      {
        id: "origins-001-298",
        name: "Blazing Scorcher",
        cardType: "Unit",
        domain: "Fury",
        energyCost: "5",
        powerCost: "0",
        might: "5",
        description: "",
      },
    ]);
    const result = run(["ingest", "raw.json"], () => apitcg);
    const cards = JSON.parse(result.stdout) as {
      type: string;
      might: number;
    }[];

    expect(result.code).toBe(EXIT.ok);
    expect(cards[0]).toMatchObject({ type: "unit", might: 5 });
  });

  it("rejects an unknown source", () => {
    const result = run(["ingest", "raw.json", "--source", "nope"], () => "[]");
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/Unknown source "nope"/);
  });

  it("reports input that is not JSON", () => {
    const result = run(
      ["ingest", "raw.json", "--source", "community"],
      () => "{ nope",
    );
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toMatch(/not valid JSON/);
  });

  it("reports input that is not an array of cards", () => {
    const result = run(
      ["ingest", "raw.json", "--source", "community"],
      () => '{"cards":[]}',
    );
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toMatch(/array of cards/);
  });
});

describe("sim", () => {
  const sim = (...args: string[]) =>
    run(
      ["sim", "deck.txt", "--cards", "cards.json", "--games", "30", ...args],
      files,
    );

  it("reports win rates with a sample size and an interval", () => {
    const result = sim();
    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toMatch(/30 games/);
    expect(result.stdout).toMatch(/heuristic/);
    expect(result.stdout).toMatch(/95% CI/);
    // A rate is never printed without its interval.
    expect(result.stdout).toMatch(/±/);
  });

  it("is reproducible for a given seed", () => {
    expect(sim("--seed", "fixed").stdout).toBe(sim("--seed", "fixed").stdout);
  });

  it("gives different seeds different batches", () => {
    expect(sim("--seed", "a").stdout).not.toBe(sim("--seed", "b").stdout);
  });

  it("emits the full result on --json", () => {
    const parsed = JSON.parse(sim("--json").stdout) as {
      games: number;
      entrants: { name: string; interval: { low: number; high: number } }[];
    };
    expect(parsed.games).toBe(30);
    expect(parsed.entrants[0]?.name).toBe("heuristic");
    expect(parsed.entrants[0]?.interval.low).toBeLessThanOrEqual(
      parsed.entrants[0]!.interval.high,
    );
  });

  it("rejects a non-positive game count", () => {
    const result = run(
      ["sim", "deck.txt", "--cards", "cards.json", "--games", "0"],
      files,
    );
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toMatch(/--games must be a positive integer/);
  });

  it("needs a deck list", () => {
    expect(run(["sim"], files).code).toBe(EXIT.usage);
  });
});

describe("analyze", () => {
  const report = analyze().stdout;

  it("succeeds on the example deck", () => {
    expect(analyze().code).toBe(EXIT.ok);
  });

  it("names the Legend, Champion and format", () => {
    expect(report).toMatch(/Legend:\s+Ember Warden/);
    expect(report).toMatch(/Champion:\s+Ashen Vanguard/);
    expect(report).toMatch(/Format:\s+Constructed \(best-of-one\)/);
    expect(report).toMatch(/Legality: LEGAL/);
  });

  it("reports the deck sizes", () => {
    expect(report).toMatch(/40 main · 12 Runes · 3 Battlefields/);
  });

  it("draws both cost curves", () => {
    expect(report).toContain("Cost curve (Energy)");
    expect(report).toContain("Cost curve (total Runes: Energy + Power)");
    expect(report).toContain("█");
  });

  it("shows Rune supply against Power demand", () => {
    expect(report).toContain("Domains");
    expect(report).toMatch(/fury\s+6\s+50\.0%/);
  });

  it("reports opening hand expectations", () => {
    expect(report).toMatch(/Opening hand \(4 cards\)/);
    expect(report).toMatch(/unit/);
  });

  it("lists castability with an earliest turn and Power odds", () => {
    expect(report).toContain("Castability");
    expect(report).toMatch(/Kindling Scout/);
    expect(report).toMatch(/Ashfall Titan/);
  });

  it("lists draw odds at the requested turn", () => {
    expect(analyze("--turn", "5").stdout).toContain("By turn 5");
  });

  it("is deterministic: the analysis has no randomness in it", () => {
    expect(analyze().stdout).toEqual(analyze().stdout);
  });

  it("still reports on an illegal deck, but exits 1", () => {
    const short = DECK.replace("3 SAMPLE-010\n", "");
    const result = run(
      ["analyze", "short.txt", "--cards", "cards.json"],
      (path) => (path === "cards.json" ? CARDS : short),
    );

    expect(result.code).toBe(EXIT.illegal);
    expect(result.stdout).toMatch(/Legality: ILLEGAL/);
    expect(result.stdout).toContain("main-deck-size");
    // The statistics are still useful while fixing the deck.
    expect(result.stdout).toContain("Cost curve");
  });

  it("refuses to analyse a deck with unknown cards", () => {
    const unknown = DECK.replace("3 SAMPLE-010", "3 SAMPLE-999");
    const result = run(
      ["analyze", "unknown.txt", "--cards", "cards.json"],
      (path) => (path === "cards.json" ? CARDS : unknown),
    );

    expect(result.code).toBe(EXIT.illegal);
    expect(result.stderr).toMatch(
      /Cannot analyse a deck containing unknown cards/,
    );
    expect(result.stdout).toBe("");
  });
});

describe("analyze --json", () => {
  const parsed = JSON.parse(analyze("--json").stdout) as Record<string, never>;

  it("serialises the Maps instead of emitting empty objects", () => {
    // JSON.stringify turns a Map into {} without complaining, so this is the
    // guard that the machine-readable output is not silently empty.
    const curve = parsed["curve"] as unknown as {
      byEnergy: Record<string, number>;
    };
    expect(Object.keys(curve.byEnergy).length).toBeGreaterThan(0);

    const domains = parsed["domains"] as unknown as {
      runeCounts: Record<string, number>;
    };
    expect(domains.runeCounts["fury"]).toBe(6);
    expect(domains.runeCounts["calm"]).toBe(6);
  });

  it("reports legality and deck sizes", () => {
    expect(parsed["legal"]).toBe(true);
    expect(parsed["mainDeckSize"]).toBe(40);
    expect(parsed["runeDeckSize"]).toBe(12);
  });

  it("includes castability for every playable main deck card", () => {
    expect((parsed["castability"] as unknown as unknown[]).length).toBe(14);
  });

  it("round-trips through JSON.parse without loss", () => {
    expect(() => JSON.parse(analyze("--json").stdout)).not.toThrow();
  });
});

describe("ingest from several set files", () => {
  it("takes more than one raw file, because card data ships per set", () => {
    const first = JSON.stringify([
      {
        id: "set-a-001",
        name: "Alpha",
        cardType: "Unit",
        domain: "Fury",
        energyCost: "2",
        powerCost: "0",
        might: "2",
        description: "",
      },
    ]);
    const second = JSON.stringify([
      {
        id: "set-b-001",
        name: "Beta",
        cardType: "Unit",
        domain: "Calm",
        energyCost: "3",
        powerCost: "0",
        might: "3",
        description: "",
      },
    ]);
    const result = run(["ingest", "a.json", "b.json"], (path) =>
      path === "a.json" ? first : second,
    );

    expect(result.code).toBe(EXIT.ok);
    const cards = JSON.parse(result.stdout) as { name: string }[];
    expect(cards.map((card) => card.name).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("collapses a card reprinted into a second set (103.2.b.2)", () => {
    // Same name in two sets is the same card, so concatenating before
    // normalizing is what lets the printing rule see both and keep one.
    const set = (id: string) =>
      JSON.stringify([
        {
          id,
          name: "Reprint",
          cardType: "Unit",
          domain: "Fury",
          energyCost: "2",
          powerCost: "0",
          might: "2",
          description: "",
        },
      ]);
    const result = run(["ingest", "a.json", "b.json"], (path) =>
      path === "a.json" ? set("set-a-001") : set("set-b-001"),
    );

    expect(JSON.parse(result.stdout)).toHaveLength(1);
  });

  it("names the file it could not read", () => {
    const result = run(["ingest", "ok.json", "missing.json"], (path) => {
      if (path === "missing.json") {
        throw new Error("ENOENT");
      }
      return "[]";
    });
    expect(result.code).toBe(EXIT.input);
    expect(result.stderr).toContain("missing.json");
  });

  it("still asks for at least one file", () => {
    expect(run(["ingest"], () => "").code).toBe(EXIT.usage);
  });
});

describe("the real-card example deck", () => {
  // Only its shape can be checked here: it names real collector numbers, and
  // this repository does not commit the real card data (see CLAUDE.md's open
  // question on licensing). Parsing needs no card data, so a typo in the file
  // still fails CI even though validation cannot run.
  const REAL_DECK = examples("real-deck.txt");

  it("parses into a legal-sized deck", () => {
    const parsed = parseDeckList(REAL_DECK);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const lists = toCardLists(parsed.deck);
    expect(lists.main).toHaveLength(40);
    expect(lists.runes).toHaveLength(12);
    expect(lists.battlefields).toHaveLength(3);
  });

  it("tells the reader how to get the card data it needs", () => {
    expect(REAL_DECK).toContain("riftbound-tcg-data");
    expect(REAL_DECK).toContain("ingest");
  });
});

describe("the suggest command", () => {
  it("reports the objective, the baseline and the edits that improve it", () => {
    const result = run(
      ["suggest", "deck.txt", "--cards", "cards.json"],
      (path) => (path === "deck.txt" ? DECK : CARDS),
    );

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Objective: consistency");
    expect(result.stdout).toMatch(/Evaluated: \d+ candidate edit/);
  });

  it("emits the whole report as JSON", () => {
    const result = run(
      ["suggest", "deck.txt", "--cards", "cards.json", "--json"],
      (path) => (path === "deck.txt" ? DECK : CARDS),
    );
    const report = JSON.parse(result.stdout) as {
      objective: string;
      baseline: { total: number };
      suggestions: unknown[];
    };

    expect(report.objective).toBe("consistency");
    expect(report.baseline.total).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(report.suggestions)).toBe(true);
  });

  it("rejects an objective it does not have", () => {
    const result = run(
      [
        "suggest",
        "deck.txt",
        "--cards",
        "cards.json",
        "--objective",
        "winrate",
      ],
      (path) => (path === "deck.txt" ? DECK : CARDS),
    );
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain("Unknown objective");
  });

  it("rejects a limit that is not a positive integer", () => {
    const result = run(
      ["suggest", "deck.txt", "--cards", "cards.json", "--limit", "0"],
      (path) => (path === "deck.txt" ? DECK : CARDS),
    );
    expect(result.code).toBe(EXIT.usage);
  });

  it("proposes no additions under --pool none", () => {
    // Suggesting a card the owner does not have is shopping, not a deck edit,
    // so `--pool none` is the setting for "tune what I already own".
    const result = run(
      [
        "suggest",
        "deck.txt",
        "--cards",
        "cards.json",
        "--pool",
        "none",
        "--json",
      ],
      (path) => (path === "deck.txt" ? DECK : CARDS),
    );
    const report = JSON.parse(result.stdout) as {
      suggestions: { edit: { kind: string } }[];
    };

    expect(report.suggestions.length).toBeGreaterThan(0);
    expect(report.suggestions.every((s) => s.edit.kind !== "add")).toBe(true);
  });

  it("says so plainly when nothing improves the objective", () => {
    // A deck whose Runes already match its demand has nothing to re-ratio.
    const tuned = DECK.replace(/^\d+ SAMPLE-10[01]$/gm, "").replace(
      /# Runes/,
      "# Runes\n12 SAMPLE-100",
    );
    const result = run(
      ["suggest", "deck.txt", "--cards", "cards.json", "--pool", "none"],
      (path) => (path === "deck.txt" ? tuned : CARDS),
    );

    expect(result.code).toBe(EXIT.ok);
    expect(result.stdout).toContain("Nothing to suggest");
  });
});
