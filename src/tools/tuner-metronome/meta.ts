import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "tuner-metronome",
  matrixSlug: "tuner",
  icon: "Music",
  name: "Tuner & Metronome",
  description:
    "Tune any instrument from your microphone and run a sample accurate metronome, all in the browser.",
  category: "Audio",
  keywords: [
    "online tuner",
    "guitar tuner online",
    "chromatic tuner browser",
    "metronome online",
    "pitch detector",
    "tune guitar with microphone",
  ],
  searchTerms: [
    "bass tuner",
    "ukulele tuner",
    "violin tuner",
    "banjo tuner",
    "drop d tuner",
    "cents meter",
    "tap tempo",
    "bpm counter",
    "click track",
    "a440 reference",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "a4",
      label: "A4 reference (Hz)",
      default: 440,
      min: 415,
      max: 466,
      step: 1,
    },
    {
      kind: "select",
      id: "tuning",
      label: "Tuning",
      default: "chromatic",
      groups: [
        {
          label: "Any instrument",
          synonyms: ["chromatic", "all notes", "any note", "free"],
          options: [
            {
              value: "chromatic",
              label: "Chromatic",
              synonyms: ["any note", "all twelve notes", "voice", "brass", "woodwind", "piano"],
            },
          ],
        },
        {
          label: "Guitar",
          synonyms: ["six string", "electric guitar", "acoustic guitar", "steel string"],
          options: [
            {
              value: "guitar-standard",
              label: "Guitar standard (EADGBE)",
              synonyms: ["eadgbe", "standard tuning", "six string guitar", "e standard"],
            },
            {
              value: "guitar-drop-d",
              label: "Guitar drop D (DADGBE)",
              synonyms: ["drop d", "dadgbe", "dropped d", "metal tuning"],
            },
            {
              value: "guitar-7-string",
              label: "7 string guitar (BEADGBE)",
              synonyms: ["seven string", "beadgbe", "low b", "extended range"],
            },
          ],
        },
        {
          label: "Bass",
          synonyms: ["bass guitar", "electric bass", "low end"],
          options: [
            {
              value: "bass-4",
              label: "Bass guitar, 4 string (EADG)",
              synonyms: ["eadg", "four string bass", "electric bass", "p bass", "jazz bass"],
            },
          ],
        },
        {
          label: "Ukulele and folk",
          synonyms: ["uke", "bluegrass", "folk instruments", "acoustic"],
          options: [
            {
              value: "ukulele",
              label: "Ukulele, re-entrant (gCEA)",
              synonyms: ["uke", "gcea", "soprano ukulele", "concert ukulele", "high g"],
            },
            {
              value: "mandolin",
              label: "Mandolin (GDAE)",
              synonyms: ["gdae", "mando", "bluegrass", "eight string"],
            },
            {
              value: "banjo-open-g",
              label: "Banjo, 5 string open G (gDGBD)",
              synonyms: ["gdgbd", "open g", "five string banjo", "clawhammer", "bluegrass banjo"],
            },
          ],
        },
        {
          label: "Bowed strings",
          synonyms: ["orchestra", "classical strings", "arco"],
          options: [
            {
              value: "violin",
              label: "Violin (GDAE)",
              synonyms: ["gdae", "fiddle", "viola alternative", "orchestra"],
            },
            {
              value: "cello",
              label: "Cello (CGDA)",
              synonyms: ["cgda", "violoncello", "orchestra"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "timeSignature",
      label: "Time signature",
      default: "4/4",
      options: [
        {
          value: "4/4",
          label: "4/4 common time",
          synonyms: ["common time", "four four", "four beats", "rock", "pop"],
        },
        {
          value: "3/4",
          label: "3/4 waltz",
          synonyms: ["waltz", "three four", "three beats", "triple meter"],
        },
        {
          value: "2/4",
          label: "2/4 march",
          synonyms: ["march", "two four", "two beats", "polka", "cut time feel"],
        },
        {
          value: "6/8",
          label: "6/8 compound duple",
          synonyms: ["six eight", "compound", "jig", "shuffle", "blues in twelve eight"],
        },
        {
          value: "5/4",
          label: "5/4",
          synonyms: ["five four", "five beats", "odd meter", "take five"],
        },
        {
          value: "7/8",
          label: "7/8 grouped 2+2+3",
          synonyms: ["seven eight", "seven beats", "odd meter", "balkan", "prog"],
        },
      ],
    },
  ],
  copy: {
    what: "A chromatic instrument tuner and a metronome in one page. The tuner listens through your microphone, finds the fundamental pitch with the McLeod Pitch Method, and shows the nearest note, how many cents sharp or flat you are, and which open string you are closest to in the tuning you picked. The metronome schedules every click against the audio clock, so the beat holds steady instead of drifting the way a plain timer does. Presets cover guitar, drop D, seven string, bass, ukulele, violin, cello, mandolin, and open G banjo, and the A4 reference moves from 415 Hz to 466 Hz for baroque pitch or an orchestra that tunes sharp.",
    how: "For tuning, pick your instrument, click Start listening, allow microphone access, then play one string at a time and watch the needle settle. Green in the middle means within five cents; the readout tells you which way to turn the peg. For the metronome, set a tempo or tap it in, choose a time signature and a subdivision, then press Start. You can also type a frequency like 440.5 or a tempo like 120 bpm into the box to get the note, the cents offset, the Italian marking, and the millisecond timings without touching the microphone.",
    why: "Most tuner and metronome sites wrap a small amount of audio code in ads, an account wall, or a push to install an app, and several upload nothing useful while asking for the microphone anyway. This one asks for the microphone only when you press the button, analyses the audio in your browser, and never records or uploads it. There is no account, no tempo limit, no ad interrupting the click, and the page works offline after the first load.",
    faq: [
      {
        q: "Is my microphone audio uploaded anywhere?",
        a: "No. The microphone stream goes straight into the browser audio graph and the pitch analysis runs on your device. Nothing is recorded, stored, or sent, and the page keeps working with the network off.",
      },
      {
        q: "How accurate is the pitch detection?",
        a: "The McLeod Pitch Method with parabolic interpolation resolves a clean sustained note to well under a cent, which is far tighter than any string will hold. Accuracy drops on a note that is still ringing down or on a very short pluck, so let the note sustain and play one string at a time.",
      },
      {
        q: "Why does the metronome stay in time when other browser metronomes stutter?",
        a: "Because the clicks are not fired by setTimeout. A short timer wakes up every 25 milliseconds and schedules the next 100 milliseconds of clicks at exact audio clock times, so each one plays at the sample it was booked for even when the main thread is busy rendering something else.",
      },
    ],
  },
};
