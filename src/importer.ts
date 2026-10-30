/**
 * Generic CSV / JSON / NDJSON importer: parsing, validation and field
 * crosswalk mapping.
 *
 * Deterministic and dependency-free. This module has no server, database,
 * filesystem or network dependency. A preview is an intake operation only: it
 * does not publish anything, assign rights, identify a specimen, or apply
 * scientific repairs. Values are never coerced; ambiguous input is reported as
 * findings and the original representation is kept.
 */

export type ImportFieldValue = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface ImportPresetField {
  readonly key: string;
  readonly label: string;
  readonly requiredForDraft: boolean;
  readonly requiredForRelease: boolean;
}

export interface ImportPreset {
  readonly id: string;
  /** Version of this portable preset configuration. */
  readonly version: string;
  readonly label: string;
  readonly description: string;
  readonly profileId: string;
  /** Exact version of the registered application profile. */
  readonly profileVersion: string;
  readonly fields: readonly ImportPresetField[];
}

const field = (key: string, label: string, requiredForDraft = false, requiredForRelease = false): ImportPresetField => ({
  key,
  label,
  requiredForDraft,
  requiredForRelease,
});

const commonFields = [
  field("sourceId", "Source record ID", false, true),
  field("eventDate", "Event or observation date", true, true),
  field("latitude", "Latitude"),
  field("longitude", "Longitude"),
  field("uncertainty", "Location or measurement uncertainty"),
  field("identification", "Identification", false, true),
  field("rights", "Source rights statement", false, true),
] as const;

export const IMPORT_PRESETS: readonly ImportPreset[] = [
  {
    id: "observation",
    version: "1.0.0",
    label: "Casual observation",
    description: "A plain-language occurrence or observation record with optional location and identification context.",
    profileId: "clio.profile.general-observation",
    profileVersion: "1.0.0",
    fields: commonFields,
  },
  {
    id: "structured-survey",
    version: "1.0.0",
    label: "Structured field survey",
    description: "A repeatable survey record retaining site, method, effort and observation context.",
    profileId: "clio.profile.structured-survey",
    profileVersion: "1.0.0",
    fields: [
      field("sourceId", "Source record ID", false, true),
      field("eventDate", "Survey date", true, true),
      field("siteId", "Site ID", true, true),
      field("method", "Survey method", true, true),
      field("effort", "Survey effort", false, true),
      field("latitude", "Latitude"),
      field("longitude", "Longitude"),
      field("uncertainty", "Location or measurement uncertainty"),
      field("identification", "Identification", false, true),
      field("rights", "Source rights statement", false, true),
    ],
  },
  {
    id: "microscopy",
    version: "1.0.0",
    label: "Microscopy collection",
    description: "Microscopy observations that keep specimen, preparation and measurement context separate from the image.",
    profileId: "clio.profile.microscopy-image",
    profileVersion: "1.0.0",
    fields: [
      field("sourceId", "Source record ID", false, true),
      field("eventDate", "Collection or observation date", true, true),
      field("specimenId", "Specimen or sample ID", true, true),
      field("preparation", "Preparation method", true, true),
      field("magnification", "Magnification"),
      field("measurement", "Measurement"),
      field("uncertainty", "Measurement uncertainty"),
      field("identification", "Identification", false, true),
      field("rights", "Source rights statement", false, true),
    ],
  },
  {
    id: "geology",
    version: "1.0.0",
    label: "Geological or material collection",
    description: "Geological and material records retaining sample, locality, material and uncertainty context.",
    profileId: "clio.profile.geological-sample",
    profileVersion: "1.0.0",
    fields: [
      field("sourceId", "Source record ID", false, true),
      field("eventDate", "Collection or observation date", true, true),
      field("specimenId", "Specimen or sample ID", true, true),
      field("materialType", "Material type", true, true),
      field("locality", "Locality", true, true),
      field("latitude", "Latitude"),
      field("longitude", "Longitude"),
      field("uncertainty", "Location or measurement uncertainty"),
      field("identification", "Identification", false, true),
      field("rights", "Source rights statement", false, true),
    ],
  },
];

export type ImportFormat = "csv" | "json" | "ndjson";
export type ImportFindingSeverity = "error" | "warning";

