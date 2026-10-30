import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConnectorError,
  chunkRowsForImport,
  fetchOdkFields,
  fetchOdkSubmissions,
  odkAttachmentApiPath,
  odkCsvToRows,
  odkFieldsFromApi,
  odkFieldsFromXForm,
  odkODataToRows,
  readOdkForm,
  toImportInput,
  type ConnectorRow,
  type FetchLike,
} from "../src/connectors/index.ts";
import { previewImport } from "../src/importer.ts";

// Forms come from ODK Central's own test data (Apache-2.0); exports are synthetic
// in the documented format. See test/fixtures/README.md.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "odk");
const text = (path: string): string => readFileSync(resolve(root, path), "utf8");
const json = (path: string): unknown => JSON.parse(text(path));
const form = (name: string) => odkFieldsFromXForm(text(`forms/${name}.xml`));
const codeOf = (error: unknown): string | undefined => (error instanceof ConnectorError ? error.code : undefined);
const throwsCode = (run: () => unknown, code: string): void => assert.throws(run, (error: unknown) => codeOf(error) === code, `expected ConnectorError ${code}`);

// No test below may reach a network: the global fetch fails loudly if anything tries.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("network access in a test"); }) as unknown as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

const describe = (rows: readonly ConnectorRow[], keys: readonly string[]) => rows.map((row) => Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]])));

// ---------------------------------------------------------------------------
// Form definitions

test("XForms field lists: structures, repeats, types, select_multiple and binary fields", () => {
  const summary = (name: string) => form(name).map((field) => `${field.path}:${field.type}${field.binary ? "+binary" : ""}${field.selectMultiple ? "+multiple" : ""}`);
  assert.deepEqual(summary("simple"), ["/meta:structure", "/meta/instanceID:string", "/name:string", "/age:int"]);
  assert.deepEqual(summary("withrepeat"), [
    "/meta:structure", "/meta/instanceID:string", "/name:string", "/age:int", "/children:structure", "/children/child:repeat", "/children/child/name:string", "/children/child/age:int",
  ]);
  assert.ok(summary("doubleRepeat").includes("/children/child/toys/toy:repeat"), "a repeat inside a repeat");
  assert.deepEqual(summary("binaryType").slice(2), ["/file1:binary+binary", "/file2:binary+binary"]);
  assert.deepEqual(summary("selectMultiple").slice(2), ["/q1:string+multiple", "/g1:structure", "/g1/q2:string+multiple"]);
  assert.ok(summary("geoTypes").includes("/plural/nested_repeat/repeatnested_group/input_geopoint_deeply_nested:geopoint"));
  assert.ok(summary("groupRepeat").includes("/child_repeat/address/city:string"), "a group inside a repeat");
  assert.deepEqual(summary("nestedGroup").slice(0, 4), ["/text:string", "/hospital:structure", "/hospital/name:string", "/hospital/hiv_medication:structure"]);
});

test("the form reader refuses a DOCTYPE, oversize input and a form with no instance", () => {
  throwsCode(() => odkFieldsFromXForm("<!DOCTYPE x [<!ENTITY a \"b\">]><h:html/>"), "xform.doctype");
  throwsCode(() => odkFieldsFromXForm("<h:html><h:head><model/></h:head></h:html>"), "xform.no-instance");
  throwsCode(() => odkFieldsFromXForm("x".repeat(4 * 1024 * 1024 + 1)), "xform.size");
});

test("the /fields API response is validated and matches the XForms reading", () => {
  const apiShape = [
    { path: "/meta", name: "meta", type: "structure" },
    { path: "/meta/instanceID", name: "instanceID", type: "string" },
    { path: "/name", name: "name", type: "string" },
    { path: "/age", name: "age", type: "int" },
  ];
  assert.deepEqual(odkFieldsFromApi(apiShape), form("simple"));
  throwsCode(() => odkFieldsFromApi({}), "fields.invalid");
  throwsCode(() => odkFieldsFromApi([{ path: "name", name: "name", type: "string" }]), "fields.invalid");
  throwsCode(() => odkFieldsFromApi([{ path: "/__proto__", name: "x", type: "string" }]), "key.unsafe");
});

