/**
 * KoboToolbox connector.
 *
 * KoboToolbox forms are XLSForms, like ODK's, so values look alike: geopoints
 * as "lat lon alt accuracy", select_multiple as a space-separated string,
 * groups as "group/question" keys. The differences this module handles:
 * - the v2 data API (`GET /api/v2/assets/{uid}/data/?format=json`) returns
 *   `{ count, next, previous, results }` with every value as text, repeats as
 *   arrays of objects keyed by full path, and system keys that start with "_"
 *   (`_uuid`, `_submission_time`, `_geolocation`, `_attachments`, ...);
 * - `_submission_time` has no offset and is UTC;
 * - the field list comes from the asset's `content.survey` (XLSForm rows),
 *   not from an XForm;
 * - CSV exports are ";"-delimited by default, with `_index`, `_parent_table_name`
 *   and `_parent_index` joining repeat tables.
 *
 * Formats follow KoboToolbox's public API documentation (the OpenAPI schema
 * at `/api/v2/schema/`) and the XLSForm specification. KoboToolbox's source
 * (KPI) is AGPL-3.0: nothing was copied from it, and this module only reads
 * what the API returns. Test data in this repository is synthetic, written to
 * match that documentation.
 */
import {
  CONNECTOR_LIMITS,
  FindingSink,
  applyPrimaryFields,
  assertJsonShape,
  assertSafeKey,
  boundedInteger,
  isIdentityMetadata,
  isPublicHttpsUrl,
  looksLikeGeoJson,
  RESERVED_KEYS,
  confinedNextLink,
  convertLeaf,
  fail,
  fetchJson,
  fieldKey,
  indexFields,
  isPlainObject,
  isSafeFilename,
  mediaTypeFor,
  newRecord,
  normaliseDateTime,
  originOnlyHttpsUrl,
  parseDelimited,
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

export interface KoboConvertOptions extends LocationOptions, TimestampOptions {
  /** Fields from `koboFieldsFromSurvey`. Strongly recommended: every Kobo JSON value is text. */
  readonly fields?: readonly FormField[];
  /** Prefix for sourceId. Default "kobo". */
  readonly namespace?: string;
  /** Adds submitterName (`_submitted_by`). It names a person: off by default. */
  readonly includeSubmitter?: boolean;
  readonly maxRows?: number;
}

const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/u;
const ASSET_UID = /^[A-Za-z0-9]{10,40}$/u;

function checkNamespace(options: KoboConvertOptions): string {
  const namespace = options.namespace ?? "kobo";
  if (!NAMESPACE.test(namespace)) fail("option.namespace", "namespace must be lower-case letters, digits and hyphens, starting with a letter.");
  return namespace;
}

// ---------------------------------------------------------------------------
// XLSForm survey rows -> fields

const TYPE_MAP: Readonly<Record<string, string>> = {
  integer: "int", int: "int", decimal: "decimal", range: "decimal",
  text: "string", string: "string", select_one: "string", select_one_from_file: "string", rank: "string", calculate: "string", hidden: "string", acknowledge: "string", barcode: "string",
  date: "date", datetime: "dateTime", time: "time", start: "dateTime", end: "dateTime", today: "date",
  geopoint: "geopoint", geotrace: "geotrace", geoshape: "geoshape",
  image: "binary", photo: "binary", audio: "binary", video: "binary", file: "binary", signature: "binary", "background-audio": "binary",
  deviceid: "string", username: "string", email: "string", phonenumber: "string", subscriberid: "string", simserial: "string",
};

/** XLSForm metadata question types that identify a device or a person. */
const IDENTITY_TYPES: ReadonlySet<string> = new Set(["deviceid", "subscriberid", "simserial", "phonenumber", "username", "email"]);

const NO_DATA = new Set(["note", "end_group", "end group", "end_repeat", "end repeat"]);

/**
 * Reads the field list from an asset's `content.survey` rows (the XLSForm
 * `survey` sheet as KoboToolbox returns it). Groups and repeats are tracked
 * with begin_group / end_group, begin_repeat / end_repeat. Paths use the
 * row's `$xpath` when the server supplies it, and the group stack otherwise.
 */
export function koboFieldsFromSurvey(survey: unknown): FormField[] {
  if (!Array.isArray(survey)) fail("fields.invalid", "The survey must be an array of XLSForm rows.");
  assertJsonShape(survey, "survey");
  if (survey.length > 20_000) fail("limit.rows", "The survey has more than 20,000 rows.");
  const fields: FormField[] = [];
  const stack: string[] = [];
  for (const row of survey) {
    if (!isPlainObject(row) || typeof row.type !== "string") fail("fields.invalid", "A survey row needs a type.");
    const rawType = row.type.trim();
    const kind = rawType.split(/\s+/u)[0]!.toLowerCase();
    const name = typeof row.name === "string" && row.name !== "" ? row.name : typeof row.$autoname === "string" ? row.$autoname : undefined;
    if (/^(begin|start)[_ ](group|repeat)$/u.test(rawType.toLowerCase())) {
      if (name === undefined) fail("fields.invalid", "A begin_group / begin_repeat row needs a name.");
      assertSafeKey(name, "a survey row name");
      stack.push(name);
      const path = typeof row.$xpath === "string" && row.$xpath !== "" ? `/${row.$xpath}` : `/${stack.join("/")}`;
      fields.push({ path, name, type: rawType.toLowerCase().endsWith("repeat") ? "repeat" : "structure" });
      continue;
    }
    if (NO_DATA.has(rawType.toLowerCase())) {
      if (rawType.toLowerCase().startsWith("end")) stack.pop();
      continue;
    }
    if (name === undefined) continue;
    assertSafeKey(name, "a survey row name");
    const path = typeof row.$xpath === "string" && row.$xpath !== "" ? `/${row.$xpath}` : `/${[...stack, name].join("/")}`;
    const selectMultiple = kind === "select_multiple" || kind === "select_multiple_from_file";
    const type = selectMultiple ? "string" : TYPE_MAP[kind] ?? "string";
    fields.push({ path, name, type, ...(type === "binary" ? { binary: true } : {}), ...(selectMultiple ? { selectMultiple: true } : {}), ...(IDENTITY_TYPES.has(kind) ? { identity: true } : {}) });
  }
  indexFields(fields);
  return fields;
}

// ---------------------------------------------------------------------------
// JSON (v2 data API)

type Env = { readonly context: RowContext; readonly fields: FieldIndex | undefined; readonly sink: FindingSink; readonly keepIdentity?: boolean };

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? "";
}

function httpsUrlOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  // https only, no credentials, and not an internal address (localhost, loopback, link-local, private ranges).
  // Callers must still sandbox any fetch of it and never send the API token there.
  return isPublicHttpsUrl(value) ? new URL(value).href : undefined;
}

function walkRecord(env: Env, item: Record<string, unknown>, repeatPath: string, target: Record<string, unknown>, top: boolean, depth: number): void {
  if (depth > CONNECTOR_LIMITS.depth) fail("json.depth-limit", "A submission nests deeper than the connector accepts.");
  const { context, sink } = env;
  for (const key of Object.keys(item)) {
    assertSafeKey(key, "a Kobo row");
    if (top && (key.startsWith("_") || key === "formhub/uuid" || key === "meta/instanceID" || key === "meta/deprecatedID" || key === "meta/rootUuid")) continue;
    const raw = item[key];
    if (raw === null || raw === undefined) continue;
    const path = `/${key}`;
    const rel = repeatPath !== "" && path.startsWith(`${repeatPath}/`) ? path.slice(repeatPath.length + 1) : key;
    const store = (value: unknown): void => { if (value !== undefined) target[top ? fieldKey(rel, sink, context.sourceId, true) : rel] = value; };
    if (Array.isArray(raw)) {
      if (raw.every(isPlainObject) && raw.length > 0) {
        const children = raw.map((entry) => {
          const record = newRecord();
          walkRecord(env, entry as Record<string, unknown>, path, record, false, depth + 1);
          return record;
        });
        store(children);
      } else store(raw.length === 0 ? undefined : raw);
      continue;
    }
    if (isPlainObject(raw)) { store(raw); continue; }
    if (env.keepIdentity !== true && isIdentityMetadata(env.fields?.get(path), key)) {
      sink.add("info", "metadata.identity-dropped", `The question ${JSON.stringify(key)} identifies a device or a person; it was dropped. Set includeSubmitter to keep it.`, { sourceId: context.sourceId, field: key });
      continue;
    }
    store(convertLeaf(context, path, key, raw));
  }
}

