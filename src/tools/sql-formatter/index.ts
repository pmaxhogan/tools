import { format, type SqlLanguage } from 'sql-formatter';
import { ToolError, type ToolLogic } from '../types';

export interface SqlFormatOpts {
  /** sql-formatter "language" key: sql, postgresql, mysql, sqlite, tsql, bigquery, snowflake, mariadb, plsql. */
  dialect: string;
  keywordCase: 'upper' | 'lower' | 'preserve';
  tabWidth: number;
  linesBetweenQueries: number;
  [key: string]: unknown;
}

/** Take just the first line of sql-formatter's (often very long) parse error. */
function summarize(message: string): string {
  const firstLine = message.split('\n')[0].trim();
  return firstLine || message.trim();
}

export function run(input: string, opts: SqlFormatOpts): string {
  const raw = input ?? '';
  if (!raw.trim()) {
    throw new ToolError('empty-input', 'Enter a SQL query to format.');
  }

  const tabWidth = Number.isFinite(opts.tabWidth) ? opts.tabWidth : 2;
  const linesBetweenQueries = Number.isFinite(opts.linesBetweenQueries)
    ? opts.linesBetweenQueries
    : 1;

  try {
    return format(raw, {
      language: (opts.dialect || 'sql') as SqlLanguage,
      keywordCase: opts.keywordCase || 'upper',
      tabWidth,
      linesBetweenQueries,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ToolError(
      'invalid-sql',
      `Could not format the SQL: ${summarize(message)}`,
      'Check for unclosed quotes or a dialect mismatch, then pick the matching dialect.',
    );
  }
}

export default { run } satisfies ToolLogic<string, string, SqlFormatOpts>;