// ---------------------------------------------------------------------------
// OData JSON

test("Central's documented example: ids, numbers and no meta/instanceID echo", () => {
  const result = odkODataToRows(json("odata/docs-simple.json"), { fields: form("simple") });
  assert.deepEqual(result.rows.map((row) => row.sourceId), ["odk:uuid:85cb9aff-005e-4edd-9739-dc9c1a829c44", "odk:uuid:297000fd-8eb2-4232-8863-d25f82521b87"]);
  assert.deepEqual(describe(result.rows, ["name", "age", "meta/instanceID"]), [{ name: "Bob", age: 25 }, { name: "Alice", age: 30 }]);
  assert.deepEqual(result.findings, []);
});

test("without a form definition the data is kept and the connector says what it could not do", () => {
  const result = odkODataToRows(json("odata/docs-simple.json"));
  assert.equal(result.rows[0]!.age, 25);
  assert.deepEqual(result.findings.map((finding) => finding.code), ["fields.not-supplied"]);
  const attachments = odkODataToRows(json("odata/attachments.json"));
  assert.ok(attachments.findings.some((finding) => finding.code === "media.fields-unknown"), "attachments expected but no form definition");
  assert.deepEqual(attachments.media, []);
});

test("repeats arrive nested under the repeat path; internal repeat ids are dropped; an empty repeat is absent, as in the CSV", () => {
  const result = odkODataToRows(json("odata/withrepeat-expanded.json"), { fields: form("withrepeat") });
  assert.deepEqual(describe(result.rows, ["name", "age", "children/child"]), [
    { name: "Alice", age: 30 },
    { name: "Bob", age: 34, "children/child": [{ name: "Billy", age: 4 }, { name: "Blaine", age: 6 }] },
    { name: "Chelsea", age: 38, "children/child": [{ name: "Candace", age: 2 }] },
  ]);
  assert.equal(result.rows[1]!.edits, 1);
  assert.equal(result.rows[1]!.formVersion, "1.0");
  assert.equal(result.rows[1]!.submittedAt, "2026-03-02T04:00:00.000Z");
  assert.equal(result.rows[1]!.updatedAt, "2026-03-03T05:00:00.000Z");
});

test("a repeat that was not expanded is reported, not silently dropped", () => {
  const result = odkODataToRows(json("odata/withrepeat-not-expanded.json"), { fields: form("withrepeat") });
  const finding = result.findings.find((item) => item.code === "odata.repeat-not-expanded");
  assert.ok(finding && finding.field === "child" && /\$expand=\*/u.test(finding.message));
  assert.equal("children/child" in result.rows[0]!, false);
});

test("geopoint, geotrace, geoshape, nested repeats and local timestamps convert to the importer's shapes", () => {
  const result = odkODataToRows(json("odata/geotypes.json"), { fields: form("geoTypes"), eventDateField: "survey_started_at", geometryField: "singular/input_geoshape" });
  const row = result.rows[0]!;
  assert.deepEqual(row["singular/input_geopoint"], { type: "Point", coordinates: [0, 50, 0] });
  assert.equal((row["singular/input_geotrace"] as { type: string }).type, "LineString");
  assert.equal((row["singular/input_geoshape"] as { type: string }).type, "Polygon");
  assert.equal(row.latitude, 50);
  assert.equal(row.longitude, 0);
  assert.equal(row.eventDate, "2026-03-05T09:15:00.000+11:00", "the local clock reading and its offset are kept");
  assert.equal(row.survey_ended_at, "2026-03-05T09:40:30.250+11:00");
  assert.equal(row.submittedAt, "2026-03-01T01:02:03.000Z");
  const plural = row.plural as Record<string, unknown>[];
  assert.equal(plural.length, 2);
  assert.deepEqual((plural[0]!.nested_repeat as Record<string, unknown>[])[0], { "repeatnested_group/input_geopoint_deeply_nested": { type: "Point", coordinates: [11, 11, 11] } });
  assert.deepEqual(result.findings, []);
});

