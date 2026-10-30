import type { AssertionUncertainty, ValidationSeverity } from "./application-profiles.ts";
import { isTermIri } from "./research-schema.ts";

/**
 * Measurement rows are the open escape hatch for research teams: any measured
 * or recorded fact can be attached to an event, record, sample or media object
 * without registering a project schema first, as long as it says what it is
 * (a type IRI, or an explicit local term) and, for numbers, its unit.
 *
 * The shape follows the OBIS Extended Measurement or Fact (eMoF) pattern so a
 * future export can map rows to eMoF columns one to one. That mapping is a
 * projection, not a claim that any repository accepts the output.
 */

export const MEASUREMENT_ROW_LIMIT = 500;
export const MEASUREMENT_TEXT_LIMIT = 4_096;

export type MeasurementValue =
  | Readonly<{ number: number }>
  | Readonly<{ text: string }>
  | Readonly<{ iri: string; label?: string }>;

export type MeasurementAttachment = Readonly<{ kind: "event" | "record" | "sample" | "media"; id: string }>;

export type MeasurementRow = Readonly<{
  measurementId: string;
  typeIri: string | null;
  typeLabel: string;
  localTerm?: boolean;
  value: MeasurementValue;
  unitIri?: string;
  unitLabel?: string;
  dimensionless?: boolean;
  method?: string;
  methodIri?: string;
  uncertainty?: AssertionUncertainty;
  determinedBy?: string;
  determinedAt?: string;
  attachedTo?: MeasurementAttachment;
  remarks?: string;
}>;

export type MeasurementFindingCode =
  | "invalid_rows"
  | "too_many_rows"
  | "invalid_row"
  | "duplicate_measurement_id"
  | "missing_term_iri"
  | "invalid_iri"
  | "invalid_value"
  | "missing_unit"
  | "invalid_date";

export type MeasurementFinding = Readonly<{
  code: MeasurementFindingCode;
  severity: ValidationSeverity;
  row?: number;
  message: string;
}>;

const MEASUREMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shortText(value: unknown, limit = MEASUREMENT_TEXT_LIMIT): boolean {
  return typeof value === "string" && value.length <= limit;
}

function validateRow(row: unknown, index: number): MeasurementFinding[] {
  const fail = (code: MeasurementFindingCode, message: string): MeasurementFinding => ({ code, severity: "error", row: index, message });
  if (!isPlainObject(row)) return [fail("invalid_row", "Each measurement must be an object.")];
  const findings: MeasurementFinding[] = [];
  if (typeof row.measurementId !== "string" || !MEASUREMENT_ID.test(row.measurementId)) {
    findings.push(fail("invalid_row", "measurementId must be 1 to 128 letters, digits, dots, colons, underscores or hyphens."));
  }
  if (typeof row.typeLabel !== "string" || row.typeLabel.trim() === "" || row.typeLabel.length > 200) {
    findings.push(fail("invalid_row", "typeLabel is required (200 characters at most)."));
  }
  if (row.localTerm === true) {
    if (row.typeIri !== null && row.typeIri !== undefined && !isTermIri(row.typeIri)) findings.push(fail("invalid_iri", "typeIri must be an absolute http(s) IRI."));
  } else if (row.typeIri === null || row.typeIri === undefined) {
    findings.push(fail("missing_term_iri", "Each measurement needs a type IRI that says what was measured, or must be flagged as a local term."));
  } else if (!isTermIri(row.typeIri)) {
    findings.push(fail("invalid_iri", "typeIri must be an absolute http(s) IRI."));
  }
  const value = row.value;
  let numeric = false;
  if (!isPlainObject(value)) {
    findings.push(fail("invalid_value", "value must be one of {number}, {text} or {iri}."));
  } else {
    const kinds = ["number", "text", "iri"].filter((kind) => Object.hasOwn(value, kind));
    if (kinds.length !== 1) findings.push(fail("invalid_value", "value must carry exactly one of number, text or iri."));
    else if (kinds[0] === "number") {
      numeric = true;
      if (typeof value.number !== "number" || !Number.isFinite(value.number)) findings.push(fail("invalid_value", "A numeric value must be a finite number."));
    } else if (kinds[0] === "text") {
      if (!shortText(value.text) || (value.text as string).trim() === "") findings.push(fail("invalid_value", "A text value must be non-empty (4,096 characters at most)."));
    } else if (!isTermIri(value.iri)) {
      findings.push(fail("invalid_iri", "A value IRI must be an absolute http(s) IRI."));
    } else if (value.label !== undefined && !shortText(value.label, 200)) {
      findings.push(fail("invalid_value", "A value label must be text (200 characters at most)."));
    }
  }
  if (numeric) {
    if (row.dimensionless === true) {
      if (row.unitIri !== undefined) findings.push(fail("missing_unit", "A dimensionless measurement must not also declare a unit."));
    } else if (row.unitIri === undefined) {
      findings.push(fail("missing_unit", "A numeric measurement needs a unit IRI, or must be declared dimensionless."));
    } else if (!isTermIri(row.unitIri)) {
      findings.push(fail("invalid_iri", "unitIri must be an absolute http(s) IRI."));
    }
  } else if (row.unitIri !== undefined && !isTermIri(row.unitIri)) {
    findings.push(fail("invalid_iri", "unitIri must be an absolute http(s) IRI."));
  }
  if (row.methodIri !== undefined && !isTermIri(row.methodIri)) findings.push(fail("invalid_iri", "methodIri must be an absolute http(s) IRI."));
  for (const key of ["unitLabel", "method", "determinedBy", "remarks"] as const) {
    if (row[key] !== undefined && !shortText(row[key])) findings.push(fail("invalid_row", `${key} must be text (4,096 characters at most).`));
  }
  if (row.determinedAt !== undefined && (typeof row.determinedAt !== "string" || !DATE_OR_DATETIME.test(row.determinedAt) || Number.isNaN(Date.parse(row.determinedAt)))) {
    findings.push(fail("invalid_date", "determinedAt must be a date (YYYY-MM-DD) or a date-time with a time zone."));
  }
  if (row.uncertainty !== undefined) {
    const uncertainty = row.uncertainty;
    if (!isPlainObject(uncertainty)) findings.push(fail("invalid_row", "uncertainty must be an object."));
    else if (uncertainty.kind !== undefined && !["absolute", "relative", "range", "qualitative"].includes(uncertainty.kind as string)) {
      findings.push(fail("invalid_row", "uncertainty.kind must be absolute, relative, range or qualitative."));
    }
  }
  if (row.attachedTo !== undefined) {
    const attached = row.attachedTo;
    if (!isPlainObject(attached) || !["event", "record", "sample", "media"].includes(attached.kind as string)
      || typeof attached.id !== "string" || !MEASUREMENT_ID.test(attached.id)) {
      findings.push(fail("invalid_row", "attachedTo must name an event, record, sample or media id."));
    }
  }
  return findings;
}