export interface ImportFinding {
  readonly severity: ImportFindingSeverity;
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface PreviewImportInput {
  readonly format: ImportFormat;
  readonly content: string;
  readonly presetId: string;
  readonly mapping?: Readonly<Record<string, string>>;
  /** CSV only. Default: detected from the header line (comma, semicolon or tab). */
  readonly delimiter?: "," | ";" | "\t";
}

export interface PreviewImportRow {
  readonly sourceId: string;
  readonly source: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  readonly findings: readonly ImportFinding[];
}

export interface PreviewImportResult {
  readonly rows: readonly PreviewImportRow[];
  readonly summary: {
    readonly total: number;
    /**
     * Rows with no import error: readable, mapped and not malformed. NOT "valid for the profile":
     * a preset's field keys are not the profile's keys yet, so profile requirements are not checked.
     */
    readonly noImportErrors: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly mappingVersion: string;
  /** CSV only: the delimiter that was used. */
  readonly delimiter?: "," | ";" | "\t";
}

export class ImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export interface ImportRow {
  readonly sourceId: string;
  readonly source: Record<string, unknown>;
  readonly data: Record<string, unknown>;
  readonly findings?: readonly ImportFinding[];
  readonly tombstone?: boolean;
}

export type ImportRows = readonly ImportRow[];

export type ChangeConflictReason = "both-changed" | "protected-field" | "delete-conflict";

export interface ChangeConflict {
  readonly sourceId: string;
  /** For display: the key path joined with ".". Keys can contain dots, so use `path` to act on a conflict. */
  readonly field: string;
  /** The exact key path, for example ["data", "a.b"]. Absent for whole-row conflicts. */
  readonly path?: readonly string[];
  readonly reason: ChangeConflictReason;
  readonly base?: unknown;
  readonly local?: unknown;
  readonly current?: unknown;
}

export interface ChangeComparison {
  readonly status: "unchanged" | "merged" | "conflicted";
  readonly merged: readonly ImportRow[];
  readonly conflicts: readonly ChangeConflict[];
}

const MAX_ROWS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_COLUMNS = 64;
const MAX_CELL_BYTES = 32 * 1024;
const MAX_JSON_DEPTH = 16;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const GEOJSON_DEPTHS: Readonly<Record<string, number>> = {
  Point: 1,
  MultiPoint: 2,
  LineString: 2,
  MultiLineString: 3,
  Polygon: 3,
  MultiPolygon: 4,
};
const encoder = new TextEncoder();

const byteLength = (value: string): number => encoder.encode(value).byteLength;

function fail(code: string, message: string): never {
  throw new ImportError(code, message);
}

function getPreset(id: string): ImportPreset {
  const preset = IMPORT_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) fail("preset.unknown", `Unknown preset: ${id}`);
  return preset;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const primitive = JSON.stringify(value);
    if (primitive === undefined) fail("json.unsupported-value", "Row contains an unsupported JSON value.");
    return primitive;
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  fail("json.unsupported-value", "Row contains an unsupported JSON value.");
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function validateJsonShape(value: unknown, depth: number, path: string): void {
  if (depth > MAX_JSON_DEPTH) fail("json.depth-limit", `JSON nesting exceeds the ${MAX_JSON_DEPTH}-level limit at ${path}.`);
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateJsonShape(child, depth + 1, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) fail("json.unsafe-key", `JSON key ${key} is not permitted at ${path}.`);
    validateJsonShape(value[key], depth + 1, `${path}.${key}`);
  }
}

function parseJsonRows(content: string, format: ImportFormat): Record<string, unknown>[] {
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  if (format === "ndjson") {
    const rows: Record<string, unknown>[] = [];
    const lines = text.split(/\r\n|\n|\r/);
    lines.forEach((line, index) => {
      if (line.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail("ndjson.invalid-line", `NDJSON line ${index + 1} is not valid JSON.`);
      }
      validateJsonShape(parsed, 0, `line ${index + 1}`);
      if (!isObject(parsed)) fail("ndjson.object-required", `NDJSON line ${index + 1} must be an object.`);
      rows.push(parsed);
    });
    if (rows.length === 0) fail("ndjson.empty", "The NDJSON input contains no object rows.");
    return rows;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("json.invalid", "The JSON input is not valid JSON.");
  }
  validateJsonShape(parsed, 0, "root");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (rows.length === 0) fail("json.empty", "The JSON array contains no rows.");
  if (!rows.every(isObject)) fail("json.object-rows-required", "JSON rows must be objects; arrays and primitives are not rows.");
  return rows;
}

function assertCell(value: string, location: string): void {
  if (byteLength(value) > MAX_CELL_BYTES) fail("input.cell-limit", `${location} exceeds the ${MAX_CELL_BYTES}-byte cell limit.`);
}

/** Picks the delimiter from the header record: the most frequent of comma, semicolon and tab outside quotes. */
export function sniffDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const character of text) {
    if (character === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (character === "\n" || character === "\r")) break;
    else if (!inQuotes && (character === "," || character === ";" || character === "\t")) counts[character] += 1;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","] && counts["\t"] > counts[";"]) return "\t";
  return ",";
}

