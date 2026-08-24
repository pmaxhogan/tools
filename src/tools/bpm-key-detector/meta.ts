import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "bpm-key-detector",
  matrixSlug: "bpm",
  icon: "Drum",
  name: "BPM and Key Detector",
  description: "Find the tempo and musical key of a track, or tap the tempo yourself.",
  category: "Audio",
  keywords: [
    "bpm detector",
    "song key finder",
    "detect bpm of a song",
    "tap tempo",
    "key detector online",
    "camelot key",
    "find tempo of mp3",
    "harmonic mixing key finder",
  ],
  searchTerms: [
    "tempo detector",
    "beat detection",
    "beatgrid",
    "musical key analyser",
    "mixed in key alternative",
    "open key notation",
    "relative minor finder",
    "dj key wheel",
    "metronome marking",
    "half time double time",
  ],
  input: "audio/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "notation",
      label: "Key notation",
      default: "both",
      options: [
        {
          value: "camelot",
          label: "Camelot only",
          synonyms: ["mixed in key", "8a", "wheel", "dj notation", "harmonic wheel"],
        },
        {
          value: "open-key",
          label: "Open Key only",
          synonyms: ["1m", "openkey", "rekordbox", "traktor", "beatport"],
        },
        {
          value: "both",
          label: "Camelot and Open Key",
          synonyms: ["all", "everything", "default", "show both"],
        },
      ],
    },
  ],
  copy: {
    what: "Measures the tempo and the musical key of an audio file in your browser. The tempo comes from an onset strength envelope autocorrelated over the 60 to 200 bpm range, reported to one decimal place with its half time and double time candidates listed beside it so you can see where the octave ambiguity sits. The key comes from a chromagram correlated against the Krumhansl-Schmuckler profiles for all 24 major and minor keys, reported as a name plus its Camelot and Open Key codes. There is also a tap tempo, which averages your taps, trims the one you fumbled, and tells you how steady the rest were.",
    how: "Drop an audio file onto the panel or pick one with the file button, then wait while the browser decodes it and the analysis runs. Tap the tempo button in time with a track instead when you only want a rough number, or when the track is not on this machine. You can type into the box as well: a run of tap times in milliseconds such as 0, 500, 1000, 1500 gives you a tempo, a bare number such as 128 gives you the tempo marking and the beat, bar, and pitch fader figures, and a key such as A minor or a code such as 8A gives you the wheel position, the relative key, and the keys that mix with it.",
    why: "Key finders are usually a paid desktop app or an upload form that queues your track behind a free tier limit and hands the result back with a watermark or a signup wall. This one runs the FFT, the autocorrelation, and the key profile correlation in the page you are looking at, so your files and inputs never leave your device and there is no length cap beyond what your machine can hold. It also shows its working: the runner up tempos with their scores, the runner up keys with their correlations, and a confidence figure for each, so you can tell a solid reading from a guess instead of trusting one number.",
    faq: [
      {
        q: "How accurate is it?",
        a: "On music with a clear beat, a four to the floor dance track, a rock song, most pop, the tempo lands within a few tenths of a bpm and the main risk is the half or double time question below rather than the number itself. On rubato piano, live orchestral recordings, ambient music, and anything with a deliberately loose feel there may be no single tempo to find, and the confidence figure drops to say so. Key detection is harder and every tool gets it wrong sometimes: expect it to be right most of the time on tonal music that stays in one key, and to struggle on tracks that modulate, on heavily processed material where the bass drowns the harmony, and on anything modal or atonal. The most common near miss is the relative key, naming C major where a musician would say A minor, because the two share all seven notes and only differ in which one feels like home. That is why the tool prints the next three candidates with their correlation scores. If the top two are close, treat the answer as a shortlist rather than a verdict.",
      },
      {
        q: "Why does it sometimes report half or double the tempo I expected?",
        a: "Autocorrelation cannot tell a beat from its own half or double, because a signal that repeats every half second also repeats every second and every quarter second. Nothing in the audio settles it; only a listener deciding how to count does. The usual example is drum and bass, which is written at 174 bpm but whose kick pattern is just as strong at 87. This tool leans towards the 80 to 160 bpm band where most music is counted, which is right far more often than not, and it lists the half time and double time candidates with their scores so you can override it in one glance. If you are beatmatching, either number works as long as both decks agree, since one is a whole number multiple of the other.",
      },
      {
        q: "Is my audio file uploaded anywhere?",
        a: "No. The browser decodes the file with its own audio decoder, the FFT and the autocorrelation run on the samples in this tab, and the result is drawn in the page. Your files and inputs never leave your device, there is no upload step, and nothing about the track is stored or logged. The page works offline once it has loaded, which is the simplest way to check the claim for yourself: turn off the network and analyze a file anyway.",
      },
    ],
  },
};
