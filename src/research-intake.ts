import type { ReadinessLevel } from "./application-profiles.ts";
import { validateMeasurementRows } from "./measurement-rows.ts";
import { validateProjectSchemaData, type ProjectSchemaDocument, type ProjectSchemaField } from "./research-schema.ts";

/**
 * Schema-aware intake for imported rows: how a staged row names a project
 * schema version, how its extension values and measurement rows are read from
 * the source, and how their findings join the importer's preview report.
 *
 * Pure functions only; nothing here reads storage or publishes anything.
 *
 * Source conventions:
 * - a column (CSV) or key (JSON) named after a project field holds its value;
 * - `projectSchema` may name `schemaKey@version` per row, overriding the
 *   version chosen for the whole import;
 * - `measurements` holds an array of measurement rows (in CSV, as JSON text).
 */

export const RESEARCH_SCHEMA_COLUMN = "projectSchema" as const;
export const RESEARCH_MEASUREMENTS_COLUMN = "measurements" as const;
export const RESEARCH_TITLE_COLUMN = "title" as const;
/** The importer's CSV parser accepts at most 64 columns. */
export const RESEARCH_TEMPLATE_MAX_COLUMNS = 64;
/** Readiness at which missing project fields become a warning rather than an error. */
export const RESEARCH_RELEASE_READINESS: ReadinessLevel = "research_ready";

const SCHEMA_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;
const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * Column names an import treats specially. Project field keys must not reuse
 * them (compared after lower-casing and removing punctuation), or one value
 * would be read two ways.
 */
const RESERVED_KEYS = [
  RESEARCH_SCHEMA_COLUMN, RESEARCH_MEASUREMENTS_COLUMN,
  "id", "sourceId", "sourceNamespace", "namespace", "sourceRecordId", "recordId",
  "title", "licence", "license", "rights", "rightsLicense", "licenceUri", "licenseUri",
] as const;

export type ResearchSchemaReference = Readonly<{ schemaKey: string; version: string }>;

export type ResearchRowFinding = Readonly<{
  severity: "error" | "warning";
  field: string;
  code: string;
  message: string;
  /** `schemaKey@version` the finding came from. */
  schema?: string;
  termIri?: string;
  /** Measurement row index within the source row. */
  row?: number;
}>;

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function singleLine(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").trim();
}

/** Accepts `schemaKey@version` or `{ schemaKey, version }`. */
export function parseSchemaReference(value: unknown): ResearchSchemaReference | null {
  let schemaKey: unknown;
  let version: unknown;
  if (typeof value === "string") {
    const at = value.trim().lastIndexOf("@");
    if (at <= 0) return null;
    schemaKey = value.trim().slice(0, at);
    version = value.trim().slice(at + 1);
  } else if (plainObject(value)) {
    schemaKey = value.schemaKey;
    version = value.version;
  } else return null;
  if (typeof schemaKey !== "string" || schemaKey.length > 64 || !SCHEMA_KEY.test(schemaKey)) return null;
  if (typeof version !== "string" || !SEMVER.test(version)) return null;
  return { schemaKey, version };
}

export function formatSchemaReference(reference: ResearchSchemaReference): string {
  return `${reference.schemaKey}@${reference.version}`;
}

/** Keys of a project schema that clash with the preset's fields or with the import's reserved columns. */
export function researchFieldKeyConflicts(document: ProjectSchemaDocument, presetFieldKeys: readonly string[]): readonly string[] {
  const taken = new Set([...presetFieldKeys, ...RESERVED_KEYS].map(normaliseKey));
  return document.fields.map((field) => field.key).filter((key) => taken.has(normaliseKey(key)));
}

function coerceCsvValue(field: ProjectSchemaField, raw: string): unknown {
  const text = raw.trim();
  switch (field.datatype) {
    case "integer":
    case "number":
      return NUMBER_TEXT.test(text) ? Number(text) : raw;
    case "boolean":
      if (/^(?:true|yes)$/iu.test(text)) return true;
      if (/^(?:false|no)$/iu.test(text)) return false;
      return raw;
    default:
      return raw;
  }
}

/**
 * Reads one row's project field values. CSV cells are text, so numbers and
 * booleans are converted when they parse cleanly; anything that does not is
 * kept as written so validation reports it rather than guessing. Empty CSV
 * cells are treated as absent.
 */
export function researchFieldValues(document: ProjectSchemaDocument, source: Readonly<Record<string, unknown>>, format: "csv" | "json" | "ndjson"): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of document.fields) {
    if (!Object.hasOwn(source, field.key)) continue;
    const raw = source[field.key];
    if (format === "csv" && typeof raw === "string") {
      if (raw.trim() === "") continue;
      values[field.key] = coerceCsvValue(field, raw);
    } else if (raw !== undefined) {
      values[field.key] = raw;
    }
  }
  return values;
}

