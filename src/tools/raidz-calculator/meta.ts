import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "raidz-calculator",
  matrixSlug: "raidz",
  icon: "HardDrive",
  name: "RAIDZ Calculator",
  description:
    "Calculate usable capacity, parity overhead, fault tolerance, and mean time to data loss for a ZFS RAIDZ, dRAID, mirror, or stripe pool.",
  category: "Homelab",
  keywords: [
    "raidz calculator",
    "zfs capacity calculator",
    "raidz2 usable space",
    "zfs parity overhead",
    "raid calculator zfs",
    "zpool size estimate",
    "draid calculator",
    "zfs mttdl calculator",
  ],
  searchTerms: [
    "zfs pool sizing",
    "raidz1 vs raidz2 vs raidz3",
    "truenas capacity planning",
    "proxmox zfs pool size",
    "vdev usable capacity",
    "zfs mirror vs raidz",
    "disks per vdev calculator",
    "zfs hot spare",
    "draid distributed spare",
    "mean time to data loss",
    "annualized failure rate afr",
    "zfs drive failure simulator",
    "nas capacity planning",
    "zfs pool calculator online",
    "how many drives can fail",
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
      groups: [
        {
          label: "RAIDZ (parity per vdev)",
          synonyms: ["raidz", "parity", "raid5", "raid6", "single vdev parity"],
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
            {
              value: "raidz3",
              label: "RAIDZ3 (3 parity disks)",
              synonyms: ["z3", "triple parity"],
            },
          ],
        },
        {
          label: "dRAID (distributed parity and spares)",
          synonyms: [
            "draid",
            "distributed raid",
            "distributed spare",
            "sequential resilver",
            "fast rebuild",
          ],
          options: [
            {
              value: "draid1",
              label: "dRAID1 (1 parity disk)",
              synonyms: ["draid 1", "distributed raidz1", "single parity draid"],
            },
            {
              value: "draid2",
              label: "dRAID2 (2 parity disks)",
              synonyms: ["draid 2", "distributed raidz2", "double parity draid"],
            },
            {
              value: "draid3",
              label: "dRAID3 (3 parity disks)",
              synonyms: ["draid 3", "distributed raidz3", "triple parity draid"],
            },
          ],
        },
        {
          label: "Mirror and stripe",
          synonyms: ["raid1", "raid10", "raid0", "no parity", "mirrored"],
          options: [
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
      ],
    },
    { kind: "number", id: "vdevs", label: "Number of vdevs", default: 1, min: 1, max: 64 },
    {
      kind: "boolean",
      id: "zfsOverhead",
      label: "Subtract ZFS overhead (padding and reservation)",
      default: true,
    },
    {
      kind: "number",
      id: "osReservePercent",
      label: "OS and filesystem reserve (percent)",
      default: 0,
      min: 0,
      max: 50,
      step: 1,
    },
    {
      kind: "number",
      id: "hotSpares",
      label: "Spare drives (hot spares, or dRAID distributed spares per vdev)",
      default: 0,
      min: 0,
      max: 16,
    },
    {
      kind: "number",
      id: "mtbfHours",
      label: "Drive MTBF (hours)",
      default: 1200000,
      min: 0,
      step: 100000,
    },
    {
      kind: "number",
      id: "afrPercent",
      label: "Drive AFR (percent, 0 to use the MTBF instead)",
      default: 0,
      min: 0,
      max: 20,
      step: 0.1,
    },
    {
      kind: "number",
      id: "resilverHours",
      label: "Resilver time (hours)",
      default: 24,
      min: 0,
      max: 2000,
    },
  ],
  inputOptional: {
    label: "Quick entry",
    hint: 'Optional. Type a shorthand like "6x4TB raidz2" to set the disks per vdev, the disk size, and the RAIDZ level in one line, overriding those options above. The vdev count and the ZFS overhead switch still come from the options.',
  },
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Computes usable capacity, parity overhead, storage efficiency, and fault tolerance for a ZFS pool built from RAIDZ1, RAIDZ2, RAIDZ3, dRAID, mirror, or stripe vdevs, with hot spares and dRAID distributed spares included. It splits the pool into slices that add up to every drive you bought: usable space, parity, the ZFS slop and metadata reservation, an optional OS reserve, and spare capacity, which is what the capacity pie draws. It also estimates mean time to data loss from a drive MTBF or annualized failure rate plus your resilver time, and it can simulate individual drive failures so you can see which vdev degrades and where the pool loses data. Decimal (TB, GB) and binary (TiB, GiB) disk sizes are both handled, so you can match the units your drives or your OS actually report.",
    how: 'Set the disks per vdev, the size and unit of each disk, the level, and how many identical vdevs the pool stripes together. Toggle the ZFS overhead estimate, add an OS reserve percent, and add spare drives to watch each one move the capacity pie. For the reliability rows, enter a drive MTBF in hours or an annualized failure rate, plus how long a resilver takes; click a drive in the pool diagram to fail it and the health propagates from drive to vdev to pool. You can still type a shorthand like "6x4TB raidz2" instead of setting the first few options by hand.',
    why: "Generic RAID calculators treat every array the same, ignore how ZFS reports capacity, and stop at a single usable number, so they cannot tell you whether raidz2 with a hot spare beats raidz3 without one. This one shows the whole breakdown, models dRAID distributed spares, and puts a mean time to data loss estimate next to the capacity so the tradeoff is visible in one place. It is also upfront about its limits: the overhead figure is an approximation, unrecoverable read errors are ignored, and the reliability math assumes drives fail independently at a constant rate.",
    faq: [
      {
        q: "Why is my real usable space lower than what this shows?",
        a: "ZFS reserves slop space, spends metadata on padding, and its effective block size interacts with ashift and recordsize in ways a generic calculator cannot model. Capacity reporting has also changed across OpenZFS versions and depends on compression and pool history. Treat this tool's number as a close estimate, not the exact figure zpool list will print.",
      },
      {
        q: "Should I use raidz1, raidz2, or dRAID?",
        a: "raidz1 tolerates one disk failure per vdev and wastes the least capacity, but on large drives a second failure during a long resilver can lose the vdev. raidz2 tolerates two failures per vdev and is the common recommendation once drives pass a few terabytes. dRAID trades a little capacity for distributed spare space, which lets a rebuild start with no human involved and finish far faster, so it earns its keep on wide vdevs with many drives.",
      },
      {
        q: "What does the MTTDL number actually mean?",
        a: "It is the standard Markov approximation: given a per drive MTBF (or an annualized failure rate, converted with MTBF = 8766 / ln(1 / (1 - AFR))) and how long a repair takes, it estimates the average time until a vdev loses more drives than its parity covers. Use it to compare layouts, not to predict a date. It ignores unrecoverable read errors, assumes drives fail independently at a constant rate, and treats spares as removing the wait for a human rather than adding tolerance. For realistic inputs, Backblaze publishes fleet-wide annualized failure rates and the drive vendors publish lab MTBF ratings on their datasheets.",
      },
    ],
  },
};
