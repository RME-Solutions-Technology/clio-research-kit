import { findApplicationProfile, type ApplicationProfile } from "./application-profiles.ts";
import { effectiveFieldVisibility, unwrapProfileAssertion } from "./darwin-core.ts";
import { LOCATION_WITHHELD_TEXT, assertLocationOptions, containsLocationText, redactLocationText, isLocationKey, isLocationVisibilityKey, locationStateOf, visibilityStateText, withoutLocationValues, type LocationState, type LocationVisibilityOptions } from "./location-visibility.ts";
import type { ProjectSchemaDocument } from "./research-schema.ts";

/**
 * What a research package export leaves out of a record the requester does not
 * own: restricted values and private location references. "Sensitive" values
 * stay, because the package is a project-internal, admin-only export.
 *
 * Restricted means any of:
 * - a project schema field declared `sensitivity: "restricted"`;
 * - a profile value whose effective visibility is restricted (the field's
 *   declared sensitivity or a stricter assertion visibility; a key the
 *   profile does not define counts as restricted, as in the archive export);
 * - a value wrapped as an assertion with a visibility that is not exactly
 *   "public" or "sensitive" (an array, an object, other text: restricted);
 * - every place, when the location is not published. A location publishes only
 *   when its visibility is exactly "public" or "generalized"; the flag is read at
 *   any depth (a group, a nested object, a repeat entry) and the strictest one wins,
 *   also over a "public" at the top and under `missingVisibility: "public"`.
 *   "restricted", "not_collected", any other text, any other type and a missing
 *   value all withhold, unless the caller passes `missingVisibility: "public"` for
 *   a value that is missing everywhere. A row whose place is not published is cut
 *   down to an ALLOW-LIST of non-spatial fields: the profile's fields outside its
 *   location and site groups, the project schema's unrestricted fields, a short list
 *   of identifiers and dates, the event envelope's non-spatial fields and any key
 *   the caller adds in `keepKeys`. Everything else is dropped by name, so an
 *   unknown column cannot carry a place out. Place-name fields (locality, site IDs and
 *   names, collectionSite and the like) are dropped too, whatever keepKeys says: a named
 *   place finds the place. A visibility-named key stays so the output says why, but only
 *   as the state it was read as, never as the raw cell. The text that stays (remarks,
 *   description, title) is screened for places written in it (decimal and
 *   whole-degree pairs, DMS, arrays, x/y, serialised GeoJSON, WKT, map URLs, geo: URIs,
 *   plus codes, UTM/MGRS, what3words) and a match is replaced by "[location withheld]".
 *   The screen is pattern matching: it cannot be guaranteed to catch every way of
 *   writing a place, so generalise locality text before you export;
 * - any private location reference (`privateLocationObjectRef` and keys like
 *   it, plus any key the caller lists in `privateKeys`), anywhere in the record.
 *
 * Every removal is reported as a path, so the package can say exactly what is
 * missing. Pure functions; inputs are never modified.
 *
 * The private-key rule is a name heuristic (`private*`, `*privatelocation*`,
 * `*restrictedlocation*`). A key such as `secret_site` or `hidden_gps` is not caught
 * unless it is listed in `privateKeys`.
 */

export type WithholdingResult<T> = Readonly<{ value: T; withheld: readonly string[] }>;

export type WithholdingOptions = LocationVisibilityOptions & Readonly<{
  /** Extra key names (any spelling) to treat as private location references. */
  privateKeys?: readonly string[];
  /**
   * Extra field names to keep when the place is not published (the allow-list is otherwise the profile's non-spatial
   * fields). Kept values are still screened for places written in them. Use it for the form questions you know are safe.
   */
  keepKeys?: readonly string[];
}>;

const normaliseName = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]+/gu, "");

/**
 * Fields that name a place in words: locality, site identifiers and names, collection site, municipality and the like. They never pass
 * the allow-list for a location that is not published, whatever `keepKeys` says. A count of sites ("siteCount") is not a place.
 */
