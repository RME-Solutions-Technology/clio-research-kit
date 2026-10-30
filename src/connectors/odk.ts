/**
 * ODK Central connector.
 *
 * Reads what ODK Central gives out and produces rows for the importer:
 * - the OData JSON data document (`.../forms/{id}.svc/Submissions`, with
 *   `$expand=*` so repeats arrive nested);
 * - the CSV export (`submissions.csv.zip`) once its files are unzipped: the
 *   main table plus one table per repeat, joined on KEY / PARENT_KEY;
 * - the form definition (XForms XML, or the `/fields` endpoint's JSON), which
 *   tells the connector which values are geopoints, select_multiple lists and
 *   attachments. Without it, OData still works (groups, repeats and GeoJSON
 *   are structural) but typed conversion is limited and the connector says so.
 *
 * Formats follow the ODK Central API documentation and source (Apache-2.0,
 * https://github.com/getodk/central-backend): `docs/api.yaml`,
 * `lib/data/briefcase.js` (CSV headers, KEY/PARENT_KEY) and
 * `lib/data/schema.js` (field types).
 *
 * No network access happens here except in `fetchOdk*`, which take an injected
 * `fetch`. Attachments are never downloaded; each becomes a MediaReference.
 */
import {
  CONNECTOR_LIMITS,
  FindingSink,
  applyPrimaryFields,
  assertJsonShape,
  assertSafeKey,
  boundedInteger,
  isIdentityMetadata,
  pointFromParts,
  IDENTITY_METADATA_NAMES,
  RESERVED_KEYS,
  confinedNextLink,
  convertLeaf,
  fail,
  fetchJson,
  fieldKey,
  indexFields,
  isPlainObject,
  looksLikeGeoJson,
  newRecord,
  originOnlyHttpsUrl,
  parseDelimited,
  normaliseDateTime,
  withTimeout,
  type ConnectorResult,
  type ConnectorRow,
  type FetchLike,
  type FieldIndex,
  type FormField,
  type LocationOptions,
  type MediaReference,
  type RowContext,
  type TimestampOptions,
} from "./common.ts";

export interface OdkConvertOptions extends LocationOptions, TimestampOptions {
  /** Form fields from `odkFieldsFromXForm` or `odkFieldsFromApi`. Strongly recommended. */
  readonly fields?: readonly FormField[];
  /** Prefix for sourceId. Default "odk". Use one per server so two servers cannot collide. */
  readonly namespace?: string;
  /** Numeric project id and form id, used only to build attachment API paths. */
  readonly project?: number | string;
  readonly form?: string;
  /** Adds submitterId, submitterName and deviceId. They name people and devices: off by default. */
  readonly includeSubmitter?: boolean;
  readonly maxRows?: number;
}

const ROOT_SYSTEM_KEYS = new Set(["__id", "__system"]);
const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/u;
// "." and ".." would collapse a URL path segment, so they are not form ids.
const FORM_ID = /^(?!\.+$)[A-Za-z0-9._-]{1,128}$/u;

function checkNamespace(options: OdkConvertOptions): string {
  const namespace = options.namespace ?? "odk";
  if (!NAMESPACE.test(namespace)) fail("option.namespace", "namespace must be lower-case letters, digits and hyphens, starting with a letter.");
  return namespace;
}

export function odkAttachmentApiPath(project: number | string, form: string, instanceId: string, filename: string): string {
  if (!/^\d{1,12}$/u.test(String(project))) fail("option.project", "project must be a numeric Central project id.");
  if (!FORM_ID.test(form)) fail("option.form", "form must be an xmlFormId of letters, digits, '.', '_' and '-'.");
  if (/^\.+$/u.test(instanceId) || instanceId === "") fail("option.instance", "instanceId must not be empty, '.' or '..'.");
  return `/v1/projects/${String(project)}/forms/${encodeURIComponent(form)}/submissions/${encodeURIComponent(instanceId)}/attachments/${encodeURIComponent(filename)}`;
}

function attachmentPathFor(options: OdkConvertOptions, instanceId: string): ((filename: string) => string | undefined) | undefined {
  if (options.project === undefined || options.form === undefined) return undefined;
  return (filename) => odkAttachmentApiPath(options.project!, options.form!, instanceId, filename);
}

// ---------------------------------------------------------------------------
// Form definition

function stripPrefix(segment: string): string {
  const colon = segment.indexOf(":");
  return colon >= 0 ? segment.slice(colon + 1) : segment;
}

function splitNodeset(nodeset: string): string[] | undefined {
  if (!nodeset.startsWith("/")) return undefined;
  return nodeset.split("/").slice(1).map(stripPrefix);
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of source.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) out[match[1]!] = match[2] ?? match[3] ?? "";
  return out;
}

/** A real XForm is well under 1 MiB (a large survey is a few hundred KB). */
const XFORM_MAX_CHARS = 1024 * 1024;

