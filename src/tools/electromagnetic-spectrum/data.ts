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
  /**
   * Optional lucide-vue-next icon NAME (a string, never an imported component,
   * so this data module stays pure). The panel maps the name to a component.
   * The full set of names used across the tree is listed in ICON_NAMES below.
   */
  icon?: string;
  /**
   * Optional search aliases and abbreviations for the "jump to" search brain,
   * lowercased by convention. These are extra terms a user might type that are
   * not already in `name` (for example "gnss" for GPS, "hi line" for the
   * hydrogen line). interpretQuery matches against these in addition to `name`.
   */
  aliases?: string[];
  /** Nested sub-bands, if any. A parent always encloses its children. */
  children?: Band[];
}

/**
 * Every lucide-vue-next icon NAME referenced by a band's `icon` field. The panel
 * agent should import exactly this set from "lucide-vue-next". Each name was
 * verified to exist as an export in node_modules/lucide-vue-next.
 *
 *   Anchor, Antenna, Atom, Bluetooth, Clock, CloudRain, Eye, Microwave,
 *   Plane, Radar, Radiation, RadioReceiver, RadioTower, Router, Satellite,
 *   SatelliteDish, ScanLine, Ship, SignalHigh, Smartphone, Sun, Thermometer,
 *   Tv, Wifi
 */
export const ICON_NAMES = [
  "Anchor",
  "Antenna",
  "Atom",
  "Bluetooth",
  "Clock",
  "CloudRain",
  "Eye",
  "Microwave",
  "Plane",
  "Radar",
  "Radiation",
  "RadioReceiver",
  "RadioTower",
  "Router",
  "Satellite",
  "SatelliteDish",
  "ScanLine",
  "Ship",
  "SignalHigh",
  "Smartphone",
  "Sun",
  "Thermometer",
  "Tv",
  "Wifi",
] as const;

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
 *
 * The main hierarchy (top level down to the ITU bands) stays a strict, non
 * overlapping partition, but the deepest named allocations may deliberately
 * overlap where real spectrum sharing does. The 2.4 GHz ISM band is the clearest
 * case: Wi-Fi channels, Bluetooth, Zigbee and microwave ovens all occupy it at
 * once. Two logic helpers resolve this: bandPathAt walks the narrowest matching
 * child at each level for a single most-specific path, and bandsCoveringAt
 * collects every band that contains a frequency (at any depth) so the readout
 * can aggregate all overlapping uses. When leaves overlap they are ordered
 * widest first so the narrower ones draw on top.
 */
