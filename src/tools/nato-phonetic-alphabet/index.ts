import { ToolError, type ToolLogic } from "../types";

export interface NatoOpts {
  alphabet: string; // "nato" | "us-army" | "german" | "italian" | "swedish"
  digitStyle: string; // "standard" | "aviation"
  [key: string]: unknown;
}

export type NatoResult = Record<string, string>;

const ALPHABETS: Record<string, string[]> = {
  nato: [
    "Alfa",
    "Bravo",
    "Charlie",
    "Delta",
    "Echo",
    "Foxtrot",
    "Golf",
    "Hotel",
    "India",
    "Juliett",
    "Kilo",
    "Lima",
    "Mike",
    "November",
    "Oscar",
    "Papa",
    "Quebec",
    "Romeo",
    "Sierra",
    "Tango",
    "Uniform",
    "Victor",
    "Whiskey",
    "X-ray",
    "Yankee",
    "Zulu",
  ],
  "us-army": [
    "Able",
    "Baker",
    "Charlie",
    "Dog",
    "Easy",
    "Fox",
    "George",
    "How",
    "Item",
    "Jig",
    "King",
    "Love",
    "Mike",
    "Nan",
    "Oboe",
    "Peter",
    "Queen",
    "Roger",
    "Sugar",
    "Tare",
    "Uncle",
    "Victor",
    "William",
    "X-ray",
    "Yoke",
    "Zebra",
  ],
  german: [
    "Anton",
    "Berta",
    "Cäsar",
    "Dora",
    "Emil",
    "Friedrich",
    "Gustav",
    "Heinrich",
    "Ida",
    "Julius",
    "Kaufmann",
    "Ludwig",
    "Martha",
    "Nordpol",
    "Otto",
    "Paula",
    "Quelle",
    "Richard",
    "Samuel",
    "Theodor",
    "Ulrich",
    "Viktor",
    "Wilhelm",
    "Xanthippe",
    "Ypsilon",
    "Zacharias",
  ],
  italian: [
    "Ancona",
    "Bologna",
    "Como",
    "Domodossola",
    "Empoli",
    "Firenze",
    "Genova",
    "Hotel",
    "Imola",
    "Jolly",
    "Kappa",
    "Livorno",
    "Milano",
    "Napoli",
    "Otranto",
    "Padova",
    "Quarto",
    "Roma",
    "Savona",
    "Torino",
    "Udine",
    "Venezia",
    "Washington",
    "Ics",
    "York",
    "Zara",
  ],
  swedish: [
    "Adam",
    "Bertil",
    "Cesar",
    "David",
    "Erik",
    "Filip",
    "Gustav",
    "Helge",
    "Ivar",
    "Johan",
    "Kalle",
    "Ludvig",
    "Martin",
    "Niklas",
    "Olof",
    "Petter",
    "Qvintus",
    "Rudolf",
    "Sigurd",
    "Tore",
    "Urban",
    "Viktor",
    "Wilhelm",
    "Xerxes",
    "Yngve",
    "Zäta",
  ],
};

const STANDARD_DIGITS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];
// ICAO aviation pronunciation spellings, chosen for radio clarity.
const AVIATION_DIGITS = [
  "Zero",
  "Wun",
  "Too",
  "Tree",
  "Fower",
  "Fife",
  "Six",
  "Seven",
  "Ait",
  "Niner",
];

const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");
function fold(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
}

function digitsFor(digitStyle: string): string[] {
  return digitStyle === "aviation" ? AVIATION_DIGITS : STANDARD_DIGITS;
}

function alphabetFor(alphabet: string): string[] {
  return ALPHABETS[alphabet] ?? ALPHABETS.nato!;
}