export function isPlaceNameKey(key: string): boolean {
  const last = key.split(/[/.]/u).pop() ?? key;
  const name = normaliseName(last);
  if (name === "sitecount" || name === "sitesvisited") return false;
  return name.includes("locality") || name.startsWith("site") || name.endsWith("site") || name.includes("collectionsite") || name.includes("placename")
    || name.includes("locationname") || name === "locationid" || name === "location" || name === "municipality" || name === "county" || name === "stateprovince"
    || name === "island" || name === "waterbody" || name === "country" || name.includes("verbatimlocation") || name.includes("georeference");
}

/** Keys the system writes itself; the only top-level canonical keys exempt from the text screen. A contributor-supplied sourceId is screened. */
export const SYSTEM_IDS: ReadonlySet<string> = new Set(["schema", "recordId", "versionId", "canonicalUri", "projectId", "importId", "rowId", "stagedAt", "presetId", "mappingVersion", "state"]);
const CANONICAL_KEEP: ReadonlySet<string> = new Set(["recordType", "subjectScopes", "predecessorVersionId"]);

export const MAX_WITHHELD_PATHS = 500;

/**
 * Keeps a withheld list within `limit` entries by grouping instead of failing: array positions become [*], then sibling keys under
 * one parent become parent.*, then whatever is left becomes one entry per root (canonical.*). The result still tells a reader which
 * parts lost values; it no longer names every one.
 */
export function collapseWithheld(paths: readonly string[], limit: number = MAX_WITHHELD_PATHS): string[] {
  // A removed column's name can itself be a place (a header made of a coordinate pair): the path keeps the shape but not the place.
  let list = [...new Set(paths.map((path) => (containsLocationText(path) ? redactLocationText(path).split(LOCATION_WITHHELD_TEXT).join("*") : path)))];
  if (list.length <= limit) return list;
  list = [...new Set(list.map((path) => path.replace(/\[\d+\]/gu, "[*]")))];
  for (let round = 0; round < 8 && list.length > limit; round += 1) {
    // One level per round: a leaf becomes parent.*, and a parent.* that is already a group moves up to its own parent.
    list = [...new Set(list.map((path) => (path.endsWith(".*") ? path.replace(/\.[^.[\]*]+\.\*$/u, ".*") : path.replace(/\.[^.[\]*]+(?:\[\*\])?$/u, ".*"))))];
  }
  if (list.length > limit) list = [...new Set(list.map((path) => `${path.split(/[.[]/u)[0]}.*`))];
  return list;
}

/** Profile groups that describe where something is. Fields in them never pass the allow-list. */
const SPATIAL_SECTIONS: ReadonlySet<string> = new Set(["location", "site"]);

/** Identifiers, dates and rights that are never spatial; kept when a place is withheld (plus the flag keys). */
const COMMON_KEEP: readonly string[] = [
  "sourceId", "sourceSystem", "sourceNamespace", "sourceRecordId", "source_id", "id", "uuid", "identifier", "recordId", "record_id",
  "submittedAt", "updatedAt", "formVersion", "reviewState", "validationStatus", "edits", "eventDate", "date", "observedOn", "rights", "licence", "license",
];

/** The non-spatial envelope fields of an event. `locality` is a place name and is dropped; free text that stays is screened. */
const EVENT_KEEP: readonly string[] = [
  "eventDate", "timeZone", "recordedBy", "method", "context", "habitat", "samplingProtocol", "samplingEffort", "fieldNumber", "sensitivityReasonCode",
];

/** The top-level parts of a record's fields that may remain; each is cleaned. */
const FIELDS_KEEP: ReadonlySet<string> = new Set(["title", "profile", "event", "uncertaintyStatement", "authors", "media", "rights"]);

/**
 * Field names that may remain when a place is withheld, normalised. A profile field counts as spatial when it is in a
 * location or site group, is typed latitude or longitude, is stored in the event envelope, or has a place-like name; a
 * name that is spatial in ANY of its definitions is spatial.
 */