export const BANDS: Band[] = [
  {
    id: "gamma",
    name: "Gamma rays",
    icon: "Radiation",
    aliases: ["gamma", "gamma ray", "y ray"],
    fLow: nm(0.01), // 10 pm, meets the hard X-ray edge exactly
    fHigh: AXIS_MAX_HZ,
    uses: [
      "Cancer radiotherapy",
      "PET and nuclear medicine imaging",
      "Sterilizing medical equipment and food",
      "Nuclear physics and gamma ray astronomy",
    ],
  },
  {
    id: "xray",
    name: "X-rays",
    icon: "ScanLine",
    aliases: ["x ray", "xray", "x rays", "roentgen"],
    fLow: nm(10),
    fHigh: nm(0.01),
    uses: ["Medical imaging", "Security scanning", "Crystallography", "X-ray astronomy"],
    children: [
      {
        id: "xray-hard",
        name: "Hard X-rays",
        fLow: nm(0.1),
        fHigh: nm(0.01),
        uses: [
          "Radiography and CT scanning",
          "Airport and cargo security scanners",
          "Industrial inspection of metal parts",
        ],
      },
      {
        id: "xray-soft",
        name: "Soft X-rays",
        fLow: nm(10),
        fHigh: nm(0.1),
        uses: [
          "X-ray microscopy",
          "Semiconductor and materials inspection",
          "Soft X-ray astronomy",
        ],
      },
    ],
  },
  {
    id: "uv",
    name: "Ultraviolet",
    icon: "Sun",
    aliases: ["uv", "ultra violet", "ultraviolet light"],
    fLow: nm(400),
    fHigh: nm(10),
    uses: ["Sterilization", "Fluorescence", "Curing inks and resins", "Chip lithography"],
    children: [
      {
        id: "uv-euv",
        name: "Extreme UV (EUV)",
        aliases: ["euv", "extreme uv", "extreme ultraviolet"],
        fLow: nm(100),
        fHigh: nm(10),
        uses: ["EUV lithography for advanced chips", "Solar physics", "Plasma research"],
      },
      {
        id: "uv-uvc",
        name: "UVC",
        aliases: ["uvc", "uv c", "germicidal uv"],
        fLow: nm(280),
        fHigh: nm(100),
        uses: ["Germicidal lamps", "Drinking water disinfection", "Air purification"],
      },
      {
        id: "uv-uvb",
        name: "UVB",
        aliases: ["uvb", "uv b"],
        fLow: nm(315),
        fHigh: nm(280),
        uses: ["Vitamin D synthesis in skin", "Cause of sunburn", "Skin condition phototherapy"],
      },
      {
        id: "uv-uva",
        name: "UVA",
        aliases: ["uva", "uv a", "black light"],
        fLow: nm(400),
        fHigh: nm(315),
        uses: ["Black lights", "Tanning beds", "Curing gel nail polish and adhesives"],
      },
    ],
  },
  {
    id: "visible",
    name: "Visible light",
    icon: "Eye",
    aliases: ["visible", "light", "optical", "visible light"],
    fLow: nm(750),
    fHigh: nm(380),
    uses: ["Human vision", "Photography and displays", "Optical fiber test signals", "Lighting"],
    children: [
      {
        id: "vis-violet",
        name: "Violet",
        fLow: nm(450),
        fHigh: nm(380),
        color: "#7f3ff2",
        uses: ["The shortest wavelengths people can see"],
      },
      {
        id: "vis-blue",
        name: "Blue",
        fLow: nm(485),
        fHigh: nm(450),
        color: "#2b58ff",
        uses: ["Blue LEDs and laser diodes", "Scatters most in the daytime sky"],
      },
      {
        id: "vis-cyan",
        name: "Cyan",
        fLow: nm(500),
        fHigh: nm(485),
        color: "#00c9d6",
        uses: ["A printing primary color"],
      },
      {
        id: "vis-green",
        name: "Green",
        fLow: nm(565),
        fHigh: nm(500),
        color: "#2fbf3f",
        uses: ["Peak sensitivity of the human eye", "Common laser pointer color"],
      },
      {
        id: "vis-yellow",
        name: "Yellow",
        fLow: nm(590),
        fHigh: nm(565),
        color: "#f4d000",
        uses: ["Sodium street lamps", "A printing primary color"],
      },
      {
        id: "vis-orange",
        name: "Orange",
        fLow: nm(625),
        fHigh: nm(590),
        color: "#ff8a1e",
        uses: ["Warm lighting"],
      },
      {
        id: "vis-red",
        name: "Red",
        fLow: nm(750),
        fHigh: nm(625),
        color: "#ff2b2b",
        uses: ["Red laser pointers and barcode scanners", "The longest wavelengths people can see"],
      },
    ],
  },
  {
    id: "ir",
    name: "Infrared",
    icon: "Thermometer",
    aliases: ["ir", "infra red", "thermal", "infrared light"],
    fLow: 300e9,
    fHigh: nm(750),
    uses: ["Thermal imaging", "Remote controls", "Fiber optic communication", "Heating"],
    children: [
      {
        id: "ir-near",
        name: "Near infrared (NIR)",
        aliases: ["nir", "near ir", "near infrared"],
        fLow: um(3),
        fHigh: um(0.78),
        uses: [
          "Fiber optic internet at 1310 and 1550 nm",
          "TV remote controls",
          "Night vision and pulse oximeters",
        ],
      },
      {
        id: "ir-mid",
        name: "Mid infrared (MIR)",
        aliases: ["mir", "mid ir", "mid infrared"],
        fLow: um(50),
        fHigh: um(3),
        uses: ["Thermal cameras", "Gas leak detection", "Molecular spectroscopy"],
      },
      {
        id: "ir-far",
        name: "Far infrared (FIR)",
        aliases: ["fir", "far ir", "far infrared", "terahertz", "thz"],
        fLow: 300e9,
        fHigh: um(50),
        uses: ["Terahertz body scanners", "Radio astronomy of cold dust", "Radiant heaters"],
      },
    ],
  },
  {
    id: "microwave",
    name: "Microwave",
    icon: "Router",
    aliases: ["microwave", "micro wave"],
    fLow: 300e6,
    fHigh: 300e9,
    uses: ["Wi-Fi and Bluetooth", "Mobile phones", "Radar", "Satellite links", "Cooking"],
    children: [
      {
        id: "uhf",
        name: "UHF",
        fLow: 300e6,
        fHigh: 3e9,
        uses: ["Mobile phones", "Wi-Fi at 2.4 GHz", "GPS", "UHF television"],
        children: [
          {
            id: "uhf-70cm",
            name: "Amateur 70 centimeter",
            fLow: 420e6,
            fHigh: 450e6,
            uses: ["Amateur voice, repeaters and satellite work"],
            children: [
              {
                id: "uhf-433ism",
                name: "433 MHz ISM band",
                fLow: 433.05e6,
                fHigh: 434.79e6,
                uses: ["Garage and gate remotes", "LoRa in Europe", "Weather stations"],
              },
            ],
          },
          {
            id: "uhf-tv",
            name: "UHF television",
            icon: "Tv",
            aliases: ["uhf tv", "broadcast tv", "over the air tv", "digital tv"],
            fLow: 470e6,
            fHigh: 698e6,
            uses: ["Over the air broadcast television in the United States"],
          },
          {
            id: "uhf-cellular",
            name: "Cellular (4G and 5G)",
            icon: "Smartphone",
            aliases: ["cellular", "cell", "lte", "4g", "5g", "mobile", "phone"],
            fLow: 698e6,
            fHigh: 2.7e9,
            uses: ["LTE and 5G phone service across many licensed bands"],
          },
          {
            id: "uhf-900ism",
            name: "900 MHz ISM band",
            fLow: 902e6,
            fHigh: 928e6,
            uses: ["Cordless phones", "LoRa in North America", "Zigbee", "RFID and smart meters"],
          },
          {
            id: "uhf-gps",
            name: "GPS and GNSS",
            icon: "Satellite",
            aliases: ["gps", "gnss", "glonass", "galileo", "navigation", "sat nav"],
            fLow: 1.164e9,
            fHigh: 1.61e9,
            uses: ["Satellite navigation"],
            children: [
              {
                id: "gps-l5",
                name: "GPS L5",
                fLow: 1.16645e9,
                fHigh: 1.18645e9,
                uses: ["The 1176.45 MHz aviation safety navigation signal"],
              },
              {
                id: "gps-l2",
                name: "GPS L2",
                fLow: 1.2176e9,
                fHigh: 1.2376e9,
                uses: ["The 1227.60 MHz second civilian navigation signal"],
              },
              {
                id: "gps-l1",
                name: "GPS L1",
                fLow: 1.56542e9,
                fHigh: 1.58542e9,
                uses: ["The 1575.42 MHz main GPS signal your phone uses"],
              },
            ],
          },
          {
            id: "uhf-hline",
            name: "21 cm hydrogen line",
            icon: "Atom",
            aliases: ["hydrogen line", "h line", "hi line", "21 cm", "21cm", "1420 mhz"],
            fLow: 1.42035e9,
            fHigh: 1.42046e9,
            uses: ["The 1420.405 MHz hydrogen emission line used in radio astronomy"],
          },
          {
            id: "uhf-ism24",
            name: "2.4 GHz ISM band",
            icon: "Wifi",
            aliases: ["ism", "2.4 ghz", "2.4ghz", "wifi", "wi fi"],
            fLow: 2.4e9,
            fHigh: 2.4835e9,
            uses: ["License free 2.4 GHz band shared by many devices"],
            children: [
              {
                id: "ism24-bt",
                name: "Bluetooth",
                icon: "Bluetooth",
                aliases: ["bluetooth", "ble", "bt"],
                fLow: 2.4e9,
                fHigh: 2.4835e9,
                uses: ["Bluetooth and Bluetooth Low Energy", "Wireless earbuds and keyboards"],
              },
              {
                id: "ism24-zigbee",
                name: "Zigbee and Thread",
                fLow: 2.405e9,
                fHigh: 2.48e9,
                uses: ["Zigbee", "Thread and Matter smart home devices"],
              },
              {
                id: "ism24-wifi1",
                name: "Wi-Fi channel 1",
                fLow: 2.401e9,
                fHigh: 2.423e9,
                uses: ["2.4 GHz Wi-Fi centered on 2412 MHz"],
              },
              {
                id: "ism24-wifi6",
                name: "Wi-Fi channel 6",
                fLow: 2.426e9,
                fHigh: 2.448e9,
                uses: ["2.4 GHz Wi-Fi centered on 2437 MHz"],
              },
              {
                id: "ism24-wifi11",
                name: "Wi-Fi channel 11",
                fLow: 2.451e9,
                fHigh: 2.473e9,
                uses: ["2.4 GHz Wi-Fi centered on 2462 MHz"],
              },
              {
                id: "ism24-oven",
                name: "Microwave ovens",
                icon: "Microwave",
                aliases: ["microwave oven", "oven"],
                fLow: 2.45e9,
                fHigh: 2.46e9,
                uses: ["Microwave ovens heat food at about 2.45 GHz"],
              },
            ],
          },
        ],
      },
      {
        id: "shf",
        name: "SHF",
        fLow: 3e9,
        fHigh: 30e9,
        uses: ["Faster Wi-Fi", "Weather radar", "Satellite television", "Some 5G"],
        children: [
          {
            id: "shf-cband",
            name: "C band satellite",
            icon: "SatelliteDish",
            aliases: ["c band", "cband"],
            fLow: 3.7e9,
            fHigh: 4.2e9,
            uses: ["Satellite television and data downlinks"],
          },
          {
            id: "shf-wifi",
            name: "Wi-Fi 5, 6 and 6E",
            icon: "Wifi",
            aliases: ["wifi", "wi fi", "unii", "5 ghz", "5ghz", "6 ghz", "6ghz", "6e"],
            fLow: 5.15e9,
            fHigh: 7.125e9,
            uses: ["The 5 GHz and 6 GHz Wi-Fi bands"],
            children: [
              {
                id: "wifi-unii1",
                name: "UNII-1 (5.2 GHz)",
                icon: "Wifi",
                aliases: ["unii 1", "unii1", "u nii 1"],
                fLow: 5.15e9,
                fHigh: 5.25e9,
                uses: ["Indoor 5 GHz Wi-Fi channels 36 to 48"],
              },
              {
                id: "wifi-unii2",
                name: "UNII-2 (5.5 GHz, DFS)",
                fLow: 5.25e9,
                fHigh: 5.725e9,
                uses: ["5 GHz Wi-Fi channels that must avoid weather radar"],
              },
              {
                id: "wifi-unii3",
                name: "UNII-3 (5.8 GHz)",
                fLow: 5.725e9,
                fHigh: 5.85e9,
                uses: ["Outdoor capable 5 GHz Wi-Fi channels"],
              },
              {
                id: "wifi-6e",
                name: "6 GHz (Wi-Fi 6E and 7)",
                icon: "Wifi",
                aliases: ["6e", "wifi 6e", "wifi 7", "unii 5", "6 ghz", "6ghz"],
                fLow: 5.925e9,
                fHigh: 7.125e9,
                uses: ["The newest wide Wi-Fi band with many clean channels"],
              },
            ],
          },
          {
            id: "shf-xband",
            name: "X band radar",
            icon: "Radar",
            aliases: ["x band", "xband", "radar"],
            fLow: 8e9,
            fHigh: 12e9,
            uses: ["Weather and air traffic radar", "Marine radar"],
          },
          {
            id: "shf-kuband",
            name: "Ku band satellite",
            icon: "SatelliteDish",
            aliases: ["ku band", "kuband"],
            fLow: 12e9,
            fHigh: 18e9,
            uses: ["Satellite television and VSAT data"],
          },
          {
            id: "shf-5g",
            name: "5G mmWave (26 and 28 GHz)",
            icon: "SignalHigh",
            aliases: ["5g mmwave", "millimeter wave", "mmwave", "n257", "n258", "n261"],
            fLow: 24.25e9,
            fHigh: 29.5e9,
            uses: ["High capacity 5G in the n257, n258 and n261 bands"],
          },
        ],
      },
      {
        id: "ehf",
        name: "EHF (millimeter wave)",
        fLow: 30e9,
        fHigh: 300e9,
        uses: ["5G millimeter wave", "Automotive radar", "Airport body scanners"],
        children: [
          {
            id: "ehf-5g",
            name: "5G mmWave (39 GHz)",
            fLow: 37e9,
            fHigh: 40e9,
            uses: ["High capacity 5G in the n260 band"],
          },
          {
            id: "ehf-wigig",
            name: "60 GHz WiGig",
            fLow: 57e9,
            fHigh: 71e9,
            uses: ["Very fast short range WiGig links", "Oxygen absorbs strongly here"],
          },
          {
            id: "ehf-autoradar",
            name: "Automotive radar",
            icon: "Radar",
            aliases: ["automotive radar", "car radar", "collision avoidance"],
            fLow: 76e9,
            fHigh: 81e9,
            uses: ["Adaptive cruise control and collision avoidance"],
          },
          {
            id: "ehf-astronomy",
            name: "Radio astronomy window",
            fLow: 100e9,
            fHigh: 300e9,
            uses: ["Millimeter wave astronomy", "Atmospheric sounding"],
          },
        ],
      },
    ],
  },
  {
    id: "radio",
    name: "Radio",
    icon: "RadioTower",
    aliases: ["radio", "radio waves", "rf"],
    fLow: AXIS_MIN_HZ,
    fHigh: 300e6,
    uses: ["Broadcast radio and television", "Navigation", "Two way radio", "Time signals"],
    children: [
      {
        id: "radio-elf",
        name: "ELF",
        fLow: 3,
        fHigh: 30,
        uses: ["Communication with submarines", "Geophysical surveying"],
      },
      {
        id: "radio-slf",
        name: "SLF",
        fLow: 30,
        fHigh: 300,
        uses: ["Submarine communication", "The 50 and 60 Hz power grid sits near here"],
      },
      {
        id: "radio-ulf",
        name: "ULF",
        fLow: 300,
        fHigh: 3000,
        uses: ["Communication inside mines", "Earthquake and geomagnetic research"],
      },
      {
        id: "radio-vlf",
        name: "VLF",
        fLow: 3e3,
        fHigh: 30e3,
        uses: ["Long range navigation", "Time signals", "Submarine communication"],
      },
      {
        id: "radio-lf",
        name: "LF",
        fLow: 30e3,
        fHigh: 300e3,
        uses: ["Longwave AM radio", "Aircraft nondirectional beacons", "RFID tags"],
        children: [
          {
            id: "lf-wwvb",
            name: "WWVB 60 kHz time signal",
            icon: "Clock",
            aliases: ["wwvb", "time signal", "atomic clock", "radio clock"],
            fLow: 59.5e3,
            fHigh: 60.5e3,
            uses: ["The 60 kHz signal that sets radio controlled atomic clocks"],
          },
          {
            id: "lf-2200m",
            name: "Amateur 2200 meter",
            fLow: 135.7e3,
            fHigh: 137.8e3,
            uses: ["The lowest amateur radio allocation"],
          },
        ],
      },
      {
        id: "radio-mf",
        name: "MF",
        fLow: 300e3,
        fHigh: 3e6,
        uses: ["AM broadcast radio", "Maritime and aviation beacons"],
        children: [
          {
            id: "mf-630m",
            name: "Amateur 630 meter",
            fLow: 472e3,
            fHigh: 479e3,
            uses: ["A low frequency amateur radio band"],
          },
          {
            id: "mf-am",
            name: "AM broadcast",
            icon: "RadioReceiver",
            aliases: ["am", "am radio", "mediumwave", "medium wave"],
            fLow: 530e3,
            fHigh: 1700e3,
            uses: ["Mediumwave AM radio stations in the United States"],
          },
          {
            id: "mf-160m",
            name: "Amateur 160 meter",
            fLow: 1.8e6,
            fHigh: 2.0e6,
            uses: ["The amateur top band, popular at night"],
          },
        ],
      },
      {
        id: "radio-hf",
        name: "HF (shortwave)",
        aliases: ["hf", "shortwave", "short wave"],
        fLow: 3e6,
        fHigh: 30e6,
        uses: ["Shortwave and amateur radio", "Long distance aviation and marine radio", "RFID"],
        children: [
          {
            id: "hf-80m",
            name: "Amateur 80 meter",
            fLow: 3.5e6,
            fHigh: 4.0e6,
            uses: ["Regional amateur voice and Morse code, best at night"],
          },
          {
            id: "hf-49m",
            name: "Shortwave broadcast (49 m)",
            fLow: 5.9e6,
            fHigh: 6.2e6,
            uses: ["International shortwave broadcasting"],
          },
          {
            id: "hf-40m",
            name: "Amateur 40 meter",
            fLow: 7.0e6,
            fHigh: 7.3e6,
            uses: ["A reliable amateur band day and night"],
            children: [
              {
                id: "hf-40m-cw",
                name: "40 m CW and data",
                fLow: 7.0e6,
                fHigh: 7.125e6,
                uses: ["Morse code and digital modes"],
              },
              {
                id: "hf-40m-ssb",
                name: "40 m SSB voice",
                fLow: 7.125e6,
                fHigh: 7.3e6,
                uses: ["Single sideband voice, busy in the evenings"],
              },
            ],
          },
          {
            id: "hf-31m",
            name: "Shortwave broadcast (31 m)",
            fLow: 9.4e6,
            fHigh: 9.9e6,
            uses: ["The most used international shortwave broadcast band"],
          },
          {
            id: "hf-30m",
            name: "Amateur 30 meter",
            fLow: 10.1e6,
            fHigh: 10.15e6,
            uses: ["A narrow Morse code and data only amateur band"],
          },
          {
            id: "hf-20m",
            name: "Amateur 20 meter",
            fLow: 14.0e6,
            fHigh: 14.35e6,
            uses: ["The classic long distance amateur band"],
            children: [
              {
                id: "hf-20m-cw",
                name: "20 m CW and data",
                fLow: 14.0e6,
                fHigh: 14.15e6,
                uses: ["Morse code and digital modes"],
              },
              {
                id: "hf-20m-ssb",
                name: "20 m SSB voice",
                fLow: 14.15e6,
                fHigh: 14.35e6,
                uses: ["Single sideband voice contacts worldwide"],
              },
            ],
          },
          {
            id: "hf-17m",
            name: "Amateur 17 meter",
            fLow: 18.068e6,
            fHigh: 18.168e6,
            uses: ["A quieter amateur voice and data band"],
          },
          {
            id: "hf-15m",
            name: "Amateur 15 meter",
            fLow: 21.0e6,
            fHigh: 21.45e6,
            uses: ["A daytime long distance amateur band"],
          },
          {
            id: "hf-cb",
            name: "CB radio",
            icon: "Antenna",
            aliases: ["cb", "cb radio", "citizens band"],
            fLow: 26.965e6,
            fHigh: 27.405e6,
            uses: ["License free Citizens Band radio, 40 channels"],
            children: [
              {
                id: "hf-cb-19",
                name: "CB Channel 19",
                fLow: 27.18e6,
                fHigh: 27.19e6,
                uses: ["The unofficial trucker highway channel at 27.185 MHz"],
              },
            ],
          },
          {
            id: "hf-10m",
            name: "Amateur 10 meter",
            fLow: 28.0e6,
            fHigh: 29.7e6,
            uses: ["Long distance amateur contacts when the sun is active"],
          },
          {
            id: "hf-wwv5",
            name: "WWV 5 MHz time signal",
            fLow: 4.999e6,
            fHigh: 5.001e6,
            uses: ["Standard time and frequency broadcast from WWV"],
          },
          {
            id: "hf-wwv10",
            name: "WWV 10 MHz time signal",
            fLow: 9.999e6,
            fHigh: 10.001e6,
            uses: ["Standard time and frequency broadcast from WWV"],
          },
          {
            id: "hf-wwv15",
            name: "WWV 15 MHz time signal",
            fLow: 14.999e6,
            fHigh: 15.001e6,
            uses: ["Standard time and frequency broadcast from WWV"],
          },
          {
            id: "hf-wwv20",
            name: "WWV 20 MHz time signal",
            fLow: 19.999e6,
            fHigh: 20.001e6,
            uses: ["Standard time and frequency broadcast from WWV"],
          },
        ],
      },
      {
        id: "radio-vhf",
        name: "VHF",
        fLow: 30e6,
        fHigh: 300e6,
        uses: ["FM radio", "Aviation", "VHF television", "Weather radio"],
        children: [
          {
            id: "vhf-tv",
            name: "VHF television",
            icon: "Tv",
            aliases: ["vhf tv", "broadcast television"],
            fLow: 54e6,
            fHigh: 88e6,
            uses: ["Low channel broadcast television in the United States"],
          },
          {
            id: "vhf-fm",
            name: "FM broadcast",
            icon: "RadioReceiver",
            aliases: ["fm", "fm radio", "broadcast fm"],
            fLow: 88e6,
            fHigh: 108e6,
            uses: ["FM radio stations in the United States"],
          },
          {
            id: "vhf-air",
            name: "Airband",
            icon: "Plane",
            aliases: ["airband", "air band", "aviation", "aircraft", "atc"],
            fLow: 108e6,
            fHigh: 137e6,
            uses: ["Aircraft to ground voice communication"],
            children: [
              {
                id: "air-nav",
                name: "VOR and ILS navigation",
                fLow: 108e6,
                fHigh: 118e6,
                uses: ["Aircraft navigation beacons and landing systems"],
              },
              {
                id: "air-voice",
                name: "Air traffic control voice",
                fLow: 118e6,
                fHigh: 137e6,
                uses: ["Pilot to controller voice communication"],
              },
              {
                id: "air-guard",
                name: "121.5 MHz emergency guard",
                fLow: 121.475e6,
                fHigh: 121.525e6,
                uses: ["The international aviation emergency and distress frequency"],
              },
            ],
          },
          {
            id: "vhf-amateur",
            name: "Amateur 2 meter",
            icon: "Antenna",
            aliases: ["2m", "2 meter", "two meter", "amateur", "ham", "ham radio"],
            fLow: 144e6,
            fHigh: 148e6,
            uses: ["Amateur radio handhelds and repeaters"],
            children: [
              {
                id: "vhf-2m-calling",
                name: "146.52 MHz calling",
                fLow: 146.505e6,
                fHigh: 146.535e6,
                uses: ["The 2 meter FM simplex calling frequency"],
              },
            ],
          },
          {
            id: "vhf-marine",
            name: "Marine VHF",
            icon: "Ship",
            aliases: ["marine", "maritime", "boat", "ship", "vhf marine"],
            fLow: 156e6,
            fHigh: 162e6,
            uses: ["Ship to ship and ship to shore radio", "Weather broadcasts"],
            children: [
              {
                id: "marine-ch70",
                name: "Marine Channel 70 DSC",
                fLow: 156.5e6,
                fHigh: 156.55e6,
                uses: ["Digital Selective Calling for automated distress alerts"],
              },
              {
                id: "marine-ch13",
                name: "Marine Channel 13 bridge to bridge",
                aliases: ["channel 13", "ch 13", "bridge to bridge"],
                fLow: 156.6375e6,
                fHigh: 156.6625e6,
                uses: ["The 156.65 MHz intership navigation safety channel"],
              },
              {
                id: "marine-ch16",
                name: "Marine Channel 16 distress",
                icon: "Anchor",
                aliases: ["channel 16", "ch 16", "marine distress"],
                fLow: 156.75e6,
                fHigh: 156.85e6,
                uses: ["The 156.8 MHz international hailing and distress channel"],
              },
              {
                id: "marine-ch22a",
                name: "Marine Channel 22A Coast Guard",
                aliases: ["channel 22a", "22a", "coast guard liaison"],
                fLow: 157.0875e6,
                fHigh: 157.1125e6,
                uses: ["The 157.1 MHz US Coast Guard liaison and safety broadcast channel"],
              },
            ],
          },
          {
            id: "vhf-noaa",
            name: "NOAA weather radio",
            icon: "CloudRain",
            aliases: ["noaa", "weather radio", "weather", "wx"],
            // Widened to the outer edges of the seven 25 kHz channels (162.3875 to
            // 162.5625 MHz) so the WX leaves tile the parent as a clean partition.
            fLow: 162.3875e6,
            fHigh: 162.5625e6,
            uses: ["Continuous weather broadcasts and emergency alerts"],
            // The seven channels are not in frequency order: WX1 is the highest.
            children: [
              {
                id: "noaa-wx2",
                name: "Weather channel WX2",
                fLow: 162.3875e6,
                fHigh: 162.4125e6,
                uses: ["The 162.400 MHz NOAA weather transmitter"],
              },
              {
                id: "noaa-wx4",
                name: "Weather channel WX4",
                fLow: 162.4125e6,
                fHigh: 162.4375e6,
                uses: ["The 162.425 MHz NOAA weather transmitter"],
              },
              {
                id: "noaa-wx5",
                name: "Weather channel WX5",
                fLow: 162.4375e6,
                fHigh: 162.4625e6,
                uses: ["The 162.450 MHz NOAA weather transmitter"],
              },
              {
                id: "noaa-wx3",
                name: "Weather channel WX3",
                fLow: 162.4625e6,
                fHigh: 162.4875e6,
                uses: ["The 162.475 MHz NOAA weather transmitter"],
              },
              {
                id: "noaa-wx6",
                name: "Weather channel WX6",
                fLow: 162.4875e6,
                fHigh: 162.5125e6,
                uses: ["The 162.500 MHz NOAA weather transmitter"],
              },
              {
                id: "noaa-wx7",
                name: "Weather channel WX7",
                fLow: 162.5125e6,
                fHigh: 162.5375e6,
                uses: ["The 162.525 MHz NOAA weather transmitter"],
              },
              {
                id: "noaa-wx1",
                name: "Weather channel WX1",
                fLow: 162.5375e6,
                fHigh: 162.5625e6,
                uses: ["The 162.550 MHz NOAA weather transmitter, the most common channel"],
              },
            ],
          },
          {
            id: "vhf-1p25m",
            name: "Amateur 1.25 meter",
            fLow: 222e6,
            fHigh: 225e6,
            uses: ["A regional amateur VHF band"],
          },
          {
            id: "vhf-milair-guard",
            name: "243.0 MHz military guard",
            fLow: 242.95e6,
            fHigh: 243.05e6,
            uses: ["The military aviation emergency and distress frequency"],
          },
        ],
      },
    ],
  },
];

