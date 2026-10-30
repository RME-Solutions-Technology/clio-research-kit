/**
 * A small synthetic dataset and the files the library builds from it, shared by
 * the validator scripts. Every value is made up. Nothing here is imported by
 * src/.
 */
import {
  DEFAULT_LICENCE_URI,
  buildDarwinCoreArchive,
  buildResearchPackage,
  recordDocument,
  type DarwinCoreArchive,
  type DarwinCoreArchiveInput,
  type MeasurementRow,
  type RecordFields,
  type ResearchPackage,
  type ResearchPackageInput,
  type ResearchPackageRecord,
} from "../src/index.ts";

const wingLength: MeasurementRow = {
  measurementId: "m1",
  typeIri: "https://example.org/terms/wingLength",
  typeLabel: "Wing length",
  value: { number: 82 },
  unitIri: "http://vocab.nerc.ac.uk/collection/P06/current/UXMM/",
  unitLabel: "millimetres",
};

const event = {
  eventDate: "2026-09-14",
  locality: "Synthetic creek reserve",
  recordedBy: "Test Observer",
  method: "Synthetic visual search",
  countryCode: "AU",
  decimalLatitude: -33.8,
  decimalLongitude: 151.2,
  geodeticDatum: "EPSG:4326",
  coordinateUncertaintyM: 50,
  locationVisibility: "public",
} as const;

function fields(profileId: string, profileVersion: string, data: Record<string, unknown>, title: string): RecordFields {
  return {
    title,
    profile: { profileId, profileVersion, readinessTarget: "referenceable", data },
    event,
    uncertaintyStatement: "None known.",
    authors: [{ ordinal: 0, nameLiteral: "Test Observer" }],
    media: [],
    rights: { licenceUri: DEFAULT_LICENCE_URI },
  };
}

const bird = (scientificName = "Exemplaria synthetica", title = "Synthetic occurrence record"): RecordFields => fields("clio.profile.biological-occurrence", "1.0.0", {
  recordBasis: "HumanObservation",
  taxonomicRank: "species",
  taxonScientificName: scientificName,
  taxonAuthorship: "Tester, 2026",
  taxonKingdom: "Animalia",
  taxonFamily: "Exemplariidae",
  taxonGenus: "Exemplaria",
  taxonSpecificEpithet: "synthetica",
  taxonNomenclaturalCode: "ICZN",
  sex: "female",
  behaviour: "foraging",
  sourceReference: "Synthetic field notebook 1",
}, title);

const creator = { individualName: { givenName: "Test", surName: "Team" }, orcid: "https://orcid.org/0000-0002-1825-0097" } as const;

export function sampleArchiveInput(): DarwinCoreArchiveInput {
  return {
    datasetId: "urn:clio:research-package:sample-0001",
    title: "Synthetic Darwin Core sample dataset",
    description: "Synthetic records used to run the format validators.",
    createdAt: "2026-10-22T01:00:00Z",
    creator,
    contact: { organizationName: "Synthetic Test Lab", email: "contact@example.org" },
    records: [
      { recordId: "rec-a", versionId: "v1", fields: bird(), landingPage: "https://example.org/records/rec-a", measurements: [wingLength] },
      { recordId: "rec-b", versionId: "v1", fields: bird("Exemplaria secunda", "Second synthetic occurrence record"), landingPage: "https://example.org/records/rec-b" },
    ],
    media: [{ recordId: "rec-a", mediaType: "image/jpeg", licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer", accessUri: "https://example.org/media/rec-a.jpg" }],
  };
}

function packageRecord(recordId: string, versionId: string, recordFields: RecordFields, extra: Partial<ResearchPackageRecord> = {}): ResearchPackageRecord {
  return {
    recordId,
    versionId,
    profileId: recordFields.profile.profileId,
    profileVersion: recordFields.profile.profileVersion,
    title: recordFields.title,
    eventDate: recordFields.event.eventDate,
    licence: recordFields.rights.licenceUri,
    canonical: recordDocument({ recordId, versionId, canonicalUri: `https://example.org/records/${recordId}`, recordType: "observation", subjectScopes: ["biology"], fields: recordFields }),
    ...extra,
  };
}

export function samplePackageInput(): ResearchPackageInput {
  return {
    packageId: "pkg-sample-0001",
    title: "Synthetic sample research package",
    createdAt: "2026-10-22T01:00:00Z",
    creator: { name: "Test Team", orcid: "https://orcid.org/0000-0002-1825-0097" },
    schemas: [],
    records: [packageRecord("rec-a", "v1", bird(), { measurements: [wingLength] }), packageRecord("rec-b", "v1", bird("Exemplaria secunda", "Second synthetic occurrence record"))],
    media: [{ recordId: "rec-a", objectKey: "objects/a", mediaType: "image/jpeg", bytes: 10, sha256: "b".repeat(64), licence: DEFAULT_LICENCE_URI, rightsHolder: "Test Observer", accessUri: "https://example.org/media/rec-a.jpg" }],
    includeDarwinCoreArchive: true,
  };
}

export function buildSampleArchive(): DarwinCoreArchive {
  return buildDarwinCoreArchive(sampleArchiveInput());
}

export function buildSamplePackage(): Promise<ResearchPackage> {
  return buildResearchPackage(samplePackageInput());
}
