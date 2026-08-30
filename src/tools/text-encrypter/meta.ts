import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "text-encrypter",
  icon: "LockKeyhole",
  name: "Text Encrypter",
  description:
    "Encrypt and decrypt text with a passphrase using AES-256-GCM, entirely on your device.",
  category: "Security",
  // The passphrase goes in the Password option below, which is flagged
  // sensitive: the panel masks it and the shell never writes it to the URL
  // fragment. sensitiveInput stays on because the message box still accepts the
  // older "--- then the passphrase" form, so the input itself may hold a secret
  // and must stay out of the fragment, history, and shared links.
  sensitiveInput: true,
  keywords: [
    "text encrypter",
    "encrypt text with password",
    "aes 256 encryption online",
    "decrypt text online",
    "password protect a message",
    "aes gcm encrypt",
  ],
  searchTerms: [
    "encrypt a message",
    "secret message tool",
    "send an encrypted note",
    "pbkdf2 aes gcm",
    "encrypt string with passphrase",
    "decrypt aes text",
    "share a password securely",
    "encrypt clipboard text",
    "encrypted note without an account",
    "symmetric encryption tool",
    "protect text before pasting",
  ],
  input: "text/plain",
  output: "application/json",
  // No http entry: the passphrase would have to travel to a server, which
  // would defeat the entire point of the tool.
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "encrypt",
      options: [
        {
          value: "encrypt",
          label: "Encrypt",
          synonyms: ["lock", "protect", "scramble", "seal"],
        },
        {
          value: "decrypt",
          label: "Decrypt",
          synonyms: ["unlock", "open", "reveal", "read", "unseal"],
        },
      ],
    },
    {
      kind: "text",
      id: "password",
      label: "Password",
      default: "",
      sensitive: true,
      placeholder: "the passphrase both sides know",
    },
    {
      kind: "number",
      id: "iterations",
      label: "PBKDF2 iterations",
      default: 600000,
      min: 100000,
      max: 5000000,
      step: 100000,
    },
  ],
  // The pinned message below is a demonstration only. Its passphrase is the
  // famous XKCD example, published everywhere, so nothing real is exposed. It
  // rides in the Password option, which the shell applies but never writes back
  // to the URL. sensitiveInput suppresses the automatic pre-fill either way, so
  // these document the tool and feed the example picker rather than seeding the
  // box on a first visit.
  examples: [
    {
      label: "Encrypt a note",
      input: "Attack at dawn.",
      opts: { mode: "encrypt", password: "correct horse battery staple" },
    },
    {
      label: "Decrypt that note",
      input:
        "AQAAJxAAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobk3RQrQStcaf7RTjV4cXJr6UyGzLRQ9ZhzbhCjs3Tkw",
      opts: { mode: "decrypt", password: "correct horse battery staple" },
    },
  ],
  copy: {
    what: "Encrypts text with AES-256-GCM under a key derived from your passphrase with PBKDF2-HMAC-SHA256 at 600,000 iterations, and packs the result into one compact base64url string you can paste anywhere. The string carries its own format version, iteration count, 16 byte salt, and 12 byte nonce, so decrypting it needs nothing but the passphrase. GCM authenticates the message as well as hiding it, so an altered message fails to decrypt instead of quietly producing garbage.",
    how: "Type the text you want to protect into the box, then put the passphrase in the Password option, which is masked and never written to the address bar. Copy the armored message and send it however you like, then give the recipient the passphrase through a different channel. To read one, paste the armored message into the box, type the passphrase into the same option, and switch Mode to Decrypt. The older form still works too: leave the option empty and put the passphrase below a line of three dashes.",
    why: "The other encrypt-a-message sites either post your text and passphrase to a server, or store the message for you behind a link, which turns a private note into somebody else's database row. Here the derivation and the encryption run in the browser's own cryptography engine: your files and inputs never leave your device, nothing is stored, and there is no server endpoint. The parameters are stated plainly instead of hidden behind the word AES.",
    faq: [
      {
        q: "How strong is this, really?",
        a: "The cipher is not the weak part: AES-256-GCM with a random 96 bit nonce is what TLS uses. The strength you actually get is the strength of your passphrase, stretched by 600,000 PBKDF2 iterations. That stretching makes each guess roughly a quarter of a second of work on a laptop, which is fatal to a five word dictionary passphrase given a real GPU rig and merely painful for a long random one. Use a passphrase you would be comfortable using on a password manager vault, not one you would use on a forum.",
      },
      {
        q: "What is in the armored string?",
        a: "One version byte, the PBKDF2 iteration count as four bytes, the 16 byte salt, the 12 byte nonce, and then the ciphertext with its 16 byte authentication tag, all base64url encoded with the padding stripped. The header is also fed to AES-GCM as additional authenticated data, so changing the stated iteration count breaks decryption rather than tricking the reader into deriving a weaker key. None of that is secret; only the passphrase is.",
      },
      {
        q: "It says the password did not decrypt the message. What now?",
        a: "AES-GCM cannot tell a wrong passphrase from an altered message, because both fail the same authentication check, so the tool cannot tell you which happened. Check the passphrase first, including capitalization and a trailing space that a chat app may have added. If the passphrase is definitely right, the message itself changed: recopy it in full, since a truncated paste or an email client that inserted a line break will both do this.",
      },
      {
        q: "Does the passphrase end up in the URL when I share a link?",
        a: "No. Option values are normally stored in the page URL so a link can carry your settings, but the Password option is flagged as a secret: it is masked on screen, it is never written to the address bar, and a link that tries to pre-fill it is ignored. The message box is kept out of the URL as well, because it still accepts the older form where the passphrase is typed below a line of three or more dashes.",
      },
      {
        q: "Can I recover a message if I forget the passphrase?",
        a: "No, and that is the point. There is no account, no stored copy, and no reset: the passphrase is the only thing that derives the key, and it is never written anywhere. If losing access would be a disaster, keep the passphrase in a password manager before you send the message.",
      },
    ],
  },
};
