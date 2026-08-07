import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'snowflake-decoder',
  matrixSlug: 'snowflake',
  name: 'Snowflake Decoder',
  description: 'Pull timestamps and worker IDs out of snowflake IDs.',
  category: 'Dev',
  keywords: [
    'snowflake id decoder',
    'discord snowflake',
    'twitter snowflake id',
    'instagram id decoder',
    'snowflake timestamp',
    'discord id to date',
  ],
  input: 'text/plain',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'platform',
      label: 'Platform',
      default: 'discord',
      choices: [
        { value: 'discord', label: 'Discord' },
        { value: 'twitter', label: 'Twitter / X' },
        { value: 'instagram', label: 'Instagram' },
      ],
    },
  ],
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Decodes a snowflake ID (Discord, Twitter/X, or Instagram) into its embedded creation timestamp and the worker/shard/sequence bits packed alongside it. Snowflake IDs encode a millisecond timestamp plus machine and sequence counters into a single 64-bit integer, and this pulls those fields back apart.',
    how: 'Paste a numeric snowflake ID — a Discord message or user ID, a Twitter/X tweet ID, or an Instagram media ID — and pick the platform it came from. You get the exact UTC creation time, the raw component IDs, and a human-readable age.',
    why: 'Most snowflake decoders online only support one platform and bury the result behind ads. This one covers all three common formats, runs entirely client-side, and flags the result when the decoded date looks implausible for the platform you picked (a sign you chose the wrong one).',
    faq: [
      {
        q: 'What platforms are supported?',
        a: 'Discord, Twitter/X, and Instagram — each uses a slightly different bit layout and epoch, and this picks the right one for you.',
      },
      {
        q: 'Can I decode a Discord user or channel ID, not just a message ID?',
        a: 'Yes. All Discord snowflakes — users, channels, messages, guilds — share the same format and epoch, so any of them decodes correctly.',
      },
      {
        q: 'Why does it say the platform might be wrong?',
        a: 'If the decoded timestamp falls before that platform existed or implausibly far in the future, the ID probably came from a different platform or was entered incorrectly.',
      },
    ],
  },
};
