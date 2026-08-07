import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "escape-unescape",
  icon: "Quote",
  matrixSlug: "escape",
  name: "Escape / Unescape",
  description:
    "Escape or unescape text in over thirty formats: JSON, HTML, XML, URL, C, Python, Java, shell, SQL, base64, base32, base58, ascii85, uuencode, quoted-printable, ROT13/47, Morse, NATO phonetic, punycode, and more.",
  category: "Text",
  keywords: [
    "escape string",
    "unescape string",
    "encode decode text",
    "json escape",
    "html entities",
    "url encode decode",
    "base64 encode decode",
    "punycode converter",
  ],
  searchTerms: [
    "regex escape",
    "shell quote escape",
    "xml entity encode",
    "percent encoding",
    "url component encode",
    "form url encoded",
    "c string escape",
    "c++ string escape",
    "python string escape",
    "java unicode escape",
    "dotnet string escape",
    "csharp string escape",
    "unicode code point escape",
    "hex escape",
    "octal escape",
    "whitespace visualizer",
    "control character escape",
    "powershell string escape",
    "windows batch escape",
    "cmd escape",
    "sql string quote",
    "sql escape",
    "csv quote field",
    "ldap filter escape",
    "ldap escape",
    "base32 encode decode",
    "base58 encode decode",
    "bitcoin base58",
    "ascii85 encode decode",
    "base85 encode decode",
    "adobe85",
    "uuencode uudecode",
    "quoted printable",
    "mime qp encode",
    "rot13",
    "rot47 cipher",
    "caesar cipher",
    "morse code translator",
    "nato phonetic alphabet",
    "military alphabet",
    "idn encode",
    "punycode encode decode",
    "xn-- prefix",
    "internationalized domain name",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "format",
      label: "Format",
      default: "json",
      groups: [
        {
          label: "Markup and data",
          synonyms: ["web", "markup", "serialization", "structured data", "entities"],
          options: [
            {
              value: "json",
              label: "JSON string escape",
              synonyms: ["javascript object notation", "js string"],
            },
            {
              value: "html",
              label: "HTML entities (named + numeric)",
              synonyms: ["named entities", "numeric entities", "ampersand", "web page"],
            },
            {
              value: "xml",
              label: "XML entities (predefined + numeric)",
              synonyms: ["predefined entities", "xhtml"],
            },
            {
              value: "url",
              label: "URL percent-encoding (component)",
              synonyms: ["percent encoding", "encodeuricomponent", "query parameter"],
            },
            {
              value: "url-full",
              label: "URL percent-encoding (full URI)",
              synonyms: ["encodeuri", "full uri", "whole url"],
            },
            {
              value: "url-form",
              label: "URL form-encoded (application/x-www-form-urlencoded)",
              synonyms: ["form encoded", "plus for space", "www-form-urlencoded"],
            },
            {
              value: "url-bytes",
              label: "Percent-encode every UTF-8 byte",
              synonyms: ["percent encode bytes", "utf-8 bytes", "every byte"],
            },
            {
              value: "csv",
              label: "CSV field quoting (RFC 4180)",
              synonyms: ["comma separated values", "rfc 4180", "spreadsheet field"],
            },
            {
              value: "sql",
              label: "SQL string literal quoting",
              synonyms: ["sql literal", "quote sql", "database"],
            },
            {
              value: "ldap",
              label: "LDAP filter escaping (RFC 4515)",
              synonyms: ["ldap filter", "rfc 4515", "directory"],
            },
          ],
        },
        {
          label: "Programming string literals",
          synonyms: ["code", "source code", "programming", "string literal", "language"],
          options: [
            {
              value: "regex",
              label: "Regex metacharacters",
              synonyms: ["regular expression", "escape regex", "regexp"],
            },
            {
              value: "c",
              label: "C / C++ string literal",
              synonyms: ["c++", "cpp", "c string"],
            },
            {
              value: "python",
              label: "Python string literal",
              synonyms: ["py", "python string", "repr"],
            },
            {
              value: "java",
              label: "Java / .NET \\uXXXX escape",
              synonyms: ["dotnet", "csharp", "c#", "unicode escape"],
            },
            {
              value: "unicode-brace",
              label: "JS/TS \\u{...} code point escape",
              synonyms: ["javascript", "typescript", "code point", "es6"],
            },
            {
              value: "whitespace",
              label: "Whitespace and control character visualizer",
              synonyms: ["control characters", "visualize whitespace", "invisible characters"],
            },
            {
              value: "hex-bytes",
              label: "Hex byte escape (\\xHH, every byte)",
              synonyms: ["hex escape", "hexadecimal bytes", "\\xhh"],
            },
            {
              value: "octal-bytes",
              label: "Octal byte escape (\\NNN, every byte)",
              synonyms: ["octal escape", "base 8", "\\nnn"],
            },
          ],
        },
        {
          label: "Shell and OS",
          synonyms: ["terminal", "command line", "quoting", "operating system"],
          options: [
            {
              value: "shell",
              label: "Shell, POSIX single-quoted",
              synonyms: ["bash", "posix", "single quote", "sh"],
            },
            {
              value: "shell-double",
              label: "Shell, POSIX double-quoted",
              synonyms: ["bash", "posix", "double quote"],
            },
            {
              value: "batch",
              label: "Windows batch (cmd.exe) escape",
              synonyms: ["cmd", "cmd.exe", "bat"],
            },
            {
              value: "powershell",
              label: "PowerShell single-quoted string",
              synonyms: ["pwsh", "windows powershell", "ps1"],
            },
          ],
        },
        {
          label: "Binary to text",
          synonyms: ["encoding", "binary encoding", "base", "radix"],
          options: [
            { value: "base64", label: "Base64", synonyms: ["b64", "mime base64"] },
            {
              value: "base64url",
              label: "Base64url (no padding)",
              synonyms: ["url safe base64", "b64url", "no padding"],
            },
            { value: "base32", label: "Base32 (RFC 4648)", synonyms: ["rfc 4648", "b32"] },
            {
              value: "base58",
              label: "Base58 (Bitcoin alphabet)",
              synonyms: ["bitcoin", "btc", "base58check alphabet"],
            },
            {
              value: "ascii85",
              label: "Ascii85 / Base85 (Adobe)",
              synonyms: ["base85", "adobe85", "a85"],
            },
            {
              value: "uuencode",
              label: "Uuencode",
              synonyms: ["uudecode", "unix to unix"],
            },
            {
              value: "quoted-printable",
              label: "Quoted-printable (MIME)",
              synonyms: ["qp", "mime qp", "email encoding"],
            },
          ],
        },
        {
          label: "Ciphers and codes",
          synonyms: ["cipher", "code", "classic", "alphabet"],
          options: [
            {
              value: "rot13",
              label: "ROT13",
              synonyms: ["caesar cipher", "letter rotation", "rot-13"],
            },
            {
              value: "rot47",
              label: "ROT47",
              synonyms: ["caesar cipher", "ascii rotation", "rot-47"],
            },
            {
              value: "morse",
              label: "Morse code",
              synonyms: ["dots and dashes", "telegraph"],
            },
            {
              value: "nato",
              label: "NATO phonetic alphabet",
              synonyms: ["military alphabet", "alpha bravo charlie", "phonetic"],
            },
            {
              value: "punycode",
              label: "Punycode / IDN (xn-- domains)",
              synonyms: ["idn", "internationalized domain name", "xn--", "idna"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "direction",
      label: "Direction",
      default: "escape",
      options: [
        {
          value: "escape",
          label: "Escape / Encode",
          synonyms: ["encode", "encoding", "to escaped"],
        },
        {
          value: "unescape",
          label: "Unescape / Decode",
          synonyms: ["decode", "decoding", "from escaped"],
        },
      ],
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "One tool for over thirty text escaping and encoding formats: the common ones (JSON, HTML, XML, URL, regex) plus far more obscure territory, including C, Python, Java and JS/TS string-literal escapes, shell/batch/PowerShell/SQL/CSV/LDAP quoting, binary-to-text encodings (base64, base64url, base32, base58, ascii85, uuencode, quoted-printable), classic ciphers (ROT13, ROT47), Morse code, the NATO phonetic alphabet, and punycode for internationalized domain names. Every reversible format round-trips: escape, then unescape, and you get your original text back.",
    how: "Paste your text, pick a format from the dropdown, and choose Escape/Encode or Unescape/Decode. The result updates instantly with its own copy button. Malformed input for any decode direction (a truncated base64 string, an unterminated escape sequence, an out-of-range punycode digit) raises a specific error explaining what is wrong and how to fix it, instead of silently returning garbage.",
    why: "Most escaping sites online handle one format, bury the tool under ads, and quietly mangle malformed input. This one covers over thirty formats, common and obscure, in a single page, runs entirely in your browser, and never sends your text anywhere: your files and inputs never leave your device.",
    faq: [
      {
        q: "What is the difference between the URL, URL full URI, and URL form-encoded options?",
        a: "Component encoding (encodeURIComponent) escapes everything except unreserved characters, and is right for a single query parameter or path segment. Full URI encoding (encodeURI) leaves URL structure characters like / and ? alone, for encoding a whole URL. Form-encoded matches application/x-www-form-urlencoded, the format browsers use for HTML form submissions, where a space becomes + instead of %20.",
      },
      {
        q: "Why do some formats like ROT13 have both Escape and Unescape do the same thing?",
        a: "ROT13 and ROT47 are self-inverse Caesar ciphers: applying the same shift twice returns the original text, so encoding and decoding are literally the same operation. Both directions are still exposed for consistency with every other format.",
      },
      {
        q: "How does punycode handle a full domain name like café.com?",
        a: "It splits on dots and encodes each label independently, only touching labels that contain non-ASCII characters and prefixing them with xn--, exactly like a browser converts an internationalized domain name before a DNS lookup. ASCII-only labels, like com, pass through untouched.",
      },
    ],
  },
};
