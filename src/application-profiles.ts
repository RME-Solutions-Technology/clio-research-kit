/**
 * The versioned, client-safe intake vocabulary.
 *
 * This module is deliberately data-first and side-effect free.  A profile is a
 * description of the evidence a collector is invited to record; it is not
 * evidence that a submission has been accepted, or that a standard has been
 * met.
 */

import {
  POLLEN_APERTURE_FEATURES,
  POLLEN_APERTURE_POSITIONS,
  POLLEN_APERTURE_PRESENCE,
  POLLEN_APERTURE_TYPES,
  POLLEN_DISPERSAL_UNITS,
  POLLEN_MATERIAL_STATES,
  POLLEN_MEASUREMENT_METHODS,
  POLLEN_MORPHOLOGY_VOCABULARY,
  POLLEN_MORPHOLOGY_VOCABULARY_VERSION,
  POLLEN_ORNAMENTATION_TERMS,
  POLLEN_POLARITIES,
  POLLEN_SHAPE_CLASSES,
  POLLEN_SYMMETRIES,
  POLLEN_TETRAD_CONFIGURATIONS,
} from "./pollen-vocabulary.ts";
import { isPollenImageCalibrations } from "./pollen-reference.ts";
import { DEFAULT_LICENCE_URI } from "./licensing.ts";
import {
  LANE_AAVSO_FILTERS,
  LANE_AAVSO_MAGNITUDE_TYPES,
  LANE_AAVSO_OBSERVATION_TYPES,
  LANE_ACID_REACTION,
  LANE_AGE_BASIS,
  LANE_AGE_TYPES,
  LANE_BASIS_OF_RECORD,
  LANE_BASIS_OF_RECORD_IRIS,
  LANE_CALIBRATION_METHODS,
  LANE_COLLECTION_AUTHORITY,
  LANE_COLLECTION_DEVICES,
  LANE_DEPTH_DATUMS,
  LANE_ENVO_IRI_PATTERN,
  LANE_ESTABLISHMENT_MEANS,
  LANE_ESTABLISHMENT_MEANS_IRIS,
  LANE_FIREBALL_BRIGHTNESS,
  LANE_FIREBALL_SOUND,
  LANE_GEODETIC_DATUMS,
  LANE_GEODETIC_DATUM_IRIS,
  LANE_GEOLOGIC_AGE_IRIS,
  LANE_GEOLOGIC_AGE_UNITS,
  LANE_GEOLOGY_COLLECTION_METHODS,
  LANE_GEOLOGY_IDENTIFICATION_BASIS,
  LANE_HERITAGE_CHECK,
  LANE_IMA_STATUS,
  LANE_IMAGING_METHODS,
  LANE_INSDC_ACCESSION_PATTERN,
  LANE_INSDC_BIOSAMPLE_PATTERN,
  LANE_LAND_TENURE,
  LANE_LIFE_STAGES,
  LANE_LITHOLOGY_IRIS,
  LANE_LITHOLOGY_TERMS,
  LANE_LOCATION_VISIBILITY,
  LANE_LUSTRE,
  LANE_MAGNETISM,
  LANE_METEORITE_CHECK,
  LANE_METEOR_COUNT_METHODS,
  LANE_METEOR_REPORT_KINDS,
  LANE_MICROSCOPY_SPECIMEN_KINDS,
  LANE_NAME_RESOLUTION,
  LANE_NEGATIVE_CONTROL_TYPES,
  LANE_OBJECTIVE_IMMERSION,
  LANE_OCCURRENCE_STATUS,
  LANE_PHOTO_SCALE,
  LANE_PLATE_SOLVE_STATUS,
  LANE_POLLEN_MOUNTANTS,
  LANE_PRESERVATIVES,
  LANE_READ_LAYOUTS,
  LANE_SAMPLE_CATEGORIES,
  LANE_SAMPLE_OBJECT_TYPES,
  LANE_SAMPLE_TAXA,
  LANE_SAMPLE_TAXON_IRIS,
  LANE_SCALE_EVIDENCE,
  LANE_SEX,
  LANE_SEX_IRIS,
  LANE_SURVEY_PROTOCOLS,
  LANE_TARGET_GENES,
  LANE_TIME_SCALES,
  LANE_TIME_SOURCES,
  LANE_WATER_BODY_TYPES,
  LANE_WILD_STATUS,
} from "./lane-vocabularies.ts";

export const READINESS_LEVELS = [
  "draft",
  "referenceable",
  "research_ready",
  "curator_reviewed",
  "doi_ready",
  "archive_accepted",
] as const;

export type ReadinessLevel = (typeof READINESS_LEVELS)[number];

const READINESS_RANK: Readonly<Record<ReadinessLevel, number>> = {
  draft: 0,
  referenceable: 1,
  research_ready: 2,
  curator_reviewed: 3,
  doi_ready: 4,
  archive_accepted: 5,
};

export type ProfileStatus = "launchable" | "unsupported";
export type ConformanceClaim = "none";
export type FieldSensitivity = "public" | "sensitive" | "restricted";
export type FieldVisibility = FieldSensitivity;

export const FIELD_DATATYPES = [
  "string",
  "string_array",
  "integer",
  "number",
  "number_array",
  "boolean",
  "date",
  "date_or_interval",
  "datetime",
  "uri",
  "identifier",
  "enum",
  "latitude",
  "longitude",
  "json",
] as const;

export type FieldDatatype = (typeof FIELD_DATATYPES)[number];

export type StandardReference = Readonly<{
  name: string;
  version?: string;
  uri?: string;
}>;

export type FieldDefinition = Readonly<{
  key: string;
  label: string;
  datatype: FieldDatatype;
  requiredAt?: ReadinessLevel;
  section: string;
  help: string;
  vocabulary?: readonly string[];
  units?: readonly string[];
  unitRequiredAt?: ReadinessLevel;
  min?: number;
  max?: number;
  sensitivity: FieldSensitivity;
  /** Lane 1.1+: published IRIs for stored vocabulary values, where one exists. */
  vocabularyIris?: Readonly<Record<string, string>>;
  /** Lane 1.1+: the published term this field maps to on export. */
  termIri?: string;
  /** Lane 1.1+: a short, well-formed example shown as a placeholder. */
  example?: string;
  /** Lane 1.1+: a pattern the value must match when the profile enables pattern checks. */
  pattern?: string;
  /** Lane 1.1+: the value lives in the universal event envelope, not in profile data. */
  storedIn?: "event";
}>;

/**
 * A cross-field rule used by lane 1.1 profiles. It applies at and above
 * `from` (default: draft) whenever `when.field` holds one of `when.in`.
 */
export type ProfileConditionalRule = Readonly<{
  when: Readonly<{ field: string; in: readonly (string | boolean)[] }>;
  from?: ReadinessLevel;
  require?: readonly string[];
  requireAny?: readonly string[];
  restrict?: Readonly<{ field: string; in: readonly (string | boolean)[] }>;
  message: string;
}>;

/**
 * Profile-level checks introduced with the lane 1.1 profiles. Profiles
 * without this object (every 1.0.0 profile and pollen reference slide 1.1.0)
 * validate exactly as before. Below `errorFrom` a failed check is a warning,
 * so beginners can save early; at and above it the check blocks.
 */
export type ProfileQualityChecks = Readonly<{
  ruleSet: "clio.lane-checks/1.0.0";
  errorFrom: ReadinessLevel;
  rejectFutureDates?: boolean;
  requireTimeZoneOffset?: boolean;
  enforcePatterns?: boolean;
  coordinatePairs?: readonly (readonly [string, string])[];
  positiveValues?: readonly string[];
  orderedPairs?: readonly (readonly [string, string])[];
  countStatus?: Readonly<{ count: string; status: string; present: string; absent: string }>;
  locationExemption?: Readonly<{ field: string; values: readonly string[]; fields: readonly string[] }>;
  conditional?: readonly ProfileConditionalRule[];
}>;

export type ApplicationProfile = Readonly<{
  id: string;
  version: string;
  title: string;
  description: string;
  status: ProfileStatus;
  launchable: boolean;
  conformanceClaim: ConformanceClaim;
  standardReferences: readonly StandardReference[];
  fields: readonly FieldDefinition[];
  unsupportedReason?: string;
  qualityChecks?: ProfileQualityChecks;
}>;

export type AssertionUncertainty = Readonly<{
  value?: number | string;
  unit?: string;
  kind?: "absolute" | "relative" | "range" | "qualitative";
  note?: string;
}>;

/**
 * A field can carry provenance without forcing every beginner to fill a
 * separate evidence form.  The wrapper is intentionally serialisable so it
 * can be retained verbatim by a later storage layer.
 */
export type FieldAssertion<T = unknown> = Readonly<{
  value: T;
  source?: string;
  uncertainty?: AssertionUncertainty | string | number;
  visibility?: FieldVisibility;
  unit?: string;
  method?: string;
}>;

export function assertField<T>(value: T, metadata: Omit<FieldAssertion<T>, "value"> = {}): FieldAssertion<T> {
  return { value, ...metadata };
}

export type ValidationSeverity = "error" | "warning";

export type ValidationFinding = Readonly<{
  code:
    | "invalid_data"
    | "unknown_profile"
    | "unknown_profile_version"
    | "unsupported_profile"
    | "invalid_readiness"
    | "unknown_field"
    | "required_field"
    | "invalid_datatype"
    | "invalid_enum"
    | "licence_policy_mismatch"
    | "out_of_range"
    | "invalid_unit"
    | "missing_unit"
    | "invalid_assertion"
    | "invalid_visibility"
    | "future_date"
    | "missing_time_zone"
    | "invalid_format"
    | "coordinate_implausible"
    | "incomplete_pair"
    | "not_positive"
    | "inconsistent_values";
  severity: ValidationSeverity;
  field?: string;
  message: string;
  expected?: string;
  actual?: string;
}>;

export type ProfileValidationResult = Readonly<{
  valid: boolean;
  profileId: string;
  profileVersion: string;
  readiness: string;
  findings: readonly ValidationFinding[];
}>;

const STANDARD_DWC: StandardReference = { name: "Darwin Core", version: "2026-05-26" };
const STANDARD_HUMBOLDT: StandardReference = { name: "Humboldt Extension" };
const STANDARD_EML: StandardReference = { name: "Ecological Metadata Language" };
const STANDARD_DWCA: StandardReference = { name: "Darwin Core Archive" };
const STANDARD_REMBI: StandardReference = { name: "REMBI" };
const STANDARD_OME: StandardReference = { name: "OME" };
const STANDARD_ABCD: StandardReference = { name: "ABCD-EFG" };
const STANDARD_FITS: StandardReference = { name: "FITS" };
const STANDARD_WCS: StandardReference = { name: "World Coordinate System (WCS)" };
const STANDARD_IVOA: StandardReference = { name: "IVOA Provenance Data Model" };
const STANDARD_MIXS: StandardReference = { name: "Minimum Information about any (x) Sequence" };
const STANDARD_LATIMER: StandardReference = { name: "Latimer Core" };
const STANDARD_ROCRATE: StandardReference = { name: "RO-Crate", version: "1.3" };

const f = (
  key: string,
  label: string,
  datatype: FieldDatatype,
  section: string,
  help: string,
  options: Partial<Omit<FieldDefinition, "key" | "label" | "datatype" | "section" | "help">> = {},
): FieldDefinition => ({ key, label, datatype, section, help, sensitivity: "public", ...options });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function freezeProfile(profile: ApplicationProfile): ApplicationProfile {
  const fields = Object.freeze(profile.fields.map((field) => Object.freeze({
    ...field,
    ...(field.vocabulary === undefined ? {} : { vocabulary: Object.freeze([...field.vocabulary]) }),
    ...(field.units === undefined ? {} : { units: Object.freeze([...field.units]) }),
    ...(field.vocabularyIris === undefined ? {} : { vocabularyIris: Object.freeze({ ...field.vocabularyIris }) }),
  })));
  const standardReferences = Object.freeze(profile.standardReferences.map((reference) => Object.freeze({ ...reference })));
  return Object.freeze({
    ...profile,
    fields,
    standardReferences,
    ...(profile.qualityChecks === undefined ? {} : { qualityChecks: deepFreeze(structuredClone(profile.qualityChecks)) }),
  });
}

// The rightsLicense labels below are part of immutable 1.0 profile snapshots.
// Current validation nevertheless requires the licence URI passed in
// ProfileValidationOptions (default CC BY 4.0); the legacy wording is not a choice.
const commonFields: readonly FieldDefinition[] = [
  f("title", "Title", "string", "identity", "A short, human-readable title for this observation or object.", { requiredAt: "draft" }),
  f("observedOn", "Date observed", "date_or_interval", "event", "The calendar date or closed date interval on which the observation or collection event occurred.", { requiredAt: "draft" }),
  f("locality", "Locality", "string", "event", "Describe where the event occurred. Use a generalised locality when precision could create risk.", { requiredAt: "draft", sensitivity: "sensitive" }),
  f("observer", "Observer or collector", "string", "provenance", "The person or organisation that made the observation or collection.", { requiredAt: "draft" }),
  f("description", "Description", "string", "observation", "What was seen, measured, or done; keep observations distinct from interpretations."),
  f("method", "Method", "string", "method", "The method, protocol, or field practice used, including meaningful deviations.", { requiredAt: "referenceable" }),
  f("rightsLicense", "Intended licence", "uri", "rights", "A URI for the intended licence or rights statement.", { requiredAt: "referenceable" }),
  f("sourceReference", "Source reference", "string", "provenance", "A book, field notebook, project, instrument log, or other source that supports the record.", { requiredAt: "research_ready" }),
  f("uncertaintyNote", "Uncertainty", "string", "observation", "What is uncertain, inferred, estimated, or still missing; use ‘none known’ rather than leaving it implicit.", { requiredAt: "referenceable" }),
  f("curatorReviewReference", "Curator review reference", "string", "review", "Reference to a review event or decision; this field does not itself confer curator authority or claim that review occurred.", { requiredAt: "curator_reviewed" }),
  f("citationText", "Citation text", "string", "citation", "Citation text prepared for a versioned object or collection.", { requiredAt: "doi_ready" }),
  f("qualityStatement", "Quality statement", "string", "quality", "Checks performed, known omissions, limitations, and remaining uncertainty.", { requiredAt: "doi_ready" }),
  f("archivePackageReference", "Archive package reference", "uri", "preservation", "Reference to a versioned preservation package; presence is not a claim that an archive accepted it.", { requiredAt: "archive_accepted" }),
];

const biologicalFields: readonly FieldDefinition[] = [
  f("recordBasis", "Record basis", "enum", "identity", "What kind of biological evidence is being described.", { requiredAt: "draft", vocabulary: ["HumanObservation", "MachineObservation", "MaterialSample", "PreservedSpecimen"] }),
  f("taxonomicRank", "Taxonomic rank", "enum", "identification", "The lowest taxonomic level supported by the evidence.", { requiredAt: "referenceable", vocabulary: ["kingdom", "phylum", "class", "order", "family", "genus", "species", "subspecies", "variety", "form", "unknown"] }),
  f("taxonKingdom", "Kingdom", "string", "identification", "Kingdom, if known."),
  f("taxonPhylum", "Phylum", "string", "identification", "Phylum, if known."),
  f("taxonClass", "Class", "string", "identification", "Class, if known."),
  f("taxonOrder", "Order", "string", "identification", "Order, if known."),
  f("taxonSuborder", "Suborder", "string", "identification", "Suborder, if used by the chosen taxonomy."),
  f("taxonFamily", "Family", "string", "identification", "Family, if known."),
  f("taxonSubfamily", "Subfamily", "string", "identification", "Subfamily, if known."),
  f("taxonTribe", "Tribe", "string", "identification", "Tribe, if known."),
  f("taxonGenus", "Genus", "string", "identification", "Genus, if known."),
  f("taxonSubgenus", "Subgenus", "string", "identification", "Subgenus, if known."),
  f("taxonSpecificEpithet", "Specific epithet", "string", "identification", "Specific epithet; do not enter a species name here."),
  f("taxonInfraspecificEpithet", "Infraspecific epithet", "string", "identification", "Subspecies, variety, or form epithet, if applicable."),
  f("taxonScientificName", "Scientific name", "string", "identification", "The name currently used for the determination, including an uncertainty marker when needed.", { requiredAt: "referenceable" }),
  f("taxonAuthorship", "Name authorship", "string", "identification", "Scientific-name authorship, when known."),
  f("taxonNameAccordingTo", "Name according to", "string", "identification", "Authority, publication, or checklist supplying the name."),
  f("taxonNomenclaturalCode", "Nomenclatural code", "enum", "identification", "Code used by the name source, when known.", { vocabulary: ["ICN", "ICZN", "ICTV", "ICNP", "other", "unknown"] }),
  f("taxonIdentificationQualifier", "Identification qualifier", "string", "identification", "Qualifier such as cf., aff., or an open nomenclature note."),
  f("taxonomicStatus", "Taxonomic status", "enum", "identification", "Status of the name in the source used.", { vocabulary: ["accepted", "doubtful", "synonym", "undetermined"] }),
  f("taxonBackbone", "Taxonomic backbone", "string", "identification", "The named taxonomy or checklist used to resolve the name.", { requiredAt: "doi_ready" }),
  f("taxonBackboneVersion", "Backbone version", "string", "identification", "Version or retrieval date of the taxonomy used.", { requiredAt: "doi_ready" }),
  f("taxonConceptId", "Taxon concept identifier", "identifier", "identification", "An identifier for the taxon concept, never inferred from a name alone.", { requiredAt: "doi_ready" }),
  f("identificationBasis", "Identification basis", "string", "identification", "Characters, comparison, key, or reference material supporting the identification.", { requiredAt: "research_ready" }),
  f("identificationUncertainty", "Identification uncertainty", "enum", "identification", "How strongly the evidence supports the determination.", { requiredAt: "research_ready", vocabulary: ["certain", "probable", "possible", "family_only", "genus_only", "unknown"] }),
];

