import {
  FIELD_DATATYPES,
  READINESS_LEVELS,
  listApplicationProfiles,
  type ApplicationProfile,
  type FieldDefinition,
} from "./application-profiles.ts";
import * as laneVocabularies from "./lane-vocabularies.ts";
import { DEFAULT_LICENCE_URI } from "./licensing.ts";
import { POLLEN_MORPHOLOGY_VOCABULARY } from "./pollen-vocabulary.ts";

/**
 * Turns the lane profiles into JSON Schema 2020-12 files.
 *
 * The profile registry in TypeScript stays the source of truth. These files
 * are generated from it, so other tools (forms, validators, spreadsheets,
 * other languages) can read the same field lists, vocabularies and readiness
 * levels without running this package.
 *
 * What a schema can and cannot say:
 * - types, enums, ranges, patterns and unknown-field rejection are enforced;
 * - `required` lists the fields needed at `draft`. Fields needed at a higher
 *   readiness level carry `x-clio-requiredAt`, and the top-level
 *   `x-clio-requiredBy` lists them per level;
 * - every field value may be a plain value or an assertion wrapper
 *   (`{ value, source, uncertainty, visibility, unit, method }`);
 * - cross-field rules (conditional requirements, ordered pairs, count versus
 *   status) are carried in `x-clio-qualityChecks` as data and are NOT enforced
 *   by JSON Schema; use `validateApplicationProfileData` for them.
 */

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { [key: string]: Json };

export type GeneratedSchemaFile = Readonly<{ path: string; text: string }>;

/** Short name used in file paths: the profile id without its `clio.profile.` prefix. */
export function profileShortName(profileId: string): string {
  return profileId.replace(/^clio\.profile\./u, "");
}

export function profileSchemaPath(profile: Pick<ApplicationProfile, "id" | "version">): string {
  return `profiles/${profileShortName(profile.id)}/${profile.version}.schema.json`;
}

/**
 * Every non-standard keyword the generated schemas use. A strict validator (Ajv's default) refuses unknown
 * keywords, so register these first: `ajv.addVocabulary([...SCHEMA_KEYWORDS])`. They are annotations; none changes validation.
 */
export const SCHEMA_KEYWORDS: readonly string[] = Object.freeze([
  "x-clio-section", "x-clio-sensitivity", "x-clio-requiredAt", "x-clio-termIri", "x-clio-units", "x-clio-unitRequiredAt",
  "x-clio-vocabularyIris", "x-clio-storedIn", "x-clio-profileId", "x-clio-profileVersion", "x-clio-status", "x-clio-launchable",
  "x-clio-conformanceClaim", "x-clio-readinessLevels", "x-clio-requiredBy", "x-clio-standardReferences", "x-clio-qualityChecks",
  "x-clio-unsupportedReason",
]);

export function profileSchemaId(profile: Pick<ApplicationProfile, "id" | "version">): string {
  return `urn:clio:schema:${profileShortName(profile.id)}:${profile.version}`;
}

/**
 * A real calendar day as a pattern: month lengths are enforced, and 29 February only in a leap year
 * (divisible by 4, except centuries not divisible by 400). 2026-02-31 does not match.
 */
const LEAP_YEAR = "(?:\\d\\d(?:0[48]|[2468][048]|[13579][26])|(?:0[048]|[2468][048]|[13579][26])00)";
const DAY_BODY = "(?:\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|02-(?:0[1-9]|1\\d|2[0-8]))|" + LEAP_YEAR + "-02-29)";
const DATE = "^" + DAY_BODY + "$";
/** A day, or start/end. The pattern cannot say that start is not after end; the TypeScript validator does. */
const DATE_OR_INTERVAL = "^" + DAY_BODY + "(?:/" + DAY_BODY + ")?$";

