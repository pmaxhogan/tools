/**
 * Curated query synonyms for tool search.
 *
 * People type the word they think in, not the word a tool page happens to use:
 * "sound" for audio, "picture" for image, "pw" for password, "movie" for
 * video. This map turns each of those into the words the tool metadata really
 * contains, so search finds the tool without every meta having to list every
 * informal spelling of its subject.
 *
 * Rules for this file:
 *
 * 1. Keys are single lowercase tokens, matched against a whole search token
 *    (never a substring of one). Values may be multi word phrases.
 * 2. Expansion is SINGLE HOP. "subnet" does not inherit the expansions of
 *    "ip", so anything a key needs is listed on that key directly.
 * 3. Expansion widens what matches, it never narrows it, and an expansion hit
 *    always scores below the same hit on the typed word (see search.ts).
 * 4. Non US spellings are deliberate KEYS here (colour, grey, analyser, metre
 *    and the rest of the British block at the bottom). The site writes US
 *    English, visitors do not, and this file is a search index rather than
 *    user facing prose, so the US English spelling sweep and
 *    scripts/check-spelling.mjs must exempt it, exactly as they exempt the
 *    British spellings kept in meta `searchTerms`.
 */

/** Common word to expansion phrases. See the rules above before adding rows. */
export const SEARCH_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // Audio
  sound: ["audio", "tone"],
  audio: ["sound"],
  mic: ["microphone", "audio"],
  microphone: ["mic", "audio"],
  song: ["audio", "music"],
  mp3: ["audio"],
  wav: ["audio"],
  flac: ["audio"],
  ogg: ["audio"],
  m4a: ["audio"],
  bpm: ["tempo", "beat"],
  hz: ["frequency"],

  // Images
  picture: ["image", "photo"],
  photo: ["image", "picture"],
  pic: ["image", "photo"],
  img: ["image"],
  image: ["photo", "picture"],
  png: ["image"],
  jpg: ["image", "jpeg"],
  jpeg: ["image", "jpg"],
  webp: ["image"],
  svg: ["image", "vector"],
  ico: ["icon", "favicon"],
  cam: ["camera", "webcam"],
  webcam: ["camera"],
  exif: ["metadata", "image"],

  // Video
  movie: ["video"],
  clip: ["video"],
  vid: ["video"],
  film: ["video"],
  mp4: ["video"],
  mov: ["video"],
  mkv: ["video"],
  webm: ["video"],
  gif: ["video", "animation"],
  subs: ["subtitle", "caption"],

  // Files and archives
  zip: ["archive", "compress"],
  unzip: ["archive", "extract"],
  archive: ["zip", "compress"],
  tar: ["archive"],
  pdf: ["document"],
  doc: ["document", "word"],
  docx: ["document", "word"],
  xls: ["spreadsheet", "excel"],
  xlsx: ["spreadsheet", "excel"],
  sheet: ["spreadsheet", "csv"],
  csv: ["spreadsheet", "table"],

  // Text and markup
  md: ["markdown"],
  yml: ["yaml"],
  ts: ["typescript"],
  js: ["javascript"],
  py: ["python"],
  regex: ["regular expression"],
  regexp: ["regular expression"],
  ocr: ["text recognition", "scan"],
  emoji: ["unicode"],
  ascii: ["unicode", "character"],
  utf: ["unicode", "encoding"],
  b64: ["base64"],
  hex: ["hexadecimal"],
  bin: ["binary"],
  slug: ["url"],

  // Color
  colour: ["color"],
  color: ["colour"],
  colours: ["color", "colors"],
  grey: ["gray"],
  gray: ["grey"],

  // Crypto and security
  cert: ["certificate"],
  ssl: ["certificate", "tls"],
  tls: ["certificate", "ssl"],
  jwt: ["token"],
  pw: ["password"],
  pwd: ["password"],
  passwd: ["password"],
  otp: ["totp", "two factor"],
  "2fa": ["totp", "two factor"],
  mfa: ["totp", "two factor"],
  hash: ["checksum", "digest"],
  checksum: ["hash"],
  md5: ["hash", "checksum"],
  sha: ["hash", "checksum"],
  uuid: ["guid", "unique id"],
  guid: ["uuid"],

  // Network
  ip: ["network", "address"],
  subnet: ["ip", "network"],
  cidr: ["ip", "network"],
  netmask: ["subnet", "ip"],
  dns: ["domain", "network"],
  domain: ["dns"],
  wifi: ["network", "wireless"],
  mac: ["mac address", "network"],
  url: ["link", "uri"],
  uri: ["url"],
  ua: ["user agent"],

  // Time
  timestamp: ["epoch", "unix time"],
  epoch: ["timestamp", "unix time"],
  unix: ["epoch", "timestamp"],
  tz: ["timezone"],
  utc: ["timezone", "time"],
  cron: ["schedule"],

  // Data
  db: ["database", "sql"],
  sql: ["database", "query"],
  sqlite: ["database", "sql"],
  diff: ["compare"],
  compare: ["diff"],

  // Homelab and hardware
  nas: ["raidz", "storage"],
  zfs: ["raidz", "storage"],
  raid: ["raidz", "storage"],
  docker: ["compose", "container"],
  compose: ["docker"],
  container: ["docker"],
  gpu: ["graphics"],
  cpu: ["processor"],
  awg: ["wire gauge"],

  // Local AI
  ai: ["local ai", "model"],
  llm: ["local ai", "model"],
  ml: ["local ai", "model"],

  // Geo
  gps: ["coordinates", "location"],
  lat: ["coordinates", "latitude"],
  lon: ["coordinates", "longitude"],
  lng: ["coordinates", "longitude"],
  coords: ["coordinates"],
  geo: ["coordinates", "map"],

  // Science
  em: ["electromagnetic"],
  ems: ["electromagnetic spectrum"],
  nfpa: ["fire diamond", "hazard"],

  // Codes
  qr: ["qr code", "barcode"],
  barcode: ["qr code"],

  // British spellings, so a visitor who writes them still finds the US English
  // tool names. Deliberate non US keys: see rule 4 in the header.
  analyse: ["analyze"],
  analyser: ["analyzer"],
  centre: ["center"],
  normalise: ["normalize"],
  optimise: ["optimize"],
  organise: ["organize"],
  serialise: ["serialize"],
  visualise: ["visualize"],
  minimise: ["minimize"],
  licence: ["license"],
  defence: ["defense"],
  behaviour: ["behavior"],
  catalogue: ["catalog"],
  metre: ["meter"],
  litre: ["liter"],
  aluminium: ["aluminum"],
};

const EMPTY: readonly string[] = [];

const EXPANSIONS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(SEARCH_SYNONYMS));

/**
 * Expansions for one search token, or an empty array. A Map lookup, not a
 * property read, so tokens like "constructor" or "__proto__" cannot reach
 * anything on Object.prototype.
 */
export function expandToken(token: string): readonly string[] {
  return EXPANSIONS.get(token) ?? EMPTY;
}