const STANDARD_CLIO_POLLEN: StandardReference = {
  name: POLLEN_MORPHOLOGY_VOCABULARY.title,
  version: POLLEN_MORPHOLOGY_VOCABULARY_VERSION,
};

/**
 * Optional controlled terms introduced in profile 1.1.0. The original
 * free-text morphology fields remain available, so contributors can submit a
 * useful observation before they know (or can agree) on a controlled term.
 */
const pollenControlledFields: readonly FieldDefinition[] = [
  f("pollenDispersalUnit", "Pollen dispersal unit", "enum", "morphology", "Monad, dyad, tetrad, polyad, massula, or pollinium when the unit is observed; use the free-text field for an unmapped term.", { vocabulary: POLLEN_DISPERSAL_UNITS }),
  f("pollenTetradConfiguration", "Tetrad configuration", "enum", "morphology", "Configuration of a tetrad when applicable.", { vocabulary: POLLEN_TETRAD_CONFIGURATIONS }),
  f("pollenPolarity", "Pollen polarity", "enum", "morphology", "Polarity of the grain using the candidate Clio vocabulary.", { vocabulary: POLLEN_POLARITIES }),
  f("pollenSymmetry", "Pollen symmetry", "enum", "morphology", "Symmetry of the grain using the candidate Clio vocabulary.", { vocabulary: POLLEN_SYMMETRIES }),
  f("pollenShapeClass", "Pollen shape class", "enum", "morphology", "P/E-ratio shape class, or ‘other’ when the supplied observation does not map to these classes. Retain the raw axes and any verbatim term.", { vocabulary: [...POLLEN_SHAPE_CLASSES] }),
  f("pollenAperturePresence", "Aperture presence", "enum", "morphology", "Whether an aperture was observed. Inaperturate is distinct from an unrecorded observation.", { vocabulary: POLLEN_APERTURE_PRESENCE }),
  f("pollenApertureTypes", "Controlled aperture types", "string_array", "morphology", "One or more controlled aperture terms; retain apertureType for a verbatim or unmapped description.", { vocabulary: POLLEN_APERTURE_TYPES }),
  f("pollenAperturePosition", "Aperture position", "enum", "morphology", "Position of the aperture(s), when observed.", { vocabulary: POLLEN_APERTURE_POSITIONS }),
  f("pollenApertureFeatures", "Aperture features", "string_array", "morphology", "Observed aperture features, such as an annulus, margo, costa, operculum, or aperture membrane.", { vocabulary: POLLEN_APERTURE_FEATURES }),
  f("pollenOrnamentation", "Controlled ornamentation", "string_array", "morphology", "One or more controlled surface-ornamentation terms; retain sculpture for a verbatim description and method context.", { vocabulary: POLLEN_ORNAMENTATION_TERMS }),
  f("pollenObservationMethod", "Pollen observation method", "enum", "method", "Microscopy or observation method associated with the controlled pollen traits.", { vocabulary: POLLEN_MEASUREMENT_METHODS }),
  f("pollenMaterialState", "Material state", "enum", "method", "Hydration or preparation state relevant to apparent size and shape.", { vocabulary: POLLEN_MATERIAL_STATES }),
  f("pollenMorphologyRemarks", "Morphology remarks", "string", "morphology", "Retain useful specialist wording, limitations, and terms that are not yet represented by the candidate vocabulary."),
];

/**
 * Optional reference-collection exchange fields. These are informed by the
 * Global Pollen Project digitisation guide, but are a candidate mapping:
 * there is no agreed GPP submission API or conformance claim.
 */
const pollenReferenceExchangeFields: readonly FieldDefinition[] = [
  f("pollenReferenceCollectionName", "Reference collection name", "string", "provenance", "Name of the source pollen reference collection, when the slide belongs to one."),
  f("pollenReferenceCollectionCurator", "Reference collection curator", "string", "credits", "Person or organisation responsible for curating the source reference collection."),
  f("pollenReferenceCollectionAccessUri", "Reference collection access URI", "uri", "exchange", "Stable HTTPS page or endpoint through which the source reference collection can be accessed."),
  f("pollenIdentificationType", "Identification type", "enum", "identification", "How the reference identity is supported. Preserve details and uncertainty in the identification fields.", { vocabulary: ["direct", "morphological", "environmental", "not_recorded"] }),
  f("originalTaxonVerbatim", "Original taxon wording", "string", "identification", "Taxon wording exactly as it appeared in the source collection before any current-name mapping."),
  f("originalTaxonFamily", "Original family", "string", "identification", "Family recorded by the source collection, retained separately from the current determination."),
  f("originalTaxonGenus", "Original genus", "string", "identification", "Genus recorded by the source collection, retained separately from the current determination."),
  f("originalTaxonSpecificEpithet", "Original specific epithet", "string", "identification", "Specific epithet recorded by the source collection."),
  f("originalTaxonAuthorship", "Original name authorship", "string", "identification", "Scientific-name authorship recorded by the source collection."),
  f("voucherInstitutionCode", "Voucher institution code", "string", "provenance", "Herbarium or other voucher institution code, when the pollen is linked to a preserved voucher."),
  f("voucherIdentifier", "Voucher identifier", "identifier", "provenance", "Catalogue or accession identifier for the linked voucher."),
  f("livingCollectionInstitutionCode", "Living collection code", "string", "provenance", "Botanic-garden or living-collection institution code, when applicable."),
  f("livingPlantIdentifier", "Living plant identifier", "identifier", "provenance", "Accession or plant identifier in the living collection."),
  f("fieldIdentificationReference", "Field identification reference", "string", "provenance", "Field number, collector reference, notebook entry, or other direct-identification evidence."),
  f("pollenCollectedBy", "Pollen collected by", "string", "credits", "Person or organisation credited with collecting the source material."),
  f("pollenCollectionYear", "Pollen collection year", "integer", "credits", "Year the source material was collected, when only a year is known.", { min: 1, max: 9999 }),
  f("pollenPreparedBy", "Slide prepared by", "string", "credits", "Person or organisation credited with preparing the slide."),
  f("pollenPreparationYear", "Slide preparation year", "integer", "preparation", "Year the slide was prepared, when known.", { min: 1, max: 9999 }),
  f("pollenPreparationTreatment", "Most destructive treatment", "enum", "preparation", "Most destructive preparation treatment known to have been applied; describe variants in preparation method.", { vocabulary: ["fresh", "acetolysis", "hydrofluoric_acid", "other", "not_recorded"] }),
  f("pollenDigitisedBy", "Digitised by", "string", "credits", "Person or organisation credited with producing the digital representations."),
  f("pollenDigitisationYear", "Digitisation year", "integer", "imaging", "Year the slide was digitised, when known.", { min: 1, max: 9999 }),
  f("pollenCuratedBy", "Reference curated by", "string", "credits", "Person or organisation responsible for the reference-collection curation statement; this does not itself record a Clio review decision."),
  f("pollenMicroscopeConfiguration", "Microscope configuration", "string", "imaging", "Microscope, camera, objective, ocular and acquisition configuration relevant to interpreting the images."),
  f("pollenImageCalibrations", "Per-image calibration and focus stack", "json", "imaging", "JSON array keyed by mediaObjectId or mediaOrdinal. Each item may record micrometresPerPixel, calibration distances, calibrationReference, focusStackFrameCount, focusStepMicrometres and imageView."),
  f("pollenSingleGrain", "Single-grain record", "boolean", "sample", "Whether the record and linked imagery describe one specifically tracked pollen grain."),
  f("pollenSampleAgeType", "Sample age type", "enum", "sample", "Kind of age statement supplied for the material; preserve the original statement in sample age wording.", { vocabulary: ["collection_date", "calendar_year", "radiocarbon_age", "years_before_present", "geological_age", "not_recorded"] }),
  f("pollenSampleAgeVerbatim", "Sample age wording", "string", "sample", "Age, date, uncertainty, calibration and reference exactly as supplied; do not infer a numeric age from this field."),
  f("externalPollenCollectionIdentifier", "External pollen collection identifier", "identifier", "exchange", "Identifier assigned by GPP or another reference-collection system; name the system in the assertion source."),
  f("externalPollenSlideIdentifier", "External pollen slide identifier", "identifier", "exchange", "Slide identifier assigned by GPP or another exchange partner; name the system in the assertion source."),
];

