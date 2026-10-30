import assert from "node:assert/strict";
import test from "node:test";
import {
  DarwinCoreArchiveError,
  ResearchPackageError,
  buildDarwinCoreArchive,
  buildResearchPackage,
  containsLocationText,
  locationStateOf,
  redactLocationText,
  withholdCanonicalRecordVersion,
  withholdStagedRow,
  type ResearchPackageInput,
} from "../src/index.ts";
import { sampleArchiveInput, samplePackageInput } from "../scripts/sample-package.ts";

// The re-review of ec72164 (RR1 to RR3): flags at any depth, an allow-list plus a text screen instead of a deny-list.
const stagedOptions = { profileId: "clio.profile.general-observation", profileVersion: "1.0.0" };
const LAT = "-33.81234";
const LON = "151.21234";

// ---------------------------------------------------------------------------
// RR1 flags at any depth

test("RR1: a restricted flag in a group, a nested object or a repeat entry wins, also under missingVisibility public", () => {
  const rows: [string, Record<string, unknown>][] = [
    ["flat group key", { latitude: Number(LAT), longitude: Number(LON), "site/location_visibility": "restricted" }],
    ["nested object", { latitude: Number(LAT), longitude: Number(LON), site: { location_visibility: "restricted" } }],
    ["repeat entry", { latitude: Number(LAT), longitude: Number(LON), rows: [{ n: 1 }, { location_visibility: "restricted" }] }],
    ["deeper still", { latitude: Number(LAT), a: { b: { c: [{ "Location Visibility": ["restricted"] }] } } }],
    ["top-level public, group restricted", { latitude: Number(LAT), locationVisibility: "public", site: { location_visibility: "restricted" } }],
    ["top-level public, repeat entry unrecognised", { latitude: Number(LAT), locationVisibility: "public", rows: [{ visibility: "Restricted." }] }],
  ];
  for (const [name, row] of rows) {
    for (const missingVisibility of [undefined, "public" as const]) {
      const state = locationStateOf(row, missingVisibility === undefined ? {} : { missingVisibility });
      assert.equal(state.publishes, false, `${name} (${String(missingVisibility)})`);
      const staged = withholdStagedRow({ data: { latitude: Number(LAT), longitude: Number(LON) }, source: row, ...(missingVisibility === undefined ? {} : { missingVisibility }), ...stagedOptions });
      assert.equal(JSON.stringify(staged.value).includes(LAT), false, `${name}: coordinates left in a staged row (${String(missingVisibility)})`);
    }
  }
});

test("RR1: the state reports where the deciding flag was", () => {
  const state = locationStateOf({ locationVisibility: "public", rows: [{ n: 1 }, { location_visibility: "restricted" }] });
  assert.equal(state.state, "restricted");
  assert.equal(state.key, "rows[1].location_visibility");
});

test("RR1: a flag at depth also governs canonical records and the package builder", async () => {
  const canonical = {
    recordId: "rec-1", versionId: "ver-1", canonicalUri: "https://example.org/records/rec-1",
    fields: {
      title: "Synthetic record",
      profile: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0", data: { title: "Synthetic record" } },
      event: { eventDate: "2026-10-01", locality: "Synthetic creek", locationVisibility: "public", decimalLatitude: Number(LAT), decimalLongitude: Number(LON), details: { location_visibility: "restricted" } },
      rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
    },
  };
  const result = withholdCanonicalRecordVersion(canonical);
  assert.equal(JSON.stringify(result.value).includes(LAT), false);
  const base = samplePackageInput();
  const record = { ...base.records[0]!, eventDate: "2026-10-01", decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, canonical } as never;
  await assert.rejects(buildResearchPackage({ ...base, includeDarwinCoreArchive: false, records: [record] }), (error: unknown) => error instanceof ResearchPackageError && /still in the record but its location visibility is "restricted"/u.test(error.problems.join()));
});

test("RR1: an assertion wrapper's own visibility is about its value, not about the place; a missing flag stays missing", () => {
  assert.equal(locationStateOf({ note: { value: "x", visibility: "restricted" } }).state, "missing");
  assert.equal(locationStateOf({ note: { value: "x", source: "s", visibility: "public" } }, { missingVisibility: "public" }).publishes, true);
  assert.equal(locationStateOf({ weather: { visibility: "good" } }).publishes, false, "an unrelated visibility key over-withholds (documented)");
});

// ---------------------------------------------------------------------------
// RR2 encodings of a place