test("$wkt output gives the same geometry as GeoJSON output", () => {
  const fields = form("geoTypes");
  const geo = odkODataToRows(json("odata/geotypes.json"), { fields }).rows[0]!;
  const wkt = odkODataToRows(json("odata/geotypes-wkt.json"), { fields }).rows[0]!;
  for (const key of ["singular/input_geopoint", "singular/input_geotrace", "singular/input_geoshape"]) assert.deepEqual(wkt[key], geo[key], key);
});

test("select_multiple strings become arrays, including a leading space and an empty group", () => {
  const result = odkODataToRows(json("odata/selectmultiple.json"), { fields: form("selectMultiple") });
  assert.deepEqual(describe(result.rows, ["q1", "g1/q2"]), [{ q1: ["a", "b"], "g1/q2": ["x", "y", "z"] }, { q1: ["b"], "g1/q2": ["m", "x"] }, { q1: ["b", "c"] }]);
});

test("attachments become media references with an API path, never bytes", () => {
  const result = odkODataToRows(json("odata/attachments.json"), { fields: form("binaryType"), project: 7, form: "binaryType" });
  assert.deepEqual(result.media.slice(0, 2).map(({ field, filename, mediaType, apiPath }) => ({ field, filename, mediaType, apiPath })), [
    { field: "file1", filename: "my_file1.mp4", mediaType: "video/mp4", apiPath: "/v1/projects/7/forms/binaryType/submissions/both/attachments/my_file1.mp4" },
    { field: "file2", filename: "here_is_file2.jpg", mediaType: "image/jpeg", apiPath: "/v1/projects/7/forms/binaryType/submissions/both/attachments/here_is_file2.jpg" },
  ]);
  const unicode = result.media.filter((item) => item.sourceId === "odk:unicode");
  assert.equal(unicode.length, 2);
  assert.ok(unicode[0]!.apiPath!.endsWith(`/attachments/${encodeURIComponent("fîlé2")}`), "names are percent-encoded");
  assert.equal(unicode[0]!.mediaType, "application/octet-stream");
  assert.deepEqual((result.rows[0]!.media as unknown[]).length, 2);
  assert.ok(!JSON.stringify(result).includes("base64"));
});

test("an attachment name that could escape a folder is not turned into a media reference", () => {
  for (const name of ["../../etc/passwd", "a/b.jpg", "a\\b.jpg", "..", "C:evil.jpg", "x\u0000.jpg", "~root"]) {
    const result = odkODataToRows({ value: [{ __id: "u", file1: name, __system: {} }] }, { fields: form("binaryType") });
    assert.deepEqual(result.media, [], name);
    assert.ok(result.findings.some((finding) => finding.code === "media.unsafe-filename"), name);
    assert.equal(result.rows[0]!.file1, name, "the value is kept as written");
  }
});

test("text that starts like a spreadsheet formula is kept and reported", () => {
  const result = odkODataToRows({ value: [{ __id: "f", name: "=HYPERLINK(\"https://example.org\")", age: -3, __system: {} }, { __id: "g", name: "-33.8 north", __system: {} }, { __id: "h", name: "-33.8", __system: {} }] }, { fields: form("simple") });
  assert.equal(result.rows[0]!.name, "=HYPERLINK(\"https://example.org\")");
  assert.deepEqual(result.findings.filter((finding) => finding.code === "cell.formula-prefix").map((finding) => finding.sourceId), ["odk:f", "odk:g"]);
});

test("submitter and device identifiers are off unless asked for", () => {
  const input = json("odata/withrepeat-expanded.json");
  const plain = odkODataToRows(input, { fields: form("withrepeat") }).rows[0]!;
  assert.ok(!("submitterName" in plain) && !("submitterId" in plain) && !("deviceId" in plain));
  const asked = odkODataToRows(input, { fields: form("withrepeat"), includeSubmitter: true }).rows[0]!;
  assert.equal(asked.submitterName, "Test Submitter");
  assert.equal(asked.submitterId, "5");
});

