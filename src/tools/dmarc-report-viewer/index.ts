import { gunzipSync, unzipSync } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ToolError, type ToolLogic } from '../types';

export interface DmarcOpts {
  /** 'summary' shows totals plus the per-source table; 'full' adds every record row. */
  view?: string;
  /** Collapse records that share a source IP into one line. */
  groupBySource?: boolean;
  [key: string]: unknown;
}

/** Advice repeated in every parse failure: what file the user should actually drop. */
const FIX_HINT =
  'Use the .zip, .gz or .xml attachment from the DMARC report email exactly as it arrived, or paste the raw XML.';

/** fast-xml-parser returns a bare object for a single child and an array for many. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Everything comes out of the parser as a string or a nested object; flatten to text. */
function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const inner = (value as Record<string, unknown>)['#text'];
    if (inner !== undefined) return text(inner);
  }
  return '';
}

function num(value: unknown): number {
  const raw = text(value);
  if (raw === '') return NaN;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function fail(message: string): never {
  throw new ToolError('invalid-report', message, FIX_HINT);
}

// ---------------------------------------------------------------------------
// Container handling: zip, gzip, or plain XML text
// ---------------------------------------------------------------------------

interface XmlFile {
  /** Entry name inside the archive, or a synthetic label for single documents. */
  name: string;
  xml: string;
}

function decodeUtf8(bytes: Uint8Array, what: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(`${what} is not valid UTF-8 text, so it cannot be a DMARC XML report.`);
  }
  return decoded.replace(/^\uFEFF/, '');
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function gunzipOrFail(bytes: Uint8Array, what: string): Uint8Array {
  try {
    return gunzipSync(bytes);
  } catch {
    return fail(`${what} looks gzip compressed but could not be decompressed. It may be truncated.`);
  }
}

function extractXmlFiles(input: Uint8Array | string): XmlFile[] {
  if (typeof input === 'string') {
    const trimmed = input.replace(/^\uFEFF/, '').trim();
    if (trimmed === '') {
      throw new ToolError(
        'empty-input',
        'No DMARC report was provided.',
        'Drop the report attachment onto the input, use the file picker, or paste the report XML.',
      );
    }
    if (!trimmed.startsWith('<')) {
      return fail('The pasted text does not start with an XML tag, so it is not a DMARC report.');
    }
    return [{ name: 'pasted XML', xml: trimmed }];
  }

  const bytes = input;
  if (!bytes || bytes.length === 0) {
    throw new ToolError(
      'empty-input',
      'No DMARC report was provided.',
      'Drop the report attachment onto the input, use the file picker, or paste the report XML.',
    );
  }

  if (isZip(bytes)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      return fail('The zip archive could not be opened. It may be truncated or password protected.');
    }
    const files: XmlFile[] = [];
    for (const name of Object.keys(entries).sort()) {
      const entry = entries[name];
      if (!entry || entry.length === 0) continue;
      if (name.endsWith('/')) continue;
      const lower = name.toLowerCase();
      if (lower.endsWith('.xml')) {
        files.push({ name, xml: decodeUtf8(entry, `The zip entry ${name}`) });
      } else if (lower.endsWith('.xml.gz') || lower.endsWith('.gz')) {
        // Some mailers nest a gzipped report inside the zip.
        const inflated = gunzipOrFail(entry, `The zip entry ${name}`);
        files.push({ name, xml: decodeUtf8(inflated, `The zip entry ${name}`) });
      } else if (isGzip(entry)) {
        const inflated = gunzipOrFail(entry, `The zip entry ${name}`);
        files.push({ name, xml: decodeUtf8(inflated, `The zip entry ${name}`) });
      }
    }
    if (files.length === 0) {
      return fail('The zip archive contains no XML report files.');
    }
    return files;
  }

  if (isGzip(bytes)) {
    const inflated = gunzipOrFail(bytes, 'The file');
    return [{ name: 'report.xml', xml: decodeUtf8(inflated, 'The decompressed file') }];
  }

  const decoded = decodeUtf8(bytes, 'The file').trim();
  if (decoded === '') {
    throw new ToolError(
      'empty-input',
      'The file is empty.',
      'Drop the report attachment onto the input, use the file picker, or paste the report XML.',
    );
  }
  if (!decoded.startsWith('<')) {
    return fail('The file does not start with an XML tag and is not a zip or gzip archive.');
  }
  return [{ name: 'report.xml', xml: decoded }];
}

