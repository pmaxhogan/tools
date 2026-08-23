import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "qr-file-transfer",
  matrixSlug: "qr-transfer",
  icon: "QrCode",
  name: "Animated QR File Transfer",
  description:
    "Move a file between two devices that share no network by streaming it as animated QR codes and reading them back with a camera.",
  category: "QR",
  keywords: [
    "transfer file via qr code",
    "animated qr code file transfer",
    "airgap file transfer",
    "qr code stream",
    "send file between phones without internet",
    "qr file sender receiver",
    "file to qr code and back",
    "offline file transfer no network",
  ],
  searchTerms: [
    "qr transfer",
    "animated qr",
    "qr fountain code",
    "lt code qr",
    "txqr",
    "get file off an air gapped machine",
    "move file with no usb",
    "camera file transfer",
    "screen to camera data",
    "qr code data channel",
    "offline key export",
    "seed phrase qr transfer",
    "no wifi file transfer",
    "flying qr codes",
  ],
  input: "File",
  output: "application/json",
  privacyNote:
    "Your file is never uploaded: it leaves one device as light on a screen and enters the other through its camera, with no server in between.",
  options: [
    {
      kind: "select",
      id: "size",
      label: "Code size",
      default: "medium",
      options: [
        {
          value: "small",
          label: "Small: version 10, easiest to scan",
          synonyms: ["v10", "version 10", "low density", "small qr", "far away", "cheap camera"],
        },
        {
          value: "medium",
          label: "Medium: version 15, balanced",
          synonyms: ["v15", "version 15", "default", "balanced", "medium qr"],
        },
        {
          value: "large",
          label: "Large: version 20, faster",
          synonyms: ["v20", "version 20", "high density", "fast", "large qr"],
        },
        {
          value: "max",
          label: "Maximum: version 25, fastest",
          synonyms: ["v25", "version 25", "fastest", "densest", "biggest", "max qr"],
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
          label: "L: 7% recovery, most data per frame",
          synonyms: ["low", "level l", "7 percent", "throughput", "fastest"],
        },
        {
          value: "M",
          label: "M: 15% recovery, most reliable scanning",
          synonyms: ["medium", "level m", "15 percent", "reliable", "default"],
        },
      ],
    },
    {
      kind: "select",
      id: "mode",
      label: "Stream mode",
      default: "fountain",
      options: [
        {
          value: "fountain",
          label: "Fountain: endless stream, missed frames are fine",
          synonyms: [
            "lt code",
            "fountain code",
            "rateless",
            "erasure code",
            "raptor",
            "lossy camera",
            "default",
          ],
        },
        {
          value: "sequential",
          label: "Sequential: chunk order, loops until complete",
          synonyms: ["in order", "ordered", "simple", "loop", "plain", "indexed"],
        },
      ],
    },
    {
      kind: "number",
      id: "fps",
      label: "Frames per second",
      default: 10,
      min: 4,
      max: 20,
      step: 1,
    },
    {
      kind: "text",
      id: "fileName",
      label: "File name the receiver saves under",
      default: "",
      placeholder: "taken from the file you drop",
    },
    {
      kind: "text",
      id: "seed",
      label: "Transfer ID seed (optional, for repeatable frames)",
      default: "",
      placeholder: "leave empty for a random transfer ID",
    },
  ],
  copy: {
    what: "Turns a file into a stream of QR codes that animate on one device's screen while another device reads them back through its camera, with no cable, no Wi-Fi, no Bluetooth and no account in between. The sender splits the file into chunks, wraps each one in a header carrying the transfer id, the chunk index, the total size and a CRC32 checksum, and paints them as codes at up to 20 frames per second. The receiver scans, checks every frame, rebuilds the file and offers it as a download. The default fountain mode uses LT erasure coding, so a camera that misses half the frames still finishes without you replaying anything.",
    how: "Open the tool on the sending device, drop in the file, pick a code size and press play. Open the same page on the receiving device, switch to the Receive tab and point its camera at the first screen. Watch the progress bar climb; when it reaches the end the file appears with a save button and the original name. If frames are being missed, move the camera closer, lower the frame rate, or drop the code size so each code has fewer modules.",
    why: "Getting a file off a machine with no network is normally a story about USB sticks, and plenty of places ban those for exactly the reason you would want one. The alternatives online either upload your file to somebody's server first or are desktop apps you have to install on the very machine you are trying not to connect. This runs entirely in two browsers with no server between them: your files and inputs never leave your device, because the only channel is a screen and a camera. It is also honest about throughput, which is roughly one to three kilobytes per second in practice, and it tells you the estimated time before you start rather than after.",
    faq: [
      {
        q: "How fast is it really?",
        a: "Plan on one to three kilobytes per second. A version 15 code at error correction M carries about 410 characters, which after the base64url encoding and the frame header is roughly 275 bytes of payload, and a phone camera reliably locks onto around 8 to 12 frames a second. That is fine for a config file, an SSH key, a wallet backup or a small archive, and it is the wrong tool for a video. The tool estimates the time up front so you can decide before you start.",
      },
      {
        q: "What happens when the camera misses frames?",
        a: "In fountain mode, nothing. Each frame after the first pass carries an XOR of a pseudo random set of chunks chosen from a seed both sides derive from the frame header, so any sufficiently large collection of frames rebuilds the file, no matter which ones were missed or what order they arrived in. You just keep pointing the camera until the progress bar fills. Sequential mode is the simpler alternative: it loops through the chunks in order and the receiver picks up whatever it missed on the next pass.",
      },
      {
        q: "Is anything uploaded or sent over the network?",
        a: "No. The file is chunked, checksummed and encoded into QR codes by JavaScript running on the sending device, and decoded by JavaScript running on the receiving one. There is no server in the middle and no request carrying your data, because the data never becomes a request: it crosses the gap as light from a screen into a lens. That is also the honest security caveat. Anything with a view of the screen can read the stream, so treat it like holding a printed page up to a window.",
      },
    ],
  },
};
