import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'wireguard-config-generator',
  matrixSlug: 'wireguard',
  name: 'WireGuard Config',
  description: 'Generate WireGuard key pairs and ready-to-use configs with QR export for phones.',
  category: 'Homelab',
  keywords: [
    'wireguard config generator',
    'wireguard key generator',
    'wireguard qr code',
    'wg genkey online',
    'wireguard peer setup',
  ],
  input: 'none',
  output: 'application/json',
  // No http entry: the whole point is that the private key is generated in
  // the visitor's own browser. A server-side /api/wireguard-config-generator
  // endpoint would have to generate that private key itself, which defeats
  // the tool's one real security property.
  options: [
    { kind: 'number', id: 'peers', label: 'Peers', default: 1, min: 1, max: 20 },
    {
      kind: 'text',
      id: 'endpoint',
      label: 'Server endpoint',
      default: '',
      placeholder: 'vpn.example.com:51820',
    },
    { kind: 'text', id: 'subnet', label: 'VPN subnet', default: '10.8.0.0/24' },
    { kind: 'text', id: 'dns', label: 'DNS (optional)', default: '' },
    { kind: 'boolean', id: 'psk', label: 'Add a preshared key', default: true },
    {
      kind: 'select',
      id: 'allowedIps',
      label: 'Client routing',
      default: 'full',
      choices: [
        { value: 'full', label: 'Full tunnel (0.0.0.0/0, ::/0)' },
        { value: 'split', label: 'Split tunnel (subnet only)' },
      ],
    },
  ],
  copy: {
    what: 'Builds a complete WireGuard setup, a server config plus one config per peer, entirely in your browser: fresh X25519 key pairs, an optional preshared key for each peer, automatic IP assignment inside your chosen VPN subnet, and a scannable QR code for every peer config so a phone can import it straight from the WireGuard app.',
    how: "Set how many peers you need, your VPN subnet, and your server's public endpoint (host and port), then generate. Each peer gets its own config block with a copy button, a downloadable .conf file, and a QR code. Copy the server block onto your server, and either scan a peer's QR code in the WireGuard mobile app or copy that peer's file to a laptop.",
    why: 'Most "wireguard config generator" sites run wg genkey on their own server and hand you the result, which means a server you do not control generated and, for at least a moment, held your private key. This one runs the X25519 key generation with the same clamping rules wg genkey uses, but entirely on your device: your files and inputs never leave your device.',
    faq: [
      {
        q: 'Is it actually safe to generate WireGuard keys in a browser tab?',
        a: "The private key is generated with your browser's cryptographic random number source and clamped exactly as wg genkey clamps it, then never sent anywhere: it only ever exists in this tab's memory until you copy or download it. That said, the gold standard for a high-value key is still generating it offline with wg genkey on an air-gapped machine. For most homelab and personal VPN use, browser-local generation like this is a solid, honest middle ground.",
      },
      {
        q: 'What does AllowedIPs actually control?',
        a: "On the server, each peer's AllowedIPs restricts which source IP that peer is allowed to send from, normally just that peer's own address. On a client, AllowedIPs decides what traffic gets routed through the tunnel: 0.0.0.0/0, ::/0 sends everything (full tunnel), while a value scoped to just the VPN subnet only routes traffic meant for other VPN peers (split tunnel) and leaves the rest of your internet traffic alone.",
      },
      {
        q: 'Are my keys or configs uploaded anywhere?',
        a: 'No. Key generation, address assignment, config formatting, and QR rendering all happen locally in your browser; nothing is sent to a server. Refreshing or closing the tab discards everything, so copy or download what you need before you leave the page.',
      },
    ],
  },
};
