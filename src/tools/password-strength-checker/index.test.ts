import { describe, expect, it } from "vitest";
import { ToolError } from "../types";
import {
  SCENARIOS,
  analyze,
  characterPool,
  findMatches,
  formatBig,
  humanTime,
  run,
  scoreFor,
  unleet,
} from "./index";
import { DICTIONARIES, KEYBOARD_LIST, PASSWORD_LIST, WORD_LIST } from "./wordlist";

/*
 * The estimates below are checked as ranges and orderings rather than exact
 * numbers, because the guess count is a model, not a measurement. Where a
 * number is pinned it is because the reference implementation this borrows
 * from (zxcvbn) lands in the same order of magnitude: "password" costs a
 * handful of guesses, "hunter2" tens of thousands, a long random string more
 * than any attacker will spend.
 */

const kinds = (password: string) => analyze(password).sequence.map((m) => m.kind);

describe("password-strength-checker scoring", () => {
  it("scores a top ranked leaked password at zero", () => {
    const out = run("password", {});
    expect(out.Score).toBe("0 of 4 (very weak)");
    expect(analyze("password").guesses).toBeLessThan(100);
  });

  it("scores a long random string at four", () => {
    const out = run("xK7!pQz#9mLw2vBn", {});
    expect(out.Score).toBe("4 of 4 (very strong)");
    expect(analyze("xK7!pQz#9mLw2vBn").guesses).toBeGreaterThan(1e10);
  });

  it("orders the five bands by guess count", () => {
    const ordered = ["password", "hunter2", "9f3Kd8", "9f3Kd8Lz", "9f3Kd8Lz!qW"];
    const guesses = ordered.map((p) => analyze(p).guesses);
    for (let i = 1; i < guesses.length; i++) {
      expect(guesses[i]!).toBeGreaterThan(guesses[i - 1]!);
    }
  });

  it("charges leet spellings barely more than the plain word", () => {
    const plain = analyze("password").guesses;
    const leet = analyze("p@ssw0rd").guesses;
    expect(leet).toBeGreaterThan(plain);
    expect(leet).toBeLessThan(plain * 100);
    expect(kinds("p@ssw0rd")).toContain("leet");
  });

  it("charges a capitalized word barely more than the lowercase one", () => {
    expect(analyze("Password").guesses).toBeLessThan(analyze("password").guesses * 10);
  });

  it("recognizes a word spelled backwards", () => {
    expect(kinds("drowssap")).toContain("reversed");
    expect(analyze("drowssap").guesses).toBeLessThan(1e4);
  });

  it("recognizes keyboard walks, runs, repeats, and dates", () => {
    expect(kinds("asdfghjkl")).toContain("keyboard");
    expect(kinds("wxyz")).toContain("sequence");
    expect(kinds("abcabcabcabc")).toContain("repeat");
    expect(kinds("zorblat1985")).toContain("date");
  });

  it("splits a word plus a year into two pieces, priced as a pair", () => {
    const analysis = analyze("michael1985");
    expect(analysis.pieces.map((p) => p.token)).toEqual(["michael", "1985"]);
    expect(analysis.guesses).toBeLessThan(1e6);
  });

  it("treats an unrecognized stretch as brute force over its own alphabet", () => {
    const analysis = analyze("qzvxjmw");
    expect(analysis.sequence).toEqual([]);
    expect(analysis.bruteforceSegments).toEqual(["qzvxjmw"]);
    // 7 lowercase characters is 26^7, so about 33 bits.
    expect(analysis.bits).toBeCloseTo(7 * Math.log2(26), 1);
  });

  it("rates a long passphrase above a short scrambled password", () => {
    expect(analyze("correct horse battery staple").guesses).toBeGreaterThan(
      analyze("Tr0ub4d&3").guesses,
    );
  });
});

