import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "raidz-calculator",
  matrixSlug: "raidz",
  icon: "HardDrive",
  name: "RAIDZ Calculator",
  description:
    "Calculate usable capacity, parity overhead, and fault tolerance for a ZFS RAIDZ, mirror, or stripe pool layout.",
  category: "Homelab",
  keywords: [
    "raidz calculator",
    "zfs capacity calculator",
    "raidz2 usable space",
    "zfs parity overhead",
    "raid calculator zfs",
    "zpool size estimate",
  ],
  searchTerms: [
    "zfs pool sizing",
    "raidz1 vs raidz2 vs raidz3",
    "truenas capacity planning",
    "proxmox zfs pool size",
    "vdev usable capacity",
    "zfs mirror vs raidz",
    "disks per vdev calculator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    { kind: "number", id: "disks", label: "Disks per vdev", default: 6, min: 1, max: 60 },
    {
      kind: "select",
      id: "diskSizeUnit",
      label: "Disk size unit",
      default: "TB",
      options: [
        {
          value: "TB",
          label: "TB (decimal)",
          synonyms: ["terabyte", "decimal terabyte", "drive label size"],
        },
        { value: "GB", label: "GB (decimal)", synonyms: ["gigabyte", "decimal gigabyte"] },
        {
          value: "TiB",
          label: "TiB (binary)",
          synonyms: ["tebibyte", "binary terabyte", "os reported size"],
        },
        { value: "GiB", label: "GiB (binary)", synonyms: ["gibibyte", "binary gigabyte"] },
      ],
    },
    { kind: "number", id: "diskSize", label: "Size of each disk", default: 4, min: 0.1, step: 0.5 },
    {
      kind: "select",
      id: "level",
      label: "RAIDZ level",
      default: "raidz1",
      options: [
        {
          value: "raidz1",
          label: "RAIDZ1 (1 parity disk)",
          synonyms: ["raid5", "z1", "single parity"],
        },
        {
          value: "raidz2",
          label: "RAIDZ2 (2 parity disks)",
          synonyms: ["raid6", "z2", "double parity"],
        },
        { value: "raidz3", label: "RAIDZ3 (3 parity disks)", synonyms: ["z3", "triple parity"] },
        {
          value: "mirror",
          label: "Mirror (n-way)",
          synonyms: ["raid1", "raid10", "mirrored vdev"],
        },
        {
          value: "stripe",
          label: "Stripe (no redundancy)",
          synonyms: ["raid0", "no parity", "no redundancy"],
        },
      ],
    },
    { kind: "number", id: "vdevs", label: "Number of vdevs", default: 1, min: 1, max: 64 },
    {
      kind: "boolean",
      id: "zfsOverhead",
      label: "Subtract ZFS overhead (padding and reservation)",
      default: true,
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Computes usable capacity, parity overhead, storage efficiency, and fault tolerance for a ZFS pool built from one or more RAIDZ1, RAIDZ2, RAIDZ3, mirror, or stripe vdevs. Handles both decimal (TB, GB) and binary (TiB, GiB) disk sizes so you can match the units your drives or your OS actually report.",
    how: 'Set the disks per vdev, the size and unit of each disk, the RAIDZ level, and how many identical vdevs the pool stripes together. Toggle the ZFS overhead estimate on or off to see the difference. You can also type a shorthand like "6x4TB raidz2" into the input field instead of using the options.',
    why: "Generic RAID calculators treat every array the same and ignore how ZFS actually reports capacity, so their numbers rarely match what zpool list shows. This one is upfront that the overhead figure is an approximation, since real usable space also depends on ashift, recordsize, and RAIDZ padding, none of which this calculator can see without your actual pool.",
    faq: [
      {
        q: "Why is my real usable space lower than what this shows?",
        a: "ZFS reserves slop space, spends metadata on padding, and its effective block size interacts with ashift and recordsize in ways a generic calculator cannot model. Treat this tool's number as a close estimate, not the exact figure zpool will report.",
      },
      {
        q: "Should I use raidz1 or raidz2?",
        a: "raidz1 tolerates one disk failure per vdev and wastes the least capacity, but on large drives a second failure or an unreadable sector during a long resilver can lose the vdev. raidz2 tolerates two failures per vdev and is the common recommendation once drives exceed a few terabytes.",
      },
      {
        q: "Does this match what zpool list or zfs list shows?",
        a: "It should be close, but not exact. ZFS capacity reporting has changed across OpenZFS versions and depends on ashift, recordsize, compression, and pool history, none of which this calculator has access to.",
      },
    ],
  },
};
