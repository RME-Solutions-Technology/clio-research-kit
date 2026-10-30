import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConnectorError,
  fetchKoboFields,
  fetchKoboSubmissions,
  koboCsvToRows,
  koboFieldsFromSurvey,
  koboJsonToRows,
  readKoboAsset,
  toImportInput,
  type ConnectorRow,
  type FetchLike,
} from "../src/connectors/index.ts";
import { previewImport } from "../src/importer.ts";

// All Kobo data here is synthetic, written to the documented v2 API and CSV export
// shapes; nothing is copied from KoboToolbox's AGPL-3.0 source. See test/fixtures/README.md.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "kobo");
const text = (path: string): string => readFileSync(resolve(root, path), "utf8");
const json = (path: string): any => JSON.parse(text(path)); // eslint-disable-line @typescript-eslint/no-explicit-any
const codeOf = (error: unknown): string | undefined => (error instanceof ConnectorError ? error.code : undefined);
const throwsCode = (run: () => unknown, code: string): void => assert.throws(run, (error: unknown) => codeOf(error) === code, `expected ConnectorError ${code}`);
const survey = () => koboFieldsFromSurvey(json("asset-survey.json").content.survey);
const results = () => [...json("data-page1.json").results, ...json("data-page2.json").results] as Record<string, unknown>[];
const pick = (row: ConnectorRow, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]]));

const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("network access in a test"); }) as unknown as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

test("XLSForm survey rows become a field list: groups, repeats, types, select_multiple, media", () => {
  const summary = survey().map((field) => `${field.path}:${field.type}${field.binary ? "+binary" : ""}${field.selectMultiple ? "+multiple" : ""}`);
  assert.deepEqual(summary, [
    "/start:dateTime", "/end:dateTime", "/site:structure", "/site/site_name:string", "/site/location:geopoint", "/habitat:string", "/behaviour:string+multiple",
    "/count:int", "/observed_at:dateTime", "/observed_on:date", "/photo:binary+binary", "/route:geotrace", "/plot:geoshape",
    "/individuals:repeat", "/individuals/tag:string", "/individuals/wing_mm:decimal", "/individuals/individual_photo:binary+binary",
  ]);
});

test("paths come from the group stack when the server sends no $xpath", () => {
  const rows = json("asset-survey.json").content.survey.map(({ $xpath, ...rest }: Record<string, unknown>) => { void $xpath; return rest; });
  assert.deepEqual(koboFieldsFromSurvey(rows), survey());
  throwsCode(() => koboFieldsFromSurvey({}), "fields.invalid");
  throwsCode(() => koboFieldsFromSurvey([{ name: "x" }]), "fields.invalid");
  throwsCode(() => koboFieldsFromSurvey([{ type: "begin_group" }]), "fields.invalid");
  throwsCode(() => koboFieldsFromSurvey([{ type: "text", name: "__proto__" }]), "key.unsafe");
});

test("v2 JSON: text values become typed values, repeats nest, system keys are separated", () => {
  const result = koboJsonToRows(json("data-page1.json"), { fields: survey(), eventDateField: "observed_at" });
  const row = result.rows[0]!;
  assert.equal(row.sourceId, "kobo:00000000-0000-4000-8000-000000000001");
  assert.equal(row.count, 3);
  assert.deepEqual(row.behaviour, ["foraging", "calling"]);
  assert.deepEqual(row["site/location"], { type: "Point", coordinates: [151.2, -33.8, 12.5], accuracyMetres: 4.8 });
  assert.equal((row.route as { type: string }).type, "LineString");
  assert.equal((row.plot as { type: string }).type, "Polygon");
  assert.deepEqual(row.individuals, [{ tag: "A1", wing_mm: 112.5, individual_photo: "ind_a1.jpg" }, { tag: "A2", wing_mm: 109 }]);
  assert.equal(row.latitude, -33.8);
  assert.equal(row.longitude, 151.2);
  assert.equal(row.uncertainty, 4.8);
  assert.equal(row.eventDate, "2026-03-10T07:45:00.000+11:00");
  assert.equal(row.submittedAt, "2026-03-10T00:30:12Z", "Kobo's submission time is UTC and written without an offset");
  assert.equal(row.formVersion, "vSyntheticVersion1");
  assert.equal(row.validationStatus, "Approved");
  for (const system of ["_id", "_uuid", "_attachments", "formhub/uuid", "meta/instanceID", "_geolocation", "_xform_id_string", "_status", "_submitted_by"]) assert.ok(!(system in row), system);
  assert.ok(result.findings.some((finding) => finding.code === "timestamp.offset-assumed" && finding.field === "submittedAt"), "the UTC assumption is said out loud");
});

