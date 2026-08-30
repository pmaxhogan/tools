import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "torrent-file-inspector",
  icon: "Waypoints",
  name: "Torrent File Inspector",
  description: "Decode a .torrent file's trackers, file list and info hash.",
  category: "Files",
  keywords: [
    "torrent file inspector",
    "read torrent file",
    "torrent info hash",
    "torrent to magnet link",
    "what is inside a torrent file",
    "torrent file list viewer",
    "bencode decoder",
    "torrent tracker list",
  ],
  searchTerms: [
    "open torrent file",
    "torrent metadata viewer",
    "btih",
    "magnet link generator",
    "bencode parser",
    "torrent hash checker",
    "piece length",
    "announce list",
    "bittorrent v2",
    "bep 52",
    "torrent contents without downloading",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "View",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary",
          synonyms: ["overview", "everything", "details", "metadata", "all fields"],
        },
        {
          value: "files",
          label: "File list",
          synonyms: ["files", "contents", "what is inside", "paths", "listing"],
        },
        {
          value: "magnet",
          label: "Magnet link",
          synonyms: ["magnet", "magnet uri", "btih", "info hash", "share link"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "allFiles",
      label: "List every file instead of the first 200",
      default: false,
    },
  ],
  examples: [{ label: "Three file sample torrent", file: "sample.torrent" }],
  copy: {
    what: "Decodes a .torrent file and shows what it actually describes: the torrent name, every file and its size, the piece length and piece count, the full tracker list flattened from announce and announce-list, the creation date, comment and creating client, the private flag, and the info hash as both hex and base32. It builds the matching magnet link for you, reads BitTorrent v2 and hybrid torrents as well as classic v1 ones, and never touches a tracker or a peer.",
    how: "Drop a .torrent file onto the panel or pick one with the file button. The View option switches between the full summary, just the file list, and just the magnet link, and a toggle lifts the 200 entry cap on the file list for torrents that hold thousands of files. Every row has its own copy button, so the info hash or the magnet link is one click away.",
    why: "The usual way to see inside a .torrent is to add it to a client, which announces you to the tracker and the DHT before you have decided you want it. This reads the file locally instead: your files and inputs never leave your device, nothing is announced, and no swarm learns your IP address. The info hash is computed over the file's own info dictionary bytes, so it matches what a client would compute rather than a re-encoded approximation.",
    faq: [
      {
        q: "What is the info hash and why does it matter?",
        a: "It is the SHA-1 of the bencoded info dictionary inside the file, and it is the torrent's identity: trackers and the DHT key the swarm on it. This tool hashes the original bytes from your file rather than re-encoding the dictionary first, because a re-encoder that sorted keys differently would produce a hash that matches no swarm.",
      },
      {
        q: "Does opening a torrent here connect me to the swarm?",
        a: "No. Nothing is announced, no tracker is contacted, and no peer is dialed. The file is decoded in your browser tab, so reading a torrent here is as private as opening it in a hex editor.",
      },
      {
        q: "Does it handle BitTorrent v2 torrents?",
        a: "Yes. A v2 torrent stores its files as a nested file tree with a meta version of 2, and this reads that tree, reports the SHA-256 info hash, and builds a btmh magnet link. A hybrid torrent is labeled as such and gets both topics in its magnet link, v1 first, so older clients can still join.",
      },
    ],
  },
};