/**
 * Removes comments, CDATA sections and processing instructions in one linear pass (each closer is looked for once,
 * from the opener, with indexOf). An opener with no closer is refused: it is how a hostile file would make a
 * pattern-based strip rescan the rest of the input from every opener.
 */
export function stripXmlSections(xml: string): string {
  const parts: string[] = [];
  let index = 0;
  while (index < xml.length) {
    const lt = xml.indexOf("<", index);
    if (lt < 0) { parts.push(xml.slice(index)); break; }
    parts.push(xml.slice(index, lt));
    const opener = xml.startsWith("<!--", lt) ? "<!--" : xml.startsWith("<![CDATA[", lt) ? "<![CDATA[" : xml.startsWith("<?", lt) ? "<?" : undefined;
    if (opener === undefined) { parts.push("<"); index = lt + 1; continue; }
    const closer = opener === "<!--" ? "-->" : opener === "<?" ? "?>" : "]]>";
    const end = xml.indexOf(closer, lt + opener.length);
    if (end < 0) fail("xform.unterminated", `A ${opener} section is never closed.`);
    index = end + closer.length;
  }
  return parts.join("");
}

type XNode = { name: string; children: XNode[] };

/**
 * Reads the field list from an XForms XML form definition, in the shape
 * ODK Central's `/forms/{id}/fields` endpoint returns: structures for groups,
 * `repeat` for repeat groups, types from `<bind type>`, `selectMultiple` from
 * body `<select>` elements. It is a tag scanner for the XForms ODK produces
 * from XLSForm, not a general XML parser: DOCTYPE and entity declarations are
 * refused, and input and element counts are bounded.
 */
export function odkFieldsFromXForm(xml: string): FormField[] {
  if (typeof xml !== "string" || xml.length > XFORM_MAX_CHARS) fail("xform.size", "The form definition is missing or larger than 1 MiB.");
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail("xform.doctype", "A form definition with a DOCTYPE or entity declaration is refused.");
  const text = stripXmlSections(xml);
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/gu;
  const stack: string[] = [];
  let root: XNode | undefined;
  const nodeStack: XNode[] = [];
  let instanceDepth = -1;
  let instanceDone = false;
  const types = new Map<string, string>();
  const identityPaths = new Set<string>();
  const repeats = new Set<string>();
  const selects = new Set<string>();
  let elements = 0;

  for (const match of text.matchAll(tag)) {
    elements += 1;
    if (elements > 50_000) fail("xform.size", "The form definition has more than 50,000 elements.");
    const closing = match[1] === "/";
    const name = stripPrefix(match[2]!);
    const selfClosing = match[4] === "/";
    if (closing) {
      stack.pop();
      if (instanceDepth >= 0) {
        if (stack.length === instanceDepth) { instanceDepth = -1; instanceDone = true; } else nodeStack.pop();
      }
      continue;
    }
    const attrs = attributes(match[3] ?? "");
    if (name === "bind" && attrs.nodeset !== undefined && attrs["jr:preload"] === "property" && IDENTITY_METADATA_NAMES.has((attrs["jr:preloadParams"] ?? "").toLowerCase())) {
      const parts = splitNodeset(attrs.nodeset);
      if (parts && parts.length > 1) identityPaths.add(`/${parts.slice(1).join("/")}`);
    }
    if (name === "bind" && attrs.nodeset !== undefined && attrs.type !== undefined) {
      const parts = splitNodeset(attrs.nodeset);
      if (parts && parts.length > 1) types.set(`/${parts.slice(1).join("/")}`, stripPrefix(attrs.type));
    } else if (name === "repeat" && attrs.nodeset !== undefined) {
      const parts = splitNodeset(attrs.nodeset);
      if (parts && parts.length > 1) repeats.add(`/${parts.slice(1).join("/")}`);
    } else if (name === "select" && attrs.ref !== undefined) {
      const parts = splitNodeset(attrs.ref);
      if (parts && parts.length > 1) selects.add(`/${parts.slice(1).join("/")}`);
    }
    if (instanceDepth < 0 && !instanceDone && name === "instance" && attrs.id === undefined && !selfClosing) {
      instanceDepth = stack.length;
    } else if (instanceDepth >= 0) {
      const node: XNode = { name, children: [] };
      const parent = nodeStack[nodeStack.length - 1];
      if (parent) {
        const existing = parent.children.find((child) => child.name === name);
        if (existing && !selfClosing) { nodeStack.push(existing); stack.push(name); continue; }
        if (existing) continue;
        parent.children.push(node);
      } else root = node;
      if (!selfClosing) nodeStack.push(node);
    }
    if (!selfClosing) stack.push(name);
  }
  if (!root) fail("xform.no-instance", "The form definition has no primary instance.");

  const fields: FormField[] = [];
  const walk = (node: XNode, prefix: string): void => {
    for (const child of node.children) {
      assertSafeKey(child.name, "a form field name");
      const path = `${prefix}/${child.name}`;
      const isRepeat = repeats.has(path);
      const type = isRepeat ? "repeat" : child.children.length > 0 ? "structure" : types.get(path) ?? "unknown";
      fields.push({
        name: child.name,
        path,
        type,
        ...(type === "binary" ? { binary: true } : {}),
        ...(selects.has(path) ? { selectMultiple: true } : {}),
        ...(identityPaths.has(path) ? { identity: true } : {}),
      });
      if (child.children.length > 0) walk(child, path);
    }
  };
  walk(root, "");
  return fields;
}

