/**
 * City table for the sun calculator.
 *
 * Pure data plus two small pure helpers. Each row is
 * `[display name, latitude, longitude, IANA zone, ...extra aliases]` with
 * latitude positive north and longitude positive east. The display name is
 * always an alias of itself, so most rows need no extra aliases at all.
 * Lookup keys are normalized: accents folded, lower cased, every character
 * that is not a letter or a digit removed, so "St. Louis", "st louis", and
 * "SAINT-LOUIS" all land on the same entry.
 *
 * The list is deliberately short. It exists so a reader can type a city
 * instead of hunting for coordinates, not to be a gazetteer. Anything not in
 * here is entered as "lat, lon" directly.
 */

/** [name, latitude, longitude, IANA zone, ...aliases] */
const RAW: readonly (readonly [string, number, number, string, ...string[]])[] = [
  // North America
  ["New York", 40.7128, -74.006, "America/New_York", "nyc", "new york city", "manhattan"],
  ["Washington DC", 38.9072, -77.0369, "America/New_York", "washington", "dc"],
  ["Boston", 42.3601, -71.0589, "America/New_York"],
  ["Miami", 25.7617, -80.1918, "America/New_York"],
  ["Atlanta", 33.749, -84.388, "America/New_York", "atl"],
  ["Chicago", 41.8781, -87.6298, "America/Chicago"],
  ["St Louis", 38.627, -90.1994, "America/Chicago", "saint louis", "stl"],
  ["Houston", 29.7604, -95.3698, "America/Chicago"],
  ["Dallas", 32.7767, -96.797, "America/Chicago", "dfw"],
  ["Minneapolis", 44.9778, -93.265, "America/Chicago", "twin cities"],
  ["Denver", 39.7392, -104.9903, "America/Denver"],
  ["Phoenix", 33.4484, -112.074, "America/Phoenix"],
  ["Los Angeles", 34.0522, -118.2437, "America/Los_Angeles", "la", "hollywood"],
  ["San Francisco", 37.7749, -122.4194, "America/Los_Angeles", "sf", "bay area"],
  ["Seattle", 47.6062, -122.3321, "America/Los_Angeles"],
  ["Anchorage", 61.2181, -149.9003, "America/Anchorage"],
  ["Honolulu", 21.3069, -157.8583, "Pacific/Honolulu", "hawaii"],
  ["Toronto", 43.6532, -79.3832, "America/Toronto"],
  ["Montreal", 45.5019, -73.5674, "America/Toronto"],
  ["Vancouver", 49.2827, -123.1207, "America/Vancouver"],
  ["Mexico City", 19.4326, -99.1332, "America/Mexico_City", "cdmx"],

  // South America
  ["Bogota", 4.711, -74.0721, "America/Bogota"],
  ["Lima", -12.0464, -77.0428, "America/Lima"],
  ["Sao Paulo", -23.5505, -46.6333, "America/Sao_Paulo"],
  ["Rio de Janeiro", -22.9068, -43.1729, "America/Sao_Paulo", "rio"],
  ["Buenos Aires", -34.6037, -58.3816, "America/Argentina/Buenos_Aires"],
  ["Santiago", -33.4489, -70.6693, "America/Santiago"],

  // Europe
  ["London", 51.5074, -0.1278, "Europe/London"],
  ["Edinburgh", 55.9533, -3.1883, "Europe/London"],
  ["Dublin", 53.3498, -6.2603, "Europe/Dublin"],
  ["Lisbon", 38.7223, -9.1393, "Europe/Lisbon"],
  ["Madrid", 40.4168, -3.7038, "Europe/Madrid"],
  ["Barcelona", 41.3851, 2.1734, "Europe/Madrid"],
  ["Paris", 48.8566, 2.3522, "Europe/Paris"],
  ["Amsterdam", 52.3676, 4.9041, "Europe/Amsterdam"],
  ["Berlin", 52.52, 13.405, "Europe/Berlin"],
  ["Zurich", 47.3769, 8.5417, "Europe/Zurich"],
  ["Vienna", 48.2082, 16.3738, "Europe/Vienna"],
  ["Prague", 50.0755, 14.4378, "Europe/Prague"],
  ["Rome", 41.9028, 12.4964, "Europe/Rome"],
  ["Athens", 37.9838, 23.7275, "Europe/Athens"],
  ["Warsaw", 52.2297, 21.0122, "Europe/Warsaw"],
  ["Copenhagen", 55.6761, 12.5683, "Europe/Copenhagen"],
  ["Oslo", 59.9139, 10.7522, "Europe/Oslo"],
  ["Stockholm", 59.3293, 18.0686, "Europe/Stockholm"],
  ["Helsinki", 60.1699, 24.9384, "Europe/Helsinki"],
  ["Reykjavik", 64.1466, -21.9426, "Atlantic/Reykjavik"],
  ["Tromso", 69.6492, 18.9553, "Europe/Oslo", "tromsoe"],
  ["Moscow", 55.7558, 37.6173, "Europe/Moscow"],
  ["Istanbul", 41.0082, 28.9784, "Europe/Istanbul"],

  // Africa and the Middle East
  ["Cairo", 30.0444, 31.2357, "Africa/Cairo"],
  ["Lagos", 6.5244, 3.3792, "Africa/Lagos"],
  ["Nairobi", -1.2921, 36.8219, "Africa/Nairobi"],
  ["Johannesburg", -26.2041, 28.0473, "Africa/Johannesburg", "joburg"],
  ["Cape Town", -33.9249, 18.4241, "Africa/Johannesburg"],
  ["Tel Aviv", 32.0853, 34.7818, "Asia/Jerusalem"],
  ["Riyadh", 24.7136, 46.6753, "Asia/Riyadh"],
  ["Dubai", 25.2048, 55.2708, "Asia/Dubai"],

  // Asia
  ["Karachi", 24.8607, 67.0011, "Asia/Karachi"],
  ["Mumbai", 19.076, 72.8777, "Asia/Kolkata", "bombay"],
  ["Delhi", 28.6139, 77.209, "Asia/Kolkata", "new delhi"],
  ["Bengaluru", 12.9716, 77.5946, "Asia/Kolkata", "bangalore"],
  ["Bangkok", 13.7563, 100.5018, "Asia/Bangkok"],
  ["Singapore", 1.3521, 103.8198, "Asia/Singapore"],
  ["Jakarta", -6.2088, 106.8456, "Asia/Jakarta"],
  ["Hong Kong", 22.3193, 114.1694, "Asia/Hong_Kong", "hongkong"],
  ["Shanghai", 31.2304, 121.4737, "Asia/Shanghai"],
  ["Beijing", 39.9042, 116.4074, "Asia/Shanghai", "peking"],
  ["Taipei", 25.033, 121.5654, "Asia/Taipei"],
  ["Manila", 14.5995, 120.9842, "Asia/Manila"],
  ["Seoul", 37.5665, 126.978, "Asia/Seoul"],
  ["Tokyo", 35.6762, 139.6503, "Asia/Tokyo"],
  ["Osaka", 34.6937, 135.5023, "Asia/Tokyo"],

  // Oceania and Antarctica
  ["Perth", -31.9505, 115.8605, "Australia/Perth"],
  ["Brisbane", -27.4698, 153.0251, "Australia/Brisbane"],
  ["Melbourne", -37.8136, 144.9631, "Australia/Melbourne"],
  ["Sydney", -33.8688, 151.2093, "Australia/Sydney"],
  ["Auckland", -36.8485, 174.7633, "Pacific/Auckland"],
  ["McMurdo Station", -77.8419, 166.6863, "Antarctica/McMurdo", "mcmurdo"],
];