/* ================================================================== */
/* United States / North American Wi-Fi channel dataset               */
/* ================================================================== */

/**
 * Which of the three unlicensed Wi-Fi bands a channel lives in. The string is
 * the nominal band name in gigahertz ("2.4", "5" or "6"), which also lets the
 * search brain disambiguate the same channel NUMBER in different bands (channel
 * 1 exists in both the 2.4 GHz and 6 GHz bands, for example).
 */
export type WifiBand = "2.4" | "5" | "6";

/** One US / North American Wi-Fi channel at a given width. */
export interface WifiChannel {
  /** The band in gigahertz: "2.4", "5" or "6". */
  band: WifiBand;
  /** The center-channel number (for bonded widths, the composite number). */
  channel: number;
  /** Channel width in megahertz: 20, 40, 80 or 160. */
  width: number;
  /** Center frequency in hertz. */
  centerHz: number;
  /** Lower band edge in hertz (center minus half the width). */
  lowerHz: number;
  /** Upper band edge in hertz (center plus half the width). */
  upperHz: number;
}

const MHZ = 1e6;

/**
 * Build a WifiChannel from a band, center-channel number, width and the center
 * frequency expressed in megahertz. Edges are the center plus and minus half of
 * the channel width, so a 20 MHz channel spans center plus or minus 10 MHz.
 */
