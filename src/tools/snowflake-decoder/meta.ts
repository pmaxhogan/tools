import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "snowflake-decoder",
  icon: "Snowflake",
  matrixSlug: "snowflake",
  name: "Snowflake Decoder",
  description:
    "Pull timestamps and worker IDs out of snowflake IDs, Discord links, or a whole batch of them at once.",
  category: "Dev",
  keywords: [
    "snowflake id decoder",
    "discord snowflake",
    "twitter snowflake id",
    "instagram id decoder",
    "snowflake timestamp",
    "discord id to date",
  ],
  searchTerms: [
    "discord id",
    "snowflake url",
    "message id",
    "decode discord timestamp",
    "discord message link",
    "discord url decoder",
    "batch snowflake decoder",
    "twitter id decoder",
    "x post id timestamp",
    "instagram id timestamp",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "platform",
      label: "Platform",
      default: "discord",
      choices: [
        { value: "discord", label: "Discord" },
        { value: "twitter", label: "Twitter / X" },
        { value: "instagram", label: "Instagram" },
      ],
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Decodes a snowflake ID (Discord, Twitter/X, or Instagram) into its embedded creation timestamp and the worker/shard/sequence bits packed alongside it. Snowflake IDs encode a millisecond timestamp plus machine and sequence counters into a single 64-bit integer, and this pulls those fields back apart. It also reads IDs straight out of a URL, so a full Discord message link or user link works without editing it down to the bare number first.",
    how: "Paste a numeric snowflake ID, or a URL that contains one, and pick the platform it came from. A Discord message link (discord.com/channels/guild/channel/message) decodes the guild, channel, and message IDs together; a Discord user link decodes the user ID; any other URL with a long numeric ID in it gets scanned for one too. Put more than one entry on its own line to decode a whole batch at once. You get the exact UTC creation time, the raw component IDs, and a human-readable age for each.",
    why: "Most snowflake decoders online only support one platform, only take a bare number, and bury the result behind ads. This one covers all three common formats, understands the URLs those IDs actually show up in, decodes a pasted list of them in one pass, runs entirely client-side, and flags the result when the decoded date looks implausible for the platform you picked (a sign you chose the wrong one).",
    faq: [
      {
        q: "What platforms are supported?",
        a: "Discord, Twitter/X, and Instagram: each uses a slightly different bit layout and epoch, and this picks the right one for you.",
      },
      {
        q: "Can I paste a Discord link instead of the raw ID?",
        a: "Yes. Paste a discord.com/channels/... message link or a discord.com/users/... link and the tool pulls out the guild, channel, message, or user ID and decodes it, no need to copy just the number first.",
      },
      {
        q: "Can I decode several IDs at once?",
        a: "Yes. Put each snowflake ID or URL on its own line and every one decodes together, mixing bare IDs and links freely in the same batch.",
      },
    ],
  },
};
