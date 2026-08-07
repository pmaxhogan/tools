import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'electromagnetic-spectrum',
  name: 'Electromagnetic Spectrum',
  description:
    'An interactive, to scale map of the electromagnetic spectrum from gamma rays to ELF radio, with live frequency, wavelength, energy and color readouts.',
  category: 'Science',
  keywords: [
    'electromagnetic spectrum',
    'wavelength frequency converter',
    'photon energy calculator',
    'visible light wavelength',
    'radio frequency bands',
    'light spectrum chart',
    'gamma xray uv infrared microwave',
  ],
  searchTerms: [
    'light spectrum',
    'radio spectrum',
    'wavelength frequency converter',
    'photon energy',
    'gamma xray uv infrared microwave',
    'ITU bands',
    'visible light nm',
    'blackbody temperature',
    'em spectrum',
    'frequency to wavelength',
    'ev to nm',
    'color to wavelength',
  ],
  icon: 'Rainbow',
  input: 'none',
  output: 'application/json',
  options: [
    {
      kind: 'text',
      id: 'query',
      label: 'Jump to (frequency, wavelength, or energy)',
      default: '550 nm',
      placeholder: '2.45 GHz, 550 nm, 10 keV',
    },
  ],
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'A single interactive chart of the whole electromagnetic spectrum, drawn to scale on a log frequency axis from the highest energy gamma rays down to ELF radio. Hover or tap anywhere to read the exact frequency, wavelength, photon energy in electronvolts, the black-body peak temperature, and the band under the pointer, with its common real world uses. Visible wavelengths show their approximate color. Nested bands cover X-ray, UV, the visible colors, the infrared subdivisions, the ITU radio bands, and named allocations like FM broadcast, Wi-Fi, GPS, and 5G.',
    how: 'Move the pointer across the spectrum to update the live readout, or tap on touch to pin it. Zoom with Ctrl and scroll or a pinch, and pan by dragging, scrolling, or swiping. Type a frequency (2.45 GHz), a wavelength (550 nm, 21 cm, 1 mile), or a photon energy (10 keV) into the jump box to fly straight to that point. Export the current view as a PNG or a vector SVG, and share the exact view with the link, which carries the center and zoom in its fragment.',
    why: 'Most spectrum charts online are flat static images with no way to read a precise value, convert between units, or zoom into the crowded radio bands. This one is live and exact: every readout comes from the real physical constants, and the whole thing runs in your browser, so your files and inputs never leave your device. It is free of ads, sign up walls, and export limits.',
    faq: [
      {
        q: 'How do you convert between frequency, wavelength, and energy?',
        a: 'Wavelength is the speed of light divided by frequency. Photon energy is Planck constant times frequency, shown in electronvolts by dividing by the elementary charge. The chart uses the exact 2019 SI values for these constants, so a green photon near 550 nm reads as about 545 THz and 2.25 eV.',
      },
      {
        q: 'What counts as ionizing radiation here?',
        a: 'The chart flags radiation as ionizing at or above about 10 electronvolts, which is roughly the hard ultraviolet boundary and up through X-rays and gamma rays. The real threshold is not a sharp line: it depends on the molecule and sits somewhere between 10 and 33 eV, so the flag is labeled as approximate.',
      },
      {
        q: 'Why are Wi-Fi and FM radio in different top level bands?',
        a: 'The chart nests the ITU bands under two top level groups: Radio holds ELF through VHF (3 Hz to 300 MHz), and Microwave holds UHF, SHF, and EHF (300 MHz to 300 GHz), because those upper ITU bands are exactly the microwave region. FM broadcast at 88 to 108 MHz sits in VHF under Radio, while 2.4 GHz Wi-Fi sits in UHF under Microwave.',
      },
    ],
  },
};
