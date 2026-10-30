import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  READINESS_LEVELS,
  assertField,
  canonicalApplicationProfileDefinition,
  findApplicationProfile,
  listApplicationProfiles,
  readinessRank,
  validateApplicationProfileData,
  type ApplicationProfile,
  type FieldDefinition,
  type ReadinessLevel,
} from "../src/application-profiles.ts";
import {
  LANE_ENVO_IRI_PATTERN,
  LANE_OCCURRENCE_STATUS_EXPORT,
  LANE_READ_LAYOUTS,
  suggestedWaterEnvoContext,
} from "../src/lane-vocabularies.ts";
import { validateRecordFields, type RecordFields } from "../src/record-fields.ts";

const NOW = new Date("2026-10-23T00:00:00Z");
const options = { now: NOW } as const;
const laneProfiles = listApplicationProfiles({ includeHistorical: true }).filter((profile) => profile.qualityChecks !== undefined);
const EVENT_KEYS = new Set(["decimalLatitude", "decimalLongitude", "coordinateUncertaintyM", "geodeticDatum", "countryCode", "locationVisibility"]);

function lane(id: string, version?: string): ApplicationProfile {
  const profile = version === undefined ? findApplicationProfile(id) : findApplicationProfile(id, version);
  assert.ok(profile, `missing ${id}@${version ?? "current"}`);
  return profile;
}

function sampleValue(field: FieldDefinition): unknown {
  if (field.key === "rightsLicense") return "https://creativecommons.org/licenses/by/4.0/";
  switch (field.datatype) {
    case "latitude": return field.example ? Number(field.example) : -33.87;
    case "longitude": return field.example ? Number(field.example) : 151.21;
    case "number": return field.example ? Number(field.example) : Math.max(1, field.min ?? 1);
    case "integer": return Math.max(1, field.min ?? 1);
    case "boolean": return true;
    case "date":
    case "date_or_interval": return "2026-09-01";
    case "datetime": return field.example ?? "2026-09-01T10:00:00Z";
    case "enum": return field.vocabulary![0];
    case "string_array": return field.vocabulary ? [field.vocabulary[0]] : JSON.parse(field.example ?? "[\"value\"]");
    case "number_array": return [1];
    case "json": return field.example ? JSON.parse(field.example) : { note: "value" };
    case "uri": return field.example ?? "https://example.test/source";
    default: return field.example ?? "recorded value";
  }
}

function withUnit(field: FieldDefinition, value: unknown, readiness: ReadinessLevel): unknown {
  return field.unitRequiredAt && readinessRank(field.unitRequiredAt) <= readinessRank(readiness) ? assertField(value, { unit: field.units?.[0] }) : value;
}

function minimumData(profile: ApplicationProfile, readiness: ReadinessLevel): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const byKey = new Map(profile.fields.map((field) => [field.key, field]));
  const fill = (key: string) => {
    const field = byKey.get(key)!;
    if (values[key] === undefined) values[key] = withUnit(field, sampleValue(field), readiness);
  };
  for (const field of profile.fields) {
    if (field.requiredAt && readinessRank(field.requiredAt) <= readinessRank(readiness)) fill(field.key);
  }
  for (const rule of profile.qualityChecks?.conditional ?? []) {
    if (rule.from && readinessRank(rule.from) > readinessRank(readiness)) continue;
    const current = values[rule.when.field];
    if (current === undefined || !rule.when.in.includes(current as string | boolean)) continue;
    for (const key of rule.require ?? []) fill(key);
    if (rule.requireAny) fill(rule.requireAny[0]!);
  }
  return values;
}