const PROFILES: readonly ApplicationProfile[] = Object.freeze(([
  {
    id: "clio.profile.general-observation", version: "1.0.0", title: "General observation",
    description: "A flexible starting point for a carefully documented observation when no more specific profile is appropriate.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC], fields: commonFields,
  },
  {
    id: "clio.profile.biological-occurrence", version: "1.0.0", title: "Biological occurrence",
    description: "An observation of a living or once-living organism with a taxonomic identification that can remain uncertain.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC], fields: [...commonFields, ...biologicalFields,
      f("lifeStage", "Life stage", "string", "organism", "Life stage or developmental state, when observed."),
      f("sex", "Sex", "enum", "organism", "Sex only when observed or reliably established.", { vocabulary: ["female", "male", "hermaphrodite", "not_recorded", "not_applicable"] }),
      f("behaviour", "Behaviour", "string", "observation", "Behaviour directly observed, not inferred."),
      f("associatedOrganisms", "Associated organisms", "string", "ecology", "Other organisms observed in meaningful association."),
    ],
  },
  {
    id: "clio.profile.structured-survey", version: "1.0.0", title: "Structured survey",
    description: "A repeated or designed sampling event where effort, unit, and protocol are as important as the finding.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_HUMBOLDT, STANDARD_EML], fields: [...commonFields, ...biologicalFields,
      f("surveyProtocol", "Survey protocol", "string", "sampling", "Name or describe the protocol used, including its version if one exists.", { requiredAt: "referenceable" }),
      f("samplingDesign", "Sampling design", "string", "sampling", "How sites, times, transects, quadrats, or other units were selected.", { requiredAt: "research_ready" }),
      f("samplingUnit", "Sampling unit", "string", "sampling", "The unit represented by one record, such as a quadrat, trap, transect, or point count.", { requiredAt: "referenceable" }),
      f("samplingEffort", "Sampling effort", "number", "sampling", "Numeric effort, with its unit recorded in the value wrapper when applicable.", { requiredAt: "research_ready", units: ["minute", "hour", "metre", "square_metre", "trap_day", "person_hour"], unitRequiredAt: "research_ready", min: 0 }),
      f("eventDuration", "Event duration", "number", "sampling", "Duration of the sampling event.", { units: ["second", "minute", "hour"], unitRequiredAt: "research_ready", min: 0 }),
      f("samplingArea", "Sampling area", "number", "sampling", "Area covered by the sampling unit.", { units: ["square_metre", "hectare"], unitRequiredAt: "research_ready", min: 0 }),
      f("eventCount", "Individuals or events counted", "integer", "observation", "Count recorded by the protocol.", { min: 0 }),
      f("environment", "Environment", "string", "event", "Habitat, weather, substrate, or other environmental context relevant to interpretation."),
    ],
  },
  {
    id: "clio.profile.material-sample", version: "1.0.0", title: "Material sample",
    description: "A biological or environmental material entity retained, subsampled, or prepared for later examination.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_ABCD], fields: [...commonFields,
      f("materialEntityId", "Material entity identifier", "identifier", "material", "A stable local identifier for the material entity or sample.", { requiredAt: "referenceable" }),
      f("materialType", "Material type", "string", "material", "What was sampled or retained.", { requiredAt: "draft" }),
      f("collectionMethod", "Collection method", "string", "collection", "How the material was obtained, including non-destructive methods.", { requiredAt: "referenceable" }),
      f("collector", "Collector", "string", "provenance", "Person or organisation that collected the material.", { requiredAt: "referenceable" }),
      f("preservationMethod", "Preservation method", "string", "curation", "How the material was preserved and any relevant concentration or fixative details.", { requiredAt: "research_ready" }),
      f("preparationMethod", "Preparation method", "string", "curation", "Preparation performed before examination.", { requiredAt: "research_ready" }),
      f("storageCondition", "Storage condition", "string", "curation", "Storage condition or range, without exposing a private storage address."),
      f("permitReference", "Permit reference", "string", "collection", "Permit or authority reference where collection required one; do not treat this field as legal advice."),
      f("materialQuantity", "Material quantity", "number", "material", "Amount retained or examined.", { units: ["milligram", "gram", "millilitre", "count"], unitRequiredAt: "research_ready", min: 0 }),
    ],
  },
  {
    id: "clio.profile.pollen-reference-slide", version: "1.0.0", title: "Pollen reference slide",
    description: "A prepared modern pollen reference slide with enough provenance and morphology to support comparison.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_REMBI, STANDARD_OME], fields: [...commonFields, ...biologicalFields,
      f("slideIdentifier", "Slide identifier", "identifier", "material", "Identifier for the prepared slide or reference mount.", { requiredAt: "referenceable" }),
      f("pollenTaxonName", "Pollen taxon", "string", "identification", "Taxon associated with the reference pollen; a determination may remain above species level.", { requiredAt: "referenceable" }),
      f("pollenOrigin", "Pollen origin", "string", "provenance", "Origin of the pollen material and how it was obtained.", { requiredAt: "research_ready" }),
      f("preparationMethod", "Preparation method", "string", "preparation", "Chemical and physical preparation method, with safety context kept in the lab record.", { requiredAt: "research_ready" }),
      f("mountant", "Mountant", "string", "preparation", "Mounting medium used on the slide.", { requiredAt: "research_ready" }),
      f("stain", "Stain", "string", "preparation", "Stain or optical treatment, if any."),
      f("polarView", "Polar view", "enum", "morphology", "View in which the grain was measured.", { requiredAt: "research_ready", vocabulary: ["polar", "equatorial", "both", "not_recorded"] }),
      f("grainShape", "Grain shape", "string", "morphology", "Observed grain shape using a stated vocabulary or reference.", { requiredAt: "research_ready" }),
      f("apertureType", "Aperture type", "string", "morphology", "Aperture type, such as colpus, pore, or colporus.", { requiredAt: "research_ready" }),
      f("apertureCount", "Aperture count", "integer", "morphology", "Number of apertures observed.", { requiredAt: "research_ready", min: 0 }),
      f("sculpture", "Surface sculpture", "string", "morphology", "Observed exine sculpture or ornamentation.", { requiredAt: "research_ready" }),
      f("polarAxis", "Polar axis", "number", "measurements", "Polar axis measurement.", { units: ["micrometre"], unitRequiredAt: "research_ready", requiredAt: "research_ready", min: 0 }),
      f("equatorialDiameter", "Equatorial diameter", "number", "measurements", "Equatorial diameter measurement.", { units: ["micrometre"], unitRequiredAt: "research_ready", requiredAt: "research_ready", min: 0 }),
      f("grainCount", "Grains measured", "integer", "measurements", "Number of grains measured for the summary.", { requiredAt: "research_ready", min: 1 }),
      f("microscopeMagnification", "Microscope magnification", "number", "imaging", "Effective magnification used for the observation.", { units: ["times"], unitRequiredAt: "research_ready", requiredAt: "research_ready", min: 1 }),
    ],
  },
  {
    id: "clio.profile.pollen-field-aerobiological-palaeo-sample", version: "1.0.0", title: "Pollen field, aerobiological, or palaeo sample",
    description: "A pollen sample tied to a place, collection event, trap, sediment context, or depth rather than only a reference slide.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_EML], fields: [...commonFields,
      f("sampleType", "Sample type", "enum", "material", "Context in which the pollen sample was collected.", { requiredAt: "draft", vocabulary: ["field", "aerobiological", "surface", "sediment", "palaeo", "ice", "honey", "other"] }),
      f("sampleIdentifier", "Sample identifier", "identifier", "material", "Stable identifier for the sample or subsample.", { requiredAt: "referenceable" }),
      f("sampleCollectedOn", "Sample collection date", "date", "event", "Date the sample was collected or the trap interval began.", { requiredAt: "referenceable" }),
      f("collectionMethod", "Collection method", "string", "collection", "Trap, coring, surface sampling, filter, or other method.", { requiredAt: "referenceable" }),
      f("depositionalContext", "Depositional context", "string", "context", "Sediment, surface, trap, or other context that affects interpretation.", { requiredAt: "research_ready" }),
      f("sampleDepth", "Sample depth", "number", "context", "Depth below a stated surface or datum.", { units: ["millimetre", "centimetre", "metre"], unitRequiredAt: "research_ready", min: 0, sensitivity: "sensitive" }),
      f("processingMethod", "Processing method", "string", "preparation", "Laboratory processing, concentration, sieving, acetolysis, or other treatment.", { requiredAt: "research_ready" }),
      f("countingProtocol", "Counting protocol", "string", "analysis", "How grains were counted, subsampled, or excluded.", { requiredAt: "research_ready" }),
      f("pollenConcentration", "Pollen concentration", "number", "analysis", "Concentration estimate with its denominator and unit.", { units: ["grains_per_gram", "grains_per_cubic_centimetre", "grains_per_cubic_metre"], unitRequiredAt: "research_ready", min: 0 }),
      f("ageModel", "Age model", "string", "context", "Age model, dating method, or age estimate for palaeo material; state uncertainty."),
      f("subsampleRelationship", "Subsample relationship", "string", "provenance", "How this sample relates to a parent core, trap interval, or bulk sample."),
    ],
  },
  {
    id: "clio.profile.microscopy-image", version: "1.0.0", title: "Microscopy image",
    description: "A micrograph with specimen, preparation, optical configuration, scale, and image provenance.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_REMBI, STANDARD_OME], fields: [...commonFields,
      f("specimenIdentifier", "Specimen or sample identifier", "identifier", "material", "Identifier linking the image to the specimen or sample observed.", { requiredAt: "referenceable" }),
      f("microscopeManufacturer", "Microscope manufacturer", "string", "acquisition", "Manufacturer of the microscope or imaging system.", { requiredAt: "research_ready" }),
      f("microscopeModel", "Microscope model", "string", "acquisition", "Model and configuration of the microscope.", { requiredAt: "research_ready" }),
      f("objectiveMagnification", "Objective magnification", "number", "acquisition", "Objective magnification used for acquisition.", { requiredAt: "research_ready", units: ["times"], unitRequiredAt: "research_ready", min: 1 }),
      f("illumination", "Illumination", "string", "acquisition", "Illumination source and relevant settings.", { requiredAt: "research_ready" }),
      f("contrastMethod", "Contrast method", "string", "acquisition", "Brightfield, phase, DIC, fluorescence, or other contrast method.", { requiredAt: "research_ready" }),
      f("pixelSize", "Pixel size", "number", "calibration", "Physical size represented by one pixel.", { requiredAt: "research_ready", units: ["nanometre", "micrometre"], unitRequiredAt: "research_ready", min: 0 }),
      f("zStep", "Z step", "number", "calibration", "Z spacing for a stack, if applicable.", { units: ["nanometre", "micrometre"], unitRequiredAt: "research_ready", min: 0 }),
      f("imagePlane", "Image plane", "enum", "acquisition", "Whether the image is a single plane, stack, projection, or montage.", { vocabulary: ["single_plane", "stack", "maximum_projection", "orthogonal_projection", "montage", "unknown"] }),
      f("calibrationTarget", "Calibration target", "string", "calibration", "Scale bar, stage micrometer, or other calibration reference."),
      f("stain", "Stain or label", "string", "preparation", "Stain, fluorophore, label, or no stain."),
    ],
  },
  {
    id: "clio.profile.geological-sample", version: "1.0.0", title: "Geological sample",
    description: "A rock, mineral, sediment, or other geological material sample with field and analytical context.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_ABCD], fields: [...commonFields,
      f("materialEntityId", "Material entity identifier", "identifier", "material", "Stable identifier for the geological material entity.", { requiredAt: "referenceable" }),
      f("geologicMaterialType", "Material type", "enum", "material", "Broad material type.", { requiredAt: "draft", vocabulary: ["mineral", "rock", "sediment", "soil", "fossil", "fluid", "other"] }),
      f("lithology", "Lithology", "string", "geology", "Observed or interpreted lithology, with the distinction stated."),
      f("mineralComposition", "Mineral composition", "string", "geology", "Observed or measured mineral composition."),
      f("formation", "Formation or unit", "string", "geology", "Geological formation, member, or mapped unit."),
      f("geologicAge", "Geological age", "string", "geology", "Age or age range and the basis for it."),
      f("stratigraphicContext", "Stratigraphic context", "string", "context", "Stratigraphic position, bed, horizon, or section."),
      f("collectionSite", "Collection site", "string", "event", "Site context, separate from a precise public locality when sensitive.", { sensitivity: "sensitive" }),
      f("specimenMass", "Specimen mass", "number", "material", "Mass of the retained specimen.", { units: ["gram", "kilogram"], unitRequiredAt: "research_ready", min: 0 }),
      f("hardness", "Hardness", "number", "identification", "Hardness measurement or scale, with method stated.", { units: ["mohs"], unitRequiredAt: "research_ready", min: 0 }),
      f("cleavage", "Cleavage", "string", "identification", "Observed cleavage planes and quality."),
      f("streak", "Streak", "string", "identification", "Observed streak, where a safe test was appropriate."),
    ],
  },
  {
    id: "clio.profile.astronomy-image", version: "1.0.0", title: "Astronomy image",
    description: "An astronomical image with target, time, location, equipment, exposure, and processing provenance.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_FITS, STANDARD_WCS, STANDARD_IVOA], fields: [...commonFields,
      f("targetName", "Target name", "string", "target", "Target name or observer-supplied label; include ambiguity when relevant.", { requiredAt: "draft" }),
      f("targetType", "Target type", "string", "target", "Star, planet, nebula, galaxy, transient, landscape, or other target."),
      f("observationStart", "Observation start", "datetime", "event", "Start time of the exposure or observing interval, in an explicit time scale.", { requiredAt: "referenceable", sensitivity: "sensitive" }),
      f("observationEnd", "Observation end", "datetime", "event", "End time of the exposure or observing interval.", { requiredAt: "referenceable", sensitivity: "sensitive" }),
      f("observatoryName", "Observatory or site", "string", "instrument", "Observatory, site, or generalised observing location."),
      f("observatoryLatitude", "Observatory latitude", "latitude", "instrument", "Latitude of the observing site; restrict precision where needed.", { sensitivity: "sensitive" }),
      f("observatoryLongitude", "Observatory longitude", "longitude", "instrument", "Longitude of the observing site; restrict precision where needed.", { sensitivity: "sensitive" }),
      f("instrumentName", "Instrument", "string", "instrument", "Telescope, camera, or instrument name.", { requiredAt: "referenceable" }),
      f("filterBand", "Filter or band", "string", "acquisition", "Filter, bandpass, or no filter."),
      f("exposureSeconds", "Exposure duration", "number", "acquisition", "Exposure duration.", { requiredAt: "referenceable", units: ["second"], unitRequiredAt: "referenceable", min: 0 }),
      f("rightAscension", "Right ascension", "number", "coordinates", "Right ascension in the stated coordinate frame and unit.", { units: ["degree", "hour"], unitRequiredAt: "research_ready", min: 0, max: 360 }),
      f("declination", "Declination", "number", "coordinates", "Declination in the stated coordinate frame and unit.", { units: ["degree"], unitRequiredAt: "research_ready", min: -90, max: 90 }),
      f("coordinateFrame", "Coordinate frame", "string", "coordinates", "ICRS, apparent, alt-az, or other coordinate frame."),
      f("calibrationStatus", "Calibration status", "enum", "processing", "State of calibration; do not describe an image as calibrated without evidence.", { requiredAt: "research_ready", vocabulary: ["not_calibrated", "partially_calibrated", "calibrated", "unknown"] }),
      f("dataProductType", "Data product type", "enum", "processing", "Raw, calibrated, stacked, or derivative product.", { vocabulary: ["raw", "calibrated", "stacked", "composite", "annotated", "unknown"] }),
      f("fitsHeaderAvailable", "FITS header available", "boolean", "provenance", "Whether the original FITS header or an equivalent header record is retained."),
      f("processingSoftware", "Processing software", "string", "processing", "Software and meaningful processing steps."),
    ],
  },
  {
    id: "clio.profile.calibrated-astronomy-observation", version: "1.0.0", title: "Calibrated astronomy observation",
    description: "An astronomy observation intended for reproducible measurement, with explicit calibration, coordinate, time, and uncertainty evidence.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_FITS, STANDARD_WCS, STANDARD_IVOA], fields: [
      ...commonFields,
      f("targetName", "Target name", "string", "target", "Target name or catalogue identifier.", { requiredAt: "draft" }),
      f("observationStart", "Observation start", "datetime", "event", "Start instant in an explicit time scale.", { requiredAt: "referenceable", sensitivity: "sensitive" }),
      f("observationEnd", "Observation end", "datetime", "event", "End instant in an explicit time scale.", { requiredAt: "referenceable", sensitivity: "sensitive" }),
      f("timeScale", "Time scale", "enum", "event", "UTC, TAI, TT, or another stated time scale.", { requiredAt: "research_ready", vocabulary: ["UTC", "TAI", "TT", "TDB", "local", "unknown"] }),
      f("instrumentName", "Instrument", "string", "instrument", "Telescope, camera, detector, or instrument configuration.", { requiredAt: "referenceable" }),
      f("observatoryName", "Observatory or site", "string", "instrument", "Observatory or observing site.", { requiredAt: "referenceable" }),
      f("rightAscension", "Right ascension", "number", "coordinates", "Right ascension in the stated frame and unit.", { requiredAt: "research_ready", units: ["degree", "hour"], unitRequiredAt: "research_ready", min: 0, max: 360 }),
      f("declination", "Declination", "number", "coordinates", "Declination in the stated frame and unit.", { requiredAt: "research_ready", units: ["degree"], unitRequiredAt: "research_ready", min: -90, max: 90 }),
      f("coordinateFrame", "Coordinate frame", "string", "coordinates", "Coordinate reference frame and equinox when applicable.", { requiredAt: "research_ready" }),
      f("wcsSolution", "WCS solution", "string", "calibration", "Reference to the retained WCS solution or header; not a claim that it is correct.", { requiredAt: "research_ready" }),
      f("astrometricCalibration", "Astrometric calibration", "string", "calibration", "Reference catalogue, fit method, residuals, and calibration date.", { requiredAt: "research_ready" }),
      f("photometricCalibration", "Photometric calibration", "string", "calibration", "Standards, zero point, bandpass, and calibration method."),
      f("calibrationReference", "Calibration reference", "string", "calibration", "Reference data or standard used for calibration.", { requiredAt: "research_ready" }),
      f("exposureSeconds", "Exposure duration", "number", "acquisition", "Exposure duration.", { requiredAt: "referenceable", units: ["second"], unitRequiredAt: "referenceable", min: 0 }),
      f("uncertaintyModel", "Uncertainty model", "string", "analysis", "How positional, photometric, or other uncertainties were calculated.", { requiredAt: "research_ready" }),
      f("coordinateUncertainty", "Coordinate uncertainty", "number", "analysis", "Uncertainty of the reported coordinate.", { units: ["arcsecond", "arcminute", "degree"], unitRequiredAt: "research_ready", min: 0 }),
      f("processingSoftware", "Processing software", "string", "processing", "Software, versions, and processing steps.", { requiredAt: "research_ready" }),
      f("processingVersion", "Processing version", "string", "processing", "Version or immutable build reference for processing.", { requiredAt: "research_ready" }),
    ],
  },
  {
    id: "clio.profile.collection-description", version: "1.0.0", title: "Collection description",
    description: "Context for a group of observations or objects, preserving scope, selection, coverage, and version history.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_LATIMER, STANDARD_EML, STANDARD_DWCA, STANDARD_ROCRATE], fields: [
      f("title", "Collection title", "string", "identity", "A clear title for the collection.", { requiredAt: "draft" }),
      f("description", "Collection description", "string", "identity", "Purpose, scope, and limits of the collection.", { requiredAt: "draft" }),
      f("creator", "Collection creator", "string", "provenance", "Person or organisation responsible for assembling the collection.", { requiredAt: "draft" }),
      f("collectionScope", "Collection scope", "string", "scope", "Taxonomic, geographic, temporal, or thematic scope.", { requiredAt: "referenceable" }),
      f("coverage", "Coverage", "string", "scope", "Spatial and temporal coverage, including exclusions.", { requiredAt: "research_ready" }),
      f("dateRangeStart", "Coverage start", "date", "scope", "Beginning of the collection's coverage."),
      f("dateRangeEnd", "Coverage end", "date", "scope", "End of the collection's coverage."),
      f("itemCount", "Item count", "integer", "contents", "Number of included items at the stated collection version.", { requiredAt: "research_ready", min: 0 }),
      f("selectionMethod", "Selection method", "string", "contents", "How items were included, excluded, or deduplicated.", { requiredAt: "research_ready" }),
      f("versionStatement", "Version statement", "string", "provenance", "What changed in this collection version.", { requiredAt: "referenceable" }),
      f("rightsLicense", "Intended licence", "uri", "rights", "A URI for the collection's intended licence or rights statement.", { requiredAt: "referenceable" }),
      f("citation", "Suggested citation", "string", "rights", "Human-readable citation guidance."),
      f("persistentIdentifier", "Persistent identifier", "identifier", "identity", "An existing persistent identifier, if one has been assigned; do not invent one.", { requiredAt: "doi_ready" }),
      f("manifestReference", "Manifest reference", "uri", "contents", "Reference to a versioned manifest or package inventory.", { requiredAt: "doi_ready" }),
      f("qualityStatement", "Quality statement", "string", "quality", "Known omissions, checks, and limitations of the collection.", { requiredAt: "doi_ready" }),
    ],
  },
  {
    id: "clio.profile.sequence-sample", version: "1.0.0", title: "Sequence sample",
    description: "A biological material or sequence result with sample identity, laboratory method, platform, and quality context.",
    status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_MIXS], fields: [...commonFields,
      f("materialEntityId", "Material entity identifier", "identifier", "material", "Identifier for the source material or biosample.", { requiredAt: "referenceable" }),
      f("sequenceIdentifier", "Sequence identifier", "identifier", "sequence", "Identifier for the sequence or sequence set, if already assigned.", { requiredAt: "referenceable" }),
      f("sequenceType", "Sequence type", "enum", "sequence", "Type of sequence data.", { requiredAt: "draft", vocabulary: ["amplicon", "metabarcoding", "shotgun", "transcriptome", "genome", "barcode", "other"] }),
      f("moleculeType", "Molecule type", "enum", "sequence", "DNA, RNA, or another molecule type.", { requiredAt: "research_ready", vocabulary: ["DNA", "RNA", "cDNA", "other", "unknown"] }),
      f("bioSampleId", "Biosample identifier", "identifier", "material", "Identifier linking the sequence to the biological sample."),
      f("libraryPreparation", "Library preparation", "string", "laboratory", "Library preparation or amplification method.", { requiredAt: "research_ready" }),
      f("platform", "Sequencing platform", "string", "laboratory", "Sequencing instrument or platform.", { requiredAt: "research_ready" }),
      f("readLayout", "Read layout", "enum", "sequence", "Single-end, paired-end, or another layout.", { vocabulary: ["single_end", "paired_end", "long_read", "unknown"] }),
      f("referenceDatabase", "Reference database", "string", "analysis", "Database and version used for comparison or annotation."),
      f("sequenceQuality", "Sequence quality", "string", "quality", "Quality summary, thresholds, and retained quality files.", { requiredAt: "research_ready" }),
      f("contaminationScreen", "Contamination screen", "string", "quality", "Contamination checks and outcomes, including what was not checked."),
      f("analysisWorkflow", "Analysis workflow", "string", "analysis", "Workflow, software versions, and parameters used.", { requiredAt: "research_ready" }),
    ],
  },
] as readonly ApplicationProfile[]).map(freezeProfile));

const POLLEN_REFERENCE_SLIDE_PROFILE_ID = "clio.profile.pollen-reference-slide";
const pollenReferenceSlideProfileV1 = PROFILES.find((profile) => profile.id === POLLEN_REFERENCE_SLIDE_PROFILE_ID);
if (!pollenReferenceSlideProfileV1) throw new Error("The historical pollen reference-slide profile is missing from the registry.");

/**
 * The 1.0 profile is retained as an immutable historical contract. New
 * records resolve to 1.1, which adds optional controlled terms without
 * invalidating older submissions or forcing a vocabulary on low-information
 * observations.
 */
const pollenReferenceSlideProfileV1_1 = freezeProfile({
  ...pollenReferenceSlideProfileV1,
  version: "1.1.0",
  description: "A prepared modern pollen reference slide with provenance and morphology fields, including optional Clio candidate controlled terms.",
  standardReferences: [...pollenReferenceSlideProfileV1.standardReferences, STANDARD_CLIO_POLLEN],
  fields: [...pollenReferenceSlideProfileV1.fields, ...pollenControlledFields, ...pollenReferenceExchangeFields],
});

// ---------------------------------------------------------------------------
// Lane profiles 1.1 (and two new astronomy profiles at 1.0.0).
//
// Each lane version is a new immutable definition. Earlier versions stay in
// the registry for exact historical validation and are never edited. The
// fields below use second-person help, keep "unknown"-style answers where the
// lane brief allows them, and place requirements so a beginner can save a
// draft early and is guided upward.
// ---------------------------------------------------------------------------

const DWC = "http://rs.tdwg.org/dwc/terms/";
const STANDARD_AAVSO: StandardReference = { name: "AAVSO Extended File Format" };
const STANDARD_IMO: StandardReference = { name: "IMO visual meteor report" };
const STANDARD_AMS: StandardReference = { name: "IMO/AMS fireball report" };
const STANDARD_ENVO: StandardReference = { name: "Environment Ontology (ENVO)" };
const STANDARD_CGI: StandardReference = { name: "CGI Simple Lithology", version: "2016.01" };
const STANDARD_ICS: StandardReference = { name: "International Chronostratigraphic Chart" };
const STANDARD_IGSN: StandardReference = { name: "IGSN / DataCite physical sample metadata" };
const STANDARD_NEOTOMA: StandardReference = { name: "Neotoma data model" };

const commonFieldsV1_1: readonly FieldDefinition[] = [
  f("title", "Title", "string", "identity", "Give this record a short name, such as what you saw and where.", { requiredAt: "draft", termIri: "http://purl.org/dc/terms/title" }),
  f("observedOn", "Date", "date_or_interval", "event", "The day you saw or collected it (YYYY-MM-DD). If you're not sure of the day, give a range such as 2026-10-01/2026-10-03.", { requiredAt: "draft", example: "2026-10-22", termIri: `${DWC}eventDate` }),
  f("locality", "Place", "string", "event", "Describe the place in words. Keep it general if the exact spot could put a species, site or person at risk.", { requiredAt: "draft", sensitivity: "sensitive", termIri: `${DWC}locality` }),
  f("observer", "Observer or collector", "string", "provenance", "Who saw or collected it. This can be you.", { requiredAt: "draft", termIri: `${DWC}recordedBy` }),
  f("description", "What you saw or did", "string", "observation", "Describe what you observed. Keep what you saw separate from what you think it means."),
  f("method", "How you recorded it", "string", "method", "How you observed, collected or captured it, and anything you did differently from usual.", { requiredAt: "referenceable" }),
  f("rightsLicense", "Licence", "uri", "rights", "Records use CC BY 4.0 unless the package says otherwise. Use the licence URI.", { requiredAt: "referenceable", termIri: "http://purl.org/dc/terms/license" }),
  f("sourceReference", "Source", "string", "provenance", "Where the evidence comes from: your field notebook, a project, an instrument log or a publication.", { requiredAt: "research_ready" }),
  f("uncertaintyNote", "What's uncertain", "string", "observation", "Say what is uncertain, estimated or missing. Write 'none known' if nothing is.", { requiredAt: "referenceable" }),
  f("curatorReviewReference", "Curator review reference", "string", "review", "A curator fills this in after a review. Entering it yourself doesn't mean a review happened.", { requiredAt: "curator_reviewed" }),
  f("citationText", "Citation", "string", "citation", "How you'd like others to cite this version.", { requiredAt: "doi_ready" }),
  f("qualityStatement", "Quality statement", "string", "quality", "The checks you made, what's missing and any limits a reader should know.", { requiredAt: "doi_ready" }),
  f("archivePackageReference", "Archive package reference", "uri", "preservation", "A link to a preservation package. Having one here doesn't mean an archive accepted it.", { requiredAt: "archive_accepted" }),
];

