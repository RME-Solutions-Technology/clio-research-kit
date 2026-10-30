import assert from "node:assert/strict";
import test from "node:test";
import { containsLocationText, isLocationKey, isLocationValue, locationStateOf, redactLocationText, withoutLocationValues } from "../src/location-visibility.ts";
import { withholdCanonicalRecordVersion, withholdStagedRow } from "../src/research-withholding.ts";

// Synthetic test data only. Ported from the Clio online museum repository's location-screen tests (PR 148 review): the same cases, so the
// two screens are held to the same bar. Where this library differs on purpose (a place-name field is dropped, a blank visibility cell
// reads as restricted) the expectation says so.
const MARKER = "[location withheld]";
// Any fragment of the coordinates used below that must not survive.
const LEFTOVER = /33[.,]?\s?81|151[.,]?\s?21|81234|21234|3400|5200|3080|filled|count\.soap|r3gx|56hl/iu;

const CASES: [string, string][] = [
  ["decimal-comma pair, space separated", "-33,81234 151,21234"],
  ["decimal-comma pair, semicolon", "-33,81234; 151,21234"],
  ["decimal-comma pair, slash", "-33,81234/151,21234"],
  ["decimal degrees with a degree sign", "-33.81234° 151.21234°"],
  ["decimal degrees with a masculine ordinal sign", "-33.81234º, 151.21234º"],
  ["one decimal degree with a sign", "latitude -33.81234°"],
  ["a single coordinate alone", "-33.81234"],
  ["a single coordinate after latitude is", "latitude is -33.81234"],
  ["a single coordinate after east of", "east of 151.21234"],
  ["a single decimal-comma coordinate", "151,21234"],
  ["a single longitude with a hemisphere letter", "151.21234 E"],
  ["a single label with few decimals", "lon 151.2"],
  ["full-width digits", "－３３．８１２３４，１５１．２１２３４"],
  ["full-width digits with a degree sign", "３３．８１２３４° １５１．２１２３４°"],
  ["pair split by a zero-width space", "-33.81​234, 151.21​234"],
  ["pair split by a zero-width joiner and a soft hyphen", "-33.81‍234,­151.21234"],
  ["pair split by a word joiner", "-33.81⁠234 151.21234"],
  ["Unicode minus", "−33.81234, 151.21234"],
  ["slash pair after lat/long", "(lat/long -33.81234/151.21234)"],
  ["slash pair after lat/lon", "lat/lon: -33.81234 / 151.21234"],
  ["lowercase MGRS", "56hly 3400 5200"],
  ["uppercase MGRS, no spaces", "56HLH3340062520"],
  ["OS grid reference with spaces", "TQ 30 80"],
  ["OS grid reference, six figures", "TQ 123 456"],
  ["OS grid reference, lowercase and joined", "tq3080"],
  ["geohash, labelled", "geohash: r3gx2f77b"],
  ["geohash, labelled with a space", "Geo hash r3gx2f77b"],
  ["what3words with slashes", "///filled.count.soap"],
  ["what3words, labelled", "what3words: filled.count.soap"],
  ["w3w, labelled", "w3w filled.count.soap"],
  ["plus code, lowercase", "4rrh46h5+c7"],
  ["map URL", "https://www.google.com/maps/@-33.81234,151.21234,15z"],
  ["geo URI", "geo:-33.81234,151.21234"],
  ["WKT", "POINT(151.21234 -33.81234)"],
  ["serialised GeoJSON", "{\"type\":\"Point\",\"coordinates\":[151.21234,-33.81234]}"],
  ["DMS", "33°48'44\"S 151°12'45\"E"],
];

test("free text: every place is fully redacted, with no half of a pair left", () => {
  for (const [name, text] of CASES) {
    assert.equal(containsLocationText(text), true, name);
    for (const sentence of [text, `Seen near the creek: ${text}. Bring water.`, `(${text})`]) {
      const out = redactLocationText(sentence);
      assert.match(out, /\[location withheld\]/u, `${name}: ${out}`);
      assert.equal(LEFTOVER.test(out), false, `${name}: ${JSON.stringify(out)}`);
      assert.equal(redactLocationText(out), out, `${name}: redacting twice changes nothing`);
    }
  }
  assert.equal(redactLocationText("lat/long -33.81234/151.21234 near the gate"), `lat/long ${MARKER} near the gate`);
});

test("free text: ordinary numbers, dates and identifiers are returned exactly as they came", () => {
  for (const fine of [
    "Bring 12 specimens, 3.5 mm long", "Temp 21.5°C at 10:30", "Specimen SYN1234567890 pressed", "Weighed 0.5 g on 2026-10-01", "version 2.1, build 4",
    ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-"), "Seen 10 cms 20 cm deep", "Plot 12 beside the creek", "Cover 40 percent",
  ]) {
    assert.equal(containsLocationText(fine), false, fine);
    assert.equal(redactLocationText(fine), fine, fine);
  }
});

