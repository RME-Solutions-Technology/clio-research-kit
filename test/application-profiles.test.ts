import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_PROFILE_VERSIONS,
  APPLICATION_PROFILES,
  READINESS_LEVELS,
  assertField,
  findApplicationProfile,
  listApplicationProfiles,
  validateApplicationProfileData,
  type ApplicationProfile,
  type ReadinessLevel,
} from "../src/application-profiles.ts";
import {
  POLLEN_MORPHOLOGY_VOCABULARY,
  derivePollenShapeClass,
} from "../src/pollen-vocabulary.ts";

const expectedLaunchableIds = [
  "clio.profile.general-observation",
  "clio.profile.biological-occurrence",
  "clio.profile.structured-survey",
  "clio.profile.material-sample",
  "clio.profile.pollen-reference-slide",
  "clio.profile.pollen-field-aerobiological-palaeo-sample",
  "clio.profile.microscopy-image",
  "clio.profile.geological-sample",
  "clio.profile.astronomy-image",
  "clio.profile.calibrated-astronomy-observation",
  "clio.profile.variable-star-observation",
  "clio.profile.meteor-fireball-report",
  "clio.profile.collection-description",
  "clio.profile.sequence-sample",
];

const expectedCurrentVersions: Readonly<Record<string, string>> = {
  "clio.profile.general-observation": "1.0.0",
  "clio.profile.biological-occurrence": "1.1.0",
  "clio.profile.structured-survey": "1.1.0",
  "clio.profile.material-sample": "1.1.0",
  "clio.profile.pollen-reference-slide": "1.2.0",
  "clio.profile.pollen-field-aerobiological-palaeo-sample": "1.1.0",
  "clio.profile.microscopy-image": "1.1.0",
  "clio.profile.geological-sample": "1.1.0",
  "clio.profile.astronomy-image": "1.1.0",
  "clio.profile.calibrated-astronomy-observation": "1.1.0",
  "clio.profile.variable-star-observation": "1.0.0",
  "clio.profile.meteor-fireball-report": "1.0.0",
  "clio.profile.collection-description": "1.0.0",
  "clio.profile.sequence-sample": "1.1.0",
};

function profile(id: string): ApplicationProfile {
  const found = findApplicationProfile(id, "1.0.0");
  assert.ok(found, `missing profile ${id}`);
  return found;
}

function minimumData(candidate: ApplicationProfile, readiness: ReadinessLevel): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of candidate.fields) {
    if (!field.requiredAt || READINESS_LEVELS.indexOf(field.requiredAt) > READINESS_LEVELS.indexOf(readiness)) continue;
    switch (field.datatype) {
      case "string":
      case "identifier":
        values[field.key] = "recorded value";
        break;
      case "uri":
        values[field.key] = field.key === "rightsLicense"
          ? "https://creativecommons.org/licenses/by/4.0/"
          : "https://example.test/source";
        break;
      case "date":
      case "date_or_interval":
        values[field.key] = "2026-09-01";
        break;
      case "datetime":
        values[field.key] = "2026-09-01T00:00:00Z";
        break;
      case "enum":
        values[field.key] = field.vocabulary?.[0] ?? "unknown";
        break;
      case "integer":
        values[field.key] = field.min !== undefined ? Math.max(1, field.min) : 1;
        break;
      case "number":
        values[field.key] = field.min !== undefined ? Math.max(1, field.min) : 1;
        break;
      case "latitude":
        values[field.key] = 0;
        break;
      case "longitude":
        values[field.key] = 0;
        break;
      case "boolean":
        values[field.key] = true;
        break;
      case "string_array":
        values[field.key] = [field.vocabulary?.[0] ?? "value"];
        break;
      case "number_array":
        values[field.key] = [1];
        break;
      case "json":
        values[field.key] = {};
        break;
    }
    if (field.unitRequiredAt && READINESS_LEVELS.indexOf(field.unitRequiredAt) <= READINESS_LEVELS.indexOf(readiness)) {
      values[field.key] = assertField(values[field.key], { unit: field.units?.[0] });
    }
  }
  return values;
}

test("the registry pins the launchable profile IDs and versions", () => {
  assert.deepEqual(listApplicationProfiles().map((item) => item.id), expectedLaunchableIds);
  assert.equal(listApplicationProfiles().length, 14);
  assert.equal(listApplicationProfiles({ includeUnsupported: true }).length, 14);
  for (const id of expectedLaunchableIds) assert.equal(APPLICATION_PROFILE_VERSIONS[id], expectedCurrentVersions[id], id);
  assert.equal(APPLICATION_PROFILES.length, 14);
  assert.equal(findApplicationProfile("clio.profile.pollen-reference-slide", "9.9.9"), undefined);
});