const LOCATION_KEYS = ["decimalLatitude", "decimalLongitude", "coordinateUncertaintyM", "geodeticDatum"] as const;

/**
 * Point-location fields stored in the universal event envelope (storedIn:
 * "event"), so the existing locationVisibility and private-location
 * mechanism stays the only one. Restricted or not-collected locations are
 * exempt from the coordinate requirement.
 */
const eventLocationFields = (requiredAt: ReadinessLevel): readonly FieldDefinition[] => [
  f("locationVisibility", "Who can see the exact place", "enum", "location", "Public shows your point. Generalised shows a coarser point, so give a matching accuracy. Restricted keeps the place private and needs a private location record. Not collected means no place was recorded.", { vocabulary: LANE_LOCATION_VISIBILITY, storedIn: "event" }),
  f("decimalLatitude", "Latitude", "latitude", "location", "Decimal degrees. Places south of the equator, like Australia, are negative.", { requiredAt, sensitivity: "sensitive", example: "-33.8688", storedIn: "event", termIri: `${DWC}decimalLatitude` }),
  f("decimalLongitude", "Longitude", "longitude", "location", "Decimal degrees. Places east of Greenwich, like Australia, are positive.", { requiredAt, sensitivity: "sensitive", example: "151.2093", storedIn: "event", termIri: `${DWC}decimalLongitude` }),
  f("coordinateUncertaintyM", "Location accuracy (metres)", "number", "location", "How far the true spot could be from your point, in metres. Phone GPS is often 5 to 30 m. Don't enter 0.", { requiredAt, min: 0, max: 20_037_509, example: "30", storedIn: "event", termIri: `${DWC}coordinateUncertaintyInMeters` }),
  f("geodeticDatum", "Map datum", "enum", "location", "Phones and web maps use WGS84. Older paper maps and labels may use GDA94, GDA2020 or AGD66. Choose unknown if you're not sure.", { requiredAt, vocabulary: LANE_GEODETIC_DATUMS, vocabularyIris: LANE_GEODETIC_DATUM_IRIS, storedIn: "event", termIri: `${DWC}geodeticDatum` }),
  f("countryCode", "Country code", "string", "location", "Two capital letters, for example AU for Australia.", { pattern: "^[A-Z]{2}$", example: "AU", storedIn: "event", termIri: `${DWC}countryCode` }),
];

const locationChecks = {
  coordinatePairs: [["decimalLatitude", "decimalLongitude"]],
  positiveValues: ["coordinateUncertaintyM"],
  locationExemption: { field: "locationVisibility", values: ["restricted", "not_collected"], fields: [...LOCATION_KEYS] },
} as const;

const baseLaneChecks = {
  ruleSet: "clio.lane-checks/1.0.0",
  errorFrom: "referenceable",
  rejectFutureDates: true,
  requireTimeZoneOffset: true,
  enforcePatterns: true,
} as const;

const biologicalFieldsV1_1: readonly FieldDefinition[] = [
  f("recordBasis", "What kind of record is this?", "enum", "identity", "Human observation if you saw or heard it yourself. Machine observation for a camera trap or sound recorder. Preserved specimen for a pinned or pressed specimen. Living specimen for a garden or captive organism. Occurrence only if you can't tell.", { requiredAt: "draft", vocabulary: LANE_BASIS_OF_RECORD, vocabularyIris: LANE_BASIS_OF_RECORD_IRIS, termIri: `${DWC}basisOfRecord` }),
  f("verbatimIdentification", "What you think it is", "string", "identification", "Type what you saw in your own words, common or scientific. We keep it exactly as you typed it.", { termIri: `${DWC}verbatimIdentification` }),
  f("taxonomicRank", "How far you could identify it", "enum", "identification", "The most precise level your evidence supports. Genus or family is fine when you can't be sure of the species.", { requiredAt: "referenceable", vocabulary: ["kingdom", "phylum", "class", "order", "family", "genus", "species", "subspecies", "variety", "form", "unknown"], termIri: `${DWC}taxonRank` }),
  f("taxonKingdom", "Kingdom", "string", "identification", "Kingdom, such as Animalia, Plantae or Fungi. It helps the name check avoid look-alike names.", { termIri: `${DWC}kingdom` }),
  f("taxonPhylum", "Phylum", "string", "identification", "Phylum, if you know it."),
  f("taxonClass", "Class", "string", "identification", "Class, if you know it."),
  f("taxonOrder", "Order", "string", "identification", "Order, if you know it."),
  f("taxonSuborder", "Suborder", "string", "identification", "Suborder, if your checklist uses one."),
  f("taxonFamily", "Family", "string", "identification", "Family, if you know it.", { termIri: `${DWC}family` }),
  f("taxonSubfamily", "Subfamily", "string", "identification", "Subfamily, if you know it."),
  f("taxonTribe", "Tribe", "string", "identification", "Tribe, if you know it."),
  f("taxonGenus", "Genus", "string", "identification", "Genus, if you know it.", { termIri: `${DWC}genus` }),
  f("taxonSubgenus", "Subgenus", "string", "identification", "Subgenus, if you know it."),
  f("taxonSpecificEpithet", "Specific epithet", "string", "identification", "The second word of a species name only, not the whole name."),
  f("taxonInfraspecificEpithet", "Infraspecific epithet", "string", "identification", "The subspecies, variety or form word, if there is one."),
  f("taxonScientificName", "Scientific name", "string", "identification", "The Latin name without cf., aff. or sp. Put those in the qualifier field.", { requiredAt: "referenceable", example: "Rhipidura albiscapa", termIri: `${DWC}scientificName` }),
  f("taxonAuthorship", "Name authorship", "string", "identification", "The author of the name, if you know it.", { termIri: `${DWC}scientificNameAuthorship` }),
  f("taxonNameAccordingTo", "Name according to", "string", "identification", "The publication or checklist the name comes from."),
  f("taxonNomenclaturalCode", "Naming code", "enum", "identification", "The code of naming the source follows, if you know it.", { vocabulary: ["ICN", "ICZN", "ICTV", "ICNP", "other", "unknown"] }),
  f("taxonIdentificationQualifier", "Identification qualifier", "string", "identification", "Use cf. (compare with) or aff. (similar to) when you're not certain.", { example: "cf.", termIri: `${DWC}identificationQualifier` }),
  f("taxonomicStatus", "Name status", "enum", "identification", "Whether the checklist treats the name as accepted, a synonym and so on.", { vocabulary: ["accepted", "doubtful", "synonym", "undetermined"] }),
  f("taxonNameResolution", "Name check result", "enum", "identification", "Check the scientific name against a checklist and record the result. 'No match, kept as typed' is a fine answer.", { requiredAt: "research_ready", vocabulary: LANE_NAME_RESOLUTION }),
  f("taxonBackbone", "Checklist used for the name", "string", "identification", "The checklist you checked the name against, such as the Catalogue of Life via GBIF, the Australian Plant Census or the Australian Faunal Directory.", { requiredAt: "research_ready" }),
  f("taxonBackboneVersion", "Checklist version", "string", "identification", "The checklist version or the date you checked it.", { requiredAt: "doi_ready" }),
  f("taxonConceptId", "Taxon identifier", "identifier", "identification", "The checklist's identifier for the name. Copy it from the checklist; never make one up.", { requiredAt: "doi_ready", termIri: `${DWC}scientificNameID` }),
  f("identificationBasis", "Why you think it's that", "string", "identification", "What helped you identify it: features, a field guide or key, a call, or a specialist. For an unusual find, say how you ruled out look-alikes.", { requiredAt: "research_ready", termIri: `${DWC}identificationRemarks` }),
  f("identificationUncertainty", "How sure you are", "enum", "identification", "How strongly your evidence supports the name.", { requiredAt: "research_ready", vocabulary: ["certain", "probable", "possible", "family_only", "genus_only", "unknown"] }),
];

const occurrenceStatusField = f("occurrenceStatus", "Found, or looked for and not found?", "enum", "observation", "Choose detected for a sighting. Choose not detected only when you searched for it on purpose and didn't find it.", { requiredAt: "research_ready", vocabulary: LANE_OCCURRENCE_STATUS, termIri: `${DWC}occurrenceStatus` });
const establishmentField = f("establishmentMeans", "How it came to be there", "enum", "organism", "Native, introduced, vagrant and so on. Choose uncertain if you don't know.", { requiredAt: "research_ready", vocabulary: LANE_ESTABLISHMENT_MEANS, vocabularyIris: LANE_ESTABLISHMENT_MEANS_IRIS, termIri: `${DWC}establishmentMeans` });
const wildStatusField = f("wildStatus", "Wild, planted or kept?", "enum", "organism", "Was it wild, or planted, kept or captive, such as in a garden, zoo, aquarium or as a pet?", { requiredAt: "referenceable", vocabulary: LANE_WILD_STATUS });

const biologicalOccurrenceV1_1: ApplicationProfile = {
  id: "clio.profile.biological-occurrence", version: "1.1.0", title: "Biological occurrence",
  description: "A sighting or record of a living or once-living organism. The name can stay uncertain; place, count and status reach research grade step by step.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC],
  fields: [...commonFieldsV1_1, ...eventLocationFields("research_ready"), ...biologicalFieldsV1_1,
    wildStatusField,
    establishmentField,
    occurrenceStatusField,
    f("individualCount", "How many", "integer", "organism", "How many individuals you counted. Leave it blank if you didn't count. Enter 0 only for a planned search that found none.", { min: 0, termIri: `${DWC}individualCount` }),
    f("lifeStage", "Life stage", "enum", "organism", "The life stage you saw, if you could tell.", { vocabulary: LANE_LIFE_STAGES, termIri: `${DWC}lifeStage` }),
    f("lifeStageRemarks", "Life stage notes", "string", "organism", "Anything about life stage the list doesn't cover."),
    f("sex", "Sex", "enum", "organism", "Only if you could see or reliably tell it.", { vocabulary: LANE_SEX, vocabularyIris: LANE_SEX_IRIS, termIri: `${DWC}sex` }),
    f("behaviour", "Behaviour", "string", "observation", "What you saw it doing, not what you think it meant."),
    f("associatedOrganisms", "Other organisms with it", "string", "ecology", "Other organisms you saw with it, such as a host plant or prey."),
  ],
  qualityChecks: {
    ...baseLaneChecks, ...locationChecks,
    countStatus: { count: "individualCount", status: "occurrenceStatus", present: "detected", absent: "notDetected" },
  },
};

const structuredSurveyV1_1: ApplicationProfile = {
  id: "clio.profile.structured-survey", version: "1.1.0", title: "Structured survey",
  description: "A planned or repeated sampling event where effort, protocol, target group and completeness matter as much as what you found.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_HUMBOLDT, STANDARD_EML],
  fields: [...commonFieldsV1_1, ...eventLocationFields("research_ready"), ...biologicalFieldsV1_1,
    f("surveyProtocol", "Survey protocol", "string", "sampling", "Name or describe the method you followed, with its version if it has one.", { requiredAt: "referenceable", termIri: `${DWC}samplingProtocol` }),
    f("surveyProtocolType", "Protocol type", "enum", "sampling", "The closest type from this starter list. Choose other and describe it above if none fit.", { vocabulary: LANE_SURVEY_PROTOCOLS }),
    f("protocolReference", "Protocol document", "uri", "sampling", "A link to the written protocol, if there is one."),
    f("samplingDesign", "How you chose sites and times", "string", "sampling", "How you picked the sites, times, transects or quadrats.", { requiredAt: "research_ready" }),
    f("samplingUnit", "What one record covers", "string", "sampling", "The unit each record represents, such as one quadrat, trap, transect or point count.", { requiredAt: "referenceable" }),
    f("samplingEffort", "Effort", "number", "sampling", "How much effort you put in, with its unit, such as 2 person-hours or 40 trap-days.", { requiredAt: "research_ready", units: ["minute", "hour", "metre", "square_metre", "trap_day", "person_hour"], unitRequiredAt: "research_ready", min: 0 }),
    f("eventDuration", "How long", "number", "sampling", "How long the survey lasted.", { units: ["second", "minute", "hour"], unitRequiredAt: "research_ready", min: 0 }),
    f("samplingArea", "Area covered", "number", "sampling", "The area the sampling unit covered.", { units: ["square_metre", "hectare"], unitRequiredAt: "research_ready", min: 0 }),
    f("siteCount", "Number of sites", "integer", "sampling", "How many sites this survey event covers.", { min: 1 }),
    f("targetTaxonomicScope", "What you were looking for", "string", "completeness", "The group you set out to find and record, such as 'all birds' or 'frogs only'.", { requiredAt: "research_ready", example: "all birds" }),
    f("isTaxonomicScopeFullyReported", "Did you record everything in that group?", "boolean", "completeness", "Yes means you listed every species in that group you could identify (a complete list). No means you listed only some.", { requiredAt: "research_ready" }),
    f("isAbsenceReported", "Do you report what you didn't find?", "boolean", "completeness", "Yes only if a species missing from your list really means you looked and didn't find it.", { requiredAt: "research_ready" }),
    f("isAbundanceReported", "Did you count numbers?", "boolean", "completeness", "Yes if you counted how many of each species, not just which species.", { requiredAt: "research_ready" }),
    f("eventCount", "How many", "integer", "observation", "How many individuals the protocol counted. Enter 0 only when you looked and found none.", { min: 0, termIri: `${DWC}individualCount` }),
    occurrenceStatusField,
    establishmentField,
    f("environment", "Habitat and conditions", "string", "event", "Habitat, weather, substrate or anything else that affects what you could find."),
  ],
  qualityChecks: {
    ...baseLaneChecks, ...locationChecks,
    countStatus: { count: "eventCount", status: "occurrenceStatus", present: "detected", absent: "notDetected" },
    conditional: [
      { when: { field: "occurrenceStatus", in: ["notDetected"] }, require: ["targetTaxonomicScope", "samplingEffort"], message: "A 'not detected' record needs the target group and your effort." },
      { when: { field: "occurrenceStatus", in: ["notDetected"] }, restrict: { field: "isAbsenceReported", in: [true] }, message: "A 'not detected' record means you report absences. Set 'Do you report what you didn't find?' to Yes." },
    ],
  },
};

const tenureFields: readonly FieldDefinition[] = [
  f("collectionAuthority", "What allowed you to collect it?", "enum", "permission", "Landholder consent, a fossicking licence or miner's right, a permit and so on. Choose unknown if you're not sure. This isn't legal advice; check your state's rules.", { requiredAt: "referenceable", vocabulary: LANE_COLLECTION_AUTHORITY }),
  f("landTenure", "Who owns or manages the land?", "enum", "permission", "Private land, Crown or public land, a national park and so on. Choose unknown if you're not sure.", { requiredAt: "research_ready", vocabulary: LANE_LAND_TENURE }),
  f("permitReference", "Permit or licence number", "string", "permission", "The permit, licence or consent reference, if you have one. Keep personal details out."),
];

const igsnReadyFields: readonly FieldDefinition[] = [
  f("sampleObjectType", "Kind of object", "enum", "material", "The physical form you kept: a hand specimen, a thin section, a core and so on.", { vocabulary: LANE_SAMPLE_OBJECT_TYPES, termIri: `${DWC}materialEntityType` }),
  f("parentMaterialEntityId", "Parent sample", "identifier", "material", "If this was cut or split from another sample, that sample's identifier."),
  f("currentRepository", "Where it's kept", "string", "curation", "The collection or institution holding it, or 'private collection'. Don't give a home address."),
  f("igsn", "IGSN", "identifier", "identifiers", "An IGSN already registered for this sample. This schema doesn't register IGSNs; leave blank if there isn't one.", { pattern: "^(?:(?:https://doi\\.org/)?10\\.[0-9]{4,9}/\\S+|IGSN:[A-Za-z0-9.-]+)$", example: "10.60579/ABC123" }),
];

const materialSampleV1_1: ApplicationProfile = {
  id: "clio.profile.material-sample", version: "1.1.0", title: "Material sample",
  description: "A biological or environmental material you kept, split or prepared for later study, with where it came from and what allowed you to take it.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_ABCD, STANDARD_IGSN],
  fields: [...commonFieldsV1_1, ...eventLocationFields("research_ready"),
    f("materialEntityId", "Sample identifier", "identifier", "material", "Your label or catalogue number for the sample. Keep the original number if it already has one.", { requiredAt: "referenceable", termIri: `${DWC}materialEntityID` }),
    f("materialType", "What you sampled", "string", "material", "What you sampled or kept, such as leaf tissue, soil or a water filter.", { requiredAt: "draft" }),
    f("collectionMethod", "How you collected it", "string", "collection", "How you got the material, including non-destructive methods.", { requiredAt: "referenceable" }),
    f("collector", "Collector", "string", "provenance", "Who collected it.", { requiredAt: "referenceable" }),
    ...tenureFields,
    f("preservationMethod", "How it's preserved", "string", "curation", "How you preserved it, such as frozen, dried or in 70% ethanol.", { requiredAt: "research_ready" }),
    f("preparationMethod", "How it was prepared", "string", "curation", "Any preparation before study.", { requiredAt: "research_ready" }),
    f("storageCondition", "Storage", "string", "curation", "Storage conditions, such as -20 °C. Don't give a private address."),
    f("materialQuantity", "Amount", "number", "material", "How much you kept or examined.", { units: ["milligram", "gram", "millilitre", "count"], unitRequiredAt: "research_ready", min: 0 }),
    ...igsnReadyFields,
  ],
  qualityChecks: {
    ...baseLaneChecks, ...locationChecks,
    conditional: [
      { when: { field: "collectionAuthority", in: ["permit", "fossicking_licence_or_miners_right"] }, from: "research_ready", require: ["permitReference"], message: "Add the permit or licence reference." },
    ],
  },
};

