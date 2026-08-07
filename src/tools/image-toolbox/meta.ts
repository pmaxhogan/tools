import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'image-toolbox',
  matrixSlug: 'image-tools',
  name: 'Image Toolbox',
  description:
    'Inspect image metadata, view and strip EXIF, and convert or resize with the editor panel.',
  category: 'Images',
  keywords: [
    'exif viewer',
    'exif remover',
    'image metadata viewer',
    'strip exif online',
    'image dimensions checker',
    'does my photo have gps data',
    'remove gps from photo',
    'check image resolution',
  ],
  searchTerms: [
    'exiftool online',
    'photo geotag checker',
    'remove metadata from photo',
    'image resizer',
    'image cropper',
    'convert image format',
    'png to jpg',
    'jpg to webp',
    'check image size in pixels',
    'gps data in photo',
  ],
  input: 'image/*',
  output: 'application/json',
  options: [
    {
      kind: 'boolean',
      id: 'stripExif',
      label: 'Strip metadata (EXIF, XMP, IPTC, comments)',
      default: false,
    },
  ],
  copy: {
    what: 'Reads an image header directly and reports what is really inside it: format, exact pixel dimensions, megapixels, aspect ratio, bit depth and color type, progressive or interlaced encoding, animation frame count, and file size. It parses PNG, JPEG, GIF, WebP, BMP, ICO, and SVG by hand, then reads any EXIF, IPTC, or XMP block for camera, lens, capture time, exposure, orientation, and GPS coordinates. Turn on the strip option and it rewrites the file without its metadata segments, keeping every pixel byte for byte. The editor panel on the same page handles resizing, cropping, and converting between formats.',
    how: 'Drop an image onto the input, paste one from your clipboard, or pick a file. The metadata rows appear immediately, with a copy button on each one. Tick "Strip metadata" to get a cleaned copy of the file as a downloadable data URL, along with a list of exactly which segments were removed and how many bytes that saved.',
    why: 'Most EXIF viewers and EXIF removers work by uploading your photo to their server, which is precisely the wrong thing to do with a file that may contain the GPS coordinates of your home. This one reads and rewrites the bytes in your browser: your files and inputs never leave your device. There is no size cap, no watermark, no signup, and stripping does not recompress the image the way a "convert to remove EXIF" workflow does.',
    faq: [
      {
        q: 'Does stripping EXIF recompress my photo?',
        a: 'No. The tool copies the compressed image data byte for byte and only deletes the metadata segments around it: APP1 (Exif and XMP), APP13 (IPTC), and comment segments in a JPEG, or the eXIf, tEXt, zTXt, and iTXt chunks in a PNG. Quality is identical, and any embedded ICC color profile is deliberately kept so colors still render correctly.',
      },
      {
        q: 'What can EXIF data reveal about me?',
        a: 'Typically the camera or phone make and model, the lens, the exact date and time the shot was taken, exposure settings, the editing software used, and very often precise GPS latitude and longitude. Phones geotag by default, so a photo posted straight from a camera roll can pin down a home or workplace to within a few meters.',
      },
      {
        q: 'Are my photos uploaded anywhere?',
        a: 'No. The header parsing, the EXIF reading, and the metadata stripping all run in your browser, so your files and inputs never leave your device. The page also keeps working offline after the first load.',
      },
    ],
  },
};
