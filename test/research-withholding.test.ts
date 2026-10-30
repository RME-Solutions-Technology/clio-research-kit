import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchPackage, verifyResearchPackage, type PackageFile } from "../src/research-package.ts";
import { PROJECT_SCHEMA_FORMAT, type ProjectSchemaDocument } from "../src/research-schema.ts";
import {
  isPrivateLocationKey,
  withholdCanonicalRecordVersion,
  withholdExtension,
  withholdStagedRow,
} from "../src/research-withholding.ts";

// Synthetic test data only.
const schema: ProjectSchemaDocument = {
  format: PROJECT_SCHEMA_FORMAT,
  schemaKey: "plot-survey",
  version: "1.0.0",
  title: "Synthetic plot survey",
  extends: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0" },
  fields: [
    { key: "plotCode", label: "Plot code", datatype: "string", termIri: "https://example.org/terms/plotCode", requiredAt: "draft", sensitivity: "restricted" },
    { key: "landholder", label: "Landholder", datatype: "string", termIri: "https://example.org/terms/landholder", sensitivity: "sensitive" },
    { key: "canopy", label: "Canopy cover", datatype: "number", termIri: "https://example.org/terms/canopy", dimensionless: true, sensitivity: "public" },
  ],
};

test("private location keys are recognised in their common spellings", () => {
  for (const key of ["privateLocationObjectRef", "private_location", "privateCoordinates", "restrictedLocationRef", "PRIVATE-LOCATION-ID"]) assert.equal(isPrivateLocationKey(key), true, key);
  for (const key of ["locality", "locationVisibility", "privacyNote2"]) assert.equal(isPrivateLocationKey(key), false, key);
});

test("a staged row loses restricted fields, a restricted location's coordinates and private references, in data and source", () => {
  const data = { sourceId: "SYN-1", eventDate: "2026-10-01", latitude: -27.5, longitude: 153.0, uncertainty: 12 };
  const source = {
    id: "SYN-1", date: "2026-10-01", lat: "-27.5", lon: "153.0", locationVisibility: "restricted",
    plotCode: "PLOT-SECRET-7", landholder: "Synthetic Station", canopy: "40",
    privateLocationObjectRef: "objects/private/synthetic", notes: { privateLocation: "nested secret" },
    observerNote: { value: "restricted note", visibility: "restricted" },
  };
  const result = withholdStagedRow({ data, source, schema, profileId: "clio.profile.general-observation", profileVersion: "1.0.0" });
  assert.deepEqual(result.value.data, { sourceId: "SYN-1", eventDate: "2026-10-01" }, "uncertainty is a precision of the place and goes with it");
  assert.deepEqual(result.value.source, { id: "SYN-1", date: "2026-10-01", locationVisibility: "restricted", landholder: "Synthetic Station", canopy: "40" }, "unlisted columns are dropped by name when the place is withheld");
  assert.deepEqual([...result.withheld].sort(), [
    "canonical.data.latitude", "canonical.data.longitude", "canonical.data.uncertainty",
    "canonical.source.lat", "canonical.source.lon", "canonical.source.notes",
    "canonical.source.observerNote", "canonical.source.plotCode", "canonical.source.privateLocationObjectRef",
  ]);
  assert.equal(JSON.stringify(result.value).includes("SECRET"), false);
  assert.equal(source.plotCode, "PLOT-SECRET-7", "inputs are not modified");

  const open = withholdStagedRow({ data, source: { id: "SYN-2", lat: "-27.5", locationVisibility: "public" }, schema, profileId: "clio.profile.general-observation", profileVersion: "1.0.0" });
  assert.deepEqual(open.withheld, [], "a public location keeps its coordinates");
});

test("project values keep sensitive fields and lose restricted ones", () => {
  const result = withholdExtension({ plotCode: "PLOT-SECRET-7", landholder: "Synthetic Station", canopy: 40 }, schema);
  assert.deepEqual(result, { value: { landholder: "Synthetic Station", canopy: 40 }, withheld: ["extension.plotCode"] });
});

