import {
  DarwinCoreArchiveError,
  buildDarwinCoreArchive,
  type DarwinCoreArchive,
  type DarwinCoreArchiveRecord,
  type EmlParty,
} from "./dwca.ts";
import { isIsoDateTime, utcDateOf } from "./iso.ts";
import { LOCATION_WITHHELD_TEXT, assertLocationOptions, containsLocationText, isLocationVisibilityKey, locationStateOf, locationValuePaths, redactLocationText, visibilityStateText, withoutLocationValues, type LocationVisibilityOptions } from "./location-visibility.ts";
import { SYSTEM_IDS, collapseWithheld, privateLocationPaths, withholdCanonicalRecordVersion, type WithholdingOptions } from "./research-withholding.ts";
import { normalizeOrcid } from "./orcid.ts";
import { spreadsheetSafeText } from "./spreadsheet.ts";
import { createStoredZip, readStoredZip } from "./zip-store.ts";
import { licenceProblems, resolveLicence, type Licence } from "./licensing.ts";
import { EMOF_COLUMNS, emofColumnTerm, toEmofRow, validateMeasurementRows, type MeasurementRow } from "./measurement-rows.ts";
import {
  canonicalProjectSchema,
  sha256Hex,
  toJsonSchema,
  validateProjectSchemaData,
  validateProjectSchemaDocument,
  type ProjectFieldDatatype,
  type ProjectSchemaDocument,
} from "./research-schema.ts";
import { RECORD_DOCUMENT_SCHEMA, type RecordReadiness, type RecordFields } from "./record-fields.ts";

/**
 * Builds a self-describing, fixity-checked research export package:
 *
 *   bagit.txt, bag-info.txt, manifest-sha256.txt, tagmanifest-sha256.txt  (BagIt 1.0, RFC 8493)
 *   data/ro-crate-metadata.json    (RO-Crate 1.2 description of the payload)
 *   data/datapackage.json          (Frictionless Data Package v2 descriptor)
 *   data/records.jsonl             (lossless record versions, one per line)
 *   data/records.csv, measurements.csv, extensions/*.csv, media-manifest.csv
 *   data/schemas/<key>/<version>.clio.json and .schema.json
 *   data/dwca/                     (optional) unzipped Darwin Core Archive with EML, see dwca.ts
 *   data/README.txt
 *
 * The package is built from values passed in, never from a live database
 * export. Output is
 * deterministic for the same input, so a re-export can be compared byte for
 * byte. Nothing here uploads, deposits or registers anything.
 */

export const RESEARCH_PACKAGE_FORMAT = "clio.research-package/v1" as const;
/** Address of the builder entity in the RO-Crate: this project's repository. Pass softwareUrl to name your own software instead. */
export const RESEARCH_KIT_URL = "https://github.com/RME-Solutions-Technology/clio-research-kit";
export const RESEARCH_PACKAGE_LIMITS = Object.freeze({ records: 10_000, schemas: 50, media: 20_000 });

export type ResearchPackageRecord = Readonly<{
  recordId: string;
  versionId: string;
  profileId: string;
  profileVersion: string;
  title: string;
  eventDate?: string;
  decimalLatitude?: number;
  decimalLongitude?: number;
  coordinateUncertaintyInMeters?: number;
  recordedBy?: string;
  landingPage?: string;
  /** Licence URI of the record metadata. Must equal the package licence (default CC BY 4.0) when a Darwin Core Archive is included. */
  licence: string;
  /** Rights holder named in the Darwin Core Archive; defaults to the authors' literal names. */
  rightsHolder?: string;
  /** The exact record-version JSON you hold; written losslessly to records.jsonl. */
  canonical: Readonly<Record<string, unknown>>;
  projectSchema?: Readonly<{ schemaKey: string; version: string }>;
  extension?: Readonly<Record<string, unknown>>;
  measurements?: readonly MeasurementRow[];
  /**
   * Paths of values deliberately left out of this copy (for example
   * `extension.plotCode` or `canonical.fields.event.privateLocationObjectRef`).
   * Written to records.jsonl and, as informationWithheld, to records.csv.
   */
  withheld?: readonly string[];
}>;

export type ResearchPackageMedia = Readonly<{
  recordId: string;
  objectKey: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  licence: string;
  rightsHolder: string;
  /** Public https URL of the media file, when it has one. Only such media enters the Darwin Core Archive. */
  accessUri?: string;
}>;

/** Dataset metadata for the optional Darwin Core Archive. Every field has a default. */
export type ResearchPackageDarwinCoreOptions = Readonly<{
  /** Default `urn:clio:research-package:<packageId>`. */
  datasetId?: string;
  /** Profile readiness every record must meet. Default "referenceable". */
  readiness?: RecordReadiness;
  /** ISO 639-2 metadata language. Default "eng". */
  language?: string;
  /** Default: the package creator. */
  creator?: EmlParty;
  /** Default: the creator. */
  metadataProvider?: EmlParty;
  /** Default: the creator. */
  contact?: EmlParty;
}>;

export type ResearchPackageInput = Readonly<{
  packageId: string;
  title: string;
  description?: string;
  /** ISO date-time the export was made; passed in so output is deterministic. */
  createdAt: string;
  /**
   * Who made the package. `name` is the display name. For the EML creator, give `organisationName`,
   * or `givenName` and `surName`; otherwise the display name is split at its last space
   * ("Surname, Given" is also understood), which is a guess.
   */
  creator: Readonly<{ name: string; orcid?: string; givenName?: string; surName?: string; organisationName?: string }>;
  records: readonly ResearchPackageRecord[];
  schemas: readonly ProjectSchemaDocument[];
  media?: readonly ResearchPackageMedia[];
  /**
   * Adds data/dwca/, an unzipped Darwin Core Archive with EML. Every record
   * must be eligible (see validateDarwinCoreEligibility) or the build fails.
   */
  includeDarwinCoreArchive?: boolean;
  darwinCore?: ResearchPackageDarwinCoreOptions;
  /**
   * "package-licence" (default): every record carries the package licence, so
   * the package declares it. "source-statements": some records are staged
   * project data that keep the rights statement supplied with them; the
   * package then declares no package-wide licence.
   */
  rights?: "package-licence" | "source-statements";
  /** The package-wide licence. Default: CC BY 4.0. */
  licence?: Licence;
  /** Plain-language notes added to README.txt (for example why an optional part is missing). At most 50 lines. */
  notes?: readonly string[];
  /**
   * Web address of the software that built the package, written to the RO-Crate
   * (the RO-Crate 1.2 profile requires a url on a SoftwareApplication). Default:
   * RESEARCH_KIT_URL, the project repository.
   */
  softwareUrl?: string;
  /**
   * Put a single quote in front of any text cell that starts with =, +, - or @ (or a tab or CR) in the
   * CSV files and in the Darwin Core tables, so a spreadsheet shows it as text instead of running it.
   * Off by default: values are then written exactly as recorded. Numbers are never quoted.
   */
  spreadsheetSafe?: boolean;
  /**
   * A record whose canonical event does not state its location visibility counts as withheld: the builder
   * refuses it while it still holds coordinates, and never writes flat coordinates for it. Pass "public" to treat
   * such records as public instead.
   */
  missingVisibility?: LocationVisibilityOptions["missingVisibility"];
  /** Extra key names to treat as private location references when checking records (see withholding). */
  privateKeys?: readonly string[];
}>;