test("1.0.0 definitions (and pollen reference slide 1.1.0) keep their seeded commitments byte for byte", () => {
  const seeded: Readonly<Record<string, string>> = {
    "clio.profile.general-observation@1.0.0": "d192b0a1d6090c57bf95c6fd1584b3e913fd15d808ac6e50406573314d62af6f",
    "clio.profile.biological-occurrence@1.0.0": "86f52fbde4e9830c86cf3a17ea080a5a4a668e932805b6d8af2844cd1ca702bd",
    "clio.profile.structured-survey@1.0.0": "b3ab608d81c5fbc59fccc037a964c1dad86d8b125c7fc92d5f24c7eb1f48885e",
    "clio.profile.material-sample@1.0.0": "a5231c3a5e41f08b819a0c751a7cd75eebefde790ebec80afc824d85afd9fcca",
    "clio.profile.pollen-reference-slide@1.0.0": "72f3a46b08acebc83b771a932ce6601ce89b5deb170c2e3c3156ae14afaa2e63",
    "clio.profile.pollen-reference-slide@1.1.0": "4102873539cdfd1195806609d6b83bba9cde9dee372fcb7e4826d964961d6232",
    "clio.profile.pollen-field-aerobiological-palaeo-sample@1.0.0": "cc25c0c9b60ac754afda79bdb717178f81a96cab245943934dd7f5f8b1d77515",
    "clio.profile.microscopy-image@1.0.0": "2a2c2ff4e26d338308f166d4588370968bcd7f32d4ca1693be37d404f9e2a903",
    "clio.profile.geological-sample@1.0.0": "bffe7191d63636fd92d1de4025596093f588326825a7af6e227836263b0f3bca",
    "clio.profile.astronomy-image@1.0.0": "031fb0680f79543f3eb4bd89e313e148b9ce83b2646aa1902dca547e013543d5",
    "clio.profile.calibrated-astronomy-observation@1.0.0": "16cce17576595b46a3a893b07578a721054b8ce2d0ce424b8c7ad8f023b3d8ed",
    "clio.profile.collection-description@1.0.0": "967db85791ff69ab6c8dd80adb7448caff3efa0057207d0e07efdc6821023c65",
    "clio.profile.sequence-sample@1.0.0": "7f11a10bdde4317298c5ebce95d2b55edc076df889af7ab9f2287b0714b54597",
  };
  for (const [id, commitment] of Object.entries(seeded)) {
    const [profileId, version] = id.split("@");
    const profile = lane(profileId!, version!);
    assert.equal(profile.qualityChecks, undefined, id);
    assert.equal(createHash("sha256").update(canonicalApplicationProfileDefinition(profile)).digest("hex"), commitment, id);
  }
});

test("the lane uplift adds twelve immutable definitions and no conformance claim", () => {
  assert.deepEqual(laneProfiles.map((profile) => `${profile.id}@${profile.version}`).sort(), [
    "clio.profile.astronomy-image@1.1.0",
    "clio.profile.biological-occurrence@1.1.0",
    "clio.profile.calibrated-astronomy-observation@1.1.0",
    "clio.profile.geological-sample@1.1.0",
    "clio.profile.material-sample@1.1.0",
    "clio.profile.meteor-fireball-report@1.0.0",
    "clio.profile.microscopy-image@1.1.0",
    "clio.profile.pollen-field-aerobiological-palaeo-sample@1.1.0",
    "clio.profile.pollen-reference-slide@1.2.0",
    "clio.profile.sequence-sample@1.1.0",
    "clio.profile.structured-survey@1.1.0",
    "clio.profile.variable-star-observation@1.0.0",
  ]);
  for (const profile of laneProfiles) {
    assert.equal(profile.conformanceClaim, "none");
    assert.equal(Object.isFrozen(profile.qualityChecks), true, profile.id);
    assert.equal(profile.qualityChecks?.ruleSet, "clio.lane-checks/1.0.0");
    const keys = new Set(profile.fields.map((field) => field.key));
    assert.equal(keys.size, profile.fields.length, `${profile.id} duplicate keys`);
    for (const field of profile.fields) {
      assert.ok(field.label.length > 0 && field.label.length <= 60, `${profile.id}.${field.key} label`);
      assert.ok(field.help.length > 0 && field.help.length <= 320, `${profile.id}.${field.key} help length`);
      assert.doesNotMatch(field.help, /\b(?:color|center|catalog|analyze|organization)\b/u, `${profile.id}.${field.key} Australian English`);
      if (field.storedIn !== undefined) assert.ok(EVENT_KEYS.has(field.key), `${profile.id}.${field.key} unexpected event field`);
      if (field.pattern !== undefined && field.example !== undefined && field.datatype !== "string_array") assert.match(field.example, new RegExp(field.pattern, "u"), `${profile.id}.${field.key} example`);
      for (const [value, iri] of Object.entries(field.vocabularyIris ?? {})) {
        assert.ok(field.vocabulary?.includes(value), `${profile.id}.${field.key} IRI for unknown value ${value}`);
        assert.match(iri, /^https?:\/\/\S+$/u, `${profile.id}.${field.key} IRI`);
      }
    }
    for (const rule of profile.qualityChecks?.conditional ?? []) {
      for (const key of [rule.when.field, ...(rule.require ?? []), ...(rule.requireAny ?? []), ...(rule.restrict ? [rule.restrict.field] : [])]) assert.ok(keys.has(key), `${profile.id} rule references ${key}`);
    }
  }
});

