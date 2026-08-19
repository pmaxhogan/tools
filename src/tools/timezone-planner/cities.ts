/**
 * City and alias table for the timezone planner.
 *
 * Pure data plus two tiny pure helpers. Each row is
 * `[IANA zone, display name, ...extra aliases]`; the display name is always an
 * alias of itself, so most rows need no extra aliases at all. Lookup keys are
 * normalized: accents folded, lower cased, every character that is not a letter
 * or a digit removed. That makes "St. Louis", "st louis", and "SAINT-LOUIS"
 * all land on the same entry.
 */

/** [zone, display name, ...aliases] */
const RAW: readonly (readonly string[])[] = [
  // North America
  ["America/New_York", "New York", "nyc", "new york city", "ny", "manhattan", "brooklyn"],
  ["America/New_York", "Washington DC", "washington", "dc", "district of columbia"],
  ["America/New_York", "Boston"],
  ["America/New_York", "Philadelphia", "philly"],
  ["America/New_York", "Atlanta", "atl"],
  ["America/New_York", "Miami"],
  ["America/New_York", "Orlando"],
  ["America/New_York", "Tampa"],
  ["America/New_York", "Charlotte"],
  ["America/New_York", "Raleigh"],
  ["America/New_York", "Baltimore"],
  ["America/New_York", "Pittsburgh"],
  ["America/New_York", "Cleveland"],
  ["America/New_York", "Cincinnati"],
  ["America/New_York", "Columbus"],
  ["America/New_York", "Indianapolis", "indy"],
  ["America/Detroit", "Detroit"],
  ["America/Toronto", "Toronto", "yyz"],
  ["America/Toronto", "Ottawa"],
  ["America/Montreal", "Montreal"],
  ["America/Halifax", "Halifax"],
  ["America/St_Johns", "St Johns", "saint johns", "newfoundland"],
  ["America/Chicago", "Chicago", "chi"],
  ["America/Chicago", "St Louis", "saint louis", "stl"],
  ["America/Chicago", "Dallas", "dfw", "fort worth"],
  ["America/Chicago", "Houston"],
  ["America/Chicago", "Austin"],
  ["America/Chicago", "San Antonio"],
  ["America/Chicago", "Minneapolis", "twin cities", "st paul", "saint paul"],
  ["America/Chicago", "Kansas City", "kc"],
  ["America/Chicago", "New Orleans", "nola"],
  ["America/Chicago", "Milwaukee"],
  ["America/Chicago", "Madison"],
  ["America/Chicago", "Memphis"],
  ["America/Chicago", "Nashville"],
  ["America/Chicago", "Oklahoma City", "okc"],
  ["America/Chicago", "Omaha"],
  ["America/Chicago", "Des Moines"],
  ["America/Winnipeg", "Winnipeg"],
  ["America/Denver", "Denver"],
  ["America/Denver", "Salt Lake City", "slc"],
  ["America/Denver", "Albuquerque"],
  ["America/Denver", "Colorado Springs"],
  ["America/Boise", "Boise"],
  ["America/Edmonton", "Edmonton"],
  ["America/Edmonton", "Calgary"],
  ["America/Phoenix", "Phoenix"],
  ["America/Phoenix", "Tucson"],
  ["America/Phoenix", "Scottsdale"],
  ["America/Los_Angeles", "Los Angeles", "la", "lax", "hollywood"],
  ["America/Los_Angeles", "San Francisco", "sf", "bay area", "silicon valley"],
  ["America/Los_Angeles", "San Jose"],
  ["America/Los_Angeles", "San Diego"],
  ["America/Los_Angeles", "Sacramento"],
  ["America/Los_Angeles", "Seattle"],
  ["America/Los_Angeles", "Portland"],
  ["America/Los_Angeles", "Las Vegas", "vegas"],
  ["America/Vancouver", "Vancouver"],
  ["America/Anchorage", "Anchorage", "alaska"],
  ["Pacific/Honolulu", "Honolulu", "hawaii"],
  ["America/Mexico_City", "Mexico City", "cdmx", "mexico"],
  ["America/Mexico_City", "Guadalajara"],
  ["America/Monterrey", "Monterrey"],
  ["America/Guatemala", "Guatemala City", "guatemala"],
  ["America/Panama", "Panama City", "panama"],
  ["America/Havana", "Havana"],
  ["America/Puerto_Rico", "San Juan", "puerto rico"],
  ["America/Jamaica", "Kingston", "jamaica"],

  // South America
  ["America/Sao_Paulo", "Sao Paulo", "sp", "saopaulo"],
  ["America/Sao_Paulo", "Rio de Janeiro", "rio"],
  ["America/Sao_Paulo", "Brasilia", "brasília"],
  ["America/Argentina/Buenos_Aires", "Buenos Aires", "argentina"],
  ["America/Santiago", "Santiago", "chile"],
  ["America/Lima", "Lima", "peru"],
  ["America/Bogota", "Bogota", "bogotá", "colombia"],
  ["America/Caracas", "Caracas", "venezuela"],
  ["America/Montevideo", "Montevideo", "uruguay"],
  ["America/La_Paz", "La Paz", "bolivia"],
  ["America/Asuncion", "Asuncion", "asunción", "paraguay"],
  ["America/Guayaquil", "Quito", "guayaquil", "ecuador"],

  // Europe
  ["Europe/London", "London", "ldn", "uk", "united kingdom", "england", "britain"],
  ["Europe/London", "Manchester"],
  ["Europe/London", "Birmingham"],
  ["Europe/London", "Leeds"],
  ["Europe/London", "Liverpool"],
  ["Europe/London", "Bristol"],
  ["Europe/London", "Edinburgh"],
  ["Europe/London", "Glasgow"],
  ["Europe/London", "Cardiff"],
  ["Europe/London", "Belfast"],
  ["Europe/Dublin", "Dublin", "ireland"],
  ["Europe/Lisbon", "Lisbon", "lisboa", "portugal"],
  ["Europe/Lisbon", "Porto", "oporto"],
  ["Europe/Madrid", "Madrid", "spain"],
  ["Europe/Madrid", "Barcelona", "bcn"],
  ["Europe/Madrid", "Valencia"],
  ["Europe/Madrid", "Seville", "sevilla"],
  ["Europe/Paris", "Paris", "france"],
  ["Europe/Paris", "Lyon"],
  ["Europe/Paris", "Marseille"],
  ["Europe/Paris", "Toulouse"],
  ["Europe/Paris", "Nice"],
  ["Europe/Berlin", "Berlin", "germany", "deutschland"],
  ["Europe/Berlin", "Munich", "munchen", "münchen"],
  ["Europe/Berlin", "Frankfurt"],
  ["Europe/Berlin", "Hamburg"],
  ["Europe/Berlin", "Cologne", "koln", "köln"],
  ["Europe/Berlin", "Stuttgart"],
  ["Europe/Berlin", "Dusseldorf", "düsseldorf"],
  ["Europe/Amsterdam", "Amsterdam", "netherlands", "holland"],
  ["Europe/Amsterdam", "Rotterdam"],
  ["Europe/Amsterdam", "The Hague", "den haag"],
  ["Europe/Brussels", "Brussels", "bruxelles", "belgium"],
  ["Europe/Brussels", "Antwerp", "antwerpen"],
  ["Europe/Luxembourg", "Luxembourg"],
  ["Europe/Zurich", "Zurich", "zürich", "switzerland"],
  ["Europe/Zurich", "Geneva", "geneve", "genève"],
  ["Europe/Zurich", "Bern"],
  ["Europe/Zurich", "Basel"],
  ["Europe/Vienna", "Vienna", "wien", "austria"],
  ["Europe/Rome", "Rome", "roma", "italy"],
  ["Europe/Rome", "Milan", "milano"],
  ["Europe/Rome", "Naples", "napoli"],
  ["Europe/Rome", "Turin", "torino"],
  ["Europe/Rome", "Florence", "firenze"],
  ["Europe/Rome", "Venice", "venezia"],
  ["Europe/Copenhagen", "Copenhagen", "kobenhavn", "denmark"],
  ["Europe/Oslo", "Oslo", "norway"],
  ["Europe/Stockholm", "Stockholm", "sweden"],
  ["Europe/Stockholm", "Gothenburg", "goteborg", "göteborg"],
  ["Europe/Helsinki", "Helsinki", "finland"],
  ["Europe/Tallinn", "Tallinn", "estonia"],
  ["Europe/Riga", "Riga", "latvia"],
  ["Europe/Vilnius", "Vilnius", "lithuania"],
  ["Europe/Warsaw", "Warsaw", "warszawa", "poland"],
  ["Europe/Warsaw", "Krakow", "kraków", "cracow"],
  ["Europe/Prague", "Prague", "praha", "czechia", "czech republic"],
  ["Europe/Budapest", "Budapest", "hungary"],
  ["Europe/Bucharest", "Bucharest", "romania"],
  ["Europe/Sofia", "Sofia", "bulgaria"],
  ["Europe/Belgrade", "Belgrade", "beograd", "serbia"],
  ["Europe/Zagreb", "Zagreb", "croatia"],
  ["Europe/Athens", "Athens", "greece"],
  ["Europe/Kyiv", "Kyiv", "kiev", "ukraine"],
  ["Europe/Moscow", "Moscow", "moskva", "russia"],
  ["Europe/Moscow", "St Petersburg", "saint petersburg", "spb"],
  ["Europe/Istanbul", "Istanbul", "turkey", "turkiye"],
  ["Europe/Istanbul", "Ankara"],
  ["Atlantic/Reykjavik", "Reykjavik", "iceland"],

  // Africa and the Middle East
  ["Africa/Casablanca", "Casablanca", "morocco", "rabat"],
  ["Africa/Algiers", "Algiers", "algeria"],
  ["Africa/Tunis", "Tunis", "tunisia"],
  ["Africa/Cairo", "Cairo", "egypt"],
  ["Africa/Lagos", "Lagos", "nigeria"],
  ["Africa/Accra", "Accra", "ghana"],
  ["Africa/Nairobi", "Nairobi", "kenya"],
  ["Africa/Addis_Ababa", "Addis Ababa", "ethiopia"],
  ["Africa/Johannesburg", "Johannesburg", "joburg", "south africa"],
  ["Africa/Johannesburg", "Cape Town"],
  ["Africa/Johannesburg", "Durban"],
  ["Africa/Johannesburg", "Pretoria"],
  ["Asia/Jerusalem", "Tel Aviv", "israel"],
  ["Asia/Jerusalem", "Jerusalem"],
  ["Asia/Beirut", "Beirut", "lebanon"],
  ["Asia/Amman", "Amman", "jordan"],
  ["Asia/Baghdad", "Baghdad", "iraq"],
  ["Asia/Tehran", "Tehran", "iran"],
  ["Asia/Dubai", "Dubai", "uae", "united arab emirates"],
  ["Asia/Dubai", "Abu Dhabi"],
  ["Asia/Qatar", "Doha", "qatar"],
  ["Asia/Kuwait", "Kuwait City", "kuwait"],
  ["Asia/Riyadh", "Riyadh", "saudi arabia"],
  ["Asia/Riyadh", "Jeddah"],

  // Asia
  ["Asia/Karachi", "Karachi", "pakistan"],
  ["Asia/Karachi", "Lahore"],
  ["Asia/Karachi", "Islamabad"],
  ["Asia/Kolkata", "Delhi", "new delhi", "india"],
  ["Asia/Kolkata", "Mumbai", "bombay"],
  ["Asia/Kolkata", "Bangalore", "bengaluru", "blr"],
  ["Asia/Kolkata", "Kolkata", "calcutta"],
  ["Asia/Kolkata", "Chennai", "madras"],
  ["Asia/Kolkata", "Hyderabad"],
  ["Asia/Kolkata", "Pune"],
  ["Asia/Kolkata", "Ahmedabad"],
  ["Asia/Kolkata", "Gurgaon", "gurugram", "noida"],
  ["Asia/Kathmandu", "Kathmandu", "nepal"],
  ["Asia/Colombo", "Colombo", "sri lanka"],
  ["Asia/Dhaka", "Dhaka", "bangladesh"],
  ["Asia/Yangon", "Yangon", "myanmar", "rangoon"],
  ["Asia/Bangkok", "Bangkok", "thailand"],
  ["Asia/Ho_Chi_Minh", "Ho Chi Minh City", "saigon", "hcmc", "vietnam"],
  ["Asia/Bangkok", "Hanoi"],
  ["Asia/Phnom_Penh", "Phnom Penh", "cambodia"],
  ["Asia/Jakarta", "Jakarta", "indonesia"],
  ["Asia/Singapore", "Singapore", "sg", "sgp"],
  ["Asia/Kuala_Lumpur", "Kuala Lumpur", "kl", "malaysia"],
  ["Asia/Manila", "Manila", "philippines"],
  ["Asia/Hong_Kong", "Hong Kong", "hk", "hkg"],
  ["Asia/Taipei", "Taipei", "taiwan"],
  ["Asia/Shanghai", "Shanghai"],
  ["Asia/Shanghai", "Beijing", "peking", "china"],
  ["Asia/Shanghai", "Shenzhen"],
  ["Asia/Shanghai", "Guangzhou", "canton"],
  ["Asia/Shanghai", "Chengdu"],
  ["Asia/Seoul", "Seoul", "korea", "south korea"],
  ["Asia/Seoul", "Busan"],
  ["Asia/Tokyo", "Tokyo", "japan"],
  ["Asia/Tokyo", "Osaka"],
  ["Asia/Tokyo", "Kyoto"],
  ["Asia/Tokyo", "Yokohama"],
  ["Asia/Tokyo", "Nagoya"],
  ["Asia/Tokyo", "Sapporo"],
  ["Asia/Almaty", "Almaty", "kazakhstan"],
  ["Asia/Tashkent", "Tashkent", "uzbekistan"],
  ["Asia/Baku", "Baku", "azerbaijan"],
  ["Asia/Tbilisi", "Tbilisi", "georgia"],
  ["Asia/Yerevan", "Yerevan", "armenia"],

  // Oceania
  ["Australia/Perth", "Perth"],
  ["Australia/Adelaide", "Adelaide"],
  ["Australia/Darwin", "Darwin"],
  ["Australia/Brisbane", "Brisbane"],
  ["Australia/Sydney", "Sydney", "australia"],
  ["Australia/Sydney", "Canberra"],
  ["Australia/Melbourne", "Melbourne"],
  ["Australia/Hobart", "Hobart", "tasmania"],
  ["Pacific/Auckland", "Auckland", "new zealand", "nz"],
  ["Pacific/Auckland", "Wellington"],
  ["Pacific/Auckland", "Christchurch"],
  ["Pacific/Fiji", "Suva", "fiji"],
  ["Pacific/Guam", "Guam"],
];

/** A resolved city: which IANA zone it sits in, and how to label it in output. */
export interface CityEntry {
  zone: string;
  name: string;
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

function buildIndex(): Map<string, CityEntry> {
  const index = new Map<string, CityEntry>();
  for (const row of RAW) {
    const [zone, name, ...aliases] = row;
    const entry: CityEntry = { zone, name };
    for (const alias of [name, ...aliases]) {
      const key = normalizePlace(alias);
      if (key && !index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

const INDEX = buildIndex();

/** Look up a city, alias, or country shorthand. Undefined when unknown. */
export function lookupPlace(token: string): CityEntry | undefined {
  return INDEX.get(normalizePlace(token));
}

/** How many distinct names and aliases the table understands. */
export const PLACE_COUNT = INDEX.size;

/** Every entry in the table, one per name or alias. Used by the tests. */
export function allPlaces(): CityEntry[] {
  return [...INDEX.values()];
}
