import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ResearchPackageError,
  buildDarwinCoreArchive,
  buildResearchPackage,
  classifyLocationVisibility,
  effectiveFieldVisibility,
  koboFieldsFromSurvey,
  koboJsonToRows,
  locationDisclosure,
  locationStateOf,
  odkFieldsFromXForm,
  odkODataToRows,
  privateLocationPaths,
  validateRecordFields,
  withholdCanonicalRecordVersion,
  withholdStagedRow,
  type RecordFields,
  type ResearchPackageInput,
} from "../src/index.ts";
import { sampleArchiveInput, samplePackageInput } from "../scripts/sample-package.ts";

// The full probe matrix from the independent review (2026-10-30-review-open-full.md), as tests.
// Rule under test: only an exact "public" or "generalized" string publishes a place. Everything else, a missing value included, withholds.
const LAT = "-33.81234";
const LON = "151.21234";
const MARKER = "PRIVATE-REF-MARKER";
const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const NON_PUBLISHING: [string, unknown][] = [
  ["restricted", "restricted"], ["Restricted. (trailing dot)", "Restricted."], ["RESTRICTED", "RESTRICTED"], ["leading space", " restricted"],
  ["private", "private"], ["array", ["restricted"]], ["boolean", true], ["wrapper object", { value: "restricted" }], ["empty string", ""],
  ["null", null], ["number", 5], ["not_collected", "not_collected"], ["Public (capital)", "Public"], ["public with space", "public "],
  ["array holding public", ["public"]], ["wrapper holding public", { value: "public" }],
];
const PUBLISHING: [string, unknown][] = [["public", "public"], ["generalized", "generalized"]];

const eventWith = (visibility: unknown, key = "locationVisibility"): Record<string, unknown> => ({
  eventDate: "2026-10-01", locality: "Synthetic creek", recordedBy: "Synthetic", method: "Walk",
  decimalLatitude: Number(LAT), decimalLongitude: Number(LON), coordinateUncertaintyM: 10, geodeticDatum: "EPSG:4326",
  privateLocationObjectRef: MARKER,
  ...(visibility === undefined ? {} : { [key]: visibility }),
});
const canonicalWith = (event: Record<string, unknown>) => ({
  schema: "clio-record-version-canonical-v1", recordId: "rec-1", versionId: "ver-1", canonicalUri: "https://example.org/records/rec-1",
  fields: {
    title: "Synthetic record",
    profile: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0", data: { title: "Synthetic record", locality: "Synthetic creek" } },
    event,
    rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
  },
});
const leaks = (value: unknown): boolean => JSON.stringify(value).includes(LAT) || JSON.stringify(value).includes(LON);

// ---------------------------------------------------------------------------
// The classifier itself

test("only the exact strings public and generalized publish; everything else is unrecognised or withheld", () => {
  for (const [name, value] of PUBLISHING) assert.equal(locationStateOf({ locationVisibility: value }).publishes, true, name);
  for (const [name, value] of NON_PUBLISHING) assert.equal(locationStateOf({ locationVisibility: value }).publishes, false, name);
  assert.equal(classifyLocationVisibility("restricted"), "restricted");
  assert.equal(classifyLocationVisibility("Restricted"), "unrecognised");
  assert.equal(locationStateOf({}).state, "missing");
  assert.equal(locationStateOf({}).publishes, false, "missing withholds by default");
  assert.equal(locationStateOf({}, { missingVisibility: "public" }).publishes, true, "the explicit option restores the old behaviour");
  assert.equal(locationStateOf({ locationVisibility: "restricted" }, { missingVisibility: "public" }).publishes, false, "the option only covers a missing value");
});

test("a visibility key in any spelling is the flag, and the most restrictive one wins", () => {
  for (const key of ["Location Visibility", "location-visibility", "location_visibility", "LOCATIONVISIBILITY", "visibility", "Visibility"]) {
    assert.equal(locationStateOf({ [key]: "restricted" }).publishes, false, key);
    assert.equal(locationStateOf({ [key]: "public" }).publishes, true, key);
  }
  assert.equal(locationStateOf({ locationVisibility: "public", location_visibility: "restricted" }).publishes, false, "two keys: the stricter wins");
  assert.equal(locationStateOf({ visibility: "private", locationVisibility: "public" }).publishes, false);
});

// ---------------------------------------------------------------------------
// withholdCanonicalRecordVersion

