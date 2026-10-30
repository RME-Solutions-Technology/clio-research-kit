import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSchemaReference,
  parseSchemaReference,
  projectSchemaCsvTemplate,
  researchFieldKeyConflicts,
  researchFieldValues,
  researchMeasurementValue,
  researchRowFindings,
  stripTemplateNotes,
} from "../src/research-intake.ts";
import { PROJECT_SCHEMA_FORMAT, type ProjectSchemaDocument } from "../src/research-schema.ts";

// All values are synthetic test data.
const schema: ProjectSchemaDocument = {
  format: PROJECT_SCHEMA_FORMAT,
  schemaKey: "soil-cores",
  version: "1.2.0",
  title: "Soil cores, synthetic",
  extends: { profileId: "clio.profile.structured-survey", profileVersion: "1.0.0" },
  fields: [
    { key: "soilPh", label: "Soil pH", datatype: "number", termIri: "https://example.org/terms/soilPh", dimensionless: true, min: 0, max: 14, requiredAt: "draft", sensitivity: "public", help: "Measured in water, 1:5" },
    { key: "coreDepth", label: "Core depth", datatype: "integer", termIri: "https://example.org/terms/coreDepth", unitIri: "http://qudt.org/vocab/unit/CentiM", unitLabel: "cm", requiredAt: "research_ready", sensitivity: "public" },
    { key: "frozen", label: "Frozen", datatype: "boolean", termIri: "https://example.org/terms/frozen", sensitivity: "public" },
    { key: "horizon", label: "Horizon", datatype: "enum", termIri: "https://example.org/terms/horizon", vocabulary: [{ value: "A" }, { value: "B" }], sensitivity: "public" },
    { key: "oldCode", label: "Old code", datatype: "string", termIri: "https://example.org/terms/oldCode", sensitivity: "public", deprecated: { since: "1.1.0", replacedBy: "horizon" } },
  ],
};

const depth = { measurementId: "m1", typeIri: "https://example.org/terms/depth", typeLabel: "Depth", value: { number: 6.5 }, unitIri: "http://qudt.org/vocab/unit/M" };

test("schema references parse from text or objects and reject anything else", () => {
  assert.deepEqual(parseSchemaReference("soil-cores@1.2.0"), { schemaKey: "soil-cores", version: "1.2.0" });
  assert.deepEqual(parseSchemaReference({ schemaKey: "soil-cores", version: "1.2.0" }), { schemaKey: "soil-cores", version: "1.2.0" });
  for (const bad of ["soil-cores", "@1.0.0", "Soil@1.0.0", "soil@1.0", "soil@01.0.0", 42, null, { schemaKey: "soil" }]) assert.equal(parseSchemaReference(bad), null, String(bad));
  assert.equal(formatSchemaReference(schema), "soil-cores@1.2.0");
});

test("field keys may not collide with preset columns or reserved import columns", () => {
  const clash = { ...schema, fields: [...schema.fields, { ...schema.fields[2]!, key: "event_date" }, { ...schema.fields[2]!, key: "measurements" }, { ...schema.fields[2]!, key: "title" }] };
  assert.deepEqual(researchFieldKeyConflicts(clash, ["sourceId", "eventDate", "siteId"]), ["event_date", "measurements", "title"]);
  assert.deepEqual(researchFieldKeyConflicts(schema, ["sourceId", "eventDate"]), []);
});

test("CSV cells convert numbers and booleans only when they parse cleanly", () => {
  const values = researchFieldValues(schema, { soilPh: " 6.5 ", coreDepth: "12", frozen: "Yes", horizon: "A", oldCode: "", other: "ignored" }, "csv");
  assert.deepEqual(values, { soilPh: 6.5, coreDepth: 12, frozen: true, horizon: "A" });
  assert.deepEqual(researchFieldValues(schema, { soilPh: "about six", frozen: "maybe" }, "csv"), { soilPh: "about six", frozen: "maybe" });
  assert.deepEqual(researchFieldValues(schema, { soilPh: "6.5" }, "json"), { soilPh: "6.5" }, "JSON values are never coerced");
});

