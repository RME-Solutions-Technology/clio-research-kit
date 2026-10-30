import assert from "node:assert/strict";
import test from "node:test";
import { EMOF_COLUMNS, toEmofRow, validateMeasurementRows, type MeasurementRow } from "../src/measurement-rows.ts";
import {
  ResearchPackageError,
  buildResearchPackage,
  toCsv,
  verifyResearchPackage,
  type PackageFile,
  type ResearchPackageInput,
} from "../src/research-package.ts";
import { PROJECT_SCHEMA_FORMAT, type ProjectSchemaDocument } from "../src/research-schema.ts";

// All values are synthetic test data.
const schema: ProjectSchemaDocument = {
  format: PROJECT_SCHEMA_FORMAT,
  schemaKey: "reef-transect",
  version: "1.0.0",
  title: "Reef transect extras",
  extends: { profileId: "clio.profile.structured-survey", profileVersion: "1.0.0" },
  fields: [
    {
      key: "waterTemperature", label: "Water temperature", datatype: "number",
      termIri: "http://vocab.nerc.ac.uk/collection/P01/current/TEMPPR01/",
      unitIri: "http://vocab.nerc.ac.uk/collection/P06/current/UPAA/", sensitivity: "public",
    },
    { key: "reefZone", label: "Reef zone", datatype: "enum", termIri: "https://example.org/terms/reefZone", vocabulary: [{ value: "crest" }, { value: "slope" }], sensitivity: "public" },
  ],
};

const depth: MeasurementRow = {
  measurementId: "m1",
  typeIri: "http://vocab.nerc.ac.uk/collection/P01/current/ADEPZZ01/",
  typeLabel: "Depth",
  value: { number: 6.5 },
  unitIri: "http://vocab.nerc.ac.uk/collection/P06/current/ULAA/",
  unitLabel: "metres",
  method: "Dive computer",
  uncertainty: { value: 0.5, unit: "m", kind: "absolute" },
  determinedAt: "2026-10-01",
};

const cover: MeasurementRow = {
  measurementId: "m2",
  typeIri: null,
  localTerm: true,
  typeLabel: "Visual bleaching score",
  value: { text: "moderate, \"patchy\"" },
  remarks: "line one\nline two",
};

function input(overrides: Partial<ResearchPackageInput> = {}): ResearchPackageInput {
  return {
    packageId: "pkg-test-0001",
    // These records carry flat coordinates and no stated location visibility; this suite is not about location privacy.
    missingVisibility: "public",
    title: "Synthetic reef survey export",
    createdAt: "2026-10-22T01:00:00Z",
    creator: { name: "Test Team", orcid: "https://orcid.org/0000-0002-1825-0097" },
    schemas: [schema],
    records: [
      {
        recordId: "rec-b", versionId: "v1", profileId: "clio.profile.structured-survey", profileVersion: "1.0.0",
        title: "Transect B", eventDate: "2026-10-01", decimalLatitude: -23.44, decimalLongitude: 151.91,
        licence: "https://creativecommons.org/licenses/by/4.0/",
        canonical: { title: "Transect B", nested: { z: 1, a: 2 } },
        projectSchema: { schemaKey: "reef-transect", version: "1.0.0" },
        extension: { waterTemperature: 24.5, reefZone: "slope" },
        measurements: [depth, cover],
      },
      {
        recordId: "rec-a", versionId: "v1", profileId: "clio.profile.structured-survey", profileVersion: "1.0.0",
        title: "Transect A, north", licence: "https://creativecommons.org/licenses/by/4.0/", canonical: { title: "Transect A, north" },
      },
    ],
    media: [{ recordId: "rec-b", objectKey: "objects/abc", mediaType: "image/jpeg", bytes: 1024, sha256: "a".repeat(64), licence: "https://creativecommons.org/licenses/by/4.0/", rightsHolder: "Test Team" }],
    ...overrides,
  };
}

function fileText(files: readonly PackageFile[], path: string): string {
  const file = files.find((item) => item.path === path);
  assert.ok(file, `missing ${path}`);
  return new TextDecoder().decode(file.bytes);
}

test("measurement rows need a type IRI or local flag, and numbers need units", () => {
  assert.deepEqual(validateMeasurementRows([depth, cover]), []);
  const { unitIri: _unit, ...noUnit } = depth;
  assert.deepEqual(validateMeasurementRows([noUnit]).map((item) => item.code), ["missing_unit"]);
  assert.deepEqual(validateMeasurementRows([{ ...depth, typeIri: null }]).map((item) => item.code), ["missing_term_iri"]);
  assert.deepEqual(validateMeasurementRows([depth, depth]).map((item) => item.code), ["duplicate_measurement_id"]);
  assert.deepEqual(validateMeasurementRows([{ ...depth, value: { number: Number.NaN } }]).map((item) => item.code), ["invalid_value"]);
  assert.deepEqual(validateMeasurementRows([{ ...depth, value: { number: 1, text: "x" } as never }]).map((item) => item.code), ["invalid_value"]);
  assert.deepEqual(validateMeasurementRows([{ ...depth, determinedAt: "01/10/2026" }]).map((item) => item.code), ["invalid_date"]);
});