export type PackageFile = Readonly<{ path: string; bytes: Uint8Array }>;

export type ResearchPackage = Readonly<{
  format: typeof RESEARCH_PACKAGE_FORMAT;
  /** Also the name of the single top-level folder when the bag is serialised (see zipResearchPackage). */
  packageId: string;
  files: readonly PackageFile[];
  /** SHA-256 of manifest-sha256.txt: one value that pins the whole payload. */
  manifestSha256: string;
  payloadBytes: number;
  payloadFiles: number;
}>;

export class ResearchPackageError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Research package input is invalid: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`);
    this.name = "ResearchPackageError";
    this.problems = problems;
  }
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const WITHHELD_PATH = /^[^\x00-\x1f\x7f]{1,300}$/u;
const MAX_WITHHELD = 500;

/** One plain sentence for a record's withheld values (informationWithheld). */
export function informationWithheldText(paths: readonly string[] | undefined): string {
  if (!paths || paths.length === 0) return "";
  const shown = paths.slice(0, 50);
  return `Withheld from this export: ${shown.join(", ")}${paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ""}.`;
}
const SHA256 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();

function stableStringify(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, member]) => [key, normalize(member)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** RFC 4180 CSV with CRLF line endings; every value is written verbatim. */
export function toCsv(columns: readonly string[], rows: readonly Readonly<Record<string, unknown>>[], options: Readonly<{ spreadsheetSafe?: boolean }> = {}): string {
  const cell = (value: unknown): string => {
    const raw = value === undefined || value === null ? "" : typeof value === "string" ? value : typeof value === "object" ? stableStringify(value) : String(value);
    // Only text is quoted: a number written as -33.8 is not a formula and stays a number.
    const text = options.spreadsheetSafe === true && typeof value === "string" ? spreadsheetSafeText(raw) : raw;
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
  };
  return [columns.map(cell).join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n") + "\r\n";
}

/** The EML creator for a package creator: an organisation, a given and family name, or a best-effort split of the display name. */
export function emlCreator(creator: ResearchPackageInput["creator"]): EmlParty {
  const orcid = creator.orcid === undefined ? {} : { orcid: creator.orcid };
  if (creator.organisationName?.trim()) return { organizationName: creator.organisationName.trim(), ...orcid };
  if (creator.surName?.trim()) return { individualName: { ...(creator.givenName?.trim() ? { givenName: creator.givenName.trim() } : {}), surName: creator.surName.trim() }, ...orcid };
  const name = creator.name.trim().replace(/\s+/gu, " ");
  const comma = name.indexOf(",");
  if (comma > 0) return { individualName: { givenName: name.slice(comma + 1).trim(), surName: name.slice(0, comma).trim() }, ...orcid };
  const space = name.lastIndexOf(" ");
  if (space > 0) return { individualName: { givenName: name.slice(0, space), surName: name.slice(space + 1) }, ...orcid };
  return { individualName: { surName: name }, ...orcid };
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim();
}

function schemaRef(schemaKey: string, version: string): string {
  return `${schemaKey}@${version}`;
}

function compareRecords(left: ResearchPackageRecord, right: ResearchPackageRecord): number {
  if (left.recordId !== right.recordId) return left.recordId < right.recordId ? -1 : 1;
  return left.versionId < right.versionId ? -1 : left.versionId > right.versionId ? 1 : 0;
}

type PathToken = string | number;
/** A collapsed withheld path ("canonical.fields.profile.data.*", "measurements[*].remarks") names a group, not one value. */
const WILDCARD = "\u0000*";

/** "canonical.fields.event.privateLocationObjectRef", "measurements[0].remarks" -> tokens, or null when the text is not a path. */
function pathTokens(path: string): PathToken[] | null {
  const tokens = path.match(/[^.[\]]+|\[\d+\]|\[\*\]/gu);
  if (tokens === null || tokens.join("") !== path.replace(/[.]/gu, "")) return null;
  return tokens.map((token) => (token === "[*]" || token === "*" ? WILDCARD : token.startsWith("[") ? Number(token.slice(1, -1)) : token));
}

/** The value the path leads to in the given data, or undefined. Own properties only. */
function pathValue(root: unknown, tokens: readonly PathToken[]): unknown {
  let cursor: unknown = root;
  for (const token of tokens) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    if (typeof token === "number") {
      if (!Array.isArray(cursor) || token >= cursor.length) return undefined;
      cursor = cursor[token];
    } else {
      if (Array.isArray(cursor) || !Object.hasOwn(cursor, token)) return undefined;
      cursor = (cursor as Record<string, unknown>)[token];
    }
  }
  return cursor;
}

/** A path listed as withheld may still hold TEXT whose place was replaced by the redaction marker: that is a redaction in place, not a leftover. */
function isRedactedInPlace(value: unknown, key?: PathToken): boolean {
  if (typeof value !== "string") return false;
  // A visibility-named key stays, rewritten to the state it was read as ("Restricted (-33.8, 151.3)" -> "restricted").
  if (typeof key === "string" && isLocationVisibilityKey(key) && value === visibilityStateText(value)) return true;
  return value.includes(LOCATION_WITHHELD_TEXT) && !containsLocationText(value);
}

const WITHHELD_ROOTS = new Set(["canonical", "extension", "measurements", "projectSchema", "title", "eventDate", "recordedBy", "landingPage", "rightsHolder"]);
/** Flat text fields of a record that are written to records.csv and the Darwin Core Archive. */
const FLAT_TEXT_FIELDS = ["title", "eventDate", "recordedBy", "landingPage", "rightsHolder"] as const;

/**
 * A package says what it left out ("withheld"). That statement is checked here, not trusted:
 * a path listed as withheld must not lead to a value in what the package will write, and the
 * flat location columns of records.csv must agree with the record's own location visibility.
 */
function withholdingProblems(record: ResearchPackageRecord, label: string, visibility: LocationVisibilityOptions & Readonly<{ privateKeys?: readonly string[] }>): string[] {
  const problems: string[] = [];
  const data = { canonical: record.canonical, extension: record.extension, measurements: record.measurements, projectSchema: record.projectSchema, title: record.title, eventDate: record.eventDate, recordedBy: record.recordedBy, landingPage: record.landingPage, rightsHolder: record.rightsHolder };
  for (const path of record.withheld ?? []) {
    if (typeof path !== "string") continue; // reported by the length/shape check
    const tokens = pathTokens(path);
    if (tokens === null || typeof tokens[0] !== "string" || !WITHHELD_ROOTS.has(tokens[0])) {
      problems.push(`${label}: withheld path ${JSON.stringify(path.slice(0, 80))} must start with canonical, extension, measurements, projectSchema or a flat text field`);
    } else if (tokens.includes(WILDCARD)) {
      continue; // a grouped entry says that values under it were left out; the siblings that remain were checked by the screens below
    } else if (pathValue(data, tokens) !== undefined && !isRedactedInPlace(pathValue(data, tokens), tokens[tokens.length - 1])) {
      problems.push(`${label}: ${path} is listed as withheld but its value is still in the record; remove it before building the package`);
    }
  }
  // Location. A place is published only when the record's own visibility is exactly "public" or "generalized"
  // (or missing, with missingVisibility "public"). Anything else, an unknown value included, means records.jsonl and
  // records.csv must hold no place and no private reference: the builder checks, it does not trust.
  const fields = (record.canonical as { fields?: { event?: unknown } }).fields;
  const event = fields !== null && typeof fields === "object" ? fields.event : undefined;
  const eventObject = event !== null && typeof event === "object" && !Array.isArray(event) ? (event as Record<string, unknown>) : undefined;
  // The flag is read anywhere in the canonical record and the extension (groups, nested objects, repeat entries); the strictest wins.
  const state = locationStateOf({ canonical: record.canonical, extension: record.extension }, visibility);
  const stateText = state.state === "missing" ? "not stated" : `"${state.state}"`;
  if (!state.publishes) {
    // The system's own ids are exempt from the text screen; every other canonical string, a contributor's sourceId included, is screened.
    const canonicalScan = Object.fromEntries(Object.entries(record.canonical).filter(([key]) => !SYSTEM_IDS.has(key)));
    const places = [...locationValuePaths(canonicalScan, "canonical"), ...privateLocationPaths(record.canonical, "canonical", visibility.privateKeys ?? []), ...locationValuePaths(record.extension, "extension"), ...locationValuePaths(record.measurements, "measurements")];
    for (const flatName of FLAT_TEXT_FIELDS) {
      const text = record[flatName];
      if (typeof text === "string" && containsLocationText(text)) places.unshift(flatName);
    }
    // A visibility-named key holding anything but an exact state (a cell like "restricted: -33.8, 151.3") is reported on its own, so
    // the cap below cannot hide it.
    const isVisibilityCell = (path: string): boolean => isLocationVisibilityKey(path.replace(/\[\d+\]$/u, "").split(".").pop() ?? "");
    const cells = [...new Set(places)].filter(isVisibilityCell);
    for (const path of cells.slice(0, 3)) problems.push(`${label}: ${path} holds more than a visibility state; run withholdCanonicalRecordVersion (or withholdPackageRecord) first`);
    for (const path of [...new Set(places)].filter((item) => !isVisibilityCell(item)).slice(0, 5)) {
      problems.push(`${label}: ${path} is still in the record but its location visibility is ${stateText}; run withholdCanonicalRecordVersion first${state.state === "missing" ? " (or state a visibility, or build with missingVisibility: \"public\")" : ""}`);
    }
    if (places.length - cells.length > 5) problems.push(`${label}: ${places.length - 5} more places are still in the record`);
  }
  const flat: [string, unknown, unknown][] = [
    ["decimalLatitude", record.decimalLatitude, eventObject?.decimalLatitude],
    ["decimalLongitude", record.decimalLongitude, eventObject?.decimalLongitude],
    ["coordinateUncertaintyInMeters", record.coordinateUncertaintyInMeters, eventObject?.coordinateUncertaintyM],
  ];
  for (const [name, value, canonicalValue] of flat) {
    if (value === undefined) continue;
    if (!state.publishes) problems.push(`${label}: ${name} is set but the record's location visibility is ${stateText}; records.csv must not carry it`);
    else if (eventObject !== undefined && value !== canonicalValue) problems.push(`${label}: ${name} differs from the record's own value; records.csv must agree with the record (generalised coordinates are the ones in the record)`);
  }
  if (eventObject !== undefined && record.eventDate !== undefined && eventObject.eventDate !== undefined && record.eventDate !== eventObject.eventDate) problems.push(`${label}: eventDate differs from the record's own value`);
  return problems;
}