test("canonical record: every non-publishing value withholds the place and the private reference", () => {
  for (const [name, value] of NON_PUBLISHING) {
    const result = withholdCanonicalRecordVersion(canonicalWith(eventWith(value)));
    assert.equal(leaks(result.value), false, `${name}: coordinates leaked`);
    assert.equal(JSON.stringify(result.value).includes(MARKER), false, `${name}: private reference leaked`);
    assert.ok(result.withheld.includes("canonical.fields.event.decimalLatitude"), name);
  }
});

test("canonical record: a missing visibility withholds by default; missingVisibility public keeps the place", () => {
  const missing = canonicalWith(eventWith(undefined));
  assert.equal(leaks(withholdCanonicalRecordVersion(missing).value), false);
  const kept = withholdCanonicalRecordVersion(missing, { missingVisibility: "public" });
  assert.equal(leaks(kept.value), true);
  assert.equal(JSON.stringify(kept.value).includes(MARKER), false, "a private reference never survives, whatever the option");
});

test("canonical record: public and generalized keep their coordinates (the private reference still goes)", () => {
  for (const [name, value] of PUBLISHING) {
    const result = withholdCanonicalRecordVersion(canonicalWith(eventWith(value)));
    assert.equal(leaks(result.value), true, name);
    assert.deepEqual(result.withheld, ["canonical.fields.event.privateLocationObjectRef"], name);
  }
});

test("canonical record: variant visibility keys inside the event count", () => {
  for (const key of ["Location Visibility", "location-visibility", "visibility"]) {
    const result = withholdCanonicalRecordVersion(canonicalWith(eventWith("restricted", key)));
    assert.equal(leaks(result.value), false, key);
    assert.equal((result.value.fields as { event: Record<string, unknown> }).event[key], "restricted", "the flag itself stays, so the output says why");
  }
});

test("canonical record: an array visibility on a profile value cannot bypass the restricted test", () => {
  const canonical = canonicalWith(eventWith("public"));
  const data = (canonical.fields.profile as { data: Record<string, unknown> }).data;
  data.title = { value: "kept", visibility: "public" };
  data.description = { value: "SECRET-BY-ARRAY", visibility: ["restricted"] };
  data.locality = { value: "SECRET-BY-OBJECT", visibility: { level: "restricted" } };
  const result = withholdCanonicalRecordVersion(canonical);
  assert.equal(JSON.stringify(result.value).includes("SECRET-BY"), false);
  assert.equal(effectiveFieldVisibility(undefined, "x", { value: 1, visibility: ["restricted"] as never }), "restricted");
  const profile = { fields: [{ key: "x", sensitivity: "public" }] } as never;
  assert.equal(effectiveFieldVisibility(profile, "x", { value: 1, visibility: ["restricted"] as never }), "restricted");
  assert.equal(effectiveFieldVisibility(profile, "x", { value: 1, visibility: 3 as never }), "restricted");
  assert.equal(effectiveFieldVisibility(profile, "x", { value: 1, visibility: "public" }), "public");
});

test("canonical record: a place anywhere in the record goes when the location is withheld, GeoJSON, WKT and lat/lon text included", () => {
  const canonical = canonicalWith(eventWith("restricted")) as { fields: Record<string, unknown> };
  // A field the allow-list does not know is dropped by name, whatever it holds.
  canonical.fields.extras = {
    title: "T", footprint: "POLYGON ((151.1 -33.1, 151.2 -33.1, 151.2 -33.2, 151.1 -33.1))", note: "-33.81234 151.21234 5 3",
    spot: { type: "Point", coordinates: [151.21234, -33.81234] }, trail: [{ type: "LineString", coordinates: [[1, 2], [3, 4]] }, "kept text"],
  };
  // Free text that stays is screened.
  canonical.fields.title = "Transect at the creek, -33.81234, 151.21234";
  const result = withholdCanonicalRecordVersion(canonical);
  const text = JSON.stringify(result.value);
  for (const gone of ["POLYGON", "151.21234", "LineString", "Point", "kept text", "extras"]) assert.equal(text.includes(gone), false, gone);
  assert.ok(result.withheld.includes("canonical.fields.extras"), "the unknown field is named in the withheld list");
  assert.equal((result.value.fields as { title: string }).title, "Transect at the creek, [location withheld]");
});

// ---------------------------------------------------------------------------
// withholdStagedRow (flat keys, any spelling)

const stagedOptions = { profileId: "clio.profile.general-observation", profileVersion: "1.0.0" };

