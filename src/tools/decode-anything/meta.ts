import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'decode-anything',
  matrixSlug: 'decode',
  name: 'Decode Anything',
  description:
    'Recursively unwrap base64, hex, URL encoding, gzip, JSON, JWTs, timestamps and IDs until plain meaning falls out.',
  category: 'Dev',
  keywords: [
    'decode base64 online',
    'jwt decoder',
    'what is this string',
    'decode anything',
    'recursive decoder',
    'unwrap base64 gzip',
    'decode unknown string',
    'identify encoding',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'number',
      id: 'maxDepth',
      label: 'Maximum decode depth',
      default: 10,
      min: 1,
      max: 20,
      step: 1,
    },
    {
      kind: 'boolean',
      id: 'showIntermediates',
      label: 'Show the value at every step',
      default: true,
    },
  ],
  http: { method: 'POST', contentType: 'text/plain' },
  copy: {
    what: 'Paste any opaque string and this works out what it is, decodes it, and then tries again on whatever comes out. It recognises JWTs, JSON, base64 and base64url, hex dumps, URL encoding, quoted-printable, data URLs, gzip and zlib streams, unix timestamps, snowflake IDs, UUIDs, MAC addresses, and IPv4 addresses stored as integers. A base64 blob holding a gzipped JSON document unwraps all three layers in one pass, and the result is printed as an indented tree with the decode chain summarised on the first line.',
    how: 'Paste or drop the mystery string into the input. The chain line at the top tells you what it turned out to be, for example "base64 -> gzip -> JSON", and each indented block below shows the value at that step. Use the depth option if a deeply nested payload stops early, and turn off the intermediate values when you only care about the final answer.',
    why: 'Single purpose decoder sites make you guess the encoding before you can even paste, and the ones that handle tokens ask you to hand over a JWT that may still be live. This one tries every detector locally, shows its reasoning including the interpretations it rejected, and your files and inputs never leave your device.',
    faq: [
      {
        q: 'How does it decide what something is?',
        a: 'Detectors run in priority order from most structured to least: JWT and data URLs first, then JSON, URL encoding, UUIDs and MAC addresses, numeric IDs and timestamps, quoted-printable, hex, and finally base64. A detector only fires when its output is genuinely more meaningful than the input, which means valid UTF-8 text with a high printable ratio, parseable JSON, or a recognised file signature such as gzip or PNG. When two readings are plausible you get the stronger one plus an "also possible" line, and text that only decodes to noise is left alone with the closing line "Nothing more to decode."',
      },
      {
        q: 'Are JWT signatures checked?',
        a: 'No, and that is deliberate. Verifying a signature needs the issuer secret or public key, and asking you to paste a signing secret into a web page would be a much bigger risk than the token itself. The decoder shows the header, the payload, the claim times, and the signature length, and labels the contents as unverified. It does flag the one case you can judge without a key: a header that declares alg "none".',
      },
      {
        q: 'Is my token uploaded anywhere?',
        a: 'No. Every detector, including gzip and zlib decompression, runs in your browser using standard web APIs, and your files and inputs never leave your device. The page also works offline after the first load, which is the safest way to inspect a token that is still valid.',
      },
    ],
  },
};
