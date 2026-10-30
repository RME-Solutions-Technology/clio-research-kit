import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  ImportError,
  PROJECT_SCHEMA_FORMAT,
  ResearchPackageError,
  SCHEMA_KEYWORDS,
  ZipStoreError,
  bcp47,
  buildDarwinCoreArchive,
  buildResearchPackage,
  compareChanges,
  createStoredZip,
  emlCreator,
  isCalendarDate,
  isIsoDateTime,
  previewImport,
  profileToJsonSchema,
  readResearchPackageZip,
  readStoredZip,
  schemaProfiles,
  sniffDelimiter,
  spreadsheetSafeText,
  toCsv,
  utcDateOf,
  validateProjectSchemaDocument,
  verifyResearchPackage,
  zipResearchPackage,
  type ImportRow,
  type ProjectSchemaDocument,
  type ResearchPackageInput,
} from "../src/index.ts";
import { sampleArchiveInput, samplePackageInput } from "../scripts/sample-package.ts";

// One test (or a few) per finding of the independent review of part 1 (2026-10-30-review-open-part1.md).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const row = (sourceId: string, data: Record<string, unknown>, source: Record<string, unknown> = {}): ImportRow => ({ sourceId, source, data });
const code = (error: unknown): string | undefined => (error instanceof ImportError ? error.code : undefined);

// ---------------------------------------------------------------------------
// H1 prototype pollution in compareChanges

test("H1: compareChanges refuses prototype-reaching and blank keys and never pollutes Object.prototype", () => {
  const base = [row("a", { x: 1 })];
  const current = [row("a", { x: 7 })];
  const hostile = JSON.parse("[{\"sourceId\":\"a\",\"source\":{},\"data\":{\"x\":1,\"__proto__\":{\"polluted\":\"yes\"}}}]") as ImportRow[];
  assert.throws(() => compareChanges(base, hostile, current), (error: unknown) => code(error) === "json.unsafe-key");
  const nested = JSON.parse("[{\"sourceId\":\"a\",\"source\":{\"deep\":{\"constructor\":{\"prototype\":{\"polluted\":\"yes\"}}}},\"data\":{\"x\":1}}]") as ImportRow[];
  assert.throws(() => compareChanges(base, nested, current), (error: unknown) => code(error) === "json.unsafe-key");
  assert.throws(() => compareChanges(hostile, base, current), (error: unknown) => code(error) === "json.unsafe-key", "base and current are checked too");
  assert.throws(() => compareChanges(base, [row("a", { "": 1 })], current), (error: unknown) => code(error) === "changes.blank-key");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("H1: a merge that has to create nested containers uses prototype-less objects and own properties", () => {
  const result = compareChanges([row("a", { x: 1 })], [row("a", { x: 1, nested: { deep: { value: 2 } } })], [row("a", { x: 7 })]);
  assert.equal(result.status, "merged");
  const merged = result.merged[0]!.data as Record<string, unknown>;
  assert.equal(merged.x, 7);
  const nested = merged.nested as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(nested), null);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), { x: 7, nested: { deep: { value: 2 } } });
});

// ---------------------------------------------------------------------------
// M5 compareChanges logic

test("M5: both sides making the same change is agreement, not a conflict", () => {
  const result = compareChanges([row("a", { x: 1, y: 1 })], [row("a", { x: 5, y: 2 })], [row("a", { x: 5, y: 1 })]);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.merged[0]!.data, { x: 5, y: 2 });
  const differing = compareChanges([row("a", { x: 1 })], [row("a", { x: 5 })], [row("a", { x: 6 })]);
  assert.deepEqual(differing.conflicts.map((conflict) => conflict.reason), ["both-changed"]);
});

