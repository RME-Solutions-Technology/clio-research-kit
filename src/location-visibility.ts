/**
 * Location privacy that fails closed.
 *
 * Deciding: only two values publish a place, exactly "public" and exactly "generalized" (a string, in that
 * spelling). Everything else withholds: "restricted", "not_collected", any other text ("Restricted.",
 * "private"), an array, a boolean, an object wrapper, a number, null, an empty string, and a missing
 * value (unless the caller opts in with `missingVisibility: "public"`). A visibility key in any spelling
 * ("Location Visibility", "location-visibility", "visibility") counts as the flag, at ANY depth: in a group
 * ("site/location_visibility"), in a nested object, in a repeat entry. The strictest flag found anywhere in
 * the row wins over a "public" at the top, also under `missingVisibility: "public"`.
 *
 * Removing: a deny-list of encodings will always miss one, so a row whose place is not published is
 * reduced to an allow-list of non-spatial fields (see research-withholding.ts), and the free text that is
 * kept is screened with the patterns below, which replace a match with "[location withheld]". The screen
 * covers decimal pairs, hemisphere and DMS text, whole-degree pairs, numeric pair arrays, x/y and
 * easting/northing, serialised GeoJSON, WKT, map URLs, geo: URIs, plus codes, UTM/MGRS and what3words.
 * It is still pattern matching on free text: it cannot be guaranteed to catch every way of writing a place,
 * which is why callers should generalise locality text before export.
 *
 * The same rules serve the Darwin Core Archive export, the withholding functions and the package builder,
 * so the paths cannot disagree.
 */

export const PUBLISHING_LOCATION_STATES = ["public", "generalized"] as const;

/** What a caller may say about a record that does not state its location visibility. Default: it is withheld. */
export type MissingVisibilityPolicy = "public";

export type LocationVisibilityOptions = Readonly<{
  /**
   * Treat a record or row with no location visibility ANYWHERE as "public". Off by default: a missing value
   * withholds coordinates, so forgetting to set it cannot publish a place. Any value other than the exact string
   * "public" is refused (a typo must not silently mean "withhold everything" while the caller thinks they opted in).
   */
  missingVisibility?: MissingVisibilityPolicy;
}>;

export type LocationState = "public" | "generalized" | "restricted" | "not_collected" | "unrecognised" | "missing";

/** Throws on a `missingVisibility` that is defined but not exactly "public". */
export function assertLocationOptions(options: LocationVisibilityOptions | undefined): void {
  const value: unknown = options?.missingVisibility;
  if (value !== undefined && value !== "public") {
    throw new RangeError(`missingVisibility must be the exact string "public" or left out; got ${JSON.stringify(value)?.slice(0, 40)}.`);
  }
}

/** The state a single value stands for. Only an exact string counts; anything else is "unrecognised". */
export function classifyLocationVisibility(value: unknown): Exclude<LocationState, "missing"> {
  if (value === "public" || value === "generalized" || value === "restricted" || value === "not_collected") return value;
  return "unrecognised";
}

/** True only for the states that may place coordinates in an output row. */
export function publishesLocation(state: LocationState, options: LocationVisibilityOptions = {}): boolean {
  assertLocationOptions(options);
  if (state === "public" || state === "generalized") return true;
  return state === "missing" && options.missingVisibility === "public";
}

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/gu, "");

/** Keys that carry a location visibility, in any spelling. A flat group key ("site/location_visibility") is judged by its last segment. */
export function isLocationVisibilityKey(key: string): boolean {
  const last = key.split(/[/.]/u).pop() ?? key;
  const name = normaliseKey(last);
  return name === "locationvisibility" || name === "visibility" || name === "locationtreatment";
}

export type LocationStateResult = Readonly<{
  state: LocationState;
  /** The key that decided it, when there was one (a path such as "rows[0].location_visibility"). */
  key?: string;
  /** Coordinates, traces and shapes may appear in output. */
  publishes: boolean;
}>;

