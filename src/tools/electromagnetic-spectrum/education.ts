/**
 * The educational layer: short, factual notes per physical band region on
 * what the radiation is, how it propagates, what it penetrates, and what it
 * does to people. Keyed by the band ids in data.ts, looked up along the band
 * path so a frequency inside a sub band inherits its region's note.
 */

import { bandPathAt } from "./index";

export interface BandEducation {
  /** Band id in data.ts. */
  bandId: string;
  what: string;
  propagation: string;
  penetration: string;
  health: string;
}

export const BAND_EDUCATION: BandEducation[] = [
  {
    bandId: "gamma",
    what: "Gamma rays are photons from nuclear decay, cosmic sources and particle interactions, with energies from tens of keV up through GeV.",
    propagation:
      "They travel in straight lines and are absorbed only by dense matter; the atmosphere stops cosmic gamma rays, which is why gamma telescopes fly in orbit.",
    penetration:
      "Centimeters of lead or a meter of concrete for meaningful shielding. They pass straight through the body, which is what makes them useful for imaging and sterilization.",
    health:
      "Strongly ionizing. Dose is what matters: medical scans are small controlled doses, while accidental exposure to sources damages DNA and tissue.",
  },
  {
    bandId: "xray",
    what: "X-rays are produced when fast electrons hit matter or drop between inner atomic shells, in the 100 eV to 100 keV range used by medicine, security and crystallography.",
    propagation:
      "Straight lines, absorbed by dense or high atomic number materials, scattered by lighter ones. The atmosphere absorbs astronomical X-rays entirely.",
    penetration:
      "Soft X-rays are stopped by skin and air; hard X-rays pass through soft tissue and are stopped by bone, which is the whole basis of radiography.",
    health:
      "Ionizing. Diagnostic doses are kept as low as reasonably achievable; repeated or high doses raise cancer risk, and lead aprons and distance are the standard protections.",
  },
  {
    bandId: "uv",
    what: "Ultraviolet sits just above visible violet, split into UV-A, UV-B and UV-C, plus the extreme UV used in the newest chip lithography.",
    propagation:
      "The ozone layer absorbs almost all UV-C and most UV-B, so sunlight at the ground is mostly UV-A. Ordinary glass blocks most UV-B.",
    penetration:
      "UV-A reaches the dermis; UV-B mostly stops in the epidermis; UV-C is absorbed in the outermost dead skin layer and by the cornea.",
    health:
      "UV-B causes sunburn and most skin cancer, UV-A drives tanning and photoaging, and UV-C germicidal lamps can burn eyes and skin in seconds. Photons above about 10 eV start to ionize.",
  },
  {
    bandId: "visible",
    what: "Visible light is the 380 to 750 nm sliver our eyes evolved to see, which is also where sunlight at the ground is brightest.",
    propagation:
      "Scattered by the atmosphere (blue more than red, hence blue skies and red sunsets), refracted by glass and water, reflected by most surfaces.",
    penetration:
      "A few millimeters into skin, deeper for red; enough for pulse oximeters to read blood oxygen through a fingertip.",
    health:
      "Non ionizing. Ordinary levels are harmless; intense sources such as lasers and arc welding damage the retina, and blue rich light in the evening shifts sleep timing.",
  },
  {
    bandId: "ir",
    what: "Infrared runs from just below red out to the terahertz gap: near IR used by remotes and fiber optics, mid IR where molecules absorb, far IR emitted by everything at room temperature.",
    propagation:
      "Water vapor and CO2 absorb whole swaths of it, leaving atmospheric windows that thermal cameras and astronomy use. Near IR passes through haze better than visible light.",
    penetration:
      "Near IR penetrates skin and tissue a centimeter or more; longer IR is absorbed at the surface and felt as heat.",
    health:
      "Non ionizing. The hazard is heating: strong IR sources cause burns and, with long exposure, cataracts. Consumer IR devices are far below those levels.",
  },
  {
    bandId: "microwave",
    what: "Microwaves are the 300 MHz to 300 GHz radio bands: cellular, Wi-Fi, Bluetooth, GPS, radar, satellite links and the 2.45 GHz that heats food.",
    propagation:
      "Mostly line of sight. Lower microwaves pass through walls with loss; above about 10 GHz rain and oxygen absorption grow, and at 60 GHz oxygen alone eats the signal within a kilometer.",
    penetration:
      "Centimeters into tissue at 1 GHz, millimeters at 30 GHz, fractions of a millimeter by 100 GHz. Penetration falls as frequency rises.",
    health:
      "Non ionizing. The only established effect is heating, which is what the FCC exposure limits cap. Consumer devices run at a small fraction of the limit; the limits themselves include a large safety margin.",
  },
  {
    bandId: "radio",
    what: "Radio here means everything below 300 MHz: ELF through VHF, from submarine communication and power line hum up to FM broadcast, aviation and the 2 m amateur band.",
    propagation:
      "The workhorse behaviors live here: ground wave along the surface at LF and MF, skywave bounce off the ionosphere at HF, and line of sight plus tropospheric ducting at VHF.",
    penetration:
      "Long wavelengths pass through buildings and foliage with little loss, and ELF even penetrates seawater and rock.",
    health:
      "Non ionizing. Exposure limits below 30 MHz are written as field strength rather than power density, because a person is small compared with the wavelength and heating is not the simple far field picture.",
  },
  {
    bandId: "radio-hf",
    what: "High frequency, 3 to 30 MHz, is shortwave: international broadcasting, amateur radio DX, aviation and maritime long haul, and over the horizon radar.",
    propagation:
      "Refracted back to Earth by the ionosphere, so signals hop thousands of kilometers. Which bands work changes with time of day, season and the solar cycle.",
    penetration:
      "Passes through buildings freely; the human body is a fraction of a wavelength across and barely interacts.",
    health:
      "Non ionizing. The FCC limit is a field strength limit here, and amateur stations must evaluate exposure above the exemption power.",
  },
  {
    bandId: "radio-vhf",
    what: "Very high frequency, 30 to 300 MHz, carries FM radio, VHF TV, aviation voice and navigation, marine radio, and the 6 m and 2 m amateur bands.",
    propagation:
      "Mostly line of sight with a little beyond the horizon bending; sporadic E and tropospheric ducting occasionally carry it hundreds of kilometers.",
    penetration:
      "Passes through wood and drywall with modest loss; metal and reinforced concrete block it.",
    health:
      "Non ionizing. The uncontrolled exposure limit is at its lowest (0.2 mW/cm2) in the 30 to 300 MHz range because the body resonates there, so this is where a handheld or a rooftop antenna deserves the most respect.",
  },
];

const BY_ID = new Map(BAND_EDUCATION.map((e) => [e.bandId, e]));

/** The note for one band id, if any. */
export function educationFor(bandId: string): BandEducation | undefined {
  return BY_ID.get(bandId);
}

/**
 * The most specific note along the band path at a frequency: a VHF frequency
 * gets the VHF note, a UV-B frequency inherits the UV note.
 */
export function educationAt(freqHz: number): BandEducation | undefined {
  const path = bandPathAt(freqHz);
  for (let i = path.length - 1; i >= 0; i--) {
    const hit = BY_ID.get(path[i]!.id);
    if (hit) return hit;
  }
  return undefined;
}