function parseCsv(content: string, requested?: "," | ";" | "\t"): { rows: Record<string, unknown>[]; delimiter: "," | ";" | "\t" } {
  const text = content.startsWith("\uFEFF") ? content.slice(1) : content;
  if (text.length === 0) fail("csv.empty", "The CSV input is empty.");
  if (requested !== undefined && requested !== "," && requested !== ";" && requested !== "\t") fail("input.delimiter", "The delimiter must be a comma, a semicolon or a tab.");
  const delimiter = requested ?? sniffDelimiter(text);
  const records: string[][] = [];
  let record: string[] = [];
  let value = "";
  let inQuotes = false;
  let afterQuote = false;
  let sawCharacter = false;

  const pushCell = (): void => {
    assertCell(value, `CSV cell ${records.length + 1}:${record.length + 1}`);
    record.push(value);
    value = "";
    afterQuote = false;
  };
  const pushRecord = (): void => {
    // A blank line is not a record of one empty cell.
    if (record.length === 0 && value === "" && !sawCharacter) return;
    pushCell();
    records.push(record);
    record = [];
    sawCharacter = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        value += character;
      }
      sawCharacter = true;
      continue;
    }
    if (afterQuote) {
      if (character === delimiter) {
        pushCell();
        sawCharacter = true;
        continue;
      }
      if (character === "\r" || character === "\n") {
        pushRecord();
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        continue;
      }
      fail("csv.trailing-characters", `CSV has characters after a closing quote at character ${index + 1}.`);
    }
    if (character === '"') {
      if (value !== "") fail("csv.quote-placement", `CSV has a quote in an unquoted cell at character ${index + 1}.`);
      inQuotes = true;
      sawCharacter = true;
    } else if (character === delimiter) {
      pushCell();
      sawCharacter = true;
    } else if (character === "\r" || character === "\n") {
      pushRecord();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      value += character;
      sawCharacter = true;
    }
  }
  if (inQuotes) fail("csv.unclosed-quote", "CSV ended inside a quoted cell.");
  if (record.length > 0 || value !== "" || sawCharacter) pushRecord();
  if (records.length === 0 || records[0].length === 0) fail("csv.empty-header", "CSV has no header row.");

  const headers = records[0];
  if (headers.length > MAX_COLUMNS) fail("input.column-limit", `CSV has more than the ${MAX_COLUMNS}-column limit.`);
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    if (header.trim() === "") fail("csv.blank-header", `CSV header ${index + 1} is blank.`);
    if (DANGEROUS_KEYS.has(header)) fail("csv.unsafe-header", `CSV header ${header} is not permitted.`);
    const key = header.trim().toLowerCase();
    if (seen.has(key)) fail("csv.duplicate-header", `CSV header ${header} is duplicated.`);
    seen.add(key);
  });

  const dataRecords = records.slice(1);
  if (dataRecords.length > MAX_ROWS) fail("input.row-limit", `Input has more than the ${MAX_ROWS}-row limit.`);
  const rows = dataRecords.map((cells, rowIndex) => {
    if (cells.length > headers.length) {
      const hint = requested === undefined && headers.length === 1 ? " The file may use a different delimiter; pass delimiter explicitly." : "";
      fail("csv.column-count", `CSV row ${rowIndex + 2} has more columns than its header.${hint}`);
    }
    const source: Record<string, unknown> = {};
    headers.forEach((header, columnIndex) => {
      const cellValue = cells[columnIndex] ?? "";
      assertCell(cellValue, `CSV cell ${rowIndex + 2}:${columnIndex + 1}`);
      source[header] = cellValue;
    });
    return source;
  });
  return { rows, delimiter };
}

function assertJsonLimits(rows: readonly Record<string, unknown>[]): void {
  if (rows.length > MAX_ROWS) fail("input.row-limit", `Input has more than the ${MAX_ROWS}-row limit.`);
  rows.forEach((row, rowIndex) => {
    const keys = Object.keys(row);
    if (keys.length > MAX_COLUMNS) fail("input.column-limit", `Row ${rowIndex + 1} has more than the ${MAX_COLUMNS}-column limit.`);
    keys.forEach((key) => {
      const value = stableJson(row[key]);
      assertCell(value, `JSON cell ${rowIndex + 1}:${key}`);
    });
  });
}

function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const aliases: Readonly<Record<string, readonly string[]>> = {
  sourceId: ["id", "recordid", "record_id", "source_id", "identifier", "uuid"],
  eventDate: ["date", "observeddate", "observationdate", "collecteddate", "excavationdate"],
  latitude: ["lat"],
  longitude: ["lon", "lng"],
  identification: ["taxon", "species", "specimenidentification", "findidentification"],
  siteId: ["site", "site_id", "locationid"],
  specimenId: ["specimen", "sampleid", "sample_id"],
  contextId: ["context", "context_id"],
  materialType: ["material", "rocktype"],
  findType: ["objecttype", "find_type"],
  rights: ["licence", "license", "rightsstatement"],
  method: ["protocol"],
  effort: ["samplingeffort"],
};

