import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "audio-spectrogram",
  icon: "AudioWaveform",
  matrixSlug: "spectrogram",
  name: "Spectrogram Viewer",
  description:
    "Draw a waveform and frequency spectrogram for any audio file, or extract and chart the audio track from a video first.",
  category: "Media",
  keywords: [
    "spectrogram viewer",
    "audio spectrogram online",
    "frequency analysis of audio file",
    "waveform viewer",
    "fft audio analyzer",
    "visualize sound frequencies",
    "audio frequency spectrum tool",
    "mp3 spectrogram",
    "video spectrogram",
    "extract audio from video",
    "spectrogram from mp4 video",
  ],
  searchTerms: [
    "sonogram",
    "sound visualizer",
    "frequency chart",
    "spectral analysis",
    "fourier transform",
    "sound wave viewer",
    "audio fingerprint",
    "noise floor viewer",
    "frequency domain chart",
    "pitch visualizer",
    "decibel chart",
    "spectrogram maker",
  ],
  input: "audio/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "fftSize",
      label: "FFT size",
      default: "2048",
      options: [
        {
          value: "1024",
          label: "1024 (sharper in time)",
          synonyms: ["fast", "low resolution", "small window"],
        },
        {
          value: "2048",
          label: "2048 (balanced)",
          synonyms: ["default", "medium", "standard"],
        },
        {
          value: "4096",
          label: "4096 (sharper in frequency)",
          synonyms: ["high resolution", "large window", "slow"],
        },
      ],
    },
    {
      kind: "select",
      id: "colors",
      label: "Color scheme",
      default: "viridis",
      options: [
        {
          value: "viridis",
          label: "Viridis",
          synonyms: ["green purple", "default colormap", "matplotlib default"],
        },
        { value: "magma", label: "Magma", synonyms: ["black orange", "heat colormap"] },
        {
          value: "gray",
          label: "Grayscale",
          synonyms: ["greyscale", "black and white", "monochrome"],
        },
      ],
    },
    {
      kind: "select",
      id: "scale",
      label: "Frequency axis",
      default: "linear",
      options: [
        { value: "linear", label: "Linear", synonyms: ["uniform scale", "hz scale"] },
        {
          value: "log",
          label: "Logarithmic",
          synonyms: ["log scale", "octave scale", "musical scale", "pitch scale"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "showWaveform",
      label: "Show waveform strip",
      default: true,
    },
  ],
  copy: {
    what: "Draws a spectrogram of any audio file your browser can decode: WAV, MP3, FLAC, OGG, M4A, and more. Drop in a video such as MP4, MOV, WebM, or MKV and its audio track is extracted locally first, then charted the same way. Time runs left to right, frequency runs bottom to top, and color is loudness in decibels with 0 dB as full scale. A waveform strip sits above it so you can line up what you hear with what you see. The frequency axis switches between linear and logarithmic, the FFT size trades time detail against frequency detail, and the whole picture exports as a PNG.",
    how: "Drop an audio or video file onto the panel or pick one with the file button, then wait for the progress bar to finish. A video first has its audio pulled out with an ffmpeg engine that runs inside this tab, so the first video you load triggers a one time engine download of about 31 MB that your browser then keeps. Hover anywhere on the spectrogram to read the exact time, frequency, and level under the pointer, and click to play from that moment with a playhead tracking along. Change the FFT size, colors, or frequency axis at any time and the picture redraws from the samples already in memory. Files longer than ten minutes are analyzed up to the ten minute mark and the panel says so on screen.",
    why: "Most spectrogram sites make you upload the audio first, then cap the length, watermark the image, or hide the export behind an account. This one decodes and analyzes the file in your browser with a hand written FFT, so your files and inputs never leave your device. The levels are real decibels against full scale rather than an arbitrary brightness ramp, the logarithmic frequency view matches how pitch actually works, and the PNG export is the same picture you are looking at, axes included.",
    faq: [
      {
        q: "What am I actually looking at?",
        a: "Each vertical stripe is one short slice of the audio, a few tens of milliseconds long. Within that stripe, height is frequency: bass at the bottom, treble at the top. Brightness is how much energy sat at that frequency during that slice, in decibels, where the brightest color is full scale and the darkest is 100 dB below it. A steady musical note shows up as a horizontal line with faint parallel lines above it, its harmonics. A drum hit or a consonant shows up as a bright vertical smear across many frequencies at once. Speech looks like stacked wavy lines that move together as the pitch changes. Silence is flat and dark, and a hard low pass filter or a lossy codec often leaves a visible flat ceiling where everything above a certain frequency simply stops.",
      },
      {
        q: "Why would I switch the frequency axis to logarithmic?",
        a: "Hearing is roughly logarithmic in pitch: every octave doubles the frequency, so the jump from 100 Hz to 200 Hz sounds like the same distance as 5 kHz to 10 kHz. A linear axis gives half the picture to the top octave alone and squashes every bass and midrange detail into a thin band at the bottom. The logarithmic view spreads the octaves evenly from 20 Hz up to the Nyquist limit, which is what you want for music, voice, and anything where the interesting structure lives below 2 kHz. Keep the linear axis when you care about high frequency content specifically, such as spotting a codec cutoff or ultrasonic noise.",
      },
      {
        q: "Can I load a video instead of an audio file?",
        a: "Yes. Drop in an MP4, MOV, WebM, MKV, or most other video containers and the tool pulls out the audio track for you before charting it. The extraction runs on an ffmpeg engine that loads inside this tab, so your files and inputs never leave your device. That engine is a one time download of about 31 MB, which is why it only starts once you actually load a video rather than on page visit, and your browser keeps it afterwards so later videos start straight from the cache and work offline. On a connection the browser reports as metered, the download waits for a single tap instead of starting on its own. If a video has no audio track, the tool says so rather than drawing an empty picture.",
      },
      {
        q: "Is my audio uploaded anywhere?",
        a: "No. The browser decodes the file, the FFT runs on the samples in this tab, and the canvas draws the result locally, so your files and inputs never leave your device. There is no upload step, no size limit beyond what your machine can hold in memory, and the PNG export is produced in the page rather than fetched from a server.",
      },
    ],
  },
};
