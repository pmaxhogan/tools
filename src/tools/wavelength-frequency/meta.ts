import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "wavelength-frequency",
  matrixSlug: "wavelength-frequency-converter",
  icon: "AudioWaveform",
  name: "Wavelength and Frequency Converter",
  description:
    "Convert between frequency and wavelength for any part of the spectrum, with ITU band name, photon energy, and period.",
  category: "RF",
  keywords: [
    "wavelength to frequency calculator",
    "frequency to wavelength calculator",
    "photon energy calculator",
    "itu radio band chart",
    "wavelength calculator",
    "frequency calculator",
    "electromagnetic wave calculator",
  ],
  searchTerms: [
    "c = f lambda calculator",
    "hz to nm converter",
    "nm to hz converter",
    "radio band designations",
    "vhf uhf shf ehf chart",
    "wavelength in cable",
    "velocity factor wavelength",
    "photon energy ev",
    "period of a wave",
    "hydrogen line frequency",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "number",
      id: "velocityFactor",
      label: "Velocity factor for wavelength in cable (1 = free space)",
      default: 1,
      min: 0.1,
      max: 1,
      step: 0.01,
    },
  ],
  examples: [
    { label: "2m band frequency to wavelength", input: "146.52 MHz" },
    { label: "Green light wavelength to frequency", input: "550nm" },
  ],
  http: { method: "GET", contentType: "application/json" },
  copy: {
    what: 'Converts between frequency and wavelength in either direction, for anything from ELF radio up through visible light and beyond, and reports the ITU band designation, the wave period, and the photon energy in electronvolts. Input is a frequency like "146.52 MHz" or "2.4GHz", or a wavelength like "550nm" or "21cm"; the tool figures out which one you typed from the unit.',
    how: "Type a frequency (Hz, kHz, MHz, GHz, or THz) or a wavelength (nm, um, mm, cm, m, or km) and the result shows the other value along with the ITU band name, period, and photon energy. Set a velocity factor below 1 to also see the shortened wavelength inside a cable or medium instead of free space.",
    why: "Most wavelength converters handle only radio frequencies or only optical wavelengths, never both, and skip the ITU band name and photon energy that put the number in context. This one spans the same log axis from ELF up through visible light in one box, with the full band table and physics constants computed exactly, and your inputs never leave your device.",
    faq: [
      {
        q: "Why does a frequency in cable differ from the free space wavelength?",
        a: "Radio waves travel slower inside a cable's dielectric than in free space, by a factor called the velocity factor, typically 0.66 to 0.88 for common coax. A physical wavelength inside the cable is shorter than the free space wavelength by that same factor, which is why antenna and stub lengths built from cable are always shortened from the free space figure.",
      },
      {
        q: "What are the ITU radio band names?",
        a: "The International Telecommunication Union divides the radio spectrum into decade bands from ELF (3 to 30 Hz) up through THF (300 GHz to 3 THz): ELF, SLF, ULF, VLF, LF, MF, HF, VHF, UHF, SHF, EHF, and THF. Each name reflects the frequency decade, and common services map onto them, for example FM broadcast and aircraft radio sit in VHF while Wi-Fi and cellular sit in UHF and SHF. For who is allocated what within each band, see the Electromagnetic Spectrum tool.",
      },
      {
        q: "Why is a bare number without a unit rejected?",
        a: 'A bare number is genuinely ambiguous here: "550" could mean 550 Hz, 550 MHz, or 550 nanometers depending on context, and getting that default wrong would silently produce a nonsense answer. Always include a unit, like "550 MHz" or "550nm".',
      },
    ],
  },
};
