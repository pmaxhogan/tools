import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "qr-code-scanner",
  icon: "ScanQrCode",
  name: "QR Code Scanner",
  description:
    "Scan a QR code with your camera or from an image, even when it is small, blurry, warped, or partly covered, and read the decoded link, Wi-Fi login, contact, or location without leaving the page.",
  category: "QR",
  keywords: [
    "qr code scanner",
    "qr code reader",
    "scan qr code online",
    "read qr code from image",
    "qr scanner camera",
    "decode qr code",
    "free qr scanner no app",
  ],
  searchTerms: [
    "scan qr code",
    "read qr",
    "qr reader",
    "qr scanner",
    "decode qr",
    "qr code reader from photo",
    "webcam qr scanner",
    "upload qr code",
    "qr code decoder online",
    "read qr code from screenshot",
    "camera qr code scanner",
    "torch flashlight qr scan",
    "wifi qr code login",
    "blurry qr code reader",
    "damaged qr code scanner",
    "qr code wont scan",
    "read multiple qr codes",
    "scan qr code at an angle",
  ],
  input: "image/*",
  output: "text/plain",
  requires: ["camera"],
  options: [
    {
      kind: "select",
      id: "inversion",
      label: "Color handling",
      default: "attemptBoth",
      options: [
        {
          value: "attemptBoth",
          label: "Standard and inverted",
          synonyms: ["both", "auto detect", "either"],
        },
        {
          value: "dontInvert",
          label: "Standard only (dark on light)",
          synonyms: ["normal", "dark text light background", "no invert"],
        },
        {
          value: "onlyInvert",
          label: "Inverted only (light on dark)",
          synonyms: ["inverted", "light text dark background", "dark mode qr"],
        },
      ],
    },
  ],
  copy: {
    what: "Reads a QR code and shows you what is inside it, including codes other scanners give up on. Point your camera at a code for a live scan, or upload, drag, or paste an image of one, and three decoders of increasing power run entirely in your browser: a quick scan, a robust industry grade decoder, and a deep scan that uses a neural network trained on millions of distorted codes to find ones that are tiny, blurry, photographed at a steep angle, wrapped around a pole or bottle, glared out, or partly covered by a logo. Every code found in the image is listed, and known payload shapes are broken into labeled fields: web links, Wi-Fi logins with the network name and password, contact cards, calendar events, map pins, email drafts, phone numbers, and text messages. Links are shown but never opened for you, so you always see where a code points before you decide to follow it.",
    how: "Choose the camera or upload an image. For a live scan, press start, allow camera access, and hold the code steady inside the frame; on phones with a supported rear camera you can switch on the torch, and the deep scan button adds the neural detector to the live loop. To read a saved code, drop an image onto the page, pick a file, or paste a screenshot with Ctrl+V. If the standard decoders come up empty, the deep scan takes over: it locates each code, flattens away perspective and curve, restores contrast, and tries again. The detector is a one time download of about 40 MB that is kept for your next visit. Every decoded code appears with a copy button and, for links, a safe clickable version that opens only on your click.",
    why: "Most online QR readers upload the photo you scanned to their servers, wrap the result in ads, and quietly log every code you decode, which matters when that code is your home Wi-Fi password or a private contact card. This one decodes on your device, so your files and inputs never leave your device, and it never follows a link on your behalf. Even the neural deep scan runs locally in your browser. There is no app to install, no account, and no watermark on what you scanned.",
    faq: [
      {
        q: "Does the image I scan get uploaded anywhere?",
        a: "No. The camera frames and any image you upload are decoded in your browser with a local library, and your files and inputs never leave your device. Nothing about the code you scanned is sent to a server or stored after you close the page.",
      },
      {
        q: "Why will it not just open the link in the code?",
        a: "By design. A QR code can hide a hostile or misleading address behind a short pattern, so the scanner shows you the full decoded link and lets you read it first. Only plain http and https links are ever made clickable, and they open only when you click; a javascript or data payload is shown as inert text.",
      },
      {
        q: "The live camera is not working. What can I do instead?",
        a: "Camera scanning needs permission and a secure connection, and some browsers or locked-down devices block it. If the camera cannot start, the tool falls back to reading an image: take a photo or screenshot of the code and upload, drag, or paste it here, which decodes exactly the same way.",
      },
      {
        q: "What does the deep scan actually do?",
        a: "It runs a small neural network, trained on millions of synthetic photos of distorted codes, that finds each QR code in the image and maps its corners and edge curvature. The code is then digitally flattened, straightened, enlarged, and contrast corrected before the decoders try again. That recovers codes that are tiny in the frame, photographed at an angle, curved around a surface, faded, or partly hidden behind a logo. The model downloads once, is cached for next time, and runs entirely on your device.",
      },
      {
        q: "Can it read more than one code in the same picture?",
        a: "Yes. Every code the scanners find is decoded and listed separately, each with its own fields and copy button. This works in both the camera and the upload modes.",
      },
    ],
  },
};
