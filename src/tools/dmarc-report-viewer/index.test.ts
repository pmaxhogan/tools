import { describe, expect, it } from 'vitest';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { run } from './index';
import { ToolError } from '../types';

/**
 * A realistic aggregate report for example.com covering 2026-08-01 to 2026-08-02.
 *
 * Three sources, hand-checked totals:
 *   203.0.113.10   120 msgs  spf=pass  dkim=pass  -> aligned pass
 *    198.51.100.7   30 msgs  spf=fail  dkim=pass  -> forwarder
 *   192.0.2.55      50 msgs  spf=fail  dkim=fail  -> likely spoofing
 * Total 200. Aligned pass 120 = 60.0%. Both fail 50 = 25.0%. Forwarder 30 = 15.0%.
 */
const THREE_SOURCE_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>1234567890123456789</report_id>
    <date_range>
      <begin>1785542400</begin>
      <end>1785628800</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.10</source_ip>
      <count>120</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>example.com</domain>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>example.com</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip>
      <count>30</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>example.com</domain>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>forwarder.example.net</domain>
        <result>fail</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>192.0.2.55</source_ip>
      <count>50</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>example.com</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>bad.example.org</domain>
        <result>fail</result>
      </dkim>
      <spf>
        <domain>bad.example.org</domain>
        <result>softfail</result>
      </spf>
    </auth_results>
  </record>
</feedback>`;

/** One record only, so fast-xml-parser hands back an object instead of an array. */
const SINGLE_RECORD_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Enterprise Outlook</org_name>
    <email>dmarcreport@microsoft.com</email>
    <date_range>
      <begin>1785542400</begin>
      <end>1785628800</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>solo.example</domain>
    <p>quarantine</p>
    <pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.99</source_ip>
      <count>7</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>solo.example</header_from>
    </identifiers>
    <auth_results>
      <dkim><domain>solo.example</domain><result>pass</result></dkim>
      <spf><domain>solo.example</domain><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;

/** Every message aligned, policy still p=none: the "ready for quarantine" case. */
const CLEAN_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Yahoo</org_name>
    <date_range><begin>1785542400</begin><end>1785628800</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>clean.example</domain>
    <p>none</p>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.1</source_ip>
      <count>500</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>clean.example</header_from></identifiers>
    <auth_results>
      <dkim><domain>clean.example</domain><result>pass</result></dkim>
      <spf><domain>clean.example</domain><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;

/** Two records sharing one source IP, used to check grouping. */
const SPLIT_SOURCE_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>AOL</org_name>
    <date_range><begin>1785542400</begin><end>1785628800</end></date_range>
  </report_metadata>
  <policy_published><domain>split.example</domain><p>none</p></policy_published>
  <record>
    <row>
      <source_ip>203.0.113.5</source_ip>
      <count>4</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>split.example</header_from></identifiers>
    <auth_results>
      <dkim><domain>split.example</domain><result>pass</result></dkim>
      <spf><domain>split.example</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>203.0.113.5</source_ip>
      <count>6</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>split.example</header_from></identifiers>
    <auth_results>
      <dkim><domain>split.example</domain><result>pass</result></dkim>
      <spf><domain>split.example</domain><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;

/** SPF passes but DKIM does not: a DMARC pass that breaks on forwarding. */
const SPF_ONLY_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<feedback>
  <report_metadata>
    <org_name>Mail.ru</org_name>
    <date_range><begin>1785542400</begin><end>1785628800</end></date_range>
  </report_metadata>
  <policy_published><domain>spfonly.example</domain><p>none</p></policy_published>
  <record>
    <row>
      <source_ip>203.0.113.77</source_ip>
      <count>9</count>
      <policy_evaluated><disposition>none</disposition><dkim>fail</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>spfonly.example</header_from></identifiers>
    <auth_results>
      <spf><domain>spfonly.example</domain><result>pass</result></spf>
    </auth_results>
  </record>
</feedback>`;

function verdictFor(report: string, ip: string): string {
  const line = report.split('\n').find((l) => l.startsWith(ip));
  if (!line) throw new Error(`no table row for ${ip}`);
  return line;
}

