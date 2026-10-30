/**
 * The structured fields of one record, and a pure, bounded validator for them.
 *
 * This is the input shape the Darwin Core Archive and research-package
 * builders read. The validator does not authenticate anyone, inspect media
 * files, verify a signature, publish a record or contact an identifier or
 * archive provider. Profile data is validated against one immutable registry
 * version; universal fields stay outside the profile payload and are overlaid
 * for validation so they cannot diverge silently.
 */

import {
  findApplicationProfile,
  validateApplicationProfileData,
  type ReadinessLevel,
  type ValidationFinding,
} from "./application-profiles.ts";
import { DEFAULT_LICENCE_URI } from "./licensing.ts";
import { isValidOrcid } from "./orcid.ts";
import { isPollenImageCalibrations } from "./pollen-reference.ts";

/** Readiness targets a record can be checked against. `doi_ready` only names a profile's strictest field set; nothing here mints a DOI. */
export const recordReadinessLevels = ["referenceable", "research_ready", "doi_ready"] as const;
export type RecordReadiness = (typeof recordReadinessLevels)[number];

export const locationVisibilityStates = ["public", "generalized", "restricted", "not_collected"] as const;
export type LocationVisibilityState = (typeof locationVisibilityStates)[number];

export interface RecordEventFields {
  /** Verbatim date or interval, retained even when a normalized projection is produced. */
  readonly eventDate: string;
  readonly locality: string;
  readonly recordedBy: string;
  readonly method: string;
  readonly timeZone?: string;
  readonly context?: string;
  readonly habitat?: string;
  readonly samplingProtocol?: string;
  readonly samplingEffort?: string;
  readonly fieldNumber?: string;
  readonly countryCode?: string;
  readonly decimalLatitude?: number;
  readonly decimalLongitude?: number;
  readonly coordinateUncertaintyM?: number;
  readonly geodeticDatum?: string;
  readonly locationVisibility?: LocationVisibilityState;
  /** Opaque reference to restricted coordinates held elsewhere under access control. */
  readonly privateLocationObjectRef?: string;
  readonly sensitivityReasonCode?: string;
}

export const recordVersionMediaRoles = ["primary", "supporting", "derivative", "evidence"] as const;
export type RecordVersionMediaRole = (typeof recordVersionMediaRoles)[number];

export interface RecordAuthor {
  readonly ordinal: number;
  /** The author's name as it should be credited. Required unless both given and family names are supplied. */
  readonly nameLiteral?: string;
  readonly givenName?: string;
  readonly familyName?: string;
  readonly nameType?: "Personal" | "Organizational";
  /** A typed iD is asserted, not OAuth-authenticated. */
  readonly orcid?: string;
  readonly affiliationRor?: string;
  readonly roleCode?: string;
}

export interface RecordMediaReference {
  /** Your own identifier for an already-stored media object — never a raw upload payload. */
  readonly mediaObjectId: string;
  readonly ordinal: number;
  readonly caption?: string;
  readonly altText?: string;
  readonly mediaRole: RecordVersionMediaRole;
}

export interface RecordRights {
  readonly licenceUri: string;
}

export interface RecordProfileReference {
  readonly profileId: string;
  readonly profileVersion: string;
  /** A readiness assessment target; this field never requests a DOI or archive action. */
  readonly readinessTarget: RecordReadiness;
  /** Profile-specific fields only. Universal envelope keys are rejected here. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RecordFields {
  readonly title: string;
  readonly profile: RecordProfileReference;
  readonly event: RecordEventFields;
  readonly uncertaintyStatement: string;
  readonly authors: readonly RecordAuthor[];
  /** Empty is valid for a non-media observation. */
  readonly media: readonly RecordMediaReference[];
  readonly rights: RecordRights;
}

export type RecordValidationSeverity = "error" | "warning";
export interface RecordValidationFinding {
  readonly code: string;
  readonly severity: RecordValidationSeverity;
  readonly path: string;
  readonly message: string;
}

export interface RecordValidationResult {
  readonly valid: boolean;
  readonly findings: readonly RecordValidationFinding[];
  readonly profile?: {
    readonly id: string;
    readonly version: string;
    readonly readiness: RecordReadiness;
  };
}

/** Value of `schema` in a record-version document, as read by the research-package builder. */
export const RECORD_DOCUMENT_SCHEMA = "clio-record-version-canonical-v1" as const;

export interface RecordValidationOptions {
  /** The licence URI every record must state. Default: CC BY 4.0. */
  readonly licenceUri?: string;
}

