import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'background-remover',
  icon: 'Eraser',
  matrixSlug: 'remove-bg',
  name: 'Background Remover',
  description: 'Cut people out of photos locally, with no credits and no uploads.',
  category: 'Local AI',
  keywords: [
    'remove background from photo free',
    'background remover no upload',
    'cut out person from photo',
    'transparent background maker',
    'local background removal',
    'portrait matting in browser',
  ],
  searchTerms: [
    'remove bg',
    'transparent png maker',
    'photo cutout tool',
    'image matting',
    'background eraser',
    'alpha matte',
    'silhouette cutout',
    'erase photo background',
    'modnet',
    'clip person from photo',
  ],
  input: 'image/*',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'output',
      label: 'Background',
      default: 'transparent',
      choices: [
        { value: 'transparent', label: 'Transparent PNG' },
        { value: 'white', label: 'White' },
        { value: 'color', label: 'Custom color' },
      ],
    },
    {
      kind: 'text',
      id: 'bgColor',
      label: 'Custom color',
      default: '#ffffff',
      placeholder: '#ffffff',
    },
    {
      kind: 'boolean',
      id: 'featherEdges',
      label: 'Feather edges',
      default: true,
    },
  ],
  copy: {
    what: 'Runs MODNet, an open portrait matting model, inside your browser tab to separate a person from the background of a photo. The model predicts a soft alpha matte rather than a hard outline, so hair and fuzzy edges survive instead of turning into a jagged silhouette. You get the cutout as a transparent PNG, or composited onto white or any hex color as a JPEG. MODNet was trained on portraits, so it is strong on people and noticeably weaker on products, pets, and busy objects.',
    how: 'Drop a photo onto the panel or pick one with the file button, then press Load model to fetch the 6.3 MB of weights once. Press Remove background and the cutout appears next to the original on a checkerboard so you can see exactly what the alpha channel is doing. Choose the background you want, leave feathering on unless the edge looks too soft, then download the result.',
    why: 'The best known background remover charges per image and needs your photo uploaded to its servers before it will show you anything above thumbnail size. This one downloads an open portrait matting model once, runs it in the tab you already have open, and your files and inputs never leave your device. The honest trade is quality: on a person against a normal background it holds its own, and on a product shot or a complicated object a paid service will usually beat it.',
    faq: [
      {
        q: 'Why do product shots come out worse than photos of people?',
        a: 'MODNet is a portrait matting model. It was trained to find a human subject and predict the soft alpha around hair and clothing, so that is what it looks for in every image you give it. A bottle, a chair, or a pet has none of the cues it learned, so the matte gets vague and the edges wander. For non human subjects, the manual selection in a normal image editor is often faster than fixing what this returns.',
      },
      {
        q: 'What image size can it handle?',
        a: 'Anything up to 4096 pixels on the longest side. Larger photos are scaled down to that limit first, and the panel tells you when it does. The model itself always sees a smaller copy, around 512 pixels on the shortest side, which is what it was trained at. The matte is then scaled back up and applied to the full size photo, so the file you download keeps its original resolution.',
      },
      {
        q: 'Are my photos uploaded anywhere?',
        a: 'No. The model weights are downloaded from this site to your browser once, and every pixel of your photo is read, matted, and re-encoded inside the tab. Your files and inputs never leave your device, and once the weights are cached the tool keeps working with the network off.',
      },
    ],
  },
};