function attachmentsOf(item: Record<string, unknown>, sink: FindingSink, sourceId: string): Map<string, { url?: string; mediaType?: string }> {
  const out = new Map<string, { url?: string; mediaType?: string }>();
  const list = item._attachments;
  if (list === undefined || list === null) return out;
  if (!Array.isArray(list)) { sink.add("warning", "media.shape", "_attachments is not a list; no media references were made.", { sourceId }); return out; }
  for (const entry of list) {
    if (!isPlainObject(entry) || entry.is_deleted === true) continue;
    const name = typeof entry.media_file_basename === "string" ? entry.media_file_basename : typeof entry.filename === "string" ? basename(entry.filename) : "";
    if (!isSafeFilename(name)) { sink.add("warning", "media.unsafe-filename", "An attachment name has a path separator, '..' or a control character; no media reference was made.", { sourceId }); continue; }
    const url = httpsUrlOrUndefined(entry.download_url);
    if (url === undefined && entry.download_url !== undefined && entry.download_url !== null && entry.download_url !== "") {
      sink.add("warning", "media.url-not-public", "An attachment download URL is not a public https address (http, credentials, localhost, loopback, link-local or a private range); it was not kept.", { sourceId });
    }
    out.set(name, { ...(url === undefined ? {} : { url }), ...(typeof entry.mimetype === "string" ? { mediaType: entry.mimetype } : {}) });
  }
  return out;
}

function findFieldFor(row: Record<string, unknown>, filename: string): string | undefined {
  for (const key of Object.keys(row)) if (row[key] === filename) return key;
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (isPlainObject(entry)) { const inner = findFieldFor(entry, filename); if (inner !== undefined) return `${key}/${inner}`; }
    }
  }
  return undefined;
}

