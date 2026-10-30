import assert from "node:assert/strict";
import test from "node:test";
import {
  findApplicationProfile,
  isPollenImageCalibrations,
  validateApplicationProfileData,
} from "../src/index.ts";

test("pollen 1.1 exposes optional reference-collection exchange metadata", () => {
  const profile = findApplicationProfile("clio.profile.pollen-reference-slide", "1.1.0");
  assert.ok(profile);
  for (const key of [
    "pollenReferenceCollectionName", "pollenReferenceCollectionCurator", "pollenReferenceCollectionAccessUri",
    "pollenIdentificationType", "originalTaxonVerbatim", "voucherInstitutionCode",
    "voucherIdentifier", "livingCollectionInstitutionCode", "livingPlantIdentifier",
    "pollenCollectedBy", "pollenPreparedBy", "pollenPreparationTreatment",
    "pollenDigitisedBy", "pollenCuratedBy", "pollenMicroscopeConfiguration",
    "pollenImageCalibrations", "pollenSingleGrain", "pollenSampleAgeType", "pollenSampleAgeVerbatim",
    "externalPollenCollectionIdentifier", "externalPollenSlideIdentifier",
  ]) assert.ok(profile.fields.some((field) => field.key === key), `${key} is missing`);
});

test("per-image pollen calibration is media-linked, bounded, and optional", () => {
  const value = [{
    mediaOrdinal: 0,
    micrometresPerPixel: 0.15,
    calibrationDistancePixels: 100,
    calibrationDistanceMicrometres: 15,
    calibrationReference: "stage micrometer 2026-09",
    focusStackFrameCount: 24,
    focusStepMicrometres: 0.5,
    imageView: "polar",
  }];
  assert.equal(isPollenImageCalibrations(value), true);
  assert.equal(isPollenImageCalibrations([{ micrometresPerPixel: 0.15 }]), false);
  assert.equal(isPollenImageCalibrations([{ mediaOrdinal: 0, micrometresPerPixel: -1 }]), false);
  assert.equal(isPollenImageCalibrations([{ mediaOrdinal: 0, imageView: "invented" }]), false);

  const result = validateApplicationProfileData("clio.profile.pollen-reference-slide", "1.1.0", {
    title: "Synthetic pollen slide",
    recordBasis: "MaterialSample",
    observedOn: "2026-09-15",
    locality: "Generalised test locality",
    observer: "Synthetic observer",
    method: "Light microscopy",
    rightsLicense: "https://creativecommons.org/licenses/by/4.0/",
    uncertaintyNote: "Synthetic data only",
    slideIdentifier: "slide-1",
    taxonomicRank: "species",
    taxonScientificName: "Acacia sp.",
    pollenTaxonName: "Acacia sp.",
    pollenImageCalibrations: value,
  }, "referenceable");
  assert.equal(result.valid, true);
});
