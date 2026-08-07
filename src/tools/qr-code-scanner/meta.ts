import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'qr-code-scanner',
  name: 'QR Code Scanner',
  description:
    'Scan a QR code with your camera or from an image, then read the decoded link, Wi-Fi login, contact, or location without leaving the page.',
  category: 'QR',
  keywords: [
    'qr code scanner',
    'qr code reader',
    'scan qr code online',
    'read qr code from image',
    'qr scanner camera',
    'decode qr code',
    'free qr scanner no app',
  ],
  searchTerms: [
    'scan qr code',
    'read qr',
    'qr reader',
    'qr scanner',
    'decode qr',
    'qr code reader from photo',
    'webcam qr scanner',
    'upload qr code',
  ],
  input: 'image/*',
  output: 'text/plain',
  requires: ['camera'],
  options: [
    {
      kind: 'select',
      id: 'inversion',
      label: 'Color handling',
      default: 'attemptBoth',
      choices: [
        { value: 'attemptBoth', label: 'Standard and inverted' },
        { value: 'dontInvert', label: 'Standard only (dark on light)' },
        { value: 'onlyInvert', label: 'Inverted only (light on dark)' },
      ],
    },
  ],
  copy: {
    what: 'Reads a QR code and shows you what is inside it. Point your camera at a code for a live scan, or upload, drag, or paste an image of one, and the decoder runs entirely in your browser. When the payload is a known shape it is broken into labelled fields you can read at a glance: web links, Wi-Fi logins with the network name and password, contact cards, calendar events, map pins, email drafts, phone numbers, and text messages. Links are shown but never opened for you, so you always see where a code points before you decide to follow it.',
    how: 'Choose the camera or upload an image. For a live scan, press start, allow camera access, and hold the code flat and steady inside the frame; on phones with a supported rear camera you can switch on the torch for a dark room. To read a saved code, drop an image onto the page, pick a file, or paste a screenshot with Ctrl+V. The decoded content appears the moment a code is recognised, with a copy button and, for links, a safe clickable version that opens only on your click.',
    why: 'Most online QR readers upload the photo you scanned to their servers, wrap the result in ads, and quietly log every code you decode, which matters when that code is your home Wi-Fi password or a private contact card. This one decodes on your device, so your files and inputs never leave your device, and it never follows a link on your behalf. There is no app to install, no account, and no watermark on what you scanned.',
    faq: [
      {
        q: 'Does the image I scan get uploaded anywhere?',
        a: 'No. The camera frames and any image you upload are decoded in your browser with a local library, and your files and inputs never leave your device. Nothing about the code you scanned is sent to a server or stored after you close the page.',
      },
      {
        q: 'Why will it not just open the link in the code?',
        a: 'By design. A QR code can hide a hostile or misleading address behind a short pattern, so the scanner shows you the full decoded link and lets you read it first. Only plain http and https links are ever made clickable, and they open only when you click; a javascript or data payload is shown as inert text.',
      },
      {
        q: 'The live camera is not working. What can I do instead?',
        a: 'Camera scanning needs permission and a secure connection, and some browsers or locked-down devices block it. If the camera cannot start, the tool falls back to reading an image: take a photo or screenshot of the code and upload, drag, or paste it here, which decodes exactly the same way.',
      },
    ],
  },
};
