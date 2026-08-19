import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "dns-lookup",
  matrixSlug: "dns",
  icon: "Globe",
  name: "DNS Lookup",
  description: "Query records over DNS-over-HTTPS with no server of your own.",
  category: "Network",
  keywords: [
    "dns lookup",
    "doh query",
    "dns over https",
    "reverse dns lookup",
    "ptr record lookup",
    "mx record lookup",
  ],
  searchTerms: [
    "nslookup online",
    "dig online",
    "dns record checker",
    "a record lookup",
    "txt record lookup",
    "ip to hostname",
    "in-addr.arpa",
    "ip6.arpa",
  ],
  input: "text/plain",
  output: "application/json",
  privacyNote:
    "Queries are sent from your browser directly to the DoH resolver you choose only when you run a lookup. That resolver sees the domain or address you look up. Nothing goes through this site's server.",
  options: [
    {
      kind: "select",
      id: "resolver",
      label: "Resolver",
      default: "cloudflare",
      options: [
        {
          value: "cloudflare",
          label: "Cloudflare",
          synonyms: ["1.1.1.1", "cloudflare dns", "cloudflare-dns.com"],
        },
        {
          value: "google",
          label: "Google",
          synonyms: ["8.8.8.8", "google public dns", "dns.google"],
        },
        {
          value: "dnssb",
          label: "dns.sb",
          synonyms: ["doh.sb", "dns sb"],
        },
      ],
    },
    {
      kind: "select",
      id: "type",
      label: "Record type",
      default: "A",
      options: [
        {
          value: "A",
          label: "A (IPv4 address)",
          synonyms: ["ipv4", "address record", "host record", "ip address"],
        },
        {
          value: "AAAA",
          label: "AAAA (IPv6 address)",
          synonyms: ["ipv6", "quad a", "quad-a", "ipv6 address"],
        },
        {
          value: "CNAME",
          label: "CNAME (alias)",
          synonyms: ["alias", "canonical name", "redirect record", "points to"],
        },
        {
          value: "MX",
          label: "MX (mail exchange)",
          synonyms: ["mail", "email", "mail server", "mail exchanger", "smtp"],
        },
        {
          value: "TXT",
          label: "TXT (text)",
          synonyms: ["spf", "dkim", "dmarc", "text record", "domain verification"],
        },
        {
          value: "NS",
          label: "NS (name server)",
          synonyms: ["nameserver", "name server", "delegation", "authoritative servers"],
        },
        {
          value: "SOA",
          label: "SOA (start of authority)",
          synonyms: ["start of authority", "serial number", "zone serial", "refresh retry"],
        },
        {
          value: "SRV",
          label: "SRV (service locator)",
          synonyms: ["service record", "service locator", "sip", "xmpp", "port and target"],
        },
        {
          value: "CAA",
          label: "CAA (certificate authority)",
          synonyms: [
            "certificate authority authorization",
            "ssl issuance",
            "letsencrypt",
            "cert policy",
          ],
        },
        {
          value: "PTR",
          label: "PTR (reverse DNS)",
          synonyms: ["reverse dns", "reverse lookup", "in-addr.arpa", "ip6.arpa", "ip to hostname"],
        },
      ],
    },
  ],
  copy: {
    what: "Queries a single DNS record over DNS-over-HTTPS at a resolver you pick: Cloudflare, Google, or dns.sb. It covers A, AAAA, CNAME, MX, TXT, NS, SOA, SRV, CAA, and PTR, and it reads the DNS status code so an NXDOMAIN or SERVFAIL shows up as plain English instead of a bare number. Paste an IPv4 or IPv6 address instead of a domain and it automatically builds the in-addr.arpa or ip6.arpa reverse name and runs a PTR lookup, whatever record type is selected.",
    how: "Type a domain name or IP address, pick a resolver and a record type, and the page fires the DoH request from your browser and shows the request URL it uses. You can also paste a JSON DoH response you already captured, such as one saved from another tool or from curl, and it renders each answer with its name, type, TTL, and data, plus the status code explained.",
    why: "Most online DNS lookup tools proxy the query through their own server first, so they see every domain you check and often wrap the answer in ads or a signup wall. This one builds the request and lets your browser send it straight to the resolver you chose, so there is no middleman logging your lookups, no account, and no daily limit beyond what the public resolver itself applies. It is honest about the tradeoff: the resolver you pick does see the domain or address you look up, because that is what a DNS query is.",
    faq: [
      {
        q: "Who sees my lookups?",
        a: "Whichever resolver you pick, Cloudflare, Google, or dns.sb, and nobody else. The query goes from your browser straight to that resolver over DNS-over-HTTPS, the same way it would if you had set it as your system resolver. Nothing is sent to this site's server, and no lookup history is stored.",
      },
      {
        q: "How does the reverse lookup work?",
        a: "Paste an IPv4 address like 192.0.2.1 or an IPv6 address like 2001:db8::1 and the tool detects it, builds the standard reverse name (1.2.0.192.in-addr.arpa for IPv4, the expanded nibble form under ip6.arpa for IPv6), and queries PTR at that name regardless of which record type is selected, noting that it did so.",
      },
      {
        q: "What do NXDOMAIN and SERVFAIL mean?",
        a: "NOERROR means the query succeeded. NXDOMAIN means the domain does not exist at all. SERVFAIL means the resolver itself failed to answer, often because of a broken or unsigned DNSSEC chain. REFUSED means the resolver declined to answer the query. The tool spells these out next to the code so you don't have to look them up.",
      },
    ],
  },
};