test("pollen profile 1.2 is current while profiles 1.1 and 1.0 remain exact historical contracts", () => {
  const current = findApplicationProfile("clio.profile.pollen-reference-slide");
  const previous = findApplicationProfile("clio.profile.pollen-reference-slide", "1.1.0");
  const historical = findApplicationProfile("clio.profile.pollen-reference-slide", "1.0.0");
  assert.ok(current);
  assert.ok(previous);
  assert.ok(historical);
  assert.equal(current.version, "1.2.0");
  assert.equal(previous.version, "1.1.0");
  assert.equal(historical.version, "1.0.0");
  assert.equal(current.fields.some((field) => field.key === "pollenMountantType"), true);
  assert.equal(previous.fields.some((field) => field.key === "pollenMountantType"), false);
  assert.equal(previous.fields.some((field) => field.key === "pollenDispersalUnit"), true);
  assert.equal(historical.fields.some((field) => field.key === "pollenDispersalUnit"), false);
  assert.equal(previous.qualityChecks, undefined);
  assert.equal(listApplicationProfiles().some((profile) => profile.version !== "1.2.0" && profile.id === current.id), false);
  assert.equal(listApplicationProfiles({ includeHistorical: true }).filter((profile) => profile.id === current.id).length, 3);
});

test("pollen 1.1 controlled terms remain optional and accept useful low-information records", () => {
  const current = findApplicationProfile("clio.profile.pollen-reference-slide");
  assert.ok(current);
  const data = minimumData(current, "referenceable");
  delete data.pollenDispersalUnit;
  delete data.pollenApertureTypes;
  assert.equal(validateApplicationProfileData(current.id, current.version, data, "referenceable").valid, true);
  data.pollenShapeClass = "prolate";
  data.pollenObservationMethod = "LM";
  data.pollenApertureTypes = ["colpus", "pore"];
  assert.equal(validateApplicationProfileData(current.id, current.version, data, "referenceable").valid, true);
  data.pollenShapeClass = "not-a-controlled-term";
  assert.equal(validateApplicationProfileData(current.id, current.version, data, "referenceable").valid, false);
  data.pollenShapeClass = "prolate";
  data.pollenApertureTypes = ["colpus", "not-a-controlled-term"];
  assert.equal(validateApplicationProfileData(current.id, current.version, data, "referenceable").valid, false);
});

test("pollen P/E shape derivation retains measurements and uses versioned boundary rules", () => {
  assert.equal(POLLEN_MORPHOLOGY_VOCABULARY.version, "0.1.0");
  assert.equal(derivePollenShapeClass(25, 50)?.shapeClass, "oblate");
  assert.equal(derivePollenShapeClass(9.5, 10)?.shapeClass, "oblate-spheroidal");
  assert.equal(derivePollenShapeClass(10, 10)?.shapeClass, "prolate-spheroidal");
  assert.equal(derivePollenShapeClass(2, 1)?.shapeClass, "prolate");
  assert.equal(derivePollenShapeClass(2.01, 1)?.shapeClass, "perprolate");
  assert.equal(derivePollenShapeClass(0, 10), undefined);
  assert.equal(derivePollenShapeClass(10, -1), undefined);
});

test("every profile field key is unique and every profile makes no conformance claim", () => {
  for (const candidate of listApplicationProfiles({ includeUnsupported: true })) {
    assert.equal(candidate.conformanceClaim, "none");
    assert.equal(Object.isFrozen(candidate), true);
    assert.equal(Object.isFrozen(candidate.fields), true);
    assert.equal(Object.isFrozen(candidate.standardReferences), true);
    const keys = candidate.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, `${candidate.id} has duplicate field keys`);
    for (const field of candidate.fields) {
      assert.ok(field.key.length > 0);
      assert.ok(field.section.length > 0);
      assert.ok(field.help.length > 0);
      assert.ok(field.sensitivity);
    }
  }
});

test("unknown profile IDs, versions, and non-objects fail closed", () => {
  assert.equal(validateApplicationProfileData("clio.profile.missing", "1.0.0", {}).valid, false);
  assert.equal(validateApplicationProfileData("clio.profile.general-observation", "9.9.9", {}).findings[0]?.code, "unknown_profile_version");
  assert.equal(validateApplicationProfileData("clio.profile.general-observation", "1.0.0", null).findings[0]?.code, "invalid_data");
  assert.equal(validateApplicationProfileData("clio.profile.general-observation", "1.0.0", "not an object").findings[0]?.code, "invalid_data");
});

test("required fields progress monotonically from draft to archive acceptance", () => {
  const candidate = profile("clio.profile.general-observation");
  const draft = validateApplicationProfileData(candidate.id, candidate.version, { title: "A record", observedOn: "2026-09-01", locality: "generalised", observer: "observer" }, "draft");
  assert.equal(draft.valid, true);
  const referenceable = validateApplicationProfileData(candidate.id, candidate.version, { title: "A record", observedOn: "2026-09-01", locality: "generalised", observer: "observer", method: "direct observation", rightsLicense: "https://creativecommons.org/licenses/by/4.0/", uncertaintyNote: "none known" }, "referenceable");
  assert.equal(referenceable.valid, true);
  const researchReady = validateApplicationProfileData(candidate.id, candidate.version, { title: "A record", observedOn: "2026-09-01", locality: "generalised", observer: "observer", method: "direct observation", rightsLicense: "https://creativecommons.org/licenses/by/4.0/", uncertaintyNote: "none known" }, "research_ready");
  assert.equal(researchReady.valid, false);
  assert.ok(researchReady.findings.some((item) => item.code === "required_field" && item.field === "sourceReference"));
  const archive = validateApplicationProfileData(candidate.id, candidate.version, minimumData(candidate, "archive_accepted"), "archive_accepted");
  assert.equal(archive.valid, true);
  assert.ok(archive.findings.length <= researchReady.findings.length || archive.valid);
});

