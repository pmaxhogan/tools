import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "certificate-decoder",
  matrixSlug: "cert",
  name: "Certificate Decoder",
  description:
    "Decode PEM or DER X.509 certificates to read expiry, SANs, issuer, fingerprints, and chain order.",
  category: "Crypto",
  icon: "FileKey",
  keywords: [
    "certificate decoder",
    "ssl certificate decoder",
    "x509 decoder",
    "pem certificate viewer",
    "check certificate expiry",
    "certificate chain checker",
    "certificate fingerprint",
    "san certificate checker",
  ],
  searchTerms: [
    "decode ssl cert",
    "read pem file",
    "when does my certificate expire",
    "cert chain order",
    "sha256 fingerprint of certificate",
    "who issued this certificate",
    "subject alternative name list",
    "openssl x509 text online",
    "crt viewer",
    "der certificate parser",
    "certificate expiration",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "view",
      label: "Detail",
      default: "summary",
      options: [
        {
          value: "summary",
          label: "Summary",
          synonyms: ["short", "overview", "basic", "default", "the important fields"],
        },
        {
          value: "full",
          label: "Full detail",
          synonyms: [
            "all extensions",
            "verbose",
            "everything",
            "raw",
            "oids",
            "rdn components",
            "openssl text",
          ],
        },
      ],
    },
  ],
  examples: [
    {
      label: "Sample TLS leaf certificate",
      input: `-----BEGIN CERTIFICATE-----
MIICbDCCAhKgAwIBAgIEC63A3jAKBggqhkjOPQQDAjBPMQswCQYDVQQGEwJVUzEZ
MBcGA1UECgwQRXhhbXBsZSBUZXN0IE9yZzElMCMGA1UEAwwcRXhhbXBsZSBUZXN0
IEludGVybWVkaWF0ZSBDQTAeFw0yNjA4MTkwNDEwNDVaFw0yNjExMjcwNDEwNDVa
MEMxCzAJBgNVBAYTAlVTMRkwFwYDVQQKDBBFeGFtcGxlIFRlc3QgT3JnMRkwFwYD
VQQDDBB0ZXN0LmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
nClJt9B8HNJ8gLJgkpjfmhevsKJoPrnJg8G7QPi4nFj9Nwy+0u/TGQOXV1AmTkNk
vZ6ujvtnaq4m6U3FgmdTxaOB5zCB5DAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQE
AwIFoDAdBgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwHQYDVR0OBBYEFLvV
I+DseIIbbldXjhzecxS2fbmAMB8GA1UdIwQYMBaAFEZ0N4oLX+68GL8y7nl4MkBN
1+yZMGUGA1UdEQReMFyCEHRlc3QuZXhhbXBsZS5jb22CFHd3dy50ZXN0LmV4YW1w
bGUuY29thwTAAAIKgRFhZG1pbkBleGFtcGxlLmNvbYYZaHR0cHM6Ly90ZXN0LmV4
YW1wbGUuY29tLzAKBggqhkjOPQQDAgNIADBFAiEA1IS8SCkbHgL/B7Ks4tobFgZP
wYfcJi7hfy+xqmbUmI4CIDNfnD1eCoZ5o2HoKAEXSFUas0jyYqRCg+GqczMKxrTf
-----END CERTIFICATE-----`,
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Decodes X.509 certificates and shows what is actually inside them: subject and issuer distinguished names, serial number, the not before and not after dates with a plain-English expiry countdown, public key algorithm and size, signature algorithm, SHA-256 and SHA-1 fingerprints, subject alternative names, key usage and extended key usage in words rather than OIDs, basic constraints, and the subject and authority key identifiers. Paste one certificate or a whole bundle. When you paste several, it also checks whether each certificate's issuer name matches the next certificate's subject name and tells you if the chain order is right, reversed, or broken. Full detail mode adds every extension OID with its raw hex value and the complete RDN component list.",
    how: "Paste a PEM block, a whole nginx or Apache config that contains one, the output of openssl s_client, or a bare base64 DER blob. You can also drop a .crt, .cer, .pem, or .der file straight onto the input. Certificates are decoded in the order they appear, so paste your leaf first and its issuers after it if you want the chain verdict to be meaningful. Switch the detail dropdown to Full detail when you need the raw extension bytes.",
    why: "The usual certificate decoder sites make you paste a certificate into a form and press a button on someone else's server, which is a strange thing to do with a document you are trying to inspect. This one decodes in your browser, so your inputs never leave your device, and it works offline after the first load. It reads bundles, not just single certificates, and it says what key usage and extended key usage mean instead of printing bare OIDs.",
    faq: [
      {
        q: "Is my certificate uploaded anywhere?",
        a: "Not from this page. Decoding happens in your browser and your inputs never leave your device. There is also an optional POST endpoint for scripts, and if you choose to call that one the certificate obviously does travel to the server, so use the page when that matters.",
      },
      {
        q: "Does it verify the chain signatures?",
        a: "No. It decodes each certificate and sanity-checks the chain by name, comparing every certificate's issuer to the next certificate's subject, then reports whether the order looks correct, reversed, or broken. It never checks a signature, so a matching name is not proof of a valid chain. Use openssl verify for that.",
      },
      {
        q: "How do I get the PEM for a website?",
        a: "Run openssl s_client -showcerts -servername example.com -connect example.com:443 </dev/null and paste the whole output here. The surrounding noise is fine, every certificate block gets picked out of it.",
      },
    ],
  },
};