test("measurement rows project to eMoF columns", () => {
  const row = toEmofRow(depth, "rec-b");
  assert.deepEqual(Object.keys(row), [...EMOF_COLUMNS]);
  assert.equal(row.measurementTypeID, depth.typeIri);
  assert.equal(row.measurementValue, "6.5");
  assert.equal(row.measurementUnitID, depth.unitIri);
  assert.equal(row.measurementAccuracy, "0.5 m (absolute)");
  assert.equal(toEmofRow({ ...cover, value: { iri: "https://example.org/v/moderate", label: "moderate" } }, "x").measurementValueID, "https://example.org/v/moderate");
});

test("CSV quoting follows RFC 4180", () => {
  assert.equal(toCsv(["a", "b"], [{ a: "x,y", b: "say \"hi\"" }, { a: "line\nbreak" }]), "a,b\r\n\"x,y\",\"say \"\"hi\"\"\"\r\n\"line\nbreak\",\r\n");
});

test("a package is a valid BagIt bag with RO-Crate and Frictionless descriptors", async () => {
  const built = await buildResearchPackage(input());
  const paths = built.files.map((file) => file.path);
  for (const path of ["bagit.txt", "bag-info.txt", "manifest-sha256.txt", "tagmanifest-sha256.txt", "data/records.jsonl", "data/records.csv",
    "data/measurements.csv", "data/extensions/reef-transect-1.0.0.csv", "data/schemas/reef-transect/1.0.0.clio.json",
    "data/schemas/reef-transect/1.0.0.schema.json", "data/media-manifest.csv", "data/README.txt", "data/datapackage.json", "data/ro-crate-metadata.json"]) {
    assert.ok(paths.includes(path), `expected ${path}`);
  }
  assert.deepEqual(await verifyResearchPackage(built.files), { valid: true, problems: [] });
  assert.equal(built.payloadFiles, paths.filter((path) => path.startsWith("data/")).length);

  const crate = JSON.parse(fileText(built.files, "data/ro-crate-metadata.json")) as { "@context": string; "@graph": Record<string, unknown>[] };
  assert.equal(crate["@context"], "https://w3id.org/ro/crate/1.2/context");
  const root = crate["@graph"].find((entity) => entity["@id"] === "./");
  assert.ok(root);
  const parts = (root.hasPart as { "@id": string }[]).map((part) => part["@id"]);
  assert.ok(parts.includes("records.jsonl") && parts.includes("datapackage.json") && !parts.includes("ro-crate-metadata.json"));

  const dataPackage = JSON.parse(fileText(built.files, "data/datapackage.json")) as { resources: { name: string; path: string; schema?: { fields: { name: string; rdfType?: string }[] } }[] };
  const extension = dataPackage.resources.find((resource) => resource.path === "extensions/reef-transect-1.0.0.csv");
  assert.equal(extension?.schema?.fields.find((field) => field.name === "waterTemperature")?.rdfType, schema.fields[0].termIri);
  const measurements = dataPackage.resources.find((resource) => resource.name === "measurements");
  assert.equal(measurements?.schema?.fields.find((field) => field.name === "measurementTypeID")?.rdfType, "http://rs.iobis.org/obis/terms/measurementTypeID");
  for (const resource of dataPackage.resources) assert.ok(paths.includes(`data/${resource.path}`), `descriptor names a missing file ${resource.path}`);
});

test("record order, key order and line endings are deterministic", async () => {
  const first = await buildResearchPackage(input());
  const second = await buildResearchPackage(input({ records: [...input().records].reverse() }));
  assert.equal(first.manifestSha256, second.manifestSha256);
  const lines = fileText(first.files, "data/records.jsonl").trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\{"canonical":\{"title":"Transect A, north"\}/u);
  assert.match(lines[1], /"nested":\{"a":2,"z":1\}/u);
  const records = fileText(first.files, "data/records.csv").split("\r\n");
  assert.equal(records[1].split(",")[0], "rec-a");
  assert.ok(records[1].includes("\"Transect A, north\""));
});

