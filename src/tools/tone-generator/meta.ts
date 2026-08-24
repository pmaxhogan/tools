import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "tone-generator",
  matrixSlug: "tone",
  icon: "AudioWaveform",
  name: "Signal Generator",
  description: "Sine, square and sweep tones for speaker and subwoofer testing.",
  category: "Audio",
  keywords: [
    "tone generator",
    "online tone generator",
    "frequency generator",
    "sine wave generator",
    "subwoofer test tone",
    "sweep tone",
    "hz tone",
  ],
  searchTerms: [
    "audio test tone",
    "speaker test tone",
    "square wave generator",
    "pink noise generator",
    "white noise generator",
    "frequency sweep generator",
    "audiometry tone",
    "note to frequency",
    "hearing test tone",
    "sine wave test online",
    "wav export tone",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "wave",
      label: "Waveform",
      default: "sine",
      groups: [
        {
          label: "Tone",
          synonyms: ["steady tone", "pitched wave", "musical wave"],
          options: [
            { value: "sine", label: "Sine", synonyms: ["pure tone", "sinusoid", "clean tone"] },
            { value: "square", label: "Square", synonyms: ["square wave", "buzzy tone"] },
            {
              value: "triangle",
              label: "Triangle",
              synonyms: ["triangle wave", "soft buzz"],
            },
            { value: "sawtooth", label: "Sawtooth", synonyms: ["saw wave", "ramp wave", "buzz"] },
          ],
        },
        {
          label: "Noise",
          synonyms: ["static", "hiss"],
          options: [
            {
              value: "white-noise",
              label: "White noise",
              synonyms: ["static", "hiss", "full spectrum noise"],
            },
            {
              value: "pink-noise",
              label: "Pink noise",
              synonyms: ["1/f noise", "equal octave noise", "relaxation noise"],
            },
          ],
        },
        {
          label: "Sweep",
          synonyms: ["chirp", "frequency sweep"],
          options: [
            {
              value: "sweep",
              label: "Sweep",
              synonyms: ["chirp", "frequency sweep", "sine sweep"],
            },
          ],
        },
      ],
    },
    {
      kind: "number",
      id: "duration",
      label: "Duration (seconds)",
      default: 3,
      min: 0.1,
      max: 60,
      step: 0.1,
    },
    { kind: "number", id: "volume", label: "Volume (%)", default: 50, min: 0, max: 100, step: 1 },
    {
      kind: "number",
      id: "endFrequency",
      label: "Sweep end frequency (Hz)",
      default: 20000,
      min: 1,
      max: 24000,
      step: 1,
    },
    {
      kind: "select",
      id: "sweepKind",
      label: "Sweep shape",
      default: "log",
      options: [
        {
          value: "linear",
          label: "Linear",
          synonyms: ["equal hertz per second", "straight sweep"],
        },
        {
          value: "log",
          label: "Logarithmic",
          synonyms: ["exponential", "equal octave per second", "musical sweep"],
        },
      ],
    },
  ],
  copy: {
    what: "Generates sine, square, triangle, sawtooth, white noise, pink noise, and swept tones for testing speakers, subwoofers, headphones, and hearing. Type a frequency like 440 or 1kHz, or a note name like A4 or C#3, and the page describes the resulting signal: exact frequency, nearest note, wavelength in air, period, and where it falls relative to human hearing.",
    how: "Type a frequency or note into the input, pick a waveform, and adjust duration, volume, and (for a sweep) the end frequency and sweep shape. The panel plays the tone on demand through your speakers or headphones and can export the same signal as a WAV file. Nothing plays automatically.",
    why: "Most online tone generators run flash-era interfaces, autoplay audio the moment the page loads, or gate the sweep and noise modes behind a paywall. This one starts silent, exposes the exact math behind the sweep, and works fully offline once loaded, with no ads and no account.",
    faq: [
      {
        q: "Is it safe to play these tones at full volume?",
        a: "No. Start at a low volume, especially on headphones and at very low or very high frequencies, since a tone can cause hearing damage before it feels loud. Raise the volume slowly and stop if anything feels uncomfortable.",
      },
      {
        q: "Why can I not hear an 18 kHz tone that the page says it is playing?",
        a: "Human hearing typically tops out well below 20 kHz, and that ceiling drops with age, most noticeably above about 15 to 17 kHz. The tone is genuinely being generated even if your ears, headphones, or speakers cannot reproduce it.",
      },
      {
        q: "How do I use a sweep to test a subwoofer?",
        a: "Pick the sweep waveform, set the start frequency low (try 20 Hz) and the end frequency around 200 Hz with a logarithmic shape, then play it at a moderate volume and listen for rattles, buzzing, or a sudden drop in output, which usually mark the edge of the subwoofer's range or a loose panel.",
      },
    ],
  },
};
