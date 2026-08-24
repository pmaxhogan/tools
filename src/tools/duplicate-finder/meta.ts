import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "duplicate-finder",
  icon: "CopyCheck",
  matrixSlug: "dupes",
  name: "Duplicate Finder",
  description: "Find identical files in a folder tree by content, then reclaim the space.",
  category: "Files",
  keywords: [
    "find duplicate files",
    "duplicate file finder",
    "dedupe folder",
    "find identical files by content",
    "reclaim disk space duplicates",
    "delete duplicate photos",
    "duplicate file finder no download",
  ],
  searchTerms: [
    "find identical files",
    "remove duplicate files",
    "disk space cleaner",
    "duplicate photo finder",
    "sha256 file compare",
    "file hash duplicate check",
    "clean up folder duplicates",
    "file deduplication tool",
    "duplicate file remover",
  ],
  input: "none",
  output: "application/json",
  // No http entry: the folder never leaves the machine it is on, so there is
  // nothing for a stateless endpoint to receive. The whole tool is the panel.
  requires: ["fs-access"],
  options: [
    {
      kind: "select",
      id: "keep",
      label: "Which copy to keep",
      default: "shallowest",
      options: [
        {
          value: "first-alpha",
          label: "First by path (A to Z)",
          synonyms: ["alphabetical", "first alphabetically", "a-z order", "path order"],
        },
        {
          value: "shortest-path",
          label: "Shortest path",
          synonyms: ["shortest", "least nested path", "fewest folders"],
        },
        {
          value: "newest",
          label: "Newest file",
          synonyms: ["most recent", "latest modified", "newest modified date"],
        },
        {
          value: "oldest",
          label: "Oldest file",
          synonyms: ["earliest", "oldest modified", "first created"],
        },
        {
          value: "shallowest",
          label: "Closest to the top folder",
          synonyms: ["shallowest", "top level", "least nested folder", "root closest"],
        },
      ],
    },
  ],
  copy: {
    what: "Finds files that hold exactly the same bytes anywhere under a folder you choose, no matter what they are called. It walks the folder once for names and sizes, groups files by size, and then reads and hashes only the files that share a size with another file, because two files cannot hold the same contents unless they hold the same number of bytes. Each set of identical files is shown with its size, how much space the extra copies waste, and every path, so you can pick which copy survives before anything is deleted.",
    how: "Click Choose a folder and pick the one you want cleaned up, then let the scan finish. The tool tells you how many files actually need hashing out of the total, and Find duplicates reads just those. Groups come back sorted by wasted space, with a keep rule you can change (closest to the top folder, newest, oldest, shortest path, first alphabetically) and a per file radio if you would rather choose by hand. Tick the groups you want cleaned, download the record file, then confirm the deletion.",
    why: "The alternatives are an installer that wants to scan your whole drive, or a web page that cannot read a real folder at all and makes you upload files one at a time. This one opens the folder in place with the File System Access API, hashes only the files that could possibly match instead of every file you own, shows you exactly which paths it proposes to remove, and takes a confirmation before it touches anything: your files and inputs never leave your device.",
    faq: [
      {
        q: "How does it decide two files are identical?",
        a: "By content, never by name. First it compares sizes, since files of different sizes cannot be identical, and any file whose size nothing else shares is ruled out without being read. The remaining candidates are read and hashed with SHA-256, and only a matching digest makes a group. That means two copies of the same photo match even when one is called IMG_0421.jpg and the other Copy of holiday.jpg, and two different files that happen to be the same size never match. Files over 256 MB are the one exception: browser hashing has to hold a whole file in memory at once, so those are reported as a size match that was not verified rather than being hashed.",
      },
      {
        q: "Can I undo a deletion?",
        a: "No. Deleting a file frees its bytes, and nothing in a browser tab can bring them back. Before anything runs you get a list of every path that will go and a record file to download, but that record only says what was deleted, it does not contain the contents and cannot restore them. Nothing is deleted until you confirm, and you can always start with the groups you are sure about and leave the rest.",
      },
      {
        q: "Are my files uploaded anywhere?",
        a: "No. The folder is opened in place by your browser after you grant permission, and the scanning, hashing and comparing all run in this tab: your files and inputs never leave your device. Closing the tab ends the access, and the permission has to be granted again next time.",
      },
    ],
  },
};