test("staged row: every non-publishing value withholds, with the flag in any key spelling", () => {
  for (const key of ["locationVisibility", "Location Visibility", "location-visibility", "location_visibility", "visibility"]) {
    for (const [name, value] of NON_PUBLISHING) {
      const result = withholdStagedRow({ data: { latitude: Number(LAT), longitude: Number(LON) }, source: { lat: LAT, lon: LON, [key]: value }, ...stagedOptions });
      assert.equal(leaks(result.value), false, `${key} = ${name}`);
    }
  }
});

test("staged row: no visibility key at all withholds by default and publishes with the option", () => {
  const input = { data: { latitude: Number(LAT), longitude: Number(LON) }, source: { lat: LAT, lon: LON }, ...stagedOptions };
  assert.equal(leaks(withholdStagedRow(input).value), false);
  assert.equal(leaks(withholdStagedRow({ ...input, missingVisibility: "public" }).value), true);
  for (const [name, value] of PUBLISHING) assert.equal(leaks(withholdStagedRow({ ...input, source: { ...input.source, locationVisibility: value } }).value), true, name);
});

test("staged row: a flag in the data applies to the source columns and the other way round", () => {
  assert.equal(leaks(withholdStagedRow({ data: { latitude: Number(LAT), locationVisibility: "restricted" }, source: { lat: LAT, lon: LON, locationVisibility: "public" }, ...stagedOptions }).value), false);
  assert.equal(leaks(withholdStagedRow({ data: { latitude: Number(LAT), locationVisibility: "public" }, source: { lat: LAT, lon: LON, locationVisibility: ["restricted"] }, ...stagedOptions }).value), false);
});

test("staged row: caller-listed private keys are withheld too", () => {
  const result = withholdStagedRow({ data: {}, source: { secret_site: "SITE-X", hidden_gps: "GPS-Y", locationVisibility: "public" }, privateKeys: ["secret_site", "Hidden GPS"], ...stagedOptions });
  assert.equal(JSON.stringify(result.value).includes("SITE-X") || JSON.stringify(result.value).includes("GPS-Y"), false);
  const unlisted = withholdStagedRow({ data: {}, source: { secret_site: "SITE-X", locationVisibility: "public" }, ...stagedOptions });
  assert.ok(JSON.stringify(unlisted.value).includes("SITE-X"), "the name heuristic does not catch it; the doc says so");
});

// ---------------------------------------------------------------------------
// Connector rows: traces, shapes, nested repeats

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), "utf8"));
const GEOMETRY = /"(?:Point|LineString|Polygon)"|"coordinates"|accuracyMetres/u;

test("ODK rows: points, traces, shapes and nested repeat points are all withheld when the location is not published", () => {
  const fields = odkFieldsFromXForm(readFileSync(join(root, "odk", "forms", "geoTypes.xml"), "utf8"));
  const result = odkODataToRows(readJson("odk/odata/geotypes.json"), { fields, eventDateField: "survey_started_at", geometryField: "singular/input_geoshape" });
  const row = result.rows[0]!;
  assert.match(JSON.stringify(row), GEOMETRY, "the fixture really has geometry");
  assert.ok(row.latitude !== undefined && row.geometry !== undefined);
  for (const flag of ["restricted", "not_collected", "Restricted.", ["restricted"], undefined]) {
    const source = { ...row, ...(flag === undefined ? {} : { locationVisibility: flag }) };
    const staged = withholdStagedRow({ data: { latitude: row.latitude, longitude: row.longitude, uncertainty: row.uncertainty }, source, ...stagedOptions });
    assert.doesNotMatch(JSON.stringify(staged.value), GEOMETRY, String(flag));
    assert.ok(!("latitude" in staged.value.data) && !("geometry" in staged.value.source), String(flag));
    assert.ok(staged.withheld.includes("canonical.source.plural"), "the repeat is dropped by name: it is not on the allow-list");
  }
  const published = withholdStagedRow({ data: {}, source: { ...row, locationVisibility: "public" }, ...stagedOptions });
  assert.match(JSON.stringify(published.value), GEOMETRY, "a published location keeps its geometry");
});

