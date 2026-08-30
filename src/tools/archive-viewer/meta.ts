import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "archive-viewer",
  icon: "FileArchive",
  name: "Archive Viewer",
  description: "Browse and extract zip and tar archives without unpacking them to disk.",
  category: "Files",
  keywords: [
    "archive viewer",
    "open zip file online",
    "view tar gz contents",
    "extract one file from a zip",
    "zip file browser",
    "tar gz viewer",
    "look inside an archive without extracting",
    "unzip in browser",
  ],
  searchTerms: [
    "unzip online",
    "untar",
    "tgz opener",
    "gzip viewer",
    "zip contents list",
    "what is in this zip",
    "extract single file from archive",
    "archive explorer",
    "zip slip check",
    "compressed file viewer",
    "tar listing",
    "zip preview",
    "open jar file",
    "read apk contents",
    "epub contents",
    "zip compression ratio",
  ],
  input: "File",
  output: "application/json",
  examples: [
    { label: "Sample zip archive", file: "sample.zip" },
    { label: "Sample tar.gz archive", file: "sample.tar.gz", opts: { view: "tree" } },
  ],
  options: [
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary and listing",
          synonyms: ["overview", "everything", "default", "details", "info"],
        },
        {
          value: "tree",
          label: "Folder tree",
          synonyms: ["hierarchy", "directories", "folders", "nested", "structure"],
        },
        {
          value: "list",
          label: "Full listing",
          synonyms: ["table", "long", "all entries", "ls", "detailed"],
        },
        {
          value: "paths",
          label: "Paths only",
          synonyms: ["names", "filenames", "bare", "plain", "copyable"],
        },
      ],
    },
    {
      kind: "select",
      id: "sort",
      label: "Sort by",
      default: "path",
      options: [
        { value: "path", label: "Path", synonyms: ["name", "alphabetical", "a to z", "folder"] },
        { value: "size", label: "Largest first", synonyms: ["bytes", "biggest", "heaviest"] },
        {
          value: "ratio",
          label: "Best compressed",
          synonyms: ["compression", "savings", "smallest", "squeezed"],
        },
        { value: "date", label: "Newest first", synonyms: ["modified", "time", "recent", "mtime"] },
      ],
    },
    {
      kind: "number",
      id: "limit",
      label: "Entries listed",
      default: 200,
      min: 1,
      max: 5000,
      step: 50,
    },
  ],
  copy: {
    what: "Opens a .zip, .tar, .tar.gz, .tgz or .gz archive and shows you everything inside it: a folder tree you can expand, the uncompressed and compressed size of every entry, how much each one was squeezed, its timestamp, its Unix permissions, and where symlinks point. Text files and images preview in place, so you can check a config or look at a screenshot without extracting anything. You can pull out a single file, or repack a selection as a fresh zip. Entries whose stored path tries to escape the archive root, the zip slip trick, are flagged and only ever shown and saved under a cleaned path.",
    how: "Drop an archive onto the input or pick one with the file button. Expand folders in the tree, or type in the filter box to narrow thousands of entries down to the ones you want. Click an entry to preview it: text files show their first 64 KB and images render directly. Use the download button on an entry to save just that file, or extract everything as a new zip. Archives up to 500 MB are accepted.",
    why: "The usual way to see inside an archive is to download it, extract the whole thing, look at one file, and then clean up the folder you just made. Online extractors avoid the cleanup by uploading your archive to a server instead, which is a poor trade for a build artifact, a database backup or a folder of documents. This one parses zip and tar containers in JavaScript inside the tab, so your files and inputs never leave your device, and it still shows you real per entry compression ratios, pax and GNU long names, and the paths a hostile archive claims rather than quietly rewriting them.",
    faq: [
      {
        q: "Can it open password protected or RAR and 7z archives?",
        a: "No. Encrypted zip entries are detected and listed, so you can see what an archive holds, but they cannot be previewed or extracted here because the tool never asks for a password. RAR, 7z, bzip2 and xz use compressors this reader does not implement and are refused with a clear message rather than a decode error. For those, 7-Zip or the command line unzip and tar are the right tools.",
      },
      {
        q: "Why do some timestamps end in Z and others do not?",
        a: "Because the formats genuinely differ. A tar mtime, a gzip header and zip's optional extended timestamp field all store a real UTC instant, so those are shown with a trailing Z. A plain zip stores MS-DOS date fields, which have two second resolution and record no timezone at all, so those are shown without a Z: it is the wall clock of whichever machine wrote the archive, and inventing a zone for it would be a guess.",
      },
      {
        q: "What is zip slip, and what does the tool do about it?",
        a: "An archive can store any path it likes, including ../../etc/passwd or a Windows drive letter, so that a careless extractor writes outside the folder you chose. Every path here is normalized before it is shown or used for a download: leading slashes and drive letters are stripped and every .. segment is dropped. The path the archive actually claimed is kept and displayed next to the entry, and a warning tells you how many entries tried it, so you can see the attempt instead of it being silently erased.",
      },
    ],
  },
};
