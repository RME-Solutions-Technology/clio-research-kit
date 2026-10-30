/**
 * Shared pieces for the field-data connectors (ODK Central, KoboToolbox).
 *
 * Both tools author forms in XLSForm and return the same kinds of values:
 * geopoints as "lat lon alt accuracy", traces and shapes as ";"-separated
 * point lists, select_multiple as a space-separated string, attachments as
 * file names. This module turns those values into plain JSON that the importer
 * (`previewImport`) accepts. It never reads a file, opens a socket or reads
 * the environment: callers pass data in and, for the fetch helpers, a
 * `fetch` function.
 *
 * Rules every connector follows:
 * - Fail closed on structure (prototype-polluting keys, oversize input).
 * - Keep values. A conversion that loses nothing (a select_multiple string
 *   to an array, a geopoint string to GeoJSON) is applied only when the form
 *   field type says so. Anything doubtful stays as the source wrote it and
 *   produces a finding.
 * - Attachments are references only. No bytes, no downloads.
 */

import { looksLikeFormula } from "../spreadsheet.ts";

export type ConnectorSource = "odk" | "kobo";
export type ConnectorSeverity = "error" | "warning" | "info";

export interface ConnectorFinding {
  readonly severity: ConnectorSeverity;
  readonly code: string;
  readonly message: string;
  readonly sourceId?: string;
  readonly field?: string;
}

/** A pointer to an attachment. The connector never fetches or embeds the file. */
export interface MediaReference {
  readonly sourceId: string;
  /** Flattened key of the form field that holds the file name. */
  readonly field: string;
  /** Plain file name, validated: no path separators, no "..", no control characters. */
  readonly filename: string;
  readonly mediaType: string;
  readonly source: ConnectorSource;
  /** ODK only: the Central API path that serves the file. Relative to the server origin. */
  readonly apiPath?: string;
  /** Kobo only: the https download URL the server reported. Never requested by this library. */
  readonly remoteUrl?: string;
}

export type ConnectorRow = Record<string, unknown> & { sourceId: string };

export interface ConnectorResult {
  readonly rows: readonly ConnectorRow[];
  readonly media: readonly MediaReference[];
  readonly findings: readonly ConnectorFinding[];
}

export class ConnectorError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

export function fail(code: string, message: string): never {
  throw new ConnectorError(code, message);
}

export const CONNECTOR_LIMITS = Object.freeze({
  /** Rows accepted from one fetch or one file. The importer takes 1,000 per call: see chunkRowsForImport. */
  rows: 10_000,
  bytes: 32 * 1024 * 1024,
  /** Wide forms are real; the importer's own 64-column cap is reported at import time. */
  columns: 512,
  cellBytes: 64 * 1024,
  depth: 16,
  findings: 5_000,
  timeoutMs: 30_000,
  pageSize: 250,
});

export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * A new row or repeat entry. A plain object, safe because every key that reaches it
 * from a source (JSON key, CSV header, repeat KEY segment, form field path) first
 * passes assertSafeKey, which refuses "__proto__", "prototype" and "constructor".
 */
export function newRecord(): Record<string, unknown> {
  return {};
}

export function assertSafeKey(key: string, where: string): void {
  if (DANGEROUS_KEYS.has(key)) fail("key.unsafe", `Key ${JSON.stringify(key)} is not permitted in ${where}.`);
  if (key.length === 0) fail("key.blank", `A blank key was found in ${where}.`);
  if (key.length > 512 || /[\u0000-\u001f\u007f]/u.test(key)) fail("key.invalid", `A key in ${where} is too long or has control characters.`);
}

