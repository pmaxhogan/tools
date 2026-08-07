/**
 * Physical constants and the hierarchical band dataset for the
 * Electromagnetic Spectrum explorer.
 *
 * This module is pure data: no imports, no side effects. `index.ts` imports the
 * constants and the band tree from here (one direction only, so there is no
 * import cycle).
 *
 * Constants are the 2019 SI exact values.
 */

/** Speed of light in vacuum, meters per second (exact). */
export const C = 299_792_458;
/** Planck constant, joule seconds (exact). */
export const H = 6.626_070_15e-34;
/** Elementary charge, coulombs (exact). */
export const E_CHARGE = 1.602_176_634e-19;
/** Wien displacement law constant, meter kelvin (CODATA). */
export const WIEN_B = 2.897_771_955e-3;

/**
 * The full modeled frequency range, in hertz. The axis runs from the top of the
 * gamma region (about 12 GeV photons) down to the bottom of the ELF radio band
 * (3 Hz). Every band below sits inside this range and the renderer maps
 * frequency onto a log10 axis across exactly these bounds.
 */
export const AXIS_MIN_HZ = 3; // ELF floor
export const AXIS_MAX_HZ = 3e24; // top of the modeled gamma region

/**
 * The approximate photon energy, in electronvolts, at or above which radiation
 * is generally considered ionizing. The real boundary is not sharp: it depends
 * on the molecule and sits somewhere in the 10 to 33 eV region (hard UV and up).
 * We use 10 eV and label it as approximate everywhere it is shown.
 */
export const IONIZING_EV = 10;

/** One node in the spectrum tree. Ranges are frequency in hertz, fLow < fHigh. */
export interface Band {
  /** Stable id, unique across the whole tree. */
  id: string;
  /** Display name. */
  name: string;
  /** Lower frequency bound in hertz (the longer wavelength edge). */
  fLow: number;
  /** Upper frequency bound in hertz (the shorter wavelength edge). */
  fHigh: number;
  /** Common real world uses, plain sentences with no dashes. */
  uses: string[];
  /** Approximate display color for a swatch (visible sub-bands only). */
  color?: string;
  /** Nested sub-bands, if any. A parent always encloses its children. */
  children?: Band[];
}

/* ------------------------------------------------------------------ */
/* Wavelength helpers, used only to author the table accurately.       */
/* ------------------------------------------------------------------ */

const fromWavelength = (meters: number): number => C / meters;
const nm = (v: number): number => fromWavelength(v * 1e-9);
const um = (v: number): number => fromWavelength(v * 1e-6);

/**
 * The band tree, ordered highest energy (gamma) first down to lowest (ELF), the
 * same order the renderer draws from the start of the axis.
 *
 * Boundary conventions (chosen for a clean, non overlapping partition at every
 * level, then noted so the choices are auditable):
 *   Gamma / X-ray  split at 10 pm (about 124 keV).
 *   X-ray          soft 0.1 to 10 nm, hard 0.01 to 0.1 nm.
 *   Ultraviolet    EUV 10 to 100 nm, UVC 100 to 280, UVB 280 to 315, UVA 315 to 400.
 *   Visible        380 to 750 nm, split into the usual color names.
 *   Infrared       ISO 20473: near 0.78 to 3 um, mid 3 to 50, far 50 to 1000.
 *   Microwave      1 mm to 1 m (300 MHz to 300 GHz), carrying the ITU UHF, SHF, EHF names.
 *   Radio          3 Hz to 300 MHz, carrying ITU ELF through VHF.
 *
 * The "Radio versus Microwave" split is a deliberate choice: the ITU bands UHF,
 * SHF and EHF are exactly the microwave region, so they are nested under
 * Microwave rather than Radio. Radio holds ELF through VHF. Broadcast
 * allocations (FM 88 to 108 MHz, AM 530 to 1700 kHz, UHF TV 470 to 698 MHz) are
 * United States allocations and labeled as broadcast bands.
 */