test("M5: keys that contain dots stay separate from nested keys", () => {
  const base = [row("a", { "a.b": 1, a: { b: 1 } })];
  const result = compareChanges(base, [row("a", { "a.b": 9, a: { b: 1 } })], [row("a", { "a.b": 1, a: { b: 2 } })]);
  assert.equal(result.conflicts.length, 0, "a.b and a/b are different keys");
  assert.deepEqual(JSON.parse(JSON.stringify(result.merged[0]!.data)), { "a.b": 9, a: { b: 2 } });
  const clash = compareChanges(base, [row("a", { "a.b": 9, a: { b: 1 } })], [row("a", { "a.b": 8, a: { b: 1 } })]);
  assert.deepEqual(clash.conflicts.map((conflict) => conflict.path), [["data", "a.b"]]);
  assert.equal(clash.conflicts[0]!.field, "data.a.b");
});

test("M5: setting a value to null is a change, not a deletion", () => {
  const result = compareChanges([row("a", { x: 1, y: 1 })], [row("a", { x: null, y: 1 })], [row("a", { x: 1, y: 2 })]);
  assert.deepEqual(JSON.parse(JSON.stringify(result.merged[0]!.data)), { x: null, y: 2 });
});

// ---------------------------------------------------------------------------
// M1 importer dates

const importCsv = (content: string, extra: Record<string, unknown> = {}) => previewImport({ format: "csv", presetId: "observation", content, ...extra } as never);
const codes = (result: ReturnType<typeof importCsv>, index = 0) => result.rows[index]!.findings.map((finding) => `${finding.severity}:${finding.code}:${finding.field}`);

test("M1: columns that merely contain the letters 'date' are not date columns", () => {
  const result = importCsv("id,eventDate,candidate_name,last_update_by\nr1,2026-09-14,Ada,Bob\n");
  assert.ok(!codes(result).some((item) => item.includes("date.invalid")), codes(result).join());
});

test("M1: partial dates, intervals and local date-times are accepted; the missing zone is a warning", () => {
  for (const good of ["2026", "2026-09", "2026-09-14", "2026-09-14/2026-09-15", "2026-09/2026-10", "2026-09-14T10:30", "2026-09-14T10:30:00", "2026-09-14T10:30:00Z", "2026-09-14T10:30:00.123+11:00"]) {
    const result = importCsv(`id,eventDate\nr1,${good}\n`);
    assert.ok(!codes(result).some((item) => item.startsWith("error:date")), `${good}: ${codes(result).join()}`);
  }
  assert.ok(codes(importCsv("id,eventDate\nr1,2026-09-14T10:30:00\n")).includes("warning:date.no-timezone:eventDate"));
  assert.ok(!codes(importCsv("id,eventDate\nr1,2026-09-14T10:30:00Z\n")).some((item) => item.includes("no-timezone")));
  assert.ok(codes(importCsv("id,eventDate\nr1,2026-09-15/2026-09-14\n")).includes("warning:date.interval-reversed:eventDate"));
});

test("M1: impossible dates are still errors", () => {
  for (const bad of ["2026-02-31", "2026-13-01", "2026-09-31", "2026-00", "2026-09-14T25:00:00Z", "yesterday", "2026-09-14/2026-09-15/2026-09-16", "2026-09-14T10:30:00+25:00"]) {
    assert.ok(codes(importCsv(`id,eventDate\nr1,${bad}\n`)).includes("error:date.invalid:eventDate"), bad);
  }
  assert.ok(codes(importCsv("id,eventDate\nr1,2024-02-29\n")).every((item) => !item.startsWith("error:date")));
  assert.ok(codes(importCsv("id,eventDate\nr1,2026-02-29\n")).includes("error:date.invalid:eventDate"));
});

test("M1: a date-looking column that was not mapped is only a warning", () => {
  const result = importCsv("id,eventDate,survey_date\nr1,2026-09-14,not a date\n");
  assert.ok(codes(result).includes("warning:date.invalid:survey_date"));
  assert.ok(!codes(result).some((item) => item.startsWith("error:date")));
});

// ---------------------------------------------------------------------------
// M2, M3, M4 importer

