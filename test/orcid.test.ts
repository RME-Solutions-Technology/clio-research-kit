import assert from "node:assert/strict";
import test from "node:test";
import { isValidOrcid, normalizeOrcid } from "../src/orcid.ts";

// 0000-0002-1825-0097 is the example iD in ORCID's own documentation (Josiah Carberry, a fictional researcher).
test("ORCID iDs are accepted bare or as https://orcid.org/ URLs when the check digit is right", () => {
  assert.equal(isValidOrcid("0000-0002-1825-0097"), true);
  assert.equal(isValidOrcid("https://orcid.org/0000-0002-1825-0097"), true);
  assert.equal(isValidOrcid("0000-0002-1694-233X"), true, "an X check digit");
  assert.equal(isValidOrcid("0000-0002-1694-233x"), true, "lowercase x is normalised");
});

test("wrong check digits, shapes and hosts are rejected", () => {
  assert.equal(isValidOrcid("0000-0002-1825-0098"), false);
  assert.equal(isValidOrcid("0000000218250097"), false);
  assert.equal(isValidOrcid(" 0000-0002-1825-0097"), false);
  assert.equal(isValidOrcid("http://orcid.org/0000-0002-1825-0097"), false);
  assert.equal(isValidOrcid("https://orcid.org.evil.example/0000-0002-1825-0097"), false);
  assert.equal(isValidOrcid("https://orcid.org/0000-0002-1825-0097?x=1"), false);
  assert.equal(isValidOrcid(["https://", "user", "@", "orcid.org/0000-0002-1825-0097"].join("")), false);
  assert.equal(isValidOrcid(undefined), false);
  assert.equal(isValidOrcid(42), false);
});

test("normalizeOrcid returns the canonical URL or null", () => {
  assert.equal(normalizeOrcid("0000-0002-1694-233x"), "https://orcid.org/0000-0002-1694-233X");
  assert.equal(normalizeOrcid("nope"), null);
});