test("attachments the server lists become media references with https URLs, which are never requested", () => {
  const result = koboJsonToRows(json("data-page1.json"), { fields: survey() });
  assert.deepEqual(result.media.map(({ field, filename, mediaType, source }) => ({ field, filename, mediaType, source })), [
    { field: "photo", filename: "bird_1.jpg", mediaType: "image/jpeg", source: "kobo" },
    { field: "individuals/individual_photo", filename: "ind_a1.jpg", mediaType: "image/jpeg", source: "kobo" },
  ]);
  assert.ok(result.media.every((item) => item.remoteUrl?.startsWith("https://kf.example.org/")));
  const hostile = json("data-page1.json").results[0];
  hostile._attachments = [
    { download_url: "http://plain.example.org/x", media_file_basename: "plain.jpg", mimetype: "image/jpeg" },
    { download_url: "https://user:pw@kf.example.org/x", media_file_basename: "creds.jpg" },
    { download_url: "https://kf.example.org/x", media_file_basename: "../../escape.jpg" },
    { download_url: "https://kf.example.org/x", filename: "owner/attachments/a/b/../../../c.jpg" },
    { download_url: "https://kf.example.org/x", media_file_basename: "deleted.jpg", is_deleted: true },
  ];
  hostile.photo = "plain.jpg";
  delete hostile.individuals;
  const checked = koboJsonToRows([hostile], { fields: survey() });
  assert.deepEqual(checked.media.map((item) => [item.filename, item.remoteUrl]), [["plain.jpg", undefined], ["creds.jpg", undefined], ["c.jpg", "https://kf.example.org/x"]]);
  assert.equal(checked.findings.filter((finding) => finding.code === "media.unsafe-filename").length, 1, "only the name with a path escape is refused; a server path is cut to its last segment");
});

test("an attachment the typed fields did not claim is still listed, with its field when it can be found", () => {
  const result = koboJsonToRows(json("data-page1.json"));
  assert.equal(result.media.length, 2, "no form definition: the server's own list is used");
  assert.deepEqual(result.media.map((item) => item.field), ["photo", "individuals/individual_photo"]);
  assert.equal(result.rows[0]!.count, "3", "without a form definition, Kobo's text values stay text");
  assert.equal(result.findings[0]!.code, "fields.not-supplied");
});

test("empty location falls back to nothing; formulas and unreadable numbers are reported, values are kept", () => {
  const result = koboJsonToRows(json("data-page2.json"), { fields: survey() });
  const row = result.rows[0]!;
  assert.ok(!("latitude" in row) && !("longitude" in row));
  assert.equal(row["site/site_name"], "=HYPERLINK(\"https://example.org\",\"open\")");
  assert.equal(row.count, "many");
  const codes = result.findings.map((finding) => finding.code);
  for (const code of ["cell.formula-prefix", "number.unreadable", "timestamp.no-offset"]) assert.ok(codes.includes(code), code);
  assert.equal(row.observed_at, "2026-03-11T08:30:00", "a date-time with no offset is not guessed");
});

test("a default offset is applied only when the caller supplies one, and says so", () => {
  const result = koboJsonToRows(json("data-page2.json"), { fields: survey(), defaultUtcOffset: "+11:00" });
  assert.equal(result.rows[0]!.observed_at, "2026-03-11T08:30:00+11:00");
  assert.ok(result.findings.some((finding) => finding.code === "timestamp.offset-assumed" && finding.field === "observed_at"));
});

test("submitter names are off unless asked for", () => {
  assert.ok(!("submitterName" in koboJsonToRows(json("data-page1.json"), { fields: survey() }).rows[0]!));
  assert.equal(koboJsonToRows(json("data-page1.json"), { fields: survey(), includeSubmitter: true }).rows[0]!.submitterName, "synthetic_user");
});

test("_geolocation is used for latitude/longitude only when no field supplied a location", () => {
  const row = json("data-page1.json").results[0];
  delete row["site/location"];
  const result = koboJsonToRows([row], { fields: survey() });
  assert.equal(result.rows[0]!.latitude, -33.8);
  assert.equal(result.rows[0]!.longitude, 151.2);
  assert.ok(!("uncertainty" in result.rows[0]!));
});

