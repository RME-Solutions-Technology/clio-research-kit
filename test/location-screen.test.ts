import assert from "node:assert/strict";
import test from "node:test";
import { containsLocationText, redactLocationText, withholdCanonicalRecordVersion, withholdStagedRow } from "../src/index.ts";

// RR6 (final re-review of 4c223ea): encodings that the free-text screen missed or half-redacted.
const MARKER = "[location withheld]";
// Any fragment of the coordinates used below that must not survive.
const LEFTOVER = /33[.,]?\s?81|151[.,]?\s?21|81234|21234|3400|5200|3080|filled|count\.soap|r3gx|56hl/iu;

const CASES: [string, string][] = [
  // decimal comma
  ["decimal-comma pair, space separated", "-33,81234 151,21234"],
  ["decimal-comma pair, semicolon", "-33,81234; 151,21234"],
  ["decimal-comma pair, slash", "-33,81234/151,21234"],
  // degree sign
  ["decimal degrees with a degree sign", "-33.81234° 151.21234°"],
  ["decimal degrees with a masculine ordinal sign", "-33.81234º, 151.21234º"],
  ["one decimal degree with a sign", "latitude -33.81234°"],
  // single coordinates
  ["a single coordinate alone", "-33.81234"],
  ["a single coordinate after latitude is", "latitude is -33.81234"],
  ["a single coordinate after east of", "east of 151.21234"],
  ["a single decimal-comma coordinate", "151,21234"],
  ["a single longitude with a hemisphere letter", "151.21234 E"],
  ["a single label with few decimals", "lon 151.2"],
  // full width digits
  ["full-width digits", "－３３．８１２３４，１５１．２１２３４"],
  ["full-width digits with a degree sign", "３３．８１２３４° １５１．２１２３４°"],
  // zero width and soft hyphen
  ["pair split by a zero-width space", "-33.81​234, 151.21​234"],
  ["pair split by a zero-width joiner and a soft hyphen", "-33.81‍234,­151.21234"],
  ["pair split by a word joiner", "-33.81⁠234 151.21234"],
  ["Unicode minus", "−33.81234, 151.21234"],
  // slash separated and labelled
  ["slash pair after lat/long", "(lat/long -33.81234/151.21234)"],
  ["slash pair after lat/lon", "lat/lon: -33.81234 / 151.21234"],
  // grid references
  ["lowercase MGRS", "56hly 3400 5200"],
  ["uppercase MGRS, no spaces", "56HLH3340062520"],
  ["OS grid reference with spaces", "TQ 30 80"],
  ["OS grid reference, six figures", "TQ 123 456"],
  ["OS grid reference, lowercase and joined", "tq3080"],
  // short codes
  ["geohash, labelled", "geohash: r3gx2f77b"],
  ["geohash, labelled with a space", "Geo hash r3gx2f77b"],
  ["what3words with slashes", "///filled.count.soap"],
  ["what3words, labelled", "what3words: filled.count.soap"],
  ["w3w, labelled", "w3w filled.count.soap"],
  ["plus code, lowercase", "4rrh46h5+c7"],
];

test("MF2: a long run of whitespace, digits or separators is screened in well under a second", () => {
  const hostile = [
    "1" + " ".repeat(100_000), "1" + " ".repeat(60_000), "1" + " ".repeat(30_000) + "E", "-33.8" + " ".repeat(60_000) + ",", " , ".repeat(20_000), "1 ".repeat(30_000),
    "1,".repeat(30_000), "-".repeat(60_000), ".1".repeat(30_000), "1.1".repeat(20_000), "1 N ".repeat(15_000), "\t\n ".repeat(20_000) + "5",
  ];
  for (const text of hostile) {
    const started = Date.now();
    redactLocationText(text);
    containsLocationText(text);
    const spent = Date.now() - started;
    assert.ok(spent < 800, `${spent} ms for ${JSON.stringify(text.slice(0, 12))}... (${text.length} chars)`);
  }
  const staged = withholdStagedRow({ data: {}, source: { locationVisibility: "restricted", remarks: "1" + " ".repeat(100_000), notes: "2" + " ".repeat(100_000) }, keepKeys: ["remarks", "notes"], profileId: "clio.profile.general-observation", profileVersion: "1.0.0" });
  assert.equal(staged.value.source.remarks, "[location withheld]", "a cell over the cap is withheld whole");
});