function wifiChannel(
  band: WifiBand,
  channel: number,
  width: number,
  centerMHz: number,
): WifiChannel {
  const centerHz = centerMHz * MHZ;
  const halfHz = (width / 2) * MHZ;
  return {
    band,
    channel,
    width,
    centerHz,
    lowerHz: centerHz - halfHz,
    upperHz: centerHz + halfHz,
  };
}

/*
 * 2.4 GHz (US / North America). The 20 MHz channels are 1 through 11 with
 * center = 2407 + 5 * channel MHz (so channel 1 is 2412 MHz, channel 11 is 2462
 * MHz). A 40 MHz channel bonds two adjacent 20 MHz channels four apart; in the
 * US, where usable channels are 1 through 11, the composite center numbers are 3
 * through 9 (bonding 1+5 up to 7+11). We keep the same center = 2407 + 5 * ch
 * formula for the composite number so, for example, the 40 MHz channel 3 is
 * centered at 2422 MHz spanning 2402 to 2442 MHz.
 */
const WIFI_24: WifiChannel[] = [];
for (let ch = 1; ch <= 11; ch++) {
  WIFI_24.push(wifiChannel("2.4", ch, 20, 2407 + 5 * ch));
}
for (let ch = 3; ch <= 9; ch++) {
  WIFI_24.push(wifiChannel("2.4", ch, 40, 2407 + 5 * ch));
}

