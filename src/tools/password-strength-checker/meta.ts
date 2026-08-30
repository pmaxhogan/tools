import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "password-strength-checker",
  icon: "ShieldCheck",
  name: "Password Strength Checker",
  description:
    "Score a password's real entropy and crack time, with plain English reasons, on your device.",
  category: "Crypto",
  // The password is the input, so sensitiveInput keeps it out of the URL
  // fragment, browser history, and any link you might share.
  sensitiveInput: true,
  keywords: [
    "password strength checker",
    "how strong is my password",
    "password entropy calculator",
    "password crack time",
    "test password strength",
    "zxcvbn online",
  ],
  searchTerms: [
    "check my password",
    "is my password secure",
    "password entropy bits",
    "time to crack a password",
    "password meter",
    "weak password test",
    "dictionary attack check",
    "keyboard walk password",
    "leet speak password",
    "password guess count",
    "brute force time calculator",
    "password strength offline",
  ],
  input: "text/plain",
  output: "application/json",
  // No http entry, ever: a curl endpoint for this tool would mean real
  // passwords traveling over the network to be scored.
  options: [
    {
      kind: "select",
      id: "attacker",
      label: "Headline attack scenario",
      default: "offline-fast",
      options: [
        {
          value: "online-throttled",
          label: "Online, rate limited (100 per hour)",
          synonyms: ["login form", "throttled", "lockout", "web app"],
        },
        {
          value: "online-open",
          label: "Online, no rate limit (10 per second)",
          synonyms: ["unthrottled", "api", "credential stuffing"],
        },
        {
          value: "offline-slow",
          label: "Offline, slow hash (10 thousand per second)",
          synonyms: ["bcrypt", "argon2", "scrypt", "stolen database"],
        },
        {
          value: "offline-fast",
          label: "Offline, fast hash on a GPU (10 billion per second)",
          synonyms: ["sha256", "md5", "hashcat", "gpu cracking", "default"],
        },
        {
          value: "offline-cluster",
          label: "Offline, GPU cluster (100 trillion per second)",
          synonyms: ["nation state", "rig", "worst case", "cloud cracking"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "showPatterns",
      label: "Show the pattern breakdown",
      default: true,
    },
  ],
  // No examples: sensitiveInput suppresses pre-fill anyway, and offering a
  // sample password would only teach people to test something they do not use.
  copy: {
    what: "Estimates how many guesses a password would actually take, rather than counting its character classes. It looks for the things that make a long password cheap: entries from a bundled list of leaked passwords and common words, the same words spelled backwards or with digits swapped in for letters, walks across neighboring keys, runs like 1234 and wxyz, repeated chunks, and years and dates. Then it finds the cheapest way to build the whole password out of those pieces, converts that into a 0 to 4 score with a reason, and shows the crack time under five different attacks.",
    how: "Type or paste one password. The score, the estimated number of guesses, and the crack times update as you type. Read the pattern breakdown to see which parts of the password an attacker gets for free and which parts they have to guess character by character, then use the suggestions to fix the cheap parts. Switch the attack scenario to match the threat you care about: a rate limited login form and a stolen fast hash are separated by about twelve orders of magnitude.",
    why: "A password meter that counts symbols will tell you P@ssw0rd1 is strong, which is how people end up with passwords that fall in milliseconds. This one prices the patterns instead, and it tells you what it found rather than showing a colored bar. It also does the whole thing in the tab: your files and inputs never leave your device, nothing is stored, and there is deliberately no server endpoint, because a hosted password checker is a password collection service with extra steps.",
    faq: [
      {
        q: "Is my password being sent anywhere?",
        a: "No. The dictionaries ship with the page, the analysis runs in JavaScript inside your browser tab, and the password is never written to the URL, to storage, or to a network request. The page keeps working with the network off, which you can check yourself. This tool also has no curl endpoint, on purpose.",
      },
      {
        q: "How does this compare to zxcvbn?",
        a: "It borrows the idea: find the cheapest sequence of recognizable patterns that spells the password, price each one, and multiply. The differences are honest ones. The bundled dictionaries here hold about a thousand entries rather than tens of thousands, and the pattern costs are simpler. So treat the guess count as an order of magnitude, not a measurement, and treat a high score as the absence of the patterns it knows about rather than proof of strength.",
      },
      {
        q: "Why does adding an exclamation mark and a capital barely change the score?",
        a: "Because attackers already know that people put the capital first and the punctuation last. A cracking tool takes each dictionary word and applies those rules automatically, so Password1! costs a small multiple of password, not the enormous number a character-class calculator would report. Length and unpredictability are what actually move the number.",
      },
      {
        q: "What should I do with a low score?",
        a: "Use a password manager and let it generate the password, so it never has to be memorable. Where you do have to remember one, four or five unrelated words chosen at random beat a short scrambled string on both strength and typability. And do not reuse a password anywhere, since a strong password is worth nothing once the site that stored it is breached.",
      },
    ],
  },
};