function valueSchema(field: FieldDefinition): JsonObject {
  const vocabulary = field.vocabulary === undefined ? undefined : [...field.vocabulary];
  switch (field.datatype) {
    case "string":
    case "identifier":
      return { type: "string", ...(field.pattern === undefined ? {} : { pattern: field.pattern }) };
    case "uri":
      return { type: "string", format: "uri", ...(field.pattern === undefined ? {} : { pattern: field.pattern }) };
    case "date":
      return { type: "string", pattern: DATE };
    case "date_or_interval":
      return { type: "string", pattern: DATE_OR_INTERVAL };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "enum":
      return { type: "string", ...(vocabulary === undefined ? {} : { enum: vocabulary }) };
    case "integer":
      return { type: "integer", ...(field.min === undefined ? {} : { minimum: field.min }), ...(field.max === undefined ? {} : { maximum: field.max }) };
    case "number":
      return { type: "number", ...(field.min === undefined ? {} : { minimum: field.min }), ...(field.max === undefined ? {} : { maximum: field.max }) };
    case "latitude":
      return { type: "number", minimum: Math.max(-90, field.min ?? -90), maximum: Math.min(90, field.max ?? 90) };
    case "longitude":
      return { type: "number", minimum: Math.max(-180, field.min ?? -180), maximum: Math.min(180, field.max ?? 180) };
    case "boolean":
      return { type: "boolean" };
    case "string_array":
      return {
        type: "array",
        items: vocabulary === undefined
          ? { type: "string", ...(field.pattern === undefined ? {} : { pattern: field.pattern }) }
          : { type: "string", enum: vocabulary },
      };
    case "number_array":
      return { type: "array", items: { type: "number" } };
    case "json":
      return {};
  }
}

/**
 * International Chronostratigraphic Chart terms are referenced by IRI only: the ICS permissions policy is non-commercial and
 * unmodified use, so unit labels are not redistributed in vocabularies or annotations. A label-to-IRI map whose IRIs are
 * ICS chart concepts becomes a sorted list of IRIs. (A pick-list's own enum values are the profile's local codes and are
 * unchanged: see schemas/SOURCES.md.)
 */
function vocabularyIrisAnnotation(map: Readonly<Record<string, string>>): Json {
  const iris = Object.values(map);
  if (iris.length > 0 && iris.every((iri) => iri.startsWith(`${laneVocabularies.LANE_ICS_CHART_BASE}/`))) return [...new Set(iris)].sort();
  return { ...map };
}

function fieldSchema(field: FieldDefinition): JsonObject {
  const value = valueSchema(field);
  const wrapped: JsonObject = {
    $ref: "#/$defs/assertion",
    properties: field.units === undefined ? { value } : { value, unit: { type: "string", enum: [...field.units] } },
  };
  const schema: JsonObject = {
    title: field.label,
    description: field.help,
    anyOf: [value, wrapped],
    "x-clio-section": field.section,
    "x-clio-sensitivity": field.sensitivity,
  };
  if (field.example !== undefined) schema.examples = [field.example];
  if (field.requiredAt !== undefined) schema["x-clio-requiredAt"] = field.requiredAt;
  if (field.termIri !== undefined) schema["x-clio-termIri"] = field.termIri;
  if (field.units !== undefined) schema["x-clio-units"] = [...field.units];
  if (field.unitRequiredAt !== undefined) schema["x-clio-unitRequiredAt"] = field.unitRequiredAt;
  if (field.vocabularyIris !== undefined) schema["x-clio-vocabularyIris"] = vocabularyIrisAnnotation(field.vocabularyIris);
  if (field.storedIn !== undefined) schema["x-clio-storedIn"] = field.storedIn;
  if (field.key === "rightsLicense") schema.default = DEFAULT_LICENCE_URI;
  return schema;
}