test("every lane profile saves early and gets stricter level by level", () => {
  for (const profile of laneProfiles) {
    const draftOnly = minimumData(profile, "draft");
    assert.ok(Object.keys(draftOnly).length <= 7, `${profile.id} asks too much at draft: ${Object.keys(draftOnly).join(", ")}`);
    for (const [index, level] of READINESS_LEVELS.entries()) {
      const data = minimumData(profile, level);
      const result = validateApplicationProfileData(profile.id, profile.version, data, level, options);
      assert.equal(result.valid, true, `${profile.id}@${profile.version} ${level}: ${JSON.stringify(result.findings.filter((item) => item.severity === "error"))}`);
      if (index === 0) continue;
      const previous = minimumData(profile, READINESS_LEVELS[index - 1]!);
      const added = Object.keys(data).filter((key) => !(key in previous));
      if (added.length > 0) {
        const upgraded = validateApplicationProfileData(profile.id, profile.version, previous, level, options);
        assert.equal(upgraded.valid, false, `${profile.id} ${level} should guide the contributor to ${added.join(", ")}`);
      }
    }
  }
});

test("biology: coordinates, accuracy and datum are needed at research-ready unless the place is withheld", () => {
  const profile = lane("clio.profile.biological-occurrence");
  const data = minimumData(profile, "research_ready");
  for (const key of ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyM", "geodeticDatum"]) delete data[key];
  const missing = validateApplicationProfileData(profile.id, profile.version, data, "research_ready", options);
  assert.equal(missing.valid, false);
  for (const key of ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyM", "geodeticDatum"]) assert.ok(missing.findings.some((item) => item.code === "required_field" && item.field === key), key);
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...data, locationVisibility: "restricted" }, "research_ready", options).valid, true);
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...data, locationVisibility: "not_collected" }, "research_ready", options).valid, true);
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...data, locationVisibility: "generalized" }, "research_ready", options).valid, false);
  // Referenceable stays light: no coordinates needed yet.
  assert.equal(validateApplicationProfileData(profile.id, profile.version, minimumData(profile, "referenceable"), "referenceable", options).valid, true);
});

test("coordinate sanity: 0/0, missing halves, zero accuracy and unknown datums are caught in 1.1 only", () => {
  const profile = lane("clio.profile.biological-occurrence");
  const base = minimumData(profile, "referenceable");
  const nullIsland = validateApplicationProfileData(profile.id, profile.version, { ...base, decimalLatitude: 0, decimalLongitude: 0 }, "referenceable", options);
  assert.ok(nullIsland.findings.some((item) => item.code === "coordinate_implausible" && item.severity === "error"));
  const draftNullIsland = validateApplicationProfileData(profile.id, profile.version, { ...minimumData(profile, "draft"), decimalLatitude: 0, decimalLongitude: 0 }, "draft", options);
  assert.equal(draftNullIsland.valid, true, "draft keeps the check as a warning so beginners can save");
  assert.ok(draftNullIsland.findings.some((item) => item.code === "coordinate_implausible" && item.severity === "warning"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...base, decimalLatitude: -33.8 }, "referenceable", options).findings.some((item) => item.code === "incomplete_pair"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...base, coordinateUncertaintyM: 0 }, "referenceable", options).findings.some((item) => item.code === "not_positive"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...base, geodeticDatum: "EPSG:9999" }, "referenceable", options).findings.some((item) => item.code === "invalid_enum"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...base, countryCode: "Australia" }, "referenceable", options).findings.some((item) => item.code === "invalid_format"));
  // 1.0.0 does not know these fields at all, so its behaviour is unchanged.
  const historical = lane("clio.profile.biological-occurrence", "1.0.0");
  assert.equal(historical.fields.some((field) => field.key === "decimalLatitude"), false);
});