function allowedNames(profile: ApplicationProfile | undefined, schema: ProjectSchemaDocument | undefined, extra: readonly string[]): Set<string> {
  const allowed = new Set<string>(COMMON_KEEP.map(normaliseName));
  const spatial = new Set<string>();
  for (const field of profile?.fields ?? []) {
    const name = normaliseName(field.key);
    const isSpatial = SPATIAL_SECTIONS.has(field.section) || field.datatype === "latitude" || field.datatype === "longitude" || field.storedIn === "event" || isLocationKey(field.key) || isPlaceNameKey(field.key);
    if (isSpatial) spatial.add(name); else allowed.add(name);
  }
  for (const field of schema?.fields ?? []) if (field.sensitivity !== "restricted" && !isLocationKey(field.key)) allowed.add(normaliseName(field.key));
  for (const name of extra) if (!isPlaceNameKey(name) && !isLocationKey(name)) allowed.add(normaliseName(name));
  for (const name of spatial) allowed.delete(name);
  return allowed;
}

type JsonObject = Record<string, unknown>;

function plainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

/** `privateLocationObjectRef`, `private_location`, `privateCoordinates`, `restrictedLocationRef` and the like. */
export function isPrivateLocationKey(key: string, extra: readonly string[] = []): boolean {
  const name = normalise(key);
  if (extra.some((candidate) => normalise(candidate) === name)) return true;
  return name.startsWith("private") || name.includes("privatelocation") || name.includes("restrictedlocation") || name.includes("restrictedcoordinate");
}

function isRestrictedAssertion(value: unknown): boolean {
  const { assertion } = unwrapProfileAssertion(value);
  return assertion !== undefined && assertion.visibility !== undefined && assertion.visibility !== "public" && assertion.visibility !== "sensitive";
}

/** Removes private location references at any depth. */
function withoutPrivateLocations(value: unknown, path: string, withheld: string[], extra: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item, index) => withoutPrivateLocations(item, `${path}[${index}]`, withheld, extra));
  if (!plainObject(value)) return value;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (isPrivateLocationKey(key, extra)) { withheld.push(`${path}.${key}`); continue; }
    result[key] = withoutPrivateLocations(item, `${path}.${key}`, withheld, extra);
  }
  return result;
}

/** Paths of every private location reference still present in a value. */
export function privateLocationPaths(value: unknown, path: string, extra: readonly string[] = []): string[] {
  const found: string[] = [];
  withoutPrivateLocations(value, path, found, extra);
  return found;
}

/** The worse of two location states, for a row whose data and source describe the same place. */
function combineStates(...states: readonly LocationState[]): LocationState {
  const keyed = states.filter((state) => state !== "missing");
  if (keyed.length === 0) return "missing";
  const rank: Record<LocationState, number> = { public: 0, generalized: 1, missing: 2, unrecognised: 3, not_collected: 4, restricted: 5 };
  return keyed.reduce((worst, state) => (rank[state] > rank[worst] ? state : worst));
}

function publishes(state: LocationState, options: LocationVisibilityOptions): boolean {
  return state === "public" || state === "generalized" || (state === "missing" && options.missingVisibility === "public");
}

/**
 * Applies the top-level and place rules to one flat object (staged row data or source). When the place is not
 * published the object is cut down to the allow-list, and what stays is cleaned of places.
 */
function withholdFlat(object: JsonObject, path: string, restrictedKeys: ReadonlySet<string>, publish: boolean, allowed: ReadonlySet<string>, withheld: string[]): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (restrictedKeys.has(key) || isRestrictedAssertion(value)) {
      withheld.push(`${path}.${key}`);
      continue;
    }
    result[key] = value;
  }
  if (publish) return result;
  const kept: JsonObject = {};
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) continue;
    if (isLocationVisibilityKey(key)) { // the flag stays, so the output says why, but only as the state it was read as
      const state = visibilityStateText(value);
      if (state !== value) withheld.push(`${path}.${key}`);
      Object.defineProperty(kept, key, { value: state, enumerable: true, writable: true, configurable: true });
      continue;
    }
    if (!allowed.has(normaliseName(key)) || isLocationKey(key) || isPlaceNameKey(key)) { withheld.push(`${path}.${key}`); continue; }
    const cleaned = withoutLocationValues({ [key]: value }, path, withheld) as JsonObject;
    if (Object.hasOwn(cleaned, key)) kept[key] = cleaned[key];
  }
  return kept;
}