/*
 * 5 GHz (US / FCC UNII-1, UNII-2A, UNII-2C and UNII-3). Every center frequency
 * is 5000 + 5 * (center-channel number) MHz. The 20 MHz channels are the usable
 * non contiguous set; the 40, 80 and 160 MHz lists are the standard composite
 * center-channel numbers (each composite number appears at exactly one width).
 * For example channel 42 is the 80 MHz channel bonding 36, 40, 44 and 48 with a
 * 5210 MHz center, and channel 50 is the 160 MHz channel bonding 36 through 64
 * with a 5250 MHz center.
 */
const G5_20 = [
  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149,
  153, 157, 161, 165,
];
const G5_40 = [38, 46, 54, 62, 102, 110, 118, 126, 134, 142, 151, 159];
const G5_80 = [42, 58, 106, 122, 138, 155];
const G5_160 = [50, 114, 163];

const WIFI_5: WifiChannel[] = [
  ...G5_20.map((ch) => wifiChannel("5", ch, 20, 5000 + 5 * ch)),
  ...G5_40.map((ch) => wifiChannel("5", ch, 40, 5000 + 5 * ch)),
  ...G5_80.map((ch) => wifiChannel("5", ch, 80, 5000 + 5 * ch)),
  ...G5_160.map((ch) => wifiChannel("5", ch, 160, 5000 + 5 * ch)),
];