function finishKobo(row: Record<string, unknown>, item: Record<string, unknown>, env: Env, options: KoboConvertOptions, rowMedia: MediaReference[], attachments: Map<string, { url?: string; mediaType?: string }>): ConnectorRow {
  const { sink, context } = env;
  const submitted = item._submission_time;
  if (typeof submitted === "string" && submitted !== "") {
    const result = normaliseDateTime(submitted, { ...options, sourceIsUtc: true });
    if (result.code !== undefined) sink.add("warning", result.code, `submittedAt: ${result.message}`, { field: "submittedAt" });
    row.submittedAt = result.value;
  }
  if (typeof item.__version__ === "string" && item.__version__ !== "") row.formVersion = item.__version__;
  const validation = item._validation_status;
  if (isPlainObject(validation)) {
    const label = typeof validation.label === "string" && validation.label !== "" ? validation.label : typeof validation.uid === "string" ? validation.uid : undefined;
    if (label !== undefined) row.validationStatus = label;
  }
  if (options.includeSubmitter === true && typeof item._submitted_by === "string") row.submitterName = item._submitted_by;

  // If a listed private field was a point, Kobo's own _geolocation (computed from the first geopoint) would put it straight back.
  const droppedPoint = (options.restrictedFields ?? []).some((key) => looksLikeGeoJson(row[key]));
  applyPrimaryFields(row, env.fields, options, sink, context.sourceId);
  // Kobo computes `_geolocation` from the form's first geopoint; use it only when no field supplied a location.
  const geolocation = item._geolocation;
  if (!droppedPoint && row.latitude === undefined && Array.isArray(geolocation) && geolocation.length === 2 && typeof geolocation[0] === "number" && typeof geolocation[1] === "number"
    && Math.abs(geolocation[0]) <= 90 && Math.abs(geolocation[1]) <= 180) {
    row.latitude = geolocation[0];
    row.longitude = geolocation[1];
  }

  // Attachments the server lists but no typed field claimed (no form definition, or a renamed field).
  for (const [filename, info] of attachments) {
    if (rowMedia.some((entry) => entry.filename === filename)) continue;
    rowMedia.push({
      sourceId: context.sourceId,
      field: findFieldFor(row, filename) ?? "(unmatched)",
      filename,
      mediaType: mediaTypeFor(filename, info.mediaType),
      source: "kobo",
      ...(info.url === undefined ? {} : { remoteUrl: info.url }),
    });
  }
  if (rowMedia.length > 0) row.media = rowMedia.map(({ field, filename, mediaType, remoteUrl }) => ({ field, filename, mediaType, ...(remoteUrl === undefined ? {} : { remoteUrl }) }));
  return row as ConnectorRow;
}

/** Converts the v2 data API response (`{ results: [...] }`) or a bare array of rows. */
export function koboJsonToRows(document: unknown, options: KoboConvertOptions = {}): ConnectorResult {
  const namespace = checkNamespace(options);
  const maxRows = boundedInteger(options.maxRows, CONNECTOR_LIMITS.rows, CONNECTOR_LIMITS.rows, "maxRows");
  assertJsonShape(document, "Kobo data document");
  const list = Array.isArray(document) ? document : isPlainObject(document) && Array.isArray(document.results) ? document.results : undefined;
  if (list === undefined) fail("kobo.shape", "Expected a Kobo data document with a results array, or an array of rows.");
  if (list.length > maxRows) fail("limit.rows", `The document has more than ${maxRows} submissions.`);
  const fields = indexFields(options.fields);
  const sink = new FindingSink();
  const media: MediaReference[] = [];
  const rows: ConnectorRow[] = [];
  const seen = new Set<string>();
  if (fields === undefined) sink.add("info", "fields.not-supplied", "No form definition was given. Kobo writes every value as text, so numbers, dates, geopoints and select_multiple values stay as written.");

  for (const item of list) {
    if (!isPlainObject(item)) fail("kobo.row", "A submission row must be an object.");
    const id = typeof item._uuid === "string" && item._uuid !== "" ? item._uuid : typeof item._id === "number" || typeof item._id === "string" ? String(item._id) : undefined;
    if (id === undefined || id.length > 256) fail("kobo.missing-id", "A submission row has neither _uuid nor _id.");
    const sourceId = `${namespace}:${id}`;
    if (seen.has(sourceId)) fail("kobo.duplicate-id", `Submission ${id} appears twice.`);
    seen.add(sourceId);
    const attachments = attachmentsOf(item, sink, sourceId);
    const rowMedia: MediaReference[] = [];
    const context: RowContext = { sourceId, source: "kobo", fields, sink, media: rowMedia, timestamps: options, remoteUrls: attachments };
    const env: Env = { context, fields, sink, keepIdentity: options.includeSubmitter === true };
    const row = newRecord();
    row.sourceId = sourceId;
    row.sourceSystem = "kobo";
    walkRecord(env, item, "", row, true, 0);
    const finished = finishKobo(row, item, env, options, rowMedia, attachments);
    media.push(...rowMedia);
    rows.push(finished);
  }
  return { rows, media, findings: sink.findings };
}

// ---------------------------------------------------------------------------
// CSV export