/** Reads the `measurements` value of a row. In CSV it is JSON text in one cell. */
export function researchMeasurementValue(source: Readonly<Record<string, unknown>>, format: "csv" | "json" | "ndjson"): Readonly<{ present: boolean; rows?: unknown; finding?: ResearchRowFinding }> {
  if (!Object.hasOwn(source, RESEARCH_MEASUREMENTS_COLUMN)) return { present: false };
  const raw = source[RESEARCH_MEASUREMENTS_COLUMN];
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { present: false };
  if (format === "csv" || typeof raw === "string") {
    try {
      return { present: true, rows: JSON.parse(String(raw)) as unknown };
    } catch {
      return { present: true, finding: { severity: "error", field: RESEARCH_MEASUREMENTS_COLUMN, code: "measurement.invalid_rows", message: "Measurements must be a JSON array of measurement rows." } };
    }
  }
  return { present: true, rows: raw };
}

export type ResearchRowInput = Readonly<{
  /** The resolved schema version, when the row names one that exists. */
  schema?: ProjectSchemaDocument;
  /** What the row asked for, resolved or not. */
  requested?: ResearchSchemaReference;
  /** The requested version exists but is deprecated. */
  deprecated?: boolean;
  fields?: Readonly<Record<string, unknown>>;
  measurements?: Readonly<{ present: boolean; rows?: unknown; finding?: ResearchRowFinding }>;
}>;

/**
 * Findings for one row, in the preview report's shape with stable codes:
 * `project-schema.<code>` and `measurement.<code>` reuse the library codes
 * from research-schema.ts and measurement-rows.ts unchanged.
 */
export function researchRowFindings(input: ResearchRowInput): readonly ResearchRowFinding[] {
  const findings: ResearchRowFinding[] = [];
  const requested = input.requested ? formatSchemaReference(input.requested) : undefined;
  if (input.requested && !input.schema) {
    findings.push({ severity: "error", field: RESEARCH_SCHEMA_COLUMN, code: "project-schema.version_unknown", message: `Project schema ${requested} is not a published version of this project.`, schema: requested });
  }
  if (input.schema) {
    const schema = formatSchemaReference(input.schema);
    if (input.deprecated) {
      findings.push({ severity: "warning", field: RESEARCH_SCHEMA_COLUMN, code: "project-schema.version_deprecated", message: `Project schema ${schema} is deprecated. Its data stays readable; use a newer version for new work.`, schema });
    }
    const byKey = new Map(input.schema.fields.map((field) => [field.key, field]));
    const values = input.fields ?? {};
    const atDraft = validateProjectSchemaData(input.schema, values, "draft");
    const seenRequired = new Set<string>();
    for (const item of atDraft) {
      const field = item.field === undefined ? undefined : byKey.get(item.field);
      if (item.code === "required_field" && item.field) seenRequired.add(item.field);
      findings.push({
        severity: item.severity === "error" ? "error" : "warning",
        field: item.field ?? RESEARCH_SCHEMA_COLUMN,
        code: `project-schema.${item.code}`,
        message: field ? `${field.label}: ${item.message}` : item.message,
        schema,
        ...(field?.termIri ? { termIri: field.termIri } : {}),
      });
    }
    for (const item of validateProjectSchemaData(input.schema, values, RESEARCH_RELEASE_READINESS)) {
      if (item.code !== "required_field" || !item.field || seenRequired.has(item.field)) continue;
      const field = byKey.get(item.field);
      findings.push({
        severity: "warning",
        field: item.field,
        code: "project-schema.required_for_research_ready",
        message: `${field?.label ?? item.field}: needed before this record is research ready.`,
        schema,
        ...(field?.termIri ? { termIri: field.termIri } : {}),
      });
    }
  }
  const measurements = input.measurements;
  if (measurements?.finding) findings.push(measurements.finding);
  else if (measurements?.present) {
    for (const item of validateMeasurementRows(measurements.rows)) {
      findings.push({
        severity: item.severity === "error" ? "error" : "warning",
        field: item.row === undefined ? RESEARCH_MEASUREMENTS_COLUMN : `${RESEARCH_MEASUREMENTS_COLUMN}[${item.row}]`,
        code: `measurement.${item.code}`,
        message: item.row === undefined ? item.message : `Measurement ${item.row + 1}: ${item.message}`,
        ...(item.row === undefined ? {} : { row: item.row }),
      });
    }
  }
  return findings;
}

