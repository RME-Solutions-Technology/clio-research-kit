import assert from "node:assert/strict";
import test from "node:test";
import {
  ResearchPackageError,
  buildResearchPackage,
  collapseWithheld,
  isPlaceNameKey,
  locationStateOf,
  verifyResearchPackage,
  withholdCanonicalRecordVersion,
  withholdPackageRecord,
  withholdStagedRow,
  type ResearchPackageInput,
  type ResearchPackageRecord,
} from "../src/index.ts";
import { samplePackageInput } from "../scripts/sample-package.ts";

// Gaps G1, G2, G3, G5 and H1 from the Clio online museum review (PR 148), held against this library. Synthetic values only.
const LAT = "-33.81234";
const LON = "151.29876";
const RAW_CELL = `Restricted (${LAT}, ${LON})`;
const stagedOptions = { profileId: "clio.profile.general-observation", profileVersion: "1.0.0" };
const text = (value: unknown): string => JSON.stringify(value);
const label = (key: string): string => `rec-a/v1: ${key} is still in the record`;
const noPlace = (value: unknown, label: string): void => {
  const out = text(value);
  assert.equal(out.includes(LAT) || out.includes(LON), false, `${label}: ${out}`);
};

function canonicalWith(event: Record<string, unknown>, rest: Record<string, unknown> = {}, top: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "clio-record-version-canonical-v1", recordId: "rec-1", versionId: "ver-1", canonicalUri: "https://example.org/records/rec-1", ...top,
    fields: {
      title: "Synthetic record",
      profile: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0", data: { title: "Synthetic record" } },
      event: { eventDate: "2026-10-01", ...event },
      rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
      ...rest,
    },
  };
}

// ---------------------------------------------------------------------------
// G1 a visibility-named key keeps only the state it was read as

test("G1: a raw visibility cell is never copied out, in a staged row, a canonical event or anywhere nested", () => {
  const cells: unknown[] = [RAW_CELL, "restricted: -33.8, 151.3", { value: "restricted", where: `${LAT}, ${LON}` }, ["restricted", LAT, LON], " Restricted ", "RESTRICTED"];
  for (const cell of cells) {
    const staged = withholdStagedRow({ data: { title: "T", locationVisibility: cell }, source: { "Location Visibility": cell, group: { location_visibility: cell } }, ...stagedOptions });
    noPlace(staged.value, "staged");
    assert.equal(staged.value.data.locationVisibility, "restricted");
    assert.equal(staged.value.source["Location Visibility"], "restricted");
    assert.equal(text(staged.value.source).includes("restricted:"), false, "the raw cell is not copied from a nested group either");
    const canonical = withholdCanonicalRecordVersion(canonicalWith({ locationVisibility: cell, decimalLatitude: -33.8 }, { site: { location_visibility: cell } }));
    noPlace(canonical.value, "canonical");
    assert.equal((canonical.value.fields as { event: { locationVisibility: string } }).event.locationVisibility, "restricted");
    assert.equal(locationStateOf(canonical.value).state, "restricted", "the cleaned record still reads as restricted");
  }
});

test("G1: an exact state is left alone and is not listed as withheld", () => {
  for (const state of ["restricted", "not_collected"]) {
    const result = withholdCanonicalRecordVersion(canonicalWith({ locationVisibility: state }));
    assert.equal((result.value.fields as { event: { locationVisibility: string } }).event.locationVisibility, state);
    assert.deepEqual(result.withheld, []);
  }
});

// ---------------------------------------------------------------------------
// H1 the cleaned record is output even when the rewrite of a visibility cell is the only change

test("H1: withholdPackageRecord returns the rewritten record when a visibility cell is the only change", () => {
  const base = samplePackageInput();
  const record = base.records[0]!;
  const canonical = canonicalWith({ locationVisibility: "restricted: -33.8, 151.3" });
  const input: ResearchPackageRecord = { ...record, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, canonical, eventDate: "2026-10-01" } as never;
  const out = withholdPackageRecord(input);
  assert.equal(text(out).includes("-33.8"), false, text(out));
  assert.equal((out.canonical.fields as { event: { locationVisibility: string } }).event.locationVisibility, "restricted");
  assert.ok(out.withheld?.includes("canonical.fields.event.locationVisibility"), "the rewrite is recorded");
  assert.notEqual(out, input);
  assert.equal((input.canonical.fields as { event: { locationVisibility: string } }).event.locationVisibility, "restricted: -33.8, 151.3", "the input is not changed");
});

test("H1: the builder refuses a raw visibility cell and accepts the rewritten one", async () => {
  const base = samplePackageInput();
  const record = base.records[0]!;
  const dirty: ResearchPackageRecord = { ...record, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, eventDate: "2026-10-01", canonical: canonicalWith({ locationVisibility: "restricted: -33.8, 151.3" }) } as never;
  const make = (records: ResearchPackageRecord[]): ResearchPackageInput => ({ ...base, includeDarwinCoreArchive: false, records });
  await assert.rejects(buildResearchPackage(make([dirty])), (error: unknown) => error instanceof ResearchPackageError && /holds more than a visibility state/u.test(error.problems.join("|")));
  const built = await buildResearchPackage(make([withholdPackageRecord(dirty)]));
  assert.deepEqual(await verifyResearchPackage(built.files), { valid: true, problems: [] });
  for (const file of built.files) assert.equal(new TextDecoder().decode(file.bytes).includes("-33.8"), false, file.path);
});

