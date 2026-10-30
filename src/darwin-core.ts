import {
  findApplicationProfile,
  type ApplicationProfile,
  type FieldAssertion,
  type FieldSensitivity,
} from "./application-profiles.ts";
import { LANE_OCCURRENCE_STATUS_EXPORT } from "./lane-vocabularies.ts";
import { classifyLocationVisibility, publishesLocation, type LocationVisibilityOptions } from "./location-visibility.ts";
import type { RecordEventFields, RecordFields } from "./record-fields.ts";

/**
 * The one Darwin Core reading of a record version.
 *
 * The Darwin Core Archive export (`dwca.ts`) and any other projection read
 * profile data through these tables and helpers, so they cannot drift apart.
 * A mapping is a projection of the profile's own fields. It is not a claim
 * that any repository has validated or accepted the result.
 */

export const DWC_TERMS_NAMESPACE = "http://rs.tdwg.org/dwc/terms/" as const;
export const DCTERMS_NAMESPACE = "http://purl.org/dc/terms/" as const;

export type DarwinCoreProfileTerm = Readonly<{
  /** Darwin Core term local name (the IRI is `DWC_TERMS_NAMESPACE + term`). */
  term: string;
  /** Profile data keys in priority order: the first one holding a value is used. */
  fields: readonly string[];
  /** `integer` accepts whole numbers only; the default accepts non-blank text only. */
  value?: "text" | "integer";
  /** When set, any other value is treated as absent (for example "unknown"). */
  accepts?: readonly string[];
  /** True for terms that only the archive export reads; other projections have no column for them. */
  exportOnly?: boolean;
  /** Maps a stored value to the exported term value (lane 1.1 occurrenceStatus). Unmapped values are absent. */
  map?: Readonly<Record<string, string>>;
}>;

/**
 * Occurrence and identification terms, shared by projections and the
 * archive export. Order is the column order used by the export.
 */
export const DARWIN_CORE_OCCURRENCE_TERMS: readonly DarwinCoreProfileTerm[] = Object.freeze([
  { term: "basisOfRecord", fields: ["recordBasis"] },
  { term: "catalogNumber", fields: ["slideIdentifier"], exportOnly: true },
  { term: "individualCount", fields: ["individualCount", "eventCount"], value: "integer", exportOnly: true },
  { term: "occurrenceStatus", fields: ["occurrenceStatus"], map: LANE_OCCURRENCE_STATUS_EXPORT },
  { term: "establishmentMeans", fields: ["establishmentMeans"] },
  { term: "sex", fields: ["sex"] },
  { term: "lifeStage", fields: ["lifeStage"] },
  { term: "behavior", fields: ["behaviour"] },
  { term: "preparations", fields: ["preparationMethod"], exportOnly: true },
  { term: "verbatimIdentification", fields: ["originalTaxonVerbatim", "taxonScientificName", "pollenTaxonName"], exportOnly: true },
  { term: "identificationQualifier", fields: ["taxonIdentificationQualifier"] },
  { term: "identificationReferences", fields: ["identificationBasis", "sourceReference"] },
  { term: "identificationRemarks", fields: ["identificationUncertainty"] },
  { term: "scientificName", fields: ["taxonScientificName", "pollenTaxonName"] },
  { term: "scientificNameID", fields: ["taxonConceptId"] },
  { term: "scientificNameAuthorship", fields: ["taxonAuthorship"], exportOnly: true },
  { term: "nameAccordingTo", fields: ["taxonNameAccordingTo"], exportOnly: true },
  { term: "taxonRank", fields: ["taxonomicRank"] },
  { term: "kingdom", fields: ["taxonKingdom"] },
  { term: "phylum", fields: ["taxonPhylum"] },
  { term: "class", fields: ["taxonClass"] },
  { term: "order", fields: ["taxonOrder"] },
  { term: "family", fields: ["taxonFamily"] },
  { term: "genus", fields: ["taxonGenus"] },
  { term: "specificEpithet", fields: ["taxonSpecificEpithet"] },
  { term: "infraspecificEpithet", fields: ["taxonInfraspecificEpithet"] },
  { term: "nomenclaturalCode", fields: ["taxonNomenclaturalCode"], accepts: ["ICN", "ICZN", "ICTV", "ICNP"], exportOnly: true },
].map((entry) => Object.freeze({ ...entry, fields: Object.freeze([...entry.fields]) })) as DarwinCoreProfileTerm[]);

/*
 * Lane 1.1 terms: individualCount now reads the occurrence profile's own count
 * first, occurrenceStatus is stored as detected/notDetected and exported as
 * present/absent, and establishmentMeans uses the Darwin Core vocabulary. The
 * 1.0.0 profiles have none of these fields, so their output is unchanged.
 */

/** Darwin Core `basisOfRecord` values a profile may state. */
export const DARWIN_CORE_BASIS_OF_RECORD = Object.freeze(["HumanObservation", "MachineObservation", "MaterialSample", "PreservedSpecimen", "LivingSpecimen", "FossilSpecimen", "Occurrence"] as const);

