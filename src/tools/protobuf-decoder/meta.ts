import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "protobuf-decoder",
  matrixSlug: "binary-decode",
  icon: "FileDigit",
  name: "Binary Format Decoder",
  description: "Decode protobuf, CBOR, and msgpack payloads to readable JSON in your browser.",
  category: "Files",
  keywords: [
    "protobuf decoder online",
    "decode protobuf without schema",
    "cbor decoder",
    "msgpack decoder",
    "protobuf wire format",
    "binary to json converter",
    "decode protobuf from base64",
  ],
  searchTerms: [
    "protocol buffers decoder",
    "proto decoder",
    "protobuf viewer",
    "protoscope",
    "messagepack decoder",
    "message pack viewer",
    "cbor diagnostic notation",
    "rfc 8949 decoder",
    "grpc payload decoder",
    "decode binary payload",
    "hex to json",
    "wire format inspector",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "format",
      label: "Format",
      default: "auto",
      options: [
        {
          value: "auto",
          label: "Auto detect",
          synonyms: ["automatic", "guess", "detect", "sniff", "any", "unknown"],
        },
        {
          value: "protobuf",
          label: "Protobuf",
          synonyms: [
            "proto",
            "pb",
            "protocol buffers",
            "wire format",
            "grpc",
            "protoscope",
            "protobuffer",
          ],
        },
        {
          value: "cbor",
          label: "CBOR",
          synonyms: [
            "concise binary object representation",
            "rfc 8949",
            "rfc 7049",
            "cose",
            "webauthn",
          ],
        },
        {
          value: "msgpack",
          label: "MessagePack",
          synonyms: ["msgpack", "message pack", "mp", "messagepack", "msg pack"],
        },
      ],
    },
  ],
  copy: {
    what: "Turns a binary payload into readable JSON. It handles protobuf, CBOR, and MessagePack, and by default it works out which one you gave it by trying all three and keeping the decoder that consumed every byte. Protobuf is decoded straight from the wire format with no .proto file, so you get field numbers, wire types, nested messages, repeated fields, and 64 bit values kept exact as decimal strings. CBOR and MessagePack come back with their byte strings shown as a hex preview, their timestamps as ISO dates, and their bignums intact, so nothing is quietly rounded or dropped.",
    how: "Drop the payload as a file, or paste it as base64, base64url, or a hex dump with any spacing and an optional 0x prefix. Leave Format on Auto detect for an unknown blob, or pin it to Protobuf, CBOR, or MessagePack when you already know and want the exact decoder error if it does not parse. The result lists the format it picked and why, the byte length, the top level field count for protobuf, and the decoded JSON in a copyable block.",
    why: "Most binary decoders online want an upload, and a protobuf payload from production is usually the last thing you want to hand to a stranger's server. This one runs entirely in the page, so your files and inputs never leave your device, and it keeps working offline after the first load. It also does not ask for a .proto schema, which is the step that stops every other protobuf tool cold when you are staring at a captured request. No sign in, no size gate at a few kilobytes, and no ads over the output.",
    faq: [
      {
        q: "Can it decode protobuf without the .proto file?",
        a: 'Yes. The protobuf wire format stores a field number and a wire type for each value, never the field name or the declared type, so a decoder without a schema can recover the whole structure but has to label fields by number. You get keys like "3 (message)" and "4 (varint)" instead of names. A length delimited field could be a string, a nested message, or raw bytes, and the wire format does not say which, so it is resolved by shape: printable text with no control characters is shown as a string, otherwise a payload that parses cleanly as fields is shown as a nested message, then text with line breaks in it, and a hex preview last.',
      },
      {
        q: "Why do CBOR and MessagePack sometimes both decode the same bytes?",
        a: "They are different formats with overlapping byte patterns. A CBOR map header and a MessagePack fixed string header share the 0xa0 to 0xbf range, for example, so a short payload can be entirely valid in both. When more than one decoder consumes every byte, the tool shows an Also decodes as row so you know the answer is a best guess, and you can pin the format yourself to settle it.",
      },
      {
        q: "Is anything uploaded?",
        a: "No. The whole decode runs in your browser, so your files and inputs never leave your device. There is no account, no queue, and no server side copy of the payload.",
      },
    ],
  },
};