/** Validates the JSON from `GET /v1/projects/{id}/forms/{xmlFormId}/fields`. */
export function odkFieldsFromApi(json: unknown): FormField[] {
  if (!Array.isArray(json)) fail("fields.invalid", "The fields response must be an array.");
  assertJsonShape(json, "fields response");
  const fields = json.map((item): FormField => {
    if (!isPlainObject(item) || typeof item.path !== "string" || typeof item.name !== "string" || typeof item.type !== "string") fail("fields.invalid", "Each field needs path, name and type text.");
    return { path: item.path, name: item.name, type: item.type, ...(item.binary === true ? { binary: true } : {}), ...(item.selectMultiple === true ? { selectMultiple: true } : {}) };
  });
  indexFields(fields);
  return fields;
}

// ---------------------------------------------------------------------------
// OData JSON

type Env = {
  /** includeSubmitter: keep device and person metadata questions (deviceid, username, phonenumber, email). */
  readonly keepIdentity?: boolean;
  readonly context: RowContext;
  readonly fields: FieldIndex | undefined;
  readonly sink: FindingSink;
};

function walkOData(env: Env, value: Record<string, unknown>, absPrefix: string, relPrefix: string, target: Record<string, unknown>, top: boolean, depth: number): void {
  if (depth > CONNECTOR_LIMITS.depth) fail("json.depth-limit", "A submission nests deeper than the connector accepts.");
  const { sink, context } = env;
  for (const key of Object.keys(value)) {
    assertSafeKey(key, "an OData row");
    if (top && absPrefix === "" && ROOT_SYSTEM_KEYS.has(key)) continue;
    const at = key.indexOf("@odata.");
    if (at > 0) {
      if (key.endsWith("@odata.navigationLink")) sink.add("warning", "odata.repeat-not-expanded", `The repeat ${JSON.stringify(key.slice(0, at))} was not expanded, so its rows are missing. Fetch again with $expand=*.`, { sourceId: context.sourceId, field: key.slice(0, at) });
      continue;
    }
    if (key.startsWith("@")) continue;
    const raw = value[key];
    if (raw === null || raw === undefined) continue;
    const abs = `${absPrefix}/${key}`;
    const rel = `${relPrefix}${key}`;
    const field = env.fields?.get(abs);
    const display = abs.slice(1);
    if (absPrefix === "/meta" && key === "instanceID" && raw === context.sourceId.slice(context.sourceId.indexOf(":") + 1)) continue;

    if (Array.isArray(raw)) {
      const items: Record<string, unknown>[] = [];
      raw.forEach((item) => {
        if (!isPlainObject(item)) { sink.add("warning", "odata.repeat-item", "A repeat entry is not an object and was skipped.", { sourceId: context.sourceId, field: display }); return; }
        const record = newRecord();
        walkOData(env, item, abs, "", record, false, depth + 1);
        delete record.__id;
        items.push(record);
      });
      // An empty repeat has no counterpart in the CSV export, so it is left out here too: both routes give the same row.
      if (items.length > 0) target[top ? fieldKey(rel, sink, context.sourceId, true) : rel] = items;
      continue;
    }
    if (isPlainObject(raw)) {
      const isGroup = field !== undefined ? field.type === "structure" || field.type === "repeat" : !looksLikeGeoJson(raw);
      if (isGroup) {
        if (field?.type === "repeat") {
          // A single (non-array) repeat entry: still a list.
          const record = newRecord();
          walkOData(env, raw, abs, "", record, false, depth + 1);
          target[top ? fieldKey(rel, sink, context.sourceId, true) : rel] = [record];
        } else walkOData(env, raw, abs, `${rel}/`, target, top, depth + 1);
        continue;
      }
    }
    if (env.keepIdentity !== true && isIdentityMetadata(field, key)) {
      sink.add("info", "metadata.identity-dropped", `The question ${JSON.stringify(display)} identifies a device or a person; it was dropped. Set includeSubmitter to keep it.`, { sourceId: context.sourceId, field: display });
      continue;
    }
    const converted = convertLeaf(context, abs, display, raw);
    if (converted !== undefined) target[top ? fieldKey(rel, sink, context.sourceId, true) : rel] = converted;
  }
}