describe('dmarc-report-viewer', () => {
  it('parses pasted XML and reports the header, policy, and date range', () => {
    const out = run(THREE_SOURCE_REPORT, {});
    expect(out).toContain('Reporter:    google.com');
    expect(out).toContain('Domain:      example.com');
    expect(out).toContain('2026-08-01T00:00:00Z to 2026-08-02T00:00:00Z');
    expect(out).toContain('p=none: failures are only reported, not blocked');
    expect(out).toContain('adkim=r: DKIM alignment is relaxed (subdomains count as aligned)');
  });

  it('computes hand-checked totals and pass rate', () => {
    const out = run(THREE_SOURCE_REPORT, {});
    // 120 + 30 + 50 = 200 messages; 120/200 = 60.0% aligned; 50/200 = 25.0% both fail.
    expect(out).toMatch(/Messages:\s+200/);
    expect(out).toMatch(/Aligned pass \(SPF and DKIM\):\s+120 \(60\.0%\)/);
    expect(out).toMatch(/Both fail \(likely spoofing\):\s+50 \(25\.0%\)/);
    expect(out).toMatch(/Forwarder pattern \(DKIM only\):\s+30 \(15\.0%\)/);
    expect(out).toMatch(/SPF only \(alignment risk\):\s+0 \(0\.0%\)/);
  });

  it('assigns the right verdict to each source and sorts by volume', () => {
    const out = run(THREE_SOURCE_REPORT, {});
    expect(verdictFor(out, '203.0.113.10')).toContain('aligned pass');
    expect(verdictFor(out, '198.51.100.7')).toContain('forwarder (SPF fail, DKIM pass)');
    expect(verdictFor(out, '192.0.2.55')).toContain('likely spoofing (both fail)');

    const order = ['203.0.113.10', '192.0.2.55', '198.51.100.7'].map((ip) => out.indexOf(`\n${ip}`));
    expect(order[0]).toBeLessThan(order[1]!);
    expect(order[1]).toBeLessThan(order[2]!);
  });

  it('detects the SPF-only pass verdict', () => {
    const out = run(SPF_ONLY_REPORT, {});
    expect(verdictFor(out, '203.0.113.77')).toContain('SPF-only pass (alignment risk)');
    expect(out).toContain('passed SPF but not DKIM');
  });

  it('never suggests looking IPs up over the network', () => {
    const out = run(THREE_SOURCE_REPORT, {});
    expect(out).toContain('Reverse DNS and ownership lookups need a network query');
  });

  it('warns about both-fail volume above 5 percent and names the suspect IPs', () => {
    const out = run(THREE_SOURCE_REPORT, {});
    expect(out).toContain('25.0% of this volume failed both SPF and DKIM alignment');
    expect(out).toContain('192.0.2.55');
    expect(out).toContain('p=quarantine');
  });

  it('suggests quarantine when p=none and everything is aligned', () => {
    const out = run(CLEAN_REPORT, {});
    expect(out).toContain('100.0% of this volume is fully aligned');
    expect(out).toContain('reasonable candidate for p=quarantine');
    expect(out).not.toContain('failed both SPF and DKIM alignment');
  });

  it('parses a report with a single record (object, not array)', () => {
    const out = run(SINGLE_RECORD_REPORT, {});
    expect(out).toMatch(/Messages:\s+7/);
    expect(out).toContain('p=quarantine: failing mail is asked to go to the spam folder');
    expect(verdictFor(out, '203.0.113.99')).toContain('aligned pass');
  });

  it('groups records by source IP by default and splits them when told not to', () => {
    const grouped = run(SPLIT_SOURCE_REPORT, {});
    const groupedRows = grouped.split('\n').filter((l) => l.startsWith('203.0.113.5'));
    expect(groupedRows).toHaveLength(1);
    expect(groupedRows[0]).toMatch(/\s10\s/);

    const ungrouped = run(SPLIT_SOURCE_REPORT, { groupBySource: false });
    expect(ungrouped.split('\n').filter((l) => l.startsWith('203.0.113.5'))).toHaveLength(2);
    expect(ungrouped).toContain('RECORDS (most mail first)');
  });

  it('adds every record row in full view only', () => {
    const summary = run(THREE_SOURCE_REPORT, { view: 'summary' });
    expect(summary).not.toContain('EVERY RECORD');

    const full = run(THREE_SOURCE_REPORT, { view: 'full' });
    expect(full).toContain('EVERY RECORD');
    expect(full).toContain('Header From');
    expect(full).toContain('forwarder.example.net=fail');
    expect(full).toContain('bad.example.org=softfail');
  });

  it('reads a gzipped report', () => {
    const gz = gzipSync(strToU8(THREE_SOURCE_REPORT));
    expect(gz[0]).toBe(0x1f);
    const out = run(gz, {});
    expect(out).toMatch(/Messages:\s+200/);
  });

  it('reads plain UTF-8 XML bytes', () => {
    const out = run(strToU8(THREE_SOURCE_REPORT), {});
    expect(out).toContain('Domain:      example.com');
  });

  it('aggregates two reports from one zip with a per-file line', () => {
    const zip = zipSync({
      'google.com!example.com!1785542400!1785628800.xml': strToU8(THREE_SOURCE_REPORT),
      'yahoo!clean.example!1785542400!1785628800.xml': strToU8(CLEAN_REPORT),
    });
    const out = run(zip, {});
    expect(out).toContain('Files: 2 XML reports in this archive');
    expect(out).toContain('google.com!example.com!1785542400!1785628800.xml');
    expect(out).toContain('yahoo!clean.example!1785542400!1785628800.xml');
    // 200 from the first report plus 500 from the second.
    expect(out).toMatch(/Messages:\s+700/);
    expect(out).toMatch(/Aligned pass \(SPF and DKIM\):\s+620/);
  });

  it('reads a gzipped report nested inside a zip', () => {
    const zip = zipSync({ 'report.xml.gz': gzipSync(strToU8(SINGLE_RECORD_REPORT)) });
    const out = run(zip, {});
    expect(out).toMatch(/Messages:\s+7/);
  });

  it('throws on malformed XML', () => {
    expect(() => run('<feedback><record></feedback>', {})).toThrow(ToolError);
    try {
      run('<feedback><record></feedback>', {});
    } catch (err) {
      expect((err as ToolError).code).toBe('invalid-report');
      expect((err as ToolError).fix).toContain('.zip, .gz or .xml attachment');
    }
  });

  it('throws on valid XML that is not a DMARC report', () => {
    expect(() => run('<rss><channel><title>Nope</title></channel></rss>', {})).toThrow(
      /not a DMARC aggregate report/,
    );
  });

  it('throws when a DMARC report has no records', () => {
    const empty = `<feedback><report_metadata><org_name>x</org_name></report_metadata><policy_published><domain>a.example</domain></policy_published></feedback>`;
    expect(() => run(empty, {})).toThrow(/no <record> entries/);
  });

  it('throws on text that is not XML at all', () => {
    expect(() => run('just a sentence', {})).toThrow(/does not start with an XML tag/);
  });

  it('throws on empty input', () => {
    expect(() => run('', {})).toThrow(ToolError);
    expect(() => run('   ', {})).toThrow(ToolError);
    expect(() => run(new Uint8Array(0), {})).toThrow(ToolError);
    try {
      run('', {});
    } catch (err) {
      expect((err as ToolError).code).toBe('empty-input');
    }
  });

  it('throws on a zip containing no XML reports', () => {
    const zip = zipSync({ 'readme.txt': strToU8('nothing useful here') });
    expect(() => run(zip, {})).toThrow(/no XML report files/);
  });

  it('throws on truncated gzip data', () => {
    const gz = gzipSync(strToU8(THREE_SOURCE_REPORT));
    expect(() => run(gz.slice(0, 12), {})).toThrow(ToolError);
  });

  it('throws on bytes that are not valid UTF-8', () => {
    expect(() => run(Uint8Array.from([0xc3, 0x28, 0xa0, 0xa1]), {})).toThrow(/not valid UTF-8/);
  });

  it('uses no em dashes or en dashes in the report prose', () => {
    const out = run(THREE_SOURCE_REPORT, { view: 'full' });
    expect(out).not.toMatch(/[–—]/);
  });
});
