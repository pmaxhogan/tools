import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "audio-transcriber",
  icon: "Mic",
  matrixSlug: "transcribe",
  name: "Transcriber",
  description: "Whisper speech to text with timestamps, running entirely in your browser.",
  category: "Local AI",
  keywords: [
    "transcribe audio online free",
    "whisper in browser",
    "speech to text no upload",
    "audio to srt",
    "local transcription",
    "video to subtitles",
    "transcribe mp3 to text",
  ],
  searchTerms: [
    "speech to text",
    "stt",
    "dictation tool",
    "voice to text",
    "closed captions generator",
    "subtitle generator",
    "srt generator",
    "vtt generator",
    "transcript maker",
    "voice recognition",
    "caption generator",
    "meeting transcription",
    "audio to text converter",
  ],
  input: "audio/*",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "model",
      label: "Model",
      default: "whisper-tiny",
      options: [
        {
          value: "whisper-tiny",
          label: "Tiny, 43 MB, fastest",
          synonyms: ["small model", "quick", "low accuracy", "smallest"],
        },
        {
          value: "whisper-base",
          label: "Base, 78 MB, more accurate",
          synonyms: ["larger model", "better accuracy", "slower"],
        },
      ],
    },
    {
      kind: "select",
      id: "format",
      label: "Output format",
      default: "text",
      options: [
        { value: "text", label: "Plain text", synonyms: ["txt", "raw text", "no timestamps"] },
        {
          value: "srt",
          label: "SRT subtitles",
          synonyms: ["subrip", ".srt", "subtitle file"],
        },
        {
          value: "vtt",
          label: "WebVTT subtitles",
          synonyms: ["webvtt", ".vtt", "html5 subtitles"],
        },
        {
          value: "json",
          label: "JSON with timings",
          synonyms: ["structured output", "timestamps json", "machine readable"],
        },
      ],
    },
    {
      kind: "select",
      id: "language",
      label: "Language",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Detect automatically",
          synonyms: ["auto detect", "unknown language", "guess language"],
        },
      ],
      groups: [
        {
          label: "European languages",
          synonyms: ["europe", "western languages"],
          options: [
            { value: "en", label: "English", synonyms: ["eng"] },
            { value: "es", label: "Spanish", synonyms: ["espanol", "castilian"] },
            { value: "fr", label: "French", synonyms: ["francais"] },
            { value: "de", label: "German", synonyms: ["deutsch"] },
            { value: "it", label: "Italian", synonyms: ["italiano"] },
            { value: "pt", label: "Portuguese", synonyms: ["portugues", "brazilian portuguese"] },
            { value: "nl", label: "Dutch", synonyms: ["nederlands", "flemish"] },
            { value: "pl", label: "Polish", synonyms: ["polski"] },
            { value: "ru", label: "Russian", synonyms: ["russkiy"] },
            { value: "tr", label: "Turkish", synonyms: ["turkce"] },
          ],
        },
        {
          label: "Asian languages",
          synonyms: ["asia"],
          options: [
            { value: "ja", label: "Japanese", synonyms: ["nihongo"] },
            { value: "ko", label: "Korean", synonyms: ["hangugeo", "hangul"] },
            { value: "zh", label: "Chinese", synonyms: ["mandarin", "putonghua", "zhongwen"] },
            { value: "hi", label: "Hindi", synonyms: ["devanagari"] },
          ],
        },
        {
          label: "Middle Eastern languages",
          synonyms: ["middle east"],
          options: [{ value: "ar", label: "Arabic", synonyms: ["arabiya"] }],
        },
      ],
    },
    {
      kind: "boolean",
      id: "timestamps",
      label: "Include timestamps",
      default: true,
    },
  ],
  copy: {
    what: "Transcriber runs the open Whisper model from OpenAI inside your browser tab and turns speech in an audio or video file into text. It writes timestamps for every phrase, so you can export the result as plain text, SRT or WebVTT subtitles, or JSON with the exact timings. Two model sizes are offered: tiny is about 43 MB and fast, base is about 78 MB and noticeably more accurate on accents and background noise. Whisper is multilingual, so it can detect the language on its own or be told which one to expect.",
    how: 'Drop an audio or video file on the panel, or pick one with the file button. Press "Load speech model" once and wait for the download, which your browser keeps afterwards so later visits start from the cache. Then press Transcribe: the text appears live as the model works through the recording, and the finished transcript can be copied or downloaded in the format you picked.',
    why: "Transcription sites make you upload your recordings to their servers and then charge by the minute, with a free tier that stops after a few files. This one runs the model in your tab instead, so there is no account, no per minute price, and no queue, and your files and inputs never leave your device. The honest trade is speed: WebAssembly inference runs at roughly real time with the tiny model on a laptop and slower with base, so a long recording takes a while.",
    faq: [
      {
        q: "How accurate is it?",
        a: "Tiny and base are the two smallest Whisper models, so they are good on clear speech and get noticeably worse with strong accents, crosstalk, or heavy background noise. Base makes fewer mistakes than tiny and takes about twice as long. Expect to fix names, numbers, and technical terms by hand, and treat the timestamps as accurate to about a second rather than to the frame.",
      },
      {
        q: "Which languages does it handle?",
        a: 'Whisper is multilingual and this tool exposes fifteen of the most common languages, including English, Spanish, French, German, Italian, Portuguese, Dutch, Japanese, Korean, Chinese, Russian, Polish, Turkish, Arabic, and Hindi. Leaving the language on "Detect automatically" lets the model guess from the first 30 seconds, which usually works. Picking the language explicitly is faster and stops the model drifting into the wrong one partway through a file.',
      },
      {
        q: "Is my audio uploaded anywhere?",
        a: "No. The model files are downloaded from this site once and cached by your browser, and the transcription itself runs in your tab using WebAssembly. Your files and inputs never leave your device, which also means the tool keeps working on a plane once the model is cached.",
      },
    ],
  },
};
