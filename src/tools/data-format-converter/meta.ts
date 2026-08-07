import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'data-format-converter',
  icon: 'ArrowRightLeft',
  matrixSlug: 'data-convert',
  name: 'Data Format Converter',
  description: 'Convert between CSV, JSON, YAML and TOML in any direction.',
  category: 'Data',
  keywords: [
    'csv to json',
    'json to yaml',
    'yaml to toml',
    'toml to json',
    'json to csv',
    'convert csv to yaml online',
    'data format converter',
  ],
  searchTerms: [
    'json to yaml converter',
    'yaml to json converter',
    'toml to yaml',
    'csv to yaml',
    'json to toml',
    'yaml to csv',
    'config format converter',
    'serialization format converter',
    'structured data converter',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'from',
      label: 'From',
      default: 'auto',
      choices: [
        { value: 'auto', label: 'Auto detect' },
        { value: 'csv', label: 'CSV' },
        { value: 'json', label: 'JSON' },
        { value: 'yaml', label: 'YAML' },
        { value: 'toml', label: 'TOML' },
      ],
    },
    {
      kind: 'select',
      id: 'to',
      label: 'To',
      default: 'json',
      choices: [
        { value: 'json', label: 'JSON' },
        { value: 'csv', label: 'CSV' },
        { value: 'yaml', label: 'YAML' },
        { value: 'toml', label: 'TOML' },
      ],
    },
    {
      kind: 'number',
      id: 'indent',
      label: 'Indent',
      default: 2,
      min: 0,
      max: 8,
      step: 1,
    },
    {
      kind: 'boolean',
      id: 'csvHeader',
      label: 'First CSV row is a header',
      default: true,
    },
  ],
  http: { method: 'POST', contentType: 'text/plain' },
  copy: {
    what: 'Converts data between CSV, JSON, YAML and TOML in all twelve directions. Paste any of the four and it works out which one you gave it, or pick the source format yourself. CSV parsing types its values, so 30 becomes a number and true becomes a boolean instead of a quoted string, and the delimiter is sniffed so tab separated and semicolon separated files work too.',
    how: 'Paste or drop your data, leave "From" on auto detect, and choose the target format. Set the indent to control the width of pretty printed JSON and YAML, or set it to 0 to minify JSON. Turn off the CSV header switch when your file starts straight in on the data, and the columns are named col1, col2 and so on instead.',
    why: 'Most converters online handle exactly one pair, which means bookmarking four sites, and they pay for themselves by pushing your file through an upload box surrounded by ads. This one does every direction on one page, and it is honest about the lossy corners: nested data going to CSV is flattened rather than quietly mangled, and keys that TOML cannot hold are listed in a comment rather than silently dropped.',
    faq: [
      {
        q: 'How does auto detect decide which format I pasted?',
        a: 'It tries them in order of strictness. Strict JSON first, since every valid JSON document is also valid YAML. Then TOML, but only if the text has a key = value line or a [section] header, because a TOML parser will otherwise accept fragments you meant as something else. Then YAML, rejecting the result if it came back as one plain string, which is what happens when you feed a YAML parser ordinary prose. Then CSV, which needs a consistent delimiter on every line. If none of that fits, you get an error asking you to pick the source format instead of a wrong guess.',
      },
      {
        q: 'What happens to nested JSON when I convert it to CSV?',
        a: 'CSV is flat, so one level of nesting is flattened into dotted column names: an object at "user" holding "name" becomes the column "user.name". Anything deeper than that, and any array value, is written into the cell as inline JSON so nothing is lost, even though it is no longer split across columns. Arrays of scalars or mixed values have no table shape at all, so those raise an error suggesting JSON or YAML instead of producing a misleading file.',
      },
      {
        q: 'Is my data uploaded anywhere?',
        a: 'No. The conversion runs entirely in your browser, so your files and inputs never leave your device, and the page keeps working with no connection at all after the first load.',
      },
    ],
  },
};