function makeMapping(preset: ImportPreset, source: Record<string, unknown>, supplied?: Readonly<Record<string, string>>): Record<string, string> {
  const fieldKeys = new Set(preset.fields.map((item) => item.key));
  const mapping: Record<string, string> = Object.create(null) as Record<string, string>;
  if (supplied) {
    const usedTargets = new Set<string>();
    for (const sourceKey of Object.keys(supplied).sort()) {
      if (DANGEROUS_KEYS.has(sourceKey)) fail("mapping.unsafe-source-key", `Mapping source key ${sourceKey} is not permitted.`);
      const target = supplied[sourceKey];
      if (!fieldKeys.has(target)) fail("mapping.unknown-target", `Mapping target ${target} is not a field in preset ${preset.id}.`);
      if (usedTargets.has(target)) fail("mapping.target-collision", `Multiple source columns map to preset field ${target}.`);
      mapping[sourceKey] = target;
      usedTargets.add(target);
    }
    return mapping;
  }

  const sourceKeys = Object.keys(source);
  const usedTargets = new Set<string>();
  const usedSourceKeys = new Set<string>();
  for (const target of preset.fields.map((item) => item.key)) {
    const targetNames = new Set([normaliseKey(target), normaliseKey(preset.fields.find((item) => item.key === target)?.label ?? ""), ...(aliases[target] ?? []).map(normaliseKey)]);
    const match = sourceKeys.find((sourceKey) => !usedSourceKeys.has(sourceKey) && !usedTargets.has(target) && targetNames.has(normaliseKey(sourceKey)));
    if (match) {
      mapping[match] = target;
      usedTargets.add(target);
      usedSourceKeys.add(match);
    }
  }
  return mapping;
}

function sourceIdFor(source: Record<string, unknown>, mapping: Record<string, string>, explicitMapping: boolean): string {
  const mappedSourceId = Object.keys(mapping).find((key) => mapping[key] === "sourceId");
  const fromMapped = (): string | undefined => {
    if (mappedSourceId === undefined) return undefined;
    const value = source[mappedSourceId];
    return hasValue(value) && (typeof value === "string" || typeof value === "number") ? String(value) : undefined;
  };
  // A column the caller mapped to sourceId wins, then the literal sourceId / source_id columns.
  if (explicitMapping) {
    const mapped = fromMapped();
    if (mapped !== undefined) return mapped;
  }
  const explicitKeys = ["sourceId", "source_id"];
  for (const key of explicitKeys) {
    const value = source[key];
    if (hasValue(value) && (typeof value === "string" || typeof value === "number")) return String(value);
  }
  const namespaces = ["sourceNamespace", "namespace", "source_namespace"];
  const records = ["sourceRecordId", "recordId", "source_record_id", "record_id"];
  const namespaceKey = namespaces.find((key) => hasValue(source[key]) && (typeof source[key] === "string" || typeof source[key] === "number"));
  const recordKey = records.find((key) => hasValue(source[key]) && (typeof source[key] === "string" || typeof source[key] === "number"));
  if (namespaceKey !== undefined && recordKey !== undefined) return `${String(source[namespaceKey])}:${String(source[recordKey])}`;
  // A compound namespace:record ID is explicit, so it comes first. Then any column that matched sourceId
  // automatically ("Record ID"), then the plain candidates.
  const autoMapped = fromMapped();
  if (autoMapped !== undefined) return autoMapped;
  const candidates = ["id", "recordId", "source_record_id", "record_id", "identifier", "uuid"];
  for (const target of candidates) {
    const value = source[target];
    if (hasValue(value) && (typeof value === "string" || typeof value === "number")) return String(value);
  }
  return `row-${stableHash(stableJson(source))}`;
}

function isNumeric(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

function addFinding(findings: ImportFinding[], severity: ImportFindingSeverity, fieldName: string, code: string, message: string): void {
  findings.push({ severity, field: fieldName, code, message });
}

function validateCoordinatePosition(value: unknown, findings: ImportFinding[], path: string): void {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3)) {
    addFinding(findings, "error", "geometry", "geometry.position-shape", `${path} must contain longitude, latitude, and optional altitude.`);
    return;
  }
  if (value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))) {
    addFinding(findings, "error", "geometry", "geometry.coordinate-not-numeric", `${path} coordinates must remain numeric JSON numbers; no coercion was applied.`);
    return;
  }
  const longitude = value[0] as number;
  const latitude = value[1] as number;
  if (longitude < -180 || longitude > 180) addFinding(findings, "error", "geometry", "geometry.longitude-out-of-range", `${path} longitude must be between -180 and 180.`);
  if (latitude < -90 || latitude > 90) addFinding(findings, "error", "geometry", "geometry.latitude-out-of-range", `${path} latitude must be between -90 and 90.`);
}

function validateCoordinates(value: unknown, levels: number, findings: ImportFinding[], path: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    addFinding(findings, "error", "geometry", "geometry.coordinates-invalid", `${path} must be a non-empty coordinate array.`);
    return;
  }
  if (levels === 1) {
    validateCoordinatePosition(value, findings, path);
    return;
  }
  value.forEach((child, index) => validateCoordinates(child, levels - 1, findings, `${path}[${index}]`));
}