test("hostile JSON is refused", () => {
  throwsCode(() => koboJsonToRows({ results: [JSON.parse("{\"_id\":1,\"__proto__\":{\"x\":1}}")] }), "key.unsafe");
  throwsCode(() => koboJsonToRows({ results: [{ _id: 1, "g/constructor": "x", g: { constructor: 1 } }] }), "key.unsafe");
  throwsCode(() => koboJsonToRows({ results: [{ note: "no id" }] }), "kobo.missing-id");
  throwsCode(() => koboJsonToRows({ results: [{ _id: 1 }, { _id: 1 }] }), "kobo.duplicate-id");
  throwsCode(() => koboJsonToRows({ count: 0 }), "kobo.shape");
  throwsCode(() => koboJsonToRows({ results: [1] }), "kobo.row");
  throwsCode(() => koboJsonToRows({ results: [{ _id: 1 }] }, { namespace: "A" }), "option.namespace");
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test("CSV (semicolons, XML headers): same row as the JSON route, split choice and derived location columns dropped", () => {
  const fields = survey();
  const csv = koboCsvToRows({ main: text("export-main.csv"), repeats: { individuals: text("export-individuals.csv") } }, { fields, eventDateField: "observed_at" });
  const jsonRow = koboJsonToRows(json("data-page1.json"), { fields, eventDateField: "observed_at" }).rows[0]!;
  const keys = ["sourceId", "start", "end", "site/site_name", "site/location", "habitat", "behaviour", "count", "observed_at", "observed_on", "photo", "route", "plot", "individuals", "latitude", "longitude", "uncertainty", "eventDate", "submittedAt", "formVersion", "validationStatus"];
  assert.deepEqual(pick(csv.rows[0]!, keys), pick(jsonRow, keys));
  assert.ok(Object.keys(csv.rows[0]!).every((key) => !/^behaviour\//u.test(key) && !key.startsWith("_")));
  assert.deepEqual(csv.media.map((item) => item.filename), ["bird_1.jpg", "ind_a1.jpg"], "media inside repeats is listed too");
  assert.equal((csv.rows[0]!.media as unknown[]).length, 2);
});

test("CSV with labels instead of XML headers is reported as unmappable", () => {
  const labelled = "Start;Site name;Count;_uuid\n2026-03-10T08:00:00.000+11:00;Creek;3;u1\n";
  const result = koboCsvToRows({ main: labelled }, { fields: survey() });
  assert.ok(result.findings.some((finding) => finding.code === "csv.headers-not-recognised"));
});

test("CSV structure errors fail closed", () => {
  throwsCode(() => koboCsvToRows({ main: "a;b\n1;2\n" }), "csv.no-id");
  throwsCode(() => koboCsvToRows({ main: "_uuid\nx\nx\n" }), "csv.duplicate-id");
  throwsCode(() => koboCsvToRows({ main: "_uuid\n\n\"\"\n" }), "csv.empty-id");
  throwsCode(() => koboCsvToRows({ main: "_uuid;__proto__\nx;y\n" }), "key.unsafe");
  throwsCode(() => koboCsvToRows({ main: "_uuid\nx\n", repeats: { r: "a;b\n1;2\n" } }), "csv.no-parent");
  throwsCode(() => koboCsvToRows({ main: "_uuid\nx\n", repeats: { __proto__x: "_parent_table_name;_parent_index\nx;1\n", ["__proto__"]: "a\n1\n" } }), "key.unsafe");
  const orphan = koboCsvToRows({ main: "_uuid;_index\nx;1\n", repeats: { r: "a;_parent_table_name;_parent_index\n1;form;9\n" } });
  assert.ok(orphan.findings.some((finding) => finding.code === "csv.orphan-repeat-row"));
});

test("connector rows go through previewImport", () => {
  const result = koboJsonToRows(json("data-page1.json"), { fields: survey(), eventDateField: "observed_at", geometryField: "plot" });
  const preview = previewImport(toImportInput(result, "observation", { habitat: "identification", eventDate: "eventDate", latitude: "latitude", longitude: "longitude" }));
  assert.equal(preview.rows[0]!.data.identification, "wetland");
  assert.equal(preview.rows[0]!.data.eventDate, "2026-03-10T07:45:00.000+11:00");
  assert.deepEqual(preview.rows[0]!.findings.filter((finding) => finding.severity === "error"), []);
});

// ---------------------------------------------------------------------------
// Fetching (mocked: no network)

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string>; wait?: boolean };
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
const base = { server: "https://kf.example.org", assetUid: "aSyntheticAssetUid0001", token: "synthetic-api-token" };

test("fetch: pages are followed on the same origin and path; the token is a header, never in a URL", async () => {
  const { fetchImpl, calls } = mockFetch([{ body: json("data-page1.json") }, { body: json("data-page2.json") }]);
  const rows = await fetchKoboSubmissions({ ...base, fetchImpl });
  assert.deepEqual(rows.map((row) => row._id), [1001, 1002]);
  assert.equal(calls[0]!.url, "https://kf.example.org/api/v2/assets/aSyntheticAssetUid0001/data/?format=json&limit=250");
  assert.equal(calls[0]!.headers.authorization, "Token synthetic-api-token");
  assert.equal(calls[0]!.redirect, "manual");
  assert.ok(calls.every((call) => !call.url.includes("synthetic-api-token")));
  assert.equal(new URL(calls[1]!.url).searchParams.get("start"), "1");
});

test("fetch: a next link off the origin or path is refused; redirects, errors, bad JSON and slow servers fail closed", async () => {
  for (const link of ["https://evil.example.net/api/v2/assets/aSyntheticAssetUid0001/data/", "https://kf.example.org/api/v2/assets/otherUid00000000000001/data/"]) {
    const { fetchImpl, calls } = mockFetch([{ body: { results: [{ _id: 1 }], next: link } }]);
    await assert.rejects(fetchKoboSubmissions({ ...base, fetchImpl }), (error: unknown) => codeOf(error) === "fetch.pagination");
    assert.equal(calls.length, 1);
  }
  const cases: [Reply, string][] = [
    [{ status: 301 }, "fetch.redirect"], [{ status: 403 }, "fetch.auth"], [{ status: 502 }, "fetch.http"], [{ text: "nope" }, "fetch.json"],
    [{ body: { rows: [] } }, "kobo.shape"], [{ body: { results: ["x"] } }, "kobo.row"], [{ text: "{\"results\":[],\"x\":1}", headers: { "content-length": "99999999999" } }, "limit.bytes"],
  ];
  for (const [reply, code] of cases) {
    const { fetchImpl } = mockFetch([reply]);
    await assert.rejects(fetchKoboSubmissions({ ...base, fetchImpl }), (error: unknown) => {
      assert.equal(codeOf(error), code);
      assert.ok(!String((error as Error).message).includes(base.token));
      return true;
    }, code);
  }
  const slow = mockFetch([{ wait: true }]);
  await assert.rejects(fetchKoboSubmissions({ ...base, fetchImpl: slow.fetchImpl, timeoutMs: 20 }), (error: unknown) => codeOf(error) === "fetch.timeout");
});

test("fetch: server, asset uid and token are validated before any request", async () => {
  const { fetchImpl, calls } = mockFetch([]);
  const bad: [Partial<typeof base>, string][] = [
    [{ server: "http://kf.example.org" }, "fetch.server"], [{ server: "https://kf.example.org/api" }, "fetch.server"],
    [{ assetUid: "short" }, "option.asset"], [{ assetUid: "a/../b/c/d/e/f/g/h/i/j" }, "option.asset"],
    [{ token: "a b" }, "option.token"], [{ token: "" }, "option.token"],
  ];
  for (const [override, code] of bad) await assert.rejects(fetchKoboSubmissions({ ...base, ...override, fetchImpl }), (error: unknown) => codeOf(error) === code, JSON.stringify(override));
  assert.equal(calls.length, 0);
  await assert.rejects(fetchKoboSubmissions(base), (error: unknown) => /network access in a test/u.test(String((error as Error).message)));
});

test("readKoboAsset: survey rows from the asset, submissions from the data API, converted in one call", async () => {
  const { fetchImpl, calls } = mockFetch([{ body: json("asset-survey.json") }, { body: json("data-page1.json") }, { body: json("data-page2.json") }]);
  const result = await readKoboAsset({ ...base, fetchImpl }, { eventDateField: "observed_at" });
  assert.equal(new URL(calls[0]!.url).pathname, "/api/v2/assets/aSyntheticAssetUid0001/");
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]!.count, 3);
  const fields = await fetchKoboFields({ ...base, fetchImpl: mockFetch([{ body: { content: { survey: [{ type: "text", name: "a" }] } } }]).fetchImpl });
  assert.deepEqual(fields, [{ path: "/a", name: "a", type: "string" }]);
  await assert.rejects(fetchKoboFields({ ...base, fetchImpl: mockFetch([{ body: { name: "no content" } }]).fetchImpl }), (error: unknown) => codeOf(error) === "kobo.shape");
});
