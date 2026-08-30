import { ToolError, type ToolLogic } from "../types";

export interface MorseOpts {
  separator: string; // "space" | "slash-words"
  dotChar: string; // "dot-dash" | "dit-dah-letters"
  wpm: number;
  [key: string]: unknown;
}

export type MorseResult = Record<string, string>;

/** International Morse code: letters, digits, and common punctuation. */
const TEXT_TO_MORSE: Record<string, string> = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  "0": "-----",
  "1": ".----",
  "2": "..---",
  "3": "...--",
  "4": "....-",
  "5": ".....",
  "6": "-....",
  "7": "--...",
  "8": "---..",
  "9": "----.",
  ".": ".-.-.-",
  ",": "--..--",
  "?": "..--..",
  "'": ".----.",
  "!": "-.-.--",
  "/": "-..-.",
  "(": "-.--.",
  ")": "-.--.-",
  "&": ".-...",
  ":": "---...",
  ";": "-.-.-.",
  "=": "-...-",
  "+": ".-.-.",
  "-": "-....-",
  _: "..--.-",
  '"': ".-..-.",
  $: "...-..-",
  "@": ".--.-.",
};

/** Prosigns: procedural signals sent as one run with no inter-letter gap. */
const PROSIGNS: Record<string, string> = {
  "<AR>": ".-.-.", // end of message
  "<AS>": ".-...", // wait
  "<BT>": "-...-", // new paragraph / break
  "<KA>": "-.-.-", // starting signal
  "<KN>": "-.--.", // invite named station only
  "<SK>": "...-.-", // end of contact
  "<SOS>": "...---...",
};

const MORSE_TO_TEXT: Record<string, string> = Object.fromEntries(
  Object.entries(TEXT_TO_MORSE).map(([k, v]) => [v, k]),
);
const MORSE_TO_PROSIGN: Record<string, string> = Object.fromEntries(
  Object.entries(PROSIGNS).map(([k, v]) => [v, k]),
);

function isMorseInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  // Morse uses only dots, dashes, and whitespace/slashes as separators.
  return /^[.\-/\s]+$/.test(trimmed);
}

function textToMorse(input: string, wordSep: string): string {
  const words = input.trim().split(/\s+/);
  const encodedWords = words.map((word) => {
    // Prosigns like <AR> encode as one run of symbols with no letter gap.
    const parts: string[] = [];
    let i = 0;
    while (i < word.length) {
      const prosignMatch = Object.keys(PROSIGNS).find((p) => word.slice(i).startsWith(p));
      if (prosignMatch) {
        parts.push(PROSIGNS[prosignMatch]!);
        i += prosignMatch.length;
        continue;
      }
      const ch = word[i]!.toUpperCase();
      const code = TEXT_TO_MORSE[ch];
      if (code === undefined) {
        throw new ToolError(
          "unsupported-character",
          `"${word[i]}" has no Morse code representation.`,
          "Use letters A-Z, digits 0-9, common punctuation, or a prosign like <AR>.",
        );
      }
      parts.push(code);
      i += 1;
    }
    return parts.join(" ");
  });
  return encodedWords.join(wordSep === "slash-words" ? " / " : "   ");
}

function morseToText(input: string): string {
  // Word boundaries: a literal "/" token, or 2+ spaces between letter groups.
  // A single space separates letters within a word.
  const normalized = input.trim().replace(/\//g, "   ");
  const words = normalized
    .split(/\s{2,}/)
    .map((w) => w.trim())
    .filter(Boolean);
  const wordTexts = words.map((word) => {
    const letters = word.split(/\s+/);
    return letters
      .map((code) => {
        if (!code) return "";
        const prosign = MORSE_TO_PROSIGN[code];
        if (prosign) return prosign;
        const ch = MORSE_TO_TEXT[code];
        if (ch === undefined) {
          throw new ToolError(
            "invalid-morse",
            `"${code}" is not a valid Morse code sequence.`,
            "Use only dots (.) and dashes (-), with a single space between letters and a slash or two spaces between words.",
          );
        }
        return ch;
      })
      .join("");
  });
  return wordTexts.join(" ").trim();
}

/** PARIS timing standard: one dit = 1200 / wpm milliseconds. */
function timingTable(wpm: number): string {
  const ditMs = Math.round(1200 / wpm);
  const dahMs = ditMs * 3;
  const symbolGapMs = ditMs;
  const letterGapMs = ditMs * 3;
  const wordGapMs = ditMs * 7;
  return [
    `${wpm} WPM (PARIS standard)`,
    `dit: ${ditMs} ms`,
    `dah: ${dahMs} ms`,
    `gap between symbols: ${symbolGapMs} ms`,
    `gap between letters: ${letterGapMs} ms`,
    `gap between words: ${wordGapMs} ms`,
  ].join("\n");
}

export function run(input: string, opts: MorseOpts): MorseResult {
  const raw = input ?? "";
  if (!raw.trim())
    throw new ToolError(
      "empty-input",
      "Enter text to encode or Morse code to decode.",
      'Type text like "SOS" or Morse like "... --- ..."',
    );

  const wordSep = opts.separator === "slash-words" ? "slash-words" : "space";
  const wpm = Number.isFinite(opts.wpm) && opts.wpm > 0 ? opts.wpm : 20;
  const useLetters = opts.dotChar === "dit-dah-letters";

  const direction = isMorseInput(raw) ? "decode" : "encode";

  if (direction === "decode") {
    const decoded = morseToText(raw);
    return {
      Direction: "Morse to text",
      Output: decoded,
      Morse: raw.trim(),
      Timing: timingTable(wpm),
    };
  }

  let morse = textToMorse(raw, wordSep);
  if (useLetters) {
    morse = morse.replace(/-/g, "dah ").replace(/\./g, "dit ").replace(/\s+/g, " ").trim();
  }
  return {
    Direction: "Text to Morse",
    Output: morse,
    Text: raw.trim(),
    Timing: timingTable(wpm),
  };
}

export default { run } satisfies ToolLogic<string, MorseResult, MorseOpts>;