/** Depth and prototype-key check for parsed JSON from a server or a file. */
export function assertJsonShape(value: unknown, where: string, depth = 0): void {
  if (depth > CONNECTOR_LIMITS.depth) fail("json.depth-limit", `${where} nests deeper than ${CONNECTOR_LIMITS.depth} levels.`);
  if (Array.isArray(value)) {
    for (const child of value) assertJsonShape(child, where, depth + 1);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) fail("key.unsafe", `${where} has the key ${JSON.stringify(key)}, which is not permitted.`);
    assertJsonShape((value as Record<string, unknown>)[key], where, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Findings

export class FindingSink {
  readonly findings: ConnectorFinding[] = [];
  private readonly seenGlobal = new Set<string>();
  private truncated = false;

  add(severity: ConnectorSeverity, code: string, message: string, extra: Readonly<{ sourceId?: string; field?: string }> = {}): void {
    // Findings with no row are about the whole input: say each one once.
    if (extra.sourceId === undefined) {
      const key = `${code}\u0000${extra.field ?? ""}`;
      if (this.seenGlobal.has(key)) return;
      this.seenGlobal.add(key);
    }
    if (this.findings.length >= CONNECTOR_LIMITS.findings) {
      if (!this.truncated) {
        this.truncated = true;
        this.findings.push({ severity: "warning", code: "findings.truncated", message: `More than ${CONNECTOR_LIMITS.findings} findings; the rest are not listed.` });
      }
      return;
    }
    this.findings.push({ severity, code, message, ...(extra.sourceId === undefined ? {} : { sourceId: extra.sourceId }), ...(extra.field === undefined ? {} : { field: extra.field }) });
  }
}

// ---------------------------------------------------------------------------
// Form field model (shared by XForms and XLSForm readers)

/**
 * One field of a form, in the shape ODK Central's `/forms/{id}/fields`
 * endpoint returns. `path` starts with "/" and omits the root element, for
 * example "/children/child/name".
 */
export interface FormField {
  readonly path: string;
  readonly name: string;
  /** ODK/XForms type names: string, int, decimal, date, dateTime, time, geopoint, geotrace, geoshape, binary, structure, repeat. */
  readonly type: string;
  readonly binary?: boolean;
  readonly selectMultiple?: boolean;
  /** The field holds the device or the person (device id, user name, phone number, e-mail address) rather than an observation. */
  readonly identity?: boolean;
}

/** XLSForm / XForms metadata question names that identify a device or a person. */
export const IDENTITY_METADATA_NAMES: ReadonlySet<string> = new Set(["deviceid", "subscriberid", "simserial", "phonenumber", "username", "email"]);

/**
 * True for the metadata questions that identify a device or a person (deviceid, username, phonenumber, email...).
 * They are dropped by default and kept only when the caller sets includeSubmitter. Decided by the field's
 * own flag when the form definition is known, and by the question name otherwise.
 */
export function isIdentityMetadata(field: FormField | undefined, key: string): boolean {
  if (field?.identity === true) return true;
  const last = key.split(/[/-]/u).pop() ?? key;
  return IDENTITY_METADATA_NAMES.has(last.toLowerCase());
}

export type FieldIndex = ReadonlyMap<string, FormField>;

export function indexFields(fields: readonly FormField[] | undefined): FieldIndex | undefined {
  if (fields === undefined) return undefined;
  const map = new Map<string, FormField>();
  for (const field of fields) {
    if (typeof field?.path !== "string" || !field.path.startsWith("/") || typeof field.type !== "string") fail("fields.invalid", "A form field needs a path that starts with '/' and a type.");
    for (const segment of field.path.slice(1).split("/")) assertSafeKey(segment, "a form field path");
    map.set(field.path, field);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Delimited text (CSV)

export interface DelimitedTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: string;
}

export interface DelimitedOptions {
  /** Default: detect "," ";" or tab from the header record. */
  readonly delimiter?: "," | ";" | "\t";
  readonly maxRows?: number;
  readonly maxBytes?: number;
}

function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\"") inQuotes = !inQuotes;
    else if (!inQuotes && (char === "\n" || char === "\r")) break;
    else if (!inQuotes && char in counts) counts[char]! += 1;
  }
  if (counts[";"]! > counts[","]! && counts[";"]! >= counts["\t"]!) return ";";
  if (counts["\t"]! > counts[","]! && counts["\t"]! > counts[";"]!) return "\t";
  return ",";
}

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).byteLength;

/**
 * RFC 4180 reader with a configurable delimiter. It handles a BOM, CRLF,
 * quoted delimiters and newlines, and doubled quotes. It stops at the first
 * structural problem (unclosed quote, text after a closing quote, a row wider
 * than the header, a NUL byte, duplicate or blank header) rather than guess.
 */