/*
 * 6 GHz (US / FCC UNII-5 through UNII-8, Wi-Fi 6E and 7). Center frequency is
 * 5950 + 5 * (center-channel number) MHz. Channels are generated arithmetically:
 * 20 MHz start at channel 1 step 4, 40 MHz start at 3 step 8, 80 MHz start at 7
 * step 16, and 160 MHz start at 15 step 32. We keep a channel only when its full
 * width fits inside the 5925 to 7125 MHz band, which yields the standard maxima
 * (20 MHz up to 233, 40 MHz to 227, 80 MHz to 215, 160 MHz to 207).
 */
const SIX_LOW_MHZ = 5925;
const SIX_HIGH_MHZ = 7125;

function generate6(startCh: number, step: number, width: number): WifiChannel[] {
  const out: WifiChannel[] = [];
  for (let ch = startCh; ; ch += step) {
    const centerMHz = 5950 + 5 * ch;
    const lower = centerMHz - width / 2;
    const upper = centerMHz + width / 2;
    if (upper > SIX_HIGH_MHZ) break;
    if (lower >= SIX_LOW_MHZ) out.push(wifiChannel("6", ch, width, centerMHz));
  }
  return out;
}

const WIFI_6: WifiChannel[] = [
  ...generate6(1, 4, 20),
  ...generate6(3, 8, 40),
  ...generate6(7, 16, 80),
  ...generate6(15, 32, 160),
];

/** Every modeled US / North American Wi-Fi channel across all three bands. */
export const WIFI_CHANNELS: WifiChannel[] = [...WIFI_24, ...WIFI_5, ...WIFI_6];

/* ================================================================== */
/* Numbered and named channel systems (US / North America)            */
/* ================================================================== */

/**
 * The named channel services the search brain resolves. Each is a family of
 * numbered or named channels with fixed frequencies, so "marine channel 16" or
 * "cb 19" jumps to an exact spot on the axis.
 */
export type ChannelService = "marine" | "cb" | "noaa" | "fm" | "tv";

/**
 * One numbered or named channel in a fixed-frequency service. Frequencies are in
 * hertz. `centerHz` is the representative (transmit) frequency the search jumps
 * to; `lowerHz` and `upperHz` are the channel edges so the panel can zoom to fit.
 * For duplex marine channels `shipHz` and `coastHz` carry the two paired
 * frequencies (ship transmit and coast transmit); on simplex channels they are
 * equal. `number` is the plain numeric part so a bare "marine 22" resolves the
 * same channel a user knows as 22A.
 */
export interface NamedChannel {
  service: ChannelService;
  /** Canonical channel id, for example "16", "22A", "WX1", "201" or "7". */
  channel: string;
  /** Numeric part of the id, for bare "cb 19" or "marine 22" style lookups. */
  number: number;
  /** Human name, for example "Channel 16" or "FM channel 201". */
  name?: string;
  /** Short extra note (band, region, restriction). */
  notes?: string;
  /** True when the channel transmits and receives on one frequency. */
  simplex?: boolean;
  /** Marine ship transmit frequency in hertz. */
  shipHz?: number;
  /** Marine coast transmit (ship receive) frequency in hertz. */
  coastHz?: number;
  /** Representative (transmit) frequency in hertz, the jump target. */
  centerHz: number;
  /** Channel low edge in hertz. */
  lowerHz: number;
  /** Channel high edge in hertz. */
  upperHz: number;
  /** Common real world uses, plain sentences with no dashes. */
  uses?: string[];
}

const KHZ = 1e3;

/*
 * All frequencies below are built from integer kilohertz or integer megahertz
 * and scaled to hertz exactly once, so the results are exact doubles (for
 * example 156800 * 1e3 is precisely 156800000, whereas 156.0 + 0.05 * 16 is
 * 156.80000000000001). This keeps the search resolutions equal to their clean
 * literal values.
 */

/* ---- Marine VHF (US channel plan) --------------------------------- */

/*
 * Ship transmit frequency, in kHz, for an ITU marine VHF channel number. The two
 * interleaved grids are channels 1 to 28 (base 156.000 MHz, 50 kHz steps) and 60
 * to 88 (base 156.025 MHz, 50 kHz steps). A duplex channel's coast transmit
 * frequency sits exactly 4.600 MHz above the ship frequency. Verified against the
 * US Coast Guard Navigation Center US VHF channel table (navcen.uscg.gov) and
 * https://en.wikipedia.org/wiki/Marine_VHF_radio: 16 = 156.800, 13 = 156.650,
 * 70 = 156.525 (DSC), 22A = 157.100. US "A" channels are simplex on the ship
 * transmit frequency of the matching international duplex channel.
 */
