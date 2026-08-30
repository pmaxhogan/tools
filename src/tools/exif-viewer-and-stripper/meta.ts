import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "exif-viewer-and-stripper",
  icon: "ImageMinus",
  name: "EXIF Viewer and Stripper",
  description:
    "See every EXIF, XMP and IPTC field in a photo, then export a clean copy with all of it removed.",
  category: "Images",
  keywords: [
    "exif viewer",
    "exif remover",
    "remove metadata from photo",
    "strip exif online",
    "photo gps location viewer",
    "remove gps from photo",
    "xmp viewer",
    "iptc metadata viewer",
  ],
  searchTerms: [
    "exiftool online",
    "does my photo have location data",
    "clear metadata before posting",
    "png text chunk viewer",
    "webp exif",
    "camera serial number in photo",
    "embedded thumbnail extract",
    "photo metadata privacy",
    "batch remove exif",
  ],
  input: "image/*",
  output: "application/json",
  options: [
    {
      kind: "boolean",
      id: "showAll",
      label: "Show every tag",
      default: false,
    },
    {
      kind: "boolean",
      id: "strip",
      label: "Also write a cleaned copy",
      default: false,
    },
  ],
  examples: [{ label: "Photo with EXIF, GPS, XMP and IPTC", file: "sample-photo.jpg" }],
  copy: {
    what: "Reads the metadata blocks a photo carries and shows them in full: the TIFF directories inside EXIF (IFD0, the Exif sub directory, GPS, Interop, and the IFD1 thumbnail), the raw XMP packet, IPTC records from a Photoshop APP13 segment, PNG tEXt, zTXt, iTXt and eXIf chunks, and the EXIF and XMP chunks in a WebP. Rationals are shown the way a photographer writes them (1/250 s, f/5.6, 35 mm), enumerations are spelled out, GPS is converted to decimal degrees with a map link, and the embedded preview is displayed. Stripping rewrites the file without those blocks, and without recompressing a single pixel.",
    how: "Drop one photo or a whole folder of them. The report opens with the fields most people are looking for, and a toggle shows every tag including the vendor ones. Turn on the strip step to get a cleaned copy of each file, downloadable one at a time or as a zip. The segment list at the bottom shows exactly which byte ranges are metadata and which are picture, so you can see what a strip would remove before you run it.",
    why: 'A photo off a phone usually carries the exact time, the camera serial number, and the coordinates of where it was taken, and most EXIF removers ask you to upload it to their server to find that out. This one reads and rewrites the bytes in your browser, so your files and inputs never leave your device. Stripping here also does not recompress: the usual "convert to JPEG to remove EXIF" workflow costs you a generation of quality, and this does not.',
    faq: [
      {
        q: "Does stripping change how the image looks?",
        a: "No. The compressed image data is copied byte for byte and only the metadata blocks around it are dropped, so the pixels are identical. Two things are kept on purpose: an ICC color profile, because removing it visibly shifts color, and the APP14 Adobe marker, because some decoders need it to read the channel order correctly.",
      },
      {
        q: "What is actually in my photo's metadata?",
        a: "Typically the camera or phone make and model, the lens, the exact date and time down to the second, every exposure setting, the software that last touched the file, and very often GPS coordinates accurate to a few meters. Many cameras also embed a small JPEG preview, which can still show the original framing after a crop, and a maker note block full of vendor specific settings.",
      },
      {
        q: "Which formats can it strip?",
        a: "JPEG, PNG, and WebP. A bare TIFF is read but not stripped, because in a TIFF the same directories that hold the metadata also point at the image data, so removing them would remove the picture. HEIC and AVIF are read by neither yet: they keep metadata inside an ISO box structure this tool does not walk.",
      },
    ],
  },
};