export function parseDelimited(input: string, options: DelimitedOptions = {}): DelimitedTable {
  const maxBytes = options.maxBytes ?? CONNECTOR_LIMITS.bytes;
  const maxRows = options.maxRows ?? CONNECTOR_LIMITS.rows;
  if (typeof input !== "string") fail("csv.not-text", "CSV input must be a string.");
  if (input.length > maxBytes || byteLength(input) > maxBytes) fail("limit.bytes", `CSV input is larger than ${maxBytes} bytes.`);
  const text = input.startsWith("﻿") ? input.slice(1) : input;
  if (text.length === 0) fail("csv.empty", "The CSV input is empty.");
  if (text.includes("\u0000")) fail("csv.nul", "The CSV input contains a NUL byte.");
  const delimiter = options.delimiter ?? detectDelimiter(text);

  const records: string[][] = [];
  let record: string[] = [];
  let value = "";
  let inQuotes = false;
  let afterQuote = false;
  let sawCharacter = false;
  const pushCell = (): void => {
    if (value.length > CONNECTOR_LIMITS.cellBytes && byteLength(value) > CONNECTOR_LIMITS.cellBytes) fail("limit.cell", `A CSV cell is larger than ${CONNECTOR_LIMITS.cellBytes} bytes.`);
    record.push(value);
    if (record.length > CONNECTOR_LIMITS.columns) fail("limit.columns", `A CSV record has more than ${CONNECTOR_LIMITS.columns} columns.`);
    value = "";
    afterQuote = false;
  };
  const pushRecord = (): void => {
    pushCell();
    records.push(record);
    if (records.length > maxRows + 1) fail("limit.rows", `The CSV has more than ${maxRows} data rows.`);
    record = [];
    sawCharacter = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === "\"") {
        if (text[index + 1] === "\"") { value += "\""; index += 1; } else { inQuotes = false; afterQuote = true; }
      } else value += char;
      sawCharacter = true;
      continue;
    }
    if (afterQuote) {
      if (char === delimiter) { pushCell(); sawCharacter = true; continue; }
      if (char === "\r" || char === "\n") { pushRecord(); if (char === "\r" && text[index + 1] === "\n") index += 1; continue; }
      fail("csv.trailing-characters", `Characters follow a closing quote at character ${index + 1}.`);
    }
    if (char === "\"") {
      if (value !== "") fail("csv.quote-placement", `A quote appears inside an unquoted cell at character ${index + 1}.`);
      inQuotes = true;
      sawCharacter = true;
    } else if (char === delimiter) {
      pushCell();
      sawCharacter = true;
    } else if (char === "\r" || char === "\n") {
      // A blank line between records is skipped; it is never a record of one empty cell.
      if (record.length === 0 && value === "" && !sawCharacter) { if (char === "\r" && text[index + 1] === "\n") index += 1; continue; }
      pushRecord();
      if (char === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      value += char;
      sawCharacter = true;
    }
  }
  if (inQuotes) fail("csv.unclosed-quote", "The CSV ended inside a quoted cell.");
  if (record.length > 0 || value !== "" || sawCharacter) pushRecord();
  if (records.length === 0) fail("csv.empty", "The CSV has no header row.");

  const headers = records[0]!;
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    if (header.trim() === "") fail("csv.blank-header", `CSV header ${index + 1} is blank.`);
    assertSafeKey(header, "a CSV header");
    if (seen.has(header)) fail("csv.duplicate-header", `CSV header ${JSON.stringify(header)} appears twice.`);
    seen.add(header);
  });
  const rows = records.slice(1).map((cells, rowIndex) => {
    if (cells.length > headers.length) fail("csv.column-count", `CSV row ${rowIndex + 2} has more cells than the header.`);
    return cells.length === headers.length ? cells : [...cells, ...Array.from({ length: headers.length - cells.length }, () => "")];
  });
  return { headers, rows, delimiter };
}

// ---------------------------------------------------------------------------
// Values

export { looksLikeFormula };

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", "3gp": "video/3gpp", mov: "video/quicktime", webm: "video/webm",
  mp3: "audio/mpeg", m4a: "audio/mp4", amr: "audio/amr", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac",
  pdf: "application/pdf", csv: "text/csv", txt: "text/plain", xml: "application/xml", kml: "application/vnd.google-earth.kml+xml", zip: "application/zip",
};

export function mediaTypeFor(filename: string, declared?: unknown): string {
  if (typeof declared === "string" && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(declared) && declared.length <= 127) return declared.toLowerCase();
  const extension = /\.([A-Za-z0-9]{1,5})$/u.exec(filename)?.[1]?.toLowerCase();
  return (extension === undefined ? undefined : MEDIA_TYPES[extension]) ?? "application/octet-stream";
}