test("DOI-ready validation is stricter than referenceable validation", () => {
  const candidate = profile("clio.profile.biological-occurrence");
  const referenceableData = minimumData(candidate, "referenceable");
  assert.equal(validateApplicationProfileData(candidate.id, candidate.version, referenceableData, "referenceable").valid, true);

  const doiReadyData = minimumData(candidate, "doi_ready");
  assert.equal(validateApplicationProfileData(candidate.id, candidate.version, doiReadyData, "doi_ready").valid, true);
  delete doiReadyData.taxonConceptId;
  const doiFailure = validateApplicationProfileData(candidate.id, candidate.version, doiReadyData, "doi_ready");
  assert.equal(doiFailure.valid, false);
  assert.ok(doiFailure.findings.some((item) => item.code === "required_field" && item.field === "taxonConceptId"));
  assert.equal(validateApplicationProfileData(candidate.id, candidate.version, doiReadyData, "referenceable").valid, true);
});

test("unknown fields and basic datatype, vocabulary, URI, and range checks are machine-readable", () => {
  const candidate = profile("clio.profile.astronomy-image");
  const result = validateApplicationProfileData(candidate.id, candidate.version, {
    title: "Night image", observedOn: "2026-02-31", locality: "observatory", observer: "observer", targetName: "Target",
    unknownField: true, exposureSeconds: assertField(-2, { unit: "second" }), declination: assertField(95, { unit: "degree" }),
    calibrationStatus: "invented", rightsLicense: "not a URI", method: "camera",
  }, "referenceable");
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((item) => item.code === "unknown_field" && item.field === "unknownField"));
  assert.ok(result.findings.some((item) => item.code === "out_of_range" && item.field === "exposureSeconds"));
  assert.ok(result.findings.some((item) => item.code === "out_of_range" && item.field === "declination"));
  assert.ok(result.findings.some((item) => item.code === "invalid_enum" && item.field === "calibrationStatus"));
  assert.ok(result.findings.some((item) => item.code === "invalid_datatype" && item.field === "rightsLicense"));
  assert.ok(result.findings.some((item) => item.code === "invalid_datatype" && item.field === "observedOn"));
});

test("assertion wrappers preserve source, uncertainty, visibility and units while validating values", () => {
  const candidate = profile("clio.profile.pollen-reference-slide");
  const data = minimumData(candidate, "research_ready");
  data.polarAxis = assertField(24.5, { unit: "micrometre", source: "slide-notebook-1", uncertainty: { value: 0.5, unit: "micrometre" }, visibility: "public" });
  const result = validateApplicationProfileData(candidate.id, candidate.version, data, "research_ready");
  assert.equal(result.valid, true);
  assert.equal((data.polarAxis as { source: string }).source, "slide-notebook-1");
  data.locality = assertField("generalised locality", { visibility: "public" });
  assert.equal(validateApplicationProfileData(candidate.id, candidate.version, data, "research_ready").valid, false);
  assert.ok(validateApplicationProfileData(candidate.id, candidate.version, data, "research_ready").findings.some((item) => item.code === "invalid_visibility"));
});

test("blank assertion values still obey required-field rules", () => {
  const candidate = profile("clio.profile.general-observation");
  const result = validateApplicationProfileData(candidate.id, candidate.version, {
    title: assertField("", { source: "field-note" }), observedOn: "2026-09-01", locality: "generalised", observer: "observer",
  }, "draft");
  assert.equal(result.valid, false);
  assert.ok(result.findings.some((item) => item.code === "required_field" && item.field === "title"));
});

test("pollen profiles require morphology at research readiness and astronomy profiles require observation context", () => {
  const pollen = profile("clio.profile.pollen-reference-slide");
  const pollenData = minimumData(pollen, "referenceable");
  const pollenResult = validateApplicationProfileData(pollen.id, pollen.version, pollenData, "research_ready");
  assert.equal(pollenResult.valid, false);
  assert.ok(pollenResult.findings.some((item) => item.field === "apertureType" && item.code === "required_field"));
  assert.ok(pollenResult.findings.some((item) => item.field === "polarAxis" && item.code === "required_field"));

  const astronomy = profile("clio.profile.calibrated-astronomy-observation");
  const astronomyData = minimumData(astronomy, "referenceable");
  const astronomyResult = validateApplicationProfileData(astronomy.id, astronomy.version, astronomyData, "research_ready");
  assert.equal(astronomyResult.valid, false);
  assert.ok(astronomyResult.findings.some((item) => item.field === "wcsSolution" && item.code === "required_field"));
  assert.ok(astronomyResult.findings.some((item) => item.field === "timeScale" && item.code === "required_field"));
});