const geologicalSampleV1_1: ApplicationProfile = {
  id: "clio.profile.geological-sample", version: "1.1.0", title: "Geological sample",
  description: "A rock, mineral, sediment or fossil with where it came from, what allowed you to collect it, and what you can tell about it.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_ABCD, STANDARD_DWC, STANDARD_CGI, STANDARD_ICS, STANDARD_IGSN],
  fields: [...commonFieldsV1_1, ...eventLocationFields("research_ready"),
    f("materialEntityId", "Sample identifier", "identifier", "material", "Your label or catalogue number. Photograph any original label or tag first and keep its number.", { requiredAt: "referenceable", termIri: `${DWC}materialEntityID` }),
    f("geologicMaterialType", "What is it?", "enum", "material", "Mineral, rock, sediment, soil, fossil and so on.", { requiredAt: "draft", vocabulary: ["mineral", "rock", "sediment", "soil", "fossil", "fluid", "other"] }),
    f("collectionMethod", "How you found or collected it", "enum", "collection", "Picked up loose, dug, broken from an outcrop, from a mine dump, bought, inherited and so on.", { requiredAt: "referenceable", vocabulary: LANE_GEOLOGY_COLLECTION_METHODS, termIri: `${DWC}samplingProtocol` }),
    ...tenureFields,
    f("heritageCheck", "Any signs of Aboriginal cultural material nearby?", "enum", "permission", "Stone tools, grinding grooves, engravings, ochre pits or scarred trees. If you think so, don't collect: take a photo, keep the place private and contact the local Aboriginal land council or state heritage body.", { requiredAt: "referenceable", vocabulary: LANE_HERITAGE_CHECK }),
    f("meteoriteCheck", "Could it be a meteorite?", "enum", "permission", "Heavy, dark crust, magnetic, no bubbles? Some states own meteorites by law. If you think so, keep the place private and contact your state museum.", { vocabulary: LANE_METEORITE_CHECK }),
    f("legalStatusNote", "Legal status note", "string", "permission", "Anything about the law or ownership that applies, in your own words. This isn't legal advice."),
    f("photoScale", "Scale in your photo", "enum", "evidence", "Put a ruler or scale card beside the specimen. Choose no scale if there isn't one; you can add another photo later.", { requiredAt: "referenceable", vocabulary: LANE_PHOTO_SCALE }),
    f("mineralSpecies", "Mineral name", "string", "identification", "The IMA mineral name, 'cf. quartz' if you're unsure, or 'unidentified'. You can check names on mindat.org, but don't copy Mindat text or photos into your records: its licence is different.", { example: "quartz" }),
    f("imaStatus", "IMA status of the name", "enum", "identification", "Whether the name is an approved mineral species, a variety or trade name, and so on.", { vocabulary: LANE_IMA_STATUS }),
    f("mineralIdentifier", "Mineral database identifier", "identifier", "identification", "The Mindat or IMA number for the name, if you know it. Name the database in the source."),
    f("identificationBasis", "How you know what it is", "enum", "identification", "A seller's label, matched photos, your own tests, a specialist, or an instrument such as XRD, XRF or Raman.", { requiredAt: "research_ready", vocabulary: LANE_GEOLOGY_IDENTIFICATION_BASIS }),
    f("lithologyClass", "Rock type", "enum", "geology", "The closest rock name. Choose igneous, sedimentary or metamorphic rock if you only know the group, or unknown.", { vocabulary: LANE_LITHOLOGY_TERMS, vocabularyIris: LANE_LITHOLOGY_IRIS }),
    f("lithology", "Rock description", "string", "geology", "Describe the rock in your own words, and say whether that's what you saw or what you think it is."),
    f("mineralComposition", "Minerals you can see", "string", "geology", "Minerals you can see or have measured."),
    f("formation", "Formation or unit", "string", "geology", "The geological formation or mapped unit. Use the name from the Australian Stratigraphic Units Database (asud.ga.gov.au) if you can.", { termIri: `${DWC}formation` }),
    f("ageEarliest", "Oldest possible age", "enum", "geology", "The oldest time unit it could belong to. Choose unknown if you're not sure.", { vocabulary: LANE_GEOLOGIC_AGE_UNITS, vocabularyIris: LANE_GEOLOGIC_AGE_IRIS }),
    f("ageLatest", "Youngest possible age", "enum", "geology", "The youngest time unit it could belong to. Use the same unit as the oldest if you know it exactly.", { vocabulary: LANE_GEOLOGIC_AGE_UNITS, vocabularyIris: LANE_GEOLOGIC_AGE_IRIS }),
    f("ageBasis", "How you know the age", "enum", "geology", "A fossil, a radiometric date, a geological map, a publication or your estimate.", { vocabulary: LANE_AGE_BASIS }),
    f("geologicAge", "Age notes", "string", "geology", "Any other age detail, with where it comes from."),
    f("stratigraphicContext", "Layer or bed", "string", "context", "The layer, bed, horizon or section it came from."),
    f("collectionSite", "Site notes", "string", "event", "Notes about the site, kept separate from the public place description.", { sensitivity: "sensitive" }),
    f("specimenMass", "Mass", "number", "material", "How heavy the specimen is.", { requiredAt: "research_ready", units: ["gram", "kilogram"], unitRequiredAt: "research_ready", min: 0 }),
    f("specimenSize", "Longest dimension", "number", "material", "The specimen's longest side.", { units: ["millimetre", "centimetre", "metre"], unitRequiredAt: "research_ready", min: 0 }),
    f("hardness", "Hardness (Mohs)", "number", "tests", "Mohs hardness from 1 (talc) to 10 (diamond). Test on a hidden spot, and say what you scratched it with in the method.", { units: ["mohs"], unitRequiredAt: "research_ready", min: 1, max: 10 }),
    f("streak", "Streak", "string", "tests", "The colour of its powder on an unglazed tile. Only test where it's safe and won't spoil the specimen."),
    f("cleavage", "Cleavage", "string", "tests", "How it breaks along flat planes, and how well."),
    f("colour", "Colour", "string", "tests", "The colour of a fresh surface."),
    f("lustre", "Lustre", "enum", "tests", "How the surface reflects light.", { vocabulary: LANE_LUSTRE }),
    f("magnetism", "Magnetism", "enum", "tests", "Whether a magnet sticks to it.", { vocabulary: LANE_MAGNETISM }),
    f("reactionToAcid", "Reaction to dilute acid", "enum", "tests", "Only if you tested safely with dilute acid on a hidden spot.", { vocabulary: LANE_ACID_REACTION }),
    f("fossilTaxon", "Fossil organism", "string", "fossil", "For a fossil, the organism's name if you know it, at any level."),
    f("fossilPartOfOrganism", "Part of the organism", "string", "fossil", "For a fossil, which part it is, such as a shell, tooth or leaf."),
    ...igsnReadyFields,
  ],
  qualityChecks: {
    ...baseLaneChecks, ...locationChecks,
    conditional: [
      { when: { field: "geologicMaterialType", in: ["mineral"] }, from: "referenceable", require: ["mineralSpecies"], message: "Add the mineral name, 'cf.' with a name, or 'unidentified'." },
      { when: { field: "geologicMaterialType", in: ["rock"] }, from: "research_ready", require: ["lithologyClass"], message: "Choose a rock type, or unknown." },
      { when: { field: "geologicMaterialType", in: ["rock", "fossil", "sediment"] }, from: "research_ready", require: ["ageEarliest", "ageLatest"], message: "Choose the oldest and youngest possible age, or unknown." },
      { when: { field: "heritageCheck", in: ["possible_cultural_material"] }, restrict: { field: "locationVisibility", in: ["generalized", "restricted", "not_collected"] }, message: "Keep the place private: choose generalised, restricted or not collected." },
      { when: { field: "heritageCheck", in: ["possible_cultural_material"] }, restrict: { field: "collectionMethod", in: ["photographed_not_collected"] }, message: "Don't collect possible cultural material. Record it as photographed, not collected." },
      { when: { field: "meteoriteCheck", in: ["possible_meteorite"] }, restrict: { field: "locationVisibility", in: ["generalized", "restricted", "not_collected"] }, message: "Keep a possible meteorite find site private: choose generalised, restricted or not collected." },
      { when: { field: "collectionAuthority", in: ["permit", "fossicking_licence_or_miners_right"] }, from: "research_ready", require: ["permitReference"], message: "Add the permit or licence reference." },
    ],
  },
};

const timeFields = (requiredAt: ReadinessLevel): readonly FieldDefinition[] => [
  f("observationStart", "Start time", "datetime", "event", "When you started, with the time zone, for example 2026-10-22T21:05:00+11:00 or 2026-10-22T10:05:00Z. Check your camera or laptop clock first.", { requiredAt, sensitivity: "sensitive", example: "2026-10-22T21:05:00+11:00" }),
  f("observationEnd", "End time", "datetime", "event", "When you finished, with the time zone.", { requiredAt, sensitivity: "sensitive", example: "2026-10-22T21:35:00+11:00" }),
  f("timeScale", "Time scale", "enum", "event", "UTC for almost everyone. Choose another scale only if your software states it.", { requiredAt: "research_ready", vocabulary: LANE_TIME_SCALES }),
  f("timeSource", "Where the time came from", "enum", "event", "GPS, internet time, the phone network, the camera clock or a watch.", { vocabulary: LANE_TIME_SOURCES }),
  f("clockErrorSeconds", "Clock error (seconds)", "number", "event", "How far your clock was off, if you checked it against a time service such as time.is. Positive if it was fast."),
];

const siteFields = (requiredAt: ReadinessLevel | undefined): readonly FieldDefinition[] => [
  f("observatoryName", "Observing site", "string", "site", "Your observatory or a general place name."),
  f("observatoryLatitude", "Site latitude", "latitude", "site", "Your observing site, in decimal degrees (negative in the southern hemisphere). It stays out of public views.", { ...(requiredAt ? { requiredAt } : {}), sensitivity: "sensitive", example: "-33.87" }),
  f("observatoryLongitude", "Site longitude", "longitude", "site", "Your observing site, in decimal degrees (positive east of Greenwich). It stays out of public views.", { ...(requiredAt ? { requiredAt } : {}), sensitivity: "sensitive", example: "151.21" }),
  f("observatoryElevation", "Site elevation", "number", "site", "Height above sea level, if you know it.", { units: ["metre"], unitRequiredAt: "research_ready" }),
];

const calibrationFrameFields: readonly FieldDefinition[] = [
  f("biasFrameCount", "Bias frames", "integer", "calibration", "How many bias frames you used.", { min: 0 }),
  f("darkFrameCount", "Dark frames", "integer", "calibration", "How many dark frames you used. Darks should match your exposure and sensor temperature.", { min: 0 }),
  f("flatFrameCount", "Flat frames", "integer", "calibration", "How many flat frames you used. Flats should be taken without moving focus.", { min: 0 }),
  f("plateSolveStatus", "Plate solve", "enum", "calibration", "Whether the file's header claims a sky solution (WCS) or you solved it yourself. Nothing here has checked it.", { vocabulary: LANE_PLATE_SOLVE_STATUS }),
];

const astronomyChecks = {
  ...baseLaneChecks,
  coordinatePairs: [["observatoryLatitude", "observatoryLongitude"]],
  orderedPairs: [["observationStart", "observationEnd"]],
} as const;

const astronomyImageV1_1: ApplicationProfile = {
  id: "clio.profile.astronomy-image", version: "1.1.0", title: "Astronomy image",
  description: "An astronomical image with target, a time-zoned capture interval, site, equipment, exposure and processing history.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_FITS, STANDARD_WCS, STANDARD_IVOA],
  fields: [...commonFieldsV1_1,
    f("targetName", "What you photographed", "string", "target", "The object's name or catalogue number, such as M42 or NGC 253. Write what you think it is if you're not sure.", { requiredAt: "draft", example: "M42" }),
    f("targetType", "Kind of target", "string", "target", "Star, planet, nebula, galaxy, comet, the Moon, a landscape with sky, and so on."),
    ...timeFields("referenceable"),
    ...siteFields("research_ready"),
    f("instrumentName", "Telescope and camera", "string", "instrument", "Your telescope or lens and camera.", { requiredAt: "referenceable" }),
    f("filterBand", "Filter", "string", "acquisition", "The filter in the light path, or 'none'.", { requiredAt: "research_ready", example: "none" }),
    f("exposureSeconds", "Exposure", "number", "acquisition", "One exposure's length, in seconds.", { requiredAt: "referenceable", units: ["second"], unitRequiredAt: "referenceable", min: 0 }),
    f("frameCount", "Frames stacked", "integer", "acquisition", "How many frames went into the final image.", { min: 1 }),
    f("rightAscension", "Right ascension", "number", "coordinates", "The image centre's right ascension, in degrees or hours. Your plate-solve or the FITS header usually gives it.", { requiredAt: "research_ready", units: ["degree", "hour"], unitRequiredAt: "research_ready", min: 0, max: 360 }),
    f("declination", "Declination", "number", "coordinates", "The image centre's declination, in degrees.", { requiredAt: "research_ready", units: ["degree"], unitRequiredAt: "research_ready", min: -90, max: 90 }),
    f("coordinateFrame", "Coordinate frame", "string", "coordinates", "Usually ICRS or J2000.", { requiredAt: "research_ready", example: "ICRS" }),
    f("calibrationStatus", "Calibration", "enum", "processing", "Whether you applied darks, flats and bias. Don't say calibrated without the frames to show it.", { requiredAt: "research_ready", vocabulary: ["not_calibrated", "partially_calibrated", "calibrated", "unknown"] }),
    ...calibrationFrameFields,
    f("dataProductType", "Kind of file", "enum", "processing", "Raw, calibrated, stacked, a composite or an annotated picture. Phone night modes are composites.", { vocabulary: ["raw", "calibrated", "stacked", "composite", "annotated", "unknown"] }),
    f("fitsHeaderAvailable", "FITS header kept", "boolean", "provenance", "Whether you kept the original FITS header."),
    f("processingSoftware", "Processing software", "string", "processing", "The software and main steps, such as stacking and stretching."),
  ],
  qualityChecks: astronomyChecks,
};

const calibratedAstronomyV1_1: ApplicationProfile = {
  id: "clio.profile.calibrated-astronomy-observation", version: "1.1.0", title: "Calibrated astronomy observation",
  description: "An observation meant for measurement, with a time-zoned interval, filter, site, sky coordinates, calibration and uncertainty.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_FITS, STANDARD_WCS, STANDARD_IVOA],
  fields: [...commonFieldsV1_1,
    f("targetName", "Target", "string", "target", "The target's name or catalogue identifier.", { requiredAt: "draft", example: "NGC 253" }),
    ...timeFields("referenceable"),
    ...siteFields("research_ready"),
    f("instrumentName", "Instrument", "string", "instrument", "Telescope, camera or detector configuration.", { requiredAt: "referenceable" }),
    f("filterBand", "Filter", "string", "acquisition", "The filter or bandpass, or 'none'.", { requiredAt: "research_ready", example: "V" }),
    f("exposureSeconds", "Exposure", "number", "acquisition", "One exposure's length, in seconds.", { requiredAt: "referenceable", units: ["second"], unitRequiredAt: "referenceable", min: 0 }),
    f("frameCount", "Frames", "integer", "acquisition", "How many frames the result uses.", { min: 1 }),
    f("rightAscension", "Right ascension", "number", "coordinates", "Right ascension, in degrees or hours.", { requiredAt: "research_ready", units: ["degree", "hour"], unitRequiredAt: "research_ready", min: 0, max: 360 }),
    f("declination", "Declination", "number", "coordinates", "Declination, in degrees.", { requiredAt: "research_ready", units: ["degree"], unitRequiredAt: "research_ready", min: -90, max: 90 }),
    f("coordinateFrame", "Coordinate frame", "string", "coordinates", "The reference frame and equinox, such as ICRS.", { requiredAt: "research_ready", example: "ICRS" }),
    f("wcsSolution", "Sky solution (WCS)", "string", "calibration", "Where the WCS solution or header is kept. Recording it here doesn't mean it's correct.", { requiredAt: "research_ready" }),
    ...calibrationFrameFields,
    f("astrometricCalibration", "Position calibration", "string", "calibration", "Reference catalogue, fit method, residuals and date.", { requiredAt: "research_ready" }),
    f("photometricCalibration", "Brightness calibration", "string", "calibration", "Standards, zero point, bandpass and method."),
    f("calibrationReference", "Calibration reference", "string", "calibration", "The reference data or standard you calibrated against.", { requiredAt: "research_ready" }),
    f("uncertaintyModel", "How you worked out uncertainty", "string", "analysis", "How you calculated position, brightness or other uncertainties.", { requiredAt: "research_ready" }),
    f("coordinateUncertainty", "Position uncertainty", "number", "analysis", "Uncertainty of the reported position.", { units: ["arcsecond", "arcminute", "degree"], unitRequiredAt: "research_ready", min: 0 }),
    f("processingSoftware", "Processing software", "string", "processing", "Software, versions and processing steps.", { requiredAt: "research_ready" }),
    f("processingVersion", "Processing version", "string", "processing", "The version or build you processed with.", { requiredAt: "research_ready" }),
  ],
  qualityChecks: astronomyChecks,
};