/** One CSV cell, RFC 4180 quoted when needed. */
function csvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll("\"", "\"\"")}"` : value;
}

function readinessLabel(level: ReadinessLevel): string {
  return level.replaceAll("_", " ");
}

function fieldNote(field: ProjectSchemaField): string {
  const parts: string[] = [`# ${field.key}: ${singleLine(field.label)}.`, field.datatype === "enum" ? `One of: ${(field.vocabulary ?? []).map((item) => item.value).join(" | ")}.` : `Type: ${field.datatype}.`];
  if (field.unitIri) parts.push(`Unit: ${field.unitLabel ? `${singleLine(field.unitLabel)} ` : ""}${field.unitIri}.`);
  if (field.dimensionless) parts.push("No unit (dimensionless).");
  if (typeof field.min === "number" || typeof field.max === "number") parts.push(`Range: ${field.min ?? "any"} to ${field.max ?? "any"}.`);
  parts.push(field.termIri ? `Meaning: ${field.termIri}.` : "Local term.");
  parts.push(field.requiredAt ? `Required for ${readinessLabel(field.requiredAt)}.` : "Optional.");
  if (field.sensitivity !== "public") parts.push(`Sensitivity: ${field.sensitivity}.`);
  if (field.deprecated) parts.push(`Deprecated${field.deprecated.replacedBy ? `; use ${field.deprecated.replacedBy}` : ""}.`);
  if (field.help) parts.push(singleLine(field.help));
  return parts.join(" ");
}

export type ResearchTemplatePresetField = Readonly<{ key: string; label: string; requiredForDraft?: boolean; requiredForRelease?: boolean }>;

/**
 * A CSV template: one note per column (lines starting with `#`), then the
 * header row. Notes are single-line, one cell each. Returns null when the
 * schema has too many fields for the importer's 64-column CSV limit; use JSON then.
 */
export function projectSchemaCsvTemplate(document: ProjectSchemaDocument, presetFields: readonly ResearchTemplatePresetField[]): string | null {
  const fields = document.fields.filter((field) => !field.deprecated);
  // The importer hands a row to the editor only with a scientific title, which no
  // preset column carries, so the template always offers one.
  const titleColumn = presetFields.some((field) => field.key === RESEARCH_TITLE_COLUMN) ? [] : [RESEARCH_TITLE_COLUMN];
  const columns = [...presetFields.map((field) => field.key), ...titleColumn, ...fields.map((field) => field.key), RESEARCH_MEASUREMENTS_COLUMN];
  if (columns.length > RESEARCH_TEMPLATE_MAX_COLUMNS) return null;
  const ref = formatSchemaReference(document);
  const notes = [
    `# CSV template for project schema ${ref} (${singleLine(document.title)}). Extends ${document.extends.profileId} ${document.extends.profileVersion}.`,
    `# Lines starting with # are notes. The importer skips them when you import this file with ${ref} selected. Keep the header row as it is and add one row per record below it.`,
    ...presetFields.map((field) => `# ${field.key}: ${singleLine(field.label)}. Project preset column${field.requiredForDraft ? "; required" : field.requiredForRelease ? "; required before release" : "; optional"}.`),
    ...titleColumn.map((key) => `# ${key}: a short scientific title for the record. Needed before a row can become a draft record.`),
    ...fields.map(fieldNote),
    `# ${RESEARCH_MEASUREMENTS_COLUMN}: optional. A JSON array of measurement rows, each with measurementId, typeIri (or localTerm true), typeLabel, value ({"number": 1.2} or {"text": "..."}) and unitIri for numbers.`,
    "# Synthetic or real values are yours to add. This template holds no data.",
  ];
  return `${[...notes.map(csvCell), columns.map(csvCell).join(",")].join("\r\n")}\r\n`;
}

/**
 * Removes the leading note lines a template carries (lines whose first cell
 * starts with `#`, quoted or not) so the header row comes first. Only the
 * leading block is touched; a `#` later in the file is data.
 */
export function stripTemplateNotes(content: string): Readonly<{ content: string; removed: number }> {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  let rest = bom ? content.slice(1) : content;
  let removed = 0;
  while (/^[ \t]*"?#/u.test(rest)) {
    const newline = rest.search(/\r\n|\n|\r/u);
    if (newline < 0) { rest = ""; removed += 1; break; }
    rest = rest.slice(newline + (rest.startsWith("\r\n", newline) ? 2 : 1));
    removed += 1;
  }
  return { content: bom + rest, removed };
}