function marineShipKHz(n: number): number {
  return n <= 28 ? 156000 + 50 * n : 156025 + 50 * (n - 60);
}
const MARINE_COAST_OFFSET_KHZ = 4600;
const MARINE_HALF_HZ = 12_500; // 25 kHz channel spacing, half width

interface MarineSpec {
  n: number;
  /** US simplex "A" variant on the ship frequency. */
  a?: boolean;
  /** Duplex: ship transmits low, coast transmits 4.6 MHz higher. */
  duplex?: boolean;
  /** False when the international channel is not used in the US channel plan. */
  usUnassigned?: boolean;
  use: string;
}

// The full US channel plan (channels 1 to 28 and 60 to 88). Channels marked
// usUnassigned are the international duplex channels the US does not assign; they
// are kept so "marine channel 3" still resolves to a real frequency.
const MARINE_SPEC: MarineSpec[] = [
  {
    n: 1,
    a: true,
    use: "Port operations and commercial, VTS in the New Orleans and Lower Mississippi areas",
  },
  {
    n: 2,
    duplex: true,
    usUnassigned: true,
    use: "International duplex channel, not assigned in the US channel plan",
  },
  {
    n: 3,
    duplex: true,
    usUnassigned: true,
    use: "International duplex channel, not assigned in the US channel plan",
  },
  {
    n: 4,
    duplex: true,
    usUnassigned: true,
    use: "International duplex channel, not assigned in the US channel plan",
  },
  { n: 5, a: true, use: "Port operations or VTS in the Houston, New Orleans and Seattle areas" },
  { n: 6, use: "Intership safety" },
  { n: 7, a: true, use: "Commercial" },
  { n: 8, use: "Commercial, intership only" },
  { n: 9, use: "Boater calling, commercial and noncommercial" },
  { n: 10, use: "Commercial" },
  { n: 11, use: "Commercial and VTS in selected areas" },
  { n: 12, use: "Port operations and VTS in selected areas" },
  { n: 13, use: "Intership navigation safety, bridge to bridge" },
  { n: 14, use: "Port operations and VTS in selected areas" },
  { n: 15, use: "Environmental and Class C EPIRBs, receive only" },
  { n: 16, use: "International distress, safety and calling" },
  { n: 17, use: "State and local government maritime control" },
  { n: 18, a: true, use: "Commercial" },
  { n: 19, a: true, use: "Commercial" },
  { n: 20, duplex: true, use: "Port operations" },
  { n: 21, a: true, use: "US Coast Guard only" },
  { n: 22, a: true, use: "Coast Guard liaison and maritime safety information broadcasts" },
  { n: 23, a: true, use: "US Coast Guard only" },
  { n: 24, duplex: true, use: "Public correspondence, marine operator" },
  { n: 25, duplex: true, use: "Public correspondence, marine operator" },
  { n: 26, duplex: true, use: "Public correspondence, marine operator" },
  { n: 27, duplex: true, use: "Public correspondence, marine operator" },
  { n: 28, duplex: true, use: "Public correspondence, marine operator" },
  {
    n: 60,
    duplex: true,
    usUnassigned: true,
    use: "International duplex channel, not assigned in the US channel plan",
  },
  {
    n: 61,
    duplex: true,
    usUnassigned: true,
    use: "International duplex channel, not assigned in the US channel plan",
  },
  {
    n: 62,
    duplex: true,
    usUnassigned: true,
    use: "International duplex channel, not assigned in the US channel plan",
  },
  {
    n: 63,
    a: true,
    use: "Port operations and commercial, VTS in the New Orleans and Lower Mississippi areas",
  },
  {
    n: 64,
    duplex: true,
    usUnassigned: true,
    use: "International duplex channel, not assigned in the US channel plan",
  },
  { n: 65, a: true, use: "Port operations" },
  { n: 66, a: true, use: "Port operations" },
  { n: 67, use: "Commercial and bridge to bridge on the Lower Mississippi River" },
  { n: 68, use: "Noncommercial, recreational" },
  { n: 69, use: "Noncommercial, recreational" },
  { n: 70, use: "Digital Selective Calling for distress, safety and calling, voice not allowed" },
  { n: 71, use: "Noncommercial, recreational" },
  { n: 72, use: "Noncommercial, intership only" },
  { n: 73, use: "Port operations" },
  { n: 74, use: "Port operations" },
  { n: 75, use: "Port operations, intership only, guard band near channel 16" },
  { n: 76, use: "Port operations, intership only, guard band near channel 16" },
  { n: 77, use: "Port operations, intership only" },
  { n: 78, a: true, use: "Noncommercial" },
  { n: 79, a: true, use: "Commercial, and noncommercial on the Great Lakes" },
  { n: 80, a: true, use: "Commercial" },
  { n: 81, a: true, use: "US government only, environmental protection operations" },
  { n: 82, a: true, use: "US government only" },
  { n: 83, a: true, use: "US Coast Guard only" },
  { n: 84, duplex: true, use: "Public correspondence, marine operator" },
  { n: 85, duplex: true, use: "Public correspondence, marine operator" },
  { n: 86, duplex: true, use: "Public correspondence, marine operator" },
  { n: 87, use: "Port operations" },
  { n: 88, use: "Commercial, intership only near the Canadian border" },
];

const MARINE_CHANNELS: NamedChannel[] = MARINE_SPEC.map((s) => {
  const shipKHz = marineShipKHz(s.n);
  const coastKHz = s.duplex ? shipKHz + MARINE_COAST_OFFSET_KHZ : shipKHz;
  const centerHz = shipKHz * KHZ;
  const channel = s.a ? `${s.n}A` : `${s.n}`;
  return {
    service: "marine" as const,
    channel,
    number: s.n,
    name: `Channel ${channel}`,
    notes: s.usUnassigned
      ? "International duplex, not in the US plan"
      : s.duplex
        ? "Duplex, US channel plan"
        : "Simplex, US channel plan",
    simplex: !s.duplex,
    shipHz: shipKHz * KHZ,
    coastHz: coastKHz * KHZ,
    centerHz,
    lowerHz: centerHz - MARINE_HALF_HZ,
    upperHz: centerHz + MARINE_HALF_HZ,
    uses: [s.use],
  };
});

/* ---- CB radio (US 40 channel plan) -------------------------------- */

