import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  highlightHtml,
  searchAll,
  searchCategories,
  searchTools,
  tokenize,
  withinEditDistanceOne,
  type SearchCategory,
  type SearchTool,
} from "./search";
import { expandToken, SEARCH_SYNONYMS } from "./search-synonyms";
import { recentBoost, rememberRecent, RECENT_TOOLS_KEY } from "./recent-tools";

const tool = (over: Partial<SearchTool>): SearchTool => ({
  slug: "x",
  name: "X",
  description: "",
  category: "Misc",
  keywords: [],
  ...over,
});

describe("tokenize", () => {
  it("splits, lowercases, dedupes, drops empties", () => {
    expect(tokenize("  Foo   BAR foo ")).toEqual(["foo", "bar"]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("escapeHtml", () => {
  it("escapes the five markup-significant characters", () => {
    expect(escapeHtml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &#39; f");
  });
});

describe("highlightHtml", () => {
  it("wraps a case-insensitive match and escapes the rest", () => {
    expect(highlightHtml("JSON Formatter", "json")).toBe("<mark>JSON</mark> Formatter");
  });

  it("escapes markup in both matched and unmatched segments (no offset drift)", () => {
    // The ampersand sits before the match; escaping must not shift offsets.
    expect(highlightHtml("a & bcd", "bcd")).toBe("a &amp; <mark>bcd</mark>");
    expect(highlightHtml("<b>", "b")).toBe("&lt;<mark>b</mark>&gt;");
  });

  it("treats regex metacharacters in the query as literal text", () => {
    expect(highlightHtml("use c++ here", "c++")).toBe("use <mark>c++</mark> here");
    expect(highlightHtml("(x) group", "(x)")).toBe("<mark>(x)</mark> group");
  });

  it("merges overlapping and touching ranges into a single mark", () => {
    expect(highlightHtml("aaa", "aa a")).toBe("<mark>aaa</mark>");
  });

  it("highlights every token of a multi-token query", () => {
    expect(highlightHtml("red green blue", "blue red")).toBe(
      "<mark>red</mark> green <mark>blue</mark>",
    );
  });

  it("returns escaped text unchanged when the query is empty or has no match", () => {
    expect(highlightHtml("a & b", "")).toBe("a &amp; b");
    expect(highlightHtml("a & b", "zzz")).toBe("a &amp; b");
  });
});

describe("searchTools", () => {
  const tools: SearchTool[] = [
    tool({ slug: "json-formatter", name: "JSON Formatter", category: "Data" }),
    tool({
      slug: "color-picker",
      name: "Color Picker",
      description: "Pick colors from a wheel",
      searchTerms: ["colour"],
    }),
    tool({
      slug: "regex-tester",
      name: "Pattern Tester",
      keywords: ["regex", "regular expression"],
    }),
    tool({
      slug: "notes",
      name: "Notes",
      description: "a note about json somewhere in the body",
    }),
  ];

  it("returns every tool in input order for an empty query", () => {
    const r = searchTools(tools, "   ");
    expect(r.map((x) => x.tool.slug)).toEqual(tools.map((t) => t.slug));
    expect(r.every((x) => x.score === 0)).toBe(true);
  });

  it("ranks a name hit above an incidental description hit", () => {
    const r = searchTools(tools, "json");
    expect(r.map((x) => x.tool.slug)).toEqual(["json-formatter", "notes"]);
  });

  it("finds a tool via a hidden searchTerms synonym", () => {
    const r = searchTools(tools, "color");
    expect(r[0]?.tool.slug).toBe("color-picker");
  });

  it("finds a tool via a keyword the name never contains", () => {
    const r = searchTools(tools, "regex");
    expect(r[0]?.tool.slug).toBe("regex-tester");
  });

  it("ranks an exact name above a synonym-only match", () => {
    const t = [
      tool({ slug: "a", name: "color", category: "Misc" }),
      tool({ slug: "b", name: "Picker", searchTerms: ["colour"] }),
    ];
    const r = searchTools(t, "color");
    expect(r.map((x) => x.tool.slug)).toEqual(["a", "b"]);
  });

  it("applies AND across tokens", () => {
    const r = searchTools(tools, "json wheel");
    expect(r).toHaveLength(0);
    const r2 = searchTools(tools, "color wheel");
    expect(r2.map((x) => x.tool.slug)).toEqual(["color-picker"]);
  });

  it("is graceful when searchTerms is absent", () => {
    expect(() => searchTools([tool({ name: "Plain" })], "plain")).not.toThrow();
  });
});

/**
 * A miniature registry: real slugs, real names, real categories, trimmed
 * metadata. Fixtures rather than the live registry on purpose, so a meta
 * reword by another agent cannot silently rewrite what these tests assert.
 */
const REGISTRY: SearchTool[] = [
  tool({
    slug: "electromagnetic-spectrum",
    name: "Electromagnetic Spectrum",
    category: "Science",
    description: "An interactive map of the spectrum from gamma rays to ELF radio.",
    keywords: ["electromagnetic spectrum", "wavelength frequency converter"],
    searchTerms: ["em spectrum", "light spectrum", "photon energy"],
  }),
  tool({
    slug: "background-remover",
    name: "Background Remover",
    category: "Local AI",
    description: "Cut people out of photos locally, with no credits and no uploads.",
    keywords: ["remove background from photo free"],
    searchTerms: ["remove bg", "photo cutout tool"],
  }),
  tool({
    slug: "temporal-playground",
    name: "Temporal Playground",
    category: "Time",
    description: "Explore date math, time zones, and DST edge cases.",
    keywords: ["temporal api playground"],
    searchTerms: ["temporal js"],
  }),
  tool({
    slug: "tone-generator",
    name: "Signal Generator",
    category: "Audio",
    description: "Play test tones and sweeps.",
    keywords: ["tone generator"],
    searchTerms: ["test tone"],
  }),
  tool({
    slug: "tuner-metronome",
    name: "Tuner & Metronome",
    category: "Audio",
    description: "Tune an instrument and keep time.",
    keywords: ["guitar tuner"],
    searchTerms: ["click track"],
  }),
  tool({
    slug: "audio-spectrogram",
    name: "Spectrogram Viewer",
    category: "Media",
    description: "See frequency over time.",
    keywords: ["spectrogram"],
    searchTerms: ["sound visualizer", "sound wave viewer"],
  }),
  tool({
    slug: "audio-trimmer",
    name: "Audio Trimmer",
    category: "Media",
    description: "Trim and fade clips.",
    keywords: ["trim audio"],
  }),
  tool({
    slug: "video-converter",
    name: "Video Converter",
    category: "Media",
    description: "Convert clips between formats, or pull the sound out as audio.",
    keywords: ["convert mp4 to webm"],
  }),
  tool({
    slug: "json-formatter",
    name: "JSON Formatter",
    category: "Data",
    description: "Pretty print and validate JSON.",
    keywords: ["json beautifier"],
  }),
];

const CATEGORY_FIXTURES: SearchCategory[] = [
  {
    slug: "audio",
    label: "Audio",
    icon: "AudioLines",
    description: "Tuners, generators and analyzers that run in the browser.",
  },
  {
    slug: "media",
    label: "Media",
    icon: "Film",
    description: "Convert, trim and inspect video and audio files.",
  },
  {
    slug: "local-ai",
    label: "Local AI",
    icon: "Sparkles",
    description: "Models that run on your own machine.",
  },
  { slug: "science", label: "Science", icon: "Atom", description: "Physics and unit reference." },
  {
    slug: "data",
    label: "Data",
    icon: "Braces",
    description: "Format and convert structured data.",
  },
  { slug: "time", label: "Time", icon: "Clock", description: "Time zones and date math." },
];

// Three tools sharing one alias, in a category whose own text matches nothing,
// so the only way its row can appear is the cluster of matching tools.
const CLUSTER_TOOLS: SearchTool[] = [
  tool({ slug: "a", name: "Alpha", category: "Widgets", keywords: ["sprocket"] }),
  tool({ slug: "b", name: "Beta", category: "Widgets", keywords: ["sprocket"] }),
  tool({ slug: "c", name: "Gamma", category: "Widgets", keywords: ["sprocket"] }),
];
const CLUSTER_CATEGORIES: SearchCategory[] = [
  { slug: "widgets", label: "Widgets", description: "Things that spin." },
];

const slugs = (results: Array<{ tool: SearchTool }>): string[] => results.map((r) => r.tool.slug);

describe("word-prefix ranking", () => {
  it("puts a token that starts a word above the same token buried mid word", () => {
    const t = [
      tool({ slug: "mid", name: "Platform Inspector" }),
      tool({ slug: "start", name: "Format Converter" }),
    ];
    expect(slugs(searchTools(t, "form"))).toEqual(["start", "mid"]);
  });

  it("puts a prefix of the first word above a prefix of a later word", () => {
    const t = [
      tool({ slug: "later", name: "Video Converter" }),
      tool({ slug: "first", name: "Converter Tool" }),
    ];
    expect(slugs(searchTools(t, "conv"))).toEqual(["first", "later"]);
  });

  it('ranks "em" to Electromagnetic Spectrum, above the mid-word hits', () => {
    // "em" is not a substring of "Electromagnetic Spectrum" at all. It arrives
    // through the alias "em spectrum" AND through the synonym em ->
    // electromagnetic, and has to beat the "em" inside Remover and Temporal.
    const r = searchTools(REGISTRY, "em");
    expect(slugs(r)).toEqual([
      "electromagnetic-spectrum",
      "background-remover",
      "temporal-playground",
    ]);
  });

  it('keeps "em" first through the synonym map alone when the alias is gone', () => {
    // Guards the requirement against a searchTerms audit dropping "em spectrum".
    const stripped = REGISTRY.map((t) =>
      t.slug === "electromagnetic-spectrum"
        ? { ...t, searchTerms: t.searchTerms?.filter((s) => s !== "em spectrum") }
        : t,
    );
    expect(searchTools(stripped, "em")[0]?.tool.slug).toBe("electromagnetic-spectrum");
  });
});

describe("acronym matching", () => {
  it("matches the initials of the name", () => {
    expect(searchTools(REGISTRY, "es")[0]?.tool.slug).toBe("electromagnetic-spectrum");
    expect(slugs(searchTools(REGISTRY, "jf"))).toEqual(["json-formatter"]);
  });

  it("matches a prefix of the initials, at two characters or more", () => {
    const t = [tool({ slug: "long", name: "Quick Response Code Generator" })];
    expect(slugs(searchTools(t, "qrc"))).toEqual(["long"]);
    expect(slugs(searchTools(t, "qr"))).toEqual(["long"]);
  });

  it("ranks an initials hit above a word hit inside a curated alias", () => {
    // Pins NAME_ACRONYM above both alias word tiers. Without this the constant
    // can slide back under them, every other test still passes, and initials
    // quietly stop surfacing on a registry the size of the real one.
    const t = [
      tool({ slug: "alias-word", name: "Random Tool", keywords: ["ems reader"] }),
      tool({ slug: "alias-prefix", name: "Other Tool", keywords: ["emsp viewer"] }),
      tool({ slug: "initials", name: "Electro Magnetic Spectrum" }),
    ];
    expect(slugs(searchTools(t, "ems"))).toEqual(["initials", "alias-word", "alias-prefix"]);
  });

  it("ranks an initials hit below a name word prefix and above a description hit", () => {
    const t = [
      tool({ slug: "acronym", name: "Json Formatter" }),
      tool({ slug: "prefix", name: "Jfif Reader" }),
      tool({ slug: "description", name: "Notes", description: "mentions jf in passing" }),
    ];
    expect(slugs(searchTools(t, "jf"))).toEqual(["prefix", "acronym", "description"]);
  });
});

describe("synonym expansion", () => {
  it('surfaces the Audio tools for "sound"', () => {
    expect(slugs(searchTools(REGISTRY, "sound"))).toEqual([
      "audio-spectrogram",
      "audio-trimmer",
      "tone-generator",
      "tuner-metronome",
      "video-converter",
    ]);
  });

  it("scores an expansion hit below the same hit on the typed word", () => {
    const t = [
      tool({ slug: "typed", name: "Sound Board" }),
      tool({ slug: "expanded", name: "Audio Board" }),
    ];
    expect(slugs(searchTools(t, "sound"))).toEqual(["typed", "expanded"]);
  });

  it("expands informal words to the words the metas actually use", () => {
    const t = [
      tool({ slug: "image-resizer", name: "Image Resizer" }),
      tool({ slug: "zip-viewer", name: "Archive Viewer" }),
      tool({ slug: "password-generator", name: "Password Generator" }),
    ];
    expect(searchTools(t, "picture")[0]?.tool.slug).toBe("image-resizer");
    expect(searchTools(t, "zip")[0]?.tool.slug).toBe("zip-viewer");
    expect(searchTools(t, "pw")[0]?.tool.slug).toBe("password-generator");
  });

  it("keeps AND semantics when only one token expands", () => {
    const t = [
      tool({ slug: "a", name: "Audio Trimmer", description: "Trim clips." }),
      tool({ slug: "b", name: "Audio Recorder", description: "Capture a take." }),
    ];
    // "sound" expands onto both names; "record" only lands on one of them.
    expect(slugs(searchTools(t, "sound record"))).toEqual(["b"]);
  });
});

describe("multi-token queries", () => {
  it('still ranks "json to ts" correctly', () => {
    const t = [
      tool({ slug: "notes", name: "Notes", description: "Convert json objects to ts types." }),
      tool({ slug: "json-to-ts", name: "JSON to TypeScript", keywords: ["json to ts"] }),
    ];
    expect(slugs(searchTools(t, "json to ts"))).toEqual(["json-to-ts", "notes"]);
  });
});

describe("typo tolerance", () => {
  it("corrects a single edit in a long token", () => {
    expect(slugs(searchTools(REGISTRY, "spectogram"))).toEqual(["audio-spectrogram"]);
    expect(slugs(searchTools(REGISTRY, "metronme"))).toEqual(["tuner-metronome"]);
  });

  it("ranks a typo correction below every exact tier", () => {
    const r = searchTools(
      [
        ...REGISTRY,
        tool({ slug: "exact", name: "Notes", description: "mentions spectogram exactly once" }),
      ],
      "spectogram",
    );
    expect(slugs(r)).toEqual(["exact", "audio-spectrogram"]);
  });

  it("stays off for tokens under four characters", () => {
    const t = [tool({ slug: "near", name: "Tone Board" })];
    expect(slugs(searchTools(t, "tne"))).toEqual([]);
    // Four characters is where the correction switches on.
    expect(slugs(searchTools(t, "tune"))).toEqual(["near"]);
  });

  it("stays off once a token already has enough direct hits", () => {
    const t = [
      tool({ slug: "a", name: "Color Alpha" }),
      tool({ slug: "b", name: "Color Beta" }),
      tool({ slug: "c", name: "Color Gamma" }),
      tool({ slug: "d", name: "Colon Delta" }),
    ];
    expect(slugs(searchTools(t, "color"))).toEqual(["a", "b", "c"]);
    // Two direct hits is thin enough for the correction to run.
    expect(slugs(searchTools(t.slice(1), "color"))).toEqual(["b", "c", "d"]);
  });
});

describe("withinEditDistanceOne", () => {
  it("accepts the four single-edit shapes", () => {
    expect(withinEditDistanceOne("spectogram", "spectrogram")).toBe(true); // insertion
    expect(withinEditDistanceOne("metronme", "metronome")).toBe(true); // insertion
    expect(withinEditDistanceOne("color", "colur")).toBe(true); // deletion
    expect(withinEditDistanceOne("color", "colon")).toBe(true); // substitution
    expect(withinEditDistanceOne("audio", "aduio")).toBe(true); // transposition
  });

  it("accepts a pure prefix or suffix that differs by one character", () => {
    expect(withinEditDistanceOne("spectrogram", "spectrogra")).toBe(true);
    expect(withinEditDistanceOne("json", "sjson")).toBe(true);
    expect(withinEditDistanceOne("", "a")).toBe(true);
  });

  it("rejects two or more edits", () => {
    expect(withinEditDistanceOne("color", "colored")).toBe(false); // distance 2
    expect(withinEditDistanceOne("json", "yaml")).toBe(false);
    expect(withinEditDistanceOne("audio", "aud")).toBe(false);
    expect(withinEditDistanceOne("acbd", "abdc")).toBe(false); // two swaps
  });

  it("accepts identical strings", () => {
    expect(withinEditDistanceOne("audio", "audio")).toBe(true);
    expect(withinEditDistanceOne("", "")).toBe(true);
  });
});

describe("searchCategories", () => {
  it("matches a category by label", () => {
    expect(searchCategories(CATEGORY_FIXTURES, "audio")[0]?.category.slug).toBe("audio");
  });

  it("matches a category by slug, including a hyphenated one", () => {
    expect(searchCategories(CATEGORY_FIXTURES, "local ai")[0]?.category.slug).toBe("local-ai");
  });

  it("matches a category through the synonym map", () => {
    expect(searchCategories(CATEGORY_FIXTURES, "sound")[0]?.category.slug).toBe("audio");
  });

  it("returns the documented shape", () => {
    const [first] = searchCategories(CATEGORY_FIXTURES, "audio");
    expect(first?.kind).toBe("category");
    expect(first?.category.label).toBe("Audio");
    expect(typeof first?.score).toBe("number");
  });

  it("returns nothing for an empty query", () => {
    expect(searchCategories(CATEGORY_FIXTURES, "  ")).toEqual([]);
  });

  it("matches a category when its tools cluster there, given the tools", () => {
    expect(searchCategories(CLUSTER_CATEGORIES, "sprocket")).toEqual([]);
    const withTools = searchCategories(CLUSTER_CATEGORIES, "sprocket", { tools: CLUSTER_TOOLS });
    expect(withTools[0]?.category.slug).toBe("widgets");
  });
});

describe("searchAll", () => {
  it("tags every row with its kind", () => {
    const rows = searchAll(REGISTRY, CATEGORY_FIXTURES, "audio");
    expect(rows.every((r) => r.kind === "tool" || r.kind === "category")).toBe(true);
    expect(rows.some((r) => r.kind === "category")).toBe(true);
  });

  it("puts a category label hit below a tool name hit and above a description hit", () => {
    const rows = searchAll(REGISTRY, CATEGORY_FIXTURES, "audio");
    const at = (find: (row: (typeof rows)[number]) => boolean): number => rows.findIndex(find);
    const name = at((r) => r.kind === "tool" && r.tool.slug === "audio-trimmer");
    const category = at((r) => r.kind === "category" && r.category.slug === "audio");
    const description = at((r) => r.kind === "tool" && r.tool.slug === "video-converter");
    expect(name).toBeGreaterThanOrEqual(0);
    expect(name).toBeLessThan(category);
    expect(category).toBeLessThan(description);
  });

  it("is sorted by score, best first", () => {
    const rows = searchAll(REGISTRY, CATEGORY_FIXTURES, "audio");
    const scores = rows.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("shows a category on cluster evidence alone, last, and only past the threshold", () => {
    const rows = searchAll(CLUSTER_TOOLS, CLUSTER_CATEGORIES, "sprocket");
    expect(rows[rows.length - 1]).toMatchObject({
      kind: "category",
      category: { slug: "widgets" },
    });
    const thin = searchAll(CLUSTER_TOOLS.slice(0, 2), CLUSTER_CATEGORIES, "sprocket");
    expect(thin.some((r) => r.kind === "category")).toBe(false);
  });

  it("returns tools only for an empty query", () => {
    const rows = searchAll(REGISTRY, CATEGORY_FIXTURES, "");
    expect(rows.every((r) => r.kind === "tool")).toBe(true);
    expect(rows).toHaveLength(REGISTRY.length);
  });
});

describe("recently used", () => {
  it("returns recent tools first, in recency order, for an empty query", () => {
    const recent = ["json-formatter", "temporal-playground"];
    const r = searchTools(REGISTRY, "", { recent });
    expect(slugs(r).slice(0, 2)).toEqual(recent);
    expect(slugs(r).slice(2)).toEqual(
      REGISTRY.filter((t) => !recent.includes(t.slug)).map((t) => t.slug),
    );
  });

  it("ignores recent slugs that are not in the list passed in", () => {
    const r = searchTools(REGISTRY, "", { recent: ["not-a-tool"] });
    expect(slugs(r)).toEqual(REGISTRY.map((t) => t.slug));
  });

  it("breaks a tie toward the recently used tool", () => {
    const t = [tool({ slug: "zeta", name: "Zip Extractor" }), tool({ slug: "a", name: "Zip Box" })];
    expect(slugs(searchTools(t, "zip"))).toEqual(["a", "zeta"]);
    expect(slugs(searchTools(t, "zip", { recent: ["zeta"] }))).toEqual(["zeta", "a"]);
  });

  it("never lifts a weaker match past a name-exact hit", () => {
    const t = [tool({ slug: "exact", name: "Zip" }), tool({ slug: "weak", name: "Zip Builder" })];
    expect(slugs(searchTools(t, "zip", { recent: ["weak"] }))).toEqual(["exact", "weak"]);
  });
});

describe("rememberRecent", () => {
  it("moves the slug to the front without mutating the input", () => {
    const list = ["a", "b", "c"];
    expect(rememberRecent(list, "c")).toEqual(["c", "a", "b"]);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("dedupes, drops blanks and caps the length", () => {
    expect(rememberRecent(["a", "a", "", "  ", "b"], "a")).toEqual(["a", "b"]);
    expect(rememberRecent(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
    expect(rememberRecent(["a"], "b", 0)).toEqual([]);
  });

  it("defaults to ten entries", () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(rememberRecent(many, "new")).toHaveLength(10);
  });

  it("names the storage key it expects callers to use", () => {
    expect(RECENT_TOOLS_KEY).toBe("recent-tools");
  });
});

describe("recentBoost", () => {
  it("decays with position and floors at one", () => {
    const recent = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(recentBoost("t0", recent)).toBe(24);
    expect(recentBoost("t1", recent)).toBeLessThan(recentBoost("t0", recent));
    expect(recentBoost("t19", recent)).toBe(1);
  });

  it("is zero for a tool that was never opened", () => {
    expect(recentBoost("missing", ["a", "b"])).toBe(0);
    expect(recentBoost("a", [])).toBe(0);
    expect(recentBoost("a")).toBe(0);
  });
});

describe("search synonyms", () => {
  it("carries a substantial curated map", () => {
    expect(Object.keys(SEARCH_SYNONYMS).length).toBeGreaterThanOrEqual(60);
  });

  it("uses single lowercase tokens as keys and never expands to itself", () => {
    for (const [key, values] of Object.entries(SEARCH_SYNONYMS)) {
      expect(key).toBe(key.toLowerCase().trim());
      expect(key).not.toMatch(/\s/);
      expect(values.length).toBeGreaterThan(0);
      expect(values).not.toContain(key);
    }
  });

  it("covers the words people actually type", () => {
    expect(expandToken("sound")).toContain("audio");
    expect(expandToken("photo")).toContain("image");
    expect(expandToken("movie")).toContain("video");
    expect(expandToken("color")).toContain("colour"); // spelling: allow
    expect(expandToken("gray")).toContain("grey"); // spelling: allow
    expect(expandToken("b64")).toContain("base64");
    expect(expandToken("subnet")).toContain("network");
  });

  it("returns nothing for an unknown token, prototype keys included", () => {
    expect(expandToken("wheel")).toEqual([]);
    expect(expandToken("constructor")).toEqual([]);
    expect(expandToken("__proto__")).toEqual([]);
    expect(expandToken("toString")).toEqual([]);
  });
});

describe("highlighting an expanded match", () => {
  it("marks nothing when the row matched through a synonym or a typo", () => {
    // Interface note for the palette: rows matched by synonym, initials, or
    // typo correction come back with no <mark> at all, by design. Highlighting
    // only ever marks what the visitor literally typed.
    expect(highlightHtml("Audio Trimmer", "sound")).toBe("Audio Trimmer");
    expect(highlightHtml("Spectrogram Viewer", "spectogram")).toBe("Spectrogram Viewer");
  });
});

describe("ranking cost", () => {
  const FILLER = [
    "converter",
    "formatter",
    "inspector",
    "generator",
    "viewer",
    "calculator",
    "encoder",
    "planner",
  ];
  const CATEGORY_LABELS = ["Text", "Data", "Dev", "Audio", "Media", "Images", "Time", "Network"];
  const many: SearchTool[] = Array.from({ length: 200 }, (_, i) =>
    tool({
      slug: `tool-${i}`,
      name: `${FILLER[i % FILLER.length]} ${FILLER[(i * 3) % FILLER.length]} ${i}`,
      category: CATEGORY_LABELS[i % CATEGORY_LABELS.length],
      description: `Turns ${FILLER[(i * 5) % FILLER.length]} input into ${FILLER[(i * 7) % FILLER.length]} output, entirely in the browser, with no upload of any kind.`,
      keywords: [`${FILLER[i % FILLER.length]} online`, `free ${FILLER[(i * 2) % FILLER.length]}`],
      searchTerms: [`${FILLER[(i * 4) % FILLER.length]} tool`, "browser based"],
    }),
  );
  const queries = ["json", "sound", "em", "convert file", "spectogram", "audio trimmer"];

  it("stays fast over 200 tools", () => {
    for (const q of queries) searchTools(many, q); // warm up and fill the index cache
    const started = performance.now();
    const rounds = 50;
    for (let i = 0; i < rounds; i++) {
      for (const q of queries) searchTools(many, q);
    }
    const perQuery = (performance.now() - started) / (rounds * queries.length);
    // Measured on the development machine: about 0.2 ms per query on these
    // thin fixtures, and about 0.9 ms for searchAll over the real 175 tool
    // registry, whose metas carry far more keywords. The ceiling stays the
    // 5 ms budget rather than either number, so a slow CI box cannot flake it
    // while a regression that costs several times as much still trips it.
    expect(perQuery).toBeLessThan(5);
  });
});
