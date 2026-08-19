import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "subnet-calculator",
  matrixSlug: "cidr",
  icon: "Network",
  name: "Subnet Calculator",
  description: "CIDR math, address ranges, splitting, and supernetting for IPv4 and IPv6.",
  category: "Network",
  keywords: [
    "subnet calculator",
    "cidr calculator",
    "ip subnet",
    "netmask calculator",
    "ipv6 subnet",
    "subnet splitter",
  ],
  searchTerms: [
    "cidr to ip range",
    "network address calculator",
    "wildcard mask",
    "supernet calculator",
    "vlsm calculator",
    "how many hosts in a subnet",
    "ip range to cidr",
    "rfc 1918 checker",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "split",
      label: "Split into subnets",
      default: 0,
      min: 0,
      max: 64,
    },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: "Parses an IPv4 or IPv6 address, CIDR block, or address plus netmask and reports the network address, broadcast address, usable host range, host count, and address type. It can also split a network into equal subnets or compare two CIDRs to check containment, overlap, and their smallest common supernet.",
    how: "Paste a CIDR like 192.168.1.0/24, an address and mask like 192.168.1.37 255.255.255.0, or a bare address to see it treated as a single host. Enter two CIDRs separated by a comma or space to compare them. Set Split into subnets above zero to break a network into that many equal pieces.",
    why: "Most online subnet calculators only handle IPv4, bury the answer under ads, or cap how many subnets you can split into. This one covers IPv4 and IPv6 with the same input box, runs entirely offline, and has no limits on how many times you use it.",
    faq: [
      {
        q: "Why does a /31 show 2 usable hosts instead of 0?",
        a: "RFC 3021 allows /31 networks on point-to-point links to use both addresses as hosts, since there is no room for a separate network and broadcast address. This tool follows that rule, and a /32 is treated as a single host address.",
      },
      {
        q: "How does the two-CIDR comparison work?",
        a: "Enter two CIDRs separated by a comma or space, such as 10.0.0.0/24, 10.0.1.0/24. The tool masks both to their network addresses, checks whether one range fully contains the other or whether they only partially overlap, and reports the smallest single network that covers both.",
      },
      {
        q: "Does anything leave my browser?",
        a: "No. All the address math runs locally in JavaScript and your inputs never leave your device. A GET endpoint at /api/subnet-calculator exists for scripts and curl, since the calculation is cheap and stateless either way.",
      },
    ],
  },
};