const MAX_PROFILE_JSON_BYTES = 256 * 1024;
const MAX_AUTHORS = 100;
const MAX_MEDIA = 100;
const universalProfileKeys = new Set(["title", "observedOn", "locality", "observer", "description", "method", "rightsLicense", "uncertaintyNote"]);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const bounded = (value: unknown, max: number): value is string => nonEmpty(value) && value.trim().length <= max;
const optionalBounded = (value: unknown, max: number): boolean => value === undefined || bounded(value, max);
const isOrdinal = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function finding(code: string, path: string, message: string, severity: RecordValidationSeverity = "error"): RecordValidationFinding {
  return { code, path, message, severity };
}

function absoluteHttpsUri(value: unknown): boolean {
  if (!bounded(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function safeJson(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > 12) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 20_000;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.length <= 500 && value.every((item) => safeJson(item, depth + 1, seen));
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length <= 500
    && keys.every((key) => key.length <= 160 && !["__proto__", "constructor", "prototype"].includes(key) && safeJson(record[key], depth + 1, seen));
}

function validAuthor(author: unknown): author is RecordAuthor {
  if (!isPlainObject(author)) return false;
  const candidate = author as Partial<RecordAuthor>;
  const hasGivenName = bounded(candidate.givenName, 200);
  const hasFamilyName = bounded(candidate.familyName, 200);
  const validNameType = candidate.nameType === undefined || candidate.nameType === "Personal" || candidate.nameType === "Organizational";
  return isOrdinal(candidate.ordinal)
    && (bounded(candidate.nameLiteral, 500) || (hasGivenName && hasFamilyName))
    && optionalBounded(candidate.givenName, 200)
    && optionalBounded(candidate.familyName, 200)
    && hasGivenName === hasFamilyName
    && validNameType
    && !(candidate.nameType === "Organizational" && hasGivenName)
    && (candidate.orcid === undefined || isValidOrcid(candidate.orcid))
    && optionalBounded(candidate.affiliationRor, 2048)
    && optionalBounded(candidate.roleCode, 120);
}

function validMediaReference(media: unknown): media is RecordMediaReference {
  if (!isPlainObject(media)) return false;
  const candidate = media as Partial<RecordMediaReference>;
  return bounded(candidate.mediaObjectId, 256)
    && isOrdinal(candidate.ordinal)
    && typeof candidate.mediaRole === "string"
    && (recordVersionMediaRoles as readonly string[]).includes(candidate.mediaRole)
    && optionalBounded(candidate.caption, 4_000)
    && optionalBounded(candidate.altText, 4_000);
}

function validateEvent(value: unknown): RecordValidationFinding[] {
  const findings: RecordValidationFinding[] = [];
  if (!isPlainObject(value)) return [finding("event_required", "event", "An event object is required.")];
  const event = value as Partial<RecordEventFields>;
  if (!bounded(event.eventDate, 120)) findings.push(finding("event_date_required", "event.eventDate", "A bounded verbatim event date or interval is required."));
  if (!bounded(event.locality, 500)) findings.push(finding("locality_required", "event.locality", "A locality or explicit permitted generalisation is required."));
  if (!bounded(event.recordedBy, 500)) findings.push(finding("recorded_by_required", "event.recordedBy", "The observer or collector is required."));
  if (!bounded(event.method, 2_000)) findings.push(finding("method_required", "event.method", "The observation, collection or capture method is required."));
  for (const [key, item, max] of [
    ["timeZone", event.timeZone, 100], ["context", event.context, 4_000], ["habitat", event.habitat, 2_000],
    ["samplingProtocol", event.samplingProtocol, 2_000], ["samplingEffort", event.samplingEffort, 500],
    ["fieldNumber", event.fieldNumber, 200], ["geodeticDatum", event.geodeticDatum, 200],
    ["privateLocationObjectRef", event.privateLocationObjectRef, 500], ["sensitivityReasonCode", event.sensitivityReasonCode, 160],
  ] as const) if (!optionalBounded(item, max)) findings.push(finding("event_field_invalid", `event.${key}`, `The ${key} field is blank or exceeds its limit.`));
  if (event.countryCode !== undefined && !/^[A-Z]{2}$/u.test(event.countryCode)) findings.push(finding("country_code_invalid", "event.countryCode", "Country code must be a two-letter uppercase ISO code."));
  if (event.locationVisibility !== undefined && !(locationVisibilityStates as readonly string[]).includes(event.locationVisibility)) findings.push(finding("location_visibility_invalid", "event.locationVisibility", "Location visibility is not a registered state."));
  if (event.locationVisibility === "restricted" && !bounded(event.privateLocationObjectRef, 500)) findings.push(finding("restricted_location_reference_required", "event.privateLocationObjectRef", "Restricted locality requires an opaque, access-controlled location-object reference."));
  if (event.locationVisibility !== "restricted" && event.privateLocationObjectRef !== undefined) findings.push(finding("restricted_location_reference_unexpected", "event.privateLocationObjectRef", "A private location reference is valid only when location visibility is restricted."));
  const hasLatitude = event.decimalLatitude !== undefined;
  const hasLongitude = event.decimalLongitude !== undefined;
  if (hasLatitude !== hasLongitude) findings.push(finding("coordinate_pair_required", "event.coordinates", "Latitude and longitude must be supplied together."));
  if (event.locationVisibility === "restricted" && (hasLatitude || hasLongitude)) findings.push(finding("restricted_coordinates_exposed", "event.coordinates", "Restricted coordinates must not be placed in the broadly queryable event envelope."));
  if (event.locationVisibility === "not_collected" && (hasLatitude || hasLongitude)) findings.push(finding("not_collected_coordinates_exposed", "event.coordinates", "A place that was not collected cannot have coordinates. Remove them, or choose another location visibility."));
  if (hasLatitude && (typeof event.decimalLatitude !== "number" || !Number.isFinite(event.decimalLatitude) || event.decimalLatitude < -90 || event.decimalLatitude > 90)) findings.push(finding("latitude_invalid", "event.decimalLatitude", "Latitude must be a finite number from -90 to 90."));
  if (hasLongitude && (typeof event.decimalLongitude !== "number" || !Number.isFinite(event.decimalLongitude) || event.decimalLongitude < -180 || event.decimalLongitude > 180)) findings.push(finding("longitude_invalid", "event.decimalLongitude", "Longitude must be a finite number from -180 to 180."));
  if (event.coordinateUncertaintyM !== undefined && (typeof event.coordinateUncertaintyM !== "number" || !Number.isFinite(event.coordinateUncertaintyM) || event.coordinateUncertaintyM < 0)) findings.push(finding("coordinate_uncertainty_invalid", "event.coordinateUncertaintyM", "Coordinate uncertainty must be a non-negative finite number of metres."));
  return findings;
}

function mapProfileFinding(item: ValidationFinding): RecordValidationFinding {
  return finding(`profile_${item.code}`, item.field ? `profile.data.${item.field}` : "profile", item.message, item.severity);
}

function unwrapProfileValue(value: unknown): unknown {
  if (!isPlainObject(value) || !("value" in value)) return value;
  const allowed = new Set(["value", "source", "uncertainty", "visibility", "unit", "method"]);
  return Object.keys(value).some((key) => !allowed.has(key)) ? value : value.value;
}

function validatePollenImageMediaLinks(
  profile: Partial<RecordProfileReference>,
  mediaValue: unknown,
): RecordValidationFinding[] {
  if (typeof profile.profileId !== "string" || typeof profile.profileVersion !== "string" || !isPlainObject(profile.data)) return [];
  // Pollen reference slide 1.1.0 introduced media-linked calibrations; later
  // pollen versions that declare the same field use the same link rules.
  const definition = findApplicationProfile(profile.profileId, profile.profileVersion);
  const linked = (profile.profileId === "clio.profile.pollen-reference-slide" && profile.profileVersion === "1.1.0")
    || (definition?.qualityChecks !== undefined && definition.fields.some((field) => field.key === "pollenImageCalibrations"));
  if (!linked) return [];
  const calibrations = unwrapProfileValue(profile.data.pollenImageCalibrations);
  if (calibrations === undefined || !isPollenImageCalibrations(calibrations)) return [];
  const media = Array.isArray(mediaValue) ? mediaValue.filter(validMediaReference) : [];
  const byId = new Map(media.map((item) => [item.mediaObjectId, item]));
  const byOrdinal = new Map(media.map((item) => [item.ordinal, item]));
  const resolvedIds = new Set<string>();
  const findings: RecordValidationFinding[] = [];
  for (const [index, calibration] of calibrations.entries()) {
    const identifiedMedia = calibration.mediaObjectId === undefined ? undefined : byId.get(calibration.mediaObjectId);
    const ordinalMedia = calibration.mediaOrdinal === undefined ? undefined : byOrdinal.get(calibration.mediaOrdinal);
    const invalid = (calibration.mediaObjectId !== undefined && identifiedMedia === undefined)
      || (calibration.mediaOrdinal !== undefined && ordinalMedia === undefined)
      || (identifiedMedia !== undefined && ordinalMedia !== undefined && identifiedMedia.mediaObjectId !== ordinalMedia.mediaObjectId);
    const path = `profile.data.pollenImageCalibrations[${index}]`;
    if (invalid) {
      findings.push(finding("pollen_image_media_reference_invalid", path, "The calibration must identify one media object attached to this record version; supplied ID and ordinal must resolve to the same object."));
      continue;
    }
    const resolved = identifiedMedia ?? ordinalMedia;
    if (resolved === undefined) continue;
    if (resolvedIds.has(resolved.mediaObjectId)) {
      findings.push(finding("pollen_image_media_reference_duplicate", path, "Only one calibration object may be supplied for each attached media object."));
    } else {
      resolvedIds.add(resolved.mediaObjectId);
    }
  }
  return findings;
}

/**
 * Return stable, machine-readable findings for browser, batch and command
 * boundaries. A valid result means metadata shape only; all operational and
 * trust gates remain outstanding.
 */
export function validateRecordFields(fields: unknown, options: RecordValidationOptions = {}): RecordValidationResult {
  const requiredLicenceUri = options.licenceUri ?? DEFAULT_LICENCE_URI;
  const findings: RecordValidationFinding[] = [];
  if (!isPlainObject(fields)) return { valid: false, findings: [finding("submission_fields_required", "fields", "Record fields must be an object.")] };
  const candidate = fields as Partial<RecordFields>;

  if (!bounded(candidate.title, 240)) findings.push(finding("title_required", "title", "A title of at most 240 characters is required."));
  findings.push(...validateEvent(candidate.event));
  if (!bounded(candidate.uncertaintyStatement, 4_000)) findings.push(finding("uncertainty_required", "uncertaintyStatement", "State what is uncertain, inferred or missing; use ‘none known’ when appropriate."));

  if (!Array.isArray(candidate.authors) || candidate.authors.length === 0 || candidate.authors.length > MAX_AUTHORS || !candidate.authors.every(validAuthor)) {
    findings.push(finding("authors_invalid", "authors", `One to ${MAX_AUTHORS} valid, attributable authors are required.`));
  } else if (new Set(candidate.authors.map((author) => author.ordinal)).size !== candidate.authors.length) {
    findings.push(finding("author_ordinal_duplicate", "authors", "Author ordinals must be unique."));
  }

  if (!Array.isArray(candidate.media) || candidate.media.length > MAX_MEDIA || !candidate.media.every(validMediaReference)) {
    findings.push(finding("media_invalid", "media", `Media must be an array of no more than ${MAX_MEDIA} media-object references.`));
  } else {
    if (new Set(candidate.media.map((media) => media.ordinal)).size !== candidate.media.length) findings.push(finding("media_ordinal_duplicate", "media", "Media ordinals must be unique."));
    if (candidate.media.length > 0 && !candidate.media.some((media) => media.mediaRole === "primary")) findings.push(finding("primary_media_required", "media", "When media is supplied, at least one representation must be primary."));
  }

  if (!isPlainObject(candidate.rights)) findings.push(finding("rights_required", "rights", "A rights object with a licence URI is required."));
  else {
    if (!absoluteHttpsUri(candidate.rights.licenceUri)) findings.push(finding("licence_uri_invalid", "rights.licenceUri", "Licence URI must be an absolute HTTPS URI."));
    else if (candidate.rights.licenceUri !== requiredLicenceUri) findings.push(finding("licence_policy_mismatch", "rights.licenceUri", `Records in this package use ${requiredLicenceUri}.`));
  }

  let profileResult: RecordValidationResult["profile"];
  if (!isPlainObject(candidate.profile)) {
    findings.push(finding("profile_required", "profile", "A versioned application profile is required."));
  } else {
    const profile = candidate.profile as Partial<RecordProfileReference>;
    if (!bounded(profile.profileId, 160)) findings.push(finding("profile_id_invalid", "profile.profileId", "A bounded profile ID is required."));
    if (!bounded(profile.profileVersion, 80)) findings.push(finding("profile_version_invalid", "profile.profileVersion", "A bounded profile version is required."));
    if (!recordReadinessLevels.includes(profile.readinessTarget as RecordReadiness)) findings.push(finding("profile_readiness_invalid", "profile.readinessTarget", "The readiness target must be referenceable, research_ready or doi_ready."));
    if (!isPlainObject(profile.data) || !safeJson(profile.data)) {
      findings.push(finding("profile_data_invalid", "profile.data", "Profile data must be bounded, finite, acyclic JSON data."));
    } else {
      try {
        if (new TextEncoder().encode(JSON.stringify(profile.data)).byteLength > MAX_PROFILE_JSON_BYTES) findings.push(finding("profile_data_too_large", "profile.data", "Profile data exceeds the 256 KiB structural limit."));
      } catch {
        findings.push(finding("profile_data_invalid", "profile.data", "Profile data could not be serialized safely."));
      }
      for (const key of Object.keys(profile.data)) if (universalProfileKeys.has(key)) findings.push(finding("profile_universal_field_duplicated", `profile.data.${key}`, "Universal envelope fields must not be duplicated in profile-specific data."));
    }
    const definition = typeof profile.profileId === "string" ? findApplicationProfile(profile.profileId) : undefined;
    // Lane 1.1+ profiles declare some fields as held in the event envelope
    // (location and its visibility). They are validated from the envelope so
    // there is one location record and one location-privacy mechanism.
    const exactDefinition = typeof profile.profileId === "string" && typeof profile.profileVersion === "string"
      ? findApplicationProfile(profile.profileId, profile.profileVersion)
      : undefined;
    const eventStoredKeys = (exactDefinition?.fields ?? []).filter((field) => field.storedIn === "event").map((field) => field.key);
    if (isPlainObject(profile.data)) {
      for (const key of eventStoredKeys) if (key in profile.data) findings.push(finding("profile_universal_field_duplicated", `profile.data.${key}`, "This field belongs in the event envelope; do not repeat it in profile-specific data."));
    }
    if (definition && typeof profile.profileVersion === "string" && typeof profile.readinessTarget === "string" && isPlainObject(profile.data) && isPlainObject(candidate.event) && isPlainObject(candidate.rights)) {
      const eventValues = candidate.event as Record<string, unknown>;
      const validationData: Record<string, unknown> = {
        ...profile.data,
        ...Object.fromEntries(eventStoredKeys.filter((key) => eventValues[key] !== undefined).map((key) => [key, eventValues[key]])),
        title: candidate.title,
        observedOn: candidate.event.eventDate,
        locality: candidate.event.locality,
        observer: candidate.event.recordedBy,
        description: candidate.event.context,
        method: candidate.event.method,
        rightsLicense: candidate.rights.licenceUri,
        uncertaintyNote: candidate.uncertaintyStatement,
      };
      const validated = validateApplicationProfileData(profile.profileId!, profile.profileVersion!, validationData, profile.readinessTarget as ReadinessLevel, { licenceUri: requiredLicenceUri });
      findings.push(...validated.findings.map(mapProfileFinding));
      findings.push(...validatePollenImageMediaLinks(profile, candidate.media));
      profileResult = { id: profile.profileId!, version: profile.profileVersion!, readiness: profile.readinessTarget as RecordReadiness };
    } else if (!definition && nonEmpty(profile.profileId)) {
      findings.push(finding("profile_unknown", "profile.profileId", "The application profile is not registered."));
    }
  }

  return { valid: findings.every((item) => item.severity !== "error"), findings, ...(profileResult ? { profile: profileResult } : {}) };
}

/** Boolean guard for callers that only need pass or fail. */
export function hasRequiredRecordFields(fields: unknown, options: RecordValidationOptions = {}): fields is RecordFields {
  return validateRecordFields(fields, options).valid;
}

export interface RecordDocumentInput {
  readonly recordId: string;
  readonly versionId: string;
  /** Stable URI of this record version, for example its landing page. */
  readonly canonicalUri: string;
  readonly recordType: string;
  readonly subjectScopes: readonly string[];
  readonly predecessorVersionId?: string;
  readonly fields: RecordFields;
}

/**
 * Wraps record fields in the record-version document the research-package
 * builder expects in each record's `canonical` property. It only arranges the
 * values; it does not hash, sign or publish anything.
 */
export function recordDocument(input: RecordDocumentInput): Record<string, unknown> {
  if (typeof input.recordId !== "string" || input.recordId.trim() === "") throw new TypeError("recordId is required");
  if (typeof input.versionId !== "string" || input.versionId.trim() === "") throw new TypeError("versionId is required");
  if (typeof input.canonicalUri !== "string" || input.canonicalUri.trim() === "") throw new TypeError("canonicalUri is required");
  if (input.predecessorVersionId !== undefined && input.predecessorVersionId.trim() === "") throw new TypeError("predecessorVersionId must not be blank");
  return {
    schema: RECORD_DOCUMENT_SCHEMA,
    recordId: input.recordId,
    versionId: input.versionId,
    canonicalUri: input.canonicalUri,
    recordType: input.recordType,
    subjectScopes: [...input.subjectScopes],
    ...(input.predecessorVersionId === undefined ? {} : { predecessorVersionId: input.predecessorVersionId }),
    fields: input.fields,
  };
}