/**
 * One call that makes a record safe to hand to buildResearchPackage when its location is not published: the canonical record
 * (see withholdCanonicalRecordVersion), the flat coordinates, the flat text fields (title, eventDate, recordedBy, landingPage,
 * rightsHolder), the measurement rows and the project extension. The cleaned record is always the one returned: there is no
 * "nothing changed, keep the original" shortcut, because rewriting a visibility cell (for example "restricted: -33.8, 151.3" to
 * "restricted") is a change that must reach the output. The withheld list is merged with the record's own and grouped when it
 * would pass 500 entries. Published locations ("public", "generalized") keep their coordinates; the text is still screened for
 * a place the visibility flag does not cover only when the location is not published.
 */
export function withholdPackageRecord(record: ResearchPackageRecord, options: WithholdingOptions = {}): ResearchPackageRecord {
  assertLocationOptions(options);
  const canonical = withholdCanonicalRecordVersion(record.canonical, options);
  const withheld: string[] = [...(record.withheld ?? []), ...canonical.withheld];
  const state = locationStateOf({ canonical: record.canonical, extension: record.extension }, options);
  let next: { -readonly [K in keyof ResearchPackageRecord]: ResearchPackageRecord[K] } = { ...record, canonical: canonical.value };
  if (!state.publishes) {
    for (const key of ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters"] as const) {
      if (next[key] !== undefined) { withheld.push(key); delete next[key]; }
    }
    for (const key of FLAT_TEXT_FIELDS) {
      const text = next[key];
      if (typeof text === "string" && containsLocationText(text)) { withheld.push(key); next = { ...next, [key]: redactLocationText(text) }; }
    }
    // The flat eventDate must agree with the record, so it takes the record's own cleaned value when the record has one.
    const cleanedEvent = (canonical.value.fields as { event?: { eventDate?: unknown } } | undefined)?.event;
    if (next.eventDate !== undefined && typeof cleanedEvent?.eventDate === "string") {
      next = { ...next, eventDate: cleanedEvent.eventDate };
      if (!cleanedEvent.eventDate.includes(LOCATION_WITHHELD_TEXT)) { const at = withheld.indexOf("eventDate"); if (at >= 0) withheld.splice(at, 1); } // the record's own value has no place in it
    }
    if (next.measurements !== undefined) next = { ...next, measurements: withoutLocationValues(next.measurements, "measurements", withheld) as ResearchPackageRecord["measurements"] & object };
    if (next.extension !== undefined) {
      next = { ...next, extension: withoutLocationValues(next.extension, "extension", withheld) as Record<string, unknown> };
    }
  }
  const list = collapseWithheld(withheld);
  if (list.length > 0) next = { ...next, withheld: list };
  return next;
}