test("measurements come from a JSON array, or JSON text in a CSV cell", () => {
  assert.deepEqual(researchMeasurementValue({}, "csv"), { present: false });
  assert.deepEqual(researchMeasurementValue({ measurements: "" }, "csv"), { present: false });
  assert.deepEqual(researchMeasurementValue({ measurements: JSON.stringify([depth]) }, "csv"), { present: true, rows: [depth] });
  assert.deepEqual(researchMeasurementValue({ measurements: [depth] }, "json"), { present: true, rows: [depth] });
  assert.equal(researchMeasurementValue({ measurements: "[not json" }, "csv").finding?.code, "measurement.invalid_rows");
});

test("row findings use stable prefixed codes and separate draft errors from later requirements", () => {
  const ok = researchRowFindings({ schema, fields: { soilPh: 6.5 }, measurements: { present: true, rows: [depth] } });
  assert.deepEqual(ok.map((item) => [item.severity, item.code, item.field]), [["warning", "project-schema.required_for_research_ready", "coreDepth"]]);
  assert.equal(ok[0]!.schema, "soil-cores@1.2.0");
  assert.equal(ok[0]!.termIri, "https://example.org/terms/coreDepth");

  const bad = researchRowFindings({
    schema,
    deprecated: true,
    fields: { soilPh: "about six", horizon: "C", oldCode: "x1" },
    measurements: { present: true, rows: [{ ...depth, unitIri: undefined }] },
  });
  const codes = bad.map((item) => `${item.severity}:${item.code}:${item.field}`);
  assert.ok(codes.includes("warning:project-schema.version_deprecated:projectSchema"));
  assert.ok(codes.includes("error:project-schema.invalid_datatype:soilPh"));
  assert.ok(codes.includes("error:project-schema.invalid_enum:horizon"));
  assert.ok(codes.includes("warning:project-schema.deprecated_field:oldCode"));
  assert.ok(codes.includes("error:measurement.missing_unit:measurements[0]"));
  assert.match(bad.find((item) => item.code === "project-schema.invalid_datatype")!.message, /^Soil pH: Expected a finite number\./u);

  const missing = researchRowFindings({ schema, fields: {} });
  assert.deepEqual(missing.filter((item) => item.severity === "error").map((item) => item.code), ["project-schema.required_field"]);

  const unknown = researchRowFindings({ requested: { schemaKey: "soil-cores", version: "9.0.0" } });
  assert.deepEqual(unknown.map((item) => [item.severity, item.code]), [["error", "project-schema.version_unknown"]]);
});

test("the CSV template carries one note per column, then a header that parses back", () => {
  const presetFields = [{ key: "sourceId", label: "Source record ID", requiredForRelease: true }, { key: "eventDate", label: "Survey date", requiredForDraft: true }];
  const template = projectSchemaCsvTemplate(schema, presetFields);
  assert.ok(template);
  const lines = template.split("\r\n").filter(Boolean);
  const header = lines.at(-1)!;
  assert.equal(header, "sourceId,eventDate,title,soilPh,coreDepth,frozen,horizon,measurements", "deprecated fields are left out of new templates");
  assert.ok(lines.slice(0, -1).every((line) => /^"?#/u.test(line)));
  assert.ok(lines.some((line) => line.includes("Unit: cm http://qudt.org/vocab/unit/CentiM.")));
  assert.ok(lines.some((line) => line.includes("One of: A | B.")));
  assert.ok(lines.some((line) => line.includes("Measured in water, 1:5")));
  const stripped = stripTemplateNotes(`\uFEFF${template}SRC-1,2026-10-01,Core one,6.5,12,false,A,\r\n# not a note: data\r\n`);
  assert.equal(stripped.removed, lines.length - 1);
  assert.ok(stripped.content.startsWith(`\uFEFF${header}\r\n`));
  assert.ok(stripped.content.includes("# not a note: data"), "only the leading block is removed");
  const wide = { ...schema, fields: Array.from({ length: 70 }, (_, index) => ({ ...schema.fields[2]!, key: `flag${index}` })) };
  assert.equal(projectSchemaCsvTemplate(wide, presetFields), null);
});