test("Kobo rows: a point, a trace and a shape are withheld when the location is not published", () => {
  const survey = koboFieldsFromSurvey((readJson("kobo/asset-survey.json") as { content: { survey: unknown } }).content.survey);
  const kobo = koboJsonToRows(readJson("kobo/data-page1.json"), { fields: survey, geometryField: "plot" }).rows[0]!;
  assert.match(JSON.stringify(kobo), GEOMETRY);
  const staged = withholdStagedRow({ data: { latitude: kobo.latitude }, source: { ...kobo, "Location Visibility": "restricted" }, ...stagedOptions });
  assert.doesNotMatch(JSON.stringify(staged.value), GEOMETRY);
  assert.equal(JSON.stringify(staged.value).includes("151.2"), false);
  assert.equal(JSON.stringify(staged.value).includes("Synthetic creek"), false, "an answer the allow-list does not know is dropped too");
  const kept = withholdStagedRow({ data: {}, source: { ...kobo, "Location Visibility": "restricted" }, keepKeys: ["site/site_name", "habitat"], ...stagedOptions });
  assert.equal(JSON.stringify(kept.value).includes("Synthetic creek"), false, "a site name is a place name: keepKeys cannot bring it back");
  assert.ok(JSON.stringify(kept.value).includes("heath") || JSON.stringify(kept.value).includes("habitat"), "a caller can still keep a question it knows is safe");
  assert.doesNotMatch(JSON.stringify(kept.value), GEOMETRY);
});

// ---------------------------------------------------------------------------
// not_collected

test("not_collected: no coordinates in the Darwin Core Archive, a validation error, and the disclosure says withheld", () => {
  const base = sampleArchiveInput();
  const record = base.records[0]!;
  const withVisibility = (locationVisibility: unknown): typeof base => ({ ...base, records: [{ ...record, fields: { ...record.fields, event: { ...record.fields.event, locationVisibility: locationVisibility as never } } }] });
  const text = (archive: ReturnType<typeof buildDarwinCoreArchive>) => archive.files.map((file) => file.text).join("\n");

  // a not_collected event that still has coordinates is a record error, and the archive refuses it
  const errors = validateRecordFields(withVisibility("not_collected").records[0]!.fields as RecordFields);
  assert.ok(JSON.stringify(errors).includes("not_collected_coordinates_exposed"));
  assert.throws(() => buildDarwinCoreArchive(withVisibility("not_collected")));

  // without coordinates it builds, with nothing placed
  const noCoordinates = withVisibility("not_collected");
  const event = { ...(noCoordinates.records[0]!.fields.event as unknown as Record<string, unknown>) };
  delete event.decimalLatitude; delete event.decimalLongitude; delete event.coordinateUncertaintyM;
  const archive = buildDarwinCoreArchive({ ...noCoordinates, records: [{ ...noCoordinates.records[0]!, fields: { ...noCoordinates.records[0]!.fields, event: event as never } }] });
  assert.equal(text(archive).includes(LAT), false);
  assert.match(text(archive), /coordinates withheld \(location not collected\)/u);
  assert.equal(locationDisclosure({ locationVisibility: "not_collected" }).coordinatesPublic, false);
});

test("Darwin Core Archive: every non-publishing value publishes no coordinates (refused or withheld)", () => {
  const base = sampleArchiveInput();
  const record = base.records[0]!;
  const coordinates = String(record.fields.event.decimalLatitude);
  for (const [name, value] of [...NON_PUBLISHING, ["missing", undefined] as [string, unknown]]) {
    const withVisibility = { ...base, records: [{ ...record, fields: { ...record.fields, event: { ...record.fields.event, locationVisibility: value as never } } }] };
    let output = "";
    try { output = buildDarwinCoreArchive(withVisibility).files.map((file) => file.text).join("\n"); } catch { output = ""; }
    assert.equal(output.includes(coordinates), false, name);
  }
  const missing = { ...base, records: [{ ...record, fields: { ...record.fields, event: { ...record.fields.event, locationVisibility: undefined } } }] };
  const kept = buildDarwinCoreArchive({ ...missing, missingVisibility: "public" }).files.map((file) => file.text).join("\n");
  assert.ok(kept.includes(coordinates), "the explicit option publishes a record with no stated visibility");
  for (const [name, value] of PUBLISHING) {
    const published = { ...base, records: [{ ...record, fields: { ...record.fields, event: { ...record.fields.event, locationVisibility: value as never } } }] };
    assert.ok(buildDarwinCoreArchive(published).files.map((file) => file.text).join("\n").includes(coordinates), name);
  }
});

// ---------------------------------------------------------------------------
// The package builder checks the canonical JSON