function validateInput(input: ResearchPackageInput): Map<string, ProjectSchemaDocument> {
  const problems: string[] = [];
  try { assertLocationOptions(input); } catch (error) { problems.push((error as Error).message); }
  if (!SAFE_ID.test(input.packageId)) problems.push("packageId must be 1 to 128 safe identifier characters");
  if (input.title.trim() === "") problems.push("title is required");
  if (typeof input.createdAt !== "string" || !isIsoDateTime(input.createdAt)) problems.push("createdAt must be an ISO 8601 date-time with a time zone and a real calendar day");
  if (input.creator.name.trim() === "") problems.push("creator.name is required");
  if (input.creator.orcid !== undefined && (normalizeOrcid(input.creator.orcid) === null || !input.creator.orcid.startsWith("https://orcid.org/"))) problems.push("creator.orcid must be an https://orcid.org/ iD with a correct check digit");
  if (input.records.length > RESEARCH_PACKAGE_LIMITS.records) problems.push("too many records for one package");
  if (input.schemas.length > RESEARCH_PACKAGE_LIMITS.schemas) problems.push("too many schemas for one package");
  if ((input.media ?? []).length > RESEARCH_PACKAGE_LIMITS.media) problems.push("too many media entries for one package");
  if (input.rights !== undefined && input.rights !== "package-licence" && input.rights !== "source-statements") problems.push("rights must be package-licence or source-statements");
  if (input.licence !== undefined) problems.push(...licenceProblems(input.licence));
  if ((input.notes ?? []).length > 50) problems.push("at most 50 README notes");
  const schemas = new Map<string, ProjectSchemaDocument>();
  for (const schema of input.schemas) {
    const errors = validateProjectSchemaDocument(schema).filter((item) => item.severity === "error");
    if (errors.length > 0) problems.push(`schema ${schema.schemaKey}@${schema.version}: ${errors[0].message}`);
    const ref = schemaRef(schema.schemaKey, schema.version);
    if (schemas.has(ref)) problems.push(`schema ${ref} is listed twice`);
    schemas.set(ref, schema);
  }
  const seenVersions = new Set<string>();
  for (const record of input.records) {
    const label = `record ${record.recordId}/${record.versionId}`;
    if (!SAFE_ID.test(record.recordId) || !SAFE_ID.test(record.versionId)) problems.push(`${label}: ids must be safe identifier characters`);
    const key = `${record.recordId}\u0000${record.versionId}`;
    if (seenVersions.has(key)) problems.push(`${label}: listed twice`);
    seenVersions.add(key);
    if (record.decimalLatitude !== undefined && !(record.decimalLatitude >= -90 && record.decimalLatitude <= 90)) problems.push(`${label}: latitude out of range`);
    if (record.decimalLongitude !== undefined && !(record.decimalLongitude >= -180 && record.decimalLongitude <= 180)) problems.push(`${label}: longitude out of range`);
    if (record.projectSchema) {
      const schema = schemas.get(schemaRef(record.projectSchema.schemaKey, record.projectSchema.version));
      if (!schema) problems.push(`${label}: its project schema is not included in the package`);
      else {
        if (schema.extends.profileId !== record.profileId || schema.extends.profileVersion !== record.profileVersion) problems.push(`${label}: its project schema extends a different profile version`);
        // A value withheld from this copy is not missing from the record, so
        // it cannot fail the record's required-field check here.
        const withheldKeys = new Set((record.withheld ?? []).filter((path) => path.startsWith("extension.")).map((path) => path.slice("extension.".length)));
        const errors = validateProjectSchemaData(schema, record.extension ?? {}, "draft")
          .filter((item) => item.severity === "error" && !(item.code === "required_field" && item.field !== undefined && withheldKeys.has(item.field)));
        if (errors.length > 0) problems.push(`${label}: ${errors[0].field ?? ""} ${errors[0].message}`.trim());
      }
    } else if (record.extension !== undefined && Object.keys(record.extension).length > 0) {
      problems.push(`${label}: has project fields but names no project schema`);
    }
    problems.push(...withholdingProblems(record, label, { ...(input.missingVisibility === "public" ? { missingVisibility: "public" as const } : {}), ...(input.privateKeys === undefined ? {} : { privateKeys: input.privateKeys }) }));
    if (record.withheld !== undefined && (record.withheld.length > MAX_WITHHELD || !record.withheld.every((path) => typeof path === "string" && WITHHELD_PATH.test(path)))) {
      problems.push(`${label}: withheld must list at most ${MAX_WITHHELD} value paths`);
    }
    if (record.measurements) {
      const errors = validateMeasurementRows(record.measurements).filter((item) => item.severity === "error");
      if (errors.length > 0) problems.push(`${label}: measurement ${errors[0].row ?? ""} ${errors[0].message}`.trim());
    }
  }
  for (const media of input.media ?? []) {
    if (!SHA256.test(media.sha256)) problems.push(`media ${media.objectKey}: sha256 must be 64 lower-case hex characters`);
    if (!Number.isSafeInteger(media.bytes) || media.bytes < 0) problems.push(`media ${media.objectKey}: bytes must be a whole number`);
  }
  if (problems.length > 0) throw new ResearchPackageError(problems);
  return schemas;
}