// ---------------------------------------------------------------------------
// G2 flat text fields are screened

test("G2: the builder refuses a place in a flat text field, a measurement or a contributor sourceId, and withholdPackageRecord fixes each", async () => {
  const base = samplePackageInput();
  const record = base.records[0]!;
  const place = `${LAT}, ${LON}`;
  const restricted = canonicalWith({ locationVisibility: "restricted" }, {}, { sourceId: `row at ${place}` });
  const measurement = { measurementId: "m9", typeIri: "https://example.org/terms/note", typeLabel: `Seen at ${place}`, value: { text: `Found ${place}` }, unitLabel: `u ${place}`, method: `m ${place}`, remarks: `r ${place}` };
  const dirty: ResearchPackageRecord = {
    ...record, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined,
    title: `Title ${place}`, eventDate: `2026-10-01 ${place}`, recordedBy: `Obs ${place}`, landingPage: `https://example.org/at/${LAT},${LON}`, rightsHolder: `Holder ${place}`,
    canonical: restricted, measurements: [measurement as never], withheld: [],
  } as never;
  const make = (records: ResearchPackageRecord[]): ResearchPackageInput => ({ ...base, includeDarwinCoreArchive: false, records });
  const noFlat = { ...dirty, title: record.title, eventDate: "2026-10-01", recordedBy: record.recordedBy, landingPage: record.landingPage, rightsHolder: record.rightsHolder } as ResearchPackageRecord;
  const refusal = await buildResearchPackage(make([noFlat])).then(() => "", (error: unknown) => (error instanceof ResearchPackageError ? error.problems.join(" | ") : String(error)));
  for (const where of ["canonical.sourceId", "measurements[0]"]) assert.ok(refusal.includes(where), `${where}: ${refusal}`);
  for (const key of ["title", "eventDate", "recordedBy", "landingPage", "rightsHolder"] as const) {
    const single: ResearchPackageRecord = { ...record, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, eventDate: "2026-10-01", canonical: canonicalWith({ locationVisibility: "restricted", eventDate: "2026-10-01" }), [key]: dirty[key], withheld: [] } as never;
    const found = await buildResearchPackage(make([single])).then(() => "", (error: unknown) => (error instanceof ResearchPackageError ? error.problems.join(" | ") : String(error)));
    assert.ok(found.includes(`${key} is still in the record`) || found.includes(`${label(key)}`), `${key}: ${found}`);
  }
  const cleaned = withholdPackageRecord(dirty);
  noPlace(cleaned, "cleaned");
  for (const key of ["title", "recordedBy", "landingPage", "rightsHolder"] as const) assert.match(String(cleaned[key]), /\[location withheld\]/u, key);
  assert.equal(cleaned.eventDate, "2026-10-01", "the flat date takes the record's own cleaned value");
  const built = await buildResearchPackage(make([cleaned]));
  assert.deepEqual(await verifyResearchPackage(built.files), { valid: true, problems: [] });
  for (const file of built.files) noPlace(new TextDecoder().decode(file.bytes), file.path);
});

test("G2: system-written ids are exempt from the text screen; a contributor sourceId is not", () => {
  const ids = { recordId: "rec-33.81234-151.29876", versionId: "ver-1", canonicalUri: "https://example.org/records/rec-1", importId: "imp-1" };
  const kept = withholdCanonicalRecordVersion(canonicalWith({ locationVisibility: "restricted" }, {}, ids));
  assert.equal(kept.value.recordId, ids.recordId, "a system id passes untouched");
  const screened = withholdCanonicalRecordVersion(canonicalWith({ locationVisibility: "restricted" }, {}, { sourceId: `row ${LAT}, ${LON}` }));
  assert.equal(text(screened.value).includes(LAT), false);
  assert.equal(screened.value.sourceId, "row [location withheld]");
});

test("G2: unknown top-level canonical keys are dropped when the location is not published", () => {
  const result = withholdCanonicalRecordVersion(canonicalWith({ locationVisibility: "restricted" }, {}, { extraNote: "free", gpsString: LAT }));
  assert.equal("extraNote" in result.value, false);
  assert.ok(result.withheld.includes("canonical.extraNote"));
});

// ---------------------------------------------------------------------------
// G3 a long withheld list is grouped, not refused