function validateGeometry(value: unknown, findings: ImportFinding[], path = "geometry"): void {
  if (!isObject(value)) {
    addFinding(findings, "error", "geometry", "geometry.object-required", "Geometry must be a GeoJSON object; stringified geometry is not silently parsed.");
    return;
  }
  const type = value.type;
  if (type === "GeometryCollection") {
    if (!Array.isArray(value.geometries)) {
      addFinding(findings, "error", "geometry", "geometry.collection-invalid", "A GeometryCollection requires a geometries array.");
      return;
    }
    value.geometries.forEach((child, index) => validateGeometry(child, findings, `${path}.geometries[${index}]`));
    return;
  }
  if (typeof type !== "string" || GEOJSON_DEPTHS[type] === undefined) {
    addFinding(findings, "error", "geometry", "geometry.type-unsupported", "Geometry type must be a supported GeoJSON geometry type.");
    return;
  }
  validateCoordinates(value.coordinates, GEOJSON_DEPTHS[type], findings, `${path}.coordinates`);
}

/**
 * A column holds a date when its name is "date", ends in a _date / -date / " date" word, ends in the
 * camel-case word Date (eventDate), or ends in observedAt / collectedAt / excavatedAt / surveyAt / eventAt.
 * A name that merely contains the letters "date" (candidate_name, last_update_by) is not a date column.
 */
export function isDateColumn(key: string): boolean {
  return /(?:^|[_\s.-])date$/iu.test(key) || /[a-z]Date$/u.test(key) || /(?:observed|collected|excavated|survey|event)At$/iu.test(key);
}

const DATE_PART = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/u;

type DatePartCheck = Readonly<{ valid: boolean; noZone: boolean }>;

/** ISO 8601 as used in Darwin Core: YYYY, YYYY-MM, YYYY-MM-DD, or a date-time with an optional zone. Real calendar days only. */
function checkDatePart(value: string): DatePartCheck {
  const match = DATE_PART.exec(value);
  if (!match) return { valid: false, noZone: false };
  const year = Number(match[1]);
  if (match[2] !== undefined) {
    const month = Number(match[2]);
    if (month < 1 || month > 12) return { valid: false, noZone: false };
    if (match[3] !== undefined) {
      const date = new Date(Date.UTC(year, month - 1, Number(match[3])));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== Number(match[3])) return { valid: false, noZone: false };
    }
  }
  if (match[4] !== undefined) {
    if (Number(match[4]) > 23 || Number(match[5]) > 59 || (match[6] !== undefined && Number(match[6]) > 59)) return { valid: false, noZone: false };
    const zone = match[7];
    if (zone !== undefined && zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.replace(":", "").slice(3, 5)) > 59)) return { valid: false, noZone: false };
    return { valid: true, noZone: zone === undefined };
  }
  return { valid: true, noZone: false };
}

function checkDateFields(data: Record<string, unknown>, findings: ImportFinding[], mapped: boolean): void {
  // A mapped date is a hard error when wrong. A date-looking source column the caller did not map is only a warning.
  const severity: ImportFindingSeverity = mapped ? "error" : "warning";
  for (const key of Object.keys(data)) {
    if (!isDateColumn(key) || !hasValue(data[key])) continue;
    const value = data[key];
    if (typeof value !== "string") {
      addFinding(findings, severity, key, "date.invalid", `${key} must be an ISO 8601 date or date-time written as text.`);
      continue;
    }
    const parts = value.trim().split("/");
    if (parts.length > 2 || parts.some((part) => !checkDatePart(part).valid)) {
      addFinding(findings, severity, key, "date.invalid", `${key} is not an ISO 8601 date, partial date (YYYY, YYYY-MM), date-time or start/end interval, or is not a real calendar date.`);
      continue;
    }
    if (parts.some((part) => checkDatePart(part).noZone)) {
      addFinding(findings, "warning", key, "date.no-timezone", `${key} has a time but no time zone; it was kept as written.`);
    }
    if (parts.length === 2 && parts[0]!.length === parts[1]!.length && parts[0]! > parts[1]!) {
      addFinding(findings, "warning", key, "date.interval-reversed", `${key} ends before it starts; the original interval was kept.`);
    }
  }
}

