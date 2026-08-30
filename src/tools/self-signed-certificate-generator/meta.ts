import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "self-signed-certificate-generator",
  icon: "FileCheck",
  name: "Self-Signed Certificate Generator",
  description:
    "Generate a self-signed X.509 certificate and private key for local development, in your browser.",
  category: "Crypto",
  keywords: [
    "self signed certificate generator",
    "create ssl certificate for localhost",
    "openssl req alternative",
    "x509 certificate generator",
    "https for local development",
    "generate cert and key",
  ],
  searchTerms: [
    "localhost https certificate",
    "make a test tls cert",
    "san certificate generator",
    "subject alternative name",
    "dev certificate authority",
    "client certificate for mtls",
    "pem cert and key pair",
    "ecdsa p256 certificate",
    "rsa 2048 certificate",
    "cert for a homelab service",
    "x509 test fixture",
    "certificate for an ip address",
  ],
  input: "none",
  output: "application/json",
  // No http entry: the private key is the whole point, and a server endpoint
  // would mean generating it somewhere other than your machine.
  options: [
    {
      kind: "text",
      id: "commonName",
      label: "Common name (CN)",
      default: "localhost",
      placeholder: "dev.example.com",
    },
    {
      kind: "text",
      id: "sans",
      label: "Subject alternative names",
      default: "localhost, 127.0.0.1, ::1",
      placeholder: "example.com, *.example.com, 127.0.0.1",
    },
    {
      kind: "text",
      id: "organization",
      label: "Organization (O), optional",
      default: "",
      placeholder: "Example Inc",
    },
    {
      kind: "text",
      id: "country",
      label: "Country (C), optional two letter code",
      default: "",
      placeholder: "US",
    },
    {
      kind: "number",
      id: "days",
      label: "Valid for (days)",
      default: 825,
      min: 1,
      max: 7300,
      step: 1,
    },
    {
      kind: "select",
      id: "keyAlgorithm",
      label: "Key algorithm",
      default: "ecdsa-p256",
      options: [
        {
          value: "ecdsa-p256",
          label: "ECDSA P-256 (recommended)",
          synonyms: ["elliptic curve", "prime256v1", "secp256r1", "nistp256", "ec"],
        },
        {
          value: "rsa-2048",
          label: "RSA 2048",
          synonyms: ["rsa", "2048 bit", "legacy", "widest compatibility"],
        },
      ],
    },
    {
      kind: "select",
      id: "usage",
      label: "Key usage preset",
      default: "server",
      options: [
        {
          value: "server",
          label: "Server TLS",
          synonyms: ["https", "web server", "serverauth", "site certificate"],
        },
        {
          value: "client",
          label: "Client TLS",
          synonyms: ["mtls", "mutual tls", "clientauth", "client certificate"],
        },
        {
          value: "ca",
          label: "Certificate authority",
          synonyms: ["root ca", "signing certificate", "basic constraints", "issuer"],
        },
      ],
    },
  ],
  // No examples: the input is "none" and every run mints a real private key.
  copy: {
    what: "Mints a complete X.509 certificate and its private key on your device: subject fields you choose, a subject alternative name list that handles hostnames, wildcards, and IP addresses, a validity window in days, and a key usage profile for a TLS server, a TLS client, or a small certificate authority. It returns the certificate and the PKCS#8 private key as PEM blocks, plus the SHA-256 and SHA-1 fingerprints and a plain summary of everything that went into the certificate.",
    how: "Set the common name to the hostname you will actually connect to, then list every name and IP that should work in the subject alternative names field, since modern clients ignore the common name and check only the SAN list. Pick a key algorithm and a usage preset, set how long it should last, and generate. Save the two PEM blocks as cert.pem and key.pem, point your server at them, and add cert.pem to the trust store you are testing with, because nothing else vouches for it.",
    why: "The alternative is a five flag openssl req incantation that nobody remembers, or a website that generates the key on its server and emails it to you. This one builds the certificate with a real X.509 library running in the tab, so your files and inputs never leave your device, and it shows the extensions it wrote instead of hiding them. It also defaults the SAN list to the common name, which is the single most common reason a hand-rolled openssl certificate is rejected.",
    faq: [
      {
        q: "Why does my browser still say the connection is not private?",
        a: "Because the certificate signed itself, and no browser trusts an issuer it has never heard of. That is not a fault in the certificate, it is the entire meaning of self-signed. Either add the certificate to your operating system or browser trust store for development, or generate one with the certificate authority preset, trust that, and use it to sign the certificates your services actually present.",
      },
      {
        q: "Why does it insist on subject alternative names?",
        a: "Chrome dropped common name matching in 2017 and every other current client followed, so a certificate whose hostname appears only in CN is rejected outright. The SAN list is what gets checked. It also has to include IP addresses separately from hostnames, which is why 127.0.0.1 goes in the list rather than being covered by localhost.",
      },
      {
        q: "What lifetime should I choose?",
        a: "For anything a browser will check, keep it at or under 398 days, since that is the maximum lifetime public clients accept and some of them apply it to private certificates too. For a certificate that only your own tooling checks, the default of 825 days is convenient. For a development certificate authority, a longer life is normal, because reissuing the root means re-trusting it everywhere.",
      },
      {
        q: "ECDSA or RSA?",
        a: "ECDSA on P-256 for anything current: the keys and handshakes are smaller and every modern client supports it. Choose RSA 2048 when something old is in the path, such as an embedded device, a legacy Java stack, or a load balancer that predates elliptic curve support. RSA key generation also takes noticeably longer in a browser tab, which you will see when you press generate.",
      },
    ],
  },
};