export interface KoboCsvInput {
  /** The main sheet. */
  readonly main: string;
  /** Repeat sheets keyed by the repeat group name (the name Kobo puts in `_parent_table_name` of its children). */
  readonly repeats?: Readonly<Record<string, string>>;
}

export interface KoboCsvOptions extends KoboConvertOptions {
  /** The name Kobo gives the main table in `_parent_table_name` (the form name). Default: any name that is not a repeat sheet. */
  readonly mainTableName?: string;
}

const DERIVED_GEO = /^_.+_(?:latitude|longitude|altitude|precision)$/u;

function resolvePath(header: string, byName: ReadonlyMap<string, FormField[]> | undefined, fields: FieldIndex | undefined): string {
  if (fields?.has(`/${header}`)) return `/${header}`;
  if (header.includes("/")) return `/${header}`;
  const candidates = byName?.get(header);
  if (candidates !== undefined && candidates.length === 1) return candidates[0]!.path;
  return `/${header}`;
}

function nameIndex(options: readonly FormField[] | undefined): Map<string, FormField[]> | undefined {
  if (options === undefined) return undefined;
  const map = new Map<string, FormField[]>();
  for (const field of options) map.set(field.name, [...(map.get(field.name) ?? []), field]);
  return map;
}

interface SheetColumn { readonly header: string; readonly index: number; readonly path: string }

function sheetColumns(headers: readonly string[], byName: ReadonlyMap<string, FormField[]> | undefined, fields: FieldIndex | undefined): SheetColumn[] {
  const columns: SheetColumn[] = [];
  headers.forEach((header, index) => {
    if (header.startsWith("_") || header === "formhub/uuid" || header === "meta/instanceID" || header === "meta/deprecatedID" || DERIVED_GEO.test(header)) return;
    const slash = header.lastIndexOf("/");
    if (slash > 0 && headers.includes(header.slice(0, slash)) && !fields?.has(`/${header}`)) return; // split select_multiple choice column
    columns.push({ header, index, path: resolvePath(header, byName, fields) });
  });
  return columns;
}

function koboCsvRecord(env: Env, columns: readonly SheetColumn[], cells: readonly string[], repeatPath: string, nested: boolean): Record<string, unknown> {
  const record = newRecord();
  const { context, sink } = env;
  for (const column of columns) {
    const raw = cells[column.index]!;
    if (env.keepIdentity !== true && raw !== "" && isIdentityMetadata(env.fields?.get(column.path), column.header)) {
      sink.add("info", "metadata.identity-dropped", `The column ${JSON.stringify(column.header)} identifies a device or a person; it was dropped. Set includeSubmitter to keep it.`, { sourceId: context.sourceId, field: column.header });
      continue;
    }
    const value = convertLeaf(context, column.path, column.path.slice(1), raw);
    if (value === undefined) continue;
    const rel = repeatPath !== "" && column.path.startsWith(`${repeatPath}/`) ? column.path.slice(repeatPath.length + 1) : column.path.slice(1);
    record[nested ? rel : fieldKey(rel, sink, context.sourceId, true)] = value;
  }
  return record;
}

/**
 * Converts a Kobo CSV export. Use "XML values and headers" when exporting, so
 * headers are question names (Kobo's "labels" format cannot be mapped; the
 * connector says so). Delimiter is detected (Kobo writes ";").
 */