test("future dates and time-zone-free date-times are rejected from referenceable in 1.1, and 1.0.0 is unchanged", () => {
  const biology = lane("clio.profile.biological-occurrence");
  const data = minimumData(biology, "referenceable");
  const future = validateApplicationProfileData(biology.id, biology.version, { ...data, observedOn: "2026-10-30" }, "referenceable", options);
  assert.ok(future.findings.some((item) => item.code === "future_date" && item.field === "observedOn" && item.severity === "error"));
  assert.ok(validateApplicationProfileData(biology.id, biology.version, { ...data, observedOn: "2026-10-01/2026-11-30" }, "referenceable", options).findings.some((item) => item.code === "future_date"));
  // Tomorrow in Sydney can be today in UTC: allow the UTC+14 window.
  assert.equal(validateApplicationProfileData(biology.id, biology.version, { ...data, observedOn: "2026-10-23" }, "referenceable", options).valid, true);

  const astronomy = lane("clio.profile.astronomy-image");
  const sky = minimumData(astronomy, "referenceable");
  const naive = validateApplicationProfileData(astronomy.id, astronomy.version, { ...sky, observationStart: "2026-10-22 21:00", observationEnd: "2026-10-22T21:30:00+11:00" }, "referenceable", options);
  assert.ok(naive.findings.some((item) => item.code === "missing_time_zone" && item.field === "observationStart"));
  const reversed = validateApplicationProfileData(astronomy.id, astronomy.version, { ...sky, observationStart: "2026-10-22T22:00:00+11:00", observationEnd: "2026-10-22T10:30:00Z" }, "referenceable", options);
  assert.ok(reversed.findings.some((item) => item.code === "inconsistent_values" && item.field === "observationEnd"));
  assert.ok(validateApplicationProfileData(astronomy.id, astronomy.version, { ...sky, observationStart: "2027-01-01T00:00:00Z", observationEnd: "2027-01-01T01:00:00Z" }, "referenceable", options).findings.some((item) => item.code === "future_date"));

  const historical = lane("clio.profile.astronomy-image", "1.0.0");
  const old = validateApplicationProfileData(historical.id, historical.version, {
    title: "Night", observedOn: "2030-01-01", locality: "site", observer: "observer", targetName: "M42", method: "camera",
    rightsLicense: "https://creativecommons.org/licenses/by/4.0/", uncertaintyNote: "none known",
    observationStart: "2026-10-22 21:00", observationEnd: "2026-10-22 20:00", instrumentName: "camera", exposureSeconds: assertField(30, { unit: "second" }),
  }, "referenceable", options);
  assert.equal(old.valid, true, "1.0.0 keeps accepting naive, future and reversed values exactly as before");
});

test("astronomy 1.1 needs time scale, filter, site and sky position at research-ready", () => {
  for (const id of ["clio.profile.astronomy-image", "clio.profile.calibrated-astronomy-observation"]) {
    const profile = lane(id);
    const result = validateApplicationProfileData(profile.id, profile.version, minimumData(profile, "referenceable"), "research_ready", options);
    for (const key of ["timeScale", "filterBand", "observatoryLatitude", "observatoryLongitude", "rightAscension", "declination", "coordinateFrame"]) {
      assert.ok(result.findings.some((item) => item.code === "required_field" && item.field === key), `${id}.${key}`);
    }
  }
});

test("variable star and meteor report profiles follow the AAVSO and IMO report content", () => {
  const star = lane("clio.profile.variable-star-observation");
  assert.equal(star.version, "1.0.0");
  const starData = minimumData(star, "research_ready");
  assert.equal(validateApplicationProfileData(star.id, star.version, starData, "research_ready", options).valid, true);
  const dif = validateApplicationProfileData(star.id, star.version, { ...starData, magnitudeType: "DIF" }, "research_ready", options);
  assert.ok(dif.findings.some((item) => item.field === "comparisonStarMagnitude" && item.code === "required_field"));
  assert.ok(validateApplicationProfileData(star.id, star.version, { ...starData, filter: "Green" }, "research_ready", options).findings.some((item) => item.code === "invalid_enum"));
  assert.ok(validateApplicationProfileData(star.id, star.version, { ...starData, observationMidpoint: "2026-10-22T11:30:00" }, "referenceable", options).findings.some((item) => item.code === "missing_time_zone"));

  const meteor = lane("clio.profile.meteor-fireball-report");
  const fireball = { ...minimumData(meteor, "referenceable"), reportKind: "fireball_sighting" };
  const incomplete = validateApplicationProfileData(meteor.id, meteor.version, { ...minimumData(meteor, "research_ready"), ...fireball }, "research_ready", options);
  for (const key of ["durationSeconds", "startAzimuth", "endElevation", "notAircraftOrSatellite"]) assert.ok(incomplete.findings.some((item) => item.field === key), key);
  assert.equal(validateApplicationProfileData(meteor.id, meteor.version, fireball, "referenceable", options).valid, true, "fireball geometry is guidance, not a referenceable blocker");
  assert.ok(validateApplicationProfileData(meteor.id, meteor.version, { ...fireball, meteorShowerCounts: { perseids: 4 } }, "referenceable", options).findings.some((item) => item.field === "meteorShowerCounts"));
  assert.equal(validateApplicationProfileData(meteor.id, meteor.version, { ...fireball, meteorShowerCounts: { PER: 4, ORI: 0 } }, "referenceable", options).valid, true);
});