/** A file name safe to store and to join onto a path: no separators, no "..", no control characters, bounded. */
export function isSafeFilename(name: string): boolean {
  if (name.length === 0 || name.length > 255 || byteLength(name) > 255) return false;
  if (/[\\/\u0000-\u001f\u007f]/u.test(name)) return false;
  if (name === "." || name === ".." || name.includes("..")) return false;
  if (/^[A-Za-z]:/u.test(name) || name.startsWith("~")) return false;
  if (/[<>:"|?*]/u.test(name)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Timestamps

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/iu;

export interface TimestampOptions {
  /** Offset to apply to a date-time that has none, "Z" or "+11:00". Reported as a warning every time it is used. */
  readonly defaultUtcOffset?: string;
  /** The source documents its values as UTC even though it writes no offset (Kobo's submission time). */
  readonly sourceIsUtc?: boolean;
}

export type TimestampResult = Readonly<{ value: string; code?: string; message?: string }>;

function normaliseOffset(raw: string): string {
  if (raw.toUpperCase() === "Z") return "Z";
  const digits = raw.replace(":", "");
  return `${digits.slice(0, 3)}:${digits.length > 3 ? digits.slice(3, 5) : "00"}`;
}

export function validOffset(offset: string): boolean {
  const match = /^(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(offset);
  return match !== null && (match[2] === undefined || (Number(match[2]) <= 23 && Number(match[3]) <= 59));
}

/**
 * Brings a date-time to `YYYY-MM-DDTHH:MM:SS[.mmm](Z|+HH:MM)` without moving
 * the instant or the local clock reading. Returns the input unchanged, with a
 * code, when it cannot be read as a date-time or has no offset to give it.
 */
export function normaliseDateTime(raw: string, options: TimestampOptions = {}): TimestampResult {
  const match = DATE_TIME.exec(raw.trim());
  if (!match) return { value: raw, code: "timestamp.unreadable", message: "Not an ISO date-time; kept as written." };
  const [, date, hour, minute, second = "00", fraction, rawOffset] = match;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return { value: raw, code: "timestamp.unreadable", message: "Not a real clock time; kept as written." };
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return { value: raw, code: "timestamp.unreadable", message: "Not a real calendar date; kept as written." };
  let truncated = false;
  let millis = "";
  if (fraction !== undefined) {
    millis = `.${fraction.slice(0, 3).padEnd(3, "0")}`;
    truncated = fraction.length > 3 && /[1-9]/u.test(fraction.slice(3));
  }
  let offset: string | undefined = rawOffset === undefined ? undefined : normaliseOffset(rawOffset);
  let code: string | undefined;
  let message: string | undefined;
  if (offset !== undefined && !validOffset(offset)) return { value: raw, code: "timestamp.unreadable", message: "The UTC offset is not valid; kept as written." };
  if (offset === undefined) {
    if (options.sourceIsUtc === true) {
      offset = "Z";
      code = "timestamp.offset-assumed";
      message = "The source writes no offset; it documents these values as UTC, so Z was added.";
    } else if (options.defaultUtcOffset !== undefined) {
      if (!validOffset(options.defaultUtcOffset)) fail("option.offset", "defaultUtcOffset must be Z or +HH:MM / -HH:MM.");
      offset = options.defaultUtcOffset;
      code = "timestamp.offset-assumed";
      message = `The source writes no UTC offset; ${offset} was applied from the defaultUtcOffset option.`;
    } else {
      return { value: raw, code: "timestamp.no-offset", message: "The date-time has no UTC offset and none was supplied (defaultUtcOffset); kept as written." };
    }
  }
  if (truncated) {
    code = code ?? "timestamp.fraction-truncated";
    message = message ?? "Fractional seconds beyond milliseconds were truncated.";
  }
  return { value: `${date}T${hour}:${minute}:${second}${millis}${offset}`, ...(code === undefined ? {} : { code, message: message! }) };
}

// ---------------------------------------------------------------------------
// Geometry

export type Position = readonly number[];
export type GeoJsonGeometry = Readonly<{ type: string; coordinates?: unknown; geometries?: unknown; [member: string]: unknown }>;

export const GEOJSON_TYPES: ReadonlySet<string> = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"]);

export function looksLikeGeoJson(value: unknown): value is GeoJsonGeometry {
  return isPlainObject(value) && typeof value.type === "string" && GEOJSON_TYPES.has(value.type) && (Array.isArray(value.coordinates) || Array.isArray(value.geometries));
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

function numbers(tokens: readonly string[]): number[] | undefined {
  const out: number[] = [];
  for (const token of tokens) {
    if (!NUMBER.test(token)) return undefined;
    const n = Number(token);
    if (!Number.isFinite(n)) return undefined;
    out.push(n);
  }
  return out;
}

export interface ParsedPoint { readonly lat: number; readonly lon: number; readonly altitude?: number; readonly accuracy?: number }

/** "lat lon [alt [accuracy]]" as ODK and Kobo write a geopoint. Returns undefined for anything else. */
export function parseOdkPoint(text: string): ParsedPoint | undefined {
  const tokens = text.trim().split(/\s+/u);
  if (tokens.length < 2 || tokens.length > 4) return undefined;
  const values = numbers(tokens);
  if (!values) return undefined;
  const [lat, lon, altitude, accuracy] = values as [number, number, number | undefined, number | undefined];
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
  return { lat, lon, ...(altitude === undefined ? {} : { altitude }), ...(accuracy === undefined ? {} : { accuracy }) };
}

/** A Point from four separate cells (latitude, longitude, altitude, accuracy). A blank altitude stays absent; it never shifts the accuracy into its place. */
export function pointFromParts(lat: string, lon: string, altitude: string, accuracy: string): GeoJsonGeometry | undefined {
  const parts = [lat, lon, altitude, accuracy].map((part) => part.trim());
  const numeric = (text: string): number | undefined => (NUMBER.test(text) && Number.isFinite(Number(text)) ? Number(text) : undefined);
  const latitude = numeric(parts[0]!);
  const longitude = numeric(parts[1]!);
  if (latitude === undefined || longitude === undefined || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
  const alt = parts[2] === "" ? undefined : numeric(parts[2]!);
  const acc = parts[3] === "" ? undefined : numeric(parts[3]!);
  if ((parts[2] !== "" && alt === undefined) || (parts[3] !== "" && acc === undefined)) return undefined;
  return pointToGeoJson({ lat: latitude, lon: longitude, ...(alt === undefined ? {} : { altitude: alt }), ...(acc === undefined ? {} : { accuracy: acc }) });
}

export function pointToGeoJson(point: ParsedPoint): GeoJsonGeometry {
  const coordinates = point.altitude === undefined ? [point.lon, point.lat] : [point.lon, point.lat, point.altitude];
  // ODK writes 0 when the accuracy is not known (a point placed by hand); that is not a measurement.
  return point.accuracy !== undefined && point.accuracy > 0 ? { type: "Point", coordinates, accuracyMetres: point.accuracy } : { type: "Point", coordinates };
}

/** "p1; p2; ..." as ODK writes a geotrace (open line) or geoshape (closed ring). */
export function parseOdkLine(text: string, kind: "geotrace" | "geoshape"): GeoJsonGeometry | undefined {
  const parts = text.split(";").map((part) => part.trim()).filter((part) => part !== "");
  const positions: number[][] = [];
  for (const part of parts) {
    const point = parseOdkPoint(part);
    if (!point) return undefined;
    positions.push(point.altitude === undefined ? [point.lon, point.lat] : [point.lon, point.lat, point.altitude]);
  }
  if (kind === "geotrace") return positions.length >= 2 ? { type: "LineString", coordinates: positions } : undefined;
  if (positions.length < 3) return undefined;
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  const closed = first[0] === last[0] && first[1] === last[1];
  const ring = closed ? positions : [...positions, first];
  return ring.length >= 4 ? { type: "Polygon", coordinates: [ring] } : undefined;
}

const WKT = /^(POINT|LINESTRING|POLYGON)\s*(Z|M|ZM)?\s*\((.*)\)$/isu;

/** Well-Known Text as ODK Central returns with `$wkt=true`: POINT, LINESTRING and POLYGON only. */
export function parseWkt(text: string): GeoJsonGeometry | undefined {
  const match = WKT.exec(text.trim());
  if (!match || text.length > 1_000_000) return undefined;
  const kind = match[1]!.toUpperCase();
  const parseCoordinates = (list: string): number[][] | undefined => {
    const out: number[][] = [];
    for (const part of list.split(",")) {
      const values = numbers(part.trim().split(/\s+/u));
      if (!values || values.length < 2 || values.length > 3) return undefined;
      const [lon, lat] = values as [number, number];
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return undefined;
      out.push(values);
    }
    return out;
  };
  const body = match[3]!.trim();
  if (kind === "POINT") {
    const coordinates = parseCoordinates(body);
    return coordinates?.length === 1 ? { type: "Point", coordinates: coordinates[0]! } : undefined;
  }
  if (kind === "LINESTRING") {
    const coordinates = parseCoordinates(body);
    return coordinates !== undefined && coordinates.length >= 2 ? { type: "LineString", coordinates } : undefined;
  }
  const rings = /^\(.*\)$/su.test(body) ? body.slice(1, -1).split(/\)\s*,\s*\(/u).map(parseCoordinates) : [undefined];
  if (rings.some((ring) => ring === undefined || ring.length < 4)) return undefined;
  return { type: "Polygon", coordinates: rings as number[][][] };
}

/** True when every position of a GeoJSON geometry is a finite lon/lat inside range. */
export function geoJsonInRange(geometry: unknown, depth = 0): boolean {
  if (depth > 6 || !looksLikeGeoJson(geometry)) return false;
  if (geometry.type === "GeometryCollection") return Array.isArray(geometry.geometries) && geometry.geometries.every((child) => geoJsonInRange(child, depth + 1));
  const check = (value: unknown, level: number): boolean => {
    if (level > 5 || !Array.isArray(value) || value.length === 0) return false;
    if (typeof value[0] === "number") {
      return value.length >= 2 && value.length <= 3 && value.every((n) => typeof n === "number" && Number.isFinite(n)) && Math.abs(value[0] as number) <= 180 && Math.abs(value[1] as number) <= 90;
    }
    return value.every((child) => check(child, level + 1));
  };
  return check(geometry.coordinates, 0);
}

// ---------------------------------------------------------------------------
// Value conversion

export interface RowContext {
  readonly sourceId: string;
  readonly source: ConnectorSource;
  readonly fields: FieldIndex | undefined;
  readonly sink: FindingSink;
  readonly media: MediaReference[];
  readonly timestamps: TimestampOptions;
  /** Builds the ODK API path for an attachment, or undefined when it cannot be known. */
  readonly attachmentPath?: (filename: string) => string | undefined;
  /** Kobo: download URLs the server reported, by file name. */
  readonly remoteUrls?: ReadonlyMap<string, { url?: string; mediaType?: string }>;
}

const SAFE_NUMBER = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

/**
 * Converts one leaf value using the form field type when it is known. Returns
 * undefined for an empty value (null, empty text), which the row omits.
 */
export function convertLeaf(context: RowContext, path: string, key: string, raw: unknown): unknown {
  const { sink, sourceId } = context;
  const note = (severity: ConnectorSeverity, code: string, message: string): void => sink.add(severity, code, message, { sourceId, field: key });
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const field = context.fields?.get(path);
  const type = field?.type;

  // Reported only for values that stay text: a converted geopoint or number is not a formula risk.
  const checkFormula = (): void => {
    if (typeof raw === "string" && looksLikeFormula(raw)) {
      note("warning", "cell.formula-prefix", "The value starts with =, +, - or @. It is kept as written; escape it before writing it to a spreadsheet or CSV that people will open.");
    }
  };

  if (type === "geopoint" || type === "geotrace" || type === "geoshape") {
    if (looksLikeGeoJson(raw)) {
      if (!geoJsonInRange(raw)) note("warning", "geometry.invalid", "The geometry has coordinates outside longitude/latitude range or the wrong shape; kept as written.");
      return raw;
    }
    if (typeof raw === "string") {
      const point = type === "geopoint" ? parseOdkPoint(raw) : undefined;
      const geometry = parseWkt(raw) ?? (type === "geopoint" ? (point ? pointToGeoJson(point) : undefined) : parseOdkLine(raw, type));
      if (geometry) {
        const expected = type === "geopoint" ? "Point" : type === "geotrace" ? "LineString" : "Polygon";
        if (geometry.type !== expected) note("warning", "geometry.type-mismatch", `The field is a ${type} but the value is a ${geometry.type}; kept as GeoJSON.`);
        return geometry;
      }
      note("warning", "geometry.unreadable", `The ${type} value could not be read; kept as written.`);
      checkFormula(); return raw;
    }
    note("warning", "geometry.unreadable", `The ${type} value is not text or GeoJSON; kept as written.`);
    checkFormula(); return raw;
  }

  if (field?.selectMultiple === true) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === "string") { checkFormula(); return raw.trim().split(/\s+/u); }
  }

  if (type === "binary") {
    if (typeof raw === "string") {
      const filename = raw.trim();
      if (!isSafeFilename(filename)) {
        note("warning", "media.unsafe-filename", "An attachment name has a path separator, '..' or a control character. No media reference was made; the name is kept as written.");
        return raw;
      }
      const remote = context.remoteUrls?.get(filename);
      const apiPath = context.attachmentPath?.(filename);
      context.media.push({
        sourceId,
        field: key,
        filename,
        mediaType: mediaTypeFor(filename, remote?.mediaType),
        source: context.source,
        ...(apiPath === undefined ? {} : { apiPath }),
        ...(remote?.url === undefined ? {} : { remoteUrl: remote.url }),
      });
      checkFormula(); return filename;
    }
    return raw;
  }

  if ((type === "int" || type === "integer" || type === "decimal") && typeof raw === "string") {
    const text = raw.trim();
    if (SAFE_NUMBER.test(text)) {
      const n = Number(text);
      if (Number.isFinite(n) && (Number.isSafeInteger(n) || !/^[+-]?\d+$/u.test(text))) return n;
    }
    note("warning", "number.unreadable", `A ${type} field holds text that is not a plain number; kept as written.`);
    checkFormula(); return raw;
  }

  if (type === "dateTime" && typeof raw === "string") {
    const result = normaliseDateTime(raw, context.timestamps);
    if (result.code !== undefined) note("warning", result.code, result.message!);
    return result.value;
  }

  if (type === "date" && typeof raw === "string") {
    const text = raw.trim();
    // Some servers write a date field as a date-time; keep the calendar date only when nothing else is in the value.
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) note("warning", "date.unreadable", "A date field does not hold YYYY-MM-DD; kept as written.");
    return text;
  }

  checkFormula();
  return raw;
}

/** Reserved top-level keys the connectors write; a form field with one of these names is renamed under "form/". */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "sourceId", "sourceSystem", "submittedAt", "updatedAt", "formVersion", "reviewState", "status", "edits", "validationStatus",
  "submitterId", "submitterName", "deviceId", "latitude", "longitude", "uncertainty", "geometry", "eventDate", "media",
]);

export function fieldKey(relativePath: string, sink: FindingSink, sourceId: string, top: boolean): string {
  const key = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  if (top && RESERVED_KEYS.has(key)) {
    sink.add("info", "key.reserved-renamed", `A form field named ${JSON.stringify(key)} clashes with a key the connector writes; it was renamed form/${key}.`, { sourceId, field: key });
    return `form/${key}`;
  }
  return key;
}

/** Collapses `field/choice` columns (0/1 or true/false) into the array a select_multiple field holds. */
export function selectedChoices(columns: ReadonlyMap<string, string>): string[] {
  const chosen: string[] = [];
  for (const [choice, value] of columns) {
    if (/^(?:1|true|yes)$/iu.test(value.trim())) chosen.push(choice);
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Primary location

export interface LocationOptions {
  /**
   * Top-level keys (as they appear in the output row, for example "site/home_gps") that the form author meant as private.
   * They are dropped from the row and never promoted to latitude/longitude. Keys inside repeats are not covered; withhold
   * those with withholdStagedRow and a restricted location visibility.
   */
  readonly restrictedFields?: readonly string[];
  /** Flattened key of the geopoint that supplies latitude/longitude. Default: the first top-level geopoint with a value. */
  readonly locationField?: string;
  /** Flattened key of a geotrace/geoshape (or geopoint) copied to `geometry`. */
  readonly geometryField?: string;
  /** Flattened key (or path) of the field that supplies `eventDate`. Not guessed: submission time is not observation time. */
  readonly eventDateField?: string;
}

/**
 * True for an https URL that is safe to hand to a caller as a download reference: no credentials, not localhost or a
 * .local / .internal name, and not a loopback, link-local, private, shared-address or documentation IP literal. This is
 * a screen, not a sandbox: a caller that fetches the URL must still resolve it and block private ranges itself, and
 * must never send an API token to it.
 */
export function isPublicHttpsUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || host.endsWith(".home.arpa")) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    if (v6 === "::" || v6 === "::1" || /^(?:fc|fd)/u.test(v6) || /^fe[89ab]/u.test(v6) || v6.startsWith("::ffff:") || v6.startsWith("64:ff9b:") || v6.startsWith("2001:db8")) return false;
    return true;
  }
  return host.includes(".");
}

