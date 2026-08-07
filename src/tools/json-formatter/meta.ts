import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'json-formatter',
  matrixSlug: 'json-tools',
  name: 'JSON / JWT / Base64',
  description: 'Format, minify, decode tokens, and handle base64 and URL encoding.',
  category: 'Data',
  keywords: [
    'json formatter',
    'json beautifier',
    'json validator',
    'minify json',
    'jwt decoder',
    'base64 encode',
    'base64 decode',
    'url encode decode',
  ],
  searchTerms: [
    'json pretty print',
    'json prettify',
    'jwt.io alternative',
    'decode jwt token',
    'base64 to text',
    'text to base64',
    'urlencode urldecode',
    'json linter',
    'json syntax checker',
    'bearer token decoder',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'mode',
      label: 'Mode',
      default: 'format',
      choices: [
        { value: 'format', label: 'Format JSON' },
        { value: 'minify', label: 'Minify JSON' },
        { value: 'validate', label: 'Validate JSON' },
        { value: 'jwt-decode', label: 'Decode JWT' },
        { value: 'base64-encode', label: 'Base64 encode' },
        { value: 'base64-decode', label: 'Base64 decode' },
        { value: 'url-encode', label: 'URL encode' },
        { value: 'url-decode', label: 'URL decode' },
      ],
    },
    {
      kind: 'select',
      id: 'indent',
      label: 'Indent (format mode)',
      default: '2',
      choices: [
        { value: '2', label: '2 spaces' },
        { value: '4', label: '4 spaces' },
        { value: 'tab', label: 'Tab' },
      ],
    },
  ],
  http: { method: 'POST', contentType: 'text/plain' },
  copy: {
    what: 'One box for the four things you do to a payload all day: pretty-print or minify JSON, check whether a document is valid and exactly where it breaks, and decode base64, URL-escapes or a JWT. JSON errors report the character position, line and column plus the surrounding text, so you find the stray comma instead of hunting for it. The JWT mode splits the token into header, payload and signature, pretty-prints both JSON parts, reports the algorithm, and turns the exp, iat and nbf claims into readable ISO timestamps. Base64 is unicode-safe in both directions, so emoji and non-Latin scripts round-trip intact.',
    how: 'Paste your JSON, token or text into the input and pick a mode. Format mode lets you choose 2 spaces, 4 spaces or tabs. Validate mode never throws: it answers yes or no and, when the answer is no, tells you the reason and the position. Copy the result with one click; the mode is kept in the URL so you can bookmark the exact tool you use most.',
    why: 'The popular JSON and JWT sites wrap a one-line transform in ad slots, cookie walls and a "paste your token here" box that ships your credentials to their server. A JWT usually contains a live session identity, so pasting one into a remote form is a real leak. Here the transform runs in your browser, your inputs never leave your device, there is no size cap, and the page keeps working offline after first load.',
    faq: [
      {
        q: 'Is it safe to paste a real JWT here?',
        a: 'The decoding happens entirely in your browser and the token is never uploaded, so it is far safer than a server-side decoder. It is still a live credential, so treat the screen you paste it on with the same care you would a password.',
      },
      {
        q: 'Does it verify the JWT signature?',
        a: 'No. Verification needs the signing secret or public key, which should never be pasted into a web page. This tool decodes and displays the token, and it labels the signature as unverified: never trust a payload you have not verified server-side.',
      },
      {
        q: 'Why does my base64 fail to decode?',
        a: 'Two common reasons: the string is base64url (it contains - or _ instead of + and /), which the JWT mode handles instead; or the bytes are a file rather than text, in which case there is no valid UTF-8 string to show.',
      },
    ],
  },
};
