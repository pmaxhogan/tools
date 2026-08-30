import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "nfc-tag-tool",
  icon: "Nfc",
  matrixSlug: "nfc",
  name: "NFC Tag Reader and Writer",
  description:
    "Encode and decode NFC tag records, text, URLs, Wi-Fi credentials, vCards, and more, and write them from Android Chrome.",
  category: "Hardware",
  keywords: [
    "nfc tag writer",
    "write nfc tag online",
    "web nfc",
    "ndef writer",
    "read nfc tag chrome android",
    "nfc url tag",
  ],
  searchTerms: [
    "ndef reader",
    "nfc wifi tag",
    "wifi simple config",
    "nfc business card",
    "vcard nfc tag",
    "android application record",
    "nfc smart tag",
    "ntag213",
    "ntag215",
    "ntag216",
    "mifare ultralight",
    "make nfc tag read only",
    "web nfc api demo",
    "nfc chip programmer",
    "ndef message builder",
    "nfc sticker",
    "topaz 512",
    "nfc tag decoder",
    "tagwriter alternative",
  ],
  input: "text/plain",
  output: "application/json",
  requires: ["nfc"],
  privacyNote:
    "Tag contents are read and written by your phone directly; nothing is sent to this site.",
  options: [
    {
      kind: "select",
      id: "kind",
      label: "Record kind",
      default: "text",
      groups: [
        {
          label: "Content",
          synonyms: ["basic", "note"],
          options: [
            { value: "text", label: "Text", synonyms: ["plain text", "note", "message"] },
            {
              value: "empty",
              label: "Empty (lock or erase)",
              synonyms: ["blank", "erase", "clear"],
            },
          ],
        },
        {
          label: "Web and Wi-Fi",
          synonyms: ["internet", "network"],
          options: [
            { value: "url", label: "URL", synonyms: ["website", "link", "web address"] },
            {
              value: "wifi",
              label: "Wi-Fi credential",
              synonyms: ["wifi password", "wpa2", "network", "wifi tag"],
            },
          ],
        },
        {
          label: "Contact and location",
          synonyms: ["people", "places"],
          options: [
            { value: "vcard", label: "vCard contact", synonyms: ["business card", "contact card"] },
            { value: "geo", label: "Geo location", synonyms: ["coordinates", "gps", "lat lon"] },
          ],
        },
        {
          label: "Communication",
          synonyms: ["contact info", "reach out"],
          options: [
            { value: "tel", label: "Phone number", synonyms: ["call", "telephone"] },
            { value: "mailto", label: "Email address", synonyms: ["e-mail", "mail"] },
            { value: "sms", label: "SMS", synonyms: ["text message"] },
          ],
        },
        {
          label: "Advanced",
          synonyms: ["android", "raw"],
          options: [
            {
              value: "app",
              label: "Android app (AAR)",
              synonyms: ["android application record", "package name", "play store"],
            },
            {
              value: "raw-hex-decode",
              label: "Decode hex bytes",
              synonyms: ["decode", "parse", "read a scanned tag", "hex to record"],
            },
          ],
        },
      ],
    },
  ],
  copy: {
    what: "A pure NDEF encoder and decoder for NFC tags: text, URLs, Wi-Fi credentials, vCard contacts, geo coordinates, phone numbers, email addresses, SMS drafts, and Android app launch records. It builds the exact record bytes the NFC Forum's NDEF format defines, including the URL prefix abbreviation table and the Wi-Fi Simple Configuration TLVs that a phone's Wi-Fi settings screen understands, and it checks the result against the usable capacity of common tag chips: NTAG213, NTAG215, NTAG216, Mifare Ultralight and Topaz 512. Paste a hex dump from a scanned tag and it decodes the record back into readable fields the same way.",
    how: "Pick a record kind, type the value, and the tool shows the record type, a payload preview, the NDEF bytes as hex, the size, and which common tags it fits on. On an Android phone in Chrome, the write panel does the actual radio work: tap Scan to read a tag with the same decoder, or tap Write to send the composed message with NDEFReader, with a clearly labeled make read only option since locking a tag cannot be undone. On desktop or any other browser the page explains that Web NFC is Android Chrome only rather than pretending to work.",
    why: "Most NFC writer apps are phone only, ad supported, and give no way to see the exact bytes going onto the tag. This runs the same NDEF encoder in a page you already trust, shows the raw hex before you write anything, and warns about tag capacity before you find out the hard way that a long URL does not fit an NTAG213. Reading and writing use the phone's own Web NFC radio, so your files and inputs never leave your device: tag contents are read and written by your phone directly, and nothing about the tag or its contents is sent to this site.",
    faq: [
      {
        q: "Which phones and browsers does this work on?",
        a: "Web NFC, the browser API that talks to the phone's NFC radio, currently ships only in Chrome on Android. It is not available in Safari, Firefox, or any browser on iOS, and not in desktop Chrome either, since desktops rarely have an NFC reader. This page still works everywhere for building and decoding NDEF bytes by hand. The live scan and write panel checks for the API and shows an honest message instead of a broken button when it is missing.",
      },
      {
        q: "Can I write a Wi-Fi tag that connects a phone automatically?",
        a: "Yes. Choose the Wi-Fi credential kind, enter the network name, password, and security type as ssid;password;WPA2, and the tool builds a Wi-Fi Simple Configuration record: the same MIME record type and TLV layout Android and other phones read to offer one-tap connect when they tap the tag. WPA2 is the default security type; WPA, WEP, WPA/WPA2, and open networks are also supported.",
      },
      {
        q: "Can this lock an NFC tag so it can never be changed again?",
        a: "The write panel exposes NDEFReader's makeReadOnly option behind its own checkbox, separate from the write button, with a clear warning next to it. Making a tag read only is permanent: once set, no device, including this one, can ever write to that tag again. Leave the checkbox off unless you are certain the tag's final content is correct.",
      },
    ],
  },
};
