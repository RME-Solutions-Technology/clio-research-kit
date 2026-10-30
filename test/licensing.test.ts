import assert from "node:assert/strict";
import test from "node:test";
import { CC_BY_4_0, DEFAULT_LICENCE, DEFAULT_LICENCE_URI, licenceProblems, resolveLicence } from "../src/licensing.ts";

test("the default licence is CC BY 4.0", () => {
  assert.equal(DEFAULT_LICENCE, CC_BY_4_0);
  assert.equal(DEFAULT_LICENCE_URI, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(CC_BY_4_0.spdxIdentifier, "CC-BY-4.0");
  assert.equal(resolveLicence(), CC_BY_4_0);
  assert.equal(Object.isFrozen(CC_BY_4_0), true);
});

test("a caller-supplied licence is used and checked", () => {
  const nc = { name: "Creative Commons Attribution-NonCommercial 4.0 International", shortName: "CC BY-NC 4.0", spdxIdentifier: "CC-BY-NC-4.0", uri: "https://creativecommons.org/licenses/by-nc/4.0/" };
  assert.equal(resolveLicence(nc), nc);
  assert.deepEqual(licenceProblems(nc), []);
  assert.deepEqual(licenceProblems({ ...nc, uri: "http://creativecommons.org/licenses/by-nc/4.0/" }), ["licence.uri must be an https URL without credentials"]);
  assert.deepEqual(licenceProblems({ ...nc, uri: "not a url" }), ["licence.uri must be an absolute https URL"]);
  assert.deepEqual(licenceProblems({ ...nc, name: "" }), ["licence.name is required"]);
  assert.deepEqual(licenceProblems(null), ["licence must be an object"]);
});
