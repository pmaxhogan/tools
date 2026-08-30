import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "mp3-tag-editor",
  icon: "Music",
  name: "MP3 Tag Editor",
  description: "Read and edit ID3 tags and cover art on MP3 files in the browser.",
  category: "Audio",
  keywords: [
    "mp3 tag editor",
    "id3 tag editor online",
    "edit mp3 metadata",
    "change mp3 album art",
    "add cover art to mp3",
    "mp3 title and artist editor",
    "remove id3 tags",
    "flac tag viewer",
  ],
  searchTerms: [
    "id3v2 reader",
    "music metadata editor",
    "album art embedder",
    "mp3tag alternative",
    "fix song titles",
    "retag music library",
    "audio tag inspector",
    "vorbis comment reader",
    "apic cover art",
    "id3v1 fallback",
    "mp3 track number editor",
    "song info editor",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "tags",
      options: [
        {
          value: "tags",
          label: "Tags and file info",
          synonyms: ["metadata", "title artist album", "summary", "overview"],
        },
        {
          value: "frames",
          label: "Raw frame list",
          synonyms: ["id3 frames", "atoms", "fields", "low level", "bytes"],
        },
        {
          value: "all",
          label: "Everything",
          synonyms: ["both", "full", "complete", "all of it"],
        },
      ],
    },
  ],
  examples: [{ label: "Tagged sample track", file: "sample.mp3" }],
  copy: {
    what: "Opens an MP3 and shows every ID3 tag it carries: title, artist, album, year, track and disc numbers, genre, composer, comment, and the embedded cover art. It reads ID3v2.2, v2.3 and v2.4, including the unsynchronization scheme, extended headers, and all four text encodings, and falls back to the 128 byte ID3v1 trailer when that is all a file has. Edit any field, replace or remove the cover, and save a new file with a clean ID3v2.3 tag in front of your original audio. FLAC files open too, read only, showing their Vorbis comments and picture block.",
    how: "Drop an .mp3 or .flac file onto the input, or click to pick one. The form fills in with whatever the file already says; change the fields you care about, and use the cover panel to swap in a new image or clear the existing one. Press Download tagged MP3 to save the result. The audio frames are copied through untouched, so nothing is re-encoded and the sound is bit identical to what you started with.",
    why: "The tag sites either cap you at a handful of files a day or upload your music to a server to change a few hundred bytes of text. This one parses and rewrites the tag in the page, so your files and inputs never leave your device, and it shows the byte level truth as well: which frames exist, how large each one is, where the audio actually starts, and what the file got wrong.",
    faq: [
      {
        q: "Does saving re-encode my audio?",
        a: "No. The old tag is stripped, a new ID3v2.3 tag is written in front, and the original MPEG audio frames are copied through byte for byte. The audio in the saved file is identical to the audio in the file you dropped.",
      },
      {
        q: "Why does it write ID3v2.3 rather than v2.4?",
        a: "Because v2.3 is the version everything reads. Car stereos, older phones, and a good share of desktop players still handle v2.4 badly or not at all, so the editor reads all three versions and writes the one with the fewest surprises.",
      },
      {
        q: "Can it edit FLAC tags too?",
        a: "Not yet. FLAC files open read only: you can see the Vorbis comments and the embedded picture, but saving is MP3 only for now, since rewriting FLAC metadata means rebuilding the block chain rather than replacing a single header.",
      },
    ],
  },
};
