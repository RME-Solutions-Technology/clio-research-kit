import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The vocabulary licence check (2026-10-30-vocab-licences.md): ICS terms by IRI only; attribution lines in SOURCES.md and NOTICE.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const ICS_BASE = "http://resource.geosciml.org/classifier/ics/ischart/";

test("ICS: vocabularies.json carries the chart concepts as IRIs only, with no unit labels list and no label-to-IRI map", () => {
  const vocabularies = JSON.parse(read("schemas/vocabularies.json")) as { lane: Record<string, unknown> };
  assert.equal("LANE_GEOLOGIC_AGE_UNITS" in vocabularies.lane, false, "the label list is not redistributed");
  const iris = vocabularies.lane.LANE_GEOLOGIC_AGE_IRIS;
  assert.ok(Array.isArray(iris) && iris.length >= 20, "a list of IRIs");
  assert.ok((iris as string[]).every((iri) => iri.startsWith(ICS_BASE)));
});

test("ICS: the age fields annotate their terms with a list of IRIs, not a map from labels", () => {
  let checked = 0;
  for (const profile of readdirSync(join(root, "schemas", "profiles"))) {
    for (const file of readdirSync(join(root, "schemas", "profiles", profile))) {
      const schema = JSON.parse(read(`schemas/profiles/${profile}/${file}`)) as { properties: Record<string, Record<string, unknown>> };
      for (const [key, property] of Object.entries(schema.properties)) {
        const iris = property["x-clio-vocabularyIris"];
        if (key === "ageEarliest" || key === "ageLatest") {
          assert.ok(Array.isArray(iris), `${profile} ${file} ${key}`);
          assert.ok((iris as string[]).every((iri) => iri.startsWith(ICS_BASE)));
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 2, "ageEarliest and ageLatest in the one profile version that has them");
});

test("SOURCES.md and NOTICE carry the attribution and the honest licence status", () => {
  const sources = read("schemas/SOURCES.md");
  const notice = read("NOTICE");
  assert.match(sources, /ICS terms referenced by IRI; labels not redistributed pending permission/u);
  assert.match(sources, /Permissions_ICS_2017_v2\.pdf/u);
  assert.match(sources, /CGI Simple Lithology, CGI Geoscience Terminology Working Group \(CGI\), CC BY 4\.0/u);
  assert.match(sources, /CC0 1\.0/u);
  assert.match(sources, /Federhen/u);
  for (const name of ["OGC coordinate reference system identifiers", "AAVSO Extended File Format codes", "UDUNITS-2 unit spellings"]) {
    const row = sources.split("\n").find((line) => line.startsWith(`| ${name}`));
    assert.ok(row && /Not checked/u.test(row), name);
  }
  assert.match(notice, /CGI Simple Lithology.*CC BY 4\.0/su);
  assert.match(notice, /referenced by IRI only/u);
  assert.match(notice, /ENVO and NCBITaxon \(OBO Foundry\), CC0 1\.0/u);
  assert.match(notice, /Federhen S\. 2012/u);
  assert.match(notice, /licences not checked/u);
  assert.doesNotMatch(sources, /CC BY 4\.0 according to the ARDC vocabulary registry/u, "the earlier unverified ICS claim is gone");
});