test("free text: stated limits, an unlabelled geohash, a street address and a place in words are not found", () => {
  for (const text of ["r3gx2f77b", "7 Smith Road, Springwood", "Lot 12 Parish of Cook", "the second gate past the old mill"]) assert.equal(containsLocationText(text), false, text);
});

test("keys outside any deny list are recognised as places by name or by what they hold", () => {
  for (const key of ["x", "y", "utmEasting", "decimalLatitudeDeg", "mgrs", "geohash", "position", "latlong", "latLng"]) assert.equal(isLocationKey(key), true, key);
  for (const value of ["-33.81234 151.21234", [151.21234, -33.81234], { lat: -33.8, lng: 151.2 }, { x: 1, y: 2 }, { type: "Point", coordinates: [1, 2] }]) assert.equal(isLocationValue(value), true, JSON.stringify(value));
  const withheld: string[] = [];
  const cleaned = withoutLocationValues({ location: "-33.81234, 151.21234", latlong: [-33.81234, 151.21234], spot: { x: 3, y: 4 }, note: "ok", remarks: "At -33.81234 151.21234 by the gate" }, "root", withheld) as Record<string, unknown>;
  assert.deepEqual(Object.keys(cleaned).sort(), ["location", "note", "remarks"]);
  assert.equal(cleaned.location, MARKER, "a place written as text is redacted in place");
  assert.equal(cleaned.remarks, `At ${MARKER} by the gate`);
  assert.deepEqual([...withheld].sort(), ["root.latlong", "root.location", "root.remarks", "root.spot"]);
});

test("an own __proto__ key is kept as data by the screen and never becomes a prototype", () => {
  const hostile = JSON.parse('{"__proto__":{"inherited":1},"title":"x"}') as unknown;
  const cleaned = withoutLocationValues(hostile, "root", []) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(cleaned), Object.prototype);
  assert.equal(cleaned.inherited, undefined);
});

test("a restricted staged row and canonical record lose places written under any key or in any text", () => {
  const profile = { profileId: "clio.profile.general-observation", profileVersion: "1.0.0" };
  for (const [name, text] of CASES) {
    const staged = withholdStagedRow({
      data: { title: `T ${text}`, location: text, latlong: text, x: 151.21234, y: -33.81234, utmEasting: 334000, nested: { position: { lat_lng: text } } },
      source: { locationVisibility: "restricted", remarks: `Near ${text} gate`, meta: { gps: text, deeper: { point: text } } },
      keepKeys: ["remarks"], ...profile,
    });
    const stagedText = JSON.stringify(staged.value);
    assert.equal(LEFTOVER.test(stagedText), false, `${name}: ${stagedText}`);
    assert.equal(/334000/u.test(stagedText), false, name);
    const canonical = {
      recordId: "r", versionId: "v", canonicalUri: "https://example.org/r",
      fields: {
        title: `Record ${text}`,
        profile: { ...profile, data: { title: "T", description: `Seen ${text}`, location: text, extra: { x: 151.21234 } } },
        event: { eventDate: "2026-10-01", locality: `Creek, ${text}`, locationVisibility: "restricted", location: text, utmEasting: 334000, nested: { latlong: text } },
        uncertaintyStatement: text,
        wherever: { position: text, anything: { y: -33.81234 } },
        rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
      },
    };
    const out = JSON.stringify(withholdCanonicalRecordVersion(canonical).value);
    assert.equal(LEFTOVER.test(out), false, `${name}: ${out}`);
    assert.equal(/334000/u.test(out), false, name);
    assert.match(out, /"eventDate":"2026-10-01"/u, "non-spatial fields stay");
  }
});

test("a published location keeps its fields untouched", () => {
  const profile = { profileId: "clio.profile.general-observation", profileVersion: "1.0.0" };
  const staged = withholdStagedRow({ data: { title: "T", latitude: -33.81234, location: "x" }, source: { locationVisibility: "public", gps: "-33.81234 151.21234" }, ...profile });
  assert.deepEqual(staged.withheld, []);
  assert.equal(staged.value.source.gps, "-33.81234 151.21234");
});

test("reading the location marker costs one visit per object, however many places share it", () => {
  // A graph where every level points at the same child twelve times would take 12^8 steps if each path were walked.
  let level: Record<string, unknown> = { locationVisibility: "restricted" };
  for (let depth = 0; depth < 8; depth += 1) level = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, level]));
  const started = Date.now();
  assert.equal(locationStateOf(level).state, "restricted");
  assert.ok(Date.now() - started < 1000, "shared references are visited once");
});

