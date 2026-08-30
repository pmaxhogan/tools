import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "hmac-generator",
  icon: "Fingerprint",
  name: "HMAC Generator",
  description: "Compute and verify HMAC digests for a message and a secret key, in your browser.",
  category: "Crypto",
  // The key goes in the Key option below, which is flagged sensitive: the panel
  // masks it and the shell never writes it to the URL fragment. sensitiveInput
  // stays on because the message box still accepts the older "--- then the key"
  // form, so the input itself may hold a key and must stay out of the fragment,
  // browser history, and shared links.
  sensitiveInput: true,
  keywords: [
    "hmac generator",
    "hmac sha256 online",
    "verify hmac signature",
    "webhook signature checker",
    "hmac calculator",
    "message authentication code",
  ],
  searchTerms: [
    "hmac sha1",
    "hmac sha512",
    "compute hmac",
    "check webhook signature",
    "stripe signature verify",
    "github webhook secret",
    "rfc 2104",
    "rfc 4231 test vectors",
    "keyed hash",
    "signature mismatch debugging",
    "hmac base64",
    "hmac hex digest",
  ],
  input: "text/plain",
  output: "application/json",
  // No http entry on purpose: a curl endpoint would mean posting the signing
  // key to a server, which is the one thing this tool exists to avoid.
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "compute",
      options: [
        {
          value: "compute",
          label: "Compute a MAC",
          synonyms: ["generate", "sign", "make", "create digest"],
        },
        {
          value: "verify",
          label: "Verify a MAC",
          synonyms: ["check", "compare", "validate", "match signature"],
        },
      ],
    },
    {
      kind: "text",
      id: "key",
      label: "Key",
      default: "",
      sensitive: true,
      placeholder: "the shared secret",
    },
    {
      kind: "select",
      id: "algorithm",
      label: "Algorithm",
      default: "sha256",
      options: [
        {
          value: "sha256",
          label: "SHA-256 (default)",
          synonyms: ["sha256", "sha 256", "hmac-sha256", "hs256"],
        },
        {
          value: "sha1",
          label: "SHA-1 (legacy)",
          synonyms: ["sha1", "sha 1", "hmac-sha1", "aws v2", "old webhooks"],
        },
        {
          value: "sha384",
          label: "SHA-384",
          synonyms: ["sha384", "sha 384", "hmac-sha384", "hs384"],
        },
        {
          value: "sha512",
          label: "SHA-512",
          synonyms: ["sha512", "sha 512", "hmac-sha512", "hs512"],
        },
      ],
    },
    {
      kind: "select",
      id: "encoding",
      label: "Output encoding",
      default: "hex",
      options: [
        {
          value: "hex",
          label: "Hex",
          synonyms: ["hexadecimal", "base16", "lowercase hex"],
        },
        {
          value: "base64",
          label: "Base64",
          synonyms: ["b64", "standard base64", "padded"],
        },
        {
          value: "base64url",
          label: "Base64url",
          synonyms: ["url safe", "base64 url", "jwt style", "unpadded"],
        },
      ],
    },
    {
      kind: "select",
      id: "keyEncoding",
      label: "Key format",
      default: "utf8",
      options: [
        {
          value: "utf8",
          label: "Text (UTF-8)",
          synonyms: ["plain", "string", "ascii", "utf 8"],
        },
        {
          value: "hex",
          label: "Hex bytes",
          synonyms: ["hexadecimal", "base16", "binary key"],
        },
        {
          value: "base64",
          label: "Base64 bytes",
          synonyms: ["b64", "encoded key", "binary key"],
        },
      ],
    },
    {
      kind: "text",
      id: "expected",
      label: "Expected MAC (verify mode)",
      default: "",
      placeholder: "hex or base64 digest to compare against",
    },
  ],
  // The "secret" here is the RFC 4231 test vector key, which is published in
  // the RFC itself, so nothing real is being suggested as a sample. The key
  // rides in the Key option, which the shell applies but never writes back to
  // the URL. sensitiveInput suppresses the automatic pre-fill either way, so
  // these document the tool and feed the example picker rather than seeding
  // the box on a first visit.
  examples: [
    {
      label: "RFC 4231 test vector",
      input: "what do ya want for nothing?",
      opts: { mode: "compute", algorithm: "sha256", encoding: "hex", key: "Jefe" },
    },
    {
      label: "Verify a known digest",
      input: "what do ya want for nothing?",
      opts: {
        mode: "verify",
        algorithm: "sha256",
        key: "Jefe",
        expected: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
      },
    },
  ],
  copy: {
    what: "Computes an HMAC over a message with a secret key, using SHA-1, SHA-256, SHA-384, or SHA-512, and prints the digest as hex, base64, or base64url. Verify mode goes the other way: paste the MAC a service sent you and it recomputes the digest and compares the two byte by byte, without an early exit, so the comparison itself leaks nothing about how close a wrong value was. It also reports the digest size and the key size, and tells you when a key is too short to be worth much or long enough that HMAC hashes it down first.",
    how: "Type or paste the message into the box, then put the secret key in the Key option, which is masked and never written to the address bar. Pick the algorithm and output encoding your service expects, and switch Key format to hex or base64 if your key is raw bytes rather than text. To check a signature, switch Mode to Verify and paste the MAC you received into the Expected MAC box; it reads hex or base64 either way. The older form still works too: leave the Key option empty and put the key below a line of three dashes in the message box.",
    why: "Every other HMAC calculator asks you to paste a live signing key into a form that posts it to somebody else's server. That key is usually the same one that signs your production webhooks, so pasting it into a random site is a real incident. This one computes the digest with an audited hash library inside the tab: your files and inputs never leave your device, and there is deliberately no curl endpoint for it. MD5 is not offered, because an HMAC-MD5 calculator is only ever used to keep a broken integration limping.",
    faq: [
      {
        q: "Does the key end up in the URL when I share a link?",
        a: "No. Option values are normally stored in the page URL so a link can carry your settings, but the Key option is flagged as a secret: it is masked on screen, it is never written to the address bar, and a link that tries to pre-fill it is ignored. The message box is kept out of the URL as well, because it still accepts the older form where the key is typed below a line of three or more dashes.",
      },
      {
        q: "My webhook signature does not match. What is usually wrong?",
        a: "Four things, in order of how often they cause it. The message has to be the exact raw request body, byte for byte, before any JSON parsing or re-serializing. Some providers sign a constructed string rather than the body alone, for example a timestamp, a period, and then the body. The key may be raw bytes issued as hex or base64 rather than text, in which case set Key format to match. And the encoding of the digest itself may be base64 where you assumed hex.",
      },
      {
        q: "Is HMAC-SHA1 still safe to use?",
        a: "For authentication, yes in practice: the known SHA-1 attacks are collision attacks, and HMAC does not depend on collision resistance the way a plain signature does, so HMAC-SHA1 has not been broken. It is still offered here because plenty of older APIs, including AWS Signature Version 2, use it and you need to be able to debug them. For anything new, use SHA-256.",
      },
      {
        q: "Does the key or the message get uploaded anywhere?",
        a: "No. The digest is computed in JavaScript inside your browser tab, so your files and inputs never leave your device, and the page keeps working offline after the first load. This tool has no server endpoint at all, precisely because a hosted HMAC endpoint would mean real signing keys traveling over the network.",
      },
    ],
  },
};