function packageWith(event: Record<string, unknown> | undefined, extra: Partial<ResearchPackageInput> = {}, flat: Record<string, unknown> = {}) {
  const base = samplePackageInput();
  const record = base.records[0]!;
  const canonical = event === undefined ? { ...record.canonical, fields: { ...(record.canonical as { fields: object }).fields, event: undefined } } : canonicalWith(event);
  return { ...base, includeDarwinCoreArchive: false, ...extra, records: [{ ...record, eventDate: "2026-10-01", decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, canonical, ...flat } as never] } as ResearchPackageInput;
}
const problems = async (input: ResearchPackageInput): Promise<string[]> => {
  try { await buildResearchPackage(input); return []; } catch (error) { assert.ok(error instanceof ResearchPackageError, String(error)); return [...error.problems]; }
};

test("package builder: a record whose canonical still holds coordinates or a private reference is refused unless the location is published", async () => {
  for (const [name, value] of NON_PUBLISHING) {
    const found = await problems(packageWith(eventWith(value)));
    assert.ok(found.some((problem) => /decimalLatitude is still in the record/u.test(problem)), `${name}: ${found.join(" | ")}`);
    assert.ok(found.some((problem) => /privateLocationObjectRef is still in the record/u.test(problem)), name);
  }
  assert.ok((await problems(packageWith(eventWith(undefined)))).some((problem) => /not stated/u.test(problem) && /missingVisibility/u.test(problem)));
  assert.deepEqual(await problems(packageWith(eventWith(undefined), { missingVisibility: "public" })).then((list) => list.filter((problem) => !/privateLocationObjectRef/u.test(problem))), []);
});

test("package builder: an empty withheld list does not make a restricted record acceptable (the reviewer's reproduction)", async () => {
  const input = packageWith(eventWith("restricted"));
  const found = await problems({ ...input, records: [{ ...input.records[0]!, withheld: [] }] });
  assert.ok(found.length >= 2, found.join(" | "));
});

test("package builder: after withholdCanonicalRecordVersion the same record builds, and records.jsonl and records.csv hold no place", async () => {
  for (const value of ["restricted", "not_collected", "Restricted.", undefined]) {
    const withheld = withholdCanonicalRecordVersion(canonicalWith(eventWith(value)));
    const base = samplePackageInput();
    const record = { ...base.records[0]!, eventDate: "2026-10-01", decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, canonical: withheld.value, withheld: [...withheld.withheld] } as never;
    const built = await buildResearchPackage({ ...base, includeDarwinCoreArchive: false, records: [record] });
    for (const path of ["data/records.jsonl", "data/records.csv"]) {
      const text = new TextDecoder().decode(built.files.find((file) => file.path === path)!.bytes);
      assert.equal(text.includes(LAT) || text.includes(LON) || text.includes(MARKER), false, `${String(value)} ${path}`);
    }
  }
});

test("package builder: flat coordinate columns never carry a withheld place, and must match a published one", async () => {
  const flat = { decimalLatitude: Number(LAT), decimalLongitude: Number(LON), coordinateUncertaintyInMeters: 10 };
  for (const [name, value] of NON_PUBLISHING) {
    const event = { ...eventWith(value) }; delete event.decimalLatitude; delete event.decimalLongitude; delete event.coordinateUncertaintyM; delete event.privateLocationObjectRef; delete event.geodeticDatum;
    const found = await problems(packageWith(event, {}, flat));
    assert.ok(found.some((problem) => /decimalLatitude is set but the record's location visibility/u.test(problem)), `${name}: ${found.join(" | ")}`);
  }
  const published = { ...eventWith("public") }; delete published.privateLocationObjectRef;
  assert.deepEqual(await problems(packageWith(published, {}, flat)), []);
  assert.ok((await problems(packageWith(published, {}, { ...flat, decimalLatitude: -34 }))).some((problem) => /differs from the record's own value/u.test(problem)));
  const noEvent = await problems(packageWith(undefined, {}, flat));
  assert.ok(noEvent.some((problem) => /decimalLatitude is set but/u.test(problem)), "no event at all means no stated visibility");
  assert.deepEqual(await problems(packageWith(undefined, { missingVisibility: "public" }, flat)), []);
});

test("private location paths helper finds nested references", () => {
  assert.deepEqual(privateLocationPaths({ a: { privateLocationObjectRef: "x", b: [{ private_location: "y" }] }, ok: 1 }, "c"), ["c.a.privateLocationObjectRef", "c.a.b[0].private_location"]);
  assert.deepEqual(privateLocationPaths({ secret_site: "x" }, "c", ["Secret Site"]), ["c.secret_site"]);
});
