import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "audio-data-codec",
  matrixSlug: "audio-data",
  icon: "Radio",
  name: "Morse, DTMF and Audio Data",
  description:
    "Translate Morse, generate and read DTMF keypad tones, and send text between devices through a speaker.",
  category: "Audio",
  keywords: [
    "morse code translator",
    "morse code audio",
    "dtmf tone generator",
    "dtmf decoder",
    "send data over sound",
    "audio modem browser",
    "text to morse code sound",
  ],
  searchTerms: [
    "morse code to text",
    "text to morse",
    "cw practice",
    "farnsworth timing",
    "touch tone generator",
    "phone keypad tones",
    "dial tone decoder",
    "afsk",
    "bell 202",
    "acoustic data transfer",
    "chirp transfer",
    "sound modem",
    "goertzel",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "text-to-morse",
      options: [
        {
          value: "text-to-morse",
          label: "Text to Morse",
          synonyms: ["encode morse", "english to morse", "morse code translator", "cw", "keyer"],
        },
        {
          value: "morse-to-text",
          label: "Morse to text",
          synonyms: ["decode morse", "morse to english", "read morse", "translate dots and dashes"],
        },
        {
          value: "dtmf",
          label: "DTMF keypad tones",
          synonyms: ["touch tone", "dial tones", "phone keypad", "q.23", "telephone tones"],
        },
        {
          value: "fsk-info",
          label: "Data over sound",
          synonyms: [
            "audio modem",
            "fsk",
            "afsk",
            "send data through the speaker",
            "acoustic transfer",
            "bell 202",
          ],
        },
      ],
    },
    {
      kind: "number",
      id: "wpm",
      label: "Morse speed (WPM)",
      default: 15,
      min: 5,
      max: 40,
      step: 1,
    },
    {
      kind: "number",
      id: "toneHz",
      label: "Morse tone (Hz)",
      default: 600,
      min: 300,
      max: 1500,
      step: 10,
    },
    {
      kind: "number",
      id: "baud",
      label: "Data speed (baud)",
      default: 100,
      min: 50,
      max: 300,
      step: 10,
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  privacyNote:
    "Every translation, every tone and every decode runs in this page, and nothing you type is uploaded. Sound is the one exception, and it is the point: tones played out loud can be heard and decoded by anyone in the room, so treat the speaker as a public channel.",
  copy: {
    what: "Three ways to carry characters as sound, in one page. Morse translates in both directions using the full ITU table, including punctuation and prosigns like <SOS>, and plays at any speed from 5 to 40 words per minute with proper PARIS timing and optional Farnsworth spacing. DTMF turns a dial string into the exact tone pairs a telephone keypad sends and reads those tones back out of a recording. The data mode frames your text with a preamble, a sync word, a length, and a CRC-16, then sends it as audio frequency shift keying so a second device listening on its microphone can pick the text back up.",
    how: "Pick a mode, type into the box, and the page shows the code, the timing, and how long it takes to send. Press play in the panel to hear it, or save it as a WAV file. To decode, let the panel listen through your microphone: it measures the tone energy in short blocks and reads Morse, DTMF, or a data frame live. For a device to device transfer, open this page on both, put them close together in a quiet room, and press send on one while the other listens.",
    why: "Morse translators usually stop at the text and leave the audio to a different site, DTMF generators tend to be ad heavy Flash leftovers, and the send data over sound demos are npm packages rather than something you can just open. This page does all three, decodes as well as encodes, and shows the actual numbers behind each one: the dit length in milliseconds, the two frequencies per key, the frame layout and the checksum. Your inputs never leave your device, there is no account, no upload, and it keeps working offline once loaded.",
    faq: [
      {
        q: "How far does sending data over the speaker actually work?",
        a: "Across a desk or a quiet room, a few metres at most, and only at low speeds. The default of 100 baud is slow on purpose: every bit gets a full 10 milliseconds, which is a dozen or more whole cycles of tone, and that is what lets the receiver still tell the two tones apart after room echo, laptop speaker roll off and a phone microphone have all had a turn. Raise the baud rate and the useful distance shrinks quickly. It will not survive a noisy cafe, a wall, or a phone in your pocket, so treat it as a neat way to move a short string between two devices in front of you rather than a replacement for a network.",
      },
      {
        q: "Is Morse timing standard, or does everyone do it differently?",
        a: "It is standard. Speed is defined against the word PARIS, which takes exactly 50 dit units including the gap after it, so a dit at W words per minute is 1200 / W milliseconds. A dah is three dits, the gap between elements inside a character is one, between characters three, and between words seven. This page uses exactly that. Farnsworth spacing is the one common variation: the characters stay at the higher speed while only the gaps stretch, so learners hear the real rhythm of each letter without the message arriving too fast to write down.",
      },
      {
        q: "What would I use DTMF tones for?",
        a: "Testing an interactive voice menu or a phone system without dialling anything, checking that a recording captured the right digits, driving old equipment that listens for keypad tones such as repeater controllers and some access gates, and decoding the beeps in a video or voicemail to find out what number was dialled. The A, B, C and D keys in the fourth column are on the pad here too: they were never fitted to consumer phones but still appear in radio and military gear.",
      },
    ],
  },
};