const ENCODINGS: [string, string][] = [
  ["decimal pair with comma", `at ${LAT}, ${LON} near the gate`],
  ["decimal pair with semicolon", `${LAT};${LON}`],
  ["decimal pair with space", `${LAT} ${LON}`],
  ["decimal pair with slash", `${LAT}/${LON}`],
  ["pair with altitude and accuracy", `${LAT} ${LON} 12.5 4.8`],
  ["DMS", "33°48'44\"S 151°12'45\"E"],
  ["DMS with decimal seconds", "33°48'44.5\"S, 151°12'45.2\"E"],
  ["degrees and minutes", "33°48.74'S 151°12.76'E"],
  ["hemisphere letters", "33.81 S, 151.21 E"],
  ["whole-degree pair", "-34 151"],
  ["whole-degree pair with comma", "-34, 151"],
  ["numeric pair array text", "[151.21234, -33.81234]"],
  ["x and y text", "x=151.2 y=-33.8"],
  ["labelled lat and lon", "lat -33.81234 lon 151.21234"],
  ["serialised GeoJSON", JSON.stringify({ type: "Point", coordinates: [151.21234, -33.81234] })],
  ["serialised GeoJSON feature", JSON.stringify({ type: "Feature", geometry: { type: "Point", coordinates: [1.5, 2.5] }, properties: {} })],
  ["WKT", "POINT (151.21234 -33.81234)"],
  ["Google Maps URL", "https://www.google.com/maps/@-33.81234,151.21234,15z"],
  ["Google Maps query URL", "https://www.google.com/maps?q=-33.81234,151.21234"],
  ["OpenStreetMap URL", "https://www.openstreetmap.org/?mlat=-33.81234&mlon=151.21234#map=16/-33.81234/151.21234"],
  ["geo: URI", "geo:-33.81234,151.21234"],
  ["plus code", "4RRH46H5+C7"],
  ["UTM", "56H 334000 6252000"],
  ["UTM with units", "56 H 334000mE 6252000mN"],
  ["MGRS", "56HLH3340062520"],
  ["what3words", "///filled.count.soap"],
];

test("RR2: the text screen finds every common way of writing a place, and redacts it", () => {
  for (const [name, text] of ENCODINGS) {
    assert.equal(containsLocationText(text), true, name);
    const redacted = redactLocationText(`Near the old mill: ${text}. Bring water.`);
    assert.match(redacted, /\[location withheld\]/u, name);
    assert.equal(/-33\.8|151\.2|3340|6252|4RRH|filled\.count/u.test(redacted), false, `${name}: ${redacted}`);
    assert.equal(redactLocationText(redacted), redacted, `${name}: redacting twice changes nothing`);
  }
  for (const fine of ["Near the old mill", "Plot 12 beside the creek", "2026-10-01T10:30:00Z", "Seen at 10:45 for 20 minutes", "Version 2.1 of the form", "ordinary text only", "Cover 40 percent"]) {
    assert.equal(containsLocationText(fine), false, fine);
    assert.equal(redactLocationText(fine), fine);
  }
});

test("RR2: free text that stays in a withheld canonical record is screened", () => {
  for (const [name, text] of ENCODINGS) {
    const canonical = {
      recordId: "rec-1", versionId: "ver-1", canonicalUri: "https://example.org/records/rec-1",
      fields: {
        title: `Record: ${text}`,
        profile: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0", data: { title: "T", description: `Seen ${text}`, locality: `Behind ${text}` } },
        event: { eventDate: "2026-10-01", locality: `By the creek, ${text}`, context: text, locationVisibility: "restricted" },
        uncertaintyStatement: text,
        rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
      },
    };
    const out = JSON.stringify(withholdCanonicalRecordVersion(canonical).value);
    assert.equal(/-33\.8|151\.2|3340|6252|4RRH|filled\.count|Point/u.test(out), false, `${name}: ${out.slice(0, 300)}`);
    assert.match(out, /\[location withheld\]/u, name);
  }
});

test("RR2: a staged row keeps only allow-listed fields; unknown columns holding a place are dropped by name", () => {
  const source: Record<string, unknown> = { id: "r1", date: "2026-10-01", locationVisibility: "restricted", landholder: "Station" };
  ENCODINGS.forEach(([name, text], index) => { source[`col${index}`] = `${name}: ${text}`; });
  source.location = [151.21234, -33.81234];
  source.pos = { x: 151.2, y: -33.8 };
  source.gps = JSON.stringify({ type: "Point", coordinates: [151.2, -33.8] });
  const staged = withholdStagedRow({ data: { sourceId: "r1" }, source, ...stagedOptions });
  assert.deepEqual(Object.keys(staged.value.source).sort(), ["date", "id", "locationVisibility"]);
  assert.ok(staged.withheld.includes("canonical.source.col0") && staged.withheld.includes("canonical.source.location") && staged.withheld.includes("canonical.source.pos"));
});