test("form fields that clash with connector keys are renamed, not overwritten", () => {
  const result = odkODataToRows({ value: [{ __id: "c", latitude: "north", media: "x", __system: {} }] });
  assert.equal(result.rows[0]!["form/latitude"], "north");
  assert.equal(result.rows[0]!["form/media"], "x");
  assert.ok(!("latitude" in result.rows[0]!));
});

test("timestamps: offsets are normalised, never shifted; a missing offset is reported or supplied explicitly", () => {
  const fields = form("geoTypes");
  const row = (value: string) => ({ value: [{ __id: "t", survey_started_at: value, __system: {} }] });
  assert.equal(odkODataToRows(row("2026-03-05T09:15:00+1100"), { fields }).rows[0]!.survey_started_at, "2026-03-05T09:15:00+11:00");
  assert.equal(odkODataToRows(row("2026-03-05T09:15:00.123456Z"), { fields }).rows[0]!.survey_started_at, "2026-03-05T09:15:00.123Z");
  const naive = odkODataToRows(row("2026-03-05T09:15:00"), { fields });
  assert.equal(naive.rows[0]!.survey_started_at, "2026-03-05T09:15:00", "kept as written");
  assert.deepEqual(naive.findings.map((finding) => finding.code), ["timestamp.no-offset"]);
  const supplied = odkODataToRows(row("2026-03-05T09:15:00"), { fields, defaultUtcOffset: "+10:00" });
  assert.equal(supplied.rows[0]!.survey_started_at, "2026-03-05T09:15:00+10:00");
  assert.deepEqual(supplied.findings.map((finding) => finding.code), ["timestamp.offset-assumed"]);
  assert.equal(odkODataToRows(row("not a time"), { fields }).findings[0]!.code, "timestamp.unreadable");
  assert.equal(odkODataToRows(row("2026-02-30T09:15:00Z"), { fields }).findings[0]!.code, "timestamp.unreadable");
  throwsCode(() => odkODataToRows(row("2026-03-05T09:15:00"), { fields, defaultUtcOffset: "Sydney" }), "option.offset");
});

// ---------------------------------------------------------------------------
// CSV export

test("CSV export: main table plus repeat table equals the OData route", () => {
  const fields = form("withrepeat");
  const csv = odkCsvToRows({ main: text("csv/withrepeat.csv"), repeats: { children: text("csv/withrepeat-children.csv") } }, { fields });
  const odata = odkODataToRows(json("odata/withrepeat-expanded.json"), { fields });
  const keys = ["sourceId", "name", "age", "children/child", "submittedAt"];
  assert.deepEqual(describe(csv.rows, keys), describe(odata.rows, keys));
  assert.equal(csv.rows[1]!.formVersion, "1.0");
  assert.deepEqual(csv.findings, []);
});

test("CSV export: geopoint columns, traces, shapes and two levels of repeat match the OData route", () => {
  const fields = form("geoTypes");
  const csv = odkCsvToRows({ main: text("csv/geotypes.csv"), repeats: { nested: text("csv/geotypes-nested.csv"), plural: text("csv/geotypes-plural.csv") } }, { fields });
  const odata = odkODataToRows(json("odata/geotypes.json"), { fields });
  const strip = (row: ConnectorRow): unknown => JSON.parse(JSON.stringify(row, (key, value: unknown) => (key === "accuracyMetres" ? undefined : value)));
  const keys = ["singular/input_geopoint", "singular/input_geotrace", "singular/input_geoshape", "plural", "survey_started_at", "survey_ended_at", "latitude", "longitude"];
  assert.deepEqual(describe([strip(csv.rows[0]!) as ConnectorRow], keys), describe([strip(odata.rows[0]!) as ConnectorRow], keys));
  // The CSV carries GPS accuracy; Central's OData output omits it (documented).
  assert.deepEqual(csv.rows[0]!["singular/input_geopoint"], { type: "Point", coordinates: [0, 50, 0], accuracyMetres: 7.5 });
  assert.equal(csv.rows[0]!.uncertainty, 7.5);
  assert.equal("uncertainty" in odata.rows[0]!, false);
  assert.equal(csv.rows[0]!.formVersion, "10");
});

