import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ConnectorError,
  fetchKoboSubmissions,
  fetchOdkSubmissions,
  isPublicHttpsUrl,
  koboCsvToRows,
  koboFieldsFromSurvey,
  koboJsonToRows,
  odkAttachmentApiPath,
  odkCsvToRows,
  odkFieldsFromXForm,
  odkODataToRows,
  pointFromParts,
  stripXmlSections,
} from "../src/index.ts";

// Tests for the independent full review (2026-10-30-review-open-full.md): connectors (M5, M6, M7, M12, L1 to L5) and workflows (M-release, M-pin, M11).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const codeOf = (error: unknown): string | undefined => (error instanceof ConnectorError ? error.code : undefined);
const throwsCode = (run: () => unknown, code: string): void => assert.throws(run, (error: unknown) => codeOf(error) === code, `expected ${code}`);
const fixture = (path: string): string => readFileSync(join(root, "test", "fixtures", path), "utf8");

// ---------------------------------------------------------------------------
// M5 identity metadata

const IDENTITY_SURVEY = [
  { type: "text", name: "species", $xpath: "species" },
  { type: "deviceid", name: "deviceid", $xpath: "deviceid" },
  { type: "username", name: "username", $xpath: "username" },
  { type: "phonenumber", name: "phonenumber", $xpath: "phonenumber" },
  { type: "email", name: "email", $xpath: "email" },
  { type: "subscriberid", name: "subscriberid", $xpath: "subscriberid" },
  { type: "simserial", name: "simserial", $xpath: "simserial" },
];
const identityRow = { _id: 1, _uuid: "u1", species: "Exemplaria synthetica", deviceid: "collect:SYNTHETIC1", username: "synthetic_user", phonenumber: "0400 000 000", email: "person@example.org", subscriberid: "SUB1", simserial: "SIM1" };
const IDENTITY_KEYS = ["deviceid", "username", "phonenumber", "email", "subscriberid", "simserial"];

test("M5: Kobo device and person metadata questions are dropped by default and kept on request", () => {
  const fields = koboFieldsFromSurvey(IDENTITY_SURVEY);
  assert.deepEqual(fields.filter((field) => field.identity).map((field) => field.name), IDENTITY_KEYS);
  const dropped = koboJsonToRows([identityRow], { fields });
  for (const key of IDENTITY_KEYS) assert.equal(key in dropped.rows[0]!, false, key);
  assert.equal(dropped.rows[0]!.species, "Exemplaria synthetica");
  assert.equal(dropped.findings.filter((finding) => finding.code === "metadata.identity-dropped").length, IDENTITY_KEYS.length);
  assert.ok(!JSON.stringify(dropped).includes("person@example.org"), "the value is in no finding either");
  const kept = koboJsonToRows([identityRow], { fields, includeSubmitter: true });
  for (const key of IDENTITY_KEYS) assert.ok(key in kept.rows[0]!, key);
  const noFields = koboJsonToRows([identityRow]);
  for (const key of IDENTITY_KEYS) assert.equal(key in noFields.rows[0]!, false, `${key} without a form definition: dropped by name`);
});

test("M5: the same for Kobo CSV, ODK OData and ODK CSV", () => {
  const fields = koboFieldsFromSurvey(IDENTITY_SURVEY);
  const kobo = koboCsvToRows({ main: "species;deviceid;username;_uuid\nX;collect:1;someone;u1\n" }, { fields });
  assert.deepEqual(Object.keys(kobo.rows[0]!).filter((key) => ["deviceid", "username"].includes(key)), []);
  assert.ok("deviceid" in koboCsvToRows({ main: "species;deviceid;_uuid\nX;collect:1;u1\n" }, { fields, includeSubmitter: true }).rows[0]!);

  const odata = odkODataToRows({ value: [{ __id: "a", species: "X", deviceid: "collect:1", username: "someone", meta: { instanceID: "a" } }] });
  assert.ok(!("deviceid" in odata.rows[0]!) && !("username" in odata.rows[0]!));
  assert.ok("deviceid" in odkODataToRows({ value: [{ __id: "a", deviceid: "collect:1" }] }, { includeSubmitter: true }).rows[0]!);

  const csv = odkCsvToRows({ main: "SubmissionDate,species,deviceid,KEY\n2026-01-01T00:00:00.000Z,X,collect:1,k1\n" });
  assert.ok(!("deviceid" in csv.rows[0]!));
  assert.ok("deviceid" in odkCsvToRows({ main: "SubmissionDate,species,deviceid,KEY\n2026-01-01T00:00:00.000Z,X,collect:1,k1\n" }, { includeSubmitter: true }).rows[0]!);
});