const FRICTIONLESS_TYPES: Readonly<Record<ProjectFieldDatatype, string>> = {
  string: "string",
  integer: "integer",
  number: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  uri: "string",
  enum: "string",
};

const RECORD_COLUMNS = [
  "recordId", "versionId", "profileId", "profileVersion", "title", "eventDate",
  "decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters", "recordedBy",
  "licence", "projectSchemaKey", "projectSchemaVersion", "landingPage", "informationWithheld",
] as const;

const DWC = "http://rs.tdwg.org/dwc/terms/";
const RECORD_FIELDS: readonly Readonly<Record<string, string>>[] = [
  { name: "recordId", type: "string", description: "Stable record identifier." },
  { name: "versionId", type: "string", description: "Immutable record-version identifier." },
  { name: "profileId", type: "string", description: "Application profile the version was validated against." },
  { name: "profileVersion", type: "string" },
  { name: "title", type: "string" },
  { name: "eventDate", type: "string", rdfType: `${DWC}eventDate`, description: "Date or ISO 8601 interval as recorded." },
  { name: "decimalLatitude", type: "number", rdfType: `${DWC}decimalLatitude` },
  { name: "decimalLongitude", type: "number", rdfType: `${DWC}decimalLongitude` },
  { name: "coordinateUncertaintyInMeters", type: "number", rdfType: `${DWC}coordinateUncertaintyInMeters` },
  { name: "recordedBy", type: "string", rdfType: `${DWC}recordedBy` },
  { name: "licence", type: "string", rdfType: "http://purl.org/dc/terms/license" },
  { name: "projectSchemaKey", type: "string" },
  { name: "projectSchemaVersion", type: "string" },
  { name: "landingPage", type: "string", format: "uri" },
  { name: "informationWithheld", type: "string", rdfType: `${DWC}informationWithheld`, description: "Values left out of this export copy, if any." },
];

function emofRdfType(column: (typeof EMOF_COLUMNS)[number]): { rdfType?: string } {
  const term = emofColumnTerm(column);
  return term === undefined ? {} : { rdfType: term };
}

const MEDIA_COLUMNS =["recordId", "objectKey", "mediaType", "bytes", "sha256", "licence", "rightsHolder", "included"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Builds the optional Darwin Core Archive from the package's own inputs. Each
 * record's canonical JSON must be its record-version document; the
 * archive reads the structured fields from it, so nothing is read twice.
 */
function darwinCoreArchiveForPackage(input: ResearchPackageInput, records: readonly ResearchPackageRecord[]): DarwinCoreArchive {
  const problems: string[] = [];
  const packageLicence = resolveLicence(input.licence);
  const dwcRecords: DarwinCoreArchiveRecord[] = [];
  for (const record of records) {
    const label = `dwca: record ${record.recordId}/${record.versionId}`;
    const canonical = record.canonical;
    const fields = canonical.fields;
    if (canonical.schema !== RECORD_DOCUMENT_SCHEMA || !isPlainRecord(fields)
      || canonical.recordId !== record.recordId || canonical.versionId !== record.versionId) {
      problems.push(`${label}: canonical JSON is not this record's ${RECORD_DOCUMENT_SCHEMA} document`);
      continue;
    }
    const profile = fields.profile;
    if (!isPlainRecord(profile) || profile.profileId !== record.profileId || profile.profileVersion !== record.profileVersion) {
      problems.push(`${label}: the canonical profile does not match the record's profile`);
      continue;
    }
    if (record.licence !== packageLicence.uri) {
      problems.push(`${label}: licence must be ${packageLicence.shortName}, the licence the archive's EML declares`);
      continue;
    }
    const landingPage = record.landingPage ?? (typeof canonical.canonicalUri === "string" ? canonical.canonicalUri : undefined);
    dwcRecords.push({
      recordId: record.recordId,
      versionId: record.versionId,
      // Shape is checked by buildDarwinCoreArchive, which validates the fields at the chosen readiness.
      fields: fields as unknown as RecordFields,
      ...(landingPage === undefined ? {} : { landingPage }),
      ...(record.rightsHolder === undefined ? {} : { rightsHolder: record.rightsHolder }),
      ...(record.measurements === undefined ? {} : { measurements: record.measurements }),
    });
  }
  let archive: DarwinCoreArchive | undefined;
  if (dwcRecords.length > 0 || problems.length === 0) {
    const options = input.darwinCore ?? {};
    const creator: EmlParty = options.creator ?? emlCreator(input.creator);
    try {
      archive = buildDarwinCoreArchive({
        datasetId: options.datasetId ?? `urn:clio:research-package:${input.packageId}`,
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        createdAt: input.createdAt,
        licence: packageLicence,
        ...(options.language === undefined ? {} : { language: options.language }),
        creator,
        ...(options.metadataProvider === undefined ? {} : { metadataProvider: options.metadataProvider }),
        ...(options.contact === undefined ? {} : { contact: options.contact }),
        ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
        records: dwcRecords,
        ...(input.spreadsheetSafe === true ? { spreadsheetSafe: true } : {}),
        ...(input.missingVisibility === undefined ? {} : { missingVisibility: input.missingVisibility }),
        media: (input.media ?? []).map((item) => ({
          recordId: item.recordId,
          mediaType: item.mediaType,
          licence: item.licence,
          rightsHolder: item.rightsHolder,
          ...(item.accessUri === undefined ? {} : { accessUri: item.accessUri }),
        })),
      });
    } catch (error) {
      if (!(error instanceof DarwinCoreArchiveError)) throw error;
      problems.push(...error.problems.map((problem) => `dwca: ${problem}`));
    }
  }
  if (problems.length > 0 || archive === undefined) throw new ResearchPackageError(problems);
  return archive;
}

const DWCA_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "meta.xml": "Darwin Core Archive descriptor: maps every column of the dwca tables to a term IRI.",
  "eml.xml": "Dataset metadata in EML 2.1.1, following the GBIF Metadata Profile.",
};

