import { ToolError, type ToolLogic } from "../types";

export interface LoremOpts {
  units: string; // "paragraphs" | "sentences" | "words"
  count: number;
  variant: string; // "classic" | "english"
  startWithLorem: boolean;
  format: string; // "plain" | "html" | "markdown"
  [key: string]: unknown;
}

export type LoremResult = string;

const CLASSIC_WORDS = (
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud " +
  "exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute " +
  "irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur " +
  "excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt " +
  "mollit anim id est laborum at vero eos accusamus iusto odio dignissimos ducimus " +
  "blanditiis praesentium voluptatum deleniti atque corrupti quos quas molestias"
).split(" ");

const ENGLISH_WORDS = (
  "business synergy solution innovative platform streamline workflow customer " +
  "experience data driven insights scalable robust framework empower collaborate " +
  "strategy growth value proposition seamless integration dynamic market leading " +
  "vision mission core competency actionable engagement transform digital journey " +
  "roadmap milestone deliverable stakeholder alignment optimize performance " +
  "efficient process resource team culture leadership initiative pipeline forward " +
  "thinking approach flexible reliable modern practical results focused"
).split(" ");

const CLASSIC_STARTER = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
const ENGLISH_STARTER = "This is placeholder text for your design.";

/** Deterministic PRNG (mulberry32) seeded from a 32-bit integer. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a string hash, used to seed the PRNG from a text seed. */
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function cryptoSeed(): number {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0]!;
}

function randomInt(rand: () => number, min: number, max: number): number {
  return min + Math.floor(rand() * (max - min + 1));
}

function pickWord(rand: () => number, bank: string[]): string {
  return bank[Math.floor(rand() * bank.length)]!;
}

function buildSentence(rand: () => number, bank: string[]): string {
  const n = randomInt(rand, 6, 16);
  const words: string[] = [];
  for (let i = 0; i < n; i++) words.push(pickWord(rand, bank));
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".";
}

function buildParagraph(rand: () => number, bank: string[]): string {
  const n = randomInt(rand, 3, 7);
  const sentences: string[] = [];
  for (let i = 0; i < n; i++) sentences.push(buildSentence(rand, bank));
  return sentences.join(" ");
}

function formatOutput(paragraphs: string[], format: string): string {
  if (format === "html") return paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  // "markdown" and "plain" both use blank-line separated paragraphs: that IS
  // Markdown's paragraph syntax, so there is nothing extra to add.
  return paragraphs.join("\n\n");
}

const MAX_COUNT = 2000;

export function run(input: string, opts: LoremOpts): LoremResult {
  const seedStr = (input ?? "").trim();
  const rand = seedStr ? mulberry32(hashString(seedStr)) : mulberry32(cryptoSeed());

  const bank = opts.variant === "english" ? ENGLISH_WORDS : CLASSIC_WORDS;
  const starter = opts.variant === "english" ? ENGLISH_STARTER : CLASSIC_STARTER;
  const units = ["paragraphs", "sentences", "words"].includes(opts.units)
    ? opts.units
    : "paragraphs";

  const count = Math.floor(opts.count);
  if (!Number.isFinite(count) || count < 1) {
    throw new ToolError(
      "invalid-count",
      "Count must be a whole number of 1 or more.",
      "Enter a count like 5.",
    );
  }
  if (count > MAX_COUNT) {
    throw new ToolError(
      "count-too-large",
      `Count must be ${MAX_COUNT} or fewer.`,
      `Enter a smaller count, up to ${MAX_COUNT}.`,
    );
  }

  let paragraphs: string[];

  if (units === "words") {
    const words: string[] = [];
    if (opts.startWithLorem) {
      const starterWords = starter.replace(/[.,]/g, "").split(" ");
      for (const w of starterWords) {
        if (words.length < count) words.push(w);
      }
    }
    while (words.length < count) words.push(pickWord(rand, bank));
    paragraphs = [words.slice(0, count).join(" ")];
  } else if (units === "sentences") {
    const sentences: string[] = [];
    if (opts.startWithLorem) sentences.push(starter);
    while (sentences.length < count) sentences.push(buildSentence(rand, bank));
    paragraphs = [sentences.slice(0, count).join(" ")];
  } else {
    paragraphs = [];
    for (let p = 0; p < count; p++) {
      if (p === 0 && opts.startWithLorem) {
        const restCount = randomInt(rand, 2, 6);
        const sentences = [starter];
        for (let i = 0; i < restCount; i++) sentences.push(buildSentence(rand, bank));
        paragraphs.push(sentences.join(" "));
      } else {
        paragraphs.push(buildParagraph(rand, bank));
      }
    }
  }

  return formatOutput(paragraphs, opts.format);
}

export default { run } satisfies ToolLogic<string, LoremResult, LoremOpts>;
