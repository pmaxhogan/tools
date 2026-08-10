import { ToolError, type ToolLogic } from "../types";

export interface CaseOpts {
  [key: string]: unknown;
}

export interface CaseResult {
  [label: string]: string;
}

const LABELS = [
  "camelCase",
  "PascalCase",
  "snake_case",
  "SCREAMING_SNAKE_CASE",
  "kebab-case",
  "Title Case",
  "Sentence case",
  "lowercase",
  "UPPERCASE",
  "URL slug",
] as const;

type Label = (typeof LABELS)[number];

const SMALL_WORDS = new Set(["a", "an", "the", "of", "in", "on", "for", "to", "and"]);

/** Split a single alphanumeric chunk at camelCase boundaries, including acronym runs. */
function splitCamel(chunk: string): string[] {
  return chunk
    .replace(/([a-z0-9])([A-Z])/g, "$1\0$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
    .split("\0")
    .filter(Boolean);
}

/**
 * Tokenize a line into words: split on whitespace, underscores, hyphens, and
 * any other run of non-alphanumeric characters, then split camelCase runs
 * (including acronyms, so "parseHTMLDocument" -> parse, HTML, Document).
 */
function tokenize(line: string): string[] {
  return line
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .flatMap(splitCamel)
    .filter(Boolean);
}

function cap(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** Strip combining diacritical marks after Unicode NFD decomposition (e.g. é -> e). */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

function foldDiacritics(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS, "");
}

function slugify(tokens: string[]): string {
  return tokens
    .map((t) =>
      foldDiacritics(t)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, ""),
    )
    .filter(Boolean)
    .join("-");
}

function emptyForms(): Record<Label, string> {
  return {
    camelCase: "",
    PascalCase: "",
    snake_case: "",
    SCREAMING_SNAKE_CASE: "",
    "kebab-case": "",
    "Title Case": "",
    "Sentence case": "",
    lowercase: "",
    UPPERCASE: "",
    "URL slug": "",
  };
}

function convertLine(line: string): Record<Label, string> {
  const tokens = tokenize(line);
  if (tokens.length === 0) return emptyForms();

  const lower = tokens.map((t) => t.toLowerCase());

  const camelCase = lower[0] + tokens.slice(1).map(cap).join("");
  const PascalCase = tokens.map(cap).join("");
  const snake_case = lower.join("_");
  const SCREAMING_SNAKE_CASE = tokens.map((t) => t.toUpperCase()).join("_");
  const kebabCase = lower.join("-");

  const titleWords = tokens.map((t, i) => {
    const isEdge = i === 0 || i === tokens.length - 1;
    const lw = t.toLowerCase();
    if (!isEdge && SMALL_WORDS.has(lw)) return lw;
    return cap(t);
  });
  const TitleCase = titleWords.join(" ");

  const sentenceJoined = lower.join(" ");
  const SentenceCase = sentenceJoined.charAt(0).toUpperCase() + sentenceJoined.slice(1);

  const lowercase = lower.join(" ");
  const UPPERCASE = tokens.map((t) => t.toUpperCase()).join(" ");
  const urlSlug = slugify(tokens);

  return {
    camelCase,
    PascalCase,
    snake_case,
    SCREAMING_SNAKE_CASE,
    "kebab-case": kebabCase,
    "Title Case": TitleCase,
    "Sentence case": SentenceCase,
    lowercase,
    UPPERCASE,
    "URL slug": urlSlug,
  };
}

export function run(input: string, _opts: CaseOpts): CaseResult {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter some text to convert.",
      'Type or paste text like "hello world" or "parseHTMLDocument".',
    );

  const lines = raw.split(/\r?\n/);
  const perLine = lines.map(convertLine);

  const result: CaseResult = {};
  for (const label of LABELS) {
    result[label] = perLine.map((f) => f[label]).join("\n");
  }
  return result;
}

export default { run } satisfies ToolLogic<string, CaseResult, CaseOpts>;