test("M5: an XForm bind that preloads a device or user property marks the field as identity", () => {
  const xml = `<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa"><h:head><model><instance><data id="x"><dev/><who/><q/></data></instance>
    <bind nodeset="/data/dev" type="string" jr:preload="property" jr:preloadParams="deviceid"/>
    <bind nodeset="/data/who" type="string" jr:preload="property" jr:preloadParams="username"/>
    <bind nodeset="/data/q" type="string"/></model></h:head><h:body/></h:html>`;
  const fields = odkFieldsFromXForm(xml);
  assert.deepEqual(fields.filter((field) => field.identity).map((field) => field.path), ["/dev", "/who"]);
  const rows = odkODataToRows({ value: [{ __id: "a", dev: "collect:1", who: "someone", q: "kept" }] }, { fields });
  assert.deepEqual(Object.keys(rows.rows[0]!).filter((key) => ["dev", "who", "q"].includes(key)), ["q"]);
});

// ---------------------------------------------------------------------------
// M6 remoteUrl

test("M6: only public https addresses become remoteUrl", () => {
  for (const good of ["https://kf.example.org/api/v2/x/", "https://eu.kobotoolbox.org/a", "https://93.184.216.34/x", "https://[2606:4700::1111]/x"]) assert.equal(isPublicHttpsUrl(good), true, good);
  for (const bad of [
    "http://kf.example.org/x", "https://user:pw@kf.example.org/x", "https://localhost:8443/x", "https://app.localhost/x", "https://printer.local/x", "https://db.internal/x",
    "https://127.0.0.1/x", "https://127.1.2.3/x", "https://169.254.169.254/latest/meta-data/", "https://10.0.0.5/x", "https://172.16.0.1/x", "https://172.31.255.255/x",
    "https://192.168.1.1/x", "https://100.64.0.1/x", "https://0.0.0.0/x", "https://198.18.0.1/x", "https://224.0.0.1/x", "https://[::1]/x", "https://[fe80::1]/x",
    "https://[fd00::1]/x", "https://[::ffff:10.0.0.1]/x", "https://2130706433/x", "https://0x7f.1/x", "https://017700000001/x", "not a url", "ftp://kf.example.org/x", "https://",
  ]) assert.equal(isPublicHttpsUrl(bad), false, bad);
  const base = JSON.parse(fixture("kobo/data-page1.json")) as { results: Record<string, unknown>[] };
  const row = base.results[0]!;
  const attachments = (urls: string[]) => urls.map((url, index) => ({ download_url: url, media_file_basename: `f${index}.jpg`, mimetype: "image/jpeg" }));
  row._attachments = attachments(["https://169.254.169.254/latest/meta-data/", "https://localhost:8443/x", "https://kf.example.org/ok"]);
  const result = koboJsonToRows([row]);
  assert.deepEqual(result.media.map((item) => [item.filename, item.remoteUrl]), [["f0.jpg", undefined], ["f1.jpg", undefined], ["f2.jpg", "https://kf.example.org/ok"]]);
  assert.equal(result.findings.filter((finding) => finding.code === "media.url-not-public").length, 2);
});

