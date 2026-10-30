import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  validateApplicationProfileData,
  type ApplicationProfile,
  type FieldDefinition,
} from "../src/application-profiles.ts";
import { DEFAULT_LICENCE_URI } from "../src/licensing.ts";
import { generateSchemaFiles, profileSchemaPath, profileToJsonSchema, schemaProfiles } from "../src/schema-generator.ts";

const schemasDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

function filesOnDisk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesOnDisk(full));
    else if (entry.name.endsWith(".json")) found.push(relative(schemasDirectory, full).replaceAll("\\", "/"));
  }
  return found.sort();
}

test("snapshot: schemas/ matches what the generator writes, with no stale files", () => {
  const generated = generateSchemaFiles();
  for (const file of generated) {
    assert.ok(existsSync(join(schemasDirectory, file.path)), `missing ${file.path}; run pnpm run schemas:generate`);
    assert.equal(readFileSync(join(schemasDirectory, file.path), "utf8"), file.text, `${file.path} is out of date; run pnpm run schemas:generate`);
  }
  assert.deepEqual(filesOnDisk(schemasDirectory), generated.map((file) => file.path).sort());
});

test("every registered profile version has a schema, and the human osteology profile has none", () => {
  const profiles = schemaProfiles();
  assert.equal(profiles.length, 25, "14 profile ids, 25 immutable versions");
  assert.equal(new Set(profiles.map((profile) => profile.id)).size, 14);
  assert.equal(profiles.some((profile) => profile.launchable === false), false);
  const generated = generateSchemaFiles();
  const everything = generated.map((file) => file.path).join("\n") + generated.map((file) => file.text).join("\n");
  assert.doesNotMatch(everything, /osteolog/iu);
  const index = JSON.parse(readFileSync(join(schemasDirectory, "index.json"), "utf8")) as { profiles: { id: string; version: string; current: boolean; schema: string }[] };
  assert.equal(index.profiles.length, 25);
  assert.equal(index.profiles.filter((entry) => entry.current).length, 14, "one current version per profile");
  for (const entry of index.profiles) assert.ok(existsSync(join(schemasDirectory, entry.schema)), entry.schema);
});

test("the schema of one version carries ids, readiness data, term IRIs and vocabularies", () => {
  const profile = schemaProfiles().find((item) => item.id === "clio.profile.biological-occurrence" && item.version === "1.1.0")!;
  const schema = profileToJsonSchema(profile) as Record<string, any>;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "urn:clio:schema:biological-occurrence:1.1.0");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, profile.fields.filter((field) => field.requiredAt === "draft").map((field) => field.key));
  assert.equal(schema.properties.rightsLicense.default, DEFAULT_LICENCE_URI);
  assert.equal(schema.properties.observedOn["x-clio-termIri"], "http://rs.tdwg.org/dwc/terms/eventDate");
  assert.ok(schema["x-clio-qualityChecks"], "1.1 profiles carry their quality checks as data");
  assert.ok(Object.keys(schema["x-clio-requiredBy"]).includes("referenceable"));
  const enumField = profile.fields.find((field) => field.datatype === "enum" && field.vocabulary !== undefined)!;
  assert.deepEqual(schema.properties[enumField.key].anyOf[0].enum, [...enumField.vocabulary!]);
  assert.equal(profileSchemaPath(profile), "profiles/biological-occurrence/1.1.0.schema.json");
});

// ---------------------------------------------------------------------------
// The JSON Schema and the TypeScript validator must agree on shape.

function sample(field: FieldDefinition): unknown {
  if (field.key === "rightsLicense") return DEFAULT_LICENCE_URI;
  if (field.vocabulary !== undefined) return field.datatype === "string_array" ? [field.vocabulary[0]] : field.vocabulary[0];
  switch (field.datatype) {
    case "string":
    case "identifier":
      return "synthetic";
    case "uri":
      return "https://example.org/synthetic";
    case "date":
    case "date_or_interval":
      return "2026-09-01";
    case "datetime":
      return "2026-09-01T00:00:00Z";
    case "integer":
    case "number":
      return Math.max(1, field.min ?? 1);
    case "latitude":
      return -33.8;
    case "longitude":
      return 151.2;
    case "boolean":
      return true;
    case "string_array":
      return ["synthetic"];
    case "number_array":
      return [1];
    case "json":
      return {};
    case "enum":
      throw new Error(`enum field ${field.key} has no vocabulary`);
  }
}

