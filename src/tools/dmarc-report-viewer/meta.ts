import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'dmarc-report-viewer',
  icon: 'ShieldCheck',
  matrixSlug: 'dmarc',
  name: 'DMARC Report Viewer',
  description: 'Drop a DMARC aggregate report and see who is sending as your domain.',
  category: 'Network',
  keywords: [
    'dmarc report viewer',
    'dmarc xml reader',
    'read dmarc aggregate report',
    'who is spoofing my domain',
    'dmarc rua analyzer',
    'dmarc report parser',
    'open dmarc zip attachment',
  ],
  searchTerms: [
    'dmarc aggregate report reader',
    'spf dkim report',
    'email spoofing checker',
    'dmarc rua xml',
    'dmarc gz reader',
    'domain spoofing report',
    'email authentication report',
  ],
  input: 'File',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'view',
      label: 'View',
      default: 'summary',
      choices: [
        { value: 'summary', label: 'Summary' },
        { value: 'full', label: 'Full (every record)' },
      ],
    },
    {
      kind: 'boolean',
      id: 'groupBySource',
      label: 'Group records by source IP',
      default: true,
    },
  ],
  copy: {
    what: 'Reads the DMARC aggregate report that mailbox providers send to your rua address and turns it into something you can actually read. It handles the .zip, .gz, and .xml attachment forms, including archives that hold several reports at once, and it decodes the published policy into plain English. The per-source table shows every sending IP with its message count, disposition, aligned SPF and DKIM results, and a verdict: aligned pass, forwarder, SPF-only pass, or likely spoofing.',
    how: 'Save the report attachment out of the DMARC email, then drop it on the input or use the file picker. You can also paste the raw XML if you have already unzipped it. Switch to the full view to see every record row with its header-from and raw authentication results, or turn off grouping to keep each record separate.',
    why: 'The hosted DMARC analyzers want you to point your rua address at their servers, upload every report, and pay monthly for a dashboard. This reads the raw attachment you already received: your files and inputs never leave your device, there is no account, and there is no per-domain limit. It will not do the things that genuinely need a server, such as reverse DNS on a sending IP or trending across months, and it says so rather than pretending.',
    faq: [
      {
        q: 'What am I actually looking at in a DMARC report?',
        a: 'One report is a single mailbox provider telling you what it saw from your domain over roughly one day. Each record is a sending IP with a message count and the DMARC result: whether SPF and DKIM passed and lined up with the domain in the From header, and what the provider did with the mail. It is a summary of volume, not a copy of any message content.',
      },
      {
        q: 'What does a forwarder look like versus real spoofing?',
        a: 'A forwarder usually shows SPF fail with DKIM pass, because forwarding rewrites the envelope sender but leaves the DKIM signature intact. Mailing lists behave the same way. Mail that fails both SPF and DKIM alignment is the pattern worth investigating, though it is often one of your own senders that was never set up rather than an attacker.',
      },
      {
        q: 'Is my report uploaded anywhere?',
        a: 'No. Your files and inputs never leave your device. The zip or gzip is decompressed and the XML is parsed in your browser, and the page works offline after the first load.',
      },
    ],
  },
};