export function koboCsvToRows(input: KoboCsvInput, options: KoboCsvOptions = {}): ConnectorResult {
  const namespace = checkNamespace(options);
  const maxRows = boundedInteger(options.maxRows, CONNECTOR_LIMITS.rows, CONNECTOR_LIMITS.rows, "maxRows");
  const fields = indexFields(options.fields);
  const byName = nameIndex(options.fields);
  const sink = new FindingSink();
  const media: MediaReference[] = [];
  if (fields === undefined) sink.add("info", "fields.not-supplied", "No form definition was given. CSV headers become keys and values stay text.");

  const main = parseDelimited(input.main, { maxRows });
  const idColumn = main.headers.indexOf("_uuid") >= 0 ? main.headers.indexOf("_uuid") : main.headers.indexOf("_id");
  if (idColumn < 0) fail("csv.no-id", "The main sheet has neither _uuid nor _id. Export with the system columns included.");
  const mainColumns = sheetColumns(main.headers, byName, fields);
  if (fields !== undefined && mainColumns.length > 0 && !mainColumns.some((column) => fields.has(column.path))) {
    sink.add("warning", "csv.headers-not-recognised", "No column header matches a field in the form definition. Export with \"XML values and headers\" instead of labels.");
  }
  const col = (name: string): number => main.headers.indexOf(name);
  const indexColumn = col("_index");

  const records: Record<string, unknown>[] = [];
  const mainContext = new Map<string, { context: RowContext; media: MediaReference[] }>();
  main.rows.forEach((cells, position) => {
    const id = cells[idColumn]!;
    if (id === "") fail("csv.empty-id", "A row in the main sheet has an empty _uuid / _id.");
    const sourceId = `${namespace}:${id}`;
    if (mainContext.has(sourceId)) fail("csv.duplicate-id", `Submission ${id} appears twice.`);
    const list: MediaReference[] = [];
    const context: RowContext = { sourceId, source: "kobo", fields, sink, media: list, timestamps: options };
    const slot = { context, media: list };
    mainContext.set(sourceId, slot);
    const row = koboCsvRecord({ context, fields, sink, keepIdentity: options.includeSubmitter === true }, mainColumns, cells, "", false);
    const out = newRecord();
    out.sourceId = sourceId;
    out.sourceSystem = "kobo";
    Object.assign(out, row);
    records.push(out);
  });

  // Repeat sheets: attach to the parent row named by _parent_table_name and _parent_index.
  const repeatNames = Object.keys(input.repeats ?? {});
  const byTable = new Map<string, Map<number, Record<string, unknown>>>();
  const mainByIndex = new Map<number, Record<string, unknown>>();
  main.rows.forEach((cells, position) => mainByIndex.set(indexColumn >= 0 && /^\d+$/u.test(cells[indexColumn]!) ? Number(cells[indexColumn]) : position + 1, records[position]!));
  const attachments: { table: string; parentTable: string; parentIndex: number; index: number; record: Record<string, unknown>; relative: string }[] = [];
  for (const table of repeatNames) {
    assertSafeKey(table, "a repeat sheet name");
    const sheet = parseDelimited(input.repeats![table]!, { maxRows });
    const parentName = sheet.headers.indexOf("_parent_table_name");
    const parentIndex = sheet.headers.indexOf("_parent_index");
    const ownIndex = sheet.headers.indexOf("_index");
    if (parentName < 0 || parentIndex < 0) fail("csv.no-parent", `Repeat sheet ${JSON.stringify(table)} needs _parent_table_name and _parent_index.`);
    const repeatField = options.fields?.find((field) => field.type === "repeat" && field.name === table);
    const repeatPath = repeatField?.path ?? "";
    const columns = sheetColumns(sheet.headers, byName, fields);
    const indexMap = new Map<number, Record<string, unknown>>();
    byTable.set(table, indexMap);
    sheet.rows.forEach((cells, position) => {
      const parentTable = cells[parentName]!;
      const parentPosition = Number(cells[parentIndex]);
      const index = ownIndex >= 0 && /^\d+$/u.test(cells[ownIndex]!) ? Number(cells[ownIndex]) : position + 1;
      // The root submission is found through the main sheet; deeper parents are resolved after all sheets are read.
      const parentRoot = parentTable === options.mainTableName || !repeatNames.includes(parentTable) ? mainByIndex.get(parentPosition) : undefined;
      const holder = parentRoot ?? undefined;
      const rootId = holder === undefined ? undefined : (holder.sourceId as string);
      const slot = rootId === undefined ? undefined : mainContext.get(rootId);
      const context: RowContext = slot?.context ?? { sourceId: `${namespace}:(repeat:${table}:${index})`, source: "kobo", fields, sink, media: [], timestamps: options };
      const record = koboCsvRecord({ context, fields, sink, keepIdentity: options.includeSubmitter === true }, columns, cells, repeatPath, true);
      indexMap.set(index, record);
      attachments.push({ table, parentTable, parentIndex: parentPosition, index, record, relative: table });
    });
  }
  for (const item of attachments) {
    const parent = byTable.get(item.parentTable)?.get(item.parentIndex) ?? ((item.parentTable === options.mainTableName || !repeatNames.includes(item.parentTable)) ? mainByIndex.get(item.parentIndex) : undefined);
    if (!parent) { sink.add("warning", "csv.orphan-repeat-row", `A row in repeat sheet ${JSON.stringify(item.table)} names a parent (${item.parentTable} #${item.parentIndex}) that is not in the export; it was left out.`); continue; }
    const repeatField = options.fields?.find((field) => field.type === "repeat" && field.name === item.table);
    let relative = item.table;
    if (repeatField !== undefined) {
      const parentField = options.fields?.find((field) => field.type === "repeat" && field.name === item.parentTable);
      relative = parentField !== undefined && repeatField.path.startsWith(`${parentField.path}/`) ? repeatField.path.slice(parentField.path.length + 1) : repeatField.path.slice(1);
    }
    const isRoot = mainByIndex.get(item.parentIndex) === parent;
    const key = isRoot ? fieldKey(relative, sink, (parent.sourceId as string | undefined) ?? "", true) : relative;
    const existing = Object.hasOwn(parent, key) ? parent[key] : undefined;
    if (existing !== undefined && !Array.isArray(existing)) fail("csv.repeat-key-collision", `A repeat named ${JSON.stringify(relative)} would overwrite a value of the same name in its parent row.`);
    if (Array.isArray(existing)) existing.push(item.record);
    else parent[key] = [item.record];
  }

  // Re-run the system fields in one place so JSON and CSV agree.
  records.forEach((out, position) => {
    const cells = main.rows[position]!;
    const slot = mainContext.get(out.sourceId as string)!;
    const at = (name: string): string => (col(name) >= 0 ? cells[col(name)]!.trim() : "");
    const system: Record<string, unknown> = {};
    if (at("_submission_time") !== "") system._submission_time = at("_submission_time");
    if (at("__version__") !== "") system.__version__ = at("__version__");
    if (at("_validation_status") !== "") system._validation_status = { label: at("_validation_status") };
    if (at("_submitted_by") !== "") system._submitted_by = at("_submitted_by");
    finishKobo(out, system, { context: slot.context, fields, sink }, options, slot.media, new Map());
  });

  const rows: ConnectorRow[] = [];
  for (const out of records) {
    const slot = mainContext.get(out.sourceId as string)!;
    media.push(...slot.media);
    rows.push(out as ConnectorRow);
  }
  return { rows, media, findings: sink.findings };
}

