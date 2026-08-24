import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "webrtc-tester",
  matrixSlug: "webrtc-debug",
  icon: "Waypoints",
  name: "WebRTC Debugger",
  description:
    "Parse ICE candidates from SDP or JSON, classify each address, and interpret STUN and TURN reachability results.",
  category: "Network",
  keywords: [
    "webrtc tester",
    "ice candidate",
    "stun test",
    "turn test",
    "webrtc debug",
    "nat traversal",
  ],
  searchTerms: [
    "webrtc debugger",
    "ice candidate parser",
    "sdp candidate",
    "stun reachability",
    "symmetric nat detector",
    "srflx candidate",
    "relay candidate",
    "mdns candidate ip",
    "rtcpeerconnection debug",
    "webrtc nat type",
    "sdp parser",
    "turn relay checker",
    "nat type checker",
    "ice gathering test",
    "webrtc candidate type checker",
    "nat behavior test",
    "coturn debug tool",
  ],
  input: "text/plain",
  output: "application/json",
  privacyNote:
    "Pasted candidates and SDP are analyzed locally. The live gathering test, when you start it, contacts only the STUN servers listed on the page, directly from your browser.",
  copy: {
    what: "Parses ICE candidate lines, whether pasted individually, embedded in a full SDP blob, or supplied as the JSON array a live gathering test produces. Each candidate is decoded into its foundation, component, transport, priority, address, port, and type, and its address is classified as private IPv4, public IPv4, an IPv6 scope, or an mDNS-hidden hostname. From the full set of candidates it reports hedged verdicts on STUN reachability, TURN relay availability, and whether the mapping pattern across STUN servers hints at a symmetric NAT.",
    how: "Paste one or more candidate lines (with or without the candidate: or a=candidate: prefix), a full SDP offer or answer, or the JSON array produced by a live ICE gathering run. Each candidate appears as its own row with a compact type, protocol, address, and classification, followed by rows for ICE ufrag count and DTLS fingerprint presence when the input was an SDP, and then the interpreted NAT and reachability verdicts.",
    why: "Reading raw ICE candidates by eye means decoding a dense space-separated line and remembering which RFC 1918 ranges and IPv6 scopes matter. This does that decoding and classification instantly, offline, and explains what a symmetric NAT mapping or a missing relay candidate actually means, without sending your candidates or SDP anywhere: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why do my candidates show something.local instead of my real IP?",
        a: "That is mDNS obfuscation. Chrome, Firefox, and Safari all hide a device's real local network IP behind a randomly generated .local hostname on host candidates, so a web page cannot fingerprint your LAN address just by starting a WebRTC connection. Only another device on the same local network, doing mDNS resolution, can turn that name back into an IP.",
      },
      {
        q: "What does srflx vs relay mean?",
        a: "srflx (server-reflexive) is the public ip:port a STUN server observed for your connection: it proves outbound UDP reached the server, but the two peers still connect directly, address to address. relay is an address allocated on a TURN server that actually forwards traffic between both peers, used when direct connection fails, typically behind a symmetric NAT or a restrictive firewall.",
      },
      {
        q: "Does this page see my IP?",
        a: "No. Pasted candidates and SDP are parsed and classified entirely in your browser. If you run the live gathering test, your browser talks directly to the STUN server you pick from the list on this page; this site is never in that path and never receives your address.",
      },
    ],
  },
};
