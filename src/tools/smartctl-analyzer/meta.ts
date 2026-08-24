import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "smartctl-analyzer",
  icon: "HardDrive",
  matrixSlug: "smart",
  name: "SMART Decoder",
  description: "Paste smartctl output and get a plain-English drive health verdict.",
  category: "Homelab",
  keywords: [
    "smartctl output analyzer",
    "smart data decoder",
    "is my hard drive failing",
    "reallocated sector count meaning",
    "nvme health check",
    "current pending sector",
    "udma crc error count",
  ],
  searchTerms: [
    "hard drive health check",
    "ssd health checker",
    "smart attributes explained",
    "disk failure predictor",
    "hdd diagnostic tool",
    "smart -a decoder",
    "drive wear leveling",
    "total bytes written",
    "power on hours",
    "nvme smart log",
    "crystaldiskinfo alternative",
    "smart status pass fail",
    "backblaze drive stats",
    "hard drive about to fail",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "detail",
      label: "Detail",
      default: "verdict",
      options: [
        {
          value: "verdict",
          label: "Verdict and findings",
          synonyms: ["summary", "health verdict", "short"],
        },
        {
          value: "full",
          label: "Full attribute list",
          synonyms: ["all attributes", "detailed", "raw attributes"],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Aging drive, watch verdict",
      input:
        "smartctl 7.3 2022-02-28 r5338 [x86_64-linux-6.1.0-18-amd64] (local build)\n\n=== START OF INFORMATION SECTION ===\nModel Family:     Seagate BarraCuda 3.5\nDevice Model:     ST2000DM008-2FR102\nSerial Number:    ZFL3Q9XK\nUser Capacity:    2,000,398,934,016 bytes [2.00 TB]\nRotation Rate:    7200 rpm\nSMART support is: Enabled\n\n=== START OF READ SMART DATA SECTION ===\nSMART overall-health self-assessment test result: PASSED\n\nID# ATTRIBUTE_NAME          FLAG     VALUE WORST THRESH TYPE      UPDATED  WHEN_FAILED RAW_VALUE\n  5 Reallocated_Sector_Ct   0x0033   097   097   010    Pre-fail  Always       -       24\n  9 Power_On_Hours          0x0032   074   074   000    Old_age   Always       -       23980\n196 Reallocated_Event_Count 0x0032   097   097   000    Old_age   Always       -       9\n197 Current_Pending_Sector  0x0032   100   100   000    Old_age   Offline      -       0\n198 Offline_Uncorrectable   0x0030   100   253   000    Old_age   Offline      -       0\n199 UDMA_CRC_Error_Count    0x0032   200   200   000    Old_age   Always       -       0\n\nSMART Error Log Version: 1\nNo Errors Logged\n",
      opts: { detail: "verdict" },
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Reads the output of smartctl -a or smartctl -x and turns it into a straight answer: HEALTHY, WATCH, or FAILING, with the reasoning spelled out. It handles ATA and SATA attribute tables in both the standard and the brief column layouts, and NVMe health logs. Every critical attribute that is off its healthy reading gets a plain-English line, so you learn what reallocated sectors, pending sectors, CRC errors, and NVMe critical warnings actually mean. It also works out power on time in years, SSD wear, and total terabytes written.",
    how: 'Run smartctl -a /dev/sda (or smartctl -a /dev/nvme0) as root, copy the whole output, and paste it in. Leave Detail on "Verdict and findings" for the summary, or switch to "Full attribute list" to see every attribute the drive reported with an explanation of each one. Re-run the check every few weeks and compare, because a single snapshot cannot show whether a count is growing.',
    why: "The usual routine is posting a screenshot to a forum and waiting a day for someone to tell you whether 8 reallocated sectors matter. Vendor tools go the other way and hide the raw values behind a green tick. This page explains every attribute, tells you when a scary looking number is really a loose SATA cable, and does it in your browser: only the text report you paste is read, and your files and inputs never leave your device.",
    faq: [
      {
        q: "Which SMART attributes actually predict failure?",
        a: "The ones worth acting on are 5 Reallocated_Sector_Ct, 187 Reported_Uncorrect, 188 Command_Timeout, 197 Current_Pending_Sector, and 198 Offline_Uncorrectable. On NVMe it is the critical warning bitmask, media and data integrity errors, and available spare falling to its threshold. Most other attributes are workload counters or vendor scaled numbers that mean nothing in isolation.",
      },
      {
        q: "What does one reallocated sector mean?",
        a: "One sector went bad and the drive quietly swapped in a spare. A count of 1 that never changes is not a reason to replace a drive, and plenty of drives run for years like that. What matters is the trend: check again in a week, and if the number is climbing, move your data off and replace the drive. Pending sectors (attribute 197) are different, because those are unreadable right now.",
      },
      {
        q: "Is my drive data uploaded anywhere?",
        a: "No. Only the text report you paste is read, and your files and inputs never leave your device. The decoding runs in your browser, and the page keeps working offline after the first load. Serial numbers stay in the text you pasted, so nothing identifying is sent anywhere.",
      },
    ],
  },
};