function validateScientificSignals(data: Record<string, unknown>, mapped = true): ImportFinding[] {
  const findings: ImportFinding[] = [];
  checkDateFields(data, findings, mapped);

  const latitude = data.latitude;
  const longitude = data.longitude;
  if (hasValue(latitude) !== hasValue(longitude)) {
    addFinding(findings, "warning", hasValue(latitude) ? "longitude" : "latitude", "coordinates.pair-incomplete", "Latitude and longitude should be supplied as a pair.");
  }
  if (hasValue(latitude)) {
    if (!isNumeric(latitude)) addFinding(findings, "error", "latitude", "coordinates.not-numeric", "Latitude is not numeric.");
    else if (Number(latitude) < -90 || Number(latitude) > 90) addFinding(findings, "error", "latitude", "coordinates.out-of-range", "Latitude must be between -90 and 90.");
  }
  if (hasValue(longitude)) {
    if (!isNumeric(longitude)) addFinding(findings, "error", "longitude", "coordinates.not-numeric", "Longitude is not numeric.");
    else if (Number(longitude) < -180 || Number(longitude) > 180) addFinding(findings, "error", "longitude", "coordinates.out-of-range", "Longitude must be between -180 and 180.");
  }

  for (const key of Object.keys(data)) {
    if (/^(geometry|geojson)$/i.test(key) && hasValue(data[key])) validateGeometry(data[key], findings, key);
    if (/uncertainty|accuracy|precision|error/i.test(key) && hasValue(data[key])) {
      if (!isNumeric(data[key]) || Number(data[key]) < 0) addFinding(findings, "warning", key, "uncertainty.invalid", `${key} should be a non-negative number; the original value was retained.`);
    }
    if (/identification|taxon|species/i.test(key) && typeof data[key] === "string" && /^(unknown|unidentified|indeterminate|n\/?a)$/i.test(data[key].trim())) {
      addFinding(findings, "warning", key, "identification.unknown", "The identification is unknown; this remains a valid draft state.");
    }
  }

  const rangePairs: [string, string][] = [];
  const seenRangePairs = new Set<string>();
  for (const key of Object.keys(data)) {
    const min = /^(.*?)(?:min|minimum|from)$/i.exec(key);
    const max = /^(.*?)(?:max|maximum|to)$/i.exec(key);
    if (min) {
      const counterpart = Object.keys(data).find((candidate) => new RegExp(`^${escapeRegExp(min[1])}(?:max|maximum|to)$`, "i").test(candidate));
      if (counterpart && !seenRangePairs.has(`${key}\u0000${counterpart}`)) {
        rangePairs.push([key, counterpart]);
        seenRangePairs.add(`${key}\u0000${counterpart}`);
        seenRangePairs.add(`${counterpart}\u0000${key}`);
      }
    } else if (max) {
      const counterpart = Object.keys(data).find((candidate) => new RegExp(`^${escapeRegExp(max[1])}(?:min|minimum|from)$`, "i").test(candidate));
      if (counterpart && !seenRangePairs.has(`${counterpart}\u0000${key}`)) {
        rangePairs.push([counterpart, key]);
        seenRangePairs.add(`${counterpart}\u0000${key}`);
        seenRangePairs.add(`${key}\u0000${counterpart}`);
      }
    }
  }
  for (const [minimumKey, maximumKey] of rangePairs) {
    if (isNumeric(data[minimumKey]) && isNumeric(data[maximumKey]) && Number(data[minimumKey]) > Number(data[maximumKey])) {
      addFinding(findings, "warning", minimumKey, "range.reversed", `${minimumKey} is greater than ${maximumKey}; the original range was retained.`);
    }
  }
  return findings;
}

function validateRow(preset: ImportPreset, data: Record<string, unknown>, source: Record<string, unknown>, mapping: Record<string, string>): ImportFinding[] {
  const findings: ImportFinding[] = [];
  for (const item of preset.fields) {
    if (!hasValue(data[item.key])) {
      if (item.requiredForDraft) addFinding(findings, "error", item.key, "required.missing", `${item.label} is required for a draft.`);
      else if (item.requiredForRelease) addFinding(findings, "warning", item.key, "required-for-release.missing", `${item.label} is required before release.`);
    }
  }
  const mappedSignals = validateScientificSignals(data);
  const unmappedSource: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source)) if (mapping[key] === undefined) unmappedSource[key] = source[key];
  const sourceSignals = validateScientificSignals(unmappedSource, false);
  for (const finding of [...mappedSignals, ...sourceSignals]) {
    if (!findings.some((existing) => existing.field === finding.field && existing.code === finding.code)) findings.push(finding);
  }
  return findings;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function previewImport(input: PreviewImportInput): PreviewImportResult {
  if (!input || typeof input.content !== "string") fail("input.content-required", "Import content must be a string.");
  if (!['csv', 'json', 'ndjson'].includes(input.format)) fail("input.format-unsupported", "Import format must be csv, json or ndjson.");
  if (byteLength(input.content) > MAX_BYTES) fail("input.byte-limit", `Input exceeds the ${MAX_BYTES}-byte limit.`);
  const preset = getPreset(input.presetId);
  let delimiter: "," | ";" | "\t" | undefined;
  let sources: Record<string, unknown>[];
  if (input.format === "csv") {
    const parsed = parseCsv(input.content, input.delimiter);
    sources = parsed.rows;
    delimiter = parsed.delimiter;
  } else sources = parseJsonRows(input.content, input.format);
  if (input.format !== "csv") assertJsonLimits(sources);
  const mappingForVersion = Object.create(null) as Record<string, string>;
  for (const source of sources) {
    const rowMapping = makeMapping(preset, source, input.mapping);
    for (const key of Object.keys(rowMapping).sort()) mappingForVersion[key] = rowMapping[key];
  }
  const mappingVersion = `import.mapping.v1/${preset.id}@${preset.version}/${stableHash(stableJson({ profileId: preset.profileId, profileVersion: preset.profileVersion, mapping: mappingForVersion }))}`;
  const rows: PreviewImportRow[] = [];
  const seenIds = new Map<string, number>();
  sources.forEach((source, rowIndex) => {
    const mapping = makeMapping(preset, source, input.mapping);
    const data: Record<string, unknown> = {};
    for (const target of preset.fields.map((item) => item.key)) {
      const sourceKey = Object.keys(mapping).find((key) => mapping[key] === target && Object.prototype.hasOwnProperty.call(source, key));
      if (sourceKey !== undefined) data[target] = source[sourceKey];
    }
    const sourceId = sourceIdFor(source, mapping, input.mapping !== undefined);
    const findings = validateRow(preset, data, source, mapping);
    const prior = seenIds.get(sourceId);
    if (prior !== undefined) addFinding(findings, "error", "sourceId", "source.duplicate-id", `Source ID ${sourceId} is duplicated by row ${prior + 1}.`);
    else seenIds.set(sourceId, rowIndex);
    rows.push({ sourceId, source, data, findings });
  });
  let errors = 0;
  let warnings = 0;
  for (const row of rows) {
    for (const finding of row.findings) {
      if (finding.severity === "error") errors += 1;
      else warnings += 1;
    }
  }
  return { rows, summary: { total: rows.length, noImportErrors: rows.filter((row) => !row.findings.some((finding) => finding.severity === "error")).length, errors, warnings }, mappingVersion, ...(delimiter === undefined ? {} : { delimiter }) };
}

