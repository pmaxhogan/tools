import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'qr-code-generator',
  matrixSlug: 'qr-generator',
  name: 'QR Code Generator',
  description: 'Generate SVG QR codes from text, URLs, Wi-Fi credentials, or contact cards.',
  category: 'QR',
  keywords: [
    'qr code generator',
    'make a qr code',
    'wifi qr code',
    'vcard qr code',
    'url to qr code',
    'svg qr code',
    'qr code png download',
    'free qr code no signup',
  ],
  input: 'text/plain',
  output: 'image/svg+xml',
  options: [
    {
      kind: 'select',
      id: 'preset',
      label: 'Payload',
      default: 'text',
      choices: [
        { value: 'text', label: 'Plain text' },
        { value: 'url', label: 'URL' },
        { value: 'wifi', label: 'Wi-Fi — SSID / password / security' },
        { value: 'vcard', label: 'Contact card — name / phone / email / org' },
      ],
    },
    {
      kind: 'select',
      id: 'ecc',
      label: 'Error correction',
      default: 'M',
      choices: [
        { value: 'L', label: 'L — 7% recovery' },
        { value: 'M', label: 'M — 15% recovery' },
        { value: 'Q', label: 'Q — 25% recovery' },
        { value: 'H', label: 'H — 30% recovery' },
      ],
    },
    { kind: 'number', id: 'margin', label: 'Quiet zone (modules)', default: 4, min: 0, max: 20 },
  ],
  copy: {
    what: 'Turns any text into a QR code rendered as clean, infinitely scalable SVG. Presets shape the payload for you: URL validation, Wi-Fi join codes in the WIFI: format that iOS and Android recognise natively, and vCard 3.0 contact cards that scan straight into a phone address book. Error correction (L/M/Q/H) and the quiet-zone margin are both adjustable, so you can trade code density for scan reliability on print.',
    how: 'Pick a payload type, then type your content. Plain text and URL take a single line; Wi-Fi takes three lines (network name, password, then WPA, WEP or nopass); contact cards take up to four (name, phone, email, organisation). The code redraws as you type — download the SVG for print or the PNG for slides and chat.',
    why: 'Most QR generators route your data through their servers, then hold the code hostage: dynamic redirects that expire, tracking on every scan, watermarks, or a signup wall before you can download a vector file. This one encodes entirely on your device, so your Wi-Fi password and phone number never leave it, and the code is static — it will still work in ten years with nobody in the middle.',
    faq: [
      {
        q: 'Will the QR code expire or start redirecting somewhere else?',
        a: 'No. It is a static code: the URL or text is encoded directly in the pattern, with no shortener or tracking redirect in between. Nothing about it can be changed after you download it, by us or anyone else.',
      },
      {
        q: 'Does the Wi-Fi code actually work on iPhone and Android?',
        a: 'Yes. It uses the standard WIFI:T:WPA;S:name;P:password;; format that both camera apps join automatically. Special characters in your SSID or password — semicolons, colons, commas, backslashes — are escaped correctly, which is where most generators quietly break.',
      },
      {
        q: 'Which error correction level should I pick?',
        a: 'M (15%) is the right default for screens. Go to Q or H if the code will be printed small, placed on a curved surface, or partly covered by a logo — higher recovery means a denser code that survives damage. Drop to L only when the payload is long and the code will be scanned up close.',
      },
    ],
  },
};