test("survey completeness and count/status consistency follow the Humboldt guidance", () => {
  const survey = lane("clio.profile.structured-survey");
  const data = minimumData(survey, "research_ready");
  for (const key of ["targetTaxonomicScope", "isTaxonomicScopeFullyReported", "isAbsenceReported", "isAbundanceReported"]) {
    const result = validateApplicationProfileData(survey.id, survey.version, { ...data, [key]: undefined }, "research_ready", options);
    assert.ok(result.findings.some((item) => item.field === key && item.code === "required_field"), key);
  }
  const absent = validateApplicationProfileData(survey.id, survey.version, { ...data, occurrenceStatus: "notDetected", eventCount: 3, isAbsenceReported: false }, "research_ready", options);
  assert.ok(absent.findings.some((item) => item.code === "inconsistent_values" && item.field === "eventCount"));
  assert.ok(absent.findings.some((item) => item.code === "inconsistent_values" && item.field === "isAbsenceReported"));
  assert.equal(validateApplicationProfileData(survey.id, survey.version, { ...data, occurrenceStatus: "notDetected", eventCount: 0 }, "research_ready", options).valid, true);

  const occurrence = lane("clio.profile.biological-occurrence");
  const sighting = minimumData(occurrence, "research_ready");
  assert.ok(validateApplicationProfileData(occurrence.id, occurrence.version, { ...sighting, individualCount: 0 }, "research_ready", options).findings.some((item) => item.code === "inconsistent_values"));
  assert.deepEqual(LANE_OCCURRENCE_STATUS_EXPORT, { detected: "present", notDetected: "absent" });
});

test("biology vocabularies carry Darwin Core and NERC IRIs and keep uncertain answers", () => {
  const profile = lane("clio.profile.biological-occurrence");
  const field = (key: string) => profile.fields.find((item) => item.key === key)!;
  assert.deepEqual(field("recordBasis").vocabulary, ["HumanObservation", "MachineObservation", "MaterialSample", "PreservedSpecimen", "LivingSpecimen", "FossilSpecimen", "Occurrence"]);
  assert.equal(field("recordBasis").vocabularyIris?.LivingSpecimen, "http://rs.tdwg.org/dwc/dwctype/LivingSpecimen");
  assert.equal(field("establishmentMeans").vocabularyIris?.introduced, "http://rs.tdwg.org/dwcem/values/e003");
  assert.ok(field("establishmentMeans").vocabulary?.includes("uncertain"));
  assert.equal(field("sex").vocabularyIris?.female, "http://vocab.nerc.ac.uk/collection/S10/current/S102/");
  assert.ok(field("lifeStage").vocabulary?.includes("unknown"));
  assert.equal(field("taxonNameResolution").requiredAt, "research_ready");
  assert.equal(field("taxonBackbone").requiredAt, "research_ready", "name resolution moves earlier than DOI-ready");
  assert.equal(field("taxonConceptId").requiredAt, "doi_ready");
});

