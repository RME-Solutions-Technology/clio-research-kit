import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT_SCHEMA_FORMAT,
  canonicalProjectSchema,
  checkProjectSchemaVersion,
  projectSchemaDigest,
  toJsonSchema,
  validateProjectSchemaData,
  validateProjectSchemaDocument,
  type ProjectSchemaDocument,
  type ProjectSchemaField,
} from "../src/research-schema.ts";

// Synthetic team schema. IRIs are real vocabulary shapes; no real project data.
const temperature: ProjectSchemaField = {
  key: "waterTemperature",
  label: "Water temperature",
  datatype: "number",
  termIri: "http://vocab.nerc.ac.uk/collection/P01/current/TEMPPR01/",
  unitIri: "http://vocab.nerc.ac.uk/collection/P06/current/UPAA/",
  unitLabel: "degrees Celsius",
  min: -5,
  max: 45,
  requiredAt: "research_ready",
  sensitivity: "public",
};

const zone: ProjectSchemaField = {
  key: "reefZone",
  label: "Reef zone",
  datatype: "enum",
  termIri: "https://example.org/terms/reefZone",
  vocabulary: [{ value: "crest" }, { value: "slope" }, { value: "flat", iri: "https://example.org/terms/reefFlat" }],
  sensitivity: "public",
};

const v1: ProjectSchemaDocument = {
  format: PROJECT_SCHEMA_FORMAT,
  schemaKey: "reef-transect",
  version: "1.0.0",
  title: "Reef transect extras",
  extends: { profileId: "clio.profile.structured-survey", profileVersion: "1.0.0" },
  fields: [temperature, zone],
};

function codes(findings: readonly { code: string }[]): string[] {
  return findings.map((item) => item.code);
}

test("a well-formed project schema has no findings", () => {
  assert.deepEqual(validateProjectSchemaDocument(v1), []);
});

test("every field must say what it means, unless flagged local", () => {
  const missing = { ...v1, fields: [{ ...zone, termIri: null }] };
  assert.deepEqual(codes(validateProjectSchemaDocument(missing)), ["missing_term_iri"]);
  const local = { ...v1, fields: [{ ...zone, termIri: null, localTerm: true }] };
  assert.deepEqual(validateProjectSchemaDocument(local), []);
  const bad = { ...v1, fields: [{ ...zone, termIri: "reefZone" }] };
  assert.deepEqual(codes(validateProjectSchemaDocument(bad)), ["invalid_iri"]);
});

test("numeric fields need a unit or an explicit dimensionless flag", () => {
  const { unitIri: _unit, ...noUnit } = temperature;
  assert.deepEqual(codes(validateProjectSchemaDocument({ ...v1, fields: [noUnit] })), ["missing_unit"]);
  assert.deepEqual(validateProjectSchemaDocument({ ...v1, fields: [{ ...noUnit, dimensionless: true }] }), []);
});

test("a project schema cannot shadow a profile field or extend an unknown profile", () => {
  const shadow = { ...v1, fields: [{ ...zone, key: "method" }] };
  assert.ok(codes(validateProjectSchemaDocument(shadow)).includes("profile_field_collision"));
  assert.deepEqual(codes(validateProjectSchemaDocument({ ...v1, extends: { profileId: "clio.profile.structured-survey", profileVersion: "9.9.9" } })), ["unknown_profile"]);
});

test("structural limits and key rules fail closed", () => {
  assert.ok(codes(validateProjectSchemaDocument({ ...v1, schemaKey: "Reef Transect" })).includes("invalid_schema_key"));
  assert.ok(codes(validateProjectSchemaDocument({ ...v1, version: "1.0" })).includes("invalid_version"));
  assert.ok(codes(validateProjectSchemaDocument({ ...v1, fields: [zone, zone] })).includes("duplicate_field"));
  assert.ok(codes(validateProjectSchemaDocument({ ...v1, fields: [{ ...temperature, min: 50 }] })).includes("invalid_range"));
  assert.ok(codes(validateProjectSchemaDocument({ ...v1, fields: [{ ...zone, requiredAt: "archive_accepted" }] })).includes("invalid_readiness"));
  assert.ok(codes(validateProjectSchemaDocument({ ...v1, fields: [{ ...zone, vocabulary: [] }] })).includes("invalid_vocabulary"));
  assert.deepEqual(codes(validateProjectSchemaDocument(null)), ["invalid_document"]);
});

test("canonical form and digest are stable regardless of key order", async () => {
  const reordered = JSON.parse(JSON.stringify({ fields: v1.fields, title: v1.title, extends: v1.extends, version: v1.version, schemaKey: v1.schemaKey, format: v1.format })) as ProjectSchemaDocument;
  assert.equal(canonicalProjectSchema(reordered), canonicalProjectSchema(v1));
  const digest = await projectSchemaDigest(v1);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(await projectSchemaDigest(reordered), digest);
});