const variableStarObservationV1: ApplicationProfile = {
  id: "clio.profile.variable-star-observation", version: "1.0.0", title: "Variable star observation",
  description: "A brightness measurement of a variable star, with the fields the AAVSO extended format uses. This profile doesn't submit to AAVSO.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_AAVSO],
  fields: [...commonFieldsV1_1,
    f("targetName", "Star", "string", "target", "The AAVSO star name or AUID, such as R CAR or 000-BBC-123. Use the AAVSO name rather than one you remember.", { requiredAt: "draft", example: "R CAR" }),
    f("observationMidpoint", "Mid-time of the observation", "datetime", "event", "The middle of your exposure or estimate, with time zone (UTC is best), for example 2026-10-22T11:30:00Z.", { requiredAt: "referenceable", sensitivity: "sensitive", example: "2026-10-22T11:30:00Z" }),
    f("julianDate", "Julian Date", "number", "event", "The same mid-time as a Julian Date, if your software gives one.", { min: 0 }),
    f("julianDateType", "Julian Date type", "enum", "event", "JD, or HJD if your software corrected for light travel time to the Sun.", { vocabulary: ["JD", "HJD"] }),
    f("magnitude", "Magnitude", "number", "measurement", "The star's brightness.", { requiredAt: "referenceable", min: -30, max: 40 }),
    f("fainterThan", "Fainter than this?", "boolean", "measurement", "Yes if you couldn't see the star and the magnitude is your faintest limit."),
    f("magnitudeError", "Magnitude uncertainty", "number", "measurement", "The uncertainty of your magnitude, if you have one.", { min: 0 }),
    f("filter", "Filter code", "enum", "measurement", "The AAVSO filter code. Use TG for a DSLR's green channel and CV for no filter with V comparison stars; O if none fit.", { requiredAt: "referenceable", vocabulary: LANE_AAVSO_FILTERS }),
    f("obsType", "How you observed", "enum", "measurement", "CCD (also for CMOS cameras), DSLR, PEP or Visual.", { requiredAt: "referenceable", vocabulary: LANE_AAVSO_OBSERVATION_TYPES }),
    f("instrumentName", "Telescope and camera", "string", "instrument", "Your telescope or lens and camera.", { requiredAt: "referenceable" }),
    f("observerCode", "AAVSO observer code", "string", "provenance", "Your AAVSO observer code, if you have one."),
    f("magnitudeType", "Magnitude type", "enum", "method", "STD for standardised magnitudes (preferred), DIF for a difference from the comparison star, ABS rarely.", { requiredAt: "research_ready", vocabulary: LANE_AAVSO_MAGNITUDE_TYPES }),
    f("transformed", "Transformed?", "boolean", "method", "Yes if you applied transformation coefficients.", { requiredAt: "research_ready" }),
    f("comparisonStarName", "Comparison star", "string", "method", "The comparison star's label or AUID from the chart, or ENSEMBLE.", { requiredAt: "research_ready" }),
    f("comparisonStarMagnitude", "Comparison star magnitude", "number", "method", "Your instrumental magnitude of the comparison star.", { min: -30, max: 40 }),
    f("checkStarName", "Check star", "string", "method", "A steady star you measured to check your result.", { requiredAt: "research_ready" }),
    f("checkStarMagnitude", "Check star magnitude", "number", "method", "Your instrumental magnitude of the check star.", { min: -30, max: 40 }),
    f("chartId", "Chart ID", "string", "method", "The chart ID from the AAVSO Variable Star Plotter, or the catalogue you used (such as APASS DR10).", { requiredAt: "research_ready" }),
    f("airmass", "Airmass", "number", "method", "The airmass at mid-time, if your software gives it.", { min: 1 }),
    f("groupId", "Group", "string", "method", "A group label to link observations made together, if you use one."),
    f("softwareName", "Software", "string", "processing", "The photometry software and version.", { requiredAt: "research_ready" }),
    ...siteFields(undefined),
  ],
  qualityChecks: {
    ...baseLaneChecks,
    coordinatePairs: [["observatoryLatitude", "observatoryLongitude"]],
    conditional: [
      { when: { field: "magnitudeType", in: ["DIF"] }, require: ["comparisonStarName", "comparisonStarMagnitude"], message: "A DIF magnitude needs the comparison star and its magnitude." },
    ],
  },
};

const meteorFireballReportV1: ApplicationProfile = {
  id: "clio.profile.meteor-fireball-report", version: "1.0.0", title: "Meteor or fireball report",
  description: "A visual meteor count, a fireball sighting or a meteor video clip, with the report content IMO and AMS ask for. This profile doesn't submit reports for you.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_IMO, STANDARD_AMS],
  fields: [...commonFieldsV1_1,
    f("reportKind", "What are you reporting?", "enum", "identity", "A meteor count over a watch, one fireball you saw, or a video clip.", { requiredAt: "draft", vocabulary: LANE_METEOR_REPORT_KINDS }),
    ...timeFields("referenceable"),
    ...siteFields("research_ready"),
    f("effectiveObservingHours", "Effective watch time (hours)", "number", "count", "Time you were actually watching the sky, in decimal hours, without breaks.", { min: 0, max: 24 }),
    f("limitingMagnitude", "Faintest star you could see", "number", "count", "The limiting magnitude from your star counts.", { min: -2, max: 9 }),
    f("cloudCoverPercent", "Cloud cover (%)", "number", "count", "How much of your field was blocked by cloud.", { min: 0, max: 100 }),
    f("countingMethod", "Counting method", "enum", "count", "Count, or plot each meteor on a chart.", { vocabulary: LANE_METEOR_COUNT_METHODS }),
    f("fieldCentre", "Where you were looking", "string", "count", "The centre of your field of view, as RA and Dec or direction and height."),
    f("meteorShowerCounts", "Meteors per shower", "json", "count", "Counts per IMO three-letter shower code, for example { \"PER\": 12 }.", { example: "{ \"PER\": 12 }" }),
    f("sporadicCount", "Sporadic meteors", "integer", "count", "Meteors that didn't belong to a shower.", { min: 0 }),
    f("durationSeconds", "How long it lasted (seconds)", "number", "fireball", "Most fireballs last a few seconds. Over 30 seconds is probably a satellite or aircraft.", { min: 0 }),
    f("brightnessComparison", "How bright?", "enum", "fireball", "Compare it with something you know.", { vocabulary: LANE_FIREBALL_BRIGHTNESS }),
    f("brightnessMagnitude", "Brightness (magnitude)", "number", "fireball", "Your estimate as a magnitude, if you can give one.", { min: -30, max: 10 }),
    f("colour", "Colour", "string", "fireball", "The colours you saw."),
    f("startAzimuth", "Start direction (degrees)", "number", "fireball", "Compass direction where it started, 0 = north, 90 = east.", { min: 0, max: 360 }),
    f("startElevation", "Start height (degrees)", "number", "fireball", "Height above the horizon where it started, 0 = horizon, 90 = overhead.", { min: 0, max: 90 }),
    f("endAzimuth", "End direction (degrees)", "number", "fireball", "Compass direction where it ended.", { min: 0, max: 360 }),
    f("endElevation", "End height (degrees)", "number", "fireball", "Height above the horizon where it ended.", { min: 0, max: 90 }),
    f("trainSeen", "Trail left behind?", "boolean", "fireball", "Yes if it left a glowing trail."),
    f("fragmentationSeen", "Broke apart?", "boolean", "fireball", "Yes if it split or flared."),
    f("soundHeard", "Sound", "enum", "fireball", "Whether you heard anything, and when.", { vocabulary: LANE_FIREBALL_SOUND }),
    f("notAircraftOrSatellite", "Ruled out aircraft and satellites?", "boolean", "fireball", "Yes if it didn't blink, recur or take more than 30 seconds to cross the sky."),
    f("cameraModel", "Camera", "string", "video", "Camera and lens for a video clip."),
    f("frameRate", "Frame rate", "number", "video", "Frames per second.", { min: 0 }),
    f("platePar", "Calibration file", "string", "video", "Your station's plate or platepar calibration reference, if you have one."),
  ],
  qualityChecks: {
    ...baseLaneChecks,
    coordinatePairs: [["observatoryLatitude", "observatoryLongitude"]],
    orderedPairs: [["observationStart", "observationEnd"]],
    conditional: [
      { when: { field: "reportKind", in: ["visual_meteor_count"] }, from: "research_ready", require: ["effectiveObservingHours", "limitingMagnitude", "countingMethod"], message: "A meteor count needs watch time, limiting magnitude and counting method." },
      { when: { field: "reportKind", in: ["fireball_sighting"] }, from: "research_ready", require: ["durationSeconds", "startAzimuth", "startElevation", "endAzimuth", "endElevation", "notAircraftOrSatellite"], message: "A fireball report needs how long it lasted, where it started and ended, and whether you ruled out aircraft and satellites." },
    ],
  },
};

const sequenceSampleV1_1: ApplicationProfile = {
  id: "clio.profile.sequence-sample", version: "1.1.0", title: "Sequence sample",
  description: "A water, eDNA or other sample linked to sequencing, with site, depth, environment, filtering, controls, target gene and accessions.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_MIXS, STANDARD_ENVO],
  fields: [...commonFieldsV1_1, ...eventLocationFields("referenceable"),
    f("materialEntityId", "Sample or tube ID", "identifier", "material", "The ID on the tube or kit label. Take a photo of the label too.", { requiredAt: "referenceable", termIri: `${DWC}materialSampleID` }),
    f("sampleCategory", "Sample or control?", "enum", "material", "A real sample, or a blank or control taken the same way.", { requiredAt: "referenceable", vocabulary: LANE_SAMPLE_CATEGORIES }),
    f("projectName", "Project", "string", "material", "The project or program this sample belongs to.", { requiredAt: "research_ready" }),
    f("sequenceType", "Sequence type", "enum", "sequence", "Choose metabarcoding for most eDNA work.", { requiredAt: "draft", vocabulary: ["amplicon", "metabarcoding", "shotgun", "transcriptome", "genome", "barcode", "other"] }),
    f("waterBodyType", "Water type", "enum", "environment", "River or creek, lake or dam, estuary, or ocean or coast. Tools can suggest the environment terms from this.", { requiredAt: "referenceable", vocabulary: LANE_WATER_BODY_TYPES }),
    f("sampleDepth", "Depth", "number", "environment", "How deep you took the sample. Enter 0 for the surface.", { requiredAt: "referenceable", units: ["metre"], unitRequiredAt: "referenceable", min: 0 }),
    f("envBroadScale", "Broad environment (ENVO biome)", "uri", "environment", "An ENVO biome IRI, such as freshwater river biome. A tool can suggest one from the water type.", { requiredAt: "research_ready", pattern: LANE_ENVO_IRI_PATTERN, example: "http://purl.obolibrary.org/obo/ENVO_01000253" }),
    f("envLocalScale", "Local environment (ENVO)", "uri", "environment", "An ENVO IRI for the feature right around the sample, such as a stream, pond or reef.", { requiredAt: "research_ready", pattern: LANE_ENVO_IRI_PATTERN, example: "http://purl.obolibrary.org/obo/ENVO_00000023" }),
    f("envMedium", "Sampled material (ENVO)", "uri", "environment", "An ENVO IRI for what you sampled, such as river water or sea water.", { requiredAt: "research_ready", pattern: LANE_ENVO_IRI_PATTERN, example: "http://purl.obolibrary.org/obo/ENVO_01000599" }),
    f("sampleTaxon", "Sample type (metagenome)", "enum", "environment", "The metagenome type for repository submission, such as freshwater metagenome.", { requiredAt: "research_ready", vocabulary: LANE_SAMPLE_TAXA, vocabularyIris: LANE_SAMPLE_TAXON_IRIS }),
    f("collectionDevice", "Collection device", "enum", "collection", "What you collected the water with.", { requiredAt: "research_ready", vocabulary: LANE_COLLECTION_DEVICES }),
    f("kitName", "Kit", "string", "collection", "The kit name, if you used one. Kit details should come from the supplier's sheet."),
    f("volumeCollected", "Water collected", "number", "filtering", "How much water you collected.", { units: ["millilitre", "litre"], unitRequiredAt: "research_ready", min: 0 }),
    f("volumeFiltered", "Water through the filter", "number", "filtering", "How much water actually went through the filter.", { requiredAt: "research_ready", units: ["millilitre", "litre"], unitRequiredAt: "research_ready", min: 0 }),
    f("filterPoreSize", "Filter pore size", "number", "filtering", "The filter's pore size, such as 0.45 µm.", { requiredAt: "research_ready", units: ["micrometre"], unitRequiredAt: "research_ready", min: 0 }),
    f("preservative", "Preservative", "enum", "storage", "What you added to keep the DNA, or how you kept it cold.", { requiredAt: "research_ready", vocabulary: LANE_PRESERVATIVES }),
    f("storageTemperature", "Storage temperature", "number", "storage", "The temperature it was stored at.", { units: ["degree_celsius"], unitRequiredAt: "research_ready", min: -273.15 }),
    f("chilledAt", "Time put on ice", "datetime", "storage", "When the sample went on ice or into the fridge or freezer, with time zone.", { example: "2026-10-22T10:40:00+11:00" }),
    f("controlsTaken", "Controls in this batch", "string_array", "controls", "The blanks and controls taken with this batch. Without a field blank, results can't rule out contamination.", { requiredAt: "research_ready", vocabulary: ["field_blank", "extraction_blank", "pcr_negative", "positive_control", "none"] }),
    f("negativeControlType", "Negative control type", "enum", "controls", "For a negative control, what it was.", { vocabulary: LANE_NEGATIVE_CONTROL_TYPES }),
    f("controlBatchId", "Batch ID", "string", "controls", "An ID that links samples and blanks taken together."),
    f("nucleicAcidExtraction", "DNA extraction", "string", "laboratory", "The extraction kit or protocol."),
    f("targetGene", "Target gene", "enum", "laboratory", "The gene region amplified, such as 12S rRNA or COI.", { vocabulary: LANE_TARGET_GENES }),
    f("targetSubfragment", "Target subfragment", "string", "laboratory", "The region within the gene, such as V4.", { example: "V4" }),
    f("pcrPrimerNameForward", "Forward primer name", "string", "laboratory", "The forward primer's published name."),
    f("pcrPrimerForward", "Forward primer sequence", "string", "laboratory", "The forward primer sequence, 5' to 3', in IUPAC letters.", { pattern: "^[ACGTURYSWKMBDHVNIacgturyswkmbdhvni]+$", example: "GTCGGTAAAACTCGTGCCAGC" }),
    f("pcrPrimerNameReverse", "Reverse primer name", "string", "laboratory", "The reverse primer's published name."),
    f("pcrPrimerReverse", "Reverse primer sequence", "string", "laboratory", "The reverse primer sequence, 5' to 3', in IUPAC letters.", { pattern: "^[ACGTURYSWKMBDHVNIacgturyswkmbdhvni]+$", example: "CATAGTGGGGTATCTAATCCCAGTTTG" }),
    f("pcrPrimerReference", "Primer reference", "string", "laboratory", "A DOI or citation for the primers."),
    f("sequenceIdentifier", "Sequence identifier", "identifier", "sequence", "An identifier for the sequence or sequence set, once there is one.", { requiredAt: "research_ready" }),
    f("moleculeType", "Molecule type", "enum", "sequence", "DNA, RNA or another molecule.", { requiredAt: "research_ready", vocabulary: ["DNA", "RNA", "cDNA", "other", "unknown"] }),
    f("bioSampleId", "BioSample accession", "identifier", "accessions", "The INSDC BioSample accession, such as SAMEA1234567, once registered.", { pattern: LANE_INSDC_BIOSAMPLE_PATTERN, example: "SAMEA1234567" }),
    f("sequenceAccessions", "Sequence accessions", "string_array", "accessions", "Study, sample, experiment or run accessions, such as PRJEB12345 or ERR1234567. Treat them as the collector's assertion until checked.", { pattern: LANE_INSDC_ACCESSION_PATTERN, example: "[\"PRJEB12345\", \"ERR1234567\"]" }),
    f("libraryPreparation", "Library preparation", "string", "laboratory", "The library preparation or amplification method.", { requiredAt: "research_ready" }),
    f("platform", "Sequencing platform", "string", "laboratory", "The sequencing instrument or platform.", { requiredAt: "research_ready" }),
    f("readLayout", "Read layout", "enum", "sequence", "Single or paired reads. Choose other for long reads.", { vocabulary: LANE_READ_LAYOUTS }),
    f("referenceDatabase", "Reference database", "string", "analysis", "The reference database and version used to assign names."),
    f("sequenceQuality", "Sequence quality", "string", "quality", "Quality summary, thresholds and the quality files you kept.", { requiredAt: "research_ready" }),
    f("contaminationScreen", "Contamination check", "string", "quality", "What you checked for contamination, what you found in the blanks, and what you didn't check."),
    f("analysisWorkflow", "Analysis workflow", "string", "analysis", "The pipeline, software versions and settings.", { requiredAt: "research_ready" }),
    f("sopReference", "Protocol (SOP)", "uri", "laboratory", "A link or DOI for your standard operating procedure."),
  ],
  qualityChecks: {
    ...baseLaneChecks, ...locationChecks,
    positiveValues: ["coordinateUncertaintyM", "volumeFiltered", "filterPoreSize"],
    orderedPairs: [["volumeFiltered", "volumeCollected"]],
    conditional: [
      { when: { field: "sampleCategory", in: ["negative_control"] }, from: "research_ready", require: ["negativeControlType"], message: "Say what the negative control was." },
      { when: { field: "sequenceType", in: ["amplicon", "metabarcoding", "barcode"] }, from: "research_ready", require: ["targetGene", "pcrPrimerForward", "pcrPrimerReverse"], message: "Amplicon work needs the target gene and both primer sequences." },
    ],
  },
};