test("geology: Mohs bounds, CGI and ICS IRIs, tenure and sensitive-site rules", () => {
  const profile = lane("clio.profile.geological-sample");
  const data = minimumData(profile, "research_ready");
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, hardness: assertField(11, { unit: "mohs" }) }, "research_ready", options).findings.some((item) => item.code === "out_of_range"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, hardness: assertField(0.5, { unit: "mohs" }) }, "research_ready", options).findings.some((item) => item.code === "out_of_range"));
  const historical = lane("clio.profile.geological-sample", "1.0.0");
  assert.equal(validateApplicationProfileData(historical.id, historical.version, { title: "t", observedOn: "2026-01-01", locality: "l", observer: "o", geologicMaterialType: "mineral", hardness: 11 }, "draft").valid, true, "1.0.0 keeps its original (unbounded) hardness");

  const field = (key: string) => profile.fields.find((item) => item.key === key)!;
  assert.equal(field("lithologyClass").vocabularyIris?.basalt, "http://resource.geosciml.org/classifier/cgi/lithology/basalt");
  assert.equal(field("ageEarliest").vocabularyIris?.Jurassic, "http://resource.geosciml.org/classifier/ics/ischart/Jurassic");
  assert.ok(field("lithologyClass").vocabulary?.includes("unknown"));
  assert.match(field("mineralSpecies").help, /mindat\.org/u);
  assert.match(field("mineralSpecies").help, /don't copy/u);

  const mineral: Record<string, unknown> = { ...minimumData(profile, "referenceable"), geologicMaterialType: "mineral" };
  delete mineral.mineralSpecies;
  assert.ok(validateApplicationProfileData(profile.id, profile.version, mineral, "referenceable", options).findings.some((item) => item.field === "mineralSpecies"));
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...mineral, mineralSpecies: "unidentified" }, "referenceable", options).valid, true);

  const heritage = { ...minimumData(profile, "referenceable"), heritageCheck: "possible_cultural_material" };
  const exposed = validateApplicationProfileData(profile.id, profile.version, { ...heritage, locationVisibility: "public" }, "referenceable", options);
  assert.ok(exposed.findings.some((item) => item.field === "locationVisibility" && item.code === "inconsistent_values"));
  assert.ok(exposed.findings.some((item) => item.field === "collectionMethod" && item.code === "inconsistent_values"));
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...heritage, locationVisibility: "generalized", collectionMethod: "photographed_not_collected" }, "referenceable", options).valid, true);
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...minimumData(profile, "referenceable"), meteoriteCheck: "possible_meteorite" }, "referenceable", options).findings.some((item) => item.field === "locationVisibility"));

  const permit = validateApplicationProfileData(profile.id, profile.version, { ...data, collectionAuthority: "permit" }, "research_ready", options);
  assert.ok(permit.findings.some((item) => item.field === "permitReference"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, igsn: "not an igsn" }, "research_ready", options).findings.some((item) => item.code === "invalid_format"));
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...data, igsn: "10.60579/ABC123" }, "research_ready", options).valid, true);
});

test("water/eDNA: depth, ENVO IRIs, filtering, controls, primers and accessions", () => {
  const profile = lane("clio.profile.sequence-sample");
  const data = minimumData(profile, "research_ready");
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, envMedium: "https://example.org/creek" }, "research_ready", options).findings.some((item) => item.code === "invalid_format" && item.field === "envMedium"));
  assert.match("http://purl.obolibrary.org/obo/ENVO_01000599", new RegExp(LANE_ENVO_IRI_PATTERN, "u"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, pcrPrimerForward: "GTC GGT" }, "research_ready", options).findings.some((item) => item.field === "pcrPrimerForward"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, sequenceAccessions: ["PRJEB12345", "not-an-accession"] }, "research_ready", options).findings.some((item) => item.code === "invalid_format" && item.actual === "not-an-accession"));
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...data, sequenceAccessions: ["PRJEB12345", "ERR1234567", "SAMEA1234567"], bioSampleId: "SAMN01234567" }, "research_ready", options).valid, true);
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, sampleCategory: "negative_control" }, "research_ready", options).findings.some((item) => item.field === "negativeControlType"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, volumeCollected: assertField(500, { unit: "millilitre" }), volumeFiltered: assertField(900, { unit: "millilitre" }) }, "research_ready", options).findings.some((item) => item.code === "inconsistent_values"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, sampleDepth: undefined }, "referenceable", options).findings.some((item) => item.field === "sampleDepth"));
  assert.deepEqual(suggestedWaterEnvoContext("river_or_creek"), { envBroadScale: "http://purl.obolibrary.org/obo/ENVO_01000253", envMedium: "http://purl.obolibrary.org/obo/ENVO_01000599" });
  assert.equal(suggestedWaterEnvoContext("other"), undefined);
});

test("sequence sample 1.1 aligns readLayout with the MIxS link table while 1.0.0 keeps its original terms", () => {
  const current = lane("clio.profile.sequence-sample").fields.find((field) => field.key === "readLayout");
  const historical = lane("clio.profile.sequence-sample", "1.0.0").fields.find((field) => field.key === "readLayout");
  assert.deepEqual(current?.vocabulary, [...LANE_READ_LAYOUTS]);
  assert.deepEqual(current?.vocabulary, ["single", "paired", "other"]);
  assert.deepEqual(historical?.vocabulary, ["single_end", "paired_end", "long_read", "unknown"]);
});