test("CSV export without a form definition: headers become keys, geopoint quartets still become Points", () => {
  const csv = odkCsvToRows({ main: text("csv/geotypes.csv") });
  const row = csv.rows[0]!;
  assert.deepEqual(row["singular-input_geopoint"], { type: "Point", coordinates: [0, 50, 0], accuracyMetres: 7.5 });
  assert.equal(row["singular-input_geotrace"], "51 1 0 0; 52 2 0 0", "text stays text");
  assert.equal(row.plural_count, "2");
  assert.equal(csv.findings[0]!.code, "fields.not-supplied");
});

test("CSV export with splitSelectMultiples: choice columns are dropped, the main column becomes an array", () => {
  const csv = odkCsvToRows({ main: text("csv/selectmultiple-split.csv") }, { fields: form("selectMultiple") });
  assert.deepEqual(describe(csv.rows, ["q1", "g1/q2"]), [{ q1: ["a", "b"], "g1/q2": ["x", "y", "z"] }, { q1: ["b"], "g1/q2": ["m", "x"] }, { q1: ["b", "c"] }]);
  assert.equal(csv.findings.filter((finding) => finding.code === "csv.split-select-dropped").length, 1, "said once, not per row");
  assert.ok(csv.rows.every((row) => Object.keys(row).every((key) => !/\/[abcmxyz]$/u.test(key) || key === "g1/q2")));
});

test("CSV structure errors fail closed", () => {
  throwsCode(() => odkCsvToRows({ main: "a,b\n1,2\n" }), "csv.no-key");
  throwsCode(() => odkCsvToRows({ main: "KEY\nx\nx\n" }), "csv.duplicate-key");
  throwsCode(() => odkCsvToRows({ main: "KEY,KEY\nx,y\n" }), "csv.duplicate-header");
  throwsCode(() => odkCsvToRows({ main: "KEY,__proto__\nx,y\n" }), "key.unsafe");
  throwsCode(() => odkCsvToRows({ main: "KEY,a\nx,\"unclosed\n" }), "csv.unclosed-quote");
  throwsCode(() => odkCsvToRows({ main: "KEY,a\nx,y,z\n" }), "csv.column-count");
  throwsCode(() => odkCsvToRows({ main: "KEY\nx\u0000\n" }), "csv.nul");
  throwsCode(() => odkCsvToRows({ main: "KEY\nx\n", repeats: { r: "a,b\n1,2\n" } }), "csv.no-key");
  throwsCode(() => odkCsvToRows({ main: "KEY\nx\n", repeats: { r: "KEY,PARENT_KEY\nbad,x\n" } }), "csv.repeat-key");
  throwsCode(() => odkCsvToRows({ main: "KEY\nx\n", repeats: { r: "KEY,PARENT_KEY\nx/r[1],x\nx/r[1],x\n" } }), "csv.duplicate-key");
  throwsCode(() => odkCsvToRows({ main: "KEY\nx\ny\n" }, { maxRows: 1 }), "limit.rows");
  throwsCode(() => odkCsvToRows({ main: "KEY\nx\n", repeats: { r: "KEY,PARENT_KEY\nx/__proto__[1],x\n" } }), "key.unsafe");
  const orphan = odkCsvToRows({ main: "KEY\nx\n", repeats: { r: "KEY,PARENT_KEY\ngone/r[1],gone\n" } });
  assert.ok(orphan.findings.some((finding) => finding.code === "csv.orphan-repeat-row"));
});

test("a CSV cell that starts like a formula is kept and reported", () => {
  const csv = odkCsvToRows({ main: "SubmissionDate,name,KEY\n2026-03-01T00:00:00.000Z,\"=1+1\",k\n" }, { fields: form("simple") });
  assert.equal(csv.rows[0]!.name, "=1+1");
  assert.ok(csv.findings.some((finding) => finding.code === "cell.formula-prefix"));
});

