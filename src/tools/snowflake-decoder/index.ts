import { ToolError, type ToolLogic } from '../types';

export interface SnowflakeOpts {
  /** 'discord' | 'twitter' | 'instagram' */
  platform: string;
  [key: string]: unknown;
}

export interface SnowflakeResult {
  [label: string]: string;
}

const YEAR_2100_MS = Date.UTC(2100, 0, 1);

interface PlatformSpec {
  label: string;
  /** ms since unix epoch that this platform's own clock starts counting from. */
  epochMs: bigint;
  decode(id: bigint): { timestampMs: bigint; fields: [string, string][] };
}

const PLATFORMS: Record<string, PlatformSpec> = {
  discord: {
    label: 'Discord',
    epochMs: 1420070400000n,
    decode(id) {
      const timestampMs = (id >> 22n) + 1420070400000n;
      const workerId = (id >> 17n) & 0x1fn;
      const processId = (id >> 12n) & 0x1fn;
      const increment = id & 0xfffn;
      return {
        timestampMs,
        fields: [
          ['Worker ID', workerId.toString()],
          ['Process ID', processId.toString()],
          ['Increment', increment.toString()],
        ],
      };
    },
  },
  twitter: {
    label: 'Twitter/X',
    epochMs: 1288834974657n,
    decode(id) {
      const timestampMs = (id >> 22n) + 1288834974657n;
      const machineId = (id >> 12n) & 0x3ffn;
      const sequence = id & 0xfffn;
      return {
        timestampMs,
        fields: [
          ['Machine ID', machineId.toString()],
          ['Sequence', sequence.toString()],
        ],
      };
    },
  },
  instagram: {
    label: 'Instagram',
    epochMs: 0n,
    decode(id) {
      const timestampMs = id >> 23n;
      const shardId = (id >> 10n) & 0x1fffn;
      const sequence = id & 0x3ffn;
      return {
        timestampMs,
        fields: [
          ['Shard ID', shardId.toString()],
          ['Sequence', sequence.toString()],
        ],
      };
    },
  },
};

/** Parse a snowflake ID: digits only (optionally BigInt-suffixed), no sign, no decimals. */
function parseId(raw: string): bigint {
  const s = raw.trim();
  if (!s) throw new ToolError('empty-input', 'Enter a snowflake ID to decode.');

  const cleaned = s.endsWith('n') ? s.slice(0, -1) : s;
  if (!/^\d+$/.test(cleaned))
    throw new ToolError(
      'not-numeric',
      `"${s}" is not a valid snowflake ID.`,
      'Snowflake IDs are positive whole numbers, e.g. 175928847299117063.'
    );

  return BigInt(cleaned);
}

function humanizeAge(ms: number): string {
  const deltaSec = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, secs] of units) {
    if (abs >= secs || unit === 'second') return rtf.format(Math.trunc(deltaSec / secs), unit);
  }
  return 'now';
}

export const run: ToolLogic<string, SnowflakeResult, SnowflakeOpts>['run'] = (input, opts) => {
  const id = parseId(input ?? '');

  const platformKey = opts.platform in PLATFORMS ? opts.platform : 'discord';
  const spec = PLATFORMS[platformKey]!;
  const { timestampMs, fields } = spec.decode(id);

  const msNumber = Number(timestampMs);
  const date = new Date(msNumber);
  if (isNaN(date.getTime()))
    throw new ToolError(
      'out-of-range',
      `The decoded timestamp is outside the representable date range.`,
      'Double-check the ID and the selected platform.'
    );

  const result: SnowflakeResult = {
    'Timestamp (UTC)': date.toISOString(),
    'Unix milliseconds': timestampMs.toString(),
  };
  for (const [label, value] of fields) result[label] = value;
  result['Age'] = humanizeAge(msNumber);

  if (timestampMs < spec.epochMs || msNumber > YEAR_2100_MS) {
    result['Warning'] =
      `This timestamp looks implausible for ${spec.label} — double-check that "${spec.label}" is the right platform for this ID.`;
  }

  return result;
};

export default { run } satisfies ToolLogic<string, SnowflakeResult, SnowflakeOpts>;