function addSystemFields(row: Record<string, unknown>, system: Record<string, unknown>, options: OdkConvertOptions, sink: FindingSink, sourceId: string): void {
  const timestamp = (raw: unknown, name: string): string | undefined => {
    if (typeof raw !== "string" || raw === "") return undefined;
    const result = normaliseDateTime(raw, options);
    if (result.code !== undefined) sink.add("warning", result.code, `${name}: ${result.message}`, { sourceId, field: name });
    return result.value;
  };
  const submitted = timestamp(system.submissionDate, "submittedAt");
  if (submitted !== undefined) row.submittedAt = submitted;
  const updated = timestamp(system.updatedAt, "updatedAt");
  if (updated !== undefined) row.updatedAt = updated;
  if (typeof system.formVersion === "string" && system.formVersion !== "") row.formVersion = system.formVersion;
  else if (typeof system.formVersion === "number") row.formVersion = String(system.formVersion);
  if (typeof system.reviewState === "string") row.reviewState = system.reviewState;
  if (typeof system.status === "string" && system.status !== "") {
    row.status = system.status;
    sink.add("warning", "submission.no-data", `Central reports the status ${JSON.stringify(system.status)}; this submission has no readable form data.`, { sourceId });
  }
  if (typeof system.edits === "number") row.edits = system.edits;
  if (options.includeSubmitter === true) {
    if (system.submitterId !== undefined && system.submitterId !== null) row.submitterId = String(system.submitterId);
    if (typeof system.submitterName === "string") row.submitterName = system.submitterName;
    if (typeof system.deviceId === "string") row.deviceId = system.deviceId;
  }
}

function finishRow(row: Record<string, unknown>, rowMedia: readonly MediaReference[], options: OdkConvertOptions, env: Env, system: Record<string, unknown>): ConnectorRow {
  applyPrimaryFields(row, env.fields, options, env.sink, env.context.sourceId);
  if (rowMedia.length > 0) row.media = rowMedia.map(({ field, filename, mediaType, apiPath }) => ({ field, filename, mediaType, ...(apiPath === undefined ? {} : { apiPath }) }));
  const expected = typeof system.attachmentsExpected === "number" ? system.attachmentsExpected : 0;
  if (env.fields === undefined && expected > 0 && rowMedia.length === 0) {
    env.sink.add("warning", "media.fields-unknown", `Central expects ${expected} attachment(s) for this submission but no form definition was given, so no media references were made. Pass fields (odkFieldsFromXForm).`, { sourceId: env.context.sourceId });
  }
  return row as ConnectorRow;
}

/**
 * Converts an OData data document (`{ value: [...] }`) or a bare array of
 * submission rows into connector rows.
 */
export function odkODataToRows(document: unknown, options: OdkConvertOptions = {}): ConnectorResult {
  const namespace = checkNamespace(options);
  const maxRows = boundedInteger(options.maxRows, CONNECTOR_LIMITS.rows, CONNECTOR_LIMITS.rows, "maxRows");
  assertJsonShape(document, "OData document");
  const list = Array.isArray(document) ? document : isPlainObject(document) && Array.isArray(document.value) ? document.value : undefined;
  if (list === undefined) fail("odata.shape", "Expected an OData document with a value array, or an array of submission rows.");
  if (list.length > maxRows) fail("limit.rows", `The document has more than ${maxRows} submissions.`);
  const fields = indexFields(options.fields);
  const sink = new FindingSink();
  const media: MediaReference[] = [];
  const rows: ConnectorRow[] = [];
  const seen = new Set<string>();
  if (fields === undefined) sink.add("info", "fields.not-supplied", "No form definition was given. Groups, repeats and GeoJSON are kept, but select_multiple values, numbers and attachments are left as the server wrote them.");

  for (const item of list) {
    if (!isPlainObject(item)) fail("odata.row", "A submission row must be an object.");
    const id = item.__id;
    if (typeof id !== "string" || id.length < 1 || id.length > 256) fail("odata.missing-id", "A submission row has no __id.");
    const sourceId = `${namespace}:${id}`;
    if (seen.has(sourceId)) fail("odata.duplicate-id", `Submission ${id} appears twice.`);
    seen.add(sourceId);
    const system = isPlainObject(item.__system) ? item.__system : {};
    const rowMedia: MediaReference[] = [];
    const attachmentPath = attachmentPathFor(options, id);
    const context: RowContext = {
      sourceId,
      source: "odk",
      fields,
      sink,
      media: rowMedia,
      timestamps: options,
      ...(attachmentPath === undefined ? {} : { attachmentPath }),
    };
    const env: Env = { context, fields, sink, keepIdentity: options.includeSubmitter === true };
    const row = newRecord();
    row.sourceId = sourceId;
    row.sourceSystem = "odk";
    addSystemFields(row, system, options, sink, sourceId);
    walkOData(env, item, "", "", row, true, 0);
    media.push(...rowMedia);
    rows.push(finishRow(row, rowMedia, options, env, system));
  }
  return { rows, media, findings: sink.findings };
}