export function applyPrimaryFields(
  row: Record<string, unknown>,
  fields: FieldIndex | undefined,
  options: LocationOptions,
  sink: FindingSink,
  sourceId: string,
): void {
  for (const key of options.restrictedFields ?? []) {
    if (Object.hasOwn(row, key)) {
      delete row[key];
      sink.add("info", "field.restricted-dropped", `The field ${JSON.stringify(key)} is listed in restrictedFields and was dropped from the row.`, { sourceId, field: key });
    }
  }
  const geoKeys: string[] = [];
  for (const key of Object.keys(row)) if (looksLikeGeoJson(row[key]) && (row[key] as GeoJsonGeometry).type === "Point") geoKeys.push(key);
  let chosen = options.locationField;
  if (chosen === undefined && fields !== undefined) {
    const firstTop = [...fields.values()].find((field) => field.type === "geopoint" && field.path.split("/").length === 2 && looksLikeGeoJson(row[field.path.slice(1)]));
    chosen = firstTop?.path.slice(1);
  }
  chosen = chosen ?? geoKeys[0];
  if (chosen !== undefined) {
    const value = row[chosen];
    if (looksLikeGeoJson(value) && value.type === "Point" && Array.isArray(value.coordinates) && typeof value.coordinates[0] === "number" && typeof value.coordinates[1] === "number") {
      if (geoJsonInRange(value)) {
        row.longitude = value.coordinates[0];
        row.latitude = value.coordinates[1];
        const accuracy = value.accuracyMetres;
        if (typeof accuracy === "number") row.uncertainty = accuracy;
      }
    } else if (options.locationField !== undefined) {
      sink.add("warning", "location.field-missing", `locationField ${JSON.stringify(options.locationField)} has no Point value in this row.`, { sourceId, field: options.locationField });
    }
  }
  if (options.geometryField !== undefined) {
    const value = row[options.geometryField];
    if (looksLikeGeoJson(value)) row.geometry = value;
    else sink.add("warning", "geometry.field-missing", `geometryField ${JSON.stringify(options.geometryField)} has no geometry in this row.`, { sourceId, field: options.geometryField });
  }
  if (options.eventDateField !== undefined) {
    const value = row[options.eventDateField];
    if (typeof value === "string" && value !== "") row.eventDate = value;
  }
}