test("RR2: columns a caller keeps are still screened, and numeric position values are dropped", () => {
  const source = {
    locationVisibility: "restricted",
    remarks: `Dry creek bed. Found at ${LAT}, ${LON} under a log.`,
    notes: "https://www.google.com/maps/@-33.8,151.2,15z",
    location: [151.21234, -33.81234],
    shape: { x: 151.2, y: -33.8 },
    asJson: JSON.stringify({ type: "Point", coordinates: [1, 2] }),
    habitat: "heath",
  };
  const staged = withholdStagedRow({ data: {}, source, keepKeys: ["remarks", "notes", "location", "shape", "asJson", "habitat"], ...stagedOptions });
  const out = staged.value.source as Record<string, unknown>;
  assert.equal(out.remarks, "Dry creek bed. Found at [location withheld] under a log.");
  assert.equal(out.notes, "[location withheld]");
  assert.equal(out.habitat, "heath");
  for (const key of ["location", "shape", "asJson"]) assert.equal(key in out, false, `${key} is a place by itself and is dropped even when kept`);
  assert.ok(staged.withheld.includes("canonical.source.remarks"), "the redaction is recorded in withheld");
});

test("RR2: the allow-list is the profile's non-spatial fields; the location and site groups never pass, even if asked for", () => {
  const input = { data: { locality: "Dry creek", decimalLatitude: -33.8, countryCode: "AU", observatoryName: "Synthetic Observatory", title: "T", locationVisibility: "restricted" }, source: {}, ...stagedOptions };
  const out = withholdStagedRow(input).value.data;
  assert.deepEqual(Object.keys(out).sort(), ["locationVisibility", "title"], "a locality is a place name and is dropped");
  const forced = withholdStagedRow({ ...input, keepKeys: ["decimalLatitude"] });
  assert.equal("decimalLatitude" in forced.value.data, false, "a spatial field cannot be forced through keepKeys");
});

test("RR2: a published location is untouched by the allow-list and the screen", () => {
  const source = { locationVisibility: "public", lat: LAT, remarks: `at ${LAT}, ${LON}`, anything: "kept" };
  assert.deepEqual(withholdStagedRow({ data: {}, source, ...stagedOptions }).value.source, source);
});

test("RR2 (c): the package builder's refusal uses the same screens", async () => {
  const base = samplePackageInput();
  const make = (event: Record<string, unknown>, extra: Record<string, unknown> = {}): ResearchPackageInput => {
    const record = base.records[0]!;
    const canonical = { ...record.canonical, fields: { ...(record.canonical as { fields: object }).fields, event: { eventDate: "2026-09-14", locationVisibility: "restricted", ...event }, ...extra } };
    return { ...base, includeDarwinCoreArchive: false, records: [{ ...record, decimalLatitude: undefined, decimalLongitude: undefined, coordinateUncertaintyInMeters: undefined, canonical } as never] };
  };
  const problems = async (input: ResearchPackageInput): Promise<string> => {
    try { await buildResearchPackage(input); return ""; } catch (error) { return error instanceof ResearchPackageError ? error.problems.join(" | ") : String(error); }
  };
  for (const [name, text] of ENCODINGS) {
    const found = await problems(make({ locality: `Creek, ${text}` }));
    assert.match(found, /still in the record/u, `${name}: ${found}`);
  }
  assert.match(await problems(make({}, { title: `Seen at ${LAT}, ${LON}` })), /canonical\.fields\.title is still in the record/u);
  assert.equal(await problems(make({ locality: "Dry creek, north of the mill" })), "", "a record with no place in it builds");
  const clean = withholdCanonicalRecordVersion(make({}, { title: `Creek, ${LAT}, ${LON}` }).records[0]!.canonical as never);
  const input = make({});
  const record = { ...input.records[0]!, canonical: clean.value, withheld: [...clean.withheld] } as never;
  const built = await buildResearchPackage({ ...input, records: [record] });
  const jsonl = new TextDecoder().decode(built.files.find((file) => file.path === "data/records.jsonl")!.bytes);
  assert.equal(jsonl.includes(LAT), false);
  assert.match(jsonl, /\[location withheld\]/u);
});

// ---------------------------------------------------------------------------
// RR3 the option is exact

test("RR3: missingVisibility must be exactly the string public; anything else is an error, not a silent no", async () => {
  for (const bad of ["Public", "true", true, 1, "restricted", "", null]) {
    const options = { missingVisibility: bad as never };
    assert.throws(() => locationStateOf({}, options), RangeError, String(bad));
    assert.throws(() => withholdStagedRow({ data: {}, source: {}, ...options, ...stagedOptions }), RangeError, String(bad));
    assert.throws(() => withholdCanonicalRecordVersion({ fields: {} }, options), RangeError, String(bad));
    const archive = { ...sampleArchiveInput(), ...options };
    assert.throws(() => buildDarwinCoreArchive(archive), (error: unknown) => error instanceof DarwinCoreArchiveError && /missingVisibility must be/u.test(error.message), String(bad));
    await assert.rejects(buildResearchPackage({ ...samplePackageInput(), ...options }), (error: unknown) => error instanceof ResearchPackageError && /missingVisibility must be/u.test(error.problems.join()), String(bad));
  }
  assert.equal(locationStateOf({}, { missingVisibility: "public" }).publishes, true);
  assert.equal(locationStateOf({}, {}).publishes, false);
});
