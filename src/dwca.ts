import { findApplicationProfile, type ApplicationProfile, type FieldSensitivity } from "./application-profiles.ts";
import {
  DARWIN_CORE_BASIS_OF_RECORD,
  DARWIN_CORE_OCCURRENCE_TERMS,
  DCTERMS_NAMESPACE,
  DWC_TERMS_NAMESPACE,
  effectiveFieldVisibility,
  locationDisclosure,
  normalisedEventDate,
  parseEventDateInterval,
  resolveDarwinCoreProfileTerm,
  unwrapProfileAssertion,
} from "./darwin-core.ts";
import { isIsoDateTime, utcDateOf } from "./iso.ts";
import { assertLocationOptions, type LocationVisibilityOptions } from "./location-visibility.ts";
import { spreadsheetSafeText } from "./spreadsheet.ts";
import { normalizeOrcid } from "./orcid.ts";
import { CC_BY_4_0, licenceProblems, resolveLicence, type Licence } from "./licensing.ts";
import { EMOF_COLUMNS, emofColumnTerm, toEmofRow, validateMeasurementRows, type MeasurementRow } from "./measurement-rows.ts";
import {
  recordReadinessLevels,
  validateRecordFields,
  type RecordReadiness,
  type RecordFields,
} from "./record-fields.ts";

/**
 * Builds the files of an unzipped Darwin Core Archive (DwC-A):
 *
 *   meta.xml                       Darwin Core text guide descriptor
 *   eml.xml                        dataset metadata, GBIF Metadata Profile (EML 2.1.1)
 *   occurrence.txt | event.txt     the core table
 *   occurrence.txt                 Occurrence extension (Event core only)
 *   extendedmeasurementorfact.txt  OBIS eMoF extension, from measurement rows
 *   multimedia.txt                 GBIF Simple Multimedia extension, from public media
 *
 * Occurrence-type profiles use an Occurrence core. Structured surveys and
 * pollen field samples use an Event core (the GBIF sampling-event pattern).
 * Tables are tab-delimited UTF-8 with a header row and no quoting.
 *
 * Profile fields whose sensitivity (or assertion visibility) is sensitive or
 * restricted are not written; the record's informationWithheld says what was
 * left out. Restricted locations never carry coordinates. This filter covers
 * the profile fields only: the event envelope (fieldNumber, habitat,
 * countryCode, locality text the caller supplied as such) and measurement rows
 * are written as given, so keep restricted values out of them. A record that
 * omits locationVisibility has its coordinates withheld unless the caller passes
 * missingVisibility: "public"; only "public" and "generalized" publish a place, and
 * any other value, including not_collected, withholds it. Ineligible input fails closed
 * with a list of problems.
 *
 * This is an export format only. Nothing here validates the archive against
 * an external validator, zips it, registers a dataset or publishes anything.
 */

export const DWCA_FORMAT = "clio.dwca/v1" as const;
export const DWCA_LIMITS = Object.freeze({ records: 10_000, media: 20_000 });
export const DWC_TEXT_NAMESPACE = "http://rs.tdwg.org/dwc/text/" as const;
export const DWCA_ROW_TYPES = Object.freeze({
  occurrence: `${DWC_TERMS_NAMESPACE}Occurrence`,
  event: `${DWC_TERMS_NAMESPACE}Event`,
  measurementOrFact: "http://rs.iobis.org/obis/terms/ExtendedMeasurementOrFact",
  multimedia: "http://rs.gbif.org/terms/1.0/Multimedia",
} as const);

/** GBIF Metadata Profile schema location for EML 2.1.1, as the IPT manual documents it. */
export const GBIF_EML_SCHEMA_LOCATION = "eml://ecoinformatics.org/eml-2.1.1 http://rs.gbif.org/schema/eml-gbif-profile/1.1/eml.xsd" as const;
/** Machine-readable CC BY 4.0 form that the IPT licensing guide gives for EML. */
const EML_CC_BY_40_URL = "http://creativecommons.org/licenses/by/4.0/legalcode";

function intellectualRightsPara(licence: Licence): string {
  if (licence.uri === CC_BY_4_0.uri) {
    return `<para>This work is licensed under a <ulink url="${EML_CC_BY_40_URL}"><citetitle>Creative Commons Attribution (CC-BY) 4.0 License</citetitle></ulink>.</para>`;
  }
  return `<para>This work is licensed under <ulink url="${xmlAttr(licence.uri)}"><citetitle>${xmlText(licence.name)}</citetitle></ulink>.</para>`;
}

export type DarwinCoreArchiveCore = "occurrence" | "event";
type ProfileShape = "occurrence" | "event-with-occurrence" | "event";

/** Profiles that can be expressed in a Darwin Core Archive, and how. */
export const DWCA_PROFILE_SHAPES: Readonly<Record<string, ProfileShape>> = Object.freeze({
  "clio.profile.biological-occurrence": "occurrence",
  "clio.profile.pollen-reference-slide": "occurrence",
  "clio.profile.structured-survey": "event-with-occurrence",
  "clio.profile.pollen-field-aerobiological-palaeo-sample": "event",
});

export type EmlParty = Readonly<{
  individualName?: Readonly<{ givenName?: string; surName: string }>;
  organizationName?: string;
  positionName?: string;
  email?: string;
  onlineUrl?: string;
  /** An https://orcid.org/ iD; written as an EML userId. */
  orcid?: string;
}>;