test("M6: ODK form ids and instance ids cannot collapse the URL path", () => {
  for (const form of [".", "..", "...", "a/b"]) throwsCode(() => odkAttachmentApiPath(7, form, "uuid:x", "a.jpg"), "option.form");
  for (const instance of ["", ".", ".."]) throwsCode(() => odkAttachmentApiPath(7, "simple", instance, "a.jpg"), "option.instance");
  assert.ok(odkAttachmentApiPath(7, "simple.v2", "uuid:x", "a.jpg").startsWith("/v1/projects/7/forms/simple.v2/"));
});

// ---------------------------------------------------------------------------
// M7 XForm scanner is linear

test("M7: unterminated comment, CDATA and processing-instruction openers are refused quickly (the reviewer's 22-second case)", () => {
  for (const opener of ["<!--", "<![CDATA[", "<?"]) {
    for (const count of [20_000, 80_000, 250_000]) {
      const input = opener.repeat(count);
      const started = Date.now();
      assert.throws(() => odkFieldsFromXForm(input), (error: unknown) => codeOf(error) === "xform.unterminated" || codeOf(error) === "xform.size", `${opener} x ${count}`);
      assert.ok(Date.now() - started < 1_500, `${opener} x ${count} took ${Date.now() - started} ms`);
    }
  }
});

test("M7: a terminated flood of comments is stripped in linear time, and the size limit is 1 MiB", () => {
  const started = Date.now();
  const stripped = stripXmlSections("<!--a-->".repeat(120_000) + "<x/>" + "<![CDATA[y]]>".repeat(60_000) + "<?p q?>".repeat(100_000));
  assert.equal(stripped, "<x/>");
  assert.ok(Date.now() - started < 1_500, `${Date.now() - started} ms`);
  const form = fixture("odk/forms/withrepeat.xml");
  assert.ok(odkFieldsFromXForm(`<!-- ok -->${form}`).length > 0, "a normal form with a comment still reads");
  throwsCode(() => odkFieldsFromXForm("x".repeat(1024 * 1024 + 1)), "xform.size");
  const near = `<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml"><h:head><model><instance><data id="a"><q/></data></instance></model></h:head><h:body>${"<!--x-->".repeat(100_000)}</h:body></h:html>`;
  assert.ok(near.length < 1024 * 1024);
  const t = Date.now();
  assert.equal(odkFieldsFromXForm(near).length, 1);
  assert.ok(Date.now() - t < 1_500);
});

// ---------------------------------------------------------------------------
// M12 repeat keys cannot overwrite row fields

test("M12: an ODK repeat table whose KEY names sourceId cannot replace the row's sourceId", () => {
  const result = odkCsvToRows({ main: "SubmissionDate,KEY\n2026-01-01T00:00:00.000Z,abc\n", repeats: { r: "x,PARENT_KEY,KEY\n1,abc,abc/sourceId[1]\n" } });
  assert.equal(result.rows[0]!.sourceId, "odk:abc");
  assert.deepEqual(result.rows[0]!["form/sourceId"], [{ x: "1" }]);
  assert.ok(result.findings.some((finding) => finding.code === "key.reserved-renamed"));
  for (const reserved of ["sourceSystem", "latitude", "media", "geometry"]) {
    const row = odkCsvToRows({ main: "SubmissionDate,KEY\n2026-01-01T00:00:00.000Z,abc\n", repeats: { r: `x,PARENT_KEY,KEY\n1,abc,abc/${reserved}[1]\n` } }).rows[0]!;
    assert.equal(typeof row.sourceId, "string");
    assert.ok(Array.isArray(row[`form/${reserved}`]), reserved);
  }
});

test("M12: a repeat that would overwrite an ordinary value is refused", () => {
  throwsCode(() => odkCsvToRows({ main: "SubmissionDate,name,KEY\n2026-01-01T00:00:00.000Z,Alice,abc\n", repeats: { r: "x,PARENT_KEY,KEY\n1,abc,abc/name[1]\n" } }), "csv.repeat-key-collision");
  throwsCode(() => koboCsvToRows({ main: "_uuid;_index;name\nu1;1;Alice\n", repeats: { name: "a;_parent_table_name;_parent_index\n1;form;1\n" } }), "csv.repeat-key-collision");
});