const PLACES = ["found at -33.81234, 151.29876", "-33.81234 151.29876", "33.81234S 151.29876E", "33°48'44\"S 151°17'55\"E", "S33 48.74 E151 17.93", "33 48 44 S, 151 17 55 E", "lat -33.81234 lon 151.29876", "lat: -33.8 lng: 151.3", "N 33.81234", "x=151.29876 y=-33.81234",
  "https://www.google.com/maps/@-33.81234,151.29876,15z", "https://maps.app.goo.gl/abcdef", "geo:-33.81234,151.29876", "4RRH+XX Sydney", "///filled.count.soap", "56H LH 123456 234567", "56 H 334000 6252000", "ﾠ-33.81234, 151.29876", "-33.81234,151.29876", "−33.81234, 151.29876", "-33,81234; 151,29876",
  "POINT(151.29876 -33.81234)", "{\"type\":\"Point\",\"coordinates\":[151.29876,-33.81234]}", "[151.29876, -33.81234]", "33.81234 S, 151.29876 E", "-33.81234\n151.29876", "approx 33.8123° S and 151.2988° E", "grid ref SU 123 456", "NZMG 2500000 6000000", "-33.8, 151.3", "-34 151", "-34, 151",
  "34S 151E", "lat=-34 lon=151", "Lat 34 deg 48 min S", "-33.81234/151.29876", "33°S 151°E", "approx. 34 S 151 E", "(-33.81234)(151.29876)", "decimal -33.81234 and then 151.29876", "-33.81234 | 151.29876", "-33.81234:151.29876", "lat-33.81234lon151.29876", "w3w: filled.count.soap", "Plus code 4RRH+XX", "geohash r3gx2f", "MGRS 56HLH1234523456", "56HLH12342345",
  "34, 151", "51.5, -0.12", "48.8566, 2.3522"];
const ORDINARY = ["Plots 1, 2 and 3", "Trip 3, 4 observers", "n = 12, 14 samples", "2026-09-14", "14/09/2026", "2026-09-14T10:30:00+10:00", "10:30 - 11:45", "Specimen ABC-123, box 4", "Ref 12 34", "5 - 10 mm", "temperature 24.5 C, ph 7.2", "magnification 40x", "Species: Vombatus ursinus",
  "sample 3, 15 cm depth", "id 1234", "version 1.0.3", "50.5, 60.2 mm", "length 12.5 x 4.5 cm", "page 12, 14", "Rob Evans, 2026", "cat 2, dog 3", "12 June 2026", "ISO 9001, 14001", "rated 4.5, 3.8", "14.3 m", "0.0001 g", "weight 23.4567 g", "ph 7.12345", "area 2.5, 3.5 ha", "weight 123.4567 g", "ratio 2.5 : 3.5"];

test("free text: ordinary measurements, counts and ranges are not mistaken for places", () => {
  for (const text of ORDINARY) assert.equal(redactLocationText(text), text, text);
});

test("free text: tightening did not lose the places that were being caught", () => {
  for (const text of PLACES) {
    const out = redactLocationText(text);
    assert.match(out, /\[location withheld\]/u, text);
    assert.equal(/\d[\d.,]{3,}/u.test(out.replace(/\[location withheld\]/gu, "")), false, `${text} -> ${out}`);
  }
});

test("a text made of unfinished WKT heads costs one pass, and real WKT is still found", () => {
  for (const hostile of ["POINT(1 ".repeat(25000), "POLYGON((1 ".repeat(18000), "MULTIPOINT(".repeat(18000) + "1"]) {
    const started = Date.now();
    redactLocationText(hostile);
    containsLocationText(hostile);
    assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`);
  }
  assert.equal(redactLocationText("see POLYGON((151.1 -33.1, 151.2 -33.1, 151.2 -33.2, 151.1 -33.1)) done"), "see [location withheld] done");
  assert.equal(redactLocationText("MULTIPOINT Z (151.1 -33.1 5) and POINT(1 2)"), "[location withheld] and [location withheld]");
  assert.equal(containsLocationText("a POINT(unfinished"), false);
});

test("a visibility key keeps only the state it was read as", () => {
  const withheld: string[] = [];
  const cleaned = withoutLocationValues({
    locationVisibility: "Restricted (-33.81234, 151.29876)",
    "Location Visibility": { value: "restricted", where: "-33.81234, 151.29876" },
    "site/location_visibility": ["restricted", "-33.81234", "151.29876"],
    nested: { location_visibility: "restricted", other: "ok" },
    blank: { locationVisibility: "" },
  }, "root", withheld) as Record<string, unknown>;
  assert.deepEqual(cleaned, { locationVisibility: "restricted", "Location Visibility": "restricted", "site/location_visibility": "restricted", nested: { location_visibility: "restricted", other: "ok" }, blank: { locationVisibility: "restricted" } });
  assert.ok(withheld.includes("root.blank.locationVisibility"), "a blank cell says nothing, so it reads as restricted here (the Clio screen drops it)");
});