// ---------------------------------------------------------------------------
// CSV export

export interface OdkCsvInput {
  /** The main table, e.g. `simple.csv` from the export ZIP. */
  readonly main: string;
  /** Repeat tables, e.g. `simple-children.csv`. Keys are only labels; the connector reads KEY and PARENT_KEY. */
  readonly repeats?: Readonly<Record<string, string>>;
}

export interface OdkCsvOptions extends OdkConvertOptions {
  /** Set false when the export used `groupPaths=false` (headers are field names, not group-name paths). Default true. */
  readonly groupPaths?: boolean;
}

const META_COLUMNS = new Set(["SubmissionDate", "KEY", "PARENT_KEY", "SubmitterID", "SubmitterName", "AttachmentsPresent", "AttachmentsExpected", "Status", "ReviewState", "DeviceID", "Edits", "FormVersion"]);
const GEO_SUFFIXES = ["Latitude", "Longitude", "Altitude", "Accuracy"] as const;

type ColumnPlan =
  | { kind: "meta"; header: string; index: number }
  | { kind: "field"; header: string; index: number; path: string | undefined }
  | { kind: "geopoint"; base: string; path: string | undefined; indexes: readonly [number, number, number, number] }
  | { kind: "split"; header: string; index: number };

function headerFor(path: string, repeatPath: string, groupPaths: boolean, name: string): string {
  return groupPaths ? path.slice(repeatPath.length + 1).replaceAll("/", "-") : name;
}

function planColumns(headers: readonly string[], fields: readonly FormField[] | undefined, repeatPath: string, groupPaths: boolean): ColumnPlan[] {
  const byHeader = new Map<string, FormField>();
  for (const field of fields ?? []) {
    if (field.type === "structure" || field.type === "repeat") continue;
    if (repeatPath === "" ? hasRepeatAncestor(field.path, fields!) : !field.path.startsWith(`${repeatPath}/`) || hasRepeatAncestor(field.path, fields!, repeatPath)) continue;
    byHeader.set(headerFor(field.path, repeatPath, groupPaths, field.name), field);
  }
  const plan: ColumnPlan[] = [];
  const consumed = new Set<number>();
  headers.forEach((header, index) => {
    if (consumed.has(index)) return;
    if (META_COLUMNS.has(header)) { plan.push({ kind: "meta", header, index }); return; }
    if (header.endsWith("-Latitude")) {
      const base = header.slice(0, -"-Latitude".length);
      const indexes = GEO_SUFFIXES.map((suffix) => headers.indexOf(`${base}-${suffix}`));
      if (indexes.every((found) => found >= 0)) {
        indexes.forEach((found) => consumed.add(found));
        const field = byHeader.get(base);
        plan.push({ kind: "geopoint", base, path: field?.path, indexes: indexes as unknown as readonly [number, number, number, number] });
        return;
      }
    }
    const slash = header.lastIndexOf("/");
    if (slash > 0 && headers.includes(header.slice(0, slash))) { plan.push({ kind: "split", header, index }); return; }
    plan.push({ kind: "field", header, index, path: byHeader.get(header)?.path });
  });
  return plan;
}

function hasRepeatAncestor(path: string, fields: readonly FormField[], below = ""): boolean {
  const parts = path.split("/");
  for (let length = parts.length - 1; length >= 2; length -= 1) {
    const ancestor = parts.slice(0, length).join("/");
    if (ancestor.length <= below.length) break;
    if (fields.some((field) => field.path === ancestor && field.type === "repeat")) return true;
  }
  return false;
}