test("M2: an automatically matched ID column is the row's source ID", () => {
  const result = importCsv("Record ID,date\nA1,2026-09-14\nA2,2026-09-15\n");
  assert.deepEqual(result.rows.map((item) => [item.sourceId, item.data.sourceId]), [["A1", "A1"], ["A2", "A2"]]);
  assert.ok(result.rows.every((item) => !item.sourceId.startsWith("row-")));
});

test("M3: the summary counts rows with no import error and does not call them valid", () => {
  const result = importCsv("id,eventDate\nr1,2026-09-14\n");
  assert.equal(result.summary.noImportErrors, 1);
  assert.equal("valid" in result.summary, false);
});

test("M4: semicolon and tab files are read; the delimiter is reported; an explicit one wins", () => {
  const semicolon = importCsv("id;eventDate;species\nr1;2026-09-14;Exemplaria synthetica\n");
  assert.equal(semicolon.delimiter, ";");
  assert.equal(semicolon.rows[0]!.data.identification, "Exemplaria synthetica");
  const tab = importCsv("id\teventDate\nr1\t2026-09-14\n");
  assert.equal(tab.delimiter, "\t");
  assert.equal(tab.rows[0]!.data.eventDate, "2026-09-14");
  assert.equal(importCsv("id,eventDate\nr1,2026-09-14\n").delimiter, ",");
  assert.equal(sniffDelimiter("\"a;b\",c\n1,2\n"), ",", "a semicolon inside quotes does not count");
  assert.equal(importCsv("id;eventDate\nr1;2026-09-14\n", { delimiter: ";" }).delimiter, ";");
  assert.throws(() => importCsv("a,b\n1,2\n", { delimiter: "|" }), (error: unknown) => code(error) === "input.delimiter");
});

test("M4: blank lines are not rows", () => {
  const result = importCsv("id,eventDate\n\nr1,2026-09-14\n\n\nr2,2026-09-15\n\n");
  assert.equal(result.summary.total, 2);
  assert.deepEqual(result.rows.map((item) => item.sourceId), ["r1", "r2"]);
  assert.equal(importCsv("\n\nid,eventDate\nr1,2026-09-14\n").summary.total, 1);
});

// ---------------------------------------------------------------------------
// H2 withheld and location checks in the package builder

const secretRef = "PRIVATE-REF-MARKER";
function packageWith(mutate: (input: ResearchPackageInput) => ResearchPackageInput): Promise<unknown> {
  return buildResearchPackage(mutate(samplePackageInput()));
}
function restrictedRecord(extra: Record<string, unknown>): ResearchPackageInput["records"][number] {
  const base = samplePackageInput().records[0]!;
  const fields = (base.canonical as { fields: { event: Record<string, unknown> } }).fields;
  const event = { ...fields.event, locationVisibility: "restricted", privateLocationObjectRef: secretRef, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyM: undefined };
  return { ...base, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, canonical: { ...base.canonical, fields: { ...fields, event } }, ...extra } as never;
}
const problemsOf = async (promise: Promise<unknown>): Promise<string[]> => {
  try { await promise; return []; } catch (error) { assert.ok(error instanceof ResearchPackageError, String(error)); return [...error.problems]; }
};

test("H2: a withheld path that still holds a value is refused", async () => {
  const record = restrictedRecord({ withheld: ["canonical.fields.event.privateLocationObjectRef"] });
  const problems = await problemsOf(packageWith((input) => ({ ...input, records: [record, ...input.records.slice(1)] })));
  assert.ok(problems.some((problem) => /privateLocationObjectRef is listed as withheld but its value is still in the record/u.test(problem)), problems.join(" | "));
});