const ASSERTION_KEYS = new Set(["value", "source", "uncertainty", "visibility", "unit", "method"]);
const RANK: Record<LocationState, number> = { public: 0, generalized: 1, missing: 2, unrecognised: 3, not_collected: 4, restricted: 5 };

/** An assertion wrapper `{ value, visibility, ... }`: its `visibility` is about that one value, not about the place. */
function isAssertionWrapper(object: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(object, "value") && Object.keys(object).every((key) => ASSERTION_KEYS.has(key));
}

/**
 * The location state of a row: an event envelope, a staged row's data or source, a connector row. The visibility
 * flags are read at any depth (groups, nested objects, repeat entries); the most restrictive one wins. No flag at
 * all is "missing".
 */
export function locationStateOf(value: unknown, options: LocationVisibilityOptions = {}): LocationStateResult {
  assertLocationOptions(options);
  let worst: LocationState | undefined;
  let worstKey: string | undefined;
  const note = (state: LocationState, key: string): void => {
    if (worst === undefined || RANK[state] > RANK[worst]) { worst = state; worstKey = key; }
  };
  // An object reachable by many paths is read once: a graph that shares one child twelve ways per level would otherwise take 12^depth steps.
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 32) { note("unrecognised", path); return; } // too deep to read: fail closed
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) { node.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1)); return; }
    const object = node as Record<string, unknown>;
    const wrapper = isAssertionWrapper(object);
    for (const key of Object.keys(object)) {
      const child = object[key];
      const childPath = path === "" ? key : `${path}.${key}`;
      if (child === undefined) continue;
      if (isLocationVisibilityKey(key) && !(wrapper && normaliseKey(key) === "visibility")) note(classifyLocationVisibility(child), childPath);
      walk(child, childPath, depth + 1);
    }
  };
  walk(value, "", 0);
  const state: LocationState = worst ?? "missing";
  return { state, ...(worstKey === undefined ? {} : { key: worstKey }), publishes: publishesLocation(state, options) };
}

// ---------------------------------------------------------------------------
// Finding location values

/** Keys that hold a place, a trace or a precision. Compared lower-case without punctuation. */
const LOCATION_KEYS = new Set([
  "latitude", "longitude", "lat", "lon", "lng", "long", "decimallatitude", "decimallongitude", "verbatimlatitude", "verbatimlongitude",
  "verbatimcoordinates", "coordinates", "geopoint", "position", "altitude", "elevation", "x", "y", "easting", "northing", "eastings", "northings",
  "coordinateuncertaintym", "coordinateuncertaintyinmeters", "coordinateuncertainty", "coordinateprecision", "uncertainty",
  "accuracy", "accuracym", "accuracymetres", "accuracymeters", "geodeticdatum", "geometry", "geojson", "footprintwkt", "wkt", "geohash", "pluscode", "utm", "mgrs",
]);

export function isLocationKey(key: string): boolean {
  const last = key.split(/[/.]/u).pop() ?? key;
  const name = normaliseKey(last);
  return LOCATION_KEYS.has(name) || name.startsWith("accuracy") || name.includes("latitude") || name.includes("longitude") || /^(?:lat|lon|lng)(?:lat|lon|lng|long)$/u.test(name) || name.startsWith("utm") || name.startsWith("mgrs");
}

const GEOJSON_TYPES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection", "Feature", "FeatureCollection"]);

/** True for a GeoJSON geometry or feature object. */
export function isGeoJsonObject(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  return typeof type === "string" && GEOJSON_TYPES.has(type);
}

export const LOCATION_WITHHELD_TEXT = "[location withheld]";

const WKT = /^\s*(?:SRID=\d+;)?(?:MULTI)?(?:POINT|LINESTRING|POLYGON)|^\s*GEOMETRYCOLLECTION/iu;
const LAT_LON_TEXT = /^\s*[+-]?\d{1,3}[.,]\d+\s+[+-]?\d{1,3}[.,]\d+(?:\s+[+-]?\d+(?:[.,]\d+)?){0,2}\s*$/u;
const TRACE_TEXT = /^\s*[+-]?\d{1,3}[.,]\d+\s+[+-]?\d{1,3}[.,]\d+(?:\s+[+-]?\d+(?:[.,]\d+)?){0,2}\s*;/u;