/** A resolved city: where it is and which time zone it keeps. */
export interface PlaceEntry {
  /** How the place is labeled in the output. */
  name: string;
  /** Degrees north of the equator. */
  lat: number;
  /** Degrees east of Greenwich. */
  lon: number;
  /** IANA zone name, used as the default display zone. */
  zone: string;
}

/**
 * Fold a place name to a lookup key: accents removed, lower cased, and every
 * character that is not a letter or a digit dropped.
 */
export function normalizePlace(raw: string): string {
  return raw
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildIndex(): Map<string, PlaceEntry> {
  const index = new Map<string, PlaceEntry>();
  for (const row of RAW) {
    const [name, lat, lon, zone, ...aliases] = row;
    const entry: PlaceEntry = { name, lat, lon, zone };
    for (const alias of [name, ...aliases]) {
      const key = normalizePlace(alias);
      if (key && !index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

const INDEX = buildIndex();

/** Look up a city by name or alias. Undefined when the name is unknown. */
export function lookupPlace(token: string): PlaceEntry | undefined {
  return INDEX.get(normalizePlace(token));
}

/** How many cities the table holds (aliases are not counted twice). */
export const PLACE_COUNT = RAW.length;

/** Every city in the table, one entry per row. Used by the tests. */
export function allPlaces(): PlaceEntry[] {
  return RAW.map(([name, lat, lon, zone]) => ({ name, lat, lon, zone }));
}