const MISSING = Symbol("missing");
const PROTECTED_ROOTS = new Set(["geometry", "identification", "rights", "relationships", "stratigraphy", "stratigraphicRelationships"]);

/** A path is stored as JSON text of its key array, so a key that contains "." can never be confused with two keys. */
const pathKey = (path: readonly string[]): string => JSON.stringify(path);
const pathOf = (key: string): string[] => JSON.parse(key) as string[];

function flattened(value: unknown, prefix: readonly string[], output: Map<string, unknown>, depth = 0): void {
  if (depth > MAX_JSON_DEPTH || value === null || typeof value !== "object" || Array.isArray(value)) {
    output.set(pathKey(prefix), value);
    return;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 0) output.set(pathKey(prefix), {});
  for (const key of keys) flattened(object[key], [...prefix, key], output, depth + 1);
}

function rowMap(row: ImportRow | undefined): Map<string, unknown> {
  const output = new Map<string, unknown>();
  if (!row) return output;
  flattened(row.source, ["source"], output);
  flattened(row.data, ["data"], output);
  output.set(pathKey(["tombstone"]), row.tombstone === true);
  return output;
}

/** A key that holds null is a value; only an absent key is MISSING. */
const valueAt = (map: ReadonlyMap<string, unknown>, path: string): unknown => (map.has(path) ? map.get(path) : MISSING);

function equalValue(left: unknown, right: unknown): boolean {
  if (left === MISSING || right === MISSING) return left === right;
  return stableJson(left) === stableJson(right);
}

function rootFor(key: string): string {
  const parts = pathOf(key);
  return parts[0] === "data" || parts[0] === "source" ? parts[1] ?? parts[0]! : parts[0]!;
}

/**
 * Change rows are not trusted: a sync client sends the "local" side. Reject the keys that reach
 * Object.prototype, and blank keys, anywhere in source or data, and limit nesting, before any merge.
 */
function assertChangeRow(row: ImportRow, label: string): void {
  if (!isObject(row.source) || !isObject(row.data)) fail("changes.row-shape", `${label} row ${String(row.sourceId)} needs source and data objects.`);
  const walk = (value: unknown, depth: number, where: string): void => {
    if (depth > MAX_JSON_DEPTH) fail("json.depth-limit", `${label} row ${String(row.sourceId)} nests deeper than ${MAX_JSON_DEPTH} levels at ${where}.`);
    if (Array.isArray(value)) { value.forEach((child, index) => walk(child, depth + 1, `${where}[${index}]`)); return; }
    if (!isObject(value)) return;
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) fail("json.unsafe-key", `Key ${key} is not permitted in ${label} row ${String(row.sourceId)} at ${where}.`);
      if (key === "") fail("changes.blank-key", `A blank key is not permitted in ${label} row ${String(row.sourceId)} at ${where}.`);
      walk(value[key], depth + 1, `${where}.${key}`);
    }
  };
  walk(row.source, 0, "source");
  walk(row.data, 0, "data");
}

function rowsById(rows: ImportRows, label: string): Map<string, ImportRow> {
  const result = new Map<string, ImportRow>();
  for (const row of rows) {
    if (!row || typeof row.sourceId !== "string" || row.sourceId === "") fail("changes.source-id", "Change rows require a non-empty sourceId.");
    assertChangeRow(row, label);
    if (result.has(row.sourceId)) fail("changes.duplicate-source-id", `Change source ID ${row.sourceId} is duplicated.`);
    result.set(row.sourceId, row);
  }
  return result;
}

