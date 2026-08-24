import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "dns-propagation",
  icon: "Globe",
  name: "DNS Propagation",
  description: "Compare live DNS answers from Cloudflare, Google, and dns.sb side by side.",
  category: "Network",
  keywords: [
    "dns propagation checker",
    "compare dns resolvers",
    "doh lookup",
    "is my dns propagated",
    "cloudflare google dns.sb doh",
    "dns record check",
  ],
  searchTerms: [
    "dns checker",
    "nslookup online",
    "dig online",
    "has my dns updated",
    "dns cache check",
    "ttl check",
    "mx record lookup",
    "txt record lookup",
    "whatsmydns alternative",
    "global dns propagation checker",
  ],
  input: "text/plain",
  output: "application/json",
  privacyNote:
    "Lookups are sent from your browser directly to Cloudflare, Google, and dns.sb DNS. Those resolvers see the domain you look up. Nothing is sent to this site's server.",
  options: [
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
          value: "CAA",
          label: "CAA (certificate authority)",
          synonyms: [
            "certificate authority authorization",
            "ssl issuance",
            "letsencrypt",
            "cert policy",
          ],
        },
      ],
    },
  ],
  copy: {
    what: "Looks up one record at three public resolvers at once, Cloudflare, Google, and dns.sb, and puts their answers next to each other so you can see whether a DNS change has actually landed. Each resolver reports its own cached copy with its own TTL, so when they all return the same data the record has propagated, and when one still holds the old value it tells you which one and what it is serving. It handles A, AAAA, CNAME, MX, TXT, NS, SOA, and CAA lookups, and reads the DNS status code so an NXDOMAIN or SERVFAIL shows up as plain English instead of a number.",
    how: "Type a domain name, pick the record type, and the page queries all three resolvers over DNS-over-HTTPS from your browser. Paste a full URL if that is what you have on the clipboard; the hostname is pulled out for you. The propagation row is the verdict: all resolvers agree, or answers differ and something is still cached. You can also paste a JSON bundle of saved DoH responses keyed by resolver name to compare a capture you took earlier.",
    why: "The usual propagation checkers wrap a one line answer in banner ads, a newsletter box, and an upsell to a paid monitoring plan, and every lookup goes through their servers first. This one queries the resolvers directly from your browser, so there is no middleman collecting your domain list, no account, and no rate limit beyond what the public resolvers themselves apply. It is honest about the tradeoff: those three resolvers do see the domain you look up, because that is what a DNS query is.",
    faq: [
      {
        q: "Who sees my lookups?",
        a: "Cloudflare, Google, and dns.sb. The queries go from your browser straight to those three public resolvers over DNS-over-HTTPS, so each of them sees the domain you asked about, the same way they would if you had set them as your system resolver. Nothing is sent to this site's server, and no lookup history is stored.",
      },
      {
        q: "Why do resolvers disagree?",
        a: "Because each one is answering from its own cache. When you change a record, resolvers keep serving the old value until the previous record's TTL runs out, and they all started their timers at different moments. A disagreement usually means one cache has expired and another has not yet. If the difference is still there long after the old TTL should have elapsed, check that every authoritative name server for the zone has the new value.",
      },
      {
        q: "Which record types can I check?",
        a: "A and AAAA for addresses, CNAME for aliases, MX for mail routing, TXT for SPF, DKIM, DMARC, and domain verification strings, NS for delegation, SOA for the zone serial, and CAA for certificate issuance policy. TXT is the one to use when you are waiting on a verification record to show up.",
      },
    ],
  },
};
