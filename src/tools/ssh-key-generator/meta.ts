import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "ssh-key-generator",
  icon: "KeySquare",
  name: "SSH Key Generator",
  description:
    "Generate an Ed25519 or ECDSA SSH key pair in your browser, with fingerprint and PEM export.",
  category: "Crypto",
  keywords: [
    "ssh key generator",
    "generate ed25519 ssh key",
    "ssh keygen online",
    "ssh key fingerprint",
    "ecdsa ssh key",
    "authorized_keys generator",
  ],
  searchTerms: [
    "ssh-keygen alternative",
    "create ssh key pair",
    "id_ed25519 generator",
    "openssh private key format",
    "sha256 fingerprint of ssh key",
    "pkcs8 ssh key",
    "github deploy key generator",
    "ssh key for server login",
    "nistp256 ssh key",
    "openssh-key-v1",
    "public key for authorized keys",
    "ssh key without terminal",
  ],
  input: "none",
  output: "application/json",
  // No http entry: a curl endpoint would mean a server generating and briefly
  // holding your private key, which is the one thing this tool exists to avoid.
  options: [
    {
      kind: "select",
      id: "algorithm",
      label: "Key type",
      default: "ed25519",
      options: [
        {
          value: "ed25519",
          label: "Ed25519 (recommended)",
          synonyms: ["ssh-ed25519", "edwards", "curve25519", "modern", "default"],
        },
        {
          value: "ecdsa-p256",
          label: "ECDSA P-256",
          synonyms: [
            "ecdsa-sha2-nistp256",
            "nistp256",
            "prime256v1",
            "secp256r1",
            "fips",
            "elliptic curve",
          ],
        },
      ],
    },
    {
      kind: "text",
      id: "comment",
      label: "Comment (optional)",
      default: "",
      placeholder: "you@laptop",
    },
  ],
  // No examples: the input is "none" and every run produces a real key pair.
  copy: {
    what: "Generates a fresh SSH key pair on your device and shows every form you might need for it: the OpenSSH public key line for authorized_keys, the OpenSSH private key in the openssh-key-v1 container that ssh reads directly, the SHA256 fingerprint that ssh-keygen -lf prints, and PKCS#8 and SubjectPublicKeyInfo PEM blocks for libraries and tools that want the generic formats. Ed25519 is the default; ECDSA on NIST P-256 is there for the environments that require a NIST curve.",
    how: "Pick a key type, optionally add a comment such as you@laptop so the key is identifiable in a list, and generate. Copy the private key into ~/.ssh/id_ed25519 and run chmod 600 on it, then append the public key line to ~/.ssh/authorized_keys on the server you want to reach. Compare the SHA256 fingerprint against what the server reports to confirm the right key is in place.",
    why: "The other online SSH key generators run ssh-keygen on their own server and send you the result, which means a machine you do not control created your private key and had a copy of it. Here the key is drawn from your browser's cryptographic random source and formatted locally: your files and inputs never leave your device, and the page has no server endpoint at all. It also gives you the fingerprint and both PEM forms in the same view, which usually means three separate commands.",
    faq: [
      {
        q: "Is it actually safe to generate an SSH key in a browser tab?",
        a: "The key comes from crypto.getRandomValues, which is the same operating system random source ssh-keygen draws from, and nothing about it is transmitted: it exists only in this tab's memory until you copy it. The honest caveat is that a browser is a large piece of software with extensions in it, so for a key that guards production infrastructure, running ssh-keygen -t ed25519 locally is still the stronger choice. For a personal server, a homelab box, or a throwaway deploy key, generating here is a reasonable trade.",
      },
      {
        q: "Why is there no passphrase option?",
        a: "The encrypted OpenSSH private key format derives its encryption key with bcrypt_pbkdf, which is not available in the browser as a building block here, so this tool writes the key unencrypted rather than inventing a format ssh would refuse to read. Adding a passphrase afterward is one command: save the private key, then run ssh-keygen -p -f ~/.ssh/id_ed25519 and it will re-encrypt the file in place.",
      },
      {
        q: "Should I pick Ed25519 or ECDSA?",
        a: "Ed25519 unless something forces your hand. It is faster, the keys and signatures are shorter, it has no dependence on a per-signature random value the way ECDSA does, and every OpenSSH release since 6.5 in 2014 supports it. Choose ECDSA P-256 when a device, a FIPS validated environment, or an older appliance will only accept a NIST curve. RSA is not offered here: if you need it for a system too old for Ed25519, generate it with ssh-keygen -t rsa -b 4096.",
      },
      {
        q: "What is the fingerprint for?",
        a: "It is a short SHA-256 hash of the public key, printed the same way ssh-keygen -lf prints it, so you can confirm that the key installed on a server is the key you meant to install without comparing two long base64 blobs by eye. GitHub, GitLab, and most hosting panels show the same fingerprint next to an uploaded key.",
      },
    ],
  },
};