export function restrictedSchemaFieldKeys(schema: ProjectSchemaDocument | undefined): ReadonlySet<string> {
  return new Set((schema?.fields ?? []).filter((field) => field.sensitivity === "restricted").map((field) => field.key));
}

function restrictedProfileKeys(profile: ApplicationProfile | undefined): ReadonlySet<string> {
  return new Set((profile?.fields ?? []).filter((field) => field.sensitivity === "restricted").map((field) => field.key));
}

/** Project schema values without restricted fields. */
export function withholdExtension(extension: Readonly<Record<string, unknown>>, schema: ProjectSchemaDocument | undefined): WithholdingResult<Record<string, unknown>> {
  const restricted = restrictedSchemaFieldKeys(schema);
  const withheld: string[] = [];
  const value: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(extension)) {
    if (restricted.has(key) || isRestrictedAssertion(item)) withheld.push(`extension.${key}`);
    else value[key] = item;
  }
  return { value, withheld };
}

/**
 * A staged imported row as exported: its mapped profile data and its original
 * source columns. A source column carrying a restricted schema field, a
 * restricted profile field, a restricted assertion, a place that is not
 * published or a private location reference is removed too, because the
 * raw source would otherwise repeat what the data leaves out.
 */
export function withholdStagedRow(input: Readonly<{
  data: Readonly<Record<string, unknown>>;
  source: Readonly<Record<string, unknown>>;
  schema?: ProjectSchemaDocument;
  profileId: string;
  profileVersion: string;
}> & WithholdingOptions): WithholdingResult<{ data: JsonObject; source: JsonObject }> {
  assertLocationOptions(input);
  const profile = findApplicationProfile(input.profileId, input.profileVersion);
  const restricted = new Set([...restrictedSchemaFieldKeys(input.schema), ...restrictedProfileKeys(profile)]);
  const extra = input.privateKeys ?? [];
  const withheld: string[] = [];
  // A location stated anywhere in either object applies to both: the raw source and the mapped data describe the same place.
  const state = combineStates(locationStateOf(input.data).state, locationStateOf(input.source).state);
  const publish = publishes(state, input);
  const allowed = allowedNames(profile, input.schema, input.keepKeys ?? []);
  const data = withholdFlat({ ...input.data }, "canonical.data", restricted, publish, allowed, withheld);
  const source = withholdFlat({ ...input.source }, "canonical.source", restricted, publish, allowed, withheld);
  return {
    value: {
      data: withoutPrivateLocations(data, "canonical.data", withheld, extra) as JsonObject,
      source: withoutPrivateLocations(source, "canonical.source", withheld, extra) as JsonObject,
    },
    withheld: collapseWithheld(withheld),
  };
}

/**
 * An accepted record version's canonical JSON as exported: restricted profile
 * values, every place when the location is not published (coordinates, datum,
 * uncertainty, GeoJSON, WKT, lat/lon text), and every private location reference are removed.
 */
