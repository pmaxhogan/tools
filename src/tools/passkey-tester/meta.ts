import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "passkey-tester",
  matrixSlug: "webauthn",
  icon: "KeyRound",
  name: "Passkey Tester",
  description:
    "Register and authenticate passkeys, then decode the attestation object, flags, and public key.",
  category: "Crypto",
  keywords: [
    "passkey tester",
    "webauthn debugger",
    "attestation object decoder",
    "authenticator data parser",
    "aaguid lookup",
    "fido2 credential decoder",
    "cose key viewer",
  ],
  searchTerms: [
    "webauthn",
    "fido2",
    "passkey debug",
    "decode attestationObject",
    "parse authenticatorData",
    "aaguid to authenticator name",
    "clientDataJSON decoder",
    "cose public key es256",
    "navigator.credentials.create",
    "backup eligible flag",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "Detail level",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary",
          synonyms: ["short", "readable", "overview", "simple", "plain english"],
        },
        {
          value: "full",
          label: "Full, with raw hex",
          synonyms: [
            "verbose",
            "everything",
            "raw",
            "hex",
            "bytes",
            "cose map",
            "debug",
            "expanded",
          ],
        },
      ],
    },
  ],
  copy: {
    what: "Decodes the pieces a passkey ceremony hands back. Paste a base64url attestationObject, raw authenticatorData, or the whole credential JSON from navigator.credentials, and it reports the relying party ID hash, every authenticator data flag (UP, UV, BE, BS, AT, ED), the signature counter, the AAGUID with the provider it belongs to, the credential ID, and the COSE public key with its algorithm and curve. Attestation statements are unpacked too, including the packed format algorithm and whether a certificate chain came with it. When clientDataJSON is present it also shows the ceremony type, challenge, and origin.",
    how: "Paste any of the three shapes into the input and the tool works out which one it got. Registration output starts with the attestation format and statement, authentication output ends with the signature size and user handle. Switch the detail level to full when you need the raw hex for the RP ID hash, credential ID, and authenticator data, plus the complete COSE key as JSON. Every row has its own copy button.",
    why: "Most WebAuthn debuggers are demo pages bolted onto a vendor signup, and they post your credential to their server to parse it. This one decodes in your browser, so your inputs never leave your device, and it names the AAGUID instead of showing you sixteen bytes of hex. There is no account, no request limit, and it keeps working offline.",
    faq: [
      {
        q: "Does my credential get sent anywhere?",
        a: "No. The decoding runs entirely in your browser, your inputs never leave your device, and the page keeps working offline after the first load. Nothing is logged or stored.",
      },
      {
        q: "Does it verify the attestation signature?",
        a: "No. It decodes and explains the attestation statement, reporting the format, the algorithm, and whether a certificate chain is present, but it never checks the signature or the certificate chain against a root. Real attestation verification belongs on your server against the FIDO Metadata Service, and any tool that claims to do it in a browser tab is not checking anything you should trust.",
      },
      {
        q: "Why is my authenticator reporting an all zero AAGUID?",
        a: "An AAGUID of sixteen zero bytes means the authenticator did not identify its model. That is normal and expected: platform authenticators return zeros whenever attestation is set to none, which is the default for most passkey registrations, and privacy conscious authenticators use zeros so a credential cannot be traced back to a specific device model. It is not an error and it does not mean the passkey is weaker.",
      },
    ],
  },
};