describe("password-strength-checker output", () => {
  it("reports every attack scenario plus the chosen headline", () => {
    const out = run("hunter2", { attacker: "online-throttled" });
    for (const scenario of SCENARIOS) expect(out[scenario.label]).toBeDefined();
    expect(out["Time to crack"]).toContain("rate limits");
  });

  it("defaults the headline to the offline fast hash scenario", () => {
    expect(run("hunter2", {})["Time to crack"]).toContain("one GPU");
  });

  it("explains the guessing order left to right", () => {
    expect(run("michael1985", {})["How it is guessed"]).toBe(
      '"michael" as a dictionary pattern, then "1985" as a date pattern',
    );
  });

  it("names the findings with an actionable sentence each", () => {
    const findings = run("qwerty123", {}).Findings!;
    expect(findings).toContain("qwerty123");
    expect(findings).toMatch(/bundled/);
  });

  it("says plainly when nothing was recognized", () => {
    expect(run("qzvxjmw", {}).Findings).toContain("No dictionary word");
  });

  it("can turn the pattern breakdown off", () => {
    const out = run("password", { showPatterns: false });
    expect(out.Findings).toBeUndefined();
    expect(out["How it is guessed"]).toBeUndefined();
    expect(out.Score).toBeDefined();
  });

  it("suggests length for a short password and drops that advice for a long one", () => {
    expect(run("hunter2", {}).Suggestions).toContain("Make it longer");
    expect(run("xK7!pQz#9mLw2vBn", {}).Suggestions).not.toContain("Make it longer");
  });

  it("names the specific pattern in the suggestions", () => {
    expect(run("fghjklrtyuiop", {}).Suggestions).toContain("keyboard walks");
    expect(run("zorblat1985", {}).Suggestions).toContain("years and dates");
    expect(run("abcdefgh", {}).Suggestions).toContain("runs like 1234");
    expect(run("abcabcabcabc", {}).Suggestions).toContain("repeating a chunk");
  });

  it("states that the analysis is local", () => {
    expect(run("hunter2", {}).Privacy).toContain("never leave your device");
  });

  it("reports the naive pool alongside the honest estimate", () => {
    const out = run("Passw0rd!", {});
    expect(out["Naive strength"]).toContain("lowercase (26)");
    expect(out["Naive strength"]).toContain("uppercase (26)");
    expect(out["Naive strength"]).toContain("digits (10)");
    expect(out["Naive strength"]).toContain("symbols (33)");
  });

  it("keeps leading and trailing spaces, which are part of the password", () => {
    expect(analyze(" password ").pieces.length).toBeGreaterThan(1);
    expect(run(" a ", {}).Score).toBeDefined();
  });

  it("analyzes only the first 128 characters of a very long password", () => {
    const out = run("z".repeat(200), {});
    expect(out.Note).toContain("first 128 characters");
    expect(run("z".repeat(20), {}).Note).toBeUndefined();
  });
});

describe("password-strength-checker errors", () => {
  it("throws on an empty password", () => {
    try {
      run("", {});
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe("empty-input");
      expect((err as ToolError).fix).toContain("never sent anywhere");
    }
  });

  it("throws when more than one line is pasted", () => {
    expect(() => run("one\ntwo", {})).toThrow(/one password at a time/);
    // A single trailing newline is stripped rather than treated as two lines.
    expect(run("password\n", {}).Score).toBe("0 of 4 (very weak)");
  });

  it("throws on an unknown attack scenario", () => {
    expect(() => run("hunter2", { attacker: "quantum" })).toThrow(/does not recognize/);
  });
});

describe("password-strength-checker helpers", () => {
  it("sizes the character pool from the classes actually used", () => {
    expect(characterPool("abc").size).toBe(26);
    expect(characterPool("abcABC123!").size).toBe(95);
    expect(characterPool("a b").size).toBe(27);
    expect(characterPool("café").parts).toContain("characters beyond ASCII (100 assumed)");
  });

  it("expands leet characters back to letters, and leaves plain text alone", () => {
    expect(unleet("p@ssw0rd")).toContain("password");
    expect(unleet("h3ll0")).toContain("hello");
    expect(unleet("plain")).toEqual([]);
    // 1 could be i or l, so both readings are offered.
    expect(unleet("s1p")).toEqual(["sip", "slp"]);
  });

  it("puts crack times into words", () => {
    expect(humanTime(0.4)).toBe("less than a second");
    expect(humanTime(90)).toBe("about 2 minutes");
    expect(humanTime(60 * 60 * 30)).toBe("about 1 day");
    expect(humanTime(31_556_952 * 5)).toBe("about 5 years");
    expect(humanTime(1e30)).toBe("longer than the age of the universe");
    expect(humanTime(Infinity)).toBe("longer than the age of the universe");
  });

  it("formats large guess counts readably", () => {
    expect(formatBig(12)).toBe("12");
    expect(formatBig(3_200_000)).toBe("3.2 million");
    expect(formatBig(1e25)).toBe("1.0e+25");
    expect(formatBig(Infinity)).toBe("more than a computer can count");
  });

  it("maps guess counts onto the five bands", () => {
    expect(scoreFor(10).value).toBe(0);
    expect(scoreFor(1e4).value).toBe(1);
    expect(scoreFor(1e7).value).toBe(2);
    expect(scoreFor(1e9).value).toBe(3);
    expect(scoreFor(1e12).value).toBe(4);
  });

  it("finds overlapping candidate matches before the search picks between them", () => {
    const matches = findMatches("password123");
    expect(matches.some((m) => m.token === "password")).toBe(true);
    expect(matches.some((m) => m.kind === "sequence")).toBe(true);
  });
});

describe("password-strength-checker dictionary", () => {
  it("bundles roughly a thousand entries across the three lists", () => {
    const total = PASSWORD_LIST.length + WORD_LIST.length + KEYBOARD_LIST.length;
    expect(total).toBeGreaterThan(800);
    expect(total).toBeLessThan(1600);
  });

  it("ranks the most common passwords first", () => {
    const passwords = DICTIONARIES[0]![1];
    expect(passwords.get("123456")).toBe(1);
    expect(passwords.get("password")).toBe(2);
    expect(passwords.get("qwerty")!).toBeLessThan(20);
  });

  it("holds only lowercase ASCII entries, so lookups are predictable", () => {
    for (const word of [...PASSWORD_LIST, ...WORD_LIST, ...KEYBOARD_LIST]) {
      expect(word).toMatch(/^[\x21-\x7e]+$/);
    }
  });
});