test("an accepted record version loses restricted profile values, restricted coordinates and private references", () => {
  const canonical = {
    schema: "clio-record-version-canonical-v1", recordId: "rec-1", versionId: "ver-1", canonicalUri: "https://example.org/records/rec-1",
    fields: {
      title: "Synthetic record",
      profile: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0", data: {
        title: "Synthetic record", locality: "Synthetic creek", description: { value: "restricted description", visibility: "restricted" }, undeclaredKey: "x",
      } },
      event: { eventDate: "2026-10-01", locality: "Synthetic creek", recordedBy: "Synthetic", method: "Walk", decimalLatitude: -27.5, decimalLongitude: 153, coordinateUncertaintyM: 10, geodeticDatum: "EPSG:4326", locationVisibility: "restricted", privateLocationObjectRef: "objects/private/synthetic" },
      rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
    },
  };
  const result = withholdCanonicalRecordVersion(canonical);
  const fields = result.value.fields as Record<string, Record<string, unknown>>;
  assert.deepEqual(fields.profile!.data, { title: "Synthetic record" }, "a locality names the place, so it goes");
  assert.deepEqual(fields.event, { eventDate: "2026-10-01", recordedBy: "Synthetic", method: "Walk", locationVisibility: "restricted" });
  assert.deepEqual([...result.withheld].sort(), [
    "canonical.fields.event.coordinateUncertaintyM", "canonical.fields.event.decimalLatitude", "canonical.fields.event.decimalLongitude",
    "canonical.fields.event.geodeticDatum", "canonical.fields.event.locality", "canonical.fields.event.privateLocationObjectRef",
    "canonical.fields.profile.data.description", "canonical.fields.profile.data.locality", "canonical.fields.profile.data.undeclaredKey",
  ]);
  assert.equal(canonical.fields.event.decimalLatitude, -27.5, "inputs are not modified");
});

test("a package names withheld values per record and in README, and a withheld required value is not an error", async () => {
  const built = await buildResearchPackage({
    packageId: "pkg-withheld-1",
    title: "Synthetic withheld export",
    createdAt: "2026-10-23T00:00:00Z",
    creator: { name: "Synthetic Team" },
    schemas: [schema],
    rights: "source-statements",
    records: [
      { recordId: "row-1", versionId: "imp-1", profileId: "clio.profile.general-observation", profileVersion: "1.0.0", title: "Not mine", licence: "", canonical: { data: {} },
        projectSchema: { schemaKey: "plot-survey", version: "1.0.0" }, extension: { landholder: "Synthetic Station" }, withheld: ["extension.plotCode", "canonical.source.privateLocationObjectRef"] },
      { recordId: "row-2", versionId: "imp-1", profileId: "clio.profile.general-observation", profileVersion: "1.0.0", title: "Mine", licence: "", canonical: { data: {} },
        projectSchema: { schemaKey: "plot-survey", version: "1.0.0" }, extension: { plotCode: "PLOT-OWN-1" } },
    ],
  });
  const files: readonly PackageFile[] = built.files;
  assert.deepEqual(await verifyResearchPackage(files), { valid: true, problems: [] });
  const text = (path: string) => new TextDecoder().decode(files.find((file) => file.path === path)!.bytes);
  const lines = text("data/records.jsonl").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines[0].withheld, ["extension.plotCode", "canonical.source.privateLocationObjectRef"]);
  assert.equal(lines[0].informationWithheld, "Withheld from this export: extension.plotCode, canonical.source.privateLocationObjectRef.");
  assert.equal(lines[1].withheld, undefined);
  const csv = text("data/records.csv").split("\r\n");
  assert.ok(csv[0]!.endsWith(",informationWithheld"));
  assert.match(csv[1]!, /"Withheld from this export: extension\.plotCode, canonical\.source\.privateLocationObjectRef\."$/u);
  const readme = text("data/README.txt");
  assert.match(readme, /What was withheld\n- 1 record has values withheld: restricted fields and private location references are left out/u);
  assert.match(readme, /less the values each record lists in withheld/u);
  const descriptor = JSON.parse(text("data/datapackage.json"));
  assert.equal(descriptor.resources[0].schema.fields.at(-1).rdfType, "http://rs.tdwg.org/dwc/terms/informationWithheld");
  await assert.rejects(buildResearchPackage({
    packageId: "pkg-withheld-2", title: "Synthetic", createdAt: "2026-10-23T00:00:00Z", creator: { name: "Synthetic Team" }, schemas: [schema],
    records: [{ recordId: "row-1", versionId: "imp-1", profileId: "clio.profile.general-observation", profileVersion: "1.0.0", title: "x", licence: "", canonical: {},
      projectSchema: { schemaKey: "plot-survey", version: "1.0.0" }, extension: {} }],
  }), /plotCode Required for draft/u, "without the withheld note, a missing required value still fails");
});