/** The JSON Schema for one registered profile version. Pure; output is deterministic. */
export function profileToJsonSchema(profile: ApplicationProfile): JsonObject {
  const properties: JsonObject = {};
  const requiredBy: JsonObject = {};
  for (const level of READINESS_LEVELS) {
    const keys = profile.fields.filter((field) => field.requiredAt === level).map((field) => field.key);
    if (keys.length > 0) requiredBy[level] = keys;
  }
  for (const field of profile.fields) properties[field.key] = fieldSchema(field);
  const schema: JsonObject = {
    $schema: JSON_SCHEMA_DIALECT,
    $id: profileSchemaId(profile),
    $comment: "SPDX-License-Identifier: CC-BY-4.0. See schemas/LICENSE. Generated by scripts/generate-schemas.ts; do not edit by hand.",
    title: profile.title,
    description: profile.description,
    type: "object",
    properties,
    required: profile.fields.filter((field) => field.requiredAt === "draft").map((field) => field.key),
    additionalProperties: false,
    $defs: {
      assertion: {
        description: "A value with provenance. Use it when a field's source, method, unit, uncertainty or visibility matters.",
        type: "object",
        properties: {
          value: {},
          source: { type: "string", minLength: 1 },
          uncertainty: {},
          visibility: { enum: ["public", "sensitive", "restricted"] },
          unit: { type: "string", minLength: 1 },
          method: { type: "string", minLength: 1 },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
    "x-clio-profileId": profile.id,
    "x-clio-profileVersion": profile.version,
    "x-clio-status": profile.status,
    "x-clio-launchable": profile.launchable,
    "x-clio-conformanceClaim": profile.conformanceClaim,
    "x-clio-readinessLevels": [...READINESS_LEVELS],
    "x-clio-requiredBy": requiredBy,
    "x-clio-standardReferences": profile.standardReferences.map((reference) => ({ ...reference })) as unknown as Json,
  };
  if (profile.qualityChecks !== undefined) schema["x-clio-qualityChecks"] = JSON.parse(JSON.stringify(profile.qualityChecks)) as Json;
  if (profile.unsupportedReason !== undefined) schema["x-clio-unsupportedReason"] = profile.unsupportedReason;
  return schema;
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const object = value as { readonly [key: string]: Json };
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortKeys(object[key]!)]));
  }
  return value;
}

/** Two-space JSON with a trailing newline. Keys of vocabulary maps are sorted; schema keys keep their authored order. */
function render(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every `LANE_*` pick-list, IRI map and pattern, plus the pollen morphology vocabulary, as one JSON document. */
export function vocabulariesDocument(): JsonObject {
  const lists: JsonObject = {};
  for (const [name, value] of Object.entries(laneVocabularies).sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (typeof value === "function") continue;
    // ICS unit labels are not redistributed pending permission; the IRIs are (see schemas/SOURCES.md).
    if (name === "LANE_GEOLOGIC_AGE_UNITS") continue;
    if (name === "LANE_GEOLOGIC_AGE_IRIS") { lists[name] = [...new Set(Object.values(value as Record<string, string>))].sort(); continue; }
    lists[name] = sortKeys(JSON.parse(JSON.stringify(value)) as Json);
  }
  return {
    $comment: "Generated from src/lane-vocabularies.ts and src/pollen-vocabulary.ts. Do not edit by hand.",
    lane: lists,
    pollenMorphology: JSON.parse(JSON.stringify(POLLEN_MORPHOLOGY_VOCABULARY)) as Json,
  };
}

function indexDocument(profiles: readonly ApplicationProfile[]): JsonObject {
  const current = new Set(listApplicationProfiles({ includeUnsupported: true }).map((profile) => `${profile.id}@${profile.version}`));
  return {
    $comment: "Generated by scripts/generate-schemas.ts. Do not edit by hand.",
    dialect: JSON_SCHEMA_DIALECT,
    keywords: [...SCHEMA_KEYWORDS],
    keywordsNote: "Annotation keywords used in the profile schemas. A strict validator needs them registered first, for example ajv.addVocabulary(index.keywords).",
    readinessLevels: [...READINESS_LEVELS],
    fieldDatatypes: [...FIELD_DATATYPES],
    profiles: profiles.map((profile) => ({
      id: profile.id,
      version: profile.version,
      title: profile.title,
      current: current.has(`${profile.id}@${profile.version}`),
      schema: profileSchemaPath(profile),
      fieldCount: profile.fields.length,
    })),
  };
}

/** Profiles that get a schema: every registered, launchable version, historical ones included. */
export function schemaProfiles(): readonly ApplicationProfile[] {
  return [...listApplicationProfiles({ includeHistorical: true })]
    .sort((left, right) => (left.id !== right.id ? (left.id < right.id ? -1 : 1) : compareVersions(left.version, right.version)));
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** All generated files, relative to the `schemas/` directory. */
export function generateSchemaFiles(): readonly GeneratedSchemaFile[] {
  const profiles = schemaProfiles();
  return [
    { path: "index.json", text: render(indexDocument(profiles)) },
    { path: "vocabularies.json", text: render(vocabulariesDocument()) },
    ...profiles.map((profile) => ({ path: profileSchemaPath(profile), text: render(profileToJsonSchema(profile)) })),
  ];
}