/**
 * Text is screened in a normalised form: NFKC (full-width digits become ASCII, ligatures and compatibility forms are
 * unfolded), zero-width and soft-hyphen characters are removed so a pair cannot be split by one, and the Unicode minus and
 * dash forms become "-". If nothing matches, the original text is returned unchanged; if something matches, the redacted
 * text is built from the normalised form.
 */
function normaliseForScreen(text: string): string {
  // Whitespace runs become one space. Several patterns let a space match on either side of a separator, which is quadratic on a long run of spaces.
  return text.normalize("NFKC").replace(/[​-‍⁠﻿­᠎]/gu, "").replace(/[−‐-―﹣－]/gu, "-").replace(/\s+/gu, " ");
}

/**
 * Patterns for a place written inside free text, applied in this order. Each match is replaced. Whole pairs come before the
 * labelled and single-number patterns so a pair is removed as one run and no half is left behind. The input is capped (MAX_SCREEN_CHARS) and its
 * whitespace runs are collapsed to one space before matching, because some patterns let a space match on either side of a separator and would
 * otherwise be quadratic on a long run of spaces; the timing tests in location-screen.test.ts hold that.
 */
const TEXT_PATTERNS: readonly RegExp[] = [
  // serialised GeoJSON / WKT fragments
  /\{[^{}]{0,2000}"type"\s*:\s*"(?:Point|MultiPoint|LineString|MultiLineString|Polygon|MultiPolygon|GeometryCollection|Feature|FeatureCollection)"[^]{0,50000}/gu,
  // map and location URLs, geo: URIs
  /\bhttps?:\/\/(?:[\w-]+\.)*(?:google\.[a-z.]{2,6}\/maps|maps\.google\.[a-z.]{2,6}|goo\.gl\/maps|maps\.app\.goo\.gl|openstreetmap\.org|osm\.org|bing\.com\/maps|waze\.com|what3words\.com|w3w\.co|geohack\.toolforge\.org|mapcarta\.com|here\.com|maps\.apple\.com|apple\.co|mapquest\.com|opentopomap\.org|caltopo\.com|gaiagps\.com|alltrails\.com|inaturalist\.org\/observations\/map|ebird\.org\/map)[^\s"'<>)]{0,500}/giu,
  /\b(?:https?:\/\/)?(?:www\.)?(?:google\.[a-z.]{2,6}\/maps)[^\s"'<>)]{0,500}/giu,
  /[?&](?:q|ll|query|center|daddr|saddr|mlat|mlon|lat|lon|lng|coords|location)=-?\d[^\s"'<>&)]{0,100}/giu,
  /@-?\d{1,3}\.\d+,-?\d{1,3}\.\d+(?:,\d+(?:\.\d+)?[a-z]?)?/gu,
  /\bgeo:[-+]?\d+(?:\.\d+)?,[-+]?\d+(?:\.\d+)?[^\s]{0,100}/giu,
  // short codes: plus codes, what3words, geohash (only when labelled: an unlabelled word-like token is too often an identifier)
  /\b[23456789CFGHJMPQRVWX]{2,8}\+[23456789CFGHJMPQRVWX]{2,3}\b/giu,
  /\/{3}[a-z]{2,30}\.[a-z]{2,30}\.[a-z]{2,30}/giu,
  /\b(?:what3words|w3w)\b[^\n.]{0,30}?\b[a-z]{2,30}\.[a-z]{2,30}\.[a-z]{2,30}\b/giu,
  /\bgeo[\s-]?hash\b\s*[:=]?\s*[0-9b-hjkmnp-z]{5,12}\b/giu,
  // grid references: UTM, MGRS (either case), OS grid
  /\b\d{1,2}\s?[C-HJ-NP-X]\s+\d{5,7}(?:\.\d+)?\s*(?:m\s?)?E?\s*[,/ ]?\s*\d{6,8}(?:\.\d+)?\s*(?:m\s?)?N?\b/giu,
  /\b\d{1,2}\s?[C-HJ-NP-X]\s?[A-HJ-NP-Z]{2}\s?(?:\d{6}\s?\d{6}|\d{5}\s?\d{5}|\d{4}\s?\d{4}|\d{3}\s?\d{3}|\d{2}\s?\d{2})\b/giu,
  /\b[HJNOST][A-HJ-Z]\s?(?:\d{5}\s?\d{5}|\d{4}\s?\d{4}|\d{3}\s?\d{3}|\d{2}\s?\d{2})\b/gu,
  /\b[hjnost][a-hj-z](?:\d{4}|\d{6}|\d{8}|\d{10})\b/gu,
  // projected grids named by system, and degrees-minutes-seconds written with spaces and a hemisphere letter
  /\b(?:NZMG|NZTM|MGA|OSGB|EPSG:?\d+)\s*[:=]?\s*\d{6,8}[ ,;/]+\d{6,8}\b/giu,
  /\b\d{1,3}\s\d{1,2}\s\d{1,2}(?:\.\d+)?\s*[NSEW]\b/gu,
  /\b[NSEW]\s?\d{1,3}[ °]\s?\d{1,2}\.\d+(?!\d)/giu,
  /\b\d{1,3}[ °]\s?\d{1,2}\.\d+\s?[NSEW]\b/gu,
  // degrees-minutes-seconds and hemisphere text
  new RegExp(String.raw`\d{1,3}\s*[°º]\s*\d{1,2}(?:[.,]\d+)?\s*['′’]\s*(?:\d{1,2}(?:[.,]\d+)?\s*(?:"|″|''|”)\s*)?[NSEWnsew]?`, "gu"),
  /\b\d{1,3}\s*d(?:eg)?\s*\d{1,2}\s*m(?:in)?\s*(?:\d{1,2}(?:\.\d+)?\s*s(?:ec)?)?\s*[NSEW]\b/giu,
  /(?<![\d.,])[-+]?\d{1,3}(?:[.,]\d+)?\s*°?\s*[NSEWnsew]\b[\s,;/]*(?:and\s+)?[-+]?\d{1,3}(?:[.,]\d+)?\s*°?\s*[NSEWnsew]\b/gu,
  /(?<![\d.,])\d{1,3}[.,]\d{2,}\s*°?\s*[NSEW]\b/gu,
  // pairs: decimal comma, decimal point, one decimal and one whole number, separated by space, comma, semicolon or slash
  /(?<![\d.,])[-+]?\d{1,3},\d{2,}\s*[;/ ]\s*[-+]?\d{1,3},\d{2,}(?!\d)/gu,
  // (a pair is a place when either half has four or more decimals, a sign, or three integer digits; "rated 4.5, 3.8" is not)
  /(?<![\d.,])[-+]?\d{1,3}[.,]\d{4,}(?:\s*°)?\s*[,;/ ]\s*[-+]?\d{1,3}[.,]\d+(?:\s*°)?(?!\d)/gu,
  /(?<![\d.,])[-+]?\d{1,3}[.,]\d+(?:\s*°)?\s*[,;/ ]\s*[-+]?\d{1,3}[.,]\d{4,}(?:\s*°)?(?!\d)/gu,
  /(?<![\d.,])[-+]\d{1,3}[.,]\d+(?:\s*°)?\s*[,;/ ]\s*[-+]?\d{1,3}[.,]\d+(?:\s*°)?(?!\d)/gu,
  /(?<![\d.,])\d{1,3}[.,]\d+(?:\s*°)?\s*[,;/ ]\s*[-+]\d{1,3}[.,]\d+(?:\s*°)?(?!\d)/gu,
  /(?<![\d.,])(?:1[0-7]\d|180)[.,]\d+(?:\s*°)?\s*[,;/ ]\s*[-+]?\d{1,3}[.,]\d+(?:\s*°)?(?!\d)/gu,
  /(?<![\d.,])[-+]?\d{1,3}[.,]\d+(?:\s*°)?\s*[,;/ ]\s*(?:1[0-7]\d|180)[.,]\d+(?:\s*°)?(?!\d)/gu,
  /(?<![\d.,])[-+]\d{1,3}[.,]\d+(?:\s*°)?\s*[,;/ ]\s*[-+]?\d{1,3}(?!\d|\.\d|,\d)/gu,
  /(?<![\d.,])\d{1,3}[.,]\d+(?:\s*°)?\s*[,;/ ]\s*(?:1[0-7]\d|180)(?!\d|\.\d|,\d)/gu,
  /(?<![\d.,])[-+]\d{1,3}\s*[,;/ ]\s*[-+]?\d{1,3}[.,]\d+(?!\d)/gu,
  /(?<![\d.,])\d{1,3}\s*[,;/ ]\s*[-+]\d{1,3}[.,]\d+(?!\d)/gu,
  /(?<![\d.,])\d{1,3}\s*[,;/ ]\s*\d{1,3}[.,]\d{4,}(?!\d)/gu,
  // numeric pair/triple arrays written as text
  /\[\s*[-+]?\d{1,3}(?:[.,]\d+)?\s*,\s*[-+]?\d{1,3}(?:[.,]\d+)?(?:\s*,\s*[-+]?\d+(?:[.,]\d+)?)?\s*\]/gu,
  // whole-degree pairs: a signed number then another, or two numbers joined by a comma/semicolon
  /(?<![\d.,])[-+]\d{1,2}\s+[-+]?\d{1,3}(?!\d|\.\d|,\d)/gu,
  /(?<![\d.,])[-+]\d{1,2}\s*[,;]\s*[-+]?\d{1,3}(?!\d|\.\d|,\d)/gu,
  /(?<![\d.,])\d{1,2}\s*[,;]\s*(?:[-+]\d{1,3}|1[0-7]\d|180)(?!\d|\.\d|,\d)/gu,
  /(?<![\d.,])\d{1,3}\s*°\s*[,;]?\s*\d{1,3}\s*°/gu,
  // a decimal number with a degree sign on its own
  /(?<![\d.,])[-+]?\d{1,3}[.,]\d{2,}\s*[°º]/gu,
  // labelled values and x/y: "latitude -33.8", "lat is -33.8", "easting 334000", "x=151.2"
  /\b(?:lat(?:itude)?|lon(?:g|gitude)?|lng|easting|northing)\b(?:\s*(?:is|of|at|was|=|:|near)\s*|\s*[:=]?\s*)[-+]?\d+(?:[.,]\d+)?/giu,
  /\b[xy]\s*[:=]\s*[-+]?\d+(?:[.,]\d+)?/giu,
  // a single high-precision coordinate on its own: 4 or more decimals in a plausible latitude/longitude range
  /(?<![\d.,])[-+](?:1[0-7]\d|[1-9]\d?)(?:\.\d{4,}|,\d{4,})(?!\d)/gu,
  // (unsigned: not when a unit follows, so "weight 123.4567 g" survives)
  /(?<![\d.,])(?:1[0-7]\d|[1-9]\d)(?:\.\d{5,}|,\d{5,})(?!\d|\s?(?:mm|cm|km|kg|mg|µg|ml|ha|hz|min|m|g|l|s|h|x|%)\b)/giu,
  /(?<![\d.,])1[0-7]\d(?:\.\d{4}|,\d{4})(?!\d|\s?(?:mm|cm|km|kg|mg|µg|ml|ha|hz|min|m|g|l|s|h|x|%)\b)/giu,
  /(?<![\d.,])[-+]?180(?:\.0{4,}|,0{4,})(?!\d)/gu,
];

/** After the patterns: a number that sits next to a redaction with a separator between them is the other half of a pair. */
const WIDEN_PATTERNS: readonly RegExp[] = [
  /\[location withheld\]\s*[,;/]\s*[-+]?\d{1,3}[.,]\d+(?!\d)/gu,
  /(?<![\d.,])[-+]?\d{1,3}[.,]\d+\s*[,;/]\s*\[location withheld\]/gu,
  /\[location withheld\]\s*[,;/]\s*[-+]\d{1,3}(?!\d)/gu,
  /(?<![\d.,])[-+]\d{1,3}\s*[,;/]\s*\[location withheld\]/gu,
  /\[location withheld\]\s+\d{5,8}(?!\d)/gu,
  /(?<![\d.,])\d{5,8}\s+\[location withheld\]/gu,
];

const MAX_SCREEN_CHARS = 65_536;

const WKT_HEAD = /\b(?:MULTI)?(?:POINT|LINESTRING|POLYGON)\s*(?:Z|M|ZM)?\s*\(\s*(?=[-+\d.(])/giu;
const WKT_BODY_LIMIT = 5000;

/**
 * Replaces WKT geometries ("POINT(151.2 -33.8)", "POLYGON((...))") with the marker. The body ends at the first closing
 * parenthesis (and any run of them). The next ")" is looked for once and reused, so text made of unfinished heads costs one
 * pass, not one scan per head.
 */
function redactWkt(text: string): string {
  WKT_HEAD.lastIndex = 0;
  let out = "";
  let cursor = 0;
  let close = -2;
  for (let match = WKT_HEAD.exec(text); match !== null; match = WKT_HEAD.exec(text)) {
    const bodyStart = match.index + match[0].length;
    if (close < bodyStart) close = text.indexOf(")", bodyStart);
    if (close === -1) break; // no ")" anywhere after this head, so none after any later head either
    if (close - bodyStart > WKT_BODY_LIMIT) continue;
    let end = close + 1;
    while (text[end] === ")") end += 1;
    out += text.slice(cursor, match.index) + LOCATION_WITHHELD_TEXT;
    cursor = end;
    WKT_HEAD.lastIndex = end;
  }
  return cursor === 0 ? text : out + text.slice(cursor);
}

/** True when the text, as a whole, is a place: WKT, a "lat lon" pair or trace, or serialised GeoJSON. */
function wholeStringIsLocation(raw: string): boolean {
  const text = normaliseForScreen(raw);
  if (WKT.test(text) || LAT_LON_TEXT.test(text) || TRACE_TEXT.test(text)) return true;
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    if (text.length <= 100_000) {
      try { return isLocationValue(JSON.parse(text) as unknown); } catch { /* not JSON: the pattern screen below still runs */ }
    }
    return /"(?:coordinates|geometry)"\s*:/u.test(text);
  }
  return false;
}

/** True when free text contains something that looks like a place. */
export function containsLocationText(text: string): boolean {
  if (text.length > MAX_SCREEN_CHARS) return true; // too long to screen: treated as containing one
  const normalised = normaliseForScreen(text);
  if (redactWkt(normalised) !== normalised) return true;
  return TEXT_PATTERNS.some((pattern) => { pattern.lastIndex = 0; return pattern.test(normalised); });
}

/**
 * Replaces every place found in free text with "[location withheld]". Text that is too long to screen is replaced whole.
 * The text is screened in normalised form (see normaliseForScreen); text with no match is returned exactly as it came.
 * A number left next to a redaction is removed with it, so a pair never survives as one redacted half and one readable half.
 * Redacting twice changes nothing more (the marker contains no digits).
 */
export function redactLocationText(text: string): string {
  if (text.length > MAX_SCREEN_CHARS) return LOCATION_WITHHELD_TEXT;
  const normalised = normaliseForScreen(text);
  let out = redactWkt(normalised);
  let changed = out !== normalised;
  for (const pattern of TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    const next = out.replace(pattern, LOCATION_WITHHELD_TEXT);
    if (next !== out) { changed = true; out = next; }
  }
  if (!changed) return text;
  for (let round = 0; round < 3; round += 1) {
    const before = out;
    for (const pattern of WIDEN_PATTERNS) { pattern.lastIndex = 0; out = out.replace(pattern, LOCATION_WITHHELD_TEXT); }
    if (out === before) break;
  }
  return out;
}

const inRange = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 180;

/**
 * True for a value that is a place by itself: GeoJSON, WKT, a "lat lon" pair or trace, serialised GeoJSON, or an
 * array of two or three numbers that could be a position.
 */
export function isLocationValue(value: unknown): boolean {
  if (typeof value === "string") return wholeStringIsLocation(value);
  if (Array.isArray(value)) return (value.length === 2 || value.length === 3) && value.every((n) => typeof n === "number" && Number.isFinite(n)) && inRange(value[0]) && inRange(value[1]) && (Math.abs(value[0] as number) <= 90 || Math.abs(value[1] as number) <= 90);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (isGeoJsonObject(object)) return true;
    // an object that is an x/y or lat/lng pair
    const keys = Object.keys(object).map((key) => key.toLowerCase());
    return keys.length >= 2 && keys.length <= 4 && ((keys.includes("x") && keys.includes("y")) || (keys.includes("easting") && keys.includes("northing")) || ((keys.includes("lat") || keys.includes("latitude")) && (keys.includes("lon") || keys.includes("lng") || keys.includes("long") || keys.includes("longitude"))));
  }
  return false;
}

/** Own-property write that cannot trigger the `__proto__` setter. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * What a visibility-named key is allowed to say in an export: the state it was read as, never the raw cell. An exact
 * "public", "generalized", "restricted" or "not_collected" stays as it is; anything else (a cell like
 * "Restricted (-33.81234, 151.29876)", an object, an array, a blank) is written as "restricted", because that is how it was read.
 */
export function visibilityStateText(raw: unknown): "public" | "generalized" | "restricted" | "not_collected" {
  const state = classifyLocationVisibility(raw);
  return state === "unrecognised" ? "restricted" : state;
}

/**
 * Removes every place from a value, at any depth: location-named keys, values that are a place (GeoJSON, WKT, pairs,
 * numeric position arrays) and, inside the text that stays, any place written in it (replaced by "[location withheld]").
 * Arrays and repeats are walked; a removed array item leaves a null so later indexes keep their meaning. A visibility-named
 * key stays, so the output says why, but only as the state it was read as (see visibilityStateText).
 * Returns the cleaned copy; each removal or redaction is added to `withheld` as a path. The input is not changed.
 */
export function withoutLocationValues(value: unknown, path: string, withheld: string[], depth = 0): unknown {
  if (depth > 32) { withheld.push(path); return undefined; }
  if (typeof value === "string") {
    if (containsLocationText(value)) { withheld.push(path); return redactLocationText(value); }
    return value;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (isLocationValue(item)) { withheld.push(itemPath); out.push(null); return; }
      out.push(withoutLocationValues(item, itemPath, withheld, depth + 1));
    });
    return out;
  }
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const itemPath = `${path}.${key}`;
    if (item === undefined) continue; // not a value: JSON drops it, so nothing is held
    if (isLocationVisibilityKey(key)) {
      const kept = visibilityStateText(item);
      if (typeof item !== "string" || item !== kept) withheld.push(itemPath); // the raw cell was replaced by its read state
      put(out, key, kept);
      continue;
    }
    if (isLocationKey(key) || isLocationValue(item)) { withheld.push(itemPath); continue; }
    put(out, key, withoutLocationValues(item, itemPath, withheld, depth + 1));
  }
  return out;
}

/** Paths of every place still present in a value (what `withoutLocationValues` would remove or redact). */
export function locationValuePaths(value: unknown, path: string): string[] {
  const found: string[] = [];
  withoutLocationValues(value, path, found);
  return found;
}