function rowFromCsv(env: Env, plan: readonly ColumnPlan[], cells: readonly string[], repeatPath: string, nested: boolean): Record<string, unknown> {
  const record = newRecord();
  const { context, sink } = env;
  const store = (rel: string, value: unknown): void => {
    if (value === undefined) return;
    record[nested ? rel : fieldKey(rel, sink, context.sourceId, true)] = value;
  };
  let droppedSplit = false;
  for (const column of plan) {
    if (column.kind === "meta") continue;
    if (column.kind === "split") { droppedSplit = true; continue; }
    if (column.kind === "geopoint") {
      const [lat, lon, alt, acc] = column.indexes.map((index) => cells[index]!.trim()) as [string, string, string, string];
      if (lat === "" && lon === "") continue;
      const path = column.path ?? `${repeatPath}/${column.base.replaceAll("-", "/")}`;
      const rel = column.path !== undefined ? column.path.slice(repeatPath.length + 1) : column.base;
      // Built from the four cells, so a blank altitude cannot shift the accuracy into its place.
      const point = pointFromParts(lat, lon, alt, acc);
      if (point === undefined) sink.add("warning", "geometry.unreadable", "The geopoint columns could not be read as numbers in range; the point was left out.", { sourceId: context.sourceId, field: path.slice(1) });
      else store(rel, point);
      continue;
    }
    const raw = cells[column.index]!;
    if (env.keepIdentity !== true && raw !== "" && isIdentityMetadata(column.path === undefined ? undefined : context.fields?.get(column.path), column.header)) {
      sink.add("info", "metadata.identity-dropped", `The column ${JSON.stringify(column.header)} identifies a device or a person; it was dropped. Set includeSubmitter to keep it.`, { sourceId: context.sourceId, field: column.header });
      continue;
    }
    if (column.path === undefined) {
      if (raw !== "") store(column.header, convertLeaf({ ...context, fields: undefined }, `${repeatPath}/${column.header}`, `${repeatPath}/${column.header}`.slice(1), raw));
      continue;
    }
    const rel = column.path.slice(repeatPath.length + 1);
    store(rel, convertLeaf(context, column.path, column.path.slice(1), raw));
  }
  if (droppedSplit) sink.add("info", "csv.split-select-dropped", "Columns written by splitSelectMultiples (field/choice, 0 or 1) were dropped; the main select_multiple column holds the same choices.");
  return record;
}

const INDEX_SUFFIX = /\[\d+\]$/u;

function repeatLocation(key: string): { instanceId: string; segments: string[] } | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0) return undefined;
  const segments = key.slice(slash + 1).split("/");
  for (const segment of segments) assertSafeKey(segment.replace(INDEX_SUFFIX, ""), "a repeat KEY");
  return { instanceId: key.slice(0, slash), segments };
}

const INDEX = /\[(\d+)\]$/u;

/**
 * Converts the unzipped CSV export. Pass `fields` to get the same keys and
 * typed values as the OData route; without it, CSV headers become keys
 * ("group-field") and values stay text, except geopoint column quartets.
 */