export const BANDS: Band[] = [
  {
    id: 'gamma',
    name: 'Gamma rays',
    fLow: nm(0.01), // 10 pm, meets the hard X-ray edge exactly
    fHigh: AXIS_MAX_HZ,
    uses: [
      'Cancer radiotherapy',
      'PET and nuclear medicine imaging',
      'Sterilizing medical equipment and food',
      'Nuclear physics and gamma ray astronomy',
    ],
  },
  {
    id: 'xray',
    name: 'X-rays',
    fLow: nm(10),
    fHigh: nm(0.01),
    uses: ['Medical imaging', 'Security scanning', 'Crystallography', 'X-ray astronomy'],
    children: [
      {
        id: 'xray-hard',
        name: 'Hard X-rays',
        fLow: nm(0.1),
        fHigh: nm(0.01),
        uses: [
          'Radiography and CT scanning',
          'Airport and cargo security scanners',
          'Industrial inspection of metal parts',
        ],
      },
      {
        id: 'xray-soft',
        name: 'Soft X-rays',
        fLow: nm(10),
        fHigh: nm(0.1),
        uses: [
          'X-ray microscopy',
          'Semiconductor and materials inspection',
          'Soft X-ray astronomy',
        ],
      },
    ],
  },
  {
    id: 'uv',
    name: 'Ultraviolet',
    fLow: nm(400),
    fHigh: nm(10),
    uses: ['Sterilization', 'Fluorescence', 'Curing inks and resins', 'Chip lithography'],
    children: [
      {
        id: 'uv-euv',
        name: 'Extreme UV (EUV)',
        fLow: nm(100),
        fHigh: nm(10),
        uses: ['EUV lithography for advanced chips', 'Solar physics', 'Plasma research'],
      },
      {
        id: 'uv-uvc',
        name: 'UVC',
        fLow: nm(280),
        fHigh: nm(100),
        uses: ['Germicidal lamps', 'Drinking water disinfection', 'Air purification'],
      },
      {
        id: 'uv-uvb',
        name: 'UVB',
        fLow: nm(315),
        fHigh: nm(280),
        uses: ['Vitamin D synthesis in skin', 'Cause of sunburn', 'Skin condition phototherapy'],
      },
      {
        id: 'uv-uva',
        name: 'UVA',
        fLow: nm(400),
        fHigh: nm(315),
        uses: ['Black lights', 'Tanning beds', 'Curing gel nail polish and adhesives'],
      },
    ],
  },
  {
    id: 'visible',
    name: 'Visible light',
    fLow: nm(750),
    fHigh: nm(380),
    uses: ['Human vision', 'Photography and displays', 'Optical fiber test signals', 'Lighting'],
    children: [
      {
        id: 'vis-violet',
        name: 'Violet',
        fLow: nm(450),
        fHigh: nm(380),
        color: '#7f3ff2',
        uses: ['The shortest wavelengths people can see'],
      },
      {
        id: 'vis-blue',
        name: 'Blue',
        fLow: nm(485),
        fHigh: nm(450),
        color: '#2b58ff',
        uses: ['Blue LEDs and laser diodes', 'Scatters most in the daytime sky'],
      },
      {
        id: 'vis-cyan',
        name: 'Cyan',
        fLow: nm(500),
        fHigh: nm(485),
        color: '#00c9d6',
        uses: ['A printing primary color'],
      },
      {
        id: 'vis-green',
        name: 'Green',
        fLow: nm(565),
        fHigh: nm(500),
        color: '#2fbf3f',
        uses: ['Peak sensitivity of the human eye', 'Common laser pointer color'],
      },
      {
        id: 'vis-yellow',
        name: 'Yellow',
        fLow: nm(590),
        fHigh: nm(565),
        color: '#f4d000',
        uses: ['Sodium street lamps', 'A printing primary color'],
      },
      {
        id: 'vis-orange',
        name: 'Orange',
        fLow: nm(625),
        fHigh: nm(590),
        color: '#ff8a1e',
        uses: ['Warm lighting'],
      },
      {
        id: 'vis-red',
        name: 'Red',
        fLow: nm(750),
        fHigh: nm(625),
        color: '#ff2b2b',
        uses: ['Red laser pointers and barcode scanners', 'The longest wavelengths people can see'],
      },
    ],
  },
  {
    id: 'ir',
    name: 'Infrared',
    fLow: 300e9,
    fHigh: nm(750),
    uses: ['Thermal imaging', 'Remote controls', 'Fiber optic communication', 'Heating'],
    children: [
      {
        id: 'ir-near',
        name: 'Near infrared (NIR)',
        fLow: um(3),
        fHigh: um(0.78),
        uses: [
          'Fiber optic internet at 1310 and 1550 nm',
          'TV remote controls',
          'Night vision and pulse oximeters',
        ],
      },
      {
        id: 'ir-mid',
        name: 'Mid infrared (MIR)',
        fLow: um(50),
        fHigh: um(3),
        uses: ['Thermal cameras', 'Gas leak detection', 'Molecular spectroscopy'],
      },
      {
        id: 'ir-far',
        name: 'Far infrared (FIR)',
        fLow: 300e9,
        fHigh: um(50),
        uses: ['Terahertz body scanners', 'Radio astronomy of cold dust', 'Radiant heaters'],
      },
    ],
  },
  {
    id: 'microwave',
    name: 'Microwave',
    fLow: 300e6,
    fHigh: 300e9,
    uses: ['Wi-Fi and Bluetooth', 'Mobile phones', 'Radar', 'Satellite links', 'Cooking'],
    children: [
      {
        id: 'uhf',
        name: 'UHF',
        fLow: 300e6,
        fHigh: 3e9,
        uses: ['Mobile phones', 'Wi-Fi at 2.4 GHz', 'GPS', 'UHF television'],
        children: [
          {
            id: 'uhf-tv',
            name: 'UHF television',
            fLow: 470e6,
            fHigh: 698e6,
            uses: ['Over the air broadcast television in the United States'],
          },
          {
            id: 'uhf-cellular',
            name: 'Cellular (4G and 5G)',
            fLow: 698e6,
            fHigh: 2.7e9,
            uses: ['LTE and 5G phone service across many licensed bands'],
          },
          {
            id: 'uhf-gps',
            name: 'GPS and GNSS',
            fLow: 1.164e9,
            fHigh: 1.61e9,
            uses: ['Satellite navigation on the L1, L2 and L5 signals'],
          },
          {
            id: 'uhf-ism24',
            name: '2.4 GHz ISM band',
            fLow: 2.4e9,
            fHigh: 2.4835e9,
            uses: ['Wi-Fi', 'Bluetooth', 'Zigbee', 'Microwave ovens near 2.45 GHz'],
          },
        ],
      },
      {
        id: 'shf',
        name: 'SHF',
        fLow: 3e9,
        fHigh: 30e9,
        uses: ['Faster Wi-Fi', 'Weather radar', 'Satellite television', 'Some 5G'],
        children: [
          {
            id: 'shf-cband',
            name: 'C band satellite',
            fLow: 3.7e9,
            fHigh: 4.2e9,
            uses: ['Satellite television and data downlinks'],
          },
          {
            id: 'shf-wifi',
            name: 'Wi-Fi 5, 6 and 6E',
            fLow: 5.15e9,
            fHigh: 7.125e9,
            uses: ['The 5 GHz and 6 GHz Wi-Fi bands'],
          },
          {
            id: 'shf-xband',
            name: 'X band radar',
            fLow: 8e9,
            fHigh: 12e9,
            uses: ['Weather and air traffic radar', 'Marine radar'],
          },
          {
            id: 'shf-kuband',
            name: 'Ku band satellite',
            fLow: 12e9,
            fHigh: 18e9,
            uses: ['Satellite television and VSAT data'],
          },
          {
            id: 'shf-5g',
            name: '5G mmWave (26 and 28 GHz)',
            fLow: 24.25e9,
            fHigh: 29.5e9,
            uses: ['High capacity 5G in the n257, n258 and n261 bands'],
          },
        ],
      },
      {
        id: 'ehf',
        name: 'EHF (millimeter wave)',
        fLow: 30e9,
        fHigh: 300e9,
        uses: ['5G millimeter wave', 'Automotive radar', 'Airport body scanners'],
        children: [
          {
            id: 'ehf-5g',
            name: '5G mmWave (39 GHz)',
            fLow: 37e9,
            fHigh: 40e9,
            uses: ['High capacity 5G in the n260 band'],
          },
          {
            id: 'ehf-autoradar',
            name: 'Automotive radar',
            fLow: 76e9,
            fHigh: 81e9,
            uses: ['Adaptive cruise control and collision avoidance'],
          },
          {
            id: 'ehf-astronomy',
            name: 'Radio astronomy window',
            fLow: 100e9,
            fHigh: 300e9,
            uses: ['Millimeter wave astronomy', 'Atmospheric sounding'],
          },
        ],
      },
    ],
  },
  {
    id: 'radio',
    name: 'Radio',
    fLow: AXIS_MIN_HZ,
    fHigh: 300e6,
    uses: ['Broadcast radio and television', 'Navigation', 'Two way radio', 'Time signals'],
    children: [
      {
        id: 'radio-elf',
        name: 'ELF',
        fLow: 3,
        fHigh: 30,
        uses: ['Communication with submarines', 'Geophysical surveying'],
      },
      {
        id: 'radio-slf',
        name: 'SLF',
        fLow: 30,
        fHigh: 300,
        uses: ['Submarine communication', 'The 50 and 60 Hz power grid sits near here'],
      },
      {
        id: 'radio-ulf',
        name: 'ULF',
        fLow: 300,
        fHigh: 3000,
        uses: ['Communication inside mines', 'Earthquake and geomagnetic research'],
      },
      {
        id: 'radio-vlf',
        name: 'VLF',
        fLow: 3e3,
        fHigh: 30e3,
        uses: ['Long range navigation', 'Time signals', 'Submarine communication'],
      },
      {
        id: 'radio-lf',
        name: 'LF',
        fLow: 30e3,
        fHigh: 300e3,
        uses: ['Longwave AM radio', 'Time signals such as WWVB at 60 kHz', 'RFID tags'],
      },
      {
        id: 'radio-mf',
        name: 'MF',
        fLow: 300e3,
        fHigh: 3e6,
        uses: ['AM broadcast radio', 'Maritime and aviation beacons'],
        children: [
          {
            id: 'mf-am',
            name: 'AM broadcast',
            fLow: 530e3,
            fHigh: 1700e3,
            uses: ['Mediumwave AM radio stations in the United States'],
          },
        ],
      },
      {
        id: 'radio-hf',
        name: 'HF (shortwave)',
        fLow: 3e6,
        fHigh: 30e6,
        uses: ['Shortwave and amateur radio', 'Long distance aviation and marine radio', 'RFID'],
      },
      {
        id: 'radio-vhf',
        name: 'VHF',
        fLow: 30e6,
        fHigh: 300e6,
        uses: ['FM radio', 'Aviation', 'VHF television', 'Weather radio'],
        children: [
          {
            id: 'vhf-tv',
            name: 'VHF television',
            fLow: 54e6,
            fHigh: 88e6,
            uses: ['Low channel broadcast television in the United States'],
          },
          {
            id: 'vhf-fm',
            name: 'FM broadcast',
            fLow: 88e6,
            fHigh: 108e6,
            uses: ['FM radio stations in the United States'],
          },
          {
            id: 'vhf-air',
            name: 'Airband',
            fLow: 108e6,
            fHigh: 137e6,
            uses: ['Aircraft to ground voice communication'],
          },
          {
            id: 'vhf-amateur',
            name: 'Amateur 2 meter',
            fLow: 144e6,
            fHigh: 148e6,
            uses: ['Amateur radio handhelds and repeaters'],
          },
          {
            id: 'vhf-marine',
            name: 'Marine VHF',
            fLow: 156e6,
            fHigh: 162e6,
            uses: ['Ship to ship and ship to shore radio', 'Weather broadcasts'],
          },
        ],
      },
    ],
  },
];
