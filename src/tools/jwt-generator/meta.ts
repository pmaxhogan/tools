import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "jwt-generator",
  icon: "FileKey",
  name: "JWT Generator",
  description: "Build, sign, and verify JSON Web Tokens with HS256, RS256, or ES256 locally.",
  category: "Crypto",
  // The signing key goes in the option below, which is flagged sensitive: the
  // panel folds it away behind a Reveal button and the shell never writes it to
  // the URL fragment. sensitiveInput stays on because the input box still
  // accepts the older "--- then the key" form, so the input itself may hold a
  // key and must stay out of the fragment, history, and shared links.
  sensitiveInput: true,
  keywords: [
    "jwt generator",
    "sign a jwt online",
    "jwt builder",
    "create jwt token",
    "verify jwt signature",
    "rs256 jwt generator",
  ],
  searchTerms: [
    "jwt.io alternative",
    "make a test jwt",
    "hs256 token generator",
    "es256 jwt",
    "jwt with expiry",
    "json web token creator",
    "sign token with private key",
    "jwt exp iat nbf",
    "bearer token generator",
    "test auth token",
    "jwt signing playground",
    "pkcs8 jwt signing key",
  ],
  input: "text/plain",
  output: "application/json",
  // No http entry: signing keys and finished bearer tokens would both have to
  // cross the network for a curl endpoint to exist.
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "sign",
      options: [
        {
          value: "sign",
          label: "Sign a token",
          synonyms: ["create", "build", "generate", "issue", "make"],
        },
        {
          value: "verify",
          label: "Verify a token",
          synonyms: ["check", "validate", "confirm signature", "test token"],
        },
      ],
    },
    {
      kind: "text",
      id: "key",
      label: "Secret or private key (PEM)",
      default: "",
      sensitive: true,
      // A PKCS#8 PEM block is many lines, so this one is a textarea. It folds
      // to a one line summary with a Reveal button once it holds a value.
      multiline: true,
      placeholder: "your-256-bit-secret, or a BEGIN PRIVATE KEY block",
    },
    {
      kind: "select",
      id: "alg",
      label: "Algorithm",
      default: "",
      options: [
        {
          value: "",
          label: "Auto (HS256 to sign, the token header to verify)",
          synonyms: ["automatic", "detect", "from header", "default", "guess"],
        },
        {
          value: "HS256",
          label: "HS256 (shared secret)",
          synonyms: ["hmac sha256", "symmetric", "shared key", "hs 256"],
        },
        {
          value: "HS384",
          label: "HS384 (shared secret)",
          synonyms: ["hmac sha384", "symmetric", "hs 384"],
        },
        {
          value: "HS512",
          label: "HS512 (shared secret)",
          synonyms: ["hmac sha512", "symmetric", "hs 512"],
        },
        {
          value: "RS256",
          label: "RS256 (RSA private key)",
          synonyms: ["rsa", "asymmetric", "pkcs1 v1.5", "public key", "rs 256"],
        },
        {
          value: "ES256",
          label: "ES256 (ECDSA P-256 key)",
          synonyms: ["ecdsa", "elliptic curve", "asymmetric", "p256", "es 256"],
        },
      ],
    },
    {
      kind: "boolean",
      id: "demoKey",
      label: "Generate a demo key pair for RS256 or ES256",
      default: false,
    },
    { kind: "boolean", id: "addIat", label: "Add iat (issued at)", default: false },
    { kind: "boolean", id: "addNbf", label: "Add nbf (not before)", default: false },
    {
      kind: "number",
      id: "expiresIn",
      label: "Expires in seconds (0 for no exp)",
      default: 0,
      min: 0,
      max: 315360000,
      step: 60,
    },
    {
      kind: "number",
      id: "now",
      label: "Clock override (unix seconds, 0 = live)",
      default: 0,
      min: 0,
      step: 1,
    },
  ],
  // The secret below is the placeholder string every JWT tutorial prints, so
  // nothing real is being suggested. It rides in the key option, which the
  // shell applies but never writes back to the URL. sensitiveInput means
  // examples never auto-fill the box either way; they exist as documentation
  // and for the example picker.
  examples: [
    {
      label: "Sign the classic example token",
      input: '{"sub":"1234567890","name":"John Doe","iat":1516239022}',
      opts: { mode: "sign", alg: "HS256", key: "your-256-bit-secret" },
    },
    {
      label: "Verify that token",
      input:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      opts: { mode: "verify", alg: "HS256", key: "your-256-bit-secret" },
    },
  ],
  copy: {
    what: "Builds a JSON Web Token from a payload you write and signs it with HS256, HS384, HS512, RS256, or ES256, then shows the finished token alongside its decoded header, payload, and signature. Checkboxes add the standard time claims (iat, nbf, and an exp a chosen number of seconds out), and a clock override makes the result reproducible for tests. Verify mode goes the other way: paste a token and the matching secret or public key, and it reports whether the signature holds and whether the token is inside its validity window.",
    how: "Write the claims as JSON in the input box, then put the signing key in the Secret or private key option: the shared secret for an HS algorithm, or a PKCS#8 PEM private key for RS256 and ES256. That option is masked, folds away behind a Reveal button once it holds a PEM block, and is never written to the address bar. For a quick asymmetric test with no key of your own, turn on the demo key pair option and both PEM blocks come back with the token. To check a token, switch Mode to Verify, paste the token into the input box, and put the secret or PEM public key in the same option; on Auto the algorithm is read from the token's own header, and picking one explicitly checks the token against that algorithm instead. The older form still works: leave the option empty and put the key below a line of three dashes.",
    why: "The usual JWT playground is a hosted page that wants your signing key typed into a form field on somebody else's origin, and several of them keep the field's contents in the query string. Here the signing runs in the browser's own cryptography engine, the key stays in a masked field that is never written to the URL, and your files and inputs never leave your device. There is no server endpoint at all, on purpose, because a hosted signing endpoint would mean production keys crossing the network.",
    faq: [
      {
        q: "Which algorithm should I pick?",
        a: "HS256 when one service both issues and checks the token, because it is one shared secret and nothing else. RS256 or ES256 when someone else has to verify tokens you issue: they only need your public key, so a verifier cannot mint tokens of its own. ES256 keys and signatures are far smaller than RSA ones, which matters if the token travels in a header. Never accept a token whose header says alg is none; this tool refuses to.",
      },
      {
        q: "Why does it want a PKCS#8 PEM specifically?",
        a: "Because that is the one private key format the browser's WebCrypto API imports. If your file starts with BEGIN RSA PRIVATE KEY or BEGIN EC PRIVATE KEY, it is the older PKCS#1 or SEC1 form, and one command converts it: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem. For verifying, the public key has to be the SubjectPublicKeyInfo form, which you get with openssl pkey -in key.pem -pubout.",
      },
      {
        q: "Is a token I make here safe to use in production?",
        a: "The token itself is a real, correctly signed JWT, so yes, technically. The judgment call is whether to type a production signing key into a browser tab at all. For a staging secret, a local development key, or a demo key pair generated right here, this is fine. For the key that guards a live system, sign on the server that owns it and use this tool with a throwaway key to work out the shape of the token first.",
      },
      {
        q: "Why does the same ES256 payload give a different token every time?",
        a: "ECDSA mixes a fresh random value into every signature, so two signatures over identical bytes never match. That is expected and does not weaken anything, as long as the randomness is good. RS256 and the HS algorithms are deterministic, so they do produce the same token twice for the same input, which is why the examples here pin an HS256 and an RS256 token but not an ES256 one.",
      },
    ],
  },
};