export function odkCsvToRows(input: OdkCsvInput, options: OdkCsvOptions = {}): ConnectorResult {
  const namespace = checkNamespace(options);
  const groupPaths = options.groupPaths ?? true;
  const maxRows = boundedInteger(options.maxRows, CONNECTOR_LIMITS.rows, CONNECTOR_LIMITS.rows, "maxRows");
  const fields = indexFields(options.fields);
  const sink = new FindingSink();
  const media: MediaReference[] = [];
  if (fields === undefined) sink.add("info", "fields.not-supplied", "No form definition was given. CSV headers are kept as keys and values stay text, except geopoint column quartets.");
  const main = parseDelimited(input.main, { delimiter: ",", maxRows });
  const mainPlan = planColumns(main.headers, options.fields, "", groupPaths);
  const keyIndex = main.headers.indexOf("KEY");
  if (keyIndex < 0) fail("csv.no-key", "The main table has no KEY column. Is this an ODK Central export?");
  const col = (name: string): number => main.headers.indexOf(name);

  const rowMedia = new Map<string, MediaReference[]>();
  const contexts = new Map<string, RowContext>();
  const contextFor = (instanceId: string): RowContext => {
    let context = contexts.get(instanceId);
    if (!context) {
      const list: MediaReference[] = [];
      rowMedia.set(instanceId, list);
      const attachmentPath = attachmentPathFor(options, instanceId);
      context = { sourceId: `${namespace}:${instanceId}`, source: "odk", fields, sink, media: list, timestamps: options, ...(attachmentPath === undefined ? {} : { attachmentPath }) };
      contexts.set(instanceId, context);
    }
    return context;
  };

  const records = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  const attachmentsExpectedBy = new Map<string, number>();
  for (const cells of main.rows) {
    const key = cells[keyIndex]!;
    if (key === "") fail("csv.empty-key", "A row in the main table has an empty KEY.");
    if (records.has(key)) fail("csv.duplicate-key", `KEY ${key} appears twice.`);
    const context = contextFor(key);
    const env: Env = { context, fields, sink, keepIdentity: options.includeSubmitter === true };
    const row = rowFromCsv(env, mainPlan, cells, "", false);
    const out = newRecord();
    out.sourceId = context.sourceId;
    out.sourceSystem = "odk";
    Object.assign(out, row);
    const system = newRecord();
    const at = (name: string): string => (col(name) >= 0 ? cells[col(name)]!.trim() : "");
    if (at("SubmissionDate") !== "") system.submissionDate = at("SubmissionDate");
    if (at("FormVersion") !== "") system.formVersion = at("FormVersion");
    if (at("ReviewState") !== "") system.reviewState = at("ReviewState");
    if (at("Status") !== "") system.status = at("Status");
    if (/^\d+$/u.test(at("Edits"))) system.edits = Number(at("Edits"));
    if (at("SubmitterID") !== "") system.submitterId = at("SubmitterID");
    if (at("SubmitterName") !== "") system.submitterName = at("SubmitterName");
    if (at("DeviceID") !== "") system.deviceId = at("DeviceID");
    addSystemFields(out, system, options, sink, context.sourceId);
    if (out["meta/instanceID"] === key) delete out["meta/instanceID"];
    records.set(key, out);
    attachmentsExpectedBy.set(key, Number(at("AttachmentsExpected")) || 0);
    order.push(key);
  }

  // Repeat tables: build every row first, then attach by KEY / PARENT_KEY.
  const pendingKeys = new Set<string>();
  const pending: { key: string; parent: string; index: number; record: Record<string, unknown> }[] = [];
  let repeatRows = 0;
  for (const [label, text] of Object.entries(input.repeats ?? {})) {
    assertSafeKey(label, "a repeat table label");
    const table = parseDelimited(text, { delimiter: ",", maxRows });
    const repeatKey = table.headers.indexOf("KEY");
    const parentKey = table.headers.indexOf("PARENT_KEY");
    if (repeatKey < 0 || parentKey < 0) fail("csv.no-key", `Repeat table ${JSON.stringify(label)} needs KEY and PARENT_KEY columns.`);
    let plan: ColumnPlan[] | undefined;
    let repeatPath = "";
    for (const cells of table.rows) {
      repeatRows += 1;
      if (repeatRows > maxRows * 10) fail("limit.rows", "The repeat tables hold too many rows.");
      const key = cells[repeatKey]!;
      const location = repeatLocation(key);
      if (!location || !INDEX.test(location.segments[location.segments.length - 1]!)) fail("csv.repeat-key", `Repeat KEY ${JSON.stringify(key.slice(0, 80))} is not of the form <instance>/<path>[n].`);
      if (plan === undefined) {
        repeatPath = `/${location.segments.map((segment) => segment.replace(INDEX, "")).join("/")}`;
        plan = planColumns(table.headers, options.fields, repeatPath, groupPaths);
      }
      if (records.has(key) || pendingKeys.has(key)) fail("csv.duplicate-key", `KEY ${key} appears twice.`);
      pendingKeys.add(key);
      const context = contextFor(location.instanceId);
      const record = rowFromCsv({ context, fields, sink, keepIdentity: options.includeSubmitter === true }, plan, cells, repeatPath, true);
      pending.push({ key, parent: cells[parentKey]!, index: Number(INDEX.exec(location.segments[location.segments.length - 1]!)![1]), record });
    }
  }
  const byKey = new Map<string, Record<string, unknown>>(records);
  for (const item of pending) byKey.set(item.key, item.record);
  pending.sort((left, right) => left.index - right.index);
  for (const item of pending) {
    const parent = byKey.get(item.parent);
    if (!parent) { sink.add("warning", "csv.orphan-repeat-row", `A repeat row (${item.key.slice(0, 80)}) names a parent that is not in the export; it was left out.`); continue; }
    const relative = item.key.slice(item.parent.length + 1).replace(INDEX, "");
    const key = records.has(item.parent) ? fieldKey(relative, sink, (parent.sourceId as string | undefined) ?? "", true) : relative;
    const existing = Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (existing !== undefined && !Array.isArray(existing)) fail("csv.repeat-key-collision", `A repeat named ${JSON.stringify(relative)} would overwrite a value of the same name in its parent row.`);
    if (Array.isArray(existing)) existing.push(item.record);
    else parent[key] = [item.record];
  }

  const rows: ConnectorRow[] = [];
  for (const key of order) {
    const record = records.get(key)!;
    const context = contexts.get(key)!;
    const mediaList = rowMedia.get(key)!;
    media.push(...mediaList);
    rows.push(finishRow(record, mediaList, options, { context, fields, sink, keepIdentity: options.includeSubmitter === true }, { attachmentsExpected: attachmentsExpectedBy.get(key) ?? 0 }));
  }
  return { rows, media, findings: sink.findings };
}

// ---------------------------------------------------------------------------
// Fetching (inject fetch; nothing here reads the environment)

export interface OdkFetchOptions {
  /** Origin only, e.g. "https://central.example.org". */
  readonly server: string;
  readonly project: number | string;
  readonly form: string;
  /** A Central session token (`POST /v1/sessions`) or an app-user token. Never logged, never put in a URL. */
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}

export interface OdkSubmissionQuery {
  /** `$expand=*` so repeats arrive nested. Default true. */
  readonly expand?: boolean;
  /** `$wkt=true`: geometries as WKT text. Default false (GeoJSON). */
  readonly wkt?: boolean;
  /** An OData `$filter`, passed through. At most 512 characters, no control characters. */
  readonly filter?: string;
}