export function validateMeasurementRows(rows: unknown): readonly MeasurementFinding[] {
  if (!Array.isArray(rows)) return [{ code: "invalid_rows", severity: "error", message: "Measurements must be an array." }];
  const findings: MeasurementFinding[] = [];
  if (rows.length > MEASUREMENT_ROW_LIMIT) findings.push({ code: "too_many_rows", severity: "error", message: "A record version can carry at most 500 measurements." });
  const seen = new Set<string>();
  rows.forEach((row: unknown, index: number) => {
    findings.push(...validateRow(row, index));
    if (isPlainObject(row) && typeof row.measurementId === "string") {
      if (seen.has(row.measurementId)) findings.push({ code: "duplicate_measurement_id", severity: "error", row: index, message: "measurementId must be unique within the record version." });
      seen.add(row.measurementId);
    }
  });
  return findings;
}

/** OBIS ExtendedMeasurementOrFact column order used by the tabular projection. */
export const EMOF_COLUMNS = [
  "id",
  "occurrenceID",
  "measurementID",
  "measurementType",
  "measurementTypeID",
  "measurementValue",
  "measurementValueID",
  "measurementAccuracy",
  "measurementUnit",
  "measurementUnitID",
  "measurementDeterminedDate",
  "measurementDeterminedBy",
  "measurementMethod",
  "measurementRemarks",
] as const;

export type EmofRow = Readonly<Record<(typeof EMOF_COLUMNS)[number], string>>;

/**
 * Term IRI of an eMoF column. measurementTypeID, measurementValueID and
 * measurementUnitID are OBIS terms; the others are Darwin Core terms. `id` is
 * the link to the core row and has no term.
 */
export function emofColumnTerm(column: (typeof EMOF_COLUMNS)[number]): string | undefined {
  if (column === "id") return undefined;
  if (column === "measurementTypeID" || column === "measurementValueID" || column === "measurementUnitID") return `http://rs.iobis.org/obis/terms/${column}`;
  return `http://rs.tdwg.org/dwc/terms/${column}`;
}

function uncertaintyText(uncertainty: AssertionUncertainty | undefined): string {
  if (!uncertainty) return "";
  const value = uncertainty.value === undefined ? "" : String(uncertainty.value);
  const parts = [value, uncertainty.unit ?? "", uncertainty.kind ? `(${uncertainty.kind})` : "", uncertainty.note ?? ""].filter((part) => part !== "");
  return parts.join(" ");
}

/**
 * Projects one row to eMoF columns. `coreId` is the event or record identifier
 * the row belongs to; `occurrenceId` is set only for occurrence-level facts.
 */
export function toEmofRow(row: MeasurementRow, coreId: string, occurrenceId = ""): EmofRow {
  const value = row.value;
  const measurementValue = "number" in value ? String(value.number) : "text" in value ? value.text : value.label ?? value.iri;
  return {
    id: coreId,
    occurrenceID: occurrenceId,
    measurementID: row.measurementId,
    measurementType: row.typeLabel,
    measurementTypeID: row.typeIri ?? "",
    measurementValue,
    measurementValueID: "iri" in value ? value.iri : "",
    measurementAccuracy: uncertaintyText(row.uncertainty),
    measurementUnit: row.unitLabel ?? "",
    measurementUnitID: row.unitIri ?? "",
    measurementDeterminedDate: row.determinedAt ?? "",
    measurementDeterminedBy: row.determinedBy ?? "",
    measurementMethod: row.methodIri ? (row.method ? `${row.method} (${row.methodIri})` : row.methodIri) : row.method ?? "",
    measurementRemarks: row.remarks ?? "",
  };
}