// ---------------------------------------------------------------------------
// Fetching

export interface KoboFetchOptions {
  /** Origin only, e.g. "https://kf.kobotoolbox.org" or your own server. */
  readonly server: string;
  /** The asset (form) uid from its URL. */
  readonly assetUid: string;
  /** An API token (`Authorization: Token ...`). Never logged, never put in a URL. */
  readonly token: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxRows?: number;
  readonly maxBytes?: number;
}

function checkKobo(options: KoboFetchOptions): { server: URL; fetchImpl: FetchLike; timeoutMs: number; maxBytes: number; headers: Record<string, string> } {
  const server = originOnlyHttpsUrl(options.server, "server");
  if (typeof options.assetUid !== "string" || !ASSET_UID.test(options.assetUid)) fail("option.asset", "assetUid must be the form's uid: 10 to 40 letters and digits.");
  if (typeof options.token !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(options.token)) fail("option.token", "token must be printable text without spaces.");
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (typeof fetchImpl !== "function") fail("fetch.unavailable", "No fetch function is available.");
  return {
    server,
    fetchImpl,
    timeoutMs: boundedInteger(options.timeoutMs, 15_000, CONNECTOR_LIMITS.timeoutMs, "timeoutMs"),
    maxBytes: boundedInteger(options.maxBytes, CONNECTOR_LIMITS.bytes, CONNECTOR_LIMITS.bytes, "maxBytes"),
    headers: { accept: "application/json", authorization: `Token ${options.token}` },
  };
}