function checkFetch(options: OdkFetchOptions): { server: URL; project: string; fetchImpl: FetchLike; timeoutMs: number; maxBytes: number; headers: Record<string, string> } {
  const server = originOnlyHttpsUrl(options.server, "server");
  const project = String(options.project);
  if (!/^\d{1,12}$/u.test(project)) fail("option.project", "project must be a numeric Central project id.");
  if (typeof options.form !== "string" || !FORM_ID.test(options.form)) fail("option.form", "form must be an xmlFormId of letters, digits, '.', '_' and '-'.");
  if (typeof options.token !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(options.token)) fail("option.token", "token must be printable text without spaces.");
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== "function") fail("fetch.unavailable", "No fetch function is available.");
  return {
    server,
    project,
    fetchImpl,
    timeoutMs: boundedInteger(options.timeoutMs, 15_000, CONNECTOR_LIMITS.timeoutMs, "timeoutMs"),
    maxBytes: boundedInteger(options.maxBytes, CONNECTOR_LIMITS.bytes, CONNECTOR_LIMITS.bytes, "maxBytes"),
    headers: { accept: "application/json", authorization: `Bearer ${options.token}` },
  };
}

/** Fetches raw OData submission rows, following same-origin, same-path `@odata.nextLink` pages. */
export async function fetchOdkSubmissions(options: OdkFetchOptions, query: OdkSubmissionQuery = {}): Promise<Record<string, unknown>[]> {
  const checked = checkFetch(options);
  const maxRows = boundedInteger(options.maxRows, CONNECTOR_LIMITS.rows, CONNECTOR_LIMITS.rows, "maxRows");
  const base = new URL(`/v1/projects/${checked.project}/forms/${encodeURIComponent(options.form)}.svc/Submissions`, checked.server);
  base.searchParams.set("$top", String(Math.min(CONNECTOR_LIMITS.pageSize, maxRows)));
  if (query.expand !== false) base.searchParams.set("$expand", "*");
  if (query.wkt === true) base.searchParams.set("$wkt", "true");
  if (query.filter !== undefined) {
    if (query.filter.length > 512 || /[\u0000-\u001f\u007f]/u.test(query.filter)) fail("option.filter", "filter must be at most 512 characters without control characters.");
    base.searchParams.set("$filter", query.filter);
  }
  const rows: Record<string, unknown>[] = [];
  let totalBytes = 0;
  let page: URL | null = base;
  let pages = 0;
  while (page !== null) {
    pages += 1;
    if (pages > 1000) fail("limit.pages", "More than 1,000 pages; stopped.");
    if (totalBytes >= checked.maxBytes) fail("limit.bytes", "The responses are larger than the byte limit.");
    const url: URL = page;
    const document = await withTimeout(checked.timeoutMs, (signal) => fetchJson(url, { fetchImpl: checked.fetchImpl, headers: checked.headers, timeoutMs: checked.timeoutMs, maxBytes: checked.maxBytes - totalBytes, label: "ODK Central" }, signal), "ODK Central");
    totalBytes += JSON.stringify(document).length;
    if (!isPlainObject(document) || !Array.isArray(document.value)) fail("odata.shape", "The OData response has no value array.");
    for (const row of document.value) {
      if (!isPlainObject(row)) fail("odata.row", "A submission row must be an object.");
      if (typeof row.__id !== "string" || row.__id.length === 0 || row.__id.length > 256) fail("odata.missing-id", "A submission row has no __id.");
      rows.push(row);
      if (rows.length > maxRows) fail("limit.rows", `The server returned more than ${maxRows} submissions.`);
    }
    page = document["@odata.nextLink"] ? confinedNextLink(document["@odata.nextLink"], checked.server, base) : null;
  }
  return rows;
}

/** Fetches the form's field list from `GET /v1/projects/{id}/forms/{xmlFormId}/fields`. */
export async function fetchOdkFields(options: OdkFetchOptions): Promise<FormField[]> {
  const checked = checkFetch(options);
  const url = new URL(`/v1/projects/${checked.project}/forms/${encodeURIComponent(options.form)}/fields`, checked.server);
  const json = await withTimeout(checked.timeoutMs, (signal) => fetchJson(url, { fetchImpl: checked.fetchImpl, headers: checked.headers, timeoutMs: checked.timeoutMs, maxBytes: 4 * 1024 * 1024, label: "ODK Central" }, signal), "ODK Central");
  return odkFieldsFromApi(json);
}

/** Fetches the field list and the submissions, then converts them. */
export async function readOdkForm(options: OdkFetchOptions, convert: OdkConvertOptions = {}, query: OdkSubmissionQuery = {}): Promise<ConnectorResult> {
  const fields = convert.fields ?? (await fetchOdkFields(options));
  const rows = await fetchOdkSubmissions(options, query);
  return odkODataToRows(rows, { ...convert, fields, project: options.project, form: options.form });
}