// ---------------------------------------------------------------------------
// Network (callers inject fetch; tests mock it)

export type FetchLike = (input: URL, init: Readonly<{ method: "GET"; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }>) => Promise<{
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null };
  body?: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } } | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export function originOnlyHttpsUrl(server: string, label: string): URL {
  let url: URL;
  try { url = new URL(server); } catch { fail("fetch.server", `${label} must be an HTTPS URL.`); }
  if (url.protocol !== "https:") fail("fetch.server", `${label} must be an HTTPS URL.`);
  if (url.pathname !== "/" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") fail("fetch.server", `${label} must be an origin only: https://host with no path, user, query or fragment.`);
  return url;
}

export function boundedInteger(value: number | undefined, fallback: number, max: number, label: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > max) fail("limit.option", `${label} must be a whole number from 1 to ${max}.`);
  return n;
}

async function readBounded(response: Awaited<ReturnType<FetchLike>>, maxBytes: number, signal: AbortSignal, label: string): Promise<Uint8Array> {
  if (!response || typeof response.status !== "number") fail("fetch.response", `${label} did not return a response.`);
  if (response.status >= 300 && response.status < 400) fail("fetch.redirect", `${label} redirected. Redirects are refused; use the exact server URL.`);
  if (response.status === 401 || response.status === 403) fail("fetch.auth", `${label} refused the credentials (HTTP ${response.status}).`);
  if (!response.ok) fail("fetch.http", `${label} returned HTTP ${response.status}.`);
  if (signal.aborted) fail("fetch.timeout", `${label} timed out.`);
  const declared = Number(response.headers?.get("content-length") ?? 0);
  if (declared > maxBytes) fail("limit.bytes", `${label} is larger than ${maxBytes} bytes.`);
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) fail("limit.bytes", `${label} is larger than ${maxBytes} bytes.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value!.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* the failure is already known */ }
      fail("limit.bytes", `${label} is larger than ${maxBytes} bytes.`);
    }
    chunks.push(value!);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

export interface FetchJsonOptions {
  readonly fetchImpl: FetchLike;
  readonly headers: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly label: string;
}

/** GET a JSON document with a timeout, no redirects, a byte limit and a shape check. */
export async function fetchJson(url: URL, options: FetchJsonOptions, signal: AbortSignal): Promise<unknown> {
  const response = await options.fetchImpl(url, { method: "GET", redirect: "manual", signal, headers: options.headers });
  const bytes = await readBounded(response, options.maxBytes, signal, options.label);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; } catch { fail("fetch.json", `${options.label} did not return valid JSON.`); }
  assertJsonShape(parsed, options.label);
  return parsed;
}

/** A pagination link must stay on the same origin and path as the request it continues. */
export function confinedNextLink(nextLink: unknown, origin: URL, requestUrl: URL): URL {
  if (typeof nextLink !== "string" || nextLink.length === 0 || nextLink.length > 2048) fail("fetch.pagination", "The next-page link is missing or too long.");
  let next: URL;
  try { next = new URL(nextLink, requestUrl); } catch { fail("fetch.pagination", "The next-page link is not a URL."); }
  if (next.username !== "" || next.password !== "") fail("fetch.pagination", "The next-page link carries credentials; it was not followed.");
  if (next.protocol === "http:" && next.hostname === origin.hostname) fail("fetch.pagination", "The next-page link uses http:// although the server was given as https:// (a server behind a proxy often does this). It was not followed; fix the server's public URL setting.");
  if (next.origin !== origin.origin || next.pathname !== requestUrl.pathname) fail("fetch.pagination", "The next-page link left the exact server and path; it was not followed.");
  return next;
}

export function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>, label: string): Promise<T> {
  const controller = new AbortController();
  // Race a timer as well as aborting the signal: a fetch function that ignores the signal must not hang the caller.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { controller.abort(); reject(new ConnectorError("fetch.timeout", `${label} timed out.`)); }, timeoutMs);
    run(controller.signal).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => {
        clearTimeout(timer);
        reject((error as { name?: string } | undefined)?.name === "AbortError" ? new ConnectorError("fetch.timeout", `${label} timed out.`) : error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Hand-off to the importer

export interface ImportHandOff {
  readonly format: "json";
  readonly content: string;
  readonly presetId: string;
  readonly mapping?: Readonly<Record<string, string>>;
}

/** The importer's per-call limits (1,000 rows, 2 MiB). Kept here so chunking does not import the importer. */
const IMPORT_ROWS = 1000;
const IMPORT_BYTES = 2 * 1024 * 1024;

/** Splits connector rows into importer calls that each fit its row and byte limits. Order is kept. */
export function chunkRowsForImport(rows: readonly ConnectorRow[], presetId: string, mapping?: Readonly<Record<string, string>>): ImportHandOff[] {
  const chunks: ImportHandOff[] = [];
  let current: string[] = [];
  let bytes = 2;
  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push({ format: "json", content: `[${current.join(",")}]`, presetId, ...(mapping === undefined ? {} : { mapping }) });
    current = [];
    bytes = 2;
  };
  for (const row of rows) {
    const text = JSON.stringify(row);
    const size = byteLength(text) + 1;
    if (size + 2 > IMPORT_BYTES) fail("limit.row-bytes", `Row ${row.sourceId} is larger than the importer accepts (${IMPORT_BYTES} bytes).`);
    if (current.length >= IMPORT_ROWS || bytes + size > IMPORT_BYTES) flush();
    current.push(text);
    bytes += size;
  }
  flush();
  return chunks;
}

/** One importer call for a result that fits; use chunkRowsForImport for more. */
export function toImportInput(result: ConnectorResult, presetId: string, mapping?: Readonly<Record<string, string>>): ImportHandOff {
  const chunks = chunkRowsForImport(result.rows, presetId, mapping);
  if (chunks.length !== 1) fail("limit.import", chunks.length === 0 ? "There are no rows to import." : `The rows need ${chunks.length} importer calls; use chunkRowsForImport.`);
  return chunks[0]!;
}