test("additive changes are minor; meaning, type, unit or tightening changes are major", () => {
  const addOptional = { ...v1, version: "1.1.0", fields: [...v1.fields, { ...zone, key: "observerCount", datatype: "integer" as const, vocabulary: undefined, termIri: "https://example.org/terms/observerCount", dimensionless: true }] };
  assert.deepEqual(checkProjectSchemaVersion(v1, addOptional), { required: "minor", declared: "minor", findings: [] });

  const addValue = { ...v1, version: "1.1.0", fields: [temperature, { ...zone, vocabulary: [...(zone.vocabulary ?? []), { value: "lagoon" }] }] };
  assert.equal(checkProjectSchemaVersion(v1, addValue).required, "minor");

  const deprecate = { ...v1, version: "1.1.0", fields: [temperature, { ...zone, deprecated: { since: "1.1.0" } }] };
  assert.equal(checkProjectSchemaVersion(v1, deprecate).required, "minor");

  const relabel = { ...v1, version: "1.0.1", fields: [{ ...temperature, label: "Sea temperature" }, zone] };
  assert.equal(checkProjectSchemaVersion(v1, relabel).required, "patch");

  const removeField = { ...v1, version: "1.1.0", fields: [temperature] };
  const removed = checkProjectSchemaVersion(v1, removeField);
  assert.equal(removed.required, "major");
  assert.deepEqual(codes(removed.findings), ["version_bump_too_small"]);

  for (const changed of [
    { ...temperature, unitIri: "http://vocab.nerc.ac.uk/collection/P06/current/UPKA/" },
    { ...temperature, termIri: "https://example.org/terms/otherTemperature" },
    { ...temperature, datatype: "integer" as const },
    { ...temperature, requiredAt: "referenceable" as const },
    { ...temperature, max: 40 },
  ]) {
    assert.equal(checkProjectSchemaVersion(v1, { ...v1, version: "2.0.0", fields: [changed, zone] }).required, "major");
  }
  const newRequired = { ...v1, version: "1.1.0", fields: [...v1.fields, { ...zone, key: "siteCode", datatype: "string" as const, vocabulary: undefined, requiredAt: "doi_ready" as const }] };
  assert.equal(checkProjectSchemaVersion(v1, newRequired).required, "major");
});

test("published versions are never edited and the schema line cannot move profile", () => {
  assert.deepEqual(codes(checkProjectSchemaVersion(v1, { ...v1 }).findings), ["version_not_increased"]);
  const moved = checkProjectSchemaVersion(v1, { ...v1, version: "2.0.0", extends: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0" } });
  assert.ok(codes(moved.findings).includes("profile_changed"));
  assert.ok(codes(checkProjectSchemaVersion(v1, { ...v1, version: "2.0.0", schemaKey: "other-key" }).findings).includes("schema_key_changed"));
});

test("record values are checked by type, vocabulary, range and readiness", () => {
  assert.deepEqual(validateProjectSchemaData(v1, { waterTemperature: 24.5, reefZone: "crest" }, "research_ready"), []);
  assert.deepEqual(codes(validateProjectSchemaData(v1, {}, "research_ready")), ["required_field"]);
  assert.deepEqual(validateProjectSchemaData(v1, {}, "referenceable"), []);
  assert.deepEqual(codes(validateProjectSchemaData(v1, { waterTemperature: "warm" }, "draft")), ["invalid_datatype"]);
  assert.deepEqual(codes(validateProjectSchemaData(v1, { waterTemperature: 80 }, "draft")), ["out_of_range"]);
  assert.deepEqual(codes(validateProjectSchemaData(v1, { reefZone: "reef" }, "draft")), ["invalid_enum"]);
  assert.deepEqual(codes(validateProjectSchemaData(v1, { colour: "blue" }, "draft")), ["unknown_field"]);
  const deprecated = { ...v1, version: "1.1.0", fields: [temperature, { ...zone, deprecated: { since: "1.1.0" } }] };
  const findings = validateProjectSchemaData(deprecated, { reefZone: "crest" }, "draft");
  assert.deepEqual(findings.map((item) => [item.code, item.severity]), [["deprecated_field", "warning"]]);
});

test("JSON Schema interchange carries terms, units and readiness-specific required fields", () => {
  const schema = toJsonSchema(v1, { id: "schemas/reef-transect/1.0.0.schema.json", readiness: "research_ready" });
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["waterTemperature"]);
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.waterTemperature["x-clio-unitIri"], temperature.unitIri);
  assert.equal(properties.waterTemperature.maximum, 45);
  assert.deepEqual(properties.reefZone.enum, ["crest", "slope", "flat"]);
  assert.deepEqual(toJsonSchema(v1, { id: "x", readiness: "draft" }).required, []);
});
