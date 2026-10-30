import {
  READINESS_LEVELS,
  findApplicationProfile,
  readinessRank,
  type FieldSensitivity,
  type ReadinessLevel,
  type ValidationSeverity,
} from "./application-profiles.ts";

/**
 * Project schemas let a research team add its own typed fields on top of one
 * pinned application profile.
 *
 * Rules enforced here:
 * - a published version is immutable; a change is a new version whose bump
 *   (patch/minor/major) is checked against what actually changed;
 * - every field carries a term IRI, or is explicitly flagged as a local term;
 * - numeric fields carry a unit IRI unless declared dimensionless;
 * - extension values live in their own namespace, so a project schema can add
 *   fields but can never remove or loosen a profile field.
 *
 * It makes no claim of JSON Schema, Darwin Core, OBIS or any other
 * conformance.
 */

export const PROJECT_SCHEMA_FORMAT = "clio.project-schema/v1" as const;
export const PROJECT_SCHEMA_LIMITS = Object.freeze({
  fields: 200,
  labelLength: 200,
  helpLength: 2_000,
  vocabularyValues: 500,
  stringValueLength: 4_096,
  iriLength: 2_048,
});

export const PROJECT_FIELD_DATATYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "datetime",
  "uri",
  "enum",
] as const;

export type ProjectFieldDatatype = (typeof PROJECT_FIELD_DATATYPES)[number];

export type ProjectVocabularyValue = Readonly<{
  value: string;
  iri?: string;
  label?: string;
}>;

export type ProjectSchemaField = Readonly<{
  key: string;
  label: string;
  datatype: ProjectFieldDatatype;
  /** Concept IRI for the field's meaning. Null only when `localTerm` is true. */
  termIri: string | null;
  localTerm?: boolean;
  unitIri?: string;
  unitLabel?: string;
  dimensionless?: boolean;
  vocabulary?: readonly ProjectVocabularyValue[];
  requiredAt?: ReadinessLevel;
  min?: number;
  max?: number;
  maxLength?: number;
  sensitivity: FieldSensitivity;
  help?: string;
  deprecated?: Readonly<{ since: string; replacedBy?: string; reason?: string }>;
  exportMap?: Readonly<{ dwcTerm?: string; emof?: boolean; csvColumn?: string }>;
}>;

export type ProjectSchemaDocument = Readonly<{
  format: typeof PROJECT_SCHEMA_FORMAT;
  schemaKey: string;
  version: string;
  title: string;
  description?: string;
  extends: Readonly<{ profileId: string; profileVersion: string }>;
  fields: readonly ProjectSchemaField[];
}>;

export type ResearchSchemaFindingCode =
  | "invalid_document"
  | "invalid_format"
  | "invalid_schema_key"
  | "invalid_version"
  | "unknown_profile"
  | "unsupported_profile"
  | "too_many_fields"
  | "invalid_field"
  | "duplicate_field"
  | "profile_field_collision"
  | "missing_term_iri"
  | "invalid_iri"
  | "missing_unit"
  | "invalid_vocabulary"
  | "invalid_range"
  | "invalid_readiness"
  | "invalid_deprecation"
  | "schema_key_changed"
  | "profile_changed"
  | "version_not_increased"
  | "version_bump_too_small"
  | "unknown_field"
  | "required_field"
  | "invalid_datatype"
  | "invalid_enum"
  | "out_of_range"
  | "deprecated_field";

export type ResearchSchemaFinding = Readonly<{
  code: ResearchSchemaFindingCode;
  severity: ValidationSeverity;
  field?: string;
  message: string;
}>;

export type ProjectSchemaChange = "none" | "patch" | "minor" | "major";