test("M12: a Kobo repeat sheet named sourceId cannot replace the row's sourceId", () => {
  const result = koboCsvToRows({ main: "_uuid;_index\nu1;1\n", repeats: { sourceId: "a;_parent_table_name;_parent_index\n1;form;1\n" } });
  assert.equal(result.rows[0]!.sourceId, "kobo:u1");
  assert.deepEqual(result.rows[0]!["form/sourceId"], [{ a: "1" }]);
});

// ---------------------------------------------------------------------------
// L1 to L5

test("L1: a blank altitude does not shift the accuracy into its place", () => {
  assert.deepEqual(pointFromParts("50", "10", "", "7"), { type: "Point", coordinates: [10, 50], accuracyMetres: 7 });
  assert.deepEqual(pointFromParts("50", "10", "12", ""), { type: "Point", coordinates: [10, 50, 12] });
  assert.deepEqual(pointFromParts("50", "10", "", ""), { type: "Point", coordinates: [10, 50] });
  assert.deepEqual(pointFromParts("50", "10", "0", "0"), { type: "Point", coordinates: [10, 50, 0] });
  for (const bad of [["91", "0", "", ""], ["x", "0", "", ""], ["50", "10", "abc", ""], ["50", "10", "", "?"]] as const) assert.equal(pointFromParts(bad[0], bad[1], bad[2], bad[3]), undefined, bad.join());
  const header = "SubmissionDate,pt-Latitude,pt-Longitude,pt-Altitude,pt-Accuracy,KEY";
  const row = odkCsvToRows({ main: `${header}\n2026-01-01T00:00:00.000Z,50,10,,7,k\n` }).rows[0]!;
  assert.deepEqual(row["pt"], { type: "Point", coordinates: [10, 50], accuracyMetres: 7 });
  assert.equal(row.uncertainty, 7);
});

test("L2: a fetch function that ignores the abort signal still times out", async () => {
  const never = () => new Promise<never>(() => undefined);
  const started = Date.now();
  await assert.rejects(fetchOdkSubmissions({ server: "https://central.example.org", project: 7, form: "simple", token: "t", timeoutMs: 40, fetchImpl: never as never }), (error: unknown) => codeOf(error) === "fetch.timeout");
  await assert.rejects(fetchKoboSubmissions({ server: "https://kf.example.org", assetUid: "aSyntheticAssetUid0001", token: "t", timeoutMs: 40, fetchImpl: never as never }), (error: unknown) => codeOf(error) === "fetch.timeout");
  assert.ok(Date.now() - started < 2_000);
});

test("L5: a next-page link with credentials is refused, and an http link gets its own message", async () => {
  const reply = (link: string) => async () => ({ status: 200, ok: true, headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ value: [{ __id: "a" }], "@odata.nextLink": link })).buffer as ArrayBuffer });
  const options = { server: "https://central.example.org", project: 7, form: "simple", token: "t" };
  await assert.rejects(fetchOdkSubmissions({ ...options, fetchImpl: reply("https://u:p@central.example.org/v1/projects/7/forms/simple.svc/Submissions?x=1") as never }), (error: unknown) => codeOf(error) === "fetch.pagination" && /credentials/u.test((error as Error).message));
  await assert.rejects(fetchOdkSubmissions({ ...options, fetchImpl: reply("http://central.example.org/v1/projects/7/forms/simple.svc/Submissions?x=1") as never }), (error: unknown) => codeOf(error) === "fetch.pagination" && /http:\/\/.*proxy/u.test((error as Error).message));
});

