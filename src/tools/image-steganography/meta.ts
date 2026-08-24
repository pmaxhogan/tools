import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "image-steganography",
  matrixSlug: "stego",
  icon: "EyeOff",
  name: "Image Steganography",
  description: "Hide and recover data inside image pixels.",
  category: "Images",
  keywords: [
    "steganography online",
    "hide text in image",
    "lsb steganography",
    "hide file in image",
    "extract hidden message from image",
    "image steganography decoder",
    "png steganography tool",
  ],
  searchTerms: [
    "stego",
    "steg",
    "least significant bit",
    "hidden message",
    "secret message in picture",
    "conceal data",
    "watermark bits",
    "bit plane viewer",
    "steghide alternative",
    "decode hidden image data",
    "png steganography",
    "invisible watermark",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "mode",
      label: "Mode",
      default: "hide",
      options: [
        {
          value: "hide",
          label: "Hide data in an image",
          synonyms: ["embed", "encode", "write", "conceal", "insert", "hide message"],
        },
        {
          value: "reveal",
          label: "Reveal data from an image",
          synonyms: ["extract", "decode", "read", "recover", "find", "reveal message"],
        },
      ],
    },
    {
      kind: "select",
      id: "bits",
      label: "Bits per channel",
      default: "1",
      options: [
        {
          value: "1",
          label: "1 bit, invisible",
          synonyms: ["one", "lsb", "single", "safest", "least significant bit"],
        },
        {
          value: "2",
          label: "2 bits, twice the capacity",
          synonyms: ["two", "double", "more space", "bigger payload"],
        },
      ],
    },
    {
      kind: "select",
      id: "channels",
      label: "Channels used",
      default: "rgb",
      options: [
        {
          value: "rgb",
          label: "Red, green, and blue",
          synonyms: ["colour", "color", "all colors", "default", "three channels"],
        },
        {
          value: "rgba",
          label: "Red, green, blue, and alpha",
          synonyms: ["with alpha", "transparency", "four channels", "most capacity"],
        },
        {
          value: "r",
          label: "Red only",
          synonyms: ["red channel", "single channel", "r"],
        },
        {
          value: "g",
          label: "Green only",
          synonyms: ["green channel", "single channel", "g"],
        },
        {
          value: "b",
          label: "Blue only",
          synonyms: ["blue channel", "single channel", "b", "least visible"],
        },
      ],
    },
  ],
  copy: {
    what: "Hides a message or a whole file in the least significant bits of an image, and reads it back out again. Every pixel channel has a lowest bit that changes its value by one step out of 256, which no eye can see, so a photo can carry a few kilobytes of text without looking any different. The hidden data starts with a small header holding the settings, the payload length, and a CRC32 checksum, which means the reader works out the bit depth and channels on its own and tells you when an image has been altered since the data went in. An optional password runs the payload through a SHA-256 keystream first, and the bit plane view shows you exactly what the low bits of your image look like before and after.",
    how: "Pick Hide, drop a PNG in the panel, type your message or attach a file, and download the result as PNG. To read one back, pick Reveal and drop the stego image in: the settings come from the header, so there is nothing to remember except the password if you used one. The capacity meter shows how much the image can hold before you paste, and raising the bits per channel to 2 doubles it at the cost of a slightly noisier low bit plane.",
    why: "Steganography sites are the worst category on the web for uploads: your carrier image and your secret both get posted to somebody's server, which defeats the entire point of hiding the message in the first place. This one runs in the tab, so your files and inputs never leave your device, and the format is documented rather than proprietary, so you can see exactly what was written. There is no size cap beyond what the image can physically hold, no watermark, no account, and the tool tells you honestly what the password does and does not protect you from.",
    faq: [
      {
        q: "Is this actually secure?",
        a: "It hides data, which is not the same as protecting it. Least significant bit embedding is well known and steganalysis tools detect it easily: the low bit plane of an edited image has statistical fingerprints, and chi-square or RS analysis will flag a filled image in seconds. The optional password adds lightweight encryption, a SHA-256 keystream with a random nonce, so someone who finds the payload cannot read it without guessing the password. There is no key stretching and no authentication tag, so a short or common password is brute forceable offline. If the content genuinely matters, encrypt it properly first with an encrypted archive or age, then hide the ciphertext here.",
      },
      {
        q: "Why do I have to save the result as PNG?",
        a: "Because the message lives in the exact value of every pixel, and JPEG does not preserve exact pixel values. JPEG, lossy WebP, AVIF, and HEIC all rewrite the image during encoding, and GIF reduces it to 256 colors, and every one of those steps wipes the low bits and takes your data with them. PNG is lossless, so the pixels you download are the pixels that come back. The same applies after the download: resizing, cropping, screenshotting, or letting a chat app recompress the file destroys the payload, so send the PNG as a file attachment rather than as an inline image.",
      },
      {
        q: "How much can I hide in one image?",
        a: "One bit per channel over red, green, and blue gives you three bits per pixel, so a 1000 by 1000 image holds about 375 KB, minus a 13 byte header, or 21 bytes when a password is used. Two bits per channel doubles that to about 750 KB. Adding the alpha channel adds another third again. The panel shows the exact number for the image you loaded, and a message longer than the space available is refused with the two figures rather than silently truncated.",
      },
    ],
  },
};