test("H2: a withheld path that really is gone is accepted, and the marker is nowhere in records.jsonl or records.csv", async () => {
  const base = restrictedRecord({});
  const event = { ...(base.canonical as { fields: { event: Record<string, unknown> } }).fields.event };
  delete event.privateLocationObjectRef;
  delete event.geodeticDatum; // a datum is part of the place and goes with it
  const clean = { ...base, canonical: { ...base.canonical, fields: { ...(base.canonical as { fields: object }).fields, event } }, withheld: ["canonical.fields.event.privateLocationObjectRef"] } as never;
  const built = await buildResearchPackage({ ...samplePackageInput(), includeDarwinCoreArchive: false, records: [clean] });
  const text = (path: string) => new TextDecoder().decode(built.files.find((file) => file.path === path)!.bytes);
  assert.ok(!text("data/records.jsonl").includes(secretRef) && !text("data/records.csv").includes(secretRef));
  assert.match(text("data/records.csv"), /Withheld from this export: canonical\.fields\.event\.privateLocationObjectRef/u);
  assert.deepEqual(await verifyResearchPackage(built.files), { valid: true, problems: [] });
});

test("H2: withheld paths must be paths into the record, with arrays and typos checked", async () => {
  const base = samplePackageInput();
  const at = (withheld: string[]) => problemsOf(buildResearchPackage({ ...base, includeDarwinCoreArchive: false, records: [{ ...base.records[0]!, withheld }, base.records[1]!] }));
  assert.ok((await at(["fields.event.x"])).some((problem) => /must start with canonical, extension, measurements, projectSchema or a flat text field/u.test(problem)));
  assert.ok((await at(["measurements[0].typeLabel"])).some((problem) => /still in the record/u.test(problem)), "an array element that exists");
  assert.deepEqual(await at(["measurements[7].typeLabel", "canonical.never.existed"]), [], "paths that lead nowhere are fine");
});