test("G3: 600 withheld places are grouped and the record still builds", async () => {
  const points = Array.from({ length: 600 }, (_, index) => ({ position: [151 + index / 1000, -33 - index / 1000] }));
  const rows = Array.from({ length: 600 }, (_, index) => ({ [`gps${index}`]: [151.1 + index / 1000, -33.1] }));
  const canonical = canonicalWith({ locationVisibility: "restricted" }, { extras: { points, rows } });
  const result = withholdCanonicalRecordVersion(canonical);
  assert.ok(result.withheld.length <= 500, `${result.withheld.length}`);
  assert.ok(result.withheld.length > 0);
  const base = samplePackageInput();
  const record = { ...base.records[0]!, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, eventDate: "2026-10-01", canonical: result.value, withheld: [...result.withheld] } as never;
  const built = await buildResearchPackage({ ...base, includeDarwinCoreArchive: false, records: [record] });
  assert.deepEqual(await verifyResearchPackage(built.files), { valid: true, problems: [] });
  const viaHelper = withholdPackageRecord({ ...base.records[0]!, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, eventDate: "2026-10-01", canonical } as never);
  assert.ok((viaHelper.withheld ?? []).length <= 500);
  await buildResearchPackage({ ...base, includeDarwinCoreArchive: false, records: [viaHelper] });
});

test("G3: collapseWithheld groups positions, then siblings, then roots, and leaves a short list alone", () => {
  const short = ["canonical.a", "canonical.b[0]"];
  assert.deepEqual(collapseWithheld(short), short);
  const positions = Array.from({ length: 700 }, (_, index) => `canonical.fields.points[${index}]`);
  assert.deepEqual(collapseWithheld(positions), ["canonical.fields.points[*]"]);
  const siblings = Array.from({ length: 700 }, (_, index) => `canonical.fields.group.k${index}`);
  assert.deepEqual(collapseWithheld(siblings), ["canonical.fields.group.*"]);
  const wide = Array.from({ length: 900 }, (_, index) => `canonical.fields.g${index}.v`);
  assert.ok(collapseWithheld(wide).length <= 500);
  const hopeless = Array.from({ length: 900 }, (_, index) => `canonical.f${index}.a.b.c`);
  assert.ok(collapseWithheld(hopeless).length <= 500);
});

test("G3: a collapsed path is accepted by the builder; a path outside the allowed roots is not", async () => {
  const base = samplePackageInput();
  const record = base.records[0]!;
  const at = (withheld: string[]) => buildResearchPackage({ ...base, includeDarwinCoreArchive: false, records: [{ ...record, withheld }] }).then(() => [] as string[], (error: unknown) => (error instanceof ResearchPackageError ? [...error.problems] : [String(error)]));
  assert.deepEqual(await at(["canonical.fields.profile.data.*", "measurements[*].remarks", "extension.*"]), []);
  assert.ok((await at(["secret[*].x"])).some((problem) => /must start with/u.test(problem)));
});

// ---------------------------------------------------------------------------
// G5 no place names for a location that is not published

test("G5: locality, site ids and collection-site fields never pass for restricted or not_collected rows, even with keepKeys", () => {
  const names = ["locality", "siteId", "siteName", "site_id", "collectionSite", "collection_site", "site/site_name", "placeName", "municipality", "verbatimLocality"];
  for (const state of ["restricted", "not_collected"]) {
    const row: Record<string, unknown> = { locationVisibility: state, habitat: "heath", title: "T" };
    for (const name of names) row[name] = "Synthetic Creek";
    const staged = withholdStagedRow({ data: { ...row }, source: { ...row }, keepKeys: [...names, "habitat"], ...stagedOptions });
    for (const part of [staged.value.data, staged.value.source]) {
      assert.equal(text(part).includes("Synthetic Creek"), false, `${state}: ${text(part)}`);
      assert.equal(part.habitat, "heath", "a safe kept question stays");
    }
    const event: Record<string, unknown> = { locationVisibility: state };
    for (const name of names) event[name] = "Synthetic Creek";
    const canonical = withholdCanonicalRecordVersion(canonicalWith(event), { keepKeys: names });
    assert.equal(text(canonical.value).includes("Synthetic Creek"), false, `${state}: ${text(canonical.value)}`);
  }
});

test("G5: a published location keeps its place names", () => {
  const staged = withholdStagedRow({ data: { locality: "Synthetic Creek" }, source: { locationVisibility: "public", siteId: "S-1", collectionSite: "Pond" }, ...stagedOptions });
  assert.equal(staged.value.data.locality, "Synthetic Creek");
  assert.equal(staged.value.source.siteId, "S-1");
  const canonical = withholdCanonicalRecordVersion(canonicalWith({ locationVisibility: "generalized", locality: "Synthetic Creek" }));
  assert.equal((canonical.value.fields as { event: { locality: string } }).event.locality, "Synthetic Creek");
});

test("G5: isPlaceNameKey names places, not counts", () => {
  for (const key of ["locality", "siteId", "SiteName", "site_id", "collectionSite", "collection_site", "site/site_name", "placeName", "municipality", "verbatimLocality", "stateProvince"]) assert.equal(isPlaceNameKey(key), true, key);
  for (const key of ["siteCount", "title", "habitat", "recordedBy", "eventDate", "method"]) assert.equal(isPlaceNameKey(key), false, key);
});
