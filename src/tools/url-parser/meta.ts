import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'url-parser',
  icon: 'Link',
  matrixSlug: 'url',
  name: 'URL Parser',
  description: 'Break a URL apart and edit query params as a table.',
  category: 'Network',
  keywords: [
    'url parser',
    'parse url',
    'query string parser',
    'url breakdown',
    'query params',
    'url decoder',
  ],
  searchTerms: [
    'split url into parts',
    'url component breakdown',
    'query string decoder',
    'url query editor',
    'percent encoding decoder',
    'url fragment parser',
    'inspect url',
    'url structure analyzer',
    'phishing url detector',
    'decode url parameters',
  ],
  input: 'text/plain',
  output: 'application/json',
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Breaks a URL down into scheme, host, port, path, each query parameter, and fragment, decoding percent-encoding and "+" spaces along the way. Repeated query keys are each shown on their own row, and a fully decoded form of the whole URL is included at the end.',
    how: 'Paste a URL into the input. If you paste a bare domain or path with no scheme, it is retried with "https://" automatically and flagged with a Note. Every field has its own copy button.',
    why: 'Most URL parser sites are cluttered with ads or only show the raw query string. This one decodes everything for you, calls out embedded-credential phishing patterns (user:pass@host), and runs entirely in your browser: nothing you paste is sent anywhere.',
    faq: [
      {
        q: 'What happens if I paste a URL without a scheme, like example.com/path?',
        a: 'It is parsed as if you had typed https://example.com/path, and a Note row tells you that happened.',
      },
      {
        q: 'How are repeated query parameters like ?tag=a&tag=b shown?',
        a: 'Each occurrence gets its own row: "? tag" for the first, "? tag [2]" for the second, and so on, in the order they appear.',
      },
      {
        q: 'Why does it warn about some URLs?',
        a: 'URLs with a "user:pass@host" pattern before the host are a common phishing trick to disguise the real destination: the tool flags these with a Warning row naming the actual host.',
      },
    ],
  },
};