// ---------------------------------------------------------------------------
// Hostile JSON

test("OData input with prototype-polluting keys, bad ids or the wrong shape is refused", () => {
  throwsCode(() => odkODataToRows(JSON.parse("{\"value\":[{\"__id\":\"a\",\"__proto__\":{\"polluted\":true}}]}")), "key.unsafe");
  throwsCode(() => odkODataToRows({ value: [{ __id: "a", g: { constructor: 1 } }] }), "key.unsafe");
  throwsCode(() => odkODataToRows({ value: [{ name: "no id" }] }), "odata.missing-id");
  throwsCode(() => odkODataToRows({ value: [{ __id: "a" }, { __id: "a" }] }), "odata.duplicate-id");
  throwsCode(() => odkODataToRows({ rows: [] }), "odata.shape");
  throwsCode(() => odkODataToRows({ value: ["text"] }), "odata.row");
  throwsCode(() => odkODataToRows({ value: [{ __id: "a" }] }, { namespace: "Bad Name" }), "option.namespace");
  throwsCode(() => odkODataToRows({ value: [{ __id: "a" }, { __id: "b" }] }, { maxRows: 1 }), "limit.rows");
  let nested: unknown = "leaf";
  for (let level = 0; level < 20; level += 1) nested = { nested };
  throwsCode(() => odkODataToRows({ value: [{ __id: "a", nested }] }), "json.depth-limit");
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("attachment API paths validate their parts", () => {
  assert.equal(odkAttachmentApiPath(7, "simple", "uuid:abc", "a b.jpg"), "/v1/projects/7/forms/simple/submissions/uuid%3Aabc/attachments/a%20b.jpg");
  throwsCode(() => odkAttachmentApiPath("7/../8", "simple", "x", "y"), "option.project");
  throwsCode(() => odkAttachmentApiPath(7, "a/b", "x", "y"), "option.form");
});

// ---------------------------------------------------------------------------
// Into the importer

test("connector rows go through previewImport without changes to the importer", () => {
  const result = odkODataToRows(json("odata/geotypes.json"), { fields: form("geoTypes"), eventDateField: "survey_started_at", geometryField: "singular/input_geoshape" });
  const preview = previewImport(toImportInput(result, "observation"));
  assert.equal(preview.summary.total, 1);
  assert.equal(preview.rows[0]!.sourceId, "odk:geo1");
  assert.equal(preview.rows[0]!.data.eventDate, "2026-03-05T09:15:00.000+11:00");
  assert.equal(preview.rows[0]!.data.latitude, 50);
  assert.deepEqual(preview.rows[0]!.findings.filter((finding) => finding.severity === "error"), []);
  assert.deepEqual((preview.rows[0]!.source.geometry as { type: string }).type, "Polygon");
});

test("a mapping moves a form field onto a preset field", () => {
  const result = odkODataToRows(json("odata/withrepeat-expanded.json"), { fields: form("withrepeat") });
  const preview = previewImport(toImportInput(result, "observation", { name: "identification" }));
  assert.deepEqual(preview.rows.map((row) => row.data.identification), ["Alice", "Bob", "Chelsea"]);
});

test("rows are chunked to the importer's limits and order is kept", () => {
  const rows = Array.from({ length: 2500 }, (_, index) => ({ sourceId: `odk:r${index}`, note: "x" }));
  const chunks = chunkRowsForImport(rows, "observation");
  assert.deepEqual(chunks.map((chunk) => (JSON.parse(chunk.content) as unknown[]).length), [1000, 1000, 500]);
  assert.equal((JSON.parse(chunks[2]!.content) as { sourceId: string }[])[499]!.sourceId, "odk:r2499");
  for (const chunk of chunks) assert.doesNotThrow(() => previewImport(chunk));
  const big = [{ sourceId: "odk:big", note: "y".repeat(1_500_000) }, { sourceId: "odk:big2", note: "y".repeat(1_500_000) }];
  assert.equal(chunkRowsForImport(big, "observation").length, 2, "split on bytes");
  throwsCode(() => chunkRowsForImport([{ sourceId: "odk:huge", note: "y".repeat(2_200_000) }], "observation"), "limit.row-bytes");
  throwsCode(() => toImportInput({ rows, media: [], findings: [] }, "observation"), "limit.import");
});

// ---------------------------------------------------------------------------
// Fetching (mocked: no network)

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; text?: string; wait?: boolean };

function mockFetch(replies: Reply[]): { fetchImpl: FetchLike; calls: { url: string; headers: Record<string, string>; redirect: string }[] } {
  const calls: { url: string; headers: Record<string, string>; redirect: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: url.href, headers: { ...init.headers }, redirect: init.redirect });
    const reply = replies.shift();
    if (!reply) throw new Error("unexpected request");
    if (reply.wait) await new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
    const bytes = new TextEncoder().encode(reply.text ?? JSON.stringify(reply.body ?? {}));
    const status = reply.status ?? 200;
    return { status, ok: status >= 200 && status < 300, headers: { get: (name: string) => reply.headers?.[name.toLowerCase()] ?? null }, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
  };
  return { fetchImpl, calls };
}