// ---------------------------------------------------------------------------
// DMARC aggregate schema
// ---------------------------------------------------------------------------

export type Verdict =
  | 'aligned pass'
  | 'forwarder (SPF fail, DKIM pass)'
  | 'likely spoofing (both fail)'
  | 'SPF-only pass (alignment risk)';

interface DmarcRecord {
  sourceIp: string;
  count: number;
  disposition: string;
  policySpf: string;
  policyDkim: string;
  headerFrom: string;
  authSpf: string;
  authDkim: string;
  verdict: Verdict;
}

interface DmarcReport {
  file: string;
  orgName: string;
  orgEmail: string;
  reportId: string;
  begin: number;
  end: number;
  domain: string;
  p: string;
  sp: string;
  adkim: string;
  aspf: string;
  pct: string;
  records: DmarcRecord[];
}

function verdictFor(spf: string, dkim: string): Verdict {
  const spfPass = spf === 'pass';
  const dkimPass = dkim === 'pass';
  if (spfPass && dkimPass) return 'aligned pass';
  if (dkimPass) return 'forwarder (SPF fail, DKIM pass)';
  if (spfPass) return 'SPF-only pass (alignment risk)';
  return 'likely spoofing (both fail)';
}

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function parseReport(file: XmlFile): DmarcReport {
  const valid = XMLValidator.validate(file.xml);
  if (valid !== true) {
    return fail(`${file.name} is not well formed XML: ${valid.err.msg}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(file.xml) as Record<string, unknown>;
  } catch {
    return fail(`${file.name} could not be parsed as XML.`);
  }

  const feedback = parsed.feedback as Record<string, unknown> | undefined;
  if (!feedback || typeof feedback !== 'object') {
    return fail(`${file.name} has no <feedback> element, so it is not a DMARC aggregate report.`);
  }

  const metadata = (feedback.report_metadata ?? {}) as Record<string, unknown>;
  const range = (metadata.date_range ?? {}) as Record<string, unknown>;
  const policy = (feedback.policy_published ?? {}) as Record<string, unknown>;
  const rawRecords = asArray(feedback.record as Record<string, unknown> | Record<string, unknown>[]);

  if (rawRecords.length === 0) {
    return fail(`${file.name} contains no <record> entries, so there is nothing to report on.`);
  }

  const records: DmarcRecord[] = rawRecords.map((raw) => {
    const row = (raw.row ?? {}) as Record<string, unknown>;
    const evaluated = (row.policy_evaluated ?? {}) as Record<string, unknown>;
    const identifiers = (raw.identifiers ?? {}) as Record<string, unknown>;
    const auth = (raw.auth_results ?? {}) as Record<string, unknown>;

    const dkimEntries = asArray(auth.dkim as Record<string, unknown> | Record<string, unknown>[]);
    const spfEntries = asArray(auth.spf as Record<string, unknown> | Record<string, unknown>[]);

    const describeAuth = (entries: Record<string, unknown>[]): string => {
      if (entries.length === 0) return 'none';
      return entries
        .map((entry) => {
          const domain = text(entry.domain);
          const result = text(entry.result) || 'unknown';
          return domain ? `${domain}=${result}` : result;
        })
        .join(', ');
    };

    const count = num(row.count);
    const policySpf = (text(evaluated.spf) || 'fail').toLowerCase();
    const policyDkim = (text(evaluated.dkim) || 'fail').toLowerCase();

    return {
      sourceIp: text(row.source_ip) || 'unknown',
      count: Number.isFinite(count) && count >= 0 ? count : 0,
      disposition: (text(evaluated.disposition) || 'none').toLowerCase(),
      policySpf,
      policyDkim,
      headerFrom: text(identifiers.header_from) || 'unknown',
      authSpf: describeAuth(spfEntries),
      authDkim: describeAuth(dkimEntries),
      verdict: verdictFor(policySpf, policyDkim),
    };
  });

  const begin = num(range.begin);
  const end = num(range.end);

  return {
    file: file.name,
    orgName: text(metadata.org_name) || 'unknown reporter',
    orgEmail: text(metadata.email),
    reportId: text(metadata.report_id),
    begin,
    end,
    domain: text(policy.domain) || 'unknown',
    p: (text(policy.p) || 'none').toLowerCase(),
    sp: text(policy.sp).toLowerCase(),
    adkim: text(policy.adkim).toLowerCase(),
    aspf: text(policy.aspf).toLowerCase(),
    pct: text(policy.pct),
    records,
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function isoOrUnknown(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toISOString().replace('.000Z', 'Z');
}

const POLICY_ENGLISH: Record<string, string> = {
  none: 'p=none: failures are only reported, not blocked',
  quarantine: 'p=quarantine: failing mail is asked to go to the spam folder',
  reject: 'p=reject: failing mail is asked to be refused outright',
};

const ALIGNMENT_ENGLISH: Record<string, string> = {
  r: 'relaxed (subdomains count as aligned)',
  s: 'strict (the domain must match exactly)',
};

function policyLine(report: DmarcReport): string {
  return POLICY_ENGLISH[report.p] ?? `p=${report.p}: unrecognized policy value`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

interface TableColumn {
  header: string;
  align?: 'right';
  cells: string[];
}

function renderTable(columns: TableColumn[]): string[] {
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...col.cells.map((c) => c.length), 1),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) =>
        columns[i]!.align === 'right' ? padStart(cell, widths[i]!) : pad(cell, widths[i]!),
      )
      .join('  ')
      .trimEnd();

  const rowCount = columns[0]?.cells.length ?? 0;
  const out = [line(columns.map((c) => c.header))];
  out.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (let i = 0; i < rowCount; i++) {
    out.push(line(columns.map((c) => c.cells[i] ?? '')));
  }
  return out;
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0.0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

interface SourceGroup {
  sourceIp: string;
  count: number;
  dispositions: Set<string>;
  spfResults: Set<string>;
  dkimResults: Set<string>;
  verdicts: Set<Verdict>;
}

function groupRecords(records: DmarcRecord[], groupBySource: boolean): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  records.forEach((record, index) => {
    const key = groupBySource ? record.sourceIp : `${record.sourceIp}#${index}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        sourceIp: record.sourceIp,
        count: 0,
        dispositions: new Set(),
        spfResults: new Set(),
        dkimResults: new Set(),
        verdicts: new Set(),
      };
      groups.set(key, group);
    }
    group.count += record.count;
    group.dispositions.add(record.disposition);
    group.spfResults.add(record.policySpf);
    group.dkimResults.add(record.policyDkim);
    group.verdicts.add(record.verdict);
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || a.sourceIp.localeCompare(b.sourceIp));
}

