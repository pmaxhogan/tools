import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'email-header-analyzer',
  icon: 'MailSearch',
  matrixSlug: 'email-headers',
  name: 'Email Header Analyzer',
  description:
    'SPF, DKIM and DMARC verdicts plus a hop-by-hop delay waterfall from raw email headers.',
  category: 'Network',
  keywords: [
    'email header analyzer',
    'spf dkim dmarc checker',
    'why is my email delayed',
    'received header parser',
    'trace email path',
  ],
  searchTerms: [
    'eml file viewer',
    'authentication results parser',
    'mail hop analyzer',
    'email delivery delay',
    'trace email route',
    'email routing analyzer',
    'mail server hop viewer',
    'email latency waterfall',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'boolean',
      id: 'showRaw',
      label: 'Show unfolded headers',
      default: false,
    },
    {
      kind: 'select',
      id: 'section',
      label: 'Section',
      default: 'all',
      choices: [
        { value: 'all', label: 'Everything' },
        { value: 'summary', label: 'Summary only' },
        { value: 'auth', label: 'Authentication only' },
        { value: 'hops', label: 'Hop waterfall only' },
      ],
    },
  ],
  http: { method: 'POST', contentType: 'text/plain' },
  copy: {
    what: 'Reads a raw email header block, or a whole .eml file, and turns it into a report you can act on. It unfolds the header fields, summarizes who the message claims to be from, pulls the SPF, DKIM, DMARC and ARC verdicts out of the Authentication-Results header, and lists every DKIM signature with its signing domain and selector. It then rebuilds the delivery path from the Received headers, oldest hop first, and draws a waterfall showing exactly where the time went.',
    how: 'Get the raw headers from your mail client: in Gmail open the message overflow menu and choose "Show original", in Outlook open File then Properties and copy the internet headers, in Apple Mail use View then Message then Raw Source. Paste the whole thing in, including a full .eml if that is what you have, since everything after the first blank line is ignored. Use the section selector to jump straight to authentication or the hop waterfall, and turn on unfolded headers when you want to read the raw field list.',
    why: 'The well known header analyzers ask you to post the whole header block to their server, and those headers carry your address, your correspondent addresses, internal hostnames, message IDs and originating IP. This one parses everything in your browser, so your files and inputs never leave your device. It is also honest about what it knows: the SPF and DKIM lines are the receiving server\'s recorded verdicts read back to you, not a fresh check, and the hop waterfall is built to answer the question people actually arrive with, which is which server sat on the message.',
    faq: [
      {
        q: 'Are the SPF, DKIM and DMARC verdicts actually verified?',
        a: 'No, and no browser tool can verify them. The results shown are parsed straight out of the Authentication-Results header that the receiving mail server wrote when it accepted the message. Real verification means fetching the sender SPF record, the DKIM public key at selector._domainkey, and the DMARC policy from DNS, then recomputing the signature over the message body. This tool makes no DNS lookups and no network requests, so it reports what was recorded rather than pretending to re-check it.',
      },
      {
        q: 'How do I get the raw headers out of my mail client?',
        a: 'Gmail: open the message, click the three dot menu at the top right of the message, then "Show original". Outlook on the web: open the message, click the three dot menu, then View, then View message details. Outlook desktop: open the message in its own window, then File, Properties, and copy the Internet headers box. Apple Mail: View, Message, Raw Source.',
      },
      {
        q: 'Are my headers uploaded anywhere?',
        a: 'No. The parsing runs entirely in your browser and the page keeps working offline after the first load, so your files and inputs never leave your device. Nothing is logged, stored or sent for analysis.',
      },
    ],
  },
};