function readme(input: ResearchPackageInput, schemaCount: number, dwca?: DarwinCoreArchive): string {
  const sourceRights = input.rights === "source-statements";
  const licence = resolveLicence(input.licence);
  const withheldRecords = input.records.filter((record) => (record.withheld ?? []).length > 0).length;
  const notes = (input.notes ?? []).map((note) => `- ${singleLine(note)}`);
  return [
    `${singleLine(input.title)}`,
    "",
    `Package ${input.packageId}, made ${input.createdAt} with ${RESEARCH_PACKAGE_FORMAT}.`,
    "",
    "How to read this package",
    withheldRecords === 0
      ? "- records.jsonl is the complete, lossless copy: one record version per line."
      : "- records.jsonl is a lossless copy of what this export includes: one record version per line, less the values each record lists in withheld.",
    "- records.csv, measurements.csv and extensions/*.csv are flat tables of the same data for spreadsheets and scripts.",
    "- measurements.csv uses Extended Measurement or Fact (eMoF) column names. Type and unit columns ending in ID hold the term IRIs.",
    `- schemas/ holds the exact project schema versions used (${schemaCount}), as project-schema documents (.clio.json) and as JSON Schema 2020-12 (.schema.json).`,
    "- datapackage.json (Frictionless Data Package) and ro-crate-metadata.json (RO-Crate) describe every file for other tools.",
    "- media-manifest.csv lists media objects with their SHA-256 digests. Media bytes are not included in this package.",
    ...(dwca ? [
      `- dwca/ is an unzipped Darwin Core Archive (${dwca.core === "occurrence" ? "Occurrence" : "Event"} core): meta.xml, eml.xml and tab-delimited tables. Zip its contents to check them with a Darwin Core Archive validator. Sensitive and restricted fields are left out; informationWithheld says what. It has not been validated, registered or published by this export.`,
    ] : []),
    "",
    "Checking it",
    "- The folder above data/ is a BagIt bag. manifest-sha256.txt lists a SHA-256 digest for every file in data/; any BagIt tool can verify it.",
    "",
    "Rights",
    ...(sourceRights ? [
      "- Some records here are staged project data, not records under the package licence. Each keeps the rights statement supplied with it (the licence column, empty when none was supplied). This export does not assign a licence.",
      `- Records stated to carry the package licence are licensed ${licence.shortName} (${licence.uri}).`,
    ] : [
      `- Record metadata is licensed ${licence.shortName} (${licence.uri}) unless a record says otherwise.`,
    ]),
    "- Media and third-party material keep the licence shown for each item.",
    "",
    ...(withheldRecords > 0 ? [
      "What was withheld",
      `- ${withheldRecords} record${withheldRecords === 1 ? " has" : "s have"} values withheld: restricted fields and private location references are left out of records the person exporting does not own. Each such record's informationWithheld (records.csv) and withheld (records.jsonl) say which. Sensitive fields are kept.`,
      "",
    ] : []),
    ...(notes.length > 0 ? ["Notes from this export", ...notes, ""] : []),
    input.spreadsheetSafe === true
      ? "Spreadsheet note: a text cell that begins with =, +, - or @ has a single quote in front of it so a spreadsheet shows it as text. Remove one leading quote to get the recorded value. records.jsonl is unchanged."
      : "Spreadsheet note: CSV cells are written exactly as recorded. A spreadsheet may treat a cell beginning with =, +, - or @ as a formula; open the files as text if that matters, or build the package with spreadsheetSafe.",
    "",
    "This package was built by the Clio research kit. It is not a statement that any repository has accepted, preserved or published it.",
    "",
  ].join("\n");
}