test("H2: restricted coordinates cannot reach records.csv", async () => {
  const record = restrictedRecord({ decimalLatitude: -33.8, decimalLongitude: 151.2, coordinateUncertaintyInMeters: 50 });
  const problems = await problemsOf(packageWith((input) => ({ ...input, includeDarwinCoreArchive: false, records: [record] })));
  for (const name of ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyInMeters"]) assert.ok(problems.some((problem) => problem.includes(`${name} is set but the record's location visibility is \"restricted\"`)), name);
});

test("H2: flat coordinates must match the record's own (generalised) coordinates", async () => {
  const base = samplePackageInput().records[0]!;
  const fields = (base.canonical as { fields: { event: Record<string, unknown> } }).fields;
  const generalised = { ...base, canonical: { ...base.canonical, fields: { ...fields, event: { ...fields.event, locationVisibility: "generalized", decimalLatitude: -34, decimalLongitude: 151 } } } };
  const exact = { ...generalised, decimalLatitude: -33.8, decimalLongitude: 151.2, coordinateUncertaintyInMeters: 50 } as never;
  const problems = await problemsOf(buildResearchPackage({ ...samplePackageInput(), includeDarwinCoreArchive: false, records: [exact] }));
  assert.ok(problems.some((problem) => /decimalLatitude differs from the record's own value/u.test(problem)), problems.join(" | "));
  const agreeing = { ...generalised, decimalLatitude: -34, decimalLongitude: 151, coordinateUncertaintyInMeters: 50 } as never;
  assert.deepEqual(await problemsOf(buildResearchPackage({ ...samplePackageInput(), includeDarwinCoreArchive: false, records: [agreeing] })), []);
});

// ---------------------------------------------------------------------------
// M6 reserved extension keys

test("M6: an extension field cannot be called recordId, versionId or an object property name", () => {
  const schema = (key: string): ProjectSchemaDocument => ({
    format: PROJECT_SCHEMA_FORMAT, schemaKey: "reef", version: "1.0.0", title: "Reef", extends: { profileId: "clio.profile.structured-survey", profileVersion: "1.0.0" },
    fields: [{ key, label: "X", datatype: "string", termIri: "https://example.org/terms/x", sensitivity: "public" }],
  });
  for (const key of ["recordId", "versionId", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    assert.ok(validateProjectSchemaDocument(schema(key)).some((item) => item.code === "invalid_field" && /reserved/u.test(item.message)), key);
  }
  assert.deepEqual(validateProjectSchemaDocument(schema("recordNote")), []);
});

test("M6: the extension CSV keeps identifier columns first and unharmed", async () => {
  const base = samplePackageInput();
  const schema: ProjectSchemaDocument = {
    format: PROJECT_SCHEMA_FORMAT, schemaKey: "reef", version: "1.0.0", title: "Reef", extends: { profileId: "clio.profile.biological-occurrence", profileVersion: "1.0.0" },
    fields: [{ key: "zone", label: "Zone", datatype: "string", termIri: "https://example.org/terms/zone", sensitivity: "public" }],
  };
  const record = { ...base.records[0]!, projectSchema: { schemaKey: "reef", version: "1.0.0" }, extension: { zone: "crest" } };
  const ok = await buildResearchPackage({ ...base, includeDarwinCoreArchive: false, schemas: [schema], records: [record] });
  const csv = new TextDecoder().decode(ok.files.find((file) => file.path === "data/extensions/reef-1.0.0.csv")!.bytes);
  assert.match(csv, /^recordId,versionId,zone\r\nrec-a,v1,crest\r\n/u);
});

// ---------------------------------------------------------------------------
// M7 dates and ORCID

test("M7: impossible createdAt dates are refused by the package and the archive", async () => {
  for (const createdAt of ["2026-02-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-22", "2026-10-22T25:00:00Z", "2026-10-22T01:00:00"]) {
    const problems = await problemsOf(buildResearchPackage({ ...samplePackageInput(), createdAt }));
    assert.ok(problems.some((problem) => problem.startsWith("createdAt must be")), createdAt);
    assert.throws(() => buildDarwinCoreArchive({ ...sampleArchiveInput(), createdAt }), /createdAt must be/u, createdAt);
  }
  assert.equal(isCalendarDate("2026-02-31"), false);
  assert.equal(isIsoDateTime("2026-02-31T00:00:00Z"), false);
});

test("M7: Bagging-Date and pubDate are the UTC calendar date", async () => {
  const createdAt = "2026-10-22T01:00:00+11:00";
  assert.equal(utcDateOf(createdAt), "2026-10-21");
  const built = await buildResearchPackage({ ...samplePackageInput(), createdAt });
  assert.match(new TextDecoder().decode(built.files.find((file) => file.path === "bag-info.txt")!.bytes), /^Bagging-Date: 2026-10-21$/mu);
  const archive = buildDarwinCoreArchive({ ...sampleArchiveInput(), createdAt });
  assert.match(archive.files.find((file) => file.path === "eml.xml")!.text, /<pubDate>2026-10-21<\/pubDate>/u);
});

test("M7: an ORCID with a wrong check digit is refused everywhere; a right one is accepted", async () => {
  const wrong = "https://orcid.org/0000-0002-1825-0098";
  const problems = await problemsOf(buildResearchPackage({ ...samplePackageInput(), creator: { name: "Test Team", orcid: wrong } }));
  assert.ok(problems.some((problem) => /creator\.orcid must be an https:\/\/orcid\.org\/ iD with a correct check digit/u.test(problem)));
  assert.throws(() => buildDarwinCoreArchive({ ...sampleArchiveInput(), creator: { individualName: { surName: "Team" }, orcid: wrong } }), /orcid must be an https:\/\/orcid\.org\/ iD/u);
  assert.deepEqual(await problemsOf(buildResearchPackage({ ...samplePackageInput(), creator: { name: "Test Team", orcid: "https://orcid.org/0000-0002-1825-0097" } })), []);
  assert.throws(() => buildDarwinCoreArchive({ ...sampleArchiveInput(), creator: { individualName: { surName: "Team" }, orcid: "0000-0002-1825-0097" } }), /orcid must be/u, "a bare id is not an https iD");
});

// ---------------------------------------------------------------------------
// M8 stable occurrenceID

test("M8: the occurrenceID does not change when a record gets a new version", () => {
  const input = sampleArchiveInput();
  const [first] = input.records;
  const v1 = buildDarwinCoreArchive({ ...input, records: [{ ...first!, landingPage: undefined as never, versionId: "v1" }] });
  const v2 = buildDarwinCoreArchive({ ...input, records: [{ ...first!, landingPage: undefined as never, versionId: "v2" }] });
  const table = (archive: typeof v1) => archive.files.find((file) => file.path === "occurrence.txt")!.text.split("\n").map((line) => line.split("\t"));
  const ids = (archive: typeof v1) => { const rows = table(archive); const column = rows[0]!.indexOf("occurrenceID"); return rows[1]![column]; };
  assert.equal(ids(v1), ids(v2));
  assert.equal(ids(v1), "urn:clio:record:rec-a");
  const dynamic = (archive: typeof v1) => { const rows = table(archive); return rows[1]![rows[0]!.indexOf("dynamicProperties")]; };
  assert.equal(dynamic(v1), "{\"recordVersionId\":\"v1\"}");
  assert.equal(dynamic(v2), "{\"recordVersionId\":\"v2\"}");
  const meta = v1.files.find((file) => file.path === "meta.xml")!.text;
  assert.match(meta, /dynamicProperties/u);
});

// ---------------------------------------------------------------------------
// M9 / M10 JSON Schema

test("M9: the schemas compile under Ajv's default strict mode once the keywords are registered", () => {
  const ajv = new Ajv2020({ allErrors: false });
  addFormats.default(ajv);
  ajv.addVocabulary([...SCHEMA_KEYWORDS]);
  for (const profile of schemaProfiles()) assert.doesNotThrow(() => ajv.compile(profileToJsonSchema(profile)), `${profile.id}@${profile.version}`);
  const strictWithout = new Ajv2020();
  addFormats.default(strictWithout);
  assert.throws(() => strictWithout.compile(profileToJsonSchema(schemaProfiles()[0]!)), /unknown keyword/u, "documents why registration is needed");
});

test("M9: SCHEMA_KEYWORDS lists every x-clio keyword the generated schemas use, and index.json repeats it", () => {
  const used = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) { if (key.startsWith("x-clio-")) used.add(key); walk(child); }
  };
  for (const profile of schemaProfiles()) walk(profileToJsonSchema(profile));
  for (const key of used) assert.ok(SCHEMA_KEYWORDS.includes(key), key);
  const index = JSON.parse(readFileSync(join(root, "schemas", "index.json"), "utf8")) as { keywords: string[] };
  assert.deepEqual(index.keywords, [...SCHEMA_KEYWORDS]);
});

test("M10: schema date patterns enforce month lengths and leap years", () => {
  const profile = schemaProfiles().find((item) => item.fields.some((field) => field.datatype === "date"))!;
  const field = profile.fields.find((item) => item.datatype === "date")!;
  const property = (profileToJsonSchema(profile).properties as Record<string, { pattern?: string; anyOf?: { pattern?: string }[] }>)[field.key]!;
  const pattern = new RegExp(property.pattern ?? property.anyOf!.find((item) => item.pattern)!.pattern!, "u");
  for (const good of ["2026-02-28", "2024-02-29", "2000-02-29", "2026-04-30", "2026-12-31", "2026-01-31"]) assert.ok(pattern.test(good), good);
  for (const bad of ["2026-02-31", "2026-02-29", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-32", "2026-1-01"]) assert.ok(!pattern.test(bad), bad);
});

// ---------------------------------------------------------------------------
// M12 BagIt serialisation and ZIP names

test("M12: a serialised bag unpacks to one top-level directory and verifies", async () => {
  const built = await buildResearchPackage(samplePackageInput());
  const zip = zipResearchPackage(built, { modifiedAt: "2026-10-22T01:00:00Z" });
  const names = readStoredZip(zip).map((entry) => entry.name);
  assert.ok(names.every((name) => name.startsWith("pkg-sample-0001/")));
  assert.ok(names.includes("pkg-sample-0001/bagit.txt") && names.includes("pkg-sample-0001/data/records.csv"));
  const back = readResearchPackageZip(zip);
  assert.equal(back.packageId, "pkg-sample-0001");
  assert.deepEqual(await verifyResearchPackage(back.files), { valid: true, problems: [] });
  const flat = createStoredZip(built.files.map((file) => ({ name: file.path, bytes: file.bytes })), { modifiedAt: "2026-10-22T01:00:00Z" });
  assert.throws(() => readResearchPackageZip(flat), (error: unknown) => error instanceof ResearchPackageError && /single top-level|exactly one top-level/u.test(error.problems.join()));
});

test("M12: a corrupt local header name is a ZipStoreError, not a TypeError", () => {
  const zip = createStoredZip([{ name: "abcd.txt", bytes: new TextEncoder().encode("x") }], { modifiedAt: "2026-01-01T00:00:00Z" });
  const broken = new Uint8Array(zip);
  broken[30] = 0xff; // first byte of the local name: not valid UTF-8
  assert.throws(() => readStoredZip(broken), (error: unknown) => error instanceof ZipStoreError);
});

test("M12: names that collide or alias on Windows and macOS are refused", () => {
  const make = (name: string) => () => createStoredZip([{ name, bytes: new Uint8Array() }], { modifiedAt: "2026-01-01T00:00:00Z" });
  for (const bad of ["CON.txt", "con", "dir/NUL", "COM1.csv", "lpt9.txt", "a/b:c", "x/trailing.", "x/trailing ", "a<b", "q?.txt", "pipe|.txt"]) assert.throws(make(bad), ZipStoreError, bad);
  assert.throws(() => createStoredZip([{ name: "README", bytes: new Uint8Array() }, { name: "readme", bytes: new Uint8Array() }], { modifiedAt: "2026-01-01T00:00:00Z" }), /differ only by case/u);
  assert.doesNotThrow(make("console.txt"));
  assert.doesNotThrow(make("dwca/meta.xml"));
});

// ---------------------------------------------------------------------------
// M13 licence in package.json, H3 package shape

test("M13: package.json declares both licences; H3: it points at built output and ships no source or tests", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(manifest.license, "Apache-2.0 AND CC-BY-4.0");
  assert.equal(manifest.exports["."].default, "./dist/index.js");
  assert.equal(manifest.exports["."].types, "./dist/index.d.ts");
  assert.equal(manifest.main, "./dist/index.js");
  assert.equal(manifest.sideEffects, false);
  assert.ok(manifest.files.includes("dist") && manifest.files.includes("schemas") && !manifest.files.includes("src") && !manifest.files.includes("test"));
  assert.equal(manifest.scripts.prepack, "pnpm run build");
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), []);
  const build = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
  assert.equal(build.compilerOptions.rewriteRelativeImportExtensions, true);
  assert.equal(build.compilerOptions.declaration, true);
});

// ---------------------------------------------------------------------------
// L1, L2, L3 and the spreadsheet-safe export

test("L1: the EML system attribute is a neutral default that can be set; xml:lang is BCP 47", () => {
  const eml = buildDarwinCoreArchive(sampleArchiveInput()).files.find((file) => file.path === "eml.xml")!.text;
  assert.match(eml, /system="research-kit"/u);
  assert.match(eml, /xml:lang="en"/u);
  assert.match(eml, /<language>eng<\/language>/u, "the element keeps the ISO 639-2 code");
  const named = buildDarwinCoreArchive({ ...sampleArchiveInput(), system: "my-host.example.org", language: "fra" }).files.find((file) => file.path === "eml.xml")!.text;
  assert.match(named, /system="my-host\.example\.org"/u);
  assert.match(named, /xml:lang="fr"/u);
  assert.equal(bcp47("xyz"), "xyz");
  assert.throws(() => buildDarwinCoreArchive({ ...sampleArchiveInput(), system: "bad \"quote" }), /system must be/u);
});

test("L2: the package creator becomes a given name and surname, or an organisation", () => {
  assert.deepEqual(emlCreator({ name: "Ada Lovelace" }).individualName, { givenName: "Ada", surName: "Lovelace" });
  assert.deepEqual(emlCreator({ name: "Lovelace, Ada" }).individualName, { givenName: "Ada", surName: "Lovelace" });
  assert.deepEqual(emlCreator({ name: "Mary Jane van der Berg", givenName: "Mary Jane", surName: "van der Berg" }).individualName, { givenName: "Mary Jane", surName: "van der Berg" });
  assert.deepEqual(emlCreator({ name: "Madonna" }).individualName, { surName: "Madonna" });
  const organisation = emlCreator({ name: "Reef Lab", organisationName: "Reef Lab Pty" });
  assert.equal(organisation.organizationName, "Reef Lab Pty");
  assert.equal(organisation.individualName, undefined);
});

test("L3: a resource name keeps a dot suffix that is not a file extension", async () => {
  const built = await buildResearchPackage({ ...samplePackageInput(), packageId: "export.final" });
  const descriptor = JSON.parse(new TextDecoder().decode(built.files.find((file) => file.path === "data/datapackage.json")!.bytes)) as { name: string };
  assert.equal(descriptor.name, "export.final");
});

test("spreadsheet-safe export: text that starts =, +, - or @ gets a leading quote; numbers do not; default is unchanged", async () => {
  assert.equal(spreadsheetSafeText("=1+1"), "'=1+1");
  assert.equal(spreadsheetSafeText("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(spreadsheetSafeText("+cmd"), "'+cmd");
  assert.equal(spreadsheetSafeText("-2+3"), "'-2+3");
  assert.equal(spreadsheetSafeText("\t=1"), "'\t=1");
  assert.equal(spreadsheetSafeText("-33.8"), "-33.8");
  assert.equal(spreadsheetSafeText("plain"), "plain");
  assert.equal(toCsv(["a", "b"], [{ a: "=HYPERLINK(\"x\")", b: -33.8 }], { spreadsheetSafe: true }), "a,b\r\n\"'=HYPERLINK(\"\"x\"\")\",-33.8\r\n");
  assert.equal(toCsv(["a"], [{ a: "=1+1" }]), "a\r\n=1+1\r\n", "off by default: values exactly as given");

  const base = samplePackageInput();
  const risky = { ...base.records[0]!, title: "=cmd|' /C calc'!A0" };
  const plain = await buildResearchPackage({ ...base, records: [risky] });
  const safe = await buildResearchPackage({ ...base, records: [risky], spreadsheetSafe: true });
  const text = (pkg: typeof plain, path: string) => new TextDecoder().decode(pkg.files.find((file) => file.path === path)!.bytes);
  assert.ok(text(plain, "data/records.csv").includes(",=cmd|"));
  assert.ok(text(safe, "data/records.csv").includes("'=cmd|"));
  assert.equal(text(safe, "data/records.jsonl"), text(plain, "data/records.jsonl"), "records.jsonl is the lossless copy and never changes");
  assert.match(text(safe, "data/README.txt"), /single quote in front of it/u);
  assert.deepEqual(await verifyResearchPackage(safe.files), { valid: true, problems: [] });

  const archive = buildDarwinCoreArchive({ ...sampleArchiveInput(), spreadsheetSafe: true, records: [{ ...sampleArchiveInput().records[0]!, fields: { ...sampleArchiveInput().records[0]!.fields, profile: { ...sampleArchiveInput().records[0]!.fields.profile, data: { ...sampleArchiveInput().records[0]!.fields.profile.data, taxonScientificName: "=Exemplaria" } } } }] });
  const occurrences = archive.files.find((file) => file.path === "occurrence.txt")!.text;
  assert.ok(occurrences.includes("\t'=Exemplaria\t") || occurrences.includes("\t'=Exemplaria"), occurrences);
});