test("imaging: specimen, preparation, method, calibration method and channels for microscopy 1.1", () => {
  const profile = lane("clio.profile.microscopy-image");
  const data = minimumData(profile, "research_ready");
  for (const key of ["samplePreparation", "imagingMethod", "pixelSizeCalibrationMethod", "organismScientificName", "biologicalEntity"]) {
    assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, [key]: undefined }, "research_ready", options).findings.some((item) => item.field === key), key);
  }
  assert.equal(validateApplicationProfileData(profile.id, profile.version, { ...data, specimenKind: "mineral_or_rock", organismScientificName: undefined, biologicalEntity: undefined }, "research_ready", options).valid, true);
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, numericalAperture: 2.4 }, "research_ready", options).findings.some((item) => item.code === "out_of_range"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, imagingChannels: [{ name: "DAPI", excitationNm: -1 }] }, "research_ready", options).findings.some((item) => item.field === "imagingChannels"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, pixelSize: assertField(0, { unit: "micrometre" }) }, "research_ready", options).findings.some((item) => item.code === "not_positive"));
  assert.ok(validateApplicationProfileData(profile.id, profile.version, { ...data, scaleEvidence: "no_scale" }, "research_ready", options).findings.some((item) => item.field === "pixelSizeCalibrationMethod"));
  assert.match(profile.fields.find((field) => field.key === "pixelSize")!.help, /Two-point/u);
});

test("pollen: palaeo depth, datum, structured age and calibrated images; reference slide 1.2 requires calibration", () => {
  const field = lane("clio.profile.pollen-field-aerobiological-palaeo-sample");
  const sediment = { ...minimumData(field, "research_ready"), sampleType: "sediment" };
  const missing = validateApplicationProfileData(field.id, field.version, sediment, "research_ready", options);
  assert.ok(missing.findings.some((item) => item.field === "depthDatum"));
  assert.ok(missing.findings.some((item) => item.field === "sampleDepth"));
  const withRange = { ...sediment, depthDatum: "core_top", sampleDepthTop: assertField(12, { unit: "centimetre" }), sampleDepthBottom: assertField(13, { unit: "centimetre" }) };
  assert.equal(validateApplicationProfileData(field.id, field.version, withRange, "research_ready", options).valid, true);
  assert.ok(validateApplicationProfileData(field.id, field.version, { ...withRange, sampleDepthTop: assertField(14, { unit: "centimetre" }) }, "research_ready", options).findings.some((item) => item.code === "inconsistent_values"));
  assert.ok(validateApplicationProfileData(field.id, field.version, { ...withRange, ageType: "calibrated_years_bp" }, "research_ready", options).findings.some((item) => item.field === "ageValue"));
  assert.equal(validateApplicationProfileData(field.id, field.version, { ...withRange, ageType: "calibrated_years_bp", ageValue: 4200, ageUncertainty: 60 }, "research_ready", options).valid, true);
  assert.ok(field.fields.some((item) => item.key === "pollenImageCalibrations"));

  const slide = lane("clio.profile.pollen-reference-slide");
  const slideData = minimumData(slide, "research_ready");
  assert.ok(validateApplicationProfileData(slide.id, slide.version, { ...slideData, pollenImageCalibrations: undefined }, "research_ready", options).findings.some((item) => item.field === "pollenImageCalibrations"));
  assert.deepEqual(slide.fields.find((item) => item.key === "pollenMountantType")?.vocabulary, ["glycerol", "glycerol_jelly", "silicone_oil", "other", "not_recorded"]);
  const previous = lane("clio.profile.pollen-reference-slide", "1.1.0");
  assert.equal(previous.fields.find((item) => item.key === "pollenImageCalibrations")?.requiredAt, undefined, "1.1.0 calibration stays optional");
});

function submission(profile: ApplicationProfile, data: Record<string, unknown>, event: Record<string, unknown>, readinessTarget: "referenceable" | "research_ready" = "research_ready"): RecordFields {
  return {
    title: "Synthetic record",
    profile: { profileId: profile.id, profileVersion: profile.version, readinessTarget, data },
    event: { eventDate: "2026-09-01", locality: "Synthetic place", recordedBy: "Synthetic observer", method: "Synthetic method", ...event },
    uncertaintyStatement: "none known",
    authors: [{ ordinal: 0, nameLiteral: "Synthetic observer" }],
    media: [],
    rights: { licenceUri: "https://creativecommons.org/licenses/by/4.0/" },
  } as RecordFields;
}