test("tampering, extra files, missing files and a wrong Payload-Oxum are all detected", async () => {
  const built = await buildResearchPackage(input());
  const tamper = (path: string, text: string) => built.files.map((file) => (file.path === path ? { path, bytes: new TextEncoder().encode(text) } : file));
  assert.ok((await verifyResearchPackage(tamper("data/records.csv", "changed"))).problems.some((problem) => problem.includes("data/records.csv does not match")));
  assert.ok((await verifyResearchPackage([...built.files, { path: "data/extra.txt", bytes: new Uint8Array([1]) }])).problems.some((problem) => problem.includes("not in the manifest")));
  assert.ok((await verifyResearchPackage(built.files.filter((file) => file.path !== "data/README.txt"))).problems.some((problem) => problem.includes("listed but missing")));
  const info = fileText(built.files, "bag-info.txt").replace(/Payload-Oxum: \d+/u, "Payload-Oxum: 1");
  const oxum = await verifyResearchPackage(tamper("bag-info.txt", info));
  assert.ok(oxum.problems.includes("Payload-Oxum does not match the payload"));
  assert.ok(oxum.problems.some((problem) => problem.includes("tag file bag-info.txt does not match")));
});

test("invalid input fails closed before anything is built", async () => {
  await assert.rejects(buildResearchPackage(input({ schemas: [] })), (error: unknown) => error instanceof ResearchPackageError && error.problems.some((problem) => problem.includes("not included")));
  const badRecord = { ...input().records[0], extension: { waterTemperature: "warm" } };
  await assert.rejects(buildResearchPackage(input({ records: [badRecord] })), ResearchPackageError);
  const traversal = { ...input().records[1], recordId: "../etc" };
  await assert.rejects(buildResearchPackage(input({ records: [traversal] })), ResearchPackageError);
  const orphan = { ...input().records[1], extension: { reefZone: "crest" } };
  await assert.rejects(buildResearchPackage(input({ records: [orphan] })), ResearchPackageError);
  await assert.rejects(buildResearchPackage(input({ media: [{ ...input().media![0], sha256: "nothex" }] })), ResearchPackageError);
});

test("staged project data keeps source rights: no package-wide licence, honest README, export notes", async () => {
  const contributed = await buildResearchPackage(input());
  const contributedPackage = JSON.parse(fileText(contributed.files, "data/datapackage.json"));
  assert.equal(contributedPackage.licenses[0].path, "https://creativecommons.org/licenses/by/4.0/");

  const staged = await buildResearchPackage(input({
    rights: "source-statements",
    notes: ["Darwin Core Archive not included: synthetic reason\nwith a line break."],
  }));
  assert.deepEqual(await verifyResearchPackage(staged.files), { valid: true, problems: [] });
  const dataPackage = JSON.parse(fileText(staged.files, "data/datapackage.json"));
  assert.equal(dataPackage.licenses, undefined);
  const crate = JSON.parse(fileText(staged.files, "data/ro-crate-metadata.json"));
  const root = crate["@graph"].find((entity: Record<string, unknown>) => entity["@id"] === "./");
  assert.equal(root.license, undefined);
  assert.equal(crate["@graph"].some((entity: Record<string, unknown>) => entity["@id"] === "https://creativecommons.org/licenses/by/4.0/"), false);
  const readmeText = fileText(staged.files, "data/README.txt");
  assert.match(readmeText, /This export does not assign a licence\./u);
  assert.match(readmeText, /Notes from this export\n- Darwin Core Archive not included: synthetic reason with a line break\./u);
  await assert.rejects(buildResearchPackage(input({ rights: "other" as never })), ResearchPackageError);
  await assert.rejects(buildResearchPackage(input({ notes: Array.from({ length: 51 }, () => "x") })), ResearchPackageError);
});

test("a licence option replaces the CC BY 4.0 default in the descriptors and the README", async () => {
  const licence = { name: "Creative Commons Zero 1.0 Universal", shortName: "CC0 1.0", spdxIdentifier: "CC0-1.0", uri: "https://creativecommons.org/publicdomain/zero/1.0/" };
  const built = await buildResearchPackage(input({ licence }));
  assert.deepEqual(await verifyResearchPackage(built.files), { valid: true, problems: [] });
  const dataPackage = JSON.parse(fileText(built.files, "data/datapackage.json")) as { licenses: { name: string; path: string }[] };
  assert.deepEqual(dataPackage.licenses.map((item) => [item.name, item.path]), [["CC0-1.0", licence.uri]]);
  const crate = JSON.parse(fileText(built.files, "data/ro-crate-metadata.json")) as { "@graph": Record<string, unknown>[] };
  assert.deepEqual(crate["@graph"].find((entity) => entity["@id"] === "./")?.license, { "@id": licence.uri });
  assert.match(fileText(built.files, "data/README.txt"), /CC0 1\.0 \(https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/\)/u);
  assert.doesNotMatch(fileText(built.files, "data/README.txt"), /CC BY 4\.0/u);
  const byDefault = await buildResearchPackage(input());
  assert.match(fileText(byDefault.files, "data/README.txt"), /CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\)/u);
  await assert.rejects(() => buildResearchPackage(input({ licence: { ...licence, uri: "http://insecure.example/licence" } })), ResearchPackageError);
});