export async function buildResearchPackage(input: ResearchPackageInput): Promise<ResearchPackage> {
  const schemas = validateInput(input);
  const records = [...input.records].sort(compareRecords);
  const dwca = input.includeDarwinCoreArchive === true ? darwinCoreArchiveForPackage(input, records) : undefined;
  const csvOptions = { spreadsheetSafe: input.spreadsheetSafe === true };
  const payload: { path: string; text: string; mediatype: string; title: string }[] = [];
  const add = (path: string, text: string, mediatype: string, title: string) => payload.push({ path, text, mediatype, title });

  add("records.jsonl", records.map((record) => stableStringify({
    recordId: record.recordId,
    versionId: record.versionId,
    profile: { id: record.profileId, version: record.profileVersion },
    projectSchema: record.projectSchema,
    canonical: record.canonical,
    extension: record.extension,
    measurements: record.measurements,
    ...((record.withheld ?? []).length > 0 ? { withheld: record.withheld, informationWithheld: informationWithheldText(record.withheld) } : {}),
  })).join("\n") + (records.length > 0 ? "\n" : ""), "application/x-ndjson", "Record versions (lossless)");

  add("records.csv", toCsv(RECORD_COLUMNS, records.map((record) => ({
    ...record,
    projectSchemaKey: record.projectSchema?.schemaKey,
    projectSchemaVersion: record.projectSchema?.version,
    informationWithheld: informationWithheldText(record.withheld),
  })), csvOptions), "text/csv", "Record versions (flat)");

  const measurementColumns = ["versionId", ...EMOF_COLUMNS] as const;
  add("measurements.csv", toCsv(measurementColumns, records.flatMap((record) => (record.measurements ?? [])
    .map((row) => ({ versionId: record.versionId, ...toEmofRow(row, row.attachedTo?.id ?? record.recordId) }))), csvOptions), "text/csv", "Measurements (eMoF columns)");

  const orderedSchemas = [...schemas.values()].sort((left, right) => schemaRef(left.schemaKey, left.version) < schemaRef(right.schemaKey, right.version) ? -1 : 1);
  const extensionResources: { path: string; schema: ProjectSchemaDocument }[] = [];
  for (const schema of orderedSchemas) {
    const ref = schemaRef(schema.schemaKey, schema.version);
    const base = `schemas/${schema.schemaKey}/${schema.version}`;
    add(`${base}.clio.json`, `${canonicalProjectSchema(schema)}\n`, "application/json", `Project schema ${ref} (project-schema document)`);
    add(`${base}.schema.json`, prettyJson(toJsonSchema(schema, { id: `${base}.schema.json`, readiness: "research_ready" })), "application/schema+json", `Project schema ${ref} (JSON Schema 2020-12)`);
    const rows = records.filter((record) => record.projectSchema && schemaRef(record.projectSchema.schemaKey, record.projectSchema.version) === ref);
    if (rows.length === 0) continue;
    const path = `extensions/${schema.schemaKey}-${schema.version}.csv`;
    add(path, toCsv(["recordId", "versionId", ...schema.fields.map((field) => field.key)], rows.map((record) => ({ ...record.extension, recordId: record.recordId, versionId: record.versionId })), csvOptions), "text/csv", `Project fields ${ref}`);
    extensionResources.push({ path, schema });
  }

  const media = [...(input.media ?? [])].sort((left, right) => (left.recordId + left.objectKey < right.recordId + right.objectKey ? -1 : 1));
  add("media-manifest.csv", toCsv(MEDIA_COLUMNS, media.map((item) => ({ ...item, included: "false" })), csvOptions), "text/csv", "Media manifest");
  for (const file of dwca?.files ?? []) add(`dwca/${file.path}`, file.text, file.mediatype, file.title);
  add("README.txt", readme(input, orderedSchemas.length, dwca), "text/plain", "Reading guide");

  const packageLicence = resolveLicence(input.licence);
  const licence = { name: packageLicence.spdxIdentifier, path: packageLicence.uri, title: packageLicence.name };
  const resourceName = (path: string) => path.toLowerCase().replace(/\.(?:csv|tsv|json|jsonl|xml|txt)$/u, "").replace(/[^a-z0-9._-]+/gu, "-");
  const dataPackage = {
    $schema: "https://datapackage.org/profiles/2.0/datapackage.json",
    name: resourceName(input.packageId),
    id: input.packageId,
    title: input.title,
    ...(input.description ? { description: input.description } : {}),
    created: input.createdAt,
    contributors: [{ title: input.creator.name, roles: ["creator"], ...(input.creator.orcid ? { path: input.creator.orcid } : {}) }],
    ...(input.rights === "source-statements" ? {} : { licenses: [licence] }),
    resources: [
      { name: "records", path: "records.csv", format: "csv", mediatype: "text/csv", encoding: "utf-8", schema: { fields: RECORD_FIELDS, primaryKey: ["recordId", "versionId"] } },
      {
        name: "measurements", path: "measurements.csv", format: "csv", mediatype: "text/csv", encoding: "utf-8",
        schema: { fields: [{ name: "versionId", type: "string" }, ...EMOF_COLUMNS.map((column) => ({ name: column, type: "string", ...emofRdfType(column) }))] },
      },
      ...extensionResources.map(({ path, schema }) => ({
        name: resourceName(path), path, format: "csv", mediatype: "text/csv", encoding: "utf-8",
        schema: {
          fields: [
            { name: "recordId", type: "string" },
            { name: "versionId", type: "string" },
            ...schema.fields.map((field) => ({
              name: field.key,
              title: field.label,
              type: FRICTIONLESS_TYPES[field.datatype],
              ...(field.termIri ? { rdfType: field.termIri } : {}),
              ...(field.datatype === "enum" ? { constraints: { enum: (field.vocabulary ?? []).map((item) => item.value) } } : {}),
            })),
          ],
          primaryKey: ["recordId", "versionId"],
        },
      })),
      { name: "media-manifest", path: "media-manifest.csv", format: "csv", mediatype: "text/csv", encoding: "utf-8" },
      ...(dwca?.files ?? []).map((file) => ({
        name: resourceName(`dwca/${file.path}`),
        path: `dwca/${file.path}`,
        format: file.path.endsWith(".xml") ? "xml" : "tsv",
        mediatype: file.mediatype,
        encoding: "utf-8",
        description: DWCA_DESCRIPTIONS[file.path] ?? "Tab-delimited Darwin Core table without quoting; dwca/meta.xml describes its columns.",
      })),
    ],
  };
  const dataPackageText = prettyJson(dataPackage);

  const creatorId = input.creator.orcid ?? "#creator";
  const fileEntities = [...payload.map((file) => ({ path: file.path, mediatype: file.mediatype, title: file.title, size: encoder.encode(file.text).byteLength })),
    { path: "datapackage.json", mediatype: "application/json", title: "Frictionless Data Package descriptor", size: encoder.encode(dataPackageText).byteLength }]
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const crate = {
    "@context": "https://w3id.org/ro/crate/1.2/context",
    "@graph": [
      { "@id": "ro-crate-metadata.json", "@type": "CreativeWork", conformsTo: { "@id": "https://w3id.org/ro/crate/1.2" }, about: { "@id": "./" } },
      {
        "@id": "./",
        "@type": "Dataset",
        identifier: input.packageId,
        name: input.title,
        description: input.description ?? input.title,
        datePublished: input.createdAt,
        ...(input.rights === "source-statements" ? {} : { license: { "@id": packageLicence.uri } }),
        author: { "@id": creatorId },
        hasPart: [...(dwca ? [{ "@id": "dwca/" }] : []), ...fileEntities.map((file) => ({ "@id": file.path }))],
      },
      ...(dwca ? [{
        "@id": "dwca/",
        "@type": "Dataset",
        name: "Darwin Core Archive (unzipped)",
        description: "meta.xml, eml.xml and tab-delimited Darwin Core tables, ready to zip for a validator. This export has not validated, registered or published them.",
        hasPart: dwca.files.map((file) => ({ "@id": `dwca/${file.path}` })),
      }] : []),
      ...fileEntities.map((file) => ({ "@id": file.path, "@type": "File", name: file.title, encodingFormat: file.mediatype, contentSize: String(file.size) })),
      { "@id": creatorId, "@type": "Person", name: input.creator.name },
      ...(input.rights === "source-statements" ? [] : [{ "@id": packageLicence.uri, "@type": "CreativeWork", name: packageLicence.name, identifier: packageLicence.spdxIdentifier }]),
      { "@id": "#export", "@type": "CreateAction", name: "Research package export", endTime: input.createdAt, instrument: { "@id": "#clio-builder" }, result: { "@id": "./" }, agent: { "@id": creatorId } },
      { "@id": "#clio-builder", "@type": "SoftwareApplication", name: "Clio research kit package builder", url: input.softwareUrl ?? RESEARCH_KIT_URL, version: RESEARCH_PACKAGE_FORMAT },
    ],
  };

  const dataFiles: PackageFile[] = [
    ...payload.map((file) => ({ path: `data/${file.path}`, bytes: encoder.encode(file.text) })),
    { path: "data/datapackage.json", bytes: encoder.encode(dataPackageText) },
    { path: "data/ro-crate-metadata.json", bytes: encoder.encode(prettyJson(crate)) },
  ].sort((left, right) => (left.path < right.path ? -1 : 1));

  const manifestLines: string[] = [];
  let payloadBytes = 0;
  for (const file of dataFiles) {
    manifestLines.push(`${await sha256Hex(file.bytes)}  ${file.path}`);
    payloadBytes += file.bytes.byteLength;
  }
  const manifest = encoder.encode(`${manifestLines.join("\n")}\n`);
  const bagit = encoder.encode("BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n");
  const bagInfo = encoder.encode([
    `Bag-Software-Agent: Clio research kit package builder (${RESEARCH_PACKAGE_FORMAT})`,
    `Bagging-Date: ${utcDateOf(input.createdAt)}`,
    `External-Identifier: ${input.packageId}`,
    `External-Description: ${singleLine(input.title)}`,
    `Payload-Oxum: ${payloadBytes}.${dataFiles.length}`,
    "",
  ].join("\n"));
  const tagFiles: PackageFile[] = [
    { path: "bag-info.txt", bytes: bagInfo },
    { path: "bagit.txt", bytes: bagit },
    { path: "manifest-sha256.txt", bytes: manifest },
  ];
  const tagLines: string[] = [];
  for (const file of tagFiles) tagLines.push(`${await sha256Hex(file.bytes)}  ${file.path}`);
  const tagManifest = encoder.encode(`${tagLines.join("\n")}\n`);

  return {
    format: RESEARCH_PACKAGE_FORMAT,
    packageId: input.packageId,
    files: [...tagFiles, { path: "tagmanifest-sha256.txt", bytes: tagManifest }, ...dataFiles],
    manifestSha256: await sha256Hex(manifest),
    payloadBytes,
    payloadFiles: dataFiles.length,
  };
}