export type DarwinCoreArchiveRecord = Readonly<{
  recordId: string;
  versionId: string;
  /** The structured fields of the record version (the `fields` of its canonical document). */
  fields: RecordFields;
  /** Public landing URI of the record. When given it is the occurrenceID. */
  landingPage?: string;
  /** Person or organisation holding rights in the record; defaults to the authors' literal names. */
  rightsHolder?: string;
  measurements?: readonly MeasurementRow[];
}>;

export type DarwinCoreArchiveMedia = Readonly<{
  recordId: string;
  mediaType: string;
  licence: string;
  rightsHolder: string;
  /** Public https URL of the media file. Media without one is left out of multimedia.txt. */
  accessUri?: string;
  title?: string;
}>;

export type DarwinCoreArchiveInput = Readonly<{
  /** Stable dataset identifier, also used as the EML packageId. */
  datasetId: string;
  title: string;
  description?: string;
  /** ISO date-time of the export; the date part is the EML pubDate. Passed in so output is deterministic. */
  createdAt: string;
  /** ISO 639-2 code of the metadata language. Default "eng". */
  language?: string;
  /** The `system` attribute of the EML root: the software or host that issued the identifier. Default "research-kit". */
  system?: string;
  /**
   * Put a single quote in front of any table cell that starts with =, +, - or @ (or a tab or CR), so a
   * spreadsheet shows it as text. Off by default. Numbers, ids and the meta.xml column positions are unchanged.
   */
  spreadsheetSafe?: boolean;
  /** The licence of the dataset and of every record. Default: CC BY 4.0. */
  licence?: Licence;
  creator: EmlParty;
  /** Defaults to the creator. */
  metadataProvider?: EmlParty;
  /** Defaults to the creator. */
  contact?: EmlParty;
  /** Profile readiness every record must meet. Default "referenceable". */
  readiness?: RecordReadiness;
  /**
   * What to do with a record that does not state its location visibility. Default: withhold its
   * coordinates (fail closed). Pass "public" to publish them, as earlier versions did.
   */
  missingVisibility?: LocationVisibilityOptions["missingVisibility"];
  records: readonly DarwinCoreArchiveRecord[];
  media?: readonly DarwinCoreArchiveMedia[];
}>;

export type DarwinCoreFindingCode =
  | "invalid_metadata"
  | "no_records"
  | "too_many_records"
  | "invalid_record"
  | "unsupported_profile"
  | "mixed_cores"
  | "record_invalid"
  | "invalid_measurements"
  | "invalid_landing_page"
  | "duplicate_occurrence_id"
  | "missing_event_date"
  | "invalid_event_date"
  | "missing_scientific_name"
  | "invalid_basis_of_record"
  | "missing_rights_holder"
  | "media_skipped";

export type DarwinCoreFinding = Readonly<{
  code: DarwinCoreFindingCode;
  severity: "error" | "warning";
  recordId?: string;
  versionId?: string;
  path?: string;
  message: string;
}>;

export type DarwinCoreEligibility = Readonly<{
  eligible: boolean;
  core: DarwinCoreArchiveCore | null;
  findings: readonly DarwinCoreFinding[];
}>;

export type DarwinCoreArchiveFile = Readonly<{ path: string; text: string; mediatype: string; title: string }>;

export type DarwinCoreArchive = Readonly<{
  format: typeof DWCA_FORMAT;
  core: DarwinCoreArchiveCore;
  /** meta.xml, eml.xml, the core table, then extension tables. Paths are relative to the archive root. */
  files: readonly DarwinCoreArchiveFile[];
  /** Warnings only (for example media left out); errors throw instead. */
  findings: readonly DarwinCoreFinding[];
}>;

export class DarwinCoreArchiveError extends Error {
  readonly problems: readonly string[];
  readonly findings: readonly DarwinCoreFinding[];
  constructor(findings: readonly DarwinCoreFinding[]) {
    const problems = findings.filter((item) => item.severity === "error").map(describeFinding);
    super(`Darwin Core Archive input is not eligible: ${problems.slice(0, 5).join("; ")}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ""}`);
    this.name = "DarwinCoreArchiveError";
    this.problems = problems;
    this.findings = findings;
  }
}

function describeFinding(finding: DarwinCoreFinding): string {
  const label = finding.recordId === undefined ? "" : `record ${finding.recordId}/${finding.versionId ?? ""}: `;
  return `${label}${finding.message}`;
}

// ---------------------------------------------------------------------------
// Columns

type Column = Readonly<{ header: string; term?: string }>;
const dwc = (name: string): Column => ({ header: name, term: `${DWC_TERMS_NAMESPACE}${name}` });
const dc = (name: string): Column => ({ header: name, term: `${DCTERMS_NAMESPACE}${name}` });

const RECORD_LEVEL = [dc("license"), dc("rightsHolder"), dc("references"), dwc("informationWithheld"), dwc("dataGeneralizations"), dwc("dynamicProperties")];
const EVENT_TERMS = [
  dwc("eventDate"), dwc("verbatimEventDate"), dwc("fieldNumber"), dwc("habitat"), dwc("samplingProtocol"),
  dwc("sampleSizeValue"), dwc("sampleSizeUnit"), dwc("samplingEffort"), dwc("eventRemarks"),
  dwc("countryCode"), dwc("locality"), dwc("verbatimLocality"), dwc("decimalLatitude"), dwc("decimalLongitude"),
  dwc("geodeticDatum"), dwc("coordinateUncertaintyInMeters"),
];
const OCCURRENCE_TERMS = [
  dwc("basisOfRecord"), dwc("recordedBy"),
  ...DARWIN_CORE_OCCURRENCE_TERMS.filter((mapping) => mapping.term !== "basisOfRecord").map((mapping) => dwc(mapping.term)),
];
const SAMPLING_ONLY = new Set(["sampleSizeValue", "sampleSizeUnit"]);

