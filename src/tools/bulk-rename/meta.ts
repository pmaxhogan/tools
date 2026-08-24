import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "bulk-rename",
  icon: "FilePen",
  matrixSlug: "rename",
  name: "Bulk Rename",
  description:
    "Rename many files at once with regex or patterns, previewed before anything is written.",
  category: "Files",
  keywords: [
    "bulk rename files",
    "batch rename online",
    "regex rename files",
    "rename files in browser",
    "mass file renamer no upload",
    "file renamer with preview",
  ],
  searchTerms: [
    "mass renamer",
    "batch file rename",
    "rename photos in bulk",
    "regex file renamer",
    "sequential file numbering",
    "file renaming tool",
    "clean up filenames",
    "strip accents from filenames",
    "multi file rename",
    "rename multiple files",
  ],
  input: "none",
  output: "application/json",
  requires: ["fs-access"],
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Rename mode",
      default: "find-replace",
      options: [
        {
          value: "find-replace",
          label: "Find and replace",
          synonyms: ["search and replace", "regex rename", "substitute"],
        },
        {
          value: "template",
          label: "Template with tokens",
          synonyms: ["pattern rename", "tokens", "placeholders"],
        },
        {
          value: "case",
          label: "Change case",
          synonyms: ["uppercase", "lowercase", "title case", "kebab case"],
        },
        {
          value: "sequence",
          label: "Number in sequence",
          synonyms: ["sequential numbering", "auto number", "counter rename"],
        },
        {
          value: "clean",
          label: "Clean up names",
          synonyms: ["sanitize filenames", "strip accents", "tidy filenames"],
        },
      ],
    },
    { kind: "text", id: "find", label: "Find", default: "", placeholder: "DSC_" },
    { kind: "text", id: "replace", label: "Replace with", default: "", placeholder: "holiday-" },
    { kind: "boolean", id: "regex", label: "Find is a regular expression", default: false },
    { kind: "boolean", id: "caseInsensitive", label: "Ignore case when matching", default: false },
    {
      kind: "text",
      id: "template",
      label: "Template",
      default: "{n}-{name}",
      placeholder: "{date}_{n}_{name}",
    },
    {
      kind: "select",
      id: "caseMode",
      label: "Case",
      default: "lower",
      options: [
        { value: "lower", label: "lower case", synonyms: ["lowercase", "all lower"] },
        { value: "upper", label: "UPPER CASE", synonyms: ["uppercase", "all caps"] },
        {
          value: "title",
          label: "Title Case",
          synonyms: ["capitalize each word", "headline case"],
        },
        {
          value: "kebab",
          label: "kebab-case",
          synonyms: ["dash case", "hyphen case", "slug case"],
        },
        { value: "snake", label: "snake_case", synonyms: ["underscore case"] },
        { value: "camel", label: "camelCase", synonyms: ["mixed case", "javascript naming"] },
      ],
    },
    { kind: "text", id: "prefix", label: "Prefix", default: "file-", placeholder: "photo-" },
    { kind: "number", id: "seqStart", label: "Start numbering at", default: 1, min: 0, step: 1 },
    { kind: "number", id: "seqPad", label: "Number width", default: 3, min: 1, max: 10, step: 1 },
    {
      kind: "select",
      id: "separator",
      label: "Separator",
      default: "dash",
      options: [
        { value: "dash", label: "Dash", synonyms: ["hyphen", "-"] },
        { value: "underscore", label: "Underscore", synonyms: ["_", "snake separator"] },
        { value: "none", label: "None", synonyms: ["no separator", "blank"] },
      ],
    },
    { kind: "boolean", id: "lowercase", label: "Lowercase the result", default: true },
    { kind: "boolean", id: "includeExt", label: "Include the extension", default: false },
    {
      kind: "select",
      id: "filterMode",
      label: "Only rename files matching",
      default: "none",
      options: [
        { value: "none", label: "Every file", synonyms: ["no filter", "all files"] },
        {
          value: "glob",
          label: "A glob, like *.jpg",
          synonyms: ["wildcard pattern", "glob pattern"],
        },
        {
          value: "regex",
          label: "A regular expression",
          synonyms: ["regexp", "regex pattern", "regular expression filter"],
        },
      ],
    },
    { kind: "text", id: "filter", label: "Pattern", default: "", placeholder: "*.jpg" },
    {
      kind: "select",
      id: "sortBy",
      label: "Numbering order",
      default: "name",
      options: [
        { value: "name", label: "Filename", synonyms: ["alphabetical", "by name"] },
        {
          value: "date",
          label: "Date modified, oldest first",
          synonyms: ["modification date", "chronological", "oldest to newest"],
        },
        {
          value: "size",
          label: "Size, smallest first",
          synonyms: ["file size", "smallest to largest"],
        },
      ],
    },
  ],
  copy: {
    what: "Renames a whole folder of files in one pass, in the browser, against the real files on your disk. Five modes cover the usual jobs: find and replace (with optional regular expressions and $1 group references), a template with {name}, {ext}, {n}, {counter}, {parent} and {date} tokens, a case change (lower, upper, title, kebab, snake or camel), a numbered sequence with a prefix and zero padding, and a clean up pass that strips accents, tidies spaces and drops characters that cause trouble later. A glob or regex filter narrows the job to the files you actually mean, such as *.jpg. Every plan is checked for names that collide before a single file is touched.",
    how: "Choose a folder, and the tool reads it in place and shows a table of every file with the name it would get. Tweak the pattern and the table updates as you type, so you can see the result before committing to it. When it looks right, press Apply renames, review the exact list of changes, download the undo file, and confirm. Files are only renamed inside their own folder: nothing moves between folders and subfolders are never renamed.",
    why: "Desktop bulk renamers are installs, and the web ones cannot touch real files, so people end up scripting it and hoping. This one previews every change against your actual folder and writes an undo file before it renames a single thing, all locally. Renames come out in an order that lets a whole run shift down by one without a file overwriting the next, and anything that would collide is held back and listed rather than left to fail halfway through.",
    faq: [
      {
        q: "Can I undo a bulk rename?",
        a: "Yes. An undo file listing the reverse of every rename is offered as a download before anything is written, and again afterwards. It is a plain JSON list of the old and new names, so you can replay it here or read it in any editor. Renames are also never destructive: a rename onto an existing name is refused rather than overwriting it.",
      },
      {
        q: "Does it rename subfolders too?",
        a: "It renames files only, including files inside subfolders, but it never renames a folder itself. That is deliberate: renaming a folder moves everything under it at once, and a mistake there is much harder to walk back than a mistaken filename.",
      },
      {
        q: "Are my files uploaded anywhere?",
        a: "No. The folder is opened in place through the browser File System Access API and read in this tab, so your files and inputs never leave your device. There is no server side for this tool and no API endpoint, which is also why it needs a Chromium browser such as Chrome, Edge, Brave or Opera on desktop.",
      },
    ],
  },
};
