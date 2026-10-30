import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_LICENCE_URI, hasRequiredRecordFields, validateRecordFields, type RecordFields } from "../src/index.ts";

const fields: RecordFields = {
  title: "Exemplaria synthetica at Synthetic Reserve",
  profile: {
    profileId: "clio.profile.general-observation",
    profileVersion: "1.0.0",
    readinessTarget: "referenceable",
    data: {},
  },
  event: { eventDate: "2026-08-13", locality: "Generalised synthetic locality", recordedBy: "A. Tester", method: "Direct field observation" },
  uncertaintyStatement: "Identification not independently reviewed.",
  authors: [{ ordinal: 0, nameLiteral: "A. Tester" }],
  media: [{ mediaObjectId: "media-1", ordinal: 0, mediaRole: "primary" }],
  rights: { licenceUri: DEFAULT_LICENCE_URI },
};

test("a well-formed record carries required event, authorship, rights and media fields", () => {
  assert.equal(hasRequiredRecordFields(fields), true);
});

test("an author needs a literal name, or given and family names together", () => {
  assert.equal(hasRequiredRecordFields({ ...fields, authors: [{ ordinal: 0 }] }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, authors: [{ ordinal: 0, nameLiteral: "A. Tester" }] }), true);
  assert.equal(hasRequiredRecordFields({ ...fields, authors: [{ ordinal: 0, givenName: "A." }] }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, authors: [{ ordinal: 0, givenName: "A.", familyName: "Tester", orcid: "https://orcid.org/0000-0002-1825-0097" }] }), true);
  assert.equal(hasRequiredRecordFields({ ...fields, authors: [{ ordinal: 0, nameLiteral: "A. Tester", orcid: "https://orcid.org/0000-0002-1825-0098" }] }), false, "a wrong ORCID check digit is rejected");
  assert.equal(hasRequiredRecordFields({ ...fields, authors: [] }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, authors: [fields.authors[0]!, fields.authors[0]!] }), false);
});

test("media is optional, but supplied media needs a primary representation and unique ordinals", () => {
  assert.equal(hasRequiredRecordFields({ ...fields, media: [{ ...fields.media[0]!, mediaRole: "supporting" }] }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, media: [] }), true);
  assert.equal(hasRequiredRecordFields({ ...fields, media: [fields.media[0]!, { ...fields.media[0]!, mediaObjectId: "media-2" }] }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, media: [fields.media[0]!, { mediaObjectId: "media-2", ordinal: 0, mediaRole: "supporting" }] }), false);
});

test("pollen image calibration resolves to exactly one attached media object", () => {
  const pollen = {
    ...fields,
    profile: {
      profileId: "clio.profile.pollen-reference-slide",
      profileVersion: "1.1.0",
      readinessTarget: "referenceable" as const,
      data: {
        recordBasis: "MaterialSample",
        taxonomicRank: "species",
        taxonScientificName: "Acacia sp.",
        slideIdentifier: "slide-1",
        pollenTaxonName: "Acacia sp.",
        pollenImageCalibrations: [{ mediaObjectId: "media-1", mediaOrdinal: 0, micrometresPerPixel: 0.15 }],
      },
    },
  };
  assert.equal(validateRecordFields(pollen).valid, true);

  for (const [calibrations, code] of [
    [[{ mediaObjectId: "missing", micrometresPerPixel: 0.15 }], "pollen_image_media_reference_invalid"],
    [[{ mediaOrdinal: 7, micrometresPerPixel: 0.15 }], "pollen_image_media_reference_invalid"],
    [[{ mediaObjectId: "media-1", mediaOrdinal: 1, micrometresPerPixel: 0.15 }], "pollen_image_media_reference_invalid"],
    [[{ mediaOrdinal: 0, micrometresPerPixel: 0.15 }, { mediaObjectId: "media-1", imageView: "polar" }], "pollen_image_media_reference_duplicate"],
  ] as const) {
    const candidate = {
      ...pollen,
      media: [fields.media[0]!, { mediaObjectId: "media-2", ordinal: 1, mediaRole: "supporting" as const }],
      profile: { ...pollen.profile, data: { ...pollen.profile.data, pollenImageCalibrations: calibrations } },
    };
    assert.ok(validateRecordFields(candidate).findings.some((item) => item.code === code), code);
  }
});

test("event, title and rights fields fail closed when missing or blank", () => {
  assert.equal(hasRequiredRecordFields({ ...fields, title: "" }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, eventDate: "" } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, locality: "   " } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, method: "" } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, uncertaintyStatement: "" }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, rights: { licenceUri: "" } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, rights: { licenceUri: "http://creativecommons.org/licenses/by/4.0/" } }), false, "an http licence URI is rejected");
  assert.equal(hasRequiredRecordFields(null), false);
  assert.equal(hasRequiredRecordFields("not-an-object"), false);
});

test("records must state the required licence, CC BY 4.0 unless the caller names another", () => {
  const cc0 = "https://creativecommons.org/publicdomain/zero/1.0/";
  assert.equal(hasRequiredRecordFields({ ...fields, rights: { licenceUri: cc0 } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, rights: { licenceUri: cc0 } }, { licenceUri: cc0 }), true);
  assert.equal(hasRequiredRecordFields(fields, { licenceUri: cc0 }), false);
  assert.equal(validateRecordFields({ ...fields, rights: { licenceUri: cc0 } }).findings.some((item) => item.code === "licence_policy_mismatch"), true);
  // Profile data that states its own rightsLicense follows the same option.
  const ncUri = "https://creativecommons.org/licenses/by-nc/4.0/";
  const result = validateRecordFields({ ...fields, rights: { licenceUri: ncUri } }, { licenceUri: ncUri });
  assert.equal(result.valid, true, JSON.stringify(result.findings));
});

test("profile identifiers, versions and readiness fail closed", () => {
  assert.equal(hasRequiredRecordFields({ ...fields, profile: { ...fields.profile, profileId: "clio.profile.unknown" } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, profile: { ...fields.profile, profileVersion: "9.9.9" } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, profile: { ...fields.profile, readinessTarget: "draft" } }), false);
});

test("profile-specific data is validated and cannot duplicate the universal envelope", () => {
  assert.equal(hasRequiredRecordFields({ ...fields, profile: { ...fields.profile, data: { title: fields.title } } }), false);
  const biological = {
    ...fields,
    profile: {
      profileId: "clio.profile.biological-occurrence",
      profileVersion: "1.0.0",
      readinessTarget: "referenceable" as const,
      data: { recordBasis: "HumanObservation", taxonomicRank: "species", taxonScientificName: "Cracticus tibicen" },
    },
  };
  assert.equal(hasRequiredRecordFields(biological), true);
  assert.equal(hasRequiredRecordFields({ ...biological, profile: { ...biological.profile, data: { recordBasis: "HumanObservation" } } }), false);
});

test("closed event-date intervals and bounded coordinates are accepted", () => {
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, eventDate: "2026-08-01/2026-08-13", decimalLatitude: -33.7, decimalLongitude: 150.3, coordinateUncertaintyM: 1000 } }), true);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, eventDate: "2026-08-13/2026-08-01" } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, decimalLatitude: -33.7 } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, decimalLatitude: 95, decimalLongitude: 150.3 } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, locationVisibility: "restricted" } }), false);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, locationVisibility: "restricted", privateLocationObjectRef: "vault://restricted/location-1" } }), true);
  assert.equal(hasRequiredRecordFields({ ...fields, event: { ...fields.event, locationVisibility: "restricted", privateLocationObjectRef: "vault://restricted/location-1", decimalLatitude: -33.7, decimalLongitude: 150.3 } }), false);
});