/** Fetches raw v2 data rows, following same-origin, same-path `next` links. */
export async function fetchKoboSubmissions(options: KoboFetchOptions): Promise<Record<string, unknown>[]> {
  const checked = checkKobo(options);
  const maxRows = boundedInteger(options.maxRows, CONNECTOR_LIMITS.rows, CONNECTOR_LIMITS.rows, "maxRows");
  const base = new URL(`/api/v2/assets/${options.assetUid}/data/`, checked.server);
  base.searchParams.set("format", "json");
  base.searchParams.set("limit", String(Math.min(CONNECTOR_LIMITS.pageSize, maxRows)));
  const rows: Record<string, unknown>[] = [];
  let page: URL | null = base;
  let pages = 0;
  let totalBytes = 0;
  while (page !== null) {
    pages += 1;
    if (pages > 1000) fail("limit.pages", "More than 1,000 pages; stopped.");
    if (totalBytes >= checked.maxBytes) fail("limit.bytes", "The responses are larger than the byte limit.");
    const url: URL = page;
    const document = await withTimeout(checked.timeoutMs, (signal) => fetchJson(url, { fetchImpl: checked.fetchImpl, headers: checked.headers, timeoutMs: checked.timeoutMs, maxBytes: checked.maxBytes - totalBytes, label: "KoboToolbox" }, signal), "KoboToolbox");
    totalBytes += JSON.stringify(document).length;
    if (!isPlainObject(document) || !Array.isArray(document.results)) fail("kobo.shape", "The response has no results array.");
    for (const row of document.results) {
      if (!isPlainObject(row)) fail("kobo.row", "A submission row must be an object.");
      rows.push(row);
      if (rows.length > maxRows) fail("limit.rows", `The server returned more than ${maxRows} submissions.`);
    }
    page = typeof document.next === "string" && document.next !== "" ? confinedNextLink(document.next, checked.server, base) : null;
  }
  return rows;
}

/** Fetches the asset and reads its XLSForm survey rows into a field list. */
export async function fetchKoboFields(options: KoboFetchOptions): Promise<FormField[]> {
  const checked = checkKobo(options);
  const url = new URL(`/api/v2/assets/${options.assetUid}/`, checked.server);
  url.searchParams.set("format", "json");
  const json = await withTimeout(checked.timeoutMs, (signal) => fetchJson(url, { fetchImpl: checked.fetchImpl, headers: checked.headers, timeoutMs: checked.timeoutMs, maxBytes: 8 * 1024 * 1024, label: "KoboToolbox" }, signal), "KoboToolbox");
  if (!isPlainObject(json) || !isPlainObject(json.content)) fail("kobo.shape", "The asset response has no content.");
  return koboFieldsFromSurvey(json.content.survey);
}

/** Fetches the field list and the submissions, then converts them. */
export async function readKoboAsset(options: KoboFetchOptions, convert: KoboConvertOptions = {}): Promise<ConnectorResult> {
  const fields = convert.fields ?? (await fetchKoboFields(options));
  const rows = await fetchKoboSubmissions(options);
  return koboJsonToRows(rows, { ...convert, fields });
}