const microscopyImageV1_1: ApplicationProfile = {
  id: "clio.profile.microscopy-image", version: "1.1.0", title: "Microscopy image",
  description: "A micrograph with what the specimen is, how it was prepared, the optics, and a calibrated scale.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_REMBI, STANDARD_OME],
  fields: [...commonFieldsV1_1,
    f("specimenIdentifier", "Specimen or slide ID", "identifier", "material", "The ID that links the image to the specimen, slide or sample.", { requiredAt: "referenceable" }),
    f("specimenKind", "What kind of specimen?", "enum", "material", "Biological, mineral or rock, or another material.", { requiredAt: "referenceable", vocabulary: LANE_MICROSCOPY_SPECIMEN_KINDS }),
    f("organismScientificName", "Organism", "string", "biosample", "For a biological specimen, the organism's scientific name at any level.", { example: "Eucalyptus" }),
    f("organismNcbiTaxonId", "NCBI Taxonomy ID", "identifier", "biosample", "The organism's NCBI Taxonomy number, if you know it.", { pattern: "^[0-9]+$", example: "3932" }),
    f("biologicalEntity", "Tissue, cell or part", "string", "biosample", "What part of the organism is shown, such as leaf section, pollen grains or blood cells."),
    f("samplePreparation", "How the sample was prepared", "string", "preparation", "Fixing, staining, sectioning and mounting, in a sentence or two.", { requiredAt: "research_ready" }),
    f("stain", "Stain or label", "string", "preparation", "The stain, dye or fluorescent label, or 'none'."),
    f("mountant", "Mountant", "string", "preparation", "What the specimen is mounted in, if anything."),
    f("scaleEvidence", "How the image shows scale", "enum", "calibration", "A photo of a stage micrometer, a scale bar in the image, scale in the file's metadata, or no scale yet.", { requiredAt: "referenceable", vocabulary: LANE_SCALE_EVIDENCE }),
    f("microscopeManufacturer", "Microscope maker", "string", "acquisition", "Who made the microscope or imaging system.", { requiredAt: "research_ready" }),
    f("microscopeModel", "Microscope model", "string", "acquisition", "The model, and phone or camera adapter if you used one.", { requiredAt: "research_ready" }),
    f("objectiveMagnification", "Objective magnification", "number", "acquisition", "The objective lens you used, such as 40. Don't multiply by the eyepiece.", { requiredAt: "research_ready", units: ["times"], unitRequiredAt: "research_ready", min: 1 }),
    f("numericalAperture", "Numerical aperture (NA)", "number", "acquisition", "The NA printed on the objective, such as 0.65.", { min: 0.01, max: 1.7 }),
    f("objectiveImmersion", "Immersion", "enum", "acquisition", "Air, oil, water and so on.", { vocabulary: LANE_OBJECTIVE_IMMERSION }),
    f("cameraModel", "Camera or phone", "string", "acquisition", "The camera or phone that took the picture."),
    f("illumination", "Light source", "string", "acquisition", "The light source and settings.", { requiredAt: "research_ready" }),
    f("imagingMethod", "Imaging method", "enum", "acquisition", "Brightfield, phase contrast, DIC, fluorescence and so on.", { requiredAt: "research_ready", vocabulary: LANE_IMAGING_METHODS }),
    f("imagingMethodTermIri", "Imaging method ontology IRI", "uri", "acquisition", "If you know it, the ontology IRI for the method, for example an FBbi term from the EBI Ontology Lookup Service."),
    f("contrastMethod", "Contrast notes", "string", "acquisition", "Anything about contrast the method list doesn't cover."),
    f("imagingChannels", "Channels", "json", "acquisition", "For fluorescence or multi-channel images, one entry per channel: name, fluorophore, excitationNm, emissionNm.", { example: "[{ \"name\": \"DAPI\", \"excitationNm\": 358, \"emissionNm\": 461 }]" }),
    f("pixelSize", "Pixel size", "number", "calibration", "The real size one pixel shows. Two-point method: photograph a stage micrometer or scale bar with the same lens and zoom, measure a known length in pixels, then divide the length by the pixels.", { requiredAt: "research_ready", units: ["nanometre", "micrometre", "millimetre"], unitRequiredAt: "research_ready", min: 0 }),
    f("pixelSizeCalibrationMethod", "How you worked out pixel size", "enum", "calibration", "A stage micrometer is best. Recalibrate whenever you change objective, zoom or phone position.", { requiredAt: "research_ready", vocabulary: LANE_CALIBRATION_METHODS }),
    f("calibrationTarget", "Calibration target", "string", "calibration", "The stage micrometer, scale bar or other reference you used."),
    f("zStep", "Z step", "number", "calibration", "Spacing between focus planes in a stack.", { units: ["nanometre", "micrometre"], unitRequiredAt: "research_ready", min: 0 }),
    f("imagePlane", "Image plane", "enum", "acquisition", "One focus plane, a stack, a merged projection or a montage. A merged image isn't a measurement stack.", { vocabulary: ["single_plane", "stack", "maximum_projection", "orthogonal_projection", "montage", "unknown"] }),
    f("exposureMilliseconds", "Exposure (ms)", "number", "acquisition", "Camera exposure, in milliseconds.", { min: 0 }),
    f("bitDepth", "Bit depth", "integer", "acquisition", "Bits per pixel per channel, such as 8 or 16.", { min: 1, max: 64 }),
  ],
  qualityChecks: {
    ...baseLaneChecks,
    positiveValues: ["pixelSize", "zStep"],
    conditional: [
      { when: { field: "specimenKind", in: ["biological"] }, from: "research_ready", require: ["organismScientificName", "biologicalEntity"], message: "For a biological specimen, add the organism and the part shown." },
      { when: { field: "scaleEvidence", in: ["no_scale"] }, from: "research_ready", restrict: { field: "pixelSizeCalibrationMethod", in: ["nominal_from_magnification", "none"] }, message: "With no scale in the image, the pixel size can only be nominal. Add a micrometer or scale-bar photo to calibrate it." },
    ],
  },
};

const pollenImageCalibrationsV1_2 = f("pollenImageCalibrations", "Per-image calibration and focus stack", "json", "imaging", "One entry per image, keyed by mediaOrdinal or mediaObjectId, with micrometresPerPixel or the two calibration distances. Two-point method: click both ends of a known length on a micrometer or scale bar and record the pixels and micrometres.", { example: "[{ \"mediaOrdinal\": 0, \"micrometresPerPixel\": 0.15, \"imageView\": \"polar\" }]" });

const pollenFieldPalaeoV1_1: ApplicationProfile = {
  id: "clio.profile.pollen-field-aerobiological-palaeo-sample", version: "1.1.0", title: "Pollen field, aerobiological, or palaeo sample",
  description: "A pollen sample from a place, trap or sediment depth, with depth and datum, structured age, and calibrated images.",
  status: "launchable", launchable: true, conformanceClaim: "none", standardReferences: [STANDARD_DWC, STANDARD_EML, STANDARD_NEOTOMA],
  fields: [...commonFieldsV1_1, ...eventLocationFields("research_ready"),
    f("sampleType", "Kind of sample", "enum", "material", "Field, air trap, surface, sediment, palaeo, ice, honey or other.", { requiredAt: "draft", vocabulary: ["field", "aerobiological", "surface", "sediment", "palaeo", "ice", "honey", "other"] }),
    f("sampleIdentifier", "Sample ID", "identifier", "material", "The ID for the sample or subsample.", { requiredAt: "referenceable" }),
    f("coreIdentifier", "Core or section ID", "identifier", "material", "For a core, the core or section ID."),
    f("sampleCollectedOn", "Collection date", "date", "event", "The date you collected the sample or the trap interval began.", { requiredAt: "referenceable", example: "2026-10-22" }),
    f("collectionMethod", "How you collected it", "string", "collection", "Trap, corer, surface scrape, filter or other method.", { requiredAt: "referenceable" }),
    f("depositionalContext", "Setting", "string", "context", "The sediment, surface, trap or other setting that affects interpretation.", { requiredAt: "research_ready" }),
    f("depthDatum", "Depth measured from", "enum", "depth", "The surface depths are measured from, such as the sediment surface or the top of the core.", { vocabulary: LANE_DEPTH_DATUMS }),
    f("sampleDepth", "Depth (midpoint)", "number", "depth", "Depth of the sample's middle below the stated surface.", { units: ["millimetre", "centimetre", "metre"], unitRequiredAt: "research_ready", min: 0, sensitivity: "sensitive" }),
    f("sampleThickness", "Thickness", "number", "depth", "Thickness of the sampled slice.", { units: ["millimetre", "centimetre", "metre"], unitRequiredAt: "research_ready", min: 0 }),
    f("sampleDepthTop", "Top depth", "number", "depth", "Depth of the top of the slice. Use with bottom depth instead of midpoint and thickness if you prefer.", { units: ["millimetre", "centimetre", "metre"], unitRequiredAt: "research_ready", min: 0, sensitivity: "sensitive" }),
    f("sampleDepthBottom", "Bottom depth", "number", "depth", "Depth of the bottom of the slice.", { units: ["millimetre", "centimetre", "metre"], unitRequiredAt: "research_ready", min: 0, sensitivity: "sensitive" }),
    f("processingMethod", "Lab processing", "string", "preparation", "Concentration, sieving, acetolysis or other treatment.", { requiredAt: "research_ready" }),
    f("countingProtocol", "How you counted", "string", "analysis", "How you counted, subsampled or excluded grains.", { requiredAt: "research_ready" }),
    f("grainsCounted", "Grains counted", "integer", "analysis", "Total grains counted.", { min: 0 }),
    f("pollenConcentration", "Pollen concentration", "number", "analysis", "Concentration, with its unit.", { units: ["grains_per_gram", "grains_per_cubic_centimetre", "grains_per_cubic_metre"], unitRequiredAt: "research_ready", min: 0 }),
    f("ageType", "Age type", "enum", "age", "Radiocarbon years BP, calibrated years BP (before 1950), or a calendar year.", { vocabulary: LANE_AGE_TYPES }),
    f("ageValue", "Age", "number", "age", "The age in the units of the age type. Never invent one; leave blank if you don't know."),
    f("ageUncertainty", "Age uncertainty", "number", "age", "Plus or minus, in the same units.", { min: 0 }),
    f("ageControl", "Age based on", "string", "age", "The dating behind the age: radiocarbon samples, tephra, an age model and so on."),
    f("ageModel", "Age model", "string", "age", "The age model or dating method, with its uncertainty."),
    f("subsampleRelationship", "Parent sample", "string", "provenance", "How this relates to a parent core, trap interval or bulk sample."),
    f("pollenMicroscopeConfiguration", "Microscope set-up", "string", "imaging", "Microscope, objective, camera and how the images were taken."),
    pollenImageCalibrationsV1_2,
  ],
  qualityChecks: {
    ...baseLaneChecks, ...locationChecks,
    positiveValues: ["coordinateUncertaintyM", "sampleThickness"],
    orderedPairs: [["sampleDepthTop", "sampleDepthBottom"]],
    conditional: [
      { when: { field: "sampleType", in: ["sediment", "palaeo", "ice"] }, from: "research_ready", require: ["depthDatum"], message: "Say which surface the depth is measured from." },
      { when: { field: "sampleType", in: ["sediment", "palaeo", "ice"] }, from: "research_ready", requireAny: ["sampleDepth", "sampleDepthTop"], message: "Add a midpoint depth, or top and bottom depths." },
      { when: { field: "ageType", in: ["radiocarbon_years_bp", "calibrated_years_bp", "calendar_year_ad_bc"] }, require: ["ageValue"], message: "Add the age value, or clear the age type." },
    ],
  },
};

const pollenReferenceSlideProfileV1_2 = ((): ApplicationProfile => {
  const replaced = new Map<string, FieldDefinition>([
    ...commonFieldsV1_1.map((field) => [field.key, field] as const),
    ...biologicalFieldsV1_1.map((field) => [field.key, field] as const),
    ["pollenImageCalibrations", { ...pollenImageCalibrationsV1_2, requiredAt: "research_ready" as const }],
    ["mountant", f("mountant", "Mountant", "string", "preparation", "What the slide is mounted in, in your words.", { requiredAt: "research_ready" })],
  ]);
  const fields = pollenReferenceSlideProfileV1_1.fields.map((field) => replaced.get(field.key) ?? field);
  const added = [...commonFieldsV1_1, ...biologicalFieldsV1_1].filter((field) => !fields.some((existing) => existing.key === field.key));
  return {
    ...pollenReferenceSlideProfileV1_1,
    version: "1.2.0",
    description: "A modern pollen reference slide with provenance, morphology, a controlled mountant and calibrated images for each picture.",
    fields: [...fields, ...added,
      f("pollenMountantType", "Mountant type", "enum", "preparation", "Glycerol, glycerol jelly, silicone oil or other. This matches the Global Pollen Project's choices.", { vocabulary: LANE_POLLEN_MOUNTANTS }),
    ],
    qualityChecks: { ...baseLaneChecks },
  };
})();

const LANE_PROFILES: readonly ApplicationProfile[] = Object.freeze([
  biologicalOccurrenceV1_1,
  structuredSurveyV1_1,
  materialSampleV1_1,
  pollenReferenceSlideProfileV1_2,
  pollenFieldPalaeoV1_1,
  microscopyImageV1_1,
  geologicalSampleV1_1,
  astronomyImageV1_1,
  calibratedAstronomyV1_1,
  variableStarObservationV1,
  meteorFireballReportV1,
  sequenceSampleV1_1,
].map(freezeProfile));

const latestById = new Map(LANE_PROFILES.map((profile) => [profile.id, profile]));
const NEW_PROFILE_IDS_AFTER: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "clio.profile.calibrated-astronomy-observation": Object.freeze(["clio.profile.variable-star-observation", "clio.profile.meteor-fireball-report"]),
});

const CURRENT_PROFILES: readonly ApplicationProfile[] = Object.freeze(PROFILES.flatMap((profile) => [
  latestById.get(profile.id) ?? profile,
  ...(NEW_PROFILE_IDS_AFTER[profile.id] ?? []).map((id) => latestById.get(id)!),
]));
const ALL_PROFILES: readonly ApplicationProfile[] = Object.freeze([...PROFILES, pollenReferenceSlideProfileV1_1, ...LANE_PROFILES]);

/** The frozen current registry. Historical versions are available by exact lookup. */
export const APPLICATION_PROFILES: readonly ApplicationProfile[] = CURRENT_PROFILES;

export const APPLICATION_PROFILE_IDS: Readonly<Record<string, string>> = Object.freeze({
  GENERAL_OBSERVATION: "clio.profile.general-observation",
  BIOLOGICAL_OCCURRENCE: "clio.profile.biological-occurrence",
  STRUCTURED_SURVEY: "clio.profile.structured-survey",
  MATERIAL_SAMPLE: "clio.profile.material-sample",
  POLLEN_REFERENCE_SLIDE: "clio.profile.pollen-reference-slide",
  POLLEN_FIELD_AEROBIOLOGICAL_PALAEO_SAMPLE: "clio.profile.pollen-field-aerobiological-palaeo-sample",
  MICROSCOPY_IMAGE: "clio.profile.microscopy-image",
  GEOLOGICAL_SAMPLE: "clio.profile.geological-sample",
  ASTRONOMY_IMAGE: "clio.profile.astronomy-image",
  CALIBRATED_ASTRONOMY_OBSERVATION: "clio.profile.calibrated-astronomy-observation",
  VARIABLE_STAR_OBSERVATION: "clio.profile.variable-star-observation",
  METEOR_FIREBALL_REPORT: "clio.profile.meteor-fireball-report",
  COLLECTION_DESCRIPTION: "clio.profile.collection-description",
  SEQUENCE_SAMPLE: "clio.profile.sequence-sample",
});

export const APPLICATION_PROFILE_VERSIONS: Readonly<Record<string, string>> = Object.freeze(
  CURRENT_PROFILES.reduce<Record<string, string>>((versions, profile) => {
    versions[profile.id] = profile.version;
    return versions;
  }, {}),
);

export function listApplicationProfiles(options: { includeUnsupported?: boolean; includeHistorical?: boolean } = {}): readonly ApplicationProfile[] {
  const profiles = options.includeHistorical === true ? ALL_PROFILES : CURRENT_PROFILES;
  return profiles.filter((profile) => options.includeUnsupported === true || profile.launchable);
}

export function findApplicationProfile(profileId: string, version?: string): ApplicationProfile | undefined {
  const profiles = version === undefined ? CURRENT_PROFILES : ALL_PROFILES;
  return profiles.find((profile) => profile.id === profileId && (version === undefined || profile.version === version));
}

/**
 * Stable (key-sorted) JSON of a profile definition, used for digests and
 * snapshot tests. It makes no standards-conformance claim.
 */
export function canonicalApplicationProfileDefinition(profile: ApplicationProfile): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]));
    }
    return value;
  };
  return JSON.stringify(normalize(profile));
}

export function readinessRank(level: ReadinessLevel): number {
  return READINESS_RANK[level];
}

type UnwrappedField = Readonly<{ value: unknown; assertion?: FieldAssertion; unit?: unknown }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

const IMAGING_CHANNEL_KEYS = new Set(["name", "fluorophore", "contrastMethod", "excitationNm", "emissionNm", "exposureMs", "notes"]);

/** Bounded per-channel descriptions for fluorescence or multi-channel images (lane 1.1). */
export function isImagingChannels(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false;
  return value.every((item) => isPlainObject(item)
    && Object.keys(item).length > 0
    && Object.entries(item).every(([key, entry]) => IMAGING_CHANNEL_KEYS.has(key) && (
      ["excitationNm", "emissionNm", "exposureMs"].includes(key)
        ? typeof entry === "number" && Number.isFinite(entry) && entry > 0
        : typeof entry === "string" && entry.trim().length > 0 && entry.length <= 500)));
}

/** IMO three-letter shower codes mapped to non-negative counts (meteor report 1.0). */
export function isMeteorShowerCounts(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= 100
    && entries.every(([code, count]) => /^[A-Z]{3}$/u.test(code) && typeof count === "number" && Number.isInteger(count) && count >= 0);
}