/**
 * Writes (or removes) one leaf. Containers it has to create have no prototype, every step
 * uses own properties only, and a key that could reach Object.prototype stops the merge.
 */
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  for (const part of path) {
    if (DANGEROUS_KEYS.has(part)) fail("json.unsafe-key", `Key ${part} is not permitted in a merge path.`);
    if (part === "") fail("changes.blank-key", "A blank key is not permitted in a merge path.");
  }
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index]!;
    const existing = Object.hasOwn(cursor, part) ? cursor[part] : undefined;
    if (isObject(existing)) { cursor = existing; continue; }
    if (value === MISSING) return; // nothing to remove below a value that is not an object
    const created = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(cursor, part, { value: created, writable: true, enumerable: true, configurable: true });
    cursor = created;
  }
  const leaf = path[path.length - 1]!;
  if (value === MISSING) delete cursor[leaf];
  else Object.defineProperty(cursor, leaf, { value, writable: true, enumerable: true, configurable: true });
}

function cloneRow(row: ImportRow): ImportRow {
  return { sourceId: row.sourceId, source: JSON.parse(stableJson(row.source)) as Record<string, unknown>, data: JSON.parse(stableJson(row.data)) as Record<string, unknown>, ...(row.findings === undefined ? {} : { findings: JSON.parse(stableJson(row.findings)) as ImportFinding[] }), ...(row.tombstone === undefined ? {} : { tombstone: row.tombstone }) };
}

export function compareChanges(base: ImportRows, local: ImportRows, current: ImportRows): ChangeComparison {
  const baseById = rowsById(base, "base");
  const localById = rowsById(local, "local");
  const currentById = rowsById(current, "current");
  const ids = [...new Set([...baseById.keys(), ...localById.keys(), ...currentById.keys()])].sort();
  const merged: ImportRow[] = [];
  const conflicts: ChangeConflict[] = [];

  for (const sourceId of ids) {
    const baseRow = baseById.get(sourceId);
    const localRow = localById.get(sourceId);
    const currentRow = currentById.get(sourceId);
    const baseMap = rowMap(baseRow);
    const localMap = rowMap(localRow);
    const currentMap = rowMap(currentRow);
    if (!baseRow) {
      if (!localRow && currentRow) merged.push(cloneRow(currentRow));
      else if (localRow && !currentRow) merged.push(cloneRow(localRow));
      else if (localRow && currentRow) {
        if (equalValue(localRow, currentRow)) merged.push(cloneRow(currentRow));
        else conflicts.push({ sourceId, field: "row", reason: "both-changed", local: localRow, current: currentRow });
      }
      continue;
    }
    const localUnchanged = localRow !== undefined && equalValue(localRow, baseRow);
    const currentUnchanged = currentRow !== undefined && equalValue(currentRow, baseRow);
    if (localUnchanged && currentRow) {
      merged.push(cloneRow(currentRow));
      continue;
    }
    if (currentUnchanged && localRow) {
      merged.push(cloneRow(localRow));
      continue;
    }
    if (!localRow || !currentRow) {
      if (!localRow && !currentRow) continue;
      if (!localRow && currentUnchanged) continue;
      if (!currentRow && localUnchanged) continue;
      conflicts.push({ sourceId, field: "row", reason: "delete-conflict", base: baseRow, local: localRow, current: currentRow });
      if (currentRow) merged.push(cloneRow(currentRow));
      continue;
    }

    const paths = [...new Set([...baseMap.keys(), ...localMap.keys(), ...currentMap.keys()])].sort();
    const localChanges = paths.filter((path) => !equalValue(valueAt(localMap, path), valueAt(baseMap, path)));
    const currentChanges = paths.filter((path) => !equalValue(valueAt(currentMap, path), valueAt(baseMap, path)));
    const localRoots = new Set(localChanges.map(rootFor));
    const currentRoots = new Set(currentChanges.map(rootFor));
    const currentChangeSet = new Set(currentChanges);
    // Both sides made the same change to the same key: that is agreement, not a conflict.
    const sameChange = (path: string): boolean => currentChangeSet.has(path) && equalValue(valueAt(localMap, path), valueAt(currentMap, path));
    for (const path of localChanges) {
      if (sameChange(path)) continue;
      const overlappingPath = currentChangeSet.has(path);
      const protectedOverlap = PROTECTED_ROOTS.has(rootFor(path)) && currentRoots.has(rootFor(path));
      if (overlappingPath || protectedOverlap) {
        const keyPath = pathOf(path);
        conflicts.push({ sourceId, field: keyPath.join("."), path: keyPath, reason: protectedOverlap ? "protected-field" : "both-changed", base: baseMap.get(path), local: localMap.get(path), current: currentMap.get(path) });
      }
    }
    if (conflicts.some((conflict) => conflict.sourceId === sourceId)) {
      merged.push(cloneRow(currentRow));
      continue;
    }
    const result = cloneRow(currentRow);
    for (const path of localChanges) {
      if (sameChange(path)) continue;
      setPath(result as unknown as Record<string, unknown>, pathOf(path), localMap.has(path) ? localMap.get(path) : MISSING);
    }
    merged.push(result);
  }

  const status = conflicts.length > 0 ? "conflicted" : merged.some((row) => !baseById.has(row.sourceId) || !equalValue(row, baseById.get(row.sourceId))) ? "merged" : "unchanged";
  return { status, merged: merged.sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0), conflicts };
}