/** Maps every recognized phonetic word (in either digit style, folded and lowercased) to its character. */
function buildLookup(alphabet: string): Map<string, string> {
  const wordList = alphabetFor(alphabet);
  const lookup = new Map<string, string>();
  wordList.forEach((w, i) => lookup.set(fold(w), String.fromCharCode(65 + i)));
  STANDARD_DIGITS.forEach((w, i) => lookup.set(fold(w), String(i)));
  AVIATION_DIGITS.forEach((w, i) => lookup.set(fold(w), String(i)));
  return lookup;
}

/**
 * Direction auto-detect. Space-separated alphabetic tokens are ambiguous
 * (both plain text words and phonetic code words look the same shape), so
 * this treats input as phonetic when a majority of its tokens are
 * recognized phonetic or digit words, rather than requiring every token to
 * match. That way a typo or an unrecognized word inside an otherwise
 * phonetic-looking message still routes to decode, where it raises a
 * specific error, instead of silently falling back to letter-by-letter
 * encoding of the whole line.
 */
function isPhoneticInput(input: string, lookup: Map<string, string>): boolean {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "/");
  if (tokens.length === 0) return false;
  const matches = tokens.filter((t) => lookup.has(fold(t))).length;
  return matches / tokens.length > 0.5;
}

function encode(
  text: string,
  alphabet: string,
  digitStyle: string,
): { output: string; breakdown: string } {
  const wordList = alphabetFor(alphabet);
  const digits = digitsFor(digitStyle);
  const words = text.trim().split(/\s+/);
  const pairs: string[] = [];
  const encodedWords = words.map((word) =>
    [...word]
      .map((ch) => {
        if (/[a-zA-Z]/.test(ch)) {
          const phonetic = wordList[ch.toUpperCase().charCodeAt(0) - 65]!;
          pairs.push(`${ch.toUpperCase()} -> ${phonetic}`);
          return phonetic;
        }
        if (/[0-9]/.test(ch)) {
          const phonetic = digits[Number(ch)]!;
          pairs.push(`${ch} -> ${phonetic}`);
          return phonetic;
        }
        throw new ToolError(
          "unsupported-character",
          `"${ch}" has no phonetic alphabet entry.`,
          "Use letters A-Z and digits 0-9 only.",
        );
      })
      .join(" "),
  );
  return { output: encodedWords.join(" / "), breakdown: pairs.join("\n") };
}

function decode(
  input: string,
  lookup: Map<string, string>,
  wordList: string[],
): { output: string; breakdown: string } {
  const groups = input.trim().split(/\s*\/\s*/);
  const pairs: string[] = [];
  const decodedWords = groups.map((group) => {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    return tokens
      .map((t) => {
        const ch = lookup.get(fold(t));
        if (ch === undefined) {
          throw new ToolError(
            "invalid-phonetic-word",
            `"${t}" is not a recognized phonetic alphabet word.`,
            `Use a word from the selected alphabet, like "${wordList[0]}" for A, or a digit word like "Zero".`,
          );
        }
        pairs.push(`${t} -> ${ch}`);
        return ch;
      })
      .join("");
  });
  return { output: decodedWords.join(" "), breakdown: pairs.join("\n") };
}

export function run(input: string, opts: NatoOpts): NatoResult {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter text to spell out, or phonetic words to decode.",
      'Type text like "SOS" or phonetic words like "Sierra Oscar Sierra".',
    );

  const alphabet = ALPHABETS[opts.alphabet] ? opts.alphabet : "nato";
  const digitStyle = opts.digitStyle === "aviation" ? "aviation" : "standard";
  const wordList = alphabetFor(alphabet);
  const lookup = buildLookup(alphabet);

  if (isPhoneticInput(raw, lookup)) {
    const { output, breakdown } = decode(raw, lookup, wordList);
    return { Direction: "Phonetic to text", Output: output, Breakdown: breakdown };
  }

  const { output, breakdown } = encode(raw, alphabet, digitStyle);
  return { Direction: "Text to phonetic", Output: output, Breakdown: breakdown };
}

export default { run } satisfies ToolLogic<string, NatoResult, NatoOpts>;