/*
 * The 40 US CB channels in kHz. This is hand tabled, not arithmetic, because the
 * plan has real irregularities: channels 23, 24 and 25 run out of numerical order
 * (23 sits above 25), and the gaps at 27.045, 27.095 and 27.145 MHz are the
 * radio control frequencies that split the grid. Verified against
 * https://en.wikipedia.org/wiki/Citizens_band_radio (26.965 to 27.405 MHz).
 */
const CB_KHZ: Record<number, number> = {
  1: 26965,
  2: 26975,
  3: 26985,
  4: 27005,
  5: 27015,
  6: 27025,
  7: 27035,
  8: 27055,
  9: 27065,
  10: 27075,
  11: 27085,
  12: 27105,
  13: 27115,
  14: 27125,
  15: 27135,
  16: 27155,
  17: 27165,
  18: 27175,
  19: 27185,
  20: 27205,
  21: 27215,
  22: 27225,
  23: 27255,
  24: 27235,
  25: 27245,
  26: 27265,
  27: 27275,
  28: 27285,
  29: 27295,
  30: 27305,
  31: 27315,
  32: 27325,
  33: 27335,
  34: 27345,
  35: 27355,
  36: 27365,
  37: 27375,
  38: 27385,
  39: 27395,
  40: 27405,
};
const CB_USE: Record<number, string> = {
  9: "Emergency and roadside assistance channel",
  19: "Highway and trucker channel",
};
const CB_HALF_HZ = 5_000; // 10 kHz channel spacing, half width

const CB_CHANNELS: NamedChannel[] = Object.keys(CB_KHZ)
  .map(Number)
  .sort((a, b) => a - b)
  .map((n) => {
    const centerHz = CB_KHZ[n]! * KHZ;
    return {
      service: "cb" as const,
      channel: `${n}`,
      number: n,
      name: `Channel ${n}`,
      simplex: true,
      centerHz,
      lowerHz: centerHz - CB_HALF_HZ,
      upperHz: centerHz + CB_HALF_HZ,
      uses: [CB_USE[n] ?? "License free Citizens Band voice"],
    };
  });

/* ---- NOAA Weather Radio (WX1 to WX7) ------------------------------ */

/*
 * The seven NOAA Weather Radio channels in kHz. The channel numbers are NOT in
 * frequency order: WX1 is the highest at 162.550 MHz. Verified against the
 * National Weather Service (weather.gov/nwr) and the RadioReference wiki.
 */
const WX_KHZ: Record<number, number> = {
  1: 162550,
  2: 162400,
  3: 162475,
  4: 162425,
  5: 162450,
  6: 162500,
  7: 162525,
};
const WX_HALF_HZ = 12_500; // 25 kHz channels

const NOAA_CHANNELS: NamedChannel[] = Object.keys(WX_KHZ)
  .map(Number)
  .sort((a, b) => a - b)
  .map((n) => {
    const centerHz = WX_KHZ[n]! * KHZ;
    return {
      service: "noaa" as const,
      channel: `WX${n}`,
      number: n,
      name: `Weather channel WX${n}`,
      simplex: true,
      centerHz,
      lowerHz: centerHz - WX_HALF_HZ,
      upperHz: centerHz + WX_HALF_HZ,
      uses: ["Continuous NOAA weather broadcasts and emergency alerts"],
    };
  });

/* ---- FM broadcast channels (US, 201 to 300) ----------------------- */

/*
 * US FM channels 201 through 300. Center frequency = 87.9 + 0.2 * (channel - 200)
 * MHz, so channel 201 is 88.1 MHz and channel 300 is 107.9 MHz. Each channel is
 * 200 kHz wide. Built in integer units of 100 kHz so the centers are exact
 * (channel 201 = 881 * 1e5 Hz = 88.1 MHz). Channels 201 to 220 (88.1 to 91.9 MHz)
 * are the reserved noncommercial educational band.
 * https://en.wikipedia.org/wiki/FM_broadcast_band
 */
const FM_HALF_HZ = 100_000; // 200 kHz channels

const FM_CHANNELS: NamedChannel[] = [];
for (let ch = 201; ch <= 300; ch++) {
  const centerHz = (879 + 2 * (ch - 200)) * 1e5;
  FM_CHANNELS.push({
    service: "fm",
    channel: `${ch}`,
    number: ch,
    name: `FM channel ${ch}`,
    notes: ch <= 220 ? "Reserved noncommercial educational band" : "Commercial FM band",
    simplex: true,
    centerHz,
    lowerHz: centerHz - FM_HALF_HZ,
    upperHz: centerHz + FM_HALF_HZ,
    uses: [
      ch <= 220 ? "Noncommercial and educational FM radio" : "Commercial FM radio broadcasting",
    ],
  });
}

/* ---- US television channels (VHF 2 to 13, UHF 14 to 36) ----------- */

/*
 * US broadcast TV channels. Each occupies a 6 MHz slot. The VHF low, mid and high
 * band edges are irregular (gaps at 72 to 76 MHz and 88 to 174 MHz), so the lower
 * edges are hand tabled; UHF is a clean 6 MHz grid from channel 14 (470 MHz). The
 * post repack UHF top is channel 36 (602 to 608 MHz); channel 37 is reserved for
 * radio astronomy and 38 and up were auctioned as the 600 MHz mobile band.
 * https://en.wikipedia.org/wiki/North_American_television_frequencies
 */
const TV_LOWER_MHZ: Record<number, number> = {
  2: 54,
  3: 60,
  4: 66,
  5: 76,
  6: 82,
  7: 174,
  8: 180,
  9: 186,
  10: 192,
  11: 198,
  12: 204,
  13: 210,
};
for (let n = 14; n <= 36; n++) TV_LOWER_MHZ[n] = 470 + 6 * (n - 14);

const TV_CHANNELS: NamedChannel[] = Object.keys(TV_LOWER_MHZ)
  .map(Number)
  .sort((a, b) => a - b)
  .map((n) => {
    const lowerHz = TV_LOWER_MHZ[n]! * MHZ;
    const upperHz = (TV_LOWER_MHZ[n]! + 6) * MHZ;
    const band = n <= 13 ? "VHF" : "UHF";
    return {
      service: "tv" as const,
      channel: `${n}`,
      number: n,
      name: `TV channel ${n}`,
      notes: `${band} broadcast television`,
      simplex: true,
      centerHz: (TV_LOWER_MHZ[n]! + 3) * MHZ,
      lowerHz,
      upperHz,
      uses: ["Over the air broadcast television in the United States"],
    };
  });

/** Every modeled US / North American numbered or named channel. */
export const NAMED_CHANNELS: NamedChannel[] = [
  ...MARINE_CHANNELS,
  ...CB_CHANNELS,
  ...NOAA_CHANNELS,
  ...FM_CHANNELS,
  ...TV_CHANNELS,
];