export function withholdCanonicalRecordVersion(canonical: Readonly<Record<string, unknown>>, options: WithholdingOptions = {}): WithholdingResult<JsonObject> {
  assertLocationOptions(options);
  const withheld: string[] = [];
  const extra = options.privateKeys ?? [];
  const fields = plainObject(canonical.fields) ? canonical.fields : undefined;
  if (!fields) return { value: withoutPrivateLocations(canonical, "canonical", withheld, extra) as JsonObject, withheld };
  const profileReference = plainObject(fields.profile) ? fields.profile : {};
  const profile = typeof profileReference.profileId === "string" && typeof profileReference.profileVersion === "string"
    ? findApplicationProfile(profileReference.profileId, profileReference.profileVersion)
    : undefined;
  // The flag is read anywhere in the record's fields; the strictest wins. A record with no event and no flag has no place to withhold.
  const state = locationStateOf(fields, options);
  const hasEvent = plainObject(fields.event);
  const publish = state.publishes || (!hasEvent && state.state === "missing");
  const allowed = allowedNames(profile, undefined, options.keepKeys ?? []);
  let nextFields: JsonObject = { ...fields };
  if (plainObject(profileReference.data)) {
    const data: JsonObject = {};
    for (const [key, raw] of Object.entries(profileReference.data)) {
      if (effectiveFieldVisibility(profile, key, unwrapProfileAssertion(raw).assertion) === "restricted") withheld.push(`canonical.fields.profile.data.${key}`);
      else if (!publish && (!allowed.has(normaliseName(key)) || isLocationKey(key) || isPlaceNameKey(key))) withheld.push(`canonical.fields.profile.data.${key}`);
      else data[key] = raw;
    }
    nextFields.profile = { ...profileReference, data };
  }
  if (!publish) {
    const kept: JsonObject = {};
    for (const [key, value] of Object.entries(nextFields)) {
      if (!FIELDS_KEEP.has(key)) { withheld.push(`canonical.fields.${key}`); continue; }
      if (key === "event" && plainObject(value)) {
        const event: JsonObject = {};
        for (const [eventKey, eventValue] of Object.entries(value)) {
          if (eventValue === undefined) continue;
          if (isLocationVisibilityKey(eventKey)) { // only the state it was read as, never the raw cell
            const state = visibilityStateText(eventValue);
            if (state !== eventValue) withheld.push(`canonical.fields.event.${eventKey}`);
            Object.defineProperty(event, eventKey, { value: state, enumerable: true, writable: true, configurable: true });
            continue;
          }
          const keep = EVENT_KEEP.some((name) => normaliseName(name) === normaliseName(eventKey)) || (options.keepKeys ?? []).some((name) => normaliseName(name) === normaliseName(eventKey));
          if (!keep || isLocationKey(eventKey) || isPlaceNameKey(eventKey)) { withheld.push(`canonical.fields.event.${eventKey}`); continue; }
          const cleaned = withoutLocationValues({ [eventKey]: eventValue }, "canonical.fields.event", withheld) as JsonObject;
          if (Object.hasOwn(cleaned, eventKey)) event[eventKey] = cleaned[eventKey];
        }
        kept.event = event;
      } else {
        const cleaned = withoutLocationValues({ [key]: value }, "canonical.fields", withheld) as JsonObject;
        if (Object.hasOwn(cleaned, key)) kept[key] = cleaned[key];
      }
    }
    nextFields = kept;
  }
  let top: JsonObject = { ...canonical, fields: nextFields };
  if (!publish) {
    // Top level: the system's own ids pass untouched; a few document keys and contributor-supplied identifiers (sourceId) are
    // screened; any other key is dropped by name.
    top = {};
    for (const [key, value] of Object.entries(canonical)) {
      if (key === "fields") { Object.defineProperty(top, "fields", { value: nextFields, enumerable: true, writable: true, configurable: true }); continue; }
      if (SYSTEM_IDS.has(key)) { Object.defineProperty(top, key, { value, enumerable: true, writable: true, configurable: true }); continue; }
      const known = CANONICAL_KEEP.has(key) || COMMON_KEEP.some((name) => normaliseName(name) === normaliseName(key));
      if (!known || isLocationKey(key) || isPlaceNameKey(key)) { withheld.push(`canonical.${key}`); continue; }
      const cleaned = withoutLocationValues({ [key]: value }, "canonical", withheld) as JsonObject;
      if (Object.hasOwn(cleaned, key)) Object.defineProperty(top, key, { value: cleaned[key], enumerable: true, writable: true, configurable: true });
    }
  }
  return { value: withoutPrivateLocations(top, "canonical", withheld, extra) as JsonObject, withheld: collapseWithheld(withheld) };
}
