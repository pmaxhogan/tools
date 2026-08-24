import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "totp-generator",
  matrixSlug: "totp",
  name: "TOTP Generator",
  description:
    "Generate live two-factor authentication codes from a Base32 secret or an otpauth:// URI.",
  category: "Crypto",
  icon: "KeyRound",
  keywords: [
    "totp generator",
    "2fa code generator",
    "authenticator code online",
    "otpauth",
    "rfc 6238",
    "test totp secret",
  ],
  searchTerms: [
    "one time password",
    "otp generator",
    "google authenticator code",
    "hotp",
    "rfc 4226",
    "two factor code from secret",
    "qr code secret to code",
    "6 digit code generator",
    "otpauth uri decoder",
    "base32 secret code generator",
    "2fa test code generator",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "algorithm",
      label: "Algorithm",
      default: "SHA1",
      options: [
        {
          value: "SHA1",
          label: "SHA1 (default)",
          synonyms: ["sha-1", "sha 1", "standard", "google authenticator", "most providers"],
        },
        {
          value: "SHA256",
          label: "SHA256",
          synonyms: ["sha-256", "sha2", "sha 256"],
        },
        {
          value: "SHA512",
          label: "SHA512",
          synonyms: ["sha-512", "sha2", "sha 512"],
        },
      ],
    },
    {
      kind: "select",
      id: "digits",
      label: "Digits",
      default: "6",
      options: [
        { value: "6", label: "6 digits", synonyms: ["six", "standard", "default"] },
        { value: "7", label: "7 digits", synonyms: ["seven"] },
        { value: "8", label: "8 digits", synonyms: ["eight", "long code"] },
      ],
    },
    {
      kind: "number",
      id: "period",
      label: "Period (seconds)",
      default: 30,
      min: 10,
      max: 120,
      step: 5,
    },
    {
      kind: "number",
      id: "now",
      label: "Time override (unix seconds, 0 = live)",
      default: 0,
      min: 0,
      step: 1,
    },
  ],
  copy: {
    what: "Turns a two-factor secret into the six digit code your provider is expecting right now. Paste the Base32 secret, or the whole otpauth:// URI hidden behind a setup QR code, and you get the current code, the seconds left before it rolls over, and the codes on either side of it. It implements RFC 6238 (TOTP) on top of RFC 4226 (HOTP), so SHA1, SHA256, and SHA512 secrets at 6, 7, or 8 digits all work, along with counter based HOTP URIs. Everything runs in your browser with no account and no rate limit.",
    how: "Paste the secret your provider showed you when you enabled 2FA, or the full otpauth:// URI decoded from its QR code. An otpauth URI carries its own algorithm, digit count, and period, so those are read from the URI and the dropdowns are ignored. For a bare secret, set the algorithm, digits, and period yourself; the defaults (SHA1, 6 digits, 30 seconds) are what almost every provider uses. The time override exists for debugging: leave it at 0 for live codes, or set a unix timestamp to reproduce the code from a specific moment.",
    why: "The obvious way to check a TOTP secret is to paste it into one of the many online 2FA generators, which means handing a long lived credential to a server you know nothing about. Here the secret is decoded and hashed in your browser, and your files and inputs never leave your device. There are no ads, no signup wall, and no daily limit on how many codes you can generate while you debug an integration.",
    faq: [
      {
        q: "Is it safe to paste my secret here?",
        a: "The secret stays in your browser and is never uploaded, which is a real improvement over the server side generators. It is still a permanent credential, so treat this as a tool for test secrets, integration debugging, and one off recovery. For an account you care about, keep the secret in a dedicated authenticator app or password manager instead of a web page.",
      },
      {
        q: "Can I paste the otpauth:// URI from a setup QR code?",
        a: "Yes. Paste the whole otpauth://totp/... or otpauth://hotp/... string and the account name, issuer, algorithm, digit count, period, and HOTP counter are all read from it. Those values override the dropdowns, because a URI already describes itself completely.",
      },
      {
        q: "Does it support SHA256 and SHA512?",
        a: "Yes, along with 7 and 8 digit codes and non standard periods. The RFC 6238 Appendix B test vectors for all three hash functions are covered by the test suite. If your codes do not match, check the algorithm first: nearly every provider uses SHA1 even though the spec allows more.",
      },
    ],
  },
};