const ASSERTION_KEYS = new Set(["value", "source", "uncertainty", "visibility", "unit", "method"]);
const SENSITIVITY_RANK: Readonly<Record<FieldSensitivity, number>> = { public: 0, sensitive: 1, restricted: 2 };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Same unwrapping rule as profile validation: a value or a `FieldAssertion` wrapper. */
export function unwrapProfileAssertion(raw: unknown): Readonly<{ value: unknown; assertion?: FieldAssertion }> {
  if (!isPlainObject(raw) || !("value" in raw)) return { value: raw };
  if (Object.keys(raw).some((key) => !ASSERTION_KEYS.has(key))) return { value: raw };
  return { value: raw.value, assertion: raw as FieldAssertion };
}

/**
 * Effective visibility of one profile value: the stricter of the field's
 * declared sensitivity and any assertion visibility. A key the profile does
 * not define is treated as restricted, so an unknown field never leaks.
 */
export function effectiveFieldVisibility(profile: ApplicationProfile | undefined, key: string, assertion?: FieldAssertion): FieldSensitivity {
  const field = profile?.fields.find((candidate) => candidate.key === key);
  if (!field) return "restricted";
  const declared = field.sensitivity;
  const asserted = assertion?.visibility;
  if (asserted === undefined) return declared;
  // A visibility that is not exactly one of the three known strings (an array, a number, an object) is restricted.
  if (typeof asserted !== "string" || !Object.hasOwn(SENSITIVITY_RANK, asserted)) return "restricted";
  return SENSITIVITY_RANK[asserted] > SENSITIVITY_RANK[declared] ? asserted : declared;
}

export type ResolvedDarwinCoreValue = Readonly<{ field: string; value: string; visibility: FieldSensitivity }>;

/** Resolves one term from profile data. Returns undefined when no source field holds a usable value. */
export function resolveDarwinCoreProfileTerm(
  fields: RecordFields,
  mapping: DarwinCoreProfileTerm,
  profile: ApplicationProfile | undefined = findApplicationProfile(fields.profile.profileId, fields.profile.profileVersion),
): ResolvedDarwinCoreValue | undefined {
  const data = isPlainObject(fields.profile.data) ? fields.profile.data : {};
  for (const key of mapping.fields) {
    const { value, assertion } = unwrapProfileAssertion(data[key]);
    const text = mapping.value === "integer"
      ? (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined)
      : (typeof value === "string" && value.trim() !== "" ? value : undefined);
    if (text === undefined) continue;
    if (mapping.accepts !== undefined && !mapping.accepts.includes(text)) continue;
    const exported = mapping.map === undefined ? text : (Object.hasOwn(mapping.map, text) ? mapping.map[text] : undefined);
    if (exported === undefined) continue;
    return { field: key, value: exported, visibility: effectiveFieldVisibility(profile, key, assertion) };
  }
  return undefined;
}

/**
 * The occurrence and identification values of a record, ready for a
 * normalised table. Visibility is not applied here; the caller keeps it on
 * its own rows. The archive export applies it before writing anything.
 */
export function darwinCoreOccurrenceValues(fields: RecordFields): Readonly<Record<string, string | null>> {
  const profile = findApplicationProfile(fields.profile.profileId, fields.profile.profileVersion);
  const values: Record<string, string | null> = {};
  for (const mapping of DARWIN_CORE_OCCURRENCE_TERMS) values[mapping.term] = resolveDarwinCoreProfileTerm(fields, mapping, profile)?.value ?? null;
  return values;
}

/**
 * Reads a verbatim event date as one `YYYY-MM-DD` date or a closed
 * `start/end` interval. Anything else is not normalised (null), and the
 * verbatim text is kept separately.
 */
export function parseEventDateInterval(value: string): Readonly<{ start: string; end: string }> | null {
  const parts = value.split("/");
  const validDate = (item: string | undefined): item is string => item !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(item);
  if (parts.length === 1 && validDate(parts[0])) return { start: parts[0], end: parts[0] };
  if (parts.length === 2 && validDate(parts[0]) && validDate(parts[1]) && parts[0] <= parts[1]) return { start: parts[0], end: parts[1] };
  return null;
}

/** ISO 8601 form of a parsed event date: a single date when start and end agree. */
export function normalisedEventDate(value: string): string | null {
  const interval = parseEventDateInterval(value);
  if (!interval) return null;
  return interval.start === interval.end ? interval.start : `${interval.start}/${interval.end}`;
}

export type LocationDisclosure = Readonly<{
  /** False unless the visibility is exactly "public" or "generalized" (or missing with missingVisibility "public"): coordinates, datum and uncertainty are then withheld. */
  coordinatesPublic: boolean;
  sensitivityState: "withheld" | "generalized" | "not_sensitive";
  /** Set when the contributor declared that the supplied coordinates are already generalised. */
  generalizationMethod: string | null;
}>;

/**
 * the location-disclosure rule. Restricted locations never place
 * coordinates in a broadly queryable row; generalised coordinates are kept as
 * the contributor supplied them and labelled as generalised.
 */
export function locationDisclosure(event: Pick<RecordEventFields, "locationVisibility">, options: LocationVisibilityOptions = {}): LocationDisclosure {
  const raw: unknown = event.locationVisibility;
  const state = raw === undefined ? "missing" : classifyLocationVisibility(raw);
  const coordinatesPublic = publishesLocation(state, options);
  return {
    coordinatesPublic,
    // Anything that does not publish the place is reported as withheld, including not_collected, unrecognised values and a missing value.
    sensitivityState: !coordinatesPublic ? "withheld" : state === "generalized" ? "generalized" : "not_sensitive",
    generalizationMethod: state === "generalized" ? "contributor-declared generalisation" : null,
  };
}