export type PackageVerification = Readonly<{ valid: boolean; problems: readonly string[] }>;

function parseManifest(text: string, problems: string[], label: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64})\s+(\S.*)$/u.exec(line);
    if (!match) { problems.push(`${label}: malformed line`); continue; }
    const path = match[2];
    if (path.startsWith("/") || path.split("/").includes("..")) { problems.push(`${label}: unsafe path ${path}`); continue; }
    if (entries.has(path)) problems.push(`${label}: ${path} listed twice`);
    entries.set(path, match[1]);
  }
  return entries;
}

/**
 * Re-checks a package from its bytes alone: BagIt declaration, every payload
 * digest, no unlisted or missing payload files, tag-manifest digests and the
 * Payload-Oxum. It proves the files match their own manifests (integrity). It does not prove who
 * made the package: someone who changes a file can recompute the manifests too, and nothing here is signed.
 */
export async function verifyResearchPackage(files: readonly PackageFile[]): Promise<PackageVerification> {
  const problems: string[] = [];
  const byPath = new Map<string, Uint8Array>();
  for (const file of files) {
    if (byPath.has(file.path)) problems.push(`${file.path} appears twice`);
    byPath.set(file.path, file.bytes);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = (path: string): string | undefined => {
    const bytes = byPath.get(path);
    if (!bytes) { problems.push(`${path} is missing`); return undefined; }
    try { return decoder.decode(bytes); } catch { problems.push(`${path} is not UTF-8`); return undefined; }
  };
  const bagit = text("bagit.txt");
  if (bagit !== undefined && !/^BagIt-Version: 1\.0\r?\nTag-File-Character-Encoding: UTF-8\r?\n?$/u.test(bagit)) problems.push("bagit.txt is not a BagIt 1.0 declaration");
  const manifestText = text("manifest-sha256.txt");
  if (manifestText !== undefined) {
    const manifest = parseManifest(manifestText, problems, "manifest-sha256.txt");
    let bytes = 0;
    for (const [path, digest] of manifest) {
      if (!path.startsWith("data/")) { problems.push(`manifest lists ${path} outside data/`); continue; }
      const content = byPath.get(path);
      if (!content) { problems.push(`${path} is listed but missing`); continue; }
      bytes += content.byteLength;
      if (await sha256Hex(content) !== digest) problems.push(`${path} does not match its SHA-256`);
    }
    for (const path of byPath.keys()) {
      if (path.startsWith("data/") && !manifest.has(path)) problems.push(`${path} is not in the manifest`);
    }
    const info = text("bag-info.txt");
    const oxum = info === undefined ? undefined : /^Payload-Oxum: (\d+)\.(\d+)$/mu.exec(info);
    if (info !== undefined && !oxum) problems.push("bag-info.txt has no Payload-Oxum");
    else if (oxum && (Number(oxum[1]) !== bytes || Number(oxum[2]) !== manifest.size)) problems.push("Payload-Oxum does not match the payload");
  }
  const tagText = byPath.has("tagmanifest-sha256.txt") ? text("tagmanifest-sha256.txt") : undefined;
  if (tagText !== undefined) {
    for (const [path, digest] of parseManifest(tagText, problems, "tagmanifest-sha256.txt")) {
      const content = byPath.get(path);
      if (!content) problems.push(`tag file ${path} is missing`);
      else if (await sha256Hex(content) !== digest) problems.push(`tag file ${path} does not match its SHA-256`);
    }
  }
  return { valid: problems.length === 0, problems };
}

/**
 * The bag as one ZIP file. RFC 8493 section 4: a serialised bag must unpack to a single
 * top-level directory, so every file is placed under `<packageId>/`.
 */
export function zipResearchPackage(pkg: ResearchPackage, options: Readonly<{ modifiedAt: string }>): Uint8Array<ArrayBuffer> {
  return createStoredZip(pkg.files.map((file) => ({ name: `${pkg.packageId}/${file.path}`, bytes: file.bytes })), options);
}

/** Reads a ZIP made by zipResearchPackage back to package files. It must hold exactly one top-level directory. */
export function readResearchPackageZip(bytes: Uint8Array): { packageId: string; files: PackageFile[] } {
  const entries = readStoredZip(bytes);
  const roots = new Set(entries.map((entry) => entry.name.split("/")[0]!));
  if (roots.size !== 1 || entries.some((entry) => !entry.name.includes("/"))) {
    throw new ResearchPackageError(["a serialised bag must unpack to exactly one top-level directory (RFC 8493, section 4)"]);
  }
  const [root] = [...roots] as [string];
  return { packageId: root, files: entries.map((entry) => ({ path: entry.name.slice(root.length + 1), bytes: entry.bytes })) };
}