function unwrapField(value: unknown): UnwrappedField {
  if (!isPlainObject(value) || !("value" in value)) return { value };
  const allowed = new Set(["value", "source", "uncertainty", "visibility", "unit", "method"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { value };
  return { value: value.value, unit: value.unit, assertion: value as FieldAssertion };
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "") || (Array.isArray(value) && value.length === 0);
}

function finding(code: ValidationFinding["code"], message: string, field?: string, expected?: string, actual?: string, severity: ValidationSeverity = "error"): ValidationFinding {
  return { code, severity, ...(field === undefined ? {} : { field }), message, ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) };
}

function validateAssertion(field: FieldDefinition, raw: UnwrappedField): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const assertion = raw.assertion;
  if (!assertion) return findings;
  if (assertion.source !== undefined && (typeof assertion.source !== "string" || assertion.source.trim() === "")) {
    findings.push(finding("invalid_assertion", "Assertion source must be a non-empty string.", field.key, "non-empty string"));
  }
  if (assertion.method !== undefined && (typeof assertion.method !== "string" || assertion.method.trim() === "")) {
    findings.push(finding("invalid_assertion", "Assertion method must be a non-empty string.", field.key, "non-empty string"));
  }
  if (assertion.visibility !== undefined && !["public", "sensitive", "restricted"].includes(assertion.visibility)) {
    findings.push(finding("invalid_visibility", "Assertion visibility is not recognised.", field.key, "public | sensitive | restricted", String(assertion.visibility)));
  } else if (assertion.visibility !== undefined) {
    const sensitivityRank: Record<FieldSensitivity, number> = { public: 0, sensitive: 1, restricted: 2 };
    if (sensitivityRank[assertion.visibility] < sensitivityRank[field.sensitivity]) {
      findings.push(finding("invalid_visibility", "This field cannot be made more public than its declared sensitivity.", field.key, field.sensitivity, assertion.visibility));
    }
  }
  if (assertion.uncertainty !== undefined && assertion.uncertainty === null) {
    findings.push(finding("invalid_assertion", "Assertion uncertainty cannot be null.", field.key));
  }
  return findings;
}

function validateField(field: FieldDefinition, rawValue: unknown, readiness: ReadinessLevel, licenceUri: string): ValidationFinding[] {
  const raw = unwrapField(rawValue);
  const findings = validateAssertion(field, raw);
  const value = raw.value;
  const actual = typeof value;
  const expectedType = field.datatype;

  if (raw.assertion && raw.assertion.unit !== undefined && field.units === undefined) {
    findings.push(finding("invalid_unit", "This field does not accept a unit.", field.key, "no unit", String(raw.assertion.unit)));
  }
  if (field.units !== undefined) {
    const unit = raw.unit;
    if (unit !== undefined && (!field.units.includes(String(unit)) || typeof unit !== "string" || unit.trim() === "")) {
      findings.push(finding("invalid_unit", "Unit is not in this profile's vocabulary.", field.key, field.units.join(" | "), String(unit)));
    }
    if (field.unitRequiredAt !== undefined && readinessRank(field.unitRequiredAt) <= readinessRank(readiness)) {
      if (unit === undefined || typeof unit !== "string" || unit.trim() === "") findings.push(finding("missing_unit", "A unit is required at this readiness level.", field.key, field.units.join(" | ")));
    }
  }

  let typeValid = true;
  switch (field.datatype) {
    case "string":
    case "identifier":
    case "uri":
    case "date":
    case "date_or_interval":
    case "datetime":
    case "enum":
      typeValid = typeof value === "string";
      break;
    case "integer":
      typeValid = typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
      break;
    case "number":
    case "latitude":
    case "longitude":
      typeValid = typeof value === "number" && Number.isFinite(value);
      break;
    case "boolean":
      typeValid = typeof value === "boolean";
      break;
    case "string_array":
      typeValid = Array.isArray(value) && value.every((item) => typeof item === "string");
      break;
    case "number_array":
      typeValid = Array.isArray(value) && value.every((item) => typeof item === "number" && Number.isFinite(item));
      break;
    case "json":
      typeValid = isJsonValue(value);
      break;
  }
  if (!typeValid) {
    findings.push(finding("invalid_datatype", "Value does not match the field datatype.", field.key, expectedType, actual));
    return findings;
  }

  if ((field.datatype === "uri" || field.datatype === "identifier") && typeof value === "string" && value.trim() === "") {
    findings.push(finding("invalid_datatype", "Identifier or URI cannot be blank.", field.key, expectedType));
  }
  if (field.datatype === "uri" && typeof value === "string") {
    try {
      const parsed = new URL(value);
      if (!parsed.protocol || !parsed.hostname) throw new Error("incomplete");
    } catch {
      findings.push(finding("invalid_datatype", "Value must be an absolute URI.", field.key, "absolute URI", value));
    }
  }
  if (field.datatype === "date" && typeof value === "string" && !isCalendarDate(value)) {
    findings.push(finding("invalid_datatype", "Date must use YYYY-MM-DD.", field.key, "YYYY-MM-DD", value));
  }
  if (field.datatype === "date_or_interval" && typeof value === "string") {
    const parts = value.split("/");
    const valid = (parts.length === 1 && isCalendarDate(parts[0]!))
      || (parts.length === 2 && isCalendarDate(parts[0]!) && isCalendarDate(parts[1]!) && parts[0]! <= parts[1]!);
    if (!valid) findings.push(finding("invalid_datatype", "Date must use YYYY-MM-DD or a closed YYYY-MM-DD/YYYY-MM-DD interval.", field.key, "date or closed date interval", value));
  }
  if (field.datatype === "datetime" && typeof value === "string" && (Number.isNaN(Date.parse(value)) || !/[T ]/.test(value))) {
    findings.push(finding("invalid_datatype", "Datetime must be an ISO-like date-time.", field.key, "ISO date-time", value));
  }
  if (field.key === "imagingChannels" && !isImagingChannels(value)) {
    findings.push(finding("invalid_datatype", "Channels must be a list of up to 64 channel descriptions.", field.key, "imaging channel array"));
  }
  if (field.key === "meteorShowerCounts" && !isMeteorShowerCounts(value)) {
    findings.push(finding("invalid_datatype", "Shower counts must map three-letter IMO shower codes to whole numbers.", field.key, "shower-count object"));
  }
  if (field.key === "pollenImageCalibrations" && !isPollenImageCalibrations(value)) {
    findings.push(finding("invalid_datatype", "Pollen image calibrations must be a bounded array of media-linked calibration or focus-stack objects.", field.key, "pollen image calibration array"));
  }
  if (field.key === "rightsLicense" && value !== licenceUri) {
    findings.push(finding("licence_policy_mismatch", `Records use the licence ${licenceUri}.`, field.key, licenceUri, typeof value === "string" ? value : undefined));
  }
  if (field.vocabulary !== undefined && typeof value === "string" && !field.vocabulary.includes(value)) {
    findings.push(finding("invalid_enum", "Value is not in this field's vocabulary.", field.key, field.vocabulary.join(" | "), value));
  }
  if (field.vocabulary !== undefined && field.datatype === "string_array" && Array.isArray(value)) {
    const invalid = value.filter((item) => typeof item === "string" && !field.vocabulary!.includes(item));
    if (invalid.length > 0) findings.push(finding("invalid_enum", "One or more values are not in this field's vocabulary.", field.key, field.vocabulary.join(" | "), invalid.join(" | ")));
  }
  if (field.datatype === "latitude" && typeof value === "number" && (value < -90 || value > 90)) {
    findings.push(finding("out_of_range", "Latitude must be between -90 and 90.", field.key, "-90..90", String(value)));
  }
  if (field.datatype === "longitude" && typeof value === "number" && (value < -180 || value > 180)) {
    findings.push(finding("out_of_range", "Longitude must be between -180 and 180.", field.key, "-180..180", String(value)));
  }
  if (typeof value === "number") {
    if (field.min !== undefined && value < field.min) findings.push(finding("out_of_range", "Value is below the permitted minimum.", field.key, `>= ${field.min}`, String(value)));
    if (field.max !== undefined && value > field.max) findings.push(finding("out_of_range", "Value is above the permitted maximum.", field.key, `<= ${field.max}`, String(value)));
  }
  return findings;
}

export type ProfileValidationOptions = Readonly<{
  /** Reference instant for future-date checks; defaults to the current time. */
  now?: Date;
  /** The licence URI `rightsLicense` must equal. Default: CC BY 4.0. */
  licenceUri?: string;
}>;

const TIME_ZONE_SUFFIX = /(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/iu;
/** Allow for the furthest-ahead civil time zone (UTC+14) before calling a calendar date future. */
const FUTURE_DATE_GRACE_MS = 14 * 60 * 60 * 1000;
/** Allow for ordinary device clock skew before calling an instant future. */
const FUTURE_INSTANT_GRACE_MS = 10 * 60 * 1000;

function presentValue(data: Record<string, unknown>, key: string): unknown {
  const value = unwrapField(data[key]).value;
  return isBlank(value) ? undefined : value;
}

function sameValue(left: unknown, candidates: readonly (string | boolean)[]): boolean {
  return (typeof left === "string" || typeof left === "boolean") && candidates.includes(left);
}

function locationExemptFields(profile: ApplicationProfile, data: Record<string, unknown>): ReadonlySet<string> {
  const exemption = profile.qualityChecks?.locationExemption;
  if (!exemption) return new Set();
  const treatment = presentValue(data, exemption.field);
  return typeof treatment === "string" && exemption.values.includes(treatment) ? new Set(exemption.fields) : new Set();
}

/**
 * Lane 1.1 checks. They run only for profiles that declare `qualityChecks`,
 * so 1.0.0 profiles and pollen reference slide 1.1.0 validate as before.
 */
function laneQualityFindings(profile: ApplicationProfile, data: Record<string, unknown>, readiness: ReadinessLevel, now: Date): ValidationFinding[] {
  const checks = profile.qualityChecks;
  if (!checks) return [];
  const findings: ValidationFinding[] = [];
  const severity: ValidationSeverity = readinessRank(readiness) >= readinessRank(checks.errorFrom) ? "error" : "warning";
  const add = (code: ValidationFinding["code"], message: string, field: string, expected?: string, actual?: string) =>
    findings.push(finding(code, message, field, expected, actual, severity));
  const fieldsByKey = new Map(profile.fields.map((field) => [field.key, field]));

  for (const field of profile.fields) {
    const value = presentValue(data, field.key);
    if (value === undefined) continue;
    if (checks.enforcePatterns && field.pattern !== undefined) {
      const pattern = new RegExp(field.pattern, "u");
      const items = Array.isArray(value) ? value : [value];
      const invalid = items.filter((item) => typeof item === "string" && !pattern.test(item));
      if (invalid.length > 0) add("invalid_format", "Value does not match the expected format.", field.key, field.example ?? field.pattern, invalid.map(String).join(" | "));
    }
    if (checks.requireTimeZoneOffset && field.datatype === "datetime" && typeof value === "string" && !Number.isNaN(Date.parse(value)) && !TIME_ZONE_SUFFIX.test(value.trim())) {
      add("missing_time_zone", "Add a time zone: end with Z for UTC or an offset such as +11:00.", field.key, "date-time ending in Z or an offset", value);
    }
    if (checks.rejectFutureDates && typeof value === "string") {
      if (field.datatype === "datetime") {
        const instant = Date.parse(value);
        if (!Number.isNaN(instant) && instant > now.getTime() + FUTURE_INSTANT_GRACE_MS) add("future_date", "This date and time is in the future.", field.key, "not in the future", value);
      } else if (field.datatype === "date" || field.datatype === "date_or_interval") {
        const latestCalendarDay = new Date(now.getTime() + FUTURE_DATE_GRACE_MS).toISOString().slice(0, 10);
        if (value.split("/").some((part) => isCalendarDate(part) && part > latestCalendarDay)) add("future_date", "This date is in the future.", field.key, `on or before ${latestCalendarDay}`, value);
      }
    }
  }

  for (const key of checks.positiveValues ?? []) {
    const value = presentValue(data, key);
    if (typeof value === "number" && Number.isFinite(value) && value <= 0) add("not_positive", "Enter a value greater than zero.", key, "> 0", String(value));
  }

  for (const [latitudeKey, longitudeKey] of checks.coordinatePairs ?? []) {
    const latitude = presentValue(data, latitudeKey);
    const longitude = presentValue(data, longitudeKey);
    if ((latitude === undefined) !== (longitude === undefined)) {
      add("incomplete_pair", "Enter both latitude and longitude, or leave both blank.", latitude === undefined ? latitudeKey : longitudeKey, `${latitudeKey} and ${longitudeKey}`);
    } else if (latitude === 0 && longitude === 0) {
      add("coordinate_implausible", "0, 0 is in the ocean off West Africa. Check the latitude and longitude.", latitudeKey, "a real location", "0, 0");
    }
  }

  for (const [lowerKey, upperKey] of checks.orderedPairs ?? []) {
    const lower = unwrapField(data[lowerKey]);
    const upper = unwrapField(data[upperKey]);
    if (isBlank(lower.value) || isBlank(upper.value)) continue;
    const lowerField = fieldsByKey.get(lowerKey);
    let reversed = false;
    if (typeof lower.value === "number" && typeof upper.value === "number" && (lower.unit === undefined || upper.unit === undefined || lower.unit === upper.unit)) reversed = lower.value > upper.value;
    if (typeof lower.value === "string" && typeof upper.value === "string" && lowerField?.datatype === "datetime") {
      const start = Date.parse(lower.value);
      const end = Date.parse(upper.value);
      reversed = !Number.isNaN(start) && !Number.isNaN(end) && start > end;
    }
    if (reversed) add("inconsistent_values", `${fieldsByKey.get(upperKey)?.label ?? upperKey} must not come before ${lowerField?.label ?? lowerKey}.`, upperKey, `not before ${lowerKey}`);
  }

  if (checks.countStatus) {
    const count = presentValue(data, checks.countStatus.count);
    const status = presentValue(data, checks.countStatus.status);
    if (count === 0 && status === checks.countStatus.present) add("inconsistent_values", "A count of 0 conflicts with 'detected'. Which is right?", checks.countStatus.count, `more than 0 when ${checks.countStatus.present}`, "0");
    if (typeof count === "number" && count > 0 && status === checks.countStatus.absent) add("inconsistent_values", "A count above 0 conflicts with 'not detected'. Which is right?", checks.countStatus.count, `0 when ${checks.countStatus.absent}`, String(count));
  }

  for (const rule of checks.conditional ?? []) {
    if (rule.from !== undefined && readinessRank(readiness) < readinessRank(rule.from)) continue;
    if (!sameValue(presentValue(data, rule.when.field), rule.when.in)) continue;
    for (const key of rule.require ?? []) {
      if (presentValue(data, key) === undefined) add("required_field", rule.message, key, `required when ${rule.when.field} is ${rule.when.in.join(" | ")}`);
    }
    if (rule.requireAny && rule.requireAny.every((key) => presentValue(data, key) === undefined)) {
      add("required_field", rule.message, rule.requireAny[0]!, rule.requireAny.join(" | "));
    }
    if (rule.restrict) {
      const value = presentValue(data, rule.restrict.field);
      if (!sameValue(value, rule.restrict.in)) add("inconsistent_values", rule.message, rule.restrict.field, rule.restrict.in.join(" | "), value === undefined ? undefined : String(value));
    }
  }
  return findings;
}

export function validateApplicationProfileData(
  profileId: string,
  version: string,
  data: unknown,
  readiness: ReadinessLevel = "draft",
  options: ProfileValidationOptions = {},
): ProfileValidationResult {
  const findings: ValidationFinding[] = [];
  const profile = findApplicationProfile(profileId, version);
  if (!profile) {
    const registered = findApplicationProfile(profileId);
    return registered
      ? { valid: false, profileId, profileVersion: version, readiness, findings: [finding("unknown_profile_version", "Profile version is not registered for this profile ID.", undefined, APPLICATION_PROFILE_VERSIONS[profileId], version)] }
      : { valid: false, profileId, profileVersion: version, readiness, findings: [finding("unknown_profile", "Profile ID is not registered.", undefined, "registered profile ID", profileId)] };
  }
  if (profile.status !== "launchable" || !profile.launchable) {
    return { valid: false, profileId, profileVersion: version, readiness, findings: [finding("unsupported_profile", profile.unsupportedReason ?? "This profile is not launchable.")] };
  }
  if (!READINESS_LEVELS.includes(readiness)) {
    return { valid: false, profileId, profileVersion: version, readiness, findings: [finding("invalid_readiness", "Readiness level is not registered.", undefined, READINESS_LEVELS.join(" | "), readiness)] };
  }
  if (!isPlainObject(data)) {
    return { valid: false, profileId, profileVersion: version, readiness, findings: [finding("invalid_data", "Profile data must be a plain object.", undefined, "object", Array.isArray(data) ? "array" : typeof data)] };
  }

  const fieldsByKey = new Map(profile.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(data)) {
    if (!fieldsByKey.has(key)) findings.push(finding("unknown_field", "Field is not defined by this profile version.", key));
  }
  const exempt = locationExemptFields(profile, data);
  for (const field of profile.fields) {
    const rawValue = data[field.key];
    if (isBlank(unwrapField(rawValue).value)) {
      if (field.requiredAt !== undefined && readinessRank(field.requiredAt) <= readinessRank(readiness) && !exempt.has(field.key)) {
        findings.push(finding("required_field", "Required field is missing or blank at this readiness level.", field.key, field.requiredAt));
      }
      continue;
    }
    findings.push(...validateField(field, rawValue, readiness, options.licenceUri ?? DEFAULT_LICENCE_URI));
  }
  findings.push(...laneQualityFindings(profile, data, readiness, options.now ?? new Date()));
  return { valid: findings.every((item) => item.severity !== "error"), profileId, profileVersion: version, readiness, findings };
}
