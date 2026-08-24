import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "folder-diff",
  icon: "FolderSync",
  name: "Folder Diff",
  description: "Compare two local folders and see exactly what changed.",
  category: "Files",
  keywords: [
    "compare two folders",
    "folder diff tool",
    "directory compare online",
    "what changed between folders",
    "diff directories no upload",
    "compare folders by content",
    "find files missing from a folder",
  ],
  searchTerms: [
    "directory diff",
    "winmerge alternative",
    "beyond compare alternative",
    "compare two directories",
    "sync check folders",
    "find changed files",
    "folder comparison tool",
    "diff folders no upload",
    "compare files by hash",
    "robocopy alternative",
    "rsync dry run",
  ],
  input: "none",
  output: "application/json",
  requires: ["fs-access"],
  options: [
    {
      kind: "text",
      id: "ignore",
      label: "Ignore (comma separated globs)",
      default: "node_modules, .git, *.log",
      placeholder: "node_modules, .git, *.log",
    },
    {
      kind: "boolean",
      id: "caseInsensitive",
      label: "Match paths without regard to case",
      default: false,
    },
    {
      kind: "boolean",
      id: "ignoreLineEndings",
      label: "Treat CRLF and LF as the same in the text diff",
      default: false,
    },
    {
      kind: "select",
      id: "format",
      label: "Report format",
      default: "tree",
      options: [
        {
          value: "tree",
          label: "Tree",
          synonyms: ["tree view", "hierarchical", "nested view"],
        },
        {
          value: "flat",
          label: "Flat list",
          synonyms: ["list view", "flat report", "linear list"],
        },
        {
          value: "csv",
          label: "CSV",
          synonyms: ["comma separated", "spreadsheet export", "csv export"],
        },
      ],
    },
  ],
  copy: {
    what: "Compares two folders on your own machine and shows what is only in the first, what is only in the second, and which shared files actually differ. Matching is by path, then by size, then by content hash, so a file with a new timestamp but identical bytes is reported as identical rather than changed. Subfolders that exist on one side only are called out too, and you can exclude noise like node_modules, .git or log files with a glob list. For a shared text file that really did change, you can open a line by line diff of both versions.",
    how: "Pick folder A, then pick folder B. Each folder is opened in place and walked once, so nothing is copied or uploaded. The result appears as a marked tree: green for added, red for removed, amber for changed, muted for identical. Files that share a path and a size are listed as needing a content check; press Resolve same-size files to hash both sides and settle them. Download the result as a tree, a flat list or a CSV when you are done.",
    why: "Comparing two folders normally means installing WinMerge or paying for Beyond Compare, or zipping both folders and handing them to some site that promises to delete them later. This does the same job in a browser tab with nothing installed and nothing uploaded: your files and inputs never leave your device. It also compares by content rather than by timestamp, so a fresh copy of an unchanged file does not show up as a difference the way a plain file listing would.",
    faq: [
      {
        q: "Does it compare file contents or just names and dates?",
        a: "Contents, in two stages. Files are matched by path, then compared by size, which settles most pairs immediately because two files of different lengths cannot hold the same bytes. Anything left over shares a path and a size, and those pairs are compared by SHA-256 hash of both files when you press Resolve same-size files. Timestamps are never used to decide whether a file changed.",
      },
      {
        q: "Can it show me what changed inside a file?",
        a: "Yes, for text files. Select a changed pair and both versions are read and shown as a line by line diff, with an option to treat Windows CRLF and Unix LF line endings as the same. Binary files such as images, archives and executables are reported as different or identical without a line diff, since there are no lines to show.",
      },
      {
        q: "Are my folders uploaded anywhere?",
        a: "No. Both folders are opened in place through the browser File System Access API and read inside this tab: your files and inputs never leave your device. The tool only ever reads, so nothing in either folder is renamed, written or deleted.",
      },
    ],
  },
};