function joinSet(values: Set<string>): string {
  return [...values].sort().join(' / ');
}

export function run(input: Uint8Array | string, opts: DmarcOpts): string {
  const view = opts?.view === 'full' ? 'full' : 'summary';
  const groupBySource = opts?.groupBySource !== false;

  const files = extractXmlFiles(input);
  const reports = files.map(parseReport);

  const allRecords = reports.flatMap((r) => r.records);
  const totalMessages = allRecords.reduce((sum, r) => sum + r.count, 0);
  const passMessages = allRecords
    .filter((r) => r.verdict === 'aligned pass')
    .reduce((sum, r) => sum + r.count, 0);
  const bothFailMessages = allRecords
    .filter((r) => r.verdict === 'likely spoofing (both fail)')
    .reduce((sum, r) => sum + r.count, 0);
  const forwarderMessages = allRecords
    .filter((r) => r.verdict === 'forwarder (SPF fail, DKIM pass)')
    .reduce((sum, r) => sum + r.count, 0);
  const spfOnlyMessages = allRecords
    .filter((r) => r.verdict === 'SPF-only pass (alignment risk)')
    .reduce((sum, r) => sum + r.count, 0);

  const lines: string[] = [];
  const first = reports[0]!;

  lines.push('DMARC AGGREGATE REPORT');
  lines.push('');

  if (reports.length > 1) {
    lines.push(`Files: ${reports.length} XML reports in this archive`);
    for (const report of reports) {
      const messages = report.records.reduce((sum, r) => sum + r.count, 0);
      lines.push(
        `  ${report.file}: ${report.orgName}, ${report.domain}, ${isoOrUnknown(report.begin)} to ${isoOrUnknown(report.end)}, ${messages} messages`,
      );
    }
    lines.push('');
  }

  const reporters = [...new Set(reports.map((r) => r.orgName))].join(', ');
  const domains = [...new Set(reports.map((r) => r.domain))].join(', ');
  lines.push(`Reporter:    ${reporters}`);
  if (first.orgEmail) lines.push(`Contact:     ${first.orgEmail}`);
  lines.push(`Domain:      ${domains}`);
  const beginAll = Math.min(...reports.map((r) => r.begin).filter((n) => Number.isFinite(n)));
  const endAll = Math.max(...reports.map((r) => r.end).filter((n) => Number.isFinite(n)));
  lines.push(`Date range:  ${isoOrUnknown(beginAll)} to ${isoOrUnknown(endAll)}`);
  lines.push('');

  lines.push('PUBLISHED POLICY');
  lines.push(`  ${policyLine(first)}`);
  if (first.sp) {
    const spEnglish = POLICY_ENGLISH[first.sp];
    lines.push(`  sp=${first.sp}: ${spEnglish ? spEnglish.split(': ')[1] : 'subdomain policy'} (subdomains)`);
  }
  if (first.pct && first.pct !== '100') {
    lines.push(`  pct=${first.pct}: the policy is applied to ${first.pct}% of failing mail`);
  }
  if (first.adkim) {
    lines.push(`  adkim=${first.adkim}: DKIM alignment is ${ALIGNMENT_ENGLISH[first.adkim] ?? 'unrecognized'}`);
  }
  if (first.aspf) {
    lines.push(`  aspf=${first.aspf}: SPF alignment is ${ALIGNMENT_ENGLISH[first.aspf] ?? 'unrecognized'}`);
  }
  lines.push('');

  lines.push('TOTALS');
  const totalRows: [string, number][] = [
    ['Messages', totalMessages],
    ['Aligned pass (SPF and DKIM)', passMessages],
    ['Both fail (likely spoofing)', bothFailMessages],
    ['Forwarder pattern (DKIM only)', forwarderMessages],
    ['SPF only (alignment risk)', spfOnlyMessages],
  ];
  const labelWidth = Math.max(...totalRows.map(([label]) => label.length)) + 1;
  for (const [label, value] of totalRows) {
    const share = label === 'Messages' ? '' : ` (${percent(value, totalMessages)})`;
    lines.push(`  ${pad(`${label}:`, labelWidth)} ${value}${share}`);
  }
  lines.push('');

  const groups = groupRecords(allRecords, groupBySource);
  lines.push(groupBySource ? 'SOURCES (grouped by IP, most mail first)' : 'RECORDS (most mail first)');
  lines.push(
    ...renderTable([
      { header: 'Source IP', cells: groups.map((g) => g.sourceIp) },
      { header: 'Messages', align: 'right', cells: groups.map((g) => String(g.count)) },
      { header: 'Disposition', cells: groups.map((g) => joinSet(g.dispositions)) },
      { header: 'SPF', cells: groups.map((g) => joinSet(g.spfResults)) },
      { header: 'DKIM', cells: groups.map((g) => joinSet(g.dkimResults)) },
      { header: 'Verdict', cells: groups.map((g) => [...g.verdicts].join(' / ')) },
    ]),
  );
  lines.push('');
  lines.push(
    'SPF and DKIM above are the DMARC aligned results, not the raw authentication results.',
  );
  lines.push(
    'Source IPs are shown as they appear in the report. Reverse DNS and ownership lookups need a network query, so run those separately if you want to name a sender.',
  );
  lines.push('');

  if (view === 'full') {
    lines.push('EVERY RECORD');
    lines.push(
      ...renderTable([
        { header: 'Source IP', cells: allRecords.map((r) => r.sourceIp) },
        { header: 'Messages', align: 'right', cells: allRecords.map((r) => String(r.count)) },
        { header: 'Header From', cells: allRecords.map((r) => r.headerFrom) },
        { header: 'Disposition', cells: allRecords.map((r) => r.disposition) },
        { header: 'SPF', cells: allRecords.map((r) => r.policySpf) },
        { header: 'DKIM', cells: allRecords.map((r) => r.policyDkim) },
        { header: 'Auth SPF', cells: allRecords.map((r) => r.authSpf) },
        { header: 'Auth DKIM', cells: allRecords.map((r) => r.authDkim) },
        { header: 'Verdict', cells: allRecords.map((r) => r.verdict) },
      ]),
    );
    lines.push('');
  }

  lines.push('WHAT TO DO NEXT');
  const hints: string[] = [];
  const bothFailShare = totalMessages === 0 ? 0 : bothFailMessages / totalMessages;
  const passShare = totalMessages === 0 ? 0 : passMessages / totalMessages;

  if (bothFailShare > 0.05) {
    const suspects = groups
      .filter((g) => g.verdicts.has('likely spoofing (both fail)'))
      .slice(0, 5)
      .map((g) => g.sourceIp)
      .join(', ');
    const lead = `${percent(bothFailMessages, totalMessages)} of this volume failed both SPF and DKIM alignment.`;
    if (first.p === 'reject') {
      hints.push(
        `${lead} The published policy is already p=reject, so these sources are being rejected. Confirm that none of them (${suspects}) are legitimate senders of yours before you treat the volume as spoofing.`,
      );
    } else if (first.p === 'quarantine') {
      hints.push(
        `${lead} Check whether those IPs (${suspects}) are one of your own senders that is not set up yet before you tighten the policy further. Moving to p=reject while a real sender is failing would get your own mail refused outright.`,
      );
    } else {
      hints.push(
        `${lead} Check whether those IPs (${suspects}) are one of your own senders that is not set up yet before you tighten the policy. Moving to p=quarantine while a real sender is failing would send your own mail to spam.`,
      );
    }
  }
  if (passShare > 0.98) {
    if (first.p === 'none') {
      hints.push(
        `${percent(passMessages, totalMessages)} of this volume is fully aligned and the policy is still p=none, so nothing is being enforced. If later reports look the same, this domain is a reasonable candidate for p=quarantine.`,
      );
    } else if (first.p === 'quarantine') {
      hints.push(
        `${percent(passMessages, totalMessages)} of this volume is fully aligned and the policy is already p=quarantine. If later reports look the same, this domain is a reasonable candidate for p=reject.`,
      );
    }
  }
  if (forwarderMessages > 0) {
    hints.push(
      'Some mail passed DKIM but failed SPF. That is the normal signature of a forwarder or a mailing list, not an attack, because forwarding rewrites the envelope sender but leaves the DKIM signature intact.',
    );
  }
  if (spfOnlyMessages > 0) {
    hints.push(
      'Some mail passed SPF but not DKIM. It still counts as a DMARC pass, but it will break the moment that mail is forwarded, so getting DKIM signing working on those senders is worth doing.',
    );
  }
  if (hints.length === 0) {
    hints.push(
      'Nothing here needs urgent action. One report covers a short window from a single mailbox provider, so read a few weeks of them before changing your policy.',
    );
  }
  for (const hint of hints) lines.push(`  ${hint}`);

  return lines.join('\n');
}

export default {
  run,
} satisfies ToolLogic<Uint8Array | string, string, DmarcOpts>;
