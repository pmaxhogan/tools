import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "qr-code-generator",
  icon: "QrCode",
  matrixSlug: "qr-generator",
  name: "QR Code Generator",
  description:
    "Generate SVG and PNG QR codes with a center logo, from links, Wi-Fi, contacts, email, SMS, maps, and calendar events.",
  category: "QR",
  keywords: [
    "qr code generator",
    "qr code with logo",
    "wifi qr code",
    "vcard qr code",
    "url to qr code",
    "svg qr code",
    "calendar event qr code",
    "free qr code no signup",
  ],
  searchTerms: [
    "make a qr code",
    "create qr code",
    "qr code maker",
    "qr code with image",
    "contact card qr",
    "vevent qr code",
    "phone number qr code",
    "geo location qr code",
    "mailto qr code",
    "sms qr code",
    "custom qr code generator",
    "qr code no watermark",
  ],
  input: "text/plain",
  output: "image/svg+xml",
  options: [
    {
      kind: "select",
      id: "preset",
      label: "Content type",
      default: "text",
      groups: [
        {
          label: "Text and links",
          synonyms: ["plain text", "url", "website link"],
          options: [
            {
              value: "text",
              label: "Plain text",
              synonyms: ["free text", "raw text", "any text"],
            },
            {
              value: "url",
              label: "URL",
              synonyms: ["link", "website", "web address", "http"],
            },
          ],
        },
        {
          label: "Contact and messaging",
          synonyms: ["vcard", "email", "sms", "phone number", "contact"],
          options: [
            {
              value: "vcard",
              label: "Contact card (vCard)",
              synonyms: ["business card", "vcf", "contact info"],
            },
            {
              value: "email",
              label: "Email message",
              synonyms: ["mailto", "send email"],
            },
            {
              value: "sms",
              label: "SMS message",
              synonyms: ["text message", "sms draft"],
            },
            {
              value: "phone",
              label: "Phone number",
              synonyms: ["dial", "call", "tel link"],
            },
          ],
        },
        {
          label: "Network",
          synonyms: ["wifi", "wireless"],
          options: [
            {
              value: "wifi",
              label: "Wi-Fi network",
              synonyms: ["wi-fi", "wireless network", "wifi password", "network join"],
            },
          ],
        },
        {
          label: "Places and events",
          synonyms: ["location", "calendar", "map", "event"],
          options: [
            {
              value: "geo",
              label: "Map location",
              synonyms: ["gps coordinates", "location pin", "map pin"],
            },
            {
              value: "event",
              label: "Calendar event",
              synonyms: ["vevent", "ics file", "appointment"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "ecc",
      label: "Error correction",
      default: "M",
      options: [
        {
          value: "L",
          label: "L: 7% recovery",
          synonyms: ["low", "level l", "7 percent"],
        },
        {
          value: "M",
          label: "M: 15% recovery",
          synonyms: ["medium", "level m", "15 percent"],
        },
        {
          value: "Q",
          label: "Q: 25% recovery",
          synonyms: ["quartile", "level q", "25 percent"],
        },
        {
          value: "H",
          label: "H: 30% recovery",
          synonyms: ["high", "level h", "30 percent", "logo safe"],
        },
      ],
    },
    { kind: "number", id: "margin", label: "Quiet zone (modules)", default: 4, min: 0, max: 20 },
  ],
  copy: {
    what: "Turns any of nine content types into a QR code rendered as clean, infinitely scalable SVG or a high resolution PNG. The payload builders handle the formats phones actually recognise: URLs, Wi-Fi join codes, vCard 4.0 contacts, mailto messages with a subject and body, SMS drafts, dialable numbers, map pins, and calendar events written as a standard VEVENT. You can drop a logo into the middle of the code, set the foreground and background colours, and tune error correction and the quiet zone.",
    how: "Pick a content type, then fill in its fields: the code redraws as you type. Add a logo if you want one and the tool switches to the highest error correction level automatically so the covered modules still recover. Adjust the size slider (15% to 25% of the code) and the colours, watch the scannability line for warnings, then copy the SVG or download SVG or PNG.",
    why: "Most QR generators route your data through their servers, then hold the code hostage: dynamic redirects that expire, tracking on every scan, watermarks, a signup wall before you can download a vector file, and a paid tier just to add a logo. This one encodes entirely in your browser, so your files and inputs never leave your device, and the code is static: it will still work in ten years with nobody in the middle.",
    faq: [
      {
        q: "Will the QR code expire or start redirecting somewhere else?",
        a: "No. It is a static code: the URL or text is encoded directly in the pattern, with no shortener or tracking redirect in between. Nothing about it can be changed after you download it, by us or anyone else.",
      },
      {
        q: "Is a QR code with a logo in the middle still reliable?",
        a: "Yes, within limits. Adding a logo forces error correction level H, which recovers about 30% of the modules, and the logo sits on a padded plate so no module is half covered. Keep it at or under 20% of the code width and test one print before you order a thousand.",
      },
      {
        q: "Does the Wi-Fi code actually work on iPhone and Android?",
        a: "Yes. It uses the standard WIFI:T:WPA;S:name;P:password;; format that both camera apps join automatically, including the hidden network flag. Special characters in your SSID or password (semicolons, colons, commas, quotes, backslashes) are escaped correctly, which is where most generators quietly break.",
      },
    ],
  },
};