const SCHEMA_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FIELD_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/u;
/** Keys an extension field may not use: the identifier columns it sits beside in the CSV, and names that exist on every object. */
const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(["recordId", "versionId", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"]);
const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/u;
const CHANGE_RANK: Readonly<Record<ProjectSchemaChange, number>> = { none: 0, patch: 1, minor: 2, major: 3 };

function finding(code: ResearchSchemaFindingCode, message: string, field?: string, severity: ValidationSeverity = "error"): ResearchSchemaFinding {
  return field === undefined ? { code, severity, message } : { code, severity, field, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Accepts only absolute http(s) IRIs without credentials or fragments-only forms. */
export function isTermIri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > PROJECT_SCHEMA_LIMITS.iriLength) return false;
  if (/\s/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = SEMVER.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(left: readonly [number, number, number], right: readonly [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function isNumeric(datatype: ProjectFieldDatatype): boolean {
  return datatype === "integer" || datatype === "number";
}

function validateField(field: unknown, index: number, profileKeys: ReadonlySet<string>): ResearchSchemaFinding[] {
  const path = `fields[${index}]`;
  if (!isPlainObject(field)) return [finding("invalid_field", "Each field must be an object.", path)];
  const key = typeof field.key === "string" ? field.key : path;
  const findings: ResearchSchemaFinding[] = [];
  if (typeof field.key !== "string" || !FIELD_KEY.test(field.key)) {
    findings.push(finding("invalid_field", "Field key must start with a lower-case letter and use letters, digits or underscores (64 characters at most).", path));
  } else if (RESERVED_FIELD_KEYS.has(field.key)) {
    findings.push(finding("invalid_field", "This key is reserved (it would overwrite an identifier column or an object property). Choose a different key.", key));
  } else if (profileKeys.has(field.key)) {
    findings.push(finding("profile_field_collision", "This key is already a field of the extended profile. Use the profile field, or choose a different key.", key));
  }
  if (typeof field.label !== "string" || field.label.trim() === "" || field.label.length > PROJECT_SCHEMA_LIMITS.labelLength) {
    findings.push(finding("invalid_field", "Field label is required (200 characters at most).", key));
  }
  if (field.help !== undefined && (typeof field.help !== "string" || field.help.length > PROJECT_SCHEMA_LIMITS.helpLength)) {
    findings.push(finding("invalid_field", "Field help must be text (2,000 characters at most).", key));
  }
  const datatype = field.datatype;
  if (typeof datatype !== "string" || !(PROJECT_FIELD_DATATYPES as readonly string[]).includes(datatype)) {
    findings.push(finding("invalid_field", `Datatype must be one of ${PROJECT_FIELD_DATATYPES.join(", ")}.`, key));
    return findings;
  }
  const typed = datatype as ProjectFieldDatatype;
  if (field.localTerm === true) {
    if (field.termIri !== null && field.termIri !== undefined && !isTermIri(field.termIri)) {
      findings.push(finding("invalid_iri", "Term IRI must be an absolute http(s) IRI.", key));
    }
  } else if (field.termIri === null || field.termIri === undefined) {
    findings.push(finding("missing_term_iri", "Every field needs a term IRI that says what it means, or must be flagged as a local term.", key));
  } else if (!isTermIri(field.termIri)) {
    findings.push(finding("invalid_iri", "Term IRI must be an absolute http(s) IRI.", key));
  }
  if (field.localTerm !== undefined && typeof field.localTerm !== "boolean") {
    findings.push(finding("invalid_field", "localTerm must be true or false.", key));
  }
  if (isNumeric(typed)) {
    if (field.dimensionless === true) {
      if (field.unitIri !== undefined) findings.push(finding("missing_unit", "A dimensionless field must not also declare a unit.", key));
    } else if (field.unitIri === undefined) {
      findings.push(finding("missing_unit", "Numeric fields need a unit IRI, or must be declared dimensionless.", key));
    } else if (!isTermIri(field.unitIri)) {
      findings.push(finding("invalid_iri", "Unit IRI must be an absolute http(s) IRI.", key));
    }
    for (const bound of ["min", "max"] as const) {
      if (field[bound] !== undefined && (typeof field[bound] !== "number" || !Number.isFinite(field[bound]))) {
        findings.push(finding("invalid_range", `${bound} must be a finite number.`, key));
      }
    }
    if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) {
      findings.push(finding("invalid_range", "min must not be greater than max.", key));
    }
  } else {
    if (field.unitIri !== undefined || field.dimensionless !== undefined) findings.push(finding("invalid_field", "Only numeric fields can declare a unit.", key));
    if (field.min !== undefined || field.max !== undefined) findings.push(finding("invalid_range", "Only numeric fields can declare min or max.", key));
  }
  if (field.maxLength !== undefined) {
    if (typed !== "string" || typeof field.maxLength !== "number" || !Number.isInteger(field.maxLength)
      || field.maxLength < 1 || field.maxLength > PROJECT_SCHEMA_LIMITS.stringValueLength) {
      findings.push(finding("invalid_range", "maxLength applies to string fields and must be 1 to 4,096.", key));
    }
  }
  if (typed === "enum") {
    const vocabulary = field.vocabulary;
    if (!Array.isArray(vocabulary) || vocabulary.length === 0 || vocabulary.length > PROJECT_SCHEMA_LIMITS.vocabularyValues) {
      findings.push(finding("invalid_vocabulary", "An enum field needs 1 to 500 vocabulary values.", key));
    } else {
      const seen = new Set<string>();
      vocabulary.forEach((item: unknown, itemIndex: number) => {
        if (!isPlainObject(item) || typeof item.value !== "string" || item.value.trim() === "" || item.value.length > PROJECT_SCHEMA_LIMITS.labelLength) {
          findings.push(finding("invalid_vocabulary", `Vocabulary value ${itemIndex} must have a non-empty value.`, key));
          return;
        }
        if (seen.has(item.value)) findings.push(finding("invalid_vocabulary", `Vocabulary value "${item.value}" is repeated.`, key));
        seen.add(item.value);
        if (item.iri !== undefined && !isTermIri(item.iri)) findings.push(finding("invalid_iri", `Vocabulary value "${item.value}" has an invalid IRI.`, key));
      });
    }
  } else if (field.vocabulary !== undefined) {
    findings.push(finding("invalid_vocabulary", "Only enum fields can declare a vocabulary.", key));
  }
  if (field.requiredAt !== undefined && !(READINESS_LEVELS as readonly unknown[]).includes(field.requiredAt)) {
    findings.push(finding("invalid_readiness", "requiredAt must be a registered readiness level.", key));
  }
  if (field.requiredAt === "archive_accepted") {
    findings.push(finding("invalid_readiness", "archive_accepted is set only from external deposit evidence; it cannot gate a field.", key));
  }
  if (field.sensitivity !== "public" && field.sensitivity !== "sensitive" && field.sensitivity !== "restricted") {
    findings.push(finding("invalid_field", "Sensitivity must be public, sensitive or restricted.", key));
  }
  if (field.deprecated !== undefined) {
    const deprecated = field.deprecated;
    if (!isPlainObject(deprecated) || typeof deprecated.since !== "string" || parseVersion(deprecated.since) === undefined) {
      findings.push(finding("invalid_deprecation", "deprecated.since must name the schema version that deprecated the field.", key));
    } else if (deprecated.replacedBy !== undefined && (typeof deprecated.replacedBy !== "string" || !FIELD_KEY.test(deprecated.replacedBy))) {
      findings.push(finding("invalid_deprecation", "deprecated.replacedBy must be a field key.", key));
    }
  }
  return findings;
}

/** Structural and semantic validation of one project schema document. */
export function validateProjectSchemaDocument(document: unknown): readonly ResearchSchemaFinding[] {
  if (!isPlainObject(document)) return [finding("invalid_document", "A project schema must be a JSON object.")];
  const findings: ResearchSchemaFinding[] = [];
  if (document.format !== PROJECT_SCHEMA_FORMAT) findings.push(finding("invalid_format", `format must be "${PROJECT_SCHEMA_FORMAT}".`));
  if (typeof document.schemaKey !== "string" || !SCHEMA_KEY.test(document.schemaKey) || document.schemaKey.length > 64) {
    findings.push(finding("invalid_schema_key", "schemaKey must be lower-case words joined by hyphens (64 characters at most)."));
  }
  if (typeof document.version !== "string" || parseVersion(document.version) === undefined) {
    findings.push(finding("invalid_version", "version must be MAJOR.MINOR.PATCH, for example 1.0.0."));
  }
  if (typeof document.title !== "string" || document.title.trim() === "" || document.title.length > PROJECT_SCHEMA_LIMITS.labelLength) {
    findings.push(finding("invalid_document", "title is required (200 characters at most)."));
  }
  if (document.description !== undefined && (typeof document.description !== "string" || document.description.length > PROJECT_SCHEMA_LIMITS.helpLength)) {
    findings.push(finding("invalid_document", "description must be text (2,000 characters at most)."));
  }
  let profileKeys: ReadonlySet<string> = new Set();
  const extendsValue = document.extends;
  if (!isPlainObject(extendsValue) || typeof extendsValue.profileId !== "string" || typeof extendsValue.profileVersion !== "string") {
    findings.push(finding("unknown_profile", "extends must name a profileId and an exact profileVersion."));
  } else {
    const profile = findApplicationProfile(extendsValue.profileId, extendsValue.profileVersion);
    if (!profile) findings.push(finding("unknown_profile", "The extended profile version is not registered."));
    else if (!profile.launchable) findings.push(finding("unsupported_profile", "Project schemas can only extend a launchable profile."));
    else profileKeys = new Set(profile.fields.map((field) => field.key));
  }
  const fields = document.fields;
  if (!Array.isArray(fields)) {
    findings.push(finding("invalid_document", "fields must be an array."));
    return findings;
  }
  if (fields.length > PROJECT_SCHEMA_LIMITS.fields) findings.push(finding("too_many_fields", "A project schema can declare at most 200 fields."));
  const seen = new Set<string>();
  fields.forEach((field: unknown, index: number) => {
    findings.push(...validateField(field, index, profileKeys));
    if (isPlainObject(field) && typeof field.key === "string") {
      if (seen.has(field.key)) findings.push(finding("duplicate_field", "Field keys must be unique.", field.key));
      seen.add(field.key);
    }
  });
  for (const field of fields) {
    if (isPlainObject(field) && isPlainObject(field.deprecated) && typeof field.deprecated.replacedBy === "string" && !seen.has(field.deprecated.replacedBy)) {
      findings.push(finding("invalid_deprecation", "deprecated.replacedBy must name a field in this schema.", String(field.key)));
    }
  }
  return findings;
}

export function isValidProjectSchemaDocument(document: unknown): document is ProjectSchemaDocument {
  return validateProjectSchemaDocument(document).every((item) => item.severity !== "error");
}

/** Stable JSON: object keys sorted, undefined members removed, arrays kept in order. */
export function canonicalProjectSchema(document: ProjectSchemaDocument): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return JSON.stringify(normalize(document));
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function projectSchemaDigest(document: ProjectSchemaDocument): Promise<string> {
  return `sha256:${await sha256Hex(canonicalProjectSchema(document))}`;
}

function requiredRank(field: ProjectSchemaField): number {
  return field.requiredAt === undefined ? Number.POSITIVE_INFINITY : readinessRank(field.requiredAt);
}

function vocabularyValues(field: ProjectSchemaField): ReadonlySet<string> {
  return new Set((field.vocabulary ?? []).map((item) => item.value));
}

function classifyFieldChange(before: ProjectSchemaField, after: ProjectSchemaField): ProjectSchemaChange {
  if (before.datatype !== after.datatype || before.termIri !== after.termIri || before.unitIri !== after.unitIri
    || Boolean(before.dimensionless) !== Boolean(after.dimensionless) || Boolean(before.localTerm) !== Boolean(after.localTerm)) {
    return "major";
  }
  if (requiredRank(after) < requiredRank(before)) return "major";
  const beforeValues = vocabularyValues(before);
  const afterValues = vocabularyValues(after);
  for (const value of beforeValues) if (!afterValues.has(value)) return "major";
  if (typeof after.min === "number" && (before.min === undefined || after.min > before.min)) return "major";
  if (typeof after.max === "number" && (before.max === undefined || after.max < before.max)) return "major";
  if (typeof after.maxLength === "number" && (before.maxLength === undefined || after.maxLength < before.maxLength)) return "major";
  if (before.sensitivity !== after.sensitivity) return "major";
  const minorChanged = afterValues.size !== beforeValues.size
    || requiredRank(after) !== requiredRank(before)
    || before.min !== after.min || before.max !== after.max || before.maxLength !== after.maxLength
    || (before.deprecated === undefined) !== (after.deprecated === undefined)
    || JSON.stringify(before.exportMap ?? null) !== JSON.stringify(after.exportMap ?? null);
  if (minorChanged) return "minor";
  const patchChanged = before.label !== after.label || before.help !== after.help || before.unitLabel !== after.unitLabel
    || JSON.stringify(before.vocabulary ?? null) !== JSON.stringify(after.vocabulary ?? null)
    || JSON.stringify(before.deprecated ?? null) !== JSON.stringify(after.deprecated ?? null);
  return patchChanged ? "patch" : "none";
}

function maxChange(left: ProjectSchemaChange, right: ProjectSchemaChange): ProjectSchemaChange {
  return CHANGE_RANK[left] >= CHANGE_RANK[right] ? left : right;
}

export type ProjectSchemaVersionCheck = Readonly<{
  required: ProjectSchemaChange;
  declared: ProjectSchemaChange;
  findings: readonly ResearchSchemaFinding[];
}>;

/**
 * Compares a new version with the latest published one. Adding an optional
 * field or vocabulary value, or deprecating a field, is minor. Removing a
 * field, changing its meaning, type or unit, or tightening it is major.
 */
export function checkProjectSchemaVersion(previous: ProjectSchemaDocument, next: ProjectSchemaDocument): ProjectSchemaVersionCheck {
  const findings: ResearchSchemaFinding[] = [];
  if (previous.schemaKey !== next.schemaKey) findings.push(finding("schema_key_changed", "A new version must keep the same schemaKey."));
  const beforeVersion = parseVersion(previous.version);
  const afterVersion = parseVersion(next.version);
  let declared: ProjectSchemaChange = "none";
  if (!beforeVersion || !afterVersion) {
    findings.push(finding("invalid_version", "Both versions must be MAJOR.MINOR.PATCH."));
  } else if (compareVersions(afterVersion, beforeVersion) <= 0) {
    findings.push(finding("version_not_increased", "A new version must be greater than the published one; published versions are never edited."));
  } else {
    declared = afterVersion[0] > beforeVersion[0] ? "major" : afterVersion[1] > beforeVersion[1] ? "minor" : "patch";
  }
  let required: ProjectSchemaChange = "none";
  if (previous.extends.profileId !== next.extends.profileId) {
    findings.push(finding("profile_changed", "A project schema line cannot move to a different profile; start a new schemaKey."));
    required = "major";
  } else if (previous.extends.profileVersion !== next.extends.profileVersion) {
    required = "major";
  }
  if (previous.title !== next.title || previous.description !== next.description) required = maxChange(required, "patch");
  const afterFields = new Map(next.fields.map((field) => [field.key, field]));
  const beforeKeys = new Set(previous.fields.map((field) => field.key));
  for (const before of previous.fields) {
    const after = afterFields.get(before.key);
    required = maxChange(required, after === undefined ? "major" : classifyFieldChange(before, after));
  }
  for (const after of next.fields) {
    if (beforeKeys.has(after.key)) continue;
    // A new optional field is additive; a new required field invalidates data
    // that was complete under the previous version, so it is major.
    required = maxChange(required, after.requiredAt === undefined ? "minor" : "major");
  }
  if (required !== "none" && CHANGE_RANK[declared] < CHANGE_RANK[required]) {
    findings.push(finding("version_bump_too_small", `These changes need at least a ${required} version increase.`));
  }
  return { required, declared, findings };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

function isDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    && isCalendarDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));
}

function datatypeError(field: ProjectSchemaField, value: unknown): string | undefined {
  switch (field.datatype) {
    case "string":
      if (typeof value !== "string") return "text";
      if (value.length > (field.maxLength ?? PROJECT_SCHEMA_LIMITS.stringValueLength)) return `text of ${field.maxLength ?? PROJECT_SCHEMA_LIMITS.stringValueLength} characters at most`;
      return undefined;
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) ? undefined : "a whole number";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "a finite number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "true or false";
    case "date":
      return typeof value === "string" && isCalendarDate(value) ? undefined : "a date as YYYY-MM-DD";
    case "datetime":
      return typeof value === "string" && isDateTime(value) ? undefined : "a date and time with a time zone, such as 2026-10-22T09:30:00+11:00";
    case "uri":
      return isTermIri(value) ? undefined : "an absolute http(s) link";
    case "enum":
      return typeof value === "string" ? undefined : "one of the listed values";
  }
}

/**
 * Validates one record's extension values (the object stored under the
 * project schema's namespace) for a requested readiness level.
 */
export function validateProjectSchemaData(document: ProjectSchemaDocument, data: unknown, readiness: ReadinessLevel): readonly ResearchSchemaFinding[] {
  if (!isPlainObject(data)) return [finding("invalid_document", "Project fields must be a JSON object.")];
  const findings: ResearchSchemaFinding[] = [];
  const fields = new Map(document.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(data)) {
    if (!fields.has(key)) findings.push(finding("unknown_field", "This field is not in the project schema version.", key));
  }
  const target = readinessRank(readiness);
  for (const field of document.fields) {
    const present = Object.hasOwn(data, field.key) && data[field.key] !== null && data[field.key] !== "";
    if (!present) {
      if (field.requiredAt !== undefined && readinessRank(field.requiredAt) <= target && field.deprecated === undefined) {
        findings.push(finding("required_field", `Required for ${readiness.replaceAll("_", " ")}.`, field.key));
      }
      continue;
    }
    const value = data[field.key];
    if (field.deprecated !== undefined) {
      findings.push(finding("deprecated_field", field.deprecated.replacedBy ? `Deprecated; use ${field.deprecated.replacedBy}.` : "Deprecated in this schema.", field.key, "warning"));
    }
    const expected = datatypeError(field, value);
    if (expected !== undefined) {
      findings.push(finding("invalid_datatype", `Expected ${expected}.`, field.key));
      continue;
    }
    if (field.datatype === "enum" && !vocabularyValues(field).has(value as string)) {
      findings.push(finding("invalid_enum", "Value is not in this field's vocabulary.", field.key));
    }
    if (typeof value === "number" && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
      findings.push(finding("out_of_range", `Expected a value from ${field.min ?? "-∞"} to ${field.max ?? "∞"}.`, field.key));
    }
  }
  return findings;
}

const JSON_SCHEMA_TYPES: Readonly<Record<ProjectFieldDatatype, Record<string, unknown>>> = {
  string: { type: "string" },
  integer: { type: "integer" },
  number: { type: "number" },
  boolean: { type: "boolean" },
  date: { type: "string", format: "date" },
  datetime: { type: "string", format: "date-time" },
  uri: { type: "string", format: "uri" },
  enum: { type: "string" },
};

/**
 * Emits an interchange JSON Schema 2020-12 document for other tools. This package's
 * own validator above stays authoritative; `x-clio-*` annotations carry the
 * term, unit and readiness metadata that JSON Schema has no keyword for.
 */
export function toJsonSchema(document: ProjectSchemaDocument, options: Readonly<{ id: string; readiness: ReadinessLevel }>): Record<string, unknown> {
  const target = readinessRank(options.readiness);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of document.fields) {
    const property: Record<string, unknown> = { ...JSON_SCHEMA_TYPES[field.datatype], title: field.label };
    if (field.help) property.description = field.help;
    if (field.datatype === "enum") property.enum = (field.vocabulary ?? []).map((item) => item.value);
    if (field.min !== undefined) property.minimum = field.min;
    if (field.max !== undefined) property.maximum = field.max;
    if (field.datatype === "string") property.maxLength = field.maxLength ?? PROJECT_SCHEMA_LIMITS.stringValueLength;
    if (field.deprecated) property.deprecated = true;
    property["x-clio-termIri"] = field.termIri;
    if (field.localTerm) property["x-clio-localTerm"] = true;
    if (field.unitIri) property["x-clio-unitIri"] = field.unitIri;
    if (field.dimensionless) property["x-clio-dimensionless"] = true;
    if (field.requiredAt) property["x-clio-requiredAt"] = field.requiredAt;
    property["x-clio-sensitivity"] = field.sensitivity;
    if (field.datatype === "enum" && field.vocabulary?.some((item) => item.iri)) {
      property["x-clio-vocabulary"] = field.vocabulary.map((item) => ({ value: item.value, ...(item.iri ? { iri: item.iri } : {}) }));
    }
    properties[field.key] = property;
    if (field.requiredAt !== undefined && readinessRank(field.requiredAt) <= target && !field.deprecated) required.push(field.key);
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: options.id,
    title: document.title,
    ...(document.description ? { description: document.description } : {}),
    type: "object",
    additionalProperties: false,
    properties,
    required,
    "x-clio-format": document.format,
    "x-clio-schemaKey": document.schemaKey,
    "x-clio-version": document.version,
    "x-clio-extends": document.extends,
    "x-clio-readiness": options.readiness,
  };
}