test("L4: restrictedFields drops named top-level fields and they are not promoted to latitude and longitude", () => {
  const rows = odkODataToRows(JSON.parse(fixture("odk/odata/geotypes.json")), { fields: odkFieldsFromXForm(fixture("odk/forms/geoTypes.xml")), restrictedFields: ["singular/input_geopoint", "singular/input_geoshape"] });
  const row = rows.rows[0]!;
  assert.ok(!("singular/input_geopoint" in row) && !("singular/input_geoshape" in row));
  assert.ok("singular/input_geotrace" in row, "only the listed fields");
  assert.ok(!("latitude" in row) && !("longitude" in row));
  assert.equal(rows.findings.filter((finding) => finding.code === "field.restricted-dropped").length, 2);
  const kobo = koboJsonToRows(JSON.parse(fixture("kobo/data-page1.json")) as unknown, { fields: koboFieldsFromSurvey((JSON.parse(fixture("kobo/asset-survey.json")) as { content: { survey: unknown } }).content.survey), restrictedFields: ["site/location"] });
  assert.ok(!("site/location" in kobo.rows[0]!) && !("latitude" in kobo.rows[0]!), "Kobo's _geolocation does not put a dropped point back");
});

// ---------------------------------------------------------------------------
// M-release, M-pin, M11: the workflow files

const workflow = (name: string): string => readFileSync(join(root, ".github", "workflows", name), "utf8");

test("M-release: release.yml packs into release/, not into dist/ where tsc writes", () => {
  const text = workflow("release.yml");
  assert.doesNotMatch(text, /pack-destination dist/u);
  assert.match(text, /pnpm pack --pack-destination release/u);
  assert.doesNotMatch(text, /\bdist\/\*|cd dist\b/u);
  assert.match(text, /sha256sum -- \*\.tgz \*\.cdx\.json > SHA256SUMS\.txt/u);
  assert.match(text, /path: release\//u);
  assert.match(text, /check:package/u, "the release job runs the same package check as CI");
});

function jobBlock(text: string, job: string): string {
  const match = new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|(?![\\s\\S]))`, "mu").exec(text);
  assert.ok(match, `job ${job}`);
  return match[1]!;
}

test("M11: write and OIDC permissions reach only the jobs that sign, release or publish", () => {
  const text = workflow("release.yml");
  const top = /^permissions:\n((?:  .*\n)+)/mu.exec(text)![1]!;
  assert.match(top, /contents: read/u);
  assert.doesNotMatch(top, /write/u);
  const build = jobBlock(text, "build");
  assert.doesNotMatch(build, /write|id-token/u, "the job that installs dependencies and runs scripts has no write or OIDC permission");
  assert.match(build, /pnpm install --frozen-lockfile/u);
  const sign = jobBlock(text, "sign-release");
  assert.match(sign, /contents: write/u);
  assert.match(sign, /id-token: write/u);
  assert.match(sign, /attestations: write/u);
  assert.doesNotMatch(sign, /pnpm|npm install|corepack|actions\/checkout/u, "the signing job runs no repository code and installs nothing");
  assert.match(sign, /sha256sum -c SHA256SUMS\.txt/u);
  const publish = jobBlock(text, "publish-npm");
  assert.match(publish, /id-token: write/u);
  assert.doesNotMatch(publish, /contents: write|attestations: write/u);
  assert.match(publish, /^\s+if: false\r?$/mu, "npm publishing is switched off");
  assert.match(publish, /npm publishing is off for now/u);
  assert.doesNotMatch(text, /NPM_TOKEN/u);
});

test("M-pin: every action is pinned to a 40-character commit SHA, and the Scorecard pin is the commit, not the tag object", () => {
  for (const name of ["ci.yml", "release.yml", "scorecard.yml"]) {
    for (const line of workflow(name).split("\n")) {
      const match = /uses:\s+([^@\s]+)@(\S+)/u.exec(line);
      if (match) assert.match(match[2]!, /^[0-9a-f]{40}$/u, `${name}: ${match[1]}`);
    }
  }
  const scorecard = workflow("scorecard.yml");
  assert.match(scorecard, /ossf\/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc/u);
  assert.doesNotMatch(scorecard, /55891bbd73f2425e97637d96e306fc9d491d0b21 #/u);
});

test("source maps carry their sources, so they do not dangle in the package", () => {
  assert.match(readFileSync(join(root, "tsconfig.build.json"), "utf8"), /"inlineSources": true/u);
});