function draftData(profile: ApplicationProfile): Record<string, unknown> {
  return Object.fromEntries(profile.fields.filter((field) => field.requiredAt === "draft").map((field) => [field.key, sample(field)]));
}

const ajv = new Ajv2020({ strict: false, allErrors: false });
addFormats.default(ajv);

function compile(profile: ApplicationProfile) {
  const schema = profileToJsonSchema(profile);
  return ajv.getSchema(schema.$id as string) ?? ajv.compile(schema);
}

test("every generated schema compiles under JSON Schema 2020-12", () => {
  for (const profile of schemaProfiles()) {
    assert.doesNotThrow(() => compile(profile), `${profile.id}@${profile.version}`);
  }
});

test("data the profile validator accepts at draft passes the schema; unknown, missing and out-of-vocabulary values fail both", () => {
  for (const profile of schemaProfiles()) {
    const label = `${profile.id}@${profile.version}`;
    const validate = compile(profile);
    const data = draftData(profile);
    const reference = validateApplicationProfileData(profile.id, profile.version, data, "draft", { now: new Date("2026-10-01T00:00:00Z") });
    assert.equal(reference.valid, true, `${label}: sample data should satisfy the TypeScript validator: ${JSON.stringify(reference.findings)}`);
    assert.equal(validate(data), true, `${label}: ${JSON.stringify(validate.errors)}`);

    const firstKey = Object.keys(data)[0]!;
    const wrapped = { ...data, [firstKey]: { value: data[firstKey], source: "field notebook" } };
    assert.equal(validate(wrapped), true, `${label}: wrapped value`);
    assert.equal(validateApplicationProfileData(profile.id, profile.version, wrapped, "draft").valid, true, `${label}: wrapped value (reference)`);

    assert.equal(validate({ ...data, notAField: 1 }), false, `${label}: unknown field`);
    assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...data, notAField: 1 }, "draft").valid, false);

    const { [firstKey]: _omitted, ...rest } = data;
    assert.equal(validate(rest), false, `${label}: missing ${firstKey}`);
    assert.equal(validateApplicationProfileData(profile.id, profile.version, rest, "draft").valid, false);

    const enumField = profile.fields.find((field) => field.datatype === "enum" && field.vocabulary !== undefined);
    if (enumField) {
      const bad = { ...data, [enumField.key]: "not-in-the-vocabulary" };
      assert.equal(validate(bad), false, `${label}: enum ${enumField.key}`);
      assert.equal(validateApplicationProfileData(profile.id, profile.version, bad, "draft").valid, false);
    }
  }
});

test("range limits agree: latitude outside the globe is rejected by both", () => {
  const profile = schemaProfiles().find((item) => item.fields.some((field) => field.datatype === "latitude"));
  if (!profile) return;
  const latitude = profile.fields.find((field) => field.datatype === "latitude")!;
  const validate = compile(profile);
  const data = { ...draftData(profile), [latitude.key]: 95 };
  assert.equal(validate(data), false);
  assert.equal(validateApplicationProfileData(profile.id, profile.version, data, "draft").valid, false);
});

test("vocabularies.json carries the lane pick-lists and the pollen morphology vocabulary", () => {
  const document = JSON.parse(readFileSync(join(schemasDirectory, "vocabularies.json"), "utf8")) as { lane: Record<string, unknown>; pollenMorphology: { traits: unknown[] } };
  assert.ok(Array.isArray(document.lane.LANE_SEX));
  assert.ok("LANE_BASIS_OF_RECORD_IRIS" in document.lane);
  assert.equal(typeof document.lane.LANE_ENVO_IRI_PATTERN, "string");
  assert.ok(document.pollenMorphology.traits.length > 0);
});