const base = { server: "https://central.example.org", project: 7 as number | string, form: "simple", token: "synthetic-session-token" };

test("fetch: follows same-path pages, sends the bearer token in a header only, refuses redirects", async () => {
  const next = "https://central.example.org/v1/projects/7/forms/simple.svc/Submissions?%24top=250&%24expand=*&%24skiptoken=abc";
  const { fetchImpl, calls } = mockFetch([
    { body: { value: [{ __id: "a", name: "A" }], "@odata.nextLink": next } },
    { body: { value: [{ __id: "b", name: "B" }] } },
  ]);
  const rows = await fetchOdkSubmissions({ ...base, fetchImpl });
  assert.deepEqual(rows.map((row) => row.__id), ["a", "b"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, "https://central.example.org/v1/projects/7/forms/simple.svc/Submissions?%24top=250&%24expand=*");
  assert.equal(calls[0]!.headers.authorization, "Bearer synthetic-session-token");
  assert.equal(calls[0]!.redirect, "manual");
  assert.ok(calls.every((call) => !call.url.includes("synthetic-session-token")), "the token is never in a URL");
});

test("fetch: options become the documented query parameters", async () => {
  const { fetchImpl, calls } = mockFetch([{ body: { value: [] } }]);
  await fetchOdkSubmissions({ ...base, fetchImpl, maxRows: 5 }, { expand: false, wkt: true, filter: "year(__system/submissionDate) eq 2026" });
  const url = new URL(calls[0]!.url);
  assert.equal(url.searchParams.get("$top"), "5");
  assert.equal(url.searchParams.get("$wkt"), "true");
  assert.equal(url.searchParams.get("$expand"), null);
  assert.equal(url.searchParams.get("$filter"), "year(__system/submissionDate) eq 2026");
  await assert.rejects(fetchOdkSubmissions({ ...base, fetchImpl }, { filter: "x\u0000" }), (error: unknown) => codeOf(error) === "option.filter");
});

test("fetch: a next link that leaves the origin or path is not followed", async () => {
  for (const link of ["https://evil.example.net/v1/projects/7/forms/simple.svc/Submissions?x=1", "https://central.example.org/v1/projects/7/forms/other.svc/Submissions", "https://central.example.org/", 12]) {
    const { fetchImpl, calls } = mockFetch([{ body: { value: [{ __id: "a" }], "@odata.nextLink": link } }]);
    await assert.rejects(fetchOdkSubmissions({ ...base, fetchImpl }), (error: unknown) => codeOf(error) === "fetch.pagination");
    assert.equal(calls.length, 1, "no second request was made");
  }
});

test("fetch: redirects, errors, bad JSON, oversize and slow servers fail closed without leaking the token", async () => {
  const cases: [Reply, string][] = [
    [{ status: 302, headers: { location: "https://evil.example.net/" } }, "fetch.redirect"],
    [{ status: 401 }, "fetch.auth"],
    [{ status: 500 }, "fetch.http"],
    [{ text: "<html>not json</html>" }, "fetch.json"],
    [{ text: "{\"value\":[]}", headers: { "content-length": "999999999" } }, "limit.bytes"],
    [{ body: { rows: [] } }, "odata.shape"],
    [{ body: { value: [{ name: "no id" }] } }, "odata.missing-id"],
    [{ text: "{\"value\":[{\"__id\":\"a\",\"__proto__\":{}}]}" }, "key.unsafe"],
  ];
  for (const [reply, code] of cases) {
    const { fetchImpl } = mockFetch([reply]);
    await assert.rejects(fetchOdkSubmissions({ ...base, fetchImpl }), (error: unknown) => {
      assert.equal(codeOf(error), code);
      assert.ok(!String((error as Error).message).includes(base.token), "the message does not contain the token");
      return true;
    }, code);
  }
  const { fetchImpl } = mockFetch([{ wait: true }]);
  await assert.rejects(fetchOdkSubmissions({ ...base, fetchImpl, timeoutMs: 20 }), (error: unknown) => codeOf(error) === "fetch.timeout");
  const small = mockFetch([{ body: { value: [{ __id: "a" }, { __id: "b" }] } }]);
  await assert.rejects(fetchOdkSubmissions({ ...base, fetchImpl: small.fetchImpl, maxRows: 1 }), (error: unknown) => codeOf(error) === "limit.rows");
});

test("fetch: the server, project, form and token are validated before any request", async () => {
  const { fetchImpl, calls } = mockFetch([]);
  const bad: [Partial<typeof base>, string][] = [
    [{ server: "http://central.example.org" }, "fetch.server"],
    [{ server: "https://central.example.org/path" }, "fetch.server"],
    [{ server: "https://user:pw@central.example.org" }, "fetch.server"],
    [{ server: "https://central.example.org/?a=1" }, "fetch.server"],
    [{ server: "not a url" }, "fetch.server"],
    [{ project: "7/../8" }, "option.project"],
    [{ form: "a/b" }, "option.form"],
    [{ form: "a b" }, "option.form"],
    [{ token: "has space" }, "option.token"],
    [{ token: "line\nbreak" }, "option.token"],
    [{ token: "" }, "option.token"],
  ];
  for (const [override, code] of bad) await assert.rejects(fetchOdkSubmissions({ ...base, ...override, fetchImpl }), (error: unknown) => codeOf(error) === code, JSON.stringify(override));
  await assert.rejects(fetchOdkSubmissions({ ...base, fetchImpl, timeoutMs: 999_999 }), (error: unknown) => codeOf(error) === "limit.option");
  assert.equal(calls.length, 0);
  await assert.rejects(fetchOdkSubmissions(base), (error: unknown) => /network access in a test/u.test(String((error as Error).message)), "the default fetch is the only way to reach a network, and it is blocked here");
});

test("readOdkForm: fields from the API, submissions with repeats, converted in one call", async () => {
  const { fetchImpl, calls } = mockFetch([
    { body: [{ path: "/meta", name: "meta", type: "structure" }, { path: "/meta/instanceID", name: "instanceID", type: "string" }, { path: "/name", name: "name", type: "string" }, { path: "/age", name: "age", type: "int" }] },
    { body: json("odata/docs-simple.json") },
  ]);
  const result = await readOdkForm({ ...base, fetchImpl });
  assert.equal(new URL(calls[0]!.url).pathname, "/v1/projects/7/forms/simple/fields");
  assert.deepEqual(describe(result.rows, ["name", "age"]), [{ name: "Bob", age: 25 }, { name: "Alice", age: 30 }]);
  const fields = await fetchOdkFields({ ...base, fetchImpl: mockFetch([{ body: [{ path: "/a", name: "a", type: "string" }] }]).fetchImpl });
  assert.deepEqual(fields, [{ path: "/a", name: "a", type: "string" }]);
});
