import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "discord-video-compressor",
  icon: "Shrink",
  matrixSlug: "discord-compressor",
  name: "Discord Compressor",
  description:
    "Two pass encode that lands a video just under a chosen upload cap, computed from its length.",
  category: "Media",
  keywords: [
    "discord video compressor",
    "compress video for discord",
    "compress video under 10mb",
    "shrink mp4 to 25mb",
    "reduce video file size online",
    "two pass video compression",
    "fit video under upload limit",
    "compress video without uploading",
  ],
  searchTerms: [
    "compress video for discord free",
    "shrink video file size",
    "two pass h264 encode",
    "video bitrate calculator",
    "discord nitro upload limit",
    "compress mp4 online",
    "video compressor no upload",
    "reduce mp4 size",
    "handbrake alternative",
    "discord video upload limit",
  ],
  input: "video/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "cap",
      label: "Size cap",
      default: "10",
      options: [
        {
          value: "10",
          label: "10 MB (free tier)",
          synonyms: ["discord free", "default limit", "no nitro"],
        },
        {
          value: "50",
          label: "50 MB (Nitro Basic)",
          synonyms: ["nitro basic limit", "discord basic"],
        },
        { value: "500", label: "500 MB (Nitro)", synonyms: ["discord nitro limit", "nitro full"] },
      ],
    },
    {
      kind: "text",
      id: "customMB",
      label: "Custom cap in MB",
      default: "",
      placeholder: "e.g. 25",
    },
    {
      kind: "select",
      id: "maxHeight",
      label: "Resolution",
      default: "0",
      options: [
        {
          value: "0",
          label: "Keep the source height",
          synonyms: ["original resolution", "no resize", "native resolution"],
        },
        { value: "1080", label: "Cap at 1080p", synonyms: ["full hd", "1920x1080"] },
        { value: "720", label: "Cap at 720p", synonyms: ["hd", "1280x720"] },
        { value: "480", label: "Cap at 480p", synonyms: ["sd", "standard definition"] },
      ],
    },
    { kind: "boolean", id: "keepFps", label: "Keep the source frame rate", default: true },
    { kind: "boolean", id: "keepAudio", label: "Keep the audio track", default: true },
  ],
  copy: {
    what: "Works out the exact video bitrate that fits a clip under a size cap, then runs a two pass H.264 encode in your browser to hit it. It reads the length of the video, holds back a margin for container overhead, pays for an AAC audio track at 96, 64, or 48 kbps depending on how tight the budget is, and hands the rest to the picture. The presets cover the common Discord caps, and a custom field takes any size up to 2000 MB for other upload limits. When a cap genuinely cannot hold the clip, it says so with the numbers instead of producing something unwatchable.",
    how: "Drop a video in and the tool reads its length, then shows the plan before anything is encoded: target size, video and audio bitrate, and the estimated result. Pick a cap, optionally cap the height or the frame rate to buy more bits per pixel, then press Compress. Pass one analyzes the clip and pass two encodes it, and the finished file is checked against the cap and reported as either the headroom it left or an honest overshoot. Very large sources are limited by how much memory the browser tab can hold, so an hour of 4K may not load even when the math says it would fit.",
    why: "The popular discord-size sites upload your video to their servers, re-encode it with one fixed setting, and hand back whatever comes out, which is why the result is often far under the cap and softer than it needed to be. This one computes the bitrate for your exact clip length and cap, shows you the plan before it runs, and does the encode with ffmpeg inside this tab: your files and inputs never leave your device. No queue, no watermark, no account.",
    faq: [
      {
        q: "Why does it encode twice?",
        a: "A hard size target needs accurate rate control. On a single pass the encoder is guessing how much of its budget the rest of the clip will need, so a still opening and a busy ending can leave the file well under or over the target. The first pass encodes nothing but statistics about where the motion and detail actually are, and the second pass spends the budget against that map, which is what makes the finished size land close to the number that was planned.",
      },
      {
        q: "What do I do when it says the cap cannot hold the clip?",
        a: "That message appears when the budget leaves under 100 kbps for video, which is the point where H.264 stops resolving anything. Three things buy real bits back: cap the resolution (480p over 1080p is roughly a quarter of the pixels), cap the frame rate at 30, or shorten the clip, since the budget is divided by its length. If none of those are acceptable, a larger cap is the only honest option.",
      },
      {
        q: "Is my video uploaded anywhere?",
        a: "No. The encoder is a WebAssembly build of ffmpeg that runs inside this tab: your files and inputs never leave your device. The engine itself is a one time download of about 31 MB that your browser keeps, so later visits start it from the cache.",
      },
    ],
  },
};