const OCCURRENCE_CORE_COLUMNS: readonly Column[] = [
  dwc("occurrenceID"), OCCURRENCE_TERMS[0]!, ...RECORD_LEVEL, ...OCCURRENCE_TERMS.slice(1),
  ...EVENT_TERMS.filter((column) => !SAMPLING_ONLY.has(column.header)),
];
const EVENT_CORE_COLUMNS: readonly Column[] = [dwc("eventID"), ...RECORD_LEVEL, ...EVENT_TERMS];
const OCCURRENCE_EXTENSION_COLUMNS: readonly Column[] = [
  dwc("eventID"), dwc("occurrenceID"), OCCURRENCE_TERMS[0]!, dc("license"), dc("rightsHolder"), dwc("informationWithheld"), ...OCCURRENCE_TERMS.slice(1),
];
const EMOF_TABLE_COLUMNS: readonly Column[] = EMOF_COLUMNS.map((column) => {
  const term = emofColumnTerm(column);
  return term === undefined ? { header: column } : { header: column, term };
});
const MULTIMEDIA_COLUMNS: readonly Column[] = [
  { header: "id" }, dc("type"), dc("format"), dc("identifier"), dc("references"), dc("title"), dc("license"), dc("rightsHolder"),
];

type Row = Record<string, string>;
type Table = { file: string; rowType: string; columns: readonly Column[]; rows: Row[]; title: string };

/** Tabs, line breaks and other control characters would break an unquoted row: each run becomes one space. */
export function dwcaCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "number" ? numberText(value) : String(value);
  return text.replace(/[\u0000-\u001F\u007F]+/gu, " ");
}

function numberText(value: number): string {
  const text = String(value);
  return /e/iu.test(text) ? value.toFixed(12).replace(/\.?0+$/u, "") : text;
}

/** Drops columns that are empty in every row (except the id column), so meta.xml describes only real data. */
function usedColumns(columns: readonly Column[], rows: readonly Row[]): Column[] {
  return columns.filter((column, index) => index === 0 || rows.some((row) => (row[column.header] ?? "") !== ""));
}

function tableText(columns: readonly Column[], rows: readonly Row[], spreadsheetSafe = false): string {
  const lines = [columns.map((column) => column.header).join("\t")];
  for (const row of rows) lines.push(columns.map((column) => (spreadsheetSafe ? spreadsheetSafeText(dwcaCell(row[column.header])) : dwcaCell(row[column.header]))).join("\t"));
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// XML

/** Drops characters XML 1.0 cannot carry (most control characters and lone surrogates). */
function xmlSafe(value: string): string {
  let text = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000) text += char;
  }
  return text;
}