test("submission validation reads lane location fields from the event envelope only", () => {
  const profile = lane("clio.profile.biological-occurrence");
  const all = minimumData(profile, "research_ready");
  const profileData = Object.fromEntries(Object.entries(all).filter(([key]) => !EVENT_KEYS.has(key) && !["title", "observedOn", "locality", "observer", "description", "method", "rightsLicense", "uncertaintyNote", "sourceReference"].includes(key)));
  profileData.sourceReference = "field notebook";
  const event = { decimalLatitude: -33.87, decimalLongitude: 151.21, coordinateUncertaintyM: 30, geodeticDatum: "WGS84" };
  const valid = validateRecordFields(submission(profile, profileData, event));
  assert.equal(valid.valid, true, JSON.stringify(valid.findings));
  const missing = validateRecordFields(submission(profile, profileData, {}));
  assert.ok(missing.findings.some((item) => item.path === "profile.data.decimalLatitude" && item.code === "profile_required_field"));
  const duplicated = validateRecordFields(submission(profile, { ...profileData, decimalLatitude: -33.87 }, event));
  assert.ok(duplicated.findings.some((item) => item.code === "profile_universal_field_duplicated" && item.path === "profile.data.decimalLatitude"));
  const restricted = validateRecordFields(submission(profile, profileData, { locationVisibility: "restricted", privateLocationObjectRef: "vault://private/location-1" }));
  assert.equal(restricted.valid, true, JSON.stringify(restricted.findings));

  const historical = lane("clio.profile.biological-occurrence", "1.0.0");
  const historicalData = minimumDataV1(historical);
  assert.equal(validateRecordFields(submission(historical, historicalData, {}, "referenceable")).valid, true, "1.0.0 never needed coordinates");
});

function minimumDataV1(profile: ApplicationProfile): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of profile.fields) {
    if (!field.requiredAt || readinessRank(field.requiredAt) > readinessRank("referenceable")) continue;
    if (["title", "observedOn", "locality", "observer", "method", "rightsLicense", "uncertaintyNote"].includes(field.key)) continue;
    data[field.key] = field.datatype === "enum" ? field.vocabulary![0] : "value";
  }
  return data;
}

test("the Darwin Core Archive export reads lane count, status, establishment, basis and event coordinates", async () => {
  const { buildDarwinCoreArchive } = await import("../src/dwca.ts");
  const profile = lane("clio.profile.biological-occurrence");
  const data: Record<string, unknown> = {
    recordBasis: "LivingSpecimen", wildStatus: "planted_or_cultivated", taxonomicRank: "species", taxonScientificName: "Exemplaria synthetica",
    establishmentMeans: "introduced", occurrenceStatus: "detected", individualCount: 4, sourceReference: "Synthetic notebook",
  };
  const record = submission(profile, data, { decimalLatitude: -33.87, decimalLongitude: 151.21, coordinateUncertaintyM: 30, geodeticDatum: "WGS84", locationVisibility: "public" }, "referenceable");
  assert.equal(validateRecordFields(record).valid, true, JSON.stringify(validateRecordFields(record).findings));
  const archive = buildDarwinCoreArchive({
    datasetId: "urn:clio:research-package:lane-test-0001",
    title: "Synthetic lane test dataset",
    createdAt: "2026-10-23T00:00:00Z",
    creator: { organizationName: "Synthetic Test Lab" },
    records: [{ recordId: "lane-rec-1", versionId: "lane-v1", fields: record, landingPage: "https://example.org/records/lane-rec-1", rightsHolder: "Synthetic Observer" }],
  });
  const occurrence = archive.files.find((file) => file.path === "occurrence.txt");
  assert.ok(occurrence);
  const [header, row] = occurrence.text.trim().split(/\r?\n/u).map((line) => line.split("\t"));
  const value = (term: string) => row![header!.indexOf(term)];
  assert.equal(value("basisOfRecord"), "LivingSpecimen");
  assert.equal(value("occurrenceStatus"), "present");
  assert.equal(value("establishmentMeans"), "introduced");
  assert.equal(value("individualCount"), "4");
  assert.equal(value("decimalLatitude"), "-33.87");
  assert.equal(value("geodeticDatum"), "WGS84");
});