test("MF2: whitespace around a pair is collapsed and the pair is still redacted", () => {
  assert.equal(redactLocationText("seen at -33.81234" + " ".repeat(500) + "151.21234 today").includes("33.8"), false);
  assert.equal(redactLocationText("a  b"), "a  b", "text with no place is returned exactly as it came");
});

test("S5: a removed column whose name is a place does not put the place into withheld", () => {
  const staged = withholdStagedRow({ data: {}, source: { locationVisibility: "restricted", "-33.81234 151.21234": "x" }, profileId: "clio.profile.general-observation", profileVersion: "1.0.0" });
  assert.equal(JSON.stringify(staged).includes("33.81234"), false, JSON.stringify(staged));
  assert.ok(staged.withheld.some((path) => path.includes("*")));
});

test("RR6: every case is fully redacted, with no half of a pair left", () => {
  for (const [name, text] of CASES) {
    assert.equal(containsLocationText(text), true, name);
    for (const sentence of [text, `Seen near the creek: ${text}. Bring water.`, `(${text})`]) {
      const out = redactLocationText(sentence);
      assert.match(out, /\[location withheld\]/u, `${name}: ${out}`);
      assert.equal(LEFTOVER.test(out), false, `${name}: ${JSON.stringify(out)}`);
      assert.equal(/\d{3,}/u.test(out.replace(/[-]/gu, "")), false, `${name}: no run of three digits survives: ${JSON.stringify(out)}`);
      assert.equal(redactLocationText(out), out, `${name}: redacting twice changes nothing`);
    }
  }
});

test("RR6: the surrounding text, spacing and sentence stay readable", () => {
  assert.equal(redactLocationText("lat/long -33.81234/151.21234 near the gate"), "lat/long [location withheld] near the gate");
  assert.equal(redactLocationText("Seen at -33,81234 151,21234, then left."), "Seen at [location withheld], then left.");
  assert.equal(redactLocationText("east of 151.21234 by the mill"), "east of [location withheld] by the mill");
});

test("RR6: text that is not a place is returned exactly as it came, normalisation and all left alone", () => {
  for (const fine of [
    "Bring 12 specimens, 3.5 mm long", "Temp 21.5°C at 10:30", "Specimen SYN1234567890 pressed", "Weighed 0.5 g on 2026-10-01", "version 2.1, build 4",
    ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-"), "Seen 10 cms 20 cm deep", "Plot 12 beside the creek", "It was so 12 degrees", "to 15 people and on 2026 days", "Cover 40 percent",
    "Ｆｕｌｌ－ｗｉｄｔｈ ｗｏｒｄｓ and ﬁne ligatures", "a​b zero-width but no place",
  ]) {
    assert.equal(containsLocationText(fine), false, fine);
    assert.equal(redactLocationText(fine), fine, fine);
  }
});

test("RR6: the same cases are removed from kept fields of a staged row and a canonical record", () => {
  for (const [name, text] of CASES) {
    const staged = withholdStagedRow({ data: { title: `T ${text}` }, source: { locationVisibility: "restricted", remarks: `Near ${text} gate` }, keepKeys: ["remarks"], profileId: "clio.profile.general-observation", profileVersion: "1.0.0" });
    const stagedText = JSON.stringify(staged.value);
    assert.equal(LEFTOVER.test(stagedText), false, `${name}: ${stagedText}`);
    const canonical = {
      recordId: "r", versionId: "v", canonicalUri: "https://example.org/r",
      fields: {
        title: `Record ${text}`,
        profile: { profileId: "clio.profile.general-observation", profileVersion: "1.0.0", data: { title: "T", description: `Seen ${text}` } },
        event: { eventDate: "2026-10-01", locality: `Creek, ${text}`, locationVisibility: "restricted" },
        uncertaintyStatement: text,
        rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
      },
    };
    const out = JSON.stringify(withholdCanonicalRecordVersion(canonical).value);
    assert.equal(LEFTOVER.test(out), false, `${name}: ${out}`);
  }
});

test("RR6: a zero-width split pair cannot hide a place from the builder's check either", () => {
  assert.equal(containsLocationText("Behind the mill, -33.81​234, 151.21​234"), true);
  assert.equal(containsLocationText("Behind the mill, －33.81234, 151.21234"), true);
});

test("RR6 limits, stated: an unlabelled geohash, a street address and a place in words are not found", () => {
  for (const text of ["r3gx2f77b", "7 Smith Road, Springwood", "Lot 12 Parish of Cook", "the second gate past the old mill"]) {
    assert.equal(containsLocationText(text), false, text);
  }
});
