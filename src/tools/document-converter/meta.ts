import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "document-converter",
  matrixSlug: "doc-convert",
  icon: "FileText",
  name: "Document Converter",
  description: "Convert DOCX, Markdown and HTML into PDF, and pull clean text back out again.",
  category: "Docs",
  keywords: [
    "docx to pdf online",
    "markdown to pdf",
    "html to pdf converter",
    "docx to markdown",
    "pdf to text",
    "convert docx to html",
    "word to markdown",
  ],
  searchTerms: [
    "word to pdf",
    "doc converter",
    "md to pdf",
    "docx to html",
    "docx to text",
    "extract text from pdf",
    "pdf text extractor",
    "convert word document online",
    "markdown to word",
    "html to text",
    "readme to pdf",
    "notes to pdf",
    "pandoc alternative",
  ],
  input: "File",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "from",
      label: "Input format",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Detect automatically",
          synonyms: ["auto", "guess", "sniff", "any"],
        },
        {
          value: "docx",
          label: "Word document (.docx)",
          synonyms: ["docx", "word", "microsoft word", "office", "doc"],
        },
        {
          value: "markdown",
          label: "Markdown",
          synonyms: ["md", "markdown", "commonmark", "gfm", "readme"],
        },
        { value: "html", label: "HTML", synonyms: ["html", "web page", "rich text", "xhtml"] },
        { value: "text", label: "Plain text", synonyms: ["txt", "text", "plain", "notes"] },
      ],
    },
    {
      kind: "select",
      id: "to",
      label: "Output format",
      default: "html",
      options: [
        { value: "html", label: "HTML", synonyms: ["html", "web page", "markup", "xhtml"] },
        {
          value: "markdown",
          label: "Markdown",
          synonyms: ["md", "markdown", "gfm", "commonmark"],
        },
        { value: "text", label: "Plain text", synonyms: ["txt", "text", "plain", "strip tags"] },
        { value: "pdf", label: "PDF", synonyms: ["pdf", "print", "acrobat", "document"] },
      ],
    },
    {
      kind: "select",
      id: "pageSize",
      label: "PDF page size",
      default: "a4",
      options: [
        { value: "a4", label: "A4", synonyms: ["a4", "metric", "210mm", "europe"] },
        {
          value: "letter",
          label: "US Letter",
          synonyms: ["letter", "us", "8.5x11", "america", "imperial"],
        },
      ],
    },
    {
      kind: "number",
      id: "fontSize",
      label: "PDF body text size (pt)",
      default: 11,
      min: 6,
      max: 36,
    },
    { kind: "number", id: "margin", label: "PDF page margin (pt)", default: 56, min: 18, max: 200 },
    { kind: "boolean", id: "pageNumbers", label: "Number the PDF pages", default: true },
  ],
  copy: {
    what: "Converts documents between the four formats people actually pass around: Word .docx files, Markdown, HTML, and plain text, plus a PDF on the way out. DOCX comes in through a real Open XML reader, so headings, lists, tables, bold and italic survive, and pictures come across as inline images in the HTML output. The PDF path is a clean text flow rendering built from the document structure: headings sized by level, bullet and numbered lists, indented quotes, monospaced code blocks, horizontal rules, tables flattened to rows, word wrapping measured against the real font, page breaks and page numbers. Dropping a PDF in runs the other direction and extracts its text, tidied up so hyphenated line breaks and column padding do not follow you out.",
    how: "Drop a .docx, .md, .html, .txt or .pdf file onto the panel, or paste Markdown or HTML straight in. The input format is detected for you, and you can override it if the guess is wrong. Pick an output format, check the preview pane, then copy the result or download it. For PDF output you can set A4 or US Letter, body text size, page margin, and whether pages get numbered.",
    why: "The popular document converters upload your file to a server, queue it, and hand it back with a watermark or a two file daily cap unless you pay. That is a rough deal for the documents people convert most: contracts, resumes, invoices, medical letters, drafts nobody else should read. This one does the whole conversion in the page, so your files and inputs never leave your device, with no account, no queue and no size cap beyond what your own browser can hold. It is also honest about the one thing it does differently: the PDF is a text flow rendering rather than a browser screenshot, and the Print to PDF button is right there when you need the exact page.",
    faq: [
      {
        q: "Is my document uploaded anywhere?",
        a: "No. The Word reader, the Markdown and HTML converters, the PDF writer and the PDF text extractor all run inside this page, so your files and inputs never leave your device. The page keeps working after the first load even with the network off.",
      },
      {
        q: "Why does the PDF look plainer than my original?",
        a: "Because it is a text flow rendering, not a screenshot of a styled page. The converter reads the document structure (headings, lists, quotes, code, tables) and lays it out with proper wrapping, page breaks and page numbers, but it does not run a CSS engine, so colors, columns, background art and web fonts are not reproduced. When you need the page exactly as it looks on screen, use the Print to PDF button, which hands the preview to your browser's own print dialog.",
      },
      {
        q: "Does it keep images from my Word file?",
        a: "In the HTML output, yes: pictures embedded in a .docx come across as inline images, so the HTML is self contained. In the PDF output, no: the text flow renderer skips images and leaves a short note where each one sat, so you can see what was dropped. Markdown output keeps the image reference, and plain text output carries the same short note.",
      },
    ],
  },
};
