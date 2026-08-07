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

/* ------------------------------------------------------------------ */
/* extracting snowflake IDs out of a line of input                    */
/* ------------------------------------------------------------------ */

interface ExtractedId {
  id: bigint;
  /** What this ID represents, e.g. "Message ID", "Snowflake ID". */
  label: string;
}

/** A run of 17-20 digits not touching another digit on either side. */
const SNOWFLAKE_RUN = /(?<!\d)\d{17,20}(?!\d)/g;
const DISCORD_HOST = /discord(?:app)?\.com/i;

/**
 * Discord channel and user URLs carry more than one meaningful ID in a
 * predictable shape, so pulling them apart by position gives much better
 * labels than the generic fallback: "Message ID" beats "Snowflake ID #3".
 */
function extractDiscordIds(entry: string): ExtractedId[] | null {
  if (!DISCORD_HOST.test(entry)) return null;

  // https://discord.com/channels/<guild|@me>/<channel>[/<message>]
  const channels = entry.match(
    /discord(?:app)?\.com\/channels\/(@me|\d{17,20})\/(\d{17,20})(?:\/(\d{17,20}))?/i,
  );
  if (channels) {
    const [, guildOrMe, channelId, messageId] = channels;
    const out: ExtractedId[] = [];
    if (guildOrMe !== '@me') out.push({ id: BigInt(guildOrMe!), label: 'Guild ID' });
    out.push({ id: BigInt(channelId!), label: 'Channel ID' });
    if (messageId) out.push({ id: BigInt(messageId), label: 'Message ID' });
    return out;
  }

  // https://discord.com/users/<id>
  const user = entry.match(/discord(?:app)?\.com\/users\/(\d{17,20})/i);
  if (user) return [{ id: BigInt(user[1]!), label: 'User ID' }];

  return null;
}

/**
 * Pull every snowflake out of one line of input: a bare ID, a recognized
 * Discord URL, or any other URL (or text) that happens to contain one or
 * more 17-20 digit numbers. Returns an empty array when nothing is found.
 */
function extractIds(entry: string): ExtractedId[] {
  const discordIds = extractDiscordIds(entry);
  if (discordIds && discordIds.length > 0) return discordIds;

  const matches = [...entry.matchAll(SNOWFLAKE_RUN)].map((m) => m[0]);
  const unique = [...new Set(matches)];
  if (unique.length === 0) return [];
  if (unique.length === 1) return [{ id: BigInt(unique[0]!), label: 'Snowflake ID' }];
  return unique.map((raw, i) => ({ id: BigInt(raw), label: `Snowflake ID #${i + 1}` }));
}

/* ------------------------------------------------------------------ */
/* decoding one already-extracted ID                                  */
/* ------------------------------------------------------------------ */

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

/** Decode one snowflake into its labeled fields, under the chosen platform. */
function decodeOne(id: bigint, spec: PlatformSpec): Record<string, string> {
  const { timestampMs, fields } = spec.decode(id);

  const msNumber = Number(timestampMs);
  const date = new Date(msNumber);
  if (isNaN(date.getTime()))
    throw new ToolError(
      'out-of-range',
      `The decoded timestamp is outside the representable date range.`,
      'Double-check the ID and the selected platform.',
    );

  const result: Record<string, string> = {
    'Timestamp (UTC)': date.toISOString(),
    'Unix milliseconds': timestampMs.toString(),
  };
  for (const [label, value] of fields) result[label] = value;
  result['Age'] = humanizeAge(msNumber);

  if (timestampMs < spec.epochMs || msNumber > YEAR_2100_MS) {
    result['Warning'] =
      `This timestamp looks implausible for ${spec.label}: double-check that "${spec.label}" is the right platform for this ID.`;
  }

  return result;
}

/** One decoded ID, formatted as a small indented text block. */
function formatIdBlock(extracted: ExtractedId, spec: PlatformSpec): string {
  try {
    const fields = decodeOne(extracted.id, spec);
    const fieldLines = Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`);
    return [`${extracted.label}: ${extracted.id.toString()}`, ...fieldLines].join('\n');
  } catch (e) {
    const message = e instanceof ToolError ? e.message : String(e);
    return `${extracted.label}: ${extracted.id.toString()}\n  Error: ${message}`;
  }
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

export function run(input: string, opts: SnowflakeOpts): SnowflakeResult {
  const lines = (input ?? '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  if (lines.length === 0)
    throw new ToolError(
      'empty-input',
      'Enter a snowflake ID, or paste a URL containing one, to decode.',
    );

  const platformKey = opts.platform in PLATFORMS ? opts.platform : 'discord';
  const spec = PLATFORMS[platformKey]!;

  const outcomes = lines.map((line) => ({ line, ids: extractIds(line) }));
  const totalIds = outcomes.reduce((sum, o) => sum + o.ids.length, 0);

  if (totalIds === 0)
    throw new ToolError(
      'no-snowflake-found',
      lines.length === 1
        ? `"${lines[0]}" does not contain a snowflake ID.`
        : 'None of the lines contain a snowflake ID.',
      'Paste a bare snowflake ID (17-20 digits), a Discord message, user or channel URL, or any URL that contains a 17-20 digit ID. Put one entry per line to decode several at once.',
    );

  // The common case, one line holding exactly one ID, keeps the classic flat
  // shape: labeled rows for that single decode, nothing wrapping it.
  if (outcomes.length === 1 && outcomes[0]!.ids.length === 1) {
    return decodeOne(outcomes[0]!.ids[0]!.id, spec);
  }

  const result: SnowflakeResult = {};
  const usedKeys = new Set<string>();
  for (const { line, ids } of outcomes) {
    let key = line;
    let suffix = 2;
    while (usedKeys.has(key)) {
      key = `${line} (#${suffix})`;
      suffix += 1;
    }
    usedKeys.add(key);

    result[key] =
      ids.length === 0
        ? 'No snowflake ID found in this line.'
        : ids.map((extracted) => formatIdBlock(extracted, spec)).join('\n\n');
  }

  return result;
}

export default { run } satisfies ToolLogic<string, SnowflakeResult, SnowflakeOpts>;