function xmlText(value: string): string {
  return xmlSafe(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll("\"", "&quot;").replaceAll("'", "&apos;").replace(/[\t\n\r]/gu, " ");
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function metaXml(core: Table, extensions: readonly Table[]): string {
  const lines = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>", `<archive xmlns="${DWC_TEXT_NAMESPACE}" metadata="eml.xml">`];
  for (const table of [core, ...extensions]) {
    const tag = table === core ? "core" : "extension";
    lines.push(`  <${tag} encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="${xmlAttr(table.rowType)}">`);
    lines.push("    <files>", `      <location>${xmlText(table.file)}</location>`, "    </files>");
    lines.push(`    <${tag === "core" ? "id" : "coreid"} index="0"/>`);
    table.columns.forEach((column, index) => {
      if (column.term !== undefined) lines.push(`    <field index="${index}" term="${xmlAttr(column.term)}"/>`);
    });
    lines.push(`  </${tag}>`);
  }
  lines.push("</archive>", "");
  return lines.join("\n");
}

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}$/u;

function partyXml(tag: string, party: EmlParty, indent: string): string {
  const inner = `${indent}  `;
  const lines = [`${indent}<${tag}>`];
  if (party.individualName) {
    lines.push(`${inner}<individualName>`);
    if (party.individualName.givenName?.trim()) lines.push(`${inner}  <givenName>${xmlText(singleLine(party.individualName.givenName))}</givenName>`);
    lines.push(`${inner}  <surName>${xmlText(singleLine(party.individualName.surName))}</surName>`, `${inner}</individualName>`);
  }
  if (party.organizationName?.trim()) lines.push(`${inner}<organizationName>${xmlText(singleLine(party.organizationName))}</organizationName>`);
  if (party.positionName?.trim()) lines.push(`${inner}<positionName>${xmlText(singleLine(party.positionName))}</positionName>`);
  if (party.email) lines.push(`${inner}<electronicMailAddress>${xmlText(party.email)}</electronicMailAddress>`);
  if (party.onlineUrl) lines.push(`${inner}<onlineUrl>${xmlText(party.onlineUrl)}</onlineUrl>`);
  const orcid = party.orcid === undefined ? null : normalizeOrcid(party.orcid);
  if (orcid) lines.push(`${inner}<userId directory="https://orcid.org/">${orcid.slice("https://orcid.org/".length)}</userId>`);
  lines.push(`${indent}</${tag}>`);
  return lines.join("\n");
}

type Coverage = Readonly<{
  bounds?: Readonly<{ west: number; east: number; north: number; south: number }>;
  dates?: Readonly<{ begin: string; end: string }>;
  taxa: readonly Readonly<{ rank?: string; name: string }>[];
}>;

/** ISO 639-2 to the BCP 47 tag xml:lang wants: the two-letter code where one exists. */
const BCP47: Readonly<Record<string, string>> = { eng: "en", fra: "fr", fre: "fr", deu: "de", ger: "de", spa: "es", por: "pt", ita: "it", nld: "nl", dut: "nl", jpn: "ja", zho: "zh", chi: "zh", rus: "ru", ara: "ar", hin: "hi", ind: "id", swe: "sv", nor: "no", dan: "da", fin: "fi", pol: "pl", tur: "tr", kor: "ko" };
export function bcp47(language: string): string {
  return BCP47[language] ?? language;
}

function emlXml(input: DarwinCoreArchiveInput, core: DarwinCoreArchiveCore, coverage: Coverage): string {
  const language = input.language ?? "eng";
  const abstract = (input.description?.trim() ? input.description : input.title).split(/\r?\n\s*\r?\n/u).map(singleLine).filter((item) => item !== "");
  const lines = [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<eml:eml xmlns:eml=\"eml://ecoinformatics.org/eml-2.1.1\"",
    "  xmlns:dc=\"http://purl.org/dc/terms/\"",
    "  xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"",
    `  xsi:schemaLocation="${GBIF_EML_SCHEMA_LOCATION}"`,
    `  packageId="${xmlAttr(input.datasetId)}" system="${xmlAttr(input.system ?? "research-kit")}" scope="system" xml:lang="${bcp47(language)}">`,
    "  <dataset>",
    `    <alternateIdentifier>${xmlText(input.datasetId)}</alternateIdentifier>`,
    `    <title xml:lang="${bcp47(language)}">${xmlText(singleLine(input.title))}</title>`,
    partyXml("creator", input.creator, "    "),
    partyXml("metadataProvider", input.metadataProvider ?? input.creator, "    "),
    `    <pubDate>${utcDateOf(input.createdAt)}</pubDate>`,
    `    <language>${language}</language>`,
    "    <abstract>",
    ...abstract.map((para) => `      <para>${xmlText(para)}</para>`),
    "    </abstract>",
    "    <keywordSet>",
    `      <keyword>${core === "occurrence" ? "Occurrence" : "Samplingevent"}</keyword>`,
    "      <keywordThesaurus>GBIF Dataset Type Vocabulary: http://rs.gbif.org/vocabulary/gbif/dataset_type_2015-07-10.xml</keywordThesaurus>",
    "    </keywordSet>",
    "    <intellectualRights>",
    `      ${intellectualRightsPara(resolveLicence(input.licence))}`,
    "    </intellectualRights>",
  ];
  if (coverage.bounds || coverage.dates || coverage.taxa.length > 0) {
    lines.push("    <coverage>");
    if (coverage.bounds) {
      lines.push(
        "      <geographicCoverage>",
        "        <geographicDescription>Bounding box of the coordinates included in this archive. Withheld locations are not included.</geographicDescription>",
        "        <boundingCoordinates>",
        `          <westBoundingCoordinate>${numberText(coverage.bounds.west)}</westBoundingCoordinate>`,
        `          <eastBoundingCoordinate>${numberText(coverage.bounds.east)}</eastBoundingCoordinate>`,
        `          <northBoundingCoordinate>${numberText(coverage.bounds.north)}</northBoundingCoordinate>`,
        `          <southBoundingCoordinate>${numberText(coverage.bounds.south)}</southBoundingCoordinate>`,
        "        </boundingCoordinates>",
        "      </geographicCoverage>",
      );
    }
    if (coverage.dates) {
      lines.push("      <temporalCoverage>");
      if (coverage.dates.begin === coverage.dates.end) {
        lines.push("        <singleDateTime>", `          <calendarDate>${coverage.dates.begin}</calendarDate>`, "        </singleDateTime>");
      } else {
        lines.push(
          "        <rangeOfDates>",
          `          <beginDate><calendarDate>${coverage.dates.begin}</calendarDate></beginDate>`,
          `          <endDate><calendarDate>${coverage.dates.end}</calendarDate></endDate>`,
          "        </rangeOfDates>",
        );
      }
      lines.push("      </temporalCoverage>");
    }
    if (coverage.taxa.length > 0) {
      lines.push("      <taxonomicCoverage>");
      for (const taxon of coverage.taxa) {
        lines.push("        <taxonomicClassification>");
        if (taxon.rank) lines.push(`          <taxonRankName>${xmlText(taxon.rank)}</taxonRankName>`);
        lines.push(`          <taxonRankValue>${xmlText(singleLine(taxon.name))}</taxonRankValue>`, "        </taxonomicClassification>");
      }
      lines.push("      </taxonomicCoverage>");
    }
    lines.push("    </coverage>");
  }
  lines.push(
    partyXml("contact", input.contact ?? input.creator, "    "),
    "  </dataset>",
    "  <additionalMetadata>",
    "    <metadata>",
    "      <gbif>",
    `        <dateStamp>${xmlText(input.createdAt)}</dateStamp>`,
    "        <hierarchyLevel>dataset</hierarchyLevel>",
    "      </gbif>",
    "    </metadata>",
    "  </additionalMetadata>",
    "</eml:eml>",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Eligibility and row preparation

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const LANGUAGE = /^[a-z]{3}$/u;
const SAMPLE_SIZE_UNITS: Readonly<Record<string, string>> = { square_metre: "square metre", hectare: "hectare" };

function httpsUri(value: unknown, protocols: readonly string[] = ["https:"]): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function present(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

type Prepared = {
  recordId: string;
  coreId: string;
  occurrenceId: string | null;
  shape: ProfileShape;
  event: Row;
  occurrence: Row | null;
  eventWithheld: string[];
  occurrenceWithheld: string[];
  measurements: readonly MeasurementRow[];
  interval: Readonly<{ start: string; end: string }> | null;
  latitude?: number;
  longitude?: number;
};

type Analysis = { findings: DarwinCoreFinding[]; core: DarwinCoreArchiveCore | null; prepared: Prepared[] };

function partyProblems(label: string, party: EmlParty | undefined): string[] {
  if (party === undefined) return [];
  const problems: string[] = [];
  const named = present(party.individualName?.surName) || present(party.organizationName) || present(party.positionName);
  if (!named) problems.push(`${label} needs an individual surname, an organisation name or a position name`);
  if (party.email !== undefined && !EMAIL.test(party.email)) problems.push(`${label} email is not an email address`);
  if (party.onlineUrl !== undefined && !httpsUri(party.onlineUrl)) problems.push(`${label} onlineUrl must be an https URL`);
  if (party.orcid !== undefined && (normalizeOrcid(party.orcid) === null || !party.orcid.startsWith("https://orcid.org/"))) problems.push(`${label} orcid must be an https://orcid.org/ iD with a correct check digit`);
  return problems;
}

function rightsHolderFor(record: DarwinCoreArchiveRecord): string | undefined {
  if (present(record.rightsHolder)) return singleLine(record.rightsHolder);
  const authors = Array.isArray(record.fields?.authors) ? [...record.fields.authors].sort((left, right) => left.ordinal - right.ordinal) : [];
  if (authors.length === 0 || !authors.every((author) => present(author.nameLiteral))) return undefined;
  return authors.map((author) => singleLine(author.nameLiteral!)).join(" | ");
}

function prepareRecord(record: DarwinCoreArchiveRecord, readiness: RecordReadiness, licenceUri: string, findings: DarwinCoreFinding[], visibility: LocationVisibilityOptions = {}): Prepared | null {
  const at = { recordId: record.recordId, versionId: record.versionId };
  const error = (code: DarwinCoreFindingCode, message: string, path?: string) => findings.push({ code, severity: "error", ...at, ...(path === undefined ? {} : { path }), message });
  const before = findings.length;

  if (!SAFE_ID.test(record.recordId) || !SAFE_ID.test(record.versionId)) {
    error("invalid_record", "recordId and versionId must be 1 to 128 safe identifier characters");
    return null;
  }
  const fields = record.fields;
  const profileId = fields?.profile?.profileId;
  const shape = typeof profileId === "string" ? DWCA_PROFILE_SHAPES[profileId] : undefined;
  if (!shape) {
    error("unsupported_profile", `profile ${String(profileId)} cannot be expressed as a Darwin Core occurrence or sampling event`);
    return null;
  }
  const validated = validateRecordFields({ ...fields, profile: { ...fields.profile, readinessTarget: readiness } }, { licenceUri });
  for (const item of validated.findings) {
    if (item.severity === "error") error("record_invalid", `${item.path}: ${item.message}`, item.path);
  }
  if (findings.length > before) return null;
  const profile = findApplicationProfile(fields.profile.profileId, fields.profile.profileVersion) as ApplicationProfile;

  if (record.measurements !== undefined) {
    const problems = validateMeasurementRows(record.measurements).filter((item) => item.severity === "error");
    if (problems.length > 0) error("invalid_measurements", `measurement ${problems[0]!.row ?? ""} ${problems[0]!.message}`.replace(/\s+/gu, " "));
  }
  if (record.landingPage !== undefined && !httpsUri(record.landingPage)) error("invalid_landing_page", "landingPage must be an absolute https URL without credentials");
  // Stable across versions: a re-published dataset must not look like new occurrences. The version is in dynamicProperties.
  const baseId = record.landingPage ?? `urn:clio:record:${record.recordId}`;
  const rightsHolder = rightsHolderFor(record);
  if (rightsHolder === undefined) error("missing_rights_holder", "a rightsHolder is required (supply one, or give every author a literal name)");

  const eventWithheld: string[] = [];
  const occurrenceWithheld: string[] = [];
  const disclose = (visibility: FieldSensitivity, label: string, withheld: string[]): boolean => {
    if (visibility === "public") return true;
    const note = `${label} withheld (${visibility} field)`;
    if (!withheld.includes(note)) withheld.push(note);
    return false;
  };
  const universal = (key: string, value: string | undefined, label: string, withheld: string[]): string | undefined => {
    if (!present(value)) return undefined;
    return disclose(effectiveFieldVisibility(profile, key), label, withheld) ? value : undefined;
  };
  const profileNumber = (key: string): { value: number; unit?: string; visibility: FieldSensitivity } | undefined => {
    const { value, assertion } = unwrapProfileAssertion(fields.profile.data[key]);
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return { value, ...(present(assertion?.unit) ? { unit: assertion.unit } : {}), visibility: effectiveFieldVisibility(profile, key, assertion) };
  };
  const profileText = (key: string): { value: string; visibility: FieldSensitivity } | undefined => {
    const resolved = resolveDarwinCoreProfileTerm(fields, { term: key, fields: [key] }, profile);
    return resolved ? { value: resolved.value, visibility: resolved.visibility } : undefined;
  };

  const event: Row = {
    license: fields.rights.licenceUri,
    rightsHolder: rightsHolder ?? "",
    references: record.landingPage ?? "",
    dynamicProperties: JSON.stringify({ recordVersionId: record.versionId }),
  };

  // Event: date (normalised and verbatim), protocol, effort, habitat, remarks.
  const verbatimDate = universal("observedOn", fields.event.eventDate, "eventDate", eventWithheld);
  let interval: Prepared["interval"] = null;
  if (verbatimDate === undefined) error("missing_event_date", "eventDate is required and must be public");
  else {
    interval = parseEventDateInterval(verbatimDate);
    const normalised = normalisedEventDate(verbatimDate);
    if (normalised === null) error("invalid_event_date", "eventDate must be a YYYY-MM-DD date or a closed YYYY-MM-DD/YYYY-MM-DD interval");
    event.eventDate = normalised ?? "";
    event.verbatimEventDate = verbatimDate;
  }
  event.fieldNumber = fields.event.fieldNumber ?? "";
  const environment = profileText("environment");
  event.habitat = fields.event.habitat ?? (environment && disclose(environment.visibility, "habitat", eventWithheld) ? environment.value : "");
  const surveyProtocol = profileText("surveyProtocol");
  event.samplingProtocol = surveyProtocol
    ? (disclose(surveyProtocol.visibility, "samplingProtocol", eventWithheld) ? surveyProtocol.value : "")
    : fields.event.samplingProtocol ?? universal("method", fields.event.method, "samplingProtocol", eventWithheld) ?? "";
  const effort = profileNumber("samplingEffort");
  event.samplingEffort = effort
    ? (disclose(effort.visibility, "samplingEffort", eventWithheld) ? `${numberText(effort.value)}${effort.unit ? ` ${effort.unit.replaceAll("_", " ")}` : ""}` : "")
    : fields.event.samplingEffort ?? "";
  const area = profileNumber("samplingArea");
  if (area?.unit && SAMPLE_SIZE_UNITS[area.unit] && disclose(area.visibility, "sampleSizeValue", eventWithheld)) {
    event.sampleSizeValue = numberText(area.value);
    event.sampleSizeUnit = SAMPLE_SIZE_UNITS[area.unit]!;
  }
  event.eventRemarks = universal("description", fields.event.context, "eventRemarks", eventWithheld) ?? "";

  // Location, under the location-disclosure rule.
  event.countryCode = fields.event.countryCode ?? "";
  const locality = universal("locality", fields.event.locality, "locality", eventWithheld);
  event.locality = locality ?? "";
  event.verbatimLocality = locality ?? "";
  const location = locationDisclosure(fields.event, visibility);
  let latitude: number | undefined;
  let longitude: number | undefined;
  if (!location.coordinatesPublic) {
    {
      const stated: unknown = fields.event.locationVisibility;
      eventWithheld.push(stated === undefined ? "coordinates withheld (location visibility not stated)" : stated === "restricted" ? "coordinates withheld (restricted location)" : stated === "not_collected" ? "coordinates withheld (location not collected)" : "coordinates withheld (location visibility not recognised)");
    }
  } else if (typeof fields.event.decimalLatitude === "number" && typeof fields.event.decimalLongitude === "number") {
    latitude = fields.event.decimalLatitude;
    longitude = fields.event.decimalLongitude;
    event.decimalLatitude = numberText(latitude);
    event.decimalLongitude = numberText(longitude);
    event.geodeticDatum = fields.event.geodeticDatum ?? "";
    event.coordinateUncertaintyInMeters = fields.event.coordinateUncertaintyM === undefined ? "" : numberText(fields.event.coordinateUncertaintyM);
  }
  if (location.generalizationMethod !== null) event.dataGeneralizations = "Coordinates were generalised by the contributor before deposit.";

  // Occurrence: basis of record, taxon and identification, through the shared mapping.
  let occurrence: Row | null = null;
  const occurrenceId = shape === "event" ? null : baseId;
  if (occurrenceId !== null) {
    occurrence = {
      occurrenceID: occurrenceId,
      license: fields.rights.licenceUri,
      rightsHolder: rightsHolder ?? "",
      recordedBy: universal("observer", fields.event.recordedBy, "recordedBy", occurrenceWithheld) ?? "",
    };
    for (const mapping of DARWIN_CORE_OCCURRENCE_TERMS) {
      const resolved = resolveDarwinCoreProfileTerm(fields, mapping, profile);
      if (resolved && disclose(resolved.visibility, mapping.term, occurrenceWithheld)) occurrence[mapping.term] = resolved.value;
    }
    if (!(DARWIN_CORE_BASIS_OF_RECORD as readonly string[]).includes(occurrence.basisOfRecord ?? "")) {
      error("invalid_basis_of_record", `basisOfRecord must be one of ${DARWIN_CORE_BASIS_OF_RECORD.join(", ")} and public`);
    }
    if (!present(occurrence.scientificName)) error("missing_scientific_name", "scientificName is required and must be public");
  }

  if (findings.length > before) return null;
  return {
    recordId: record.recordId,
    coreId: shape === "occurrence" ? baseId : `${baseId}#event`,
    occurrenceId,
    shape,
    event,
    occurrence,
    eventWithheld,
    occurrenceWithheld,
    measurements: record.measurements ?? [],
    interval,
    ...(latitude === undefined ? {} : { latitude, longitude }),
  };
}

function analyse(input: DarwinCoreArchiveInput): Analysis {
  const findings: DarwinCoreFinding[] = [];
  const meta = (message: string) => findings.push({ code: "invalid_metadata", severity: "error", message });
  if (!present(input.datasetId) || input.datasetId.length > 512 || /\s/u.test(input.datasetId)) meta("datasetId must be a non-blank identifier without spaces");
  if (!present(input.title)) meta("title is required");
  if (typeof input.createdAt !== "string" || !isIsoDateTime(input.createdAt)) meta("createdAt must be an ISO 8601 date-time with a time zone and a real calendar day");
  if (input.language !== undefined && !LANGUAGE.test(input.language)) meta("language must be a three-letter ISO 639-2 code");
  try { assertLocationOptions(input); } catch (error) { meta((error as Error).message); }
  if (input.system !== undefined && !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(input.system)) meta("system must be 1 to 64 letters, digits, dots, hyphens or underscores");
  if (input.licence !== undefined) for (const problem of licenceProblems(input.licence)) meta(problem);
  if (input.readiness !== undefined && !recordReadinessLevels.includes(input.readiness)) meta(`readiness must be one of ${recordReadinessLevels.join(", ")}`);
  if (input.creator === undefined) meta("creator is required");
  for (const problem of [
    ...partyProblems("creator", input.creator),
    ...partyProblems("metadataProvider", input.metadataProvider),
    ...partyProblems("contact", input.contact),
  ]) meta(problem);

  const records = Array.isArray(input.records) ? input.records : [];
  if (records.length === 0) findings.push({ code: "no_records", severity: "error", message: "an archive needs at least one record" });
  if (records.length > DWCA_LIMITS.records) findings.push({ code: "too_many_records", severity: "error", message: `an archive holds at most ${DWCA_LIMITS.records} records` });
  if ((input.media ?? []).length > DWCA_LIMITS.media) findings.push({ code: "too_many_records", severity: "error", message: `an archive lists at most ${DWCA_LIMITS.media} media items` });

  const ordered = [...records].sort((left, right) => (left.recordId !== right.recordId
    ? (left.recordId < right.recordId ? -1 : 1)
    : left.versionId < right.versionId ? -1 : left.versionId > right.versionId ? 1 : 0));
  const prepared: Prepared[] = [];
  const shapes = new Set<ProfileShape>();
  const seenIds = new Map<string, string>();
  const seenRecords = new Map<string, string>();
  for (const record of ordered) {
    const row = prepareRecord(record, input.readiness ?? "referenceable", resolveLicence(input.licence).uri, findings, input.missingVisibility === "public" ? { missingVisibility: "public" } : {});
    if (!row) continue;
    shapes.add(row.shape);
    const label = `${record.recordId}/${record.versionId}`;
    const previous = seenRecords.get(record.recordId) ?? seenIds.get(row.coreId);
    if (previous !== undefined) {
      findings.push({ code: "duplicate_occurrence_id", severity: "error", recordId: record.recordId, versionId: record.versionId, message: `it repeats ${previous} (identifier ${row.coreId}); an archive holds one version per record` });
      continue;
    }
    seenRecords.set(record.recordId, label);
    seenIds.set(row.coreId, label);
    prepared.push(row);
  }
  const hasOccurrenceCore = shapes.has("occurrence");
  const hasEventCore = shapes.has("event") || shapes.has("event-with-occurrence");
  if (hasOccurrenceCore && hasEventCore) {
    findings.push({ code: "mixed_cores", severity: "error", message: "an archive has one core: occurrence profiles (biological occurrence, pollen reference slide) and sampling-event profiles (structured survey, pollen field sample) need separate archives" });
  }
  const core: DarwinCoreArchiveCore | null = hasOccurrenceCore && !hasEventCore ? "occurrence" : hasEventCore && !hasOccurrenceCore ? "event" : null;
  return { findings, core, prepared };
}

/**
 * Checks whether input can become a Darwin Core Archive, without building it.
 * Returns every finding so a UI can show what to fix.
 */
export function validateDarwinCoreEligibility(input: DarwinCoreArchiveInput): DarwinCoreEligibility {
  const { findings, core, prepared } = analyse(input);
  const media = mediaRows(input, mediaTargets(prepared));
  const all = [...findings, ...media.findings];
  return { eligible: core !== null && all.every((item) => item.severity !== "error"), core, findings: all };
}

function mediaTargets(prepared: readonly Prepared[]): Map<string, Readonly<{ coreId: string; references: string }>> {
  return new Map(prepared.map((row) => [row.recordId, { coreId: row.coreId, references: row.event.references ?? "" }]));
}

function mediaRows(input: DarwinCoreArchiveInput, coreIds: ReadonlyMap<string, Readonly<{ coreId: string; references: string }>>): { rows: Row[]; findings: DarwinCoreFinding[] } {
  const findings: DarwinCoreFinding[] = [];
  const rows: Row[] = [];
  const known = new Set((Array.isArray(input.records) ? input.records : []).map((record) => record.recordId));
  const media = [...(input.media ?? [])].sort((left, right) => {
    const a = `${left.recordId}\u0000${left.accessUri ?? ""}\u0000${left.mediaType}`;
    const b = `${right.recordId}\u0000${right.accessUri ?? ""}\u0000${right.mediaType}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const item of media) {
    const skip = (message: string) => findings.push({ code: "media_skipped", severity: "warning", recordId: item.recordId, message });
    if (!known.has(item.recordId)) { skip("media belongs to a record that is not in the archive; left out"); continue; }
    if (!httpsUri(item.accessUri)) { skip("media has no public https accessUri; left out of multimedia.txt"); continue; }
    if (!httpsUri(item.licence, ["https:", "http:"])) { skip("media licence is not a URI; left out of multimedia.txt"); continue; }
    if (!present(item.rightsHolder)) { skip("media has no rights holder; left out of multimedia.txt"); continue; }
    const target = coreIds.get(item.recordId);
    if (!target) continue; // its record is ineligible, which is already an error
    const family = item.mediaType.split("/")[0];
    rows.push({
      id: target.coreId,
      type: family === "image" ? "StillImage" : family === "video" ? "MovingImage" : family === "audio" ? "Sound" : "",
      format: item.mediaType,
      identifier: item.accessUri,
      references: target.references,
      title: item.title ?? "",
      license: item.licence,
      rightsHolder: singleLine(item.rightsHolder),
    });
  }
  return { rows, findings };
}

/**
 * Builds the archive files. Throws DarwinCoreArchiveError, listing every
 * problem, when any record is ineligible: a partial or misleading archive is
 * never produced. Output is deterministic for the same input.
 */
export function buildDarwinCoreArchive(input: DarwinCoreArchiveInput): DarwinCoreArchive {
  const { findings, core, prepared } = analyse(input);
  if (findings.some((item) => item.severity === "error") || core === null) throw new DarwinCoreArchiveError(findings);

  const withheld = (items: readonly string[]) => items.join(" | ");
  const tables: Table[] = [];
  let coreTable: Table;
  if (core === "occurrence") {
    coreTable = {
      file: "occurrence.txt", rowType: DWCA_ROW_TYPES.occurrence, columns: OCCURRENCE_CORE_COLUMNS, title: "Darwin Core occurrences (core)",
      rows: prepared.map((row) => ({ ...row.event, ...row.occurrence, informationWithheld: withheld([...row.eventWithheld, ...row.occurrenceWithheld]) })),
    };
  } else {
    coreTable = {
      file: "event.txt", rowType: DWCA_ROW_TYPES.event, columns: EVENT_CORE_COLUMNS, title: "Darwin Core sampling events (core)",
      rows: prepared.map((row) => ({ eventID: row.coreId, ...row.event, informationWithheld: withheld(row.eventWithheld) })),
    };
    const occurrences = prepared.filter((row) => row.occurrence !== null);
    if (occurrences.length > 0) {
      tables.push({
        file: "occurrence.txt", rowType: DWCA_ROW_TYPES.occurrence, columns: OCCURRENCE_EXTENSION_COLUMNS, title: "Darwin Core occurrences (extension)",
        rows: occurrences.map((row) => ({ eventID: row.coreId, ...row.occurrence, informationWithheld: withheld(row.occurrenceWithheld) })),
      });
    }
  }

  const emofRows: Row[] = [];
  for (const row of prepared) {
    for (const measurement of row.measurements) {
      const linkedOccurrence = core === "event" && row.occurrenceId !== null && measurement.attachedTo?.kind !== "event" ? row.occurrenceId : "";
      const emof = toEmofRow(measurement, row.coreId, linkedOccurrence);
      emofRows.push({ ...emof, measurementID: `${row.coreId.replace(/#event$/u, "")}#measurement-${measurement.measurementId}` });
    }
  }
  if (emofRows.length > 0) {
    tables.push({ file: "extendedmeasurementorfact.txt", rowType: DWCA_ROW_TYPES.measurementOrFact, columns: EMOF_TABLE_COLUMNS, title: "Extended measurements or facts (eMoF)", rows: emofRows });
  }

  const media = mediaRows(input, mediaTargets(prepared));
  if (media.rows.length > 0) {
    tables.push({ file: "multimedia.txt", rowType: DWCA_ROW_TYPES.multimedia, columns: MULTIMEDIA_COLUMNS, title: "Simple Multimedia", rows: media.rows });
  }

  const finalise = (table: Table): Table => ({ ...table, columns: usedColumns(table.columns, table.rows) });
  const coreFinal = finalise(coreTable);
  const extensions = tables.map(finalise);

  const latitudes = prepared.flatMap((row) => (row.latitude === undefined ? [] : [row.latitude]));
  const longitudes = prepared.flatMap((row) => (row.longitude === undefined ? [] : [row.longitude]));
  const starts = prepared.flatMap((row) => (row.interval ? [row.interval.start] : [])).sort();
  const ends = prepared.flatMap((row) => (row.interval ? [row.interval.end] : [])).sort();
  const taxa = new Map<string, { rank?: string; name: string }>();
  for (const row of prepared) {
    const name = row.occurrence?.scientificName;
    if (!present(name)) continue;
    const rank = row.occurrence?.taxonRank;
    const usableRank = present(rank) && rank !== "unknown" ? rank : undefined;
    taxa.set(`${usableRank ?? ""}\u0000${name}`, { ...(usableRank ? { rank: usableRank } : {}), name });
  }
  const coverage: Coverage = {
    ...(latitudes.length > 0 ? { bounds: { west: Math.min(...longitudes), east: Math.max(...longitudes), north: Math.max(...latitudes), south: Math.min(...latitudes) } } : {}),
    ...(starts.length > 0 ? { dates: { begin: starts[0]!, end: ends[ends.length - 1]! } } : {}),
    taxa: [...taxa.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, taxon]) => taxon),
  };

  const files: DarwinCoreArchiveFile[] = [
    { path: "meta.xml", text: metaXml(coreFinal, extensions), mediatype: "application/xml", title: "Darwin Core Archive descriptor (meta.xml)" },
    { path: "eml.xml", text: emlXml(input, core, coverage), mediatype: "application/xml", title: "Dataset metadata (EML 2.1.1, GBIF Metadata Profile)" },
    ...[coreFinal, ...extensions].map((table) => ({ path: table.file, text: tableText(table.columns, table.rows, input.spreadsheetSafe === true), mediatype: "text/tab-separated-values", title: table.title })),
  ];
  return { format: DWCA_FORMAT, core, files, findings: media.findings };
}

/**
 * Lists the archive's files as root-level entries in the order a zip should
 * hold them (meta.xml first). It does not compress or write a zip: zip
 * packaging is a separate, later step.
 */
export function listDarwinCoreArchiveEntries(archive: DarwinCoreArchive): readonly Readonly<{ name: string; bytes: Uint8Array }>[] {
  const encoder = new TextEncoder();
  return archive.files.map((file) => ({ name: file.path, bytes: encoder.encode(file.text) }));
}
