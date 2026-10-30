import assert from "node:assert/strict";
import test from "node:test";
import {
  IMPORT_PRESETS,
  ImportError,
  compareChanges,
  previewImport,
  type ImportRow,
} from "../src/importer.ts";
import { findApplicationProfile } from "../src/application-profiles.ts";

test("presets are stable and each pins a registered application profile", () => {
  assert.deepEqual(IMPORT_PRESETS.map((preset) => preset.id), ["observation", "structured-survey", "microscopy", "geology"]);
  assert.deepEqual(Object.fromEntries(IMPORT_PRESETS.map((preset) => [preset.id, [preset.profileId, preset.profileVersion]])), {
    observation: ["clio.profile.general-observation", "1.0.0"],
    "structured-survey": ["clio.profile.structured-survey", "1.0.0"],
    microscopy: ["clio.profile.microscopy-image", "1.0.0"],
    geology: ["clio.profile.geological-sample", "1.0.0"],
  });
  for (const preset of IMPORT_PRESETS) {
    assert.match(preset.version, /^\d+\.\d+\.\d+$/);
    assert.match(preset.profileVersion, /^\d+\.\d+\.\d+$/);
    assert.ok(findApplicationProfile(preset.profileId, preset.profileVersion), `${preset.id} must name a registered profile version`);
    assert.ok(preset.fields.every((field) => field.key && field.label && typeof field.requiredForDraft === "boolean" && typeof field.requiredForRelease === "boolean"));
  }
});

test("CSV preview handles BOM, CRLF, quoted commas and preserves rights and values", () => {
  const result = previewImport({
    format: "csv",
    presetId: "observation",
    content: '\uFEFFid,date,lat,lon,species,rights\r\n"row-1","2026-08-14",-33.8,151.2,"Unknown, sp.","CC BY-NC"\r\n',
  });
  assert.equal(result.summary.total, 1);
  assert.equal(result.rows[0]?.source["species"], "Unknown, sp.");
  assert.equal(result.rows[0]?.data.identification, "Unknown, sp.");
  assert.equal(result.rows[0]?.data.rights, "CC BY-NC");
  assert.equal(result.rows[0]?.findings.some((finding) => finding.code === "identification.unknown"), false);
  assert.equal(result.mappingVersion, previewImport({
    format: "csv",
    presetId: "observation",
    content: 'id,date,lat,lon,species,rights\nrow-1,2026-08-14,-33.8,151.2,"Unknown, sp.","CC BY-NC"\n',
  }).mappingVersion);
});

test("preview returns non-fatal scientific findings and keeps original representations", () => {
  const result = previewImport({
    format: "json",
    presetId: "observation",
    content: JSON.stringify([{
      sourceId: "synthetic-1",
      eventDate: "2026-02-31",
      latitude: "91.000",
      longitude: "181.000",
      uncertainty: "-2",
      identification: "unknown",
      rights: "third-party-restricted",
    }]),
  });
  const row = result.rows[0]!;
  assert.equal(row.data.latitude, "91.000");
  assert.equal(row.data.rights, "third-party-restricted");
  assert.ok(row.findings.some((finding) => finding.code === "date.invalid"));
  assert.ok(row.findings.some((finding) => finding.code === "coordinates.out-of-range"));
  assert.ok(row.findings.some((finding) => finding.code === "uncertainty.invalid"));
  assert.ok(row.findings.some((finding) => finding.code === "identification.unknown"));
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.noImportErrors, 0);
});

test("CSV and JSON structural limits fail closed", () => {
  assert.throws(() => previewImport({ format: "csv", presetId: "observation", content: "id,id\na,b\n" }), (error: unknown) => error instanceof ImportError && error.code === "csv.duplicate-header");
  assert.throws(() => previewImport({ format: "csv", presetId: "observation", content: ",date\na,2026-08-14\n" }), (error: unknown) => error instanceof ImportError && error.code === "csv.blank-header");
  assert.throws(() => previewImport({ format: "ndjson", presetId: "observation", content: '{"__proto__":{"polluted":true}}\n' }), (error: unknown) => error instanceof ImportError && error.code === "json.unsafe-key");
  assert.throws(() => previewImport({ format: "json", presetId: "observation", content: '{"id":"one","nested":{"constructor":{"polluted":true}}}' }), (error: unknown) => error instanceof ImportError && error.code === "json.unsafe-key");
  assert.throws(() => previewImport({ format: "json", presetId: "observation", content: JSON.stringify([["not", "a", "row"]]) }), (error: unknown) => error instanceof ImportError && error.code === "json.object-rows-required");
  let nested: unknown = "value";
  for (let index = 0; index < 18; index += 1) nested = { nested };
  assert.throws(() => previewImport({ format: "json", presetId: "observation", content: JSON.stringify([{ value: nested }]) }), (error: unknown) => error instanceof ImportError && error.code === "json.depth-limit");
});

test("mapping collisions and dangerous mapping keys fail instead of choosing silently", () => {
  assert.throws(() => previewImport({
    format: "json",
    presetId: "observation",
    content: JSON.stringify([{ id: "one", date: "2026-08-14", otherDate: "2026-08-15" }]),
    mapping: { id: "eventDate", date: "eventDate" },
  }), (error: unknown) => error instanceof ImportError && error.code === "mapping.target-collision");
  const unsafeMapping = JSON.parse('{"__proto__":"eventDate","id":"sourceId"}') as Record<string, string>;
  assert.throws(() => previewImport({ format: "json", presetId: "observation", content: '[{"id":"one"}]', mapping: unsafeMapping }), (error: unknown) => error instanceof ImportError && error.code === "mapping.unsafe-source-key");
  const explicitMapping = previewImport({
    format: "json",
    presetId: "observation",
    content: JSON.stringify([{ id: "mapped-id", sourceId: "unmapped-id", eventDate: "2026-08-14" }]),
    mapping: { id: "sourceId", eventDate: "eventDate" },
  });
  assert.equal(explicitMapping.rows[0]?.sourceId, "mapped-id");
  assert.equal(explicitMapping.rows[0]?.data.sourceId, "mapped-id");
});

test("preview performs no numeric or date coercion and reports ambiguous numeric dates", () => {
  const result = previewImport({
    format: "json",
    presetId: "observation",
    content: JSON.stringify([{ id: "001", eventDate: 20260916, latitude: "-33.8000", longitude: 151.2, uncertainty: "1e3" }]),
  });
  const row = result.rows[0]!;
  assert.equal(row.source.id, "001");
  assert.equal(row.source.eventDate, 20260916);
  assert.equal(row.data.sourceId, "001");
  assert.equal(row.data.eventDate, 20260916);
  assert.equal(typeof row.data.latitude, "string");
  assert.equal(typeof row.data.longitude, "number");
  assert.equal(row.data.uncertainty, "1e3");
  assert.ok(row.findings.some((finding) => finding.field === "eventDate" && finding.code === "date.invalid"));

  const localDateTime = previewImport({
    format: "json",
    presetId: "observation",
    content: '{"id":"local-time","eventDate":"2026-08-14T12:30"}',
  });
  assert.equal(localDateTime.rows[0]?.data.eventDate, "2026-08-14T12:30");
  // A local date-time is valid ISO 8601; the missing zone is a warning, not an error (review M1).
  assert.ok(!localDateTime.rows[0]?.findings.some((finding) => finding.code === "date.invalid"));
  assert.ok(localDateTime.rows[0]?.findings.some((finding) => finding.code === "date.no-timezone" && finding.severity === "warning"));
});

test("duplicate IDs, compound IDs and reordering remain explicit and stable", () => {
  const firstContent = JSON.stringify([
    { id: "same", eventDate: "2026-08-14" },
    { id: "same", eventDate: "2026-08-15" },
    { namespace: "survey-A", recordId: "001", eventDate: "2026-08-16" },
  ]);
  const secondContent = JSON.stringify(JSON.parse(firstContent).reverse());
  const first = previewImport({ format: "json", presetId: "observation", content: firstContent });
  const second = previewImport({ format: "json", presetId: "observation", content: secondContent });
  assert.equal(first.rows[1]?.findings.some((finding) => finding.code === "source.duplicate-id"), true);
  assert.deepEqual(first.rows.map((row) => row.sourceId).sort(), ["same", "same", "survey-A:001"]);
  assert.deepEqual(second.rows.map((row) => row.sourceId).sort(), ["same", "same", "survey-A:001"]);
  assert.equal(first.mappingVersion, second.mappingVersion);
  assert.equal(first.rows.find((row) => row.sourceId === "survey-A:001")?.source.recordId, "001");
});

test("malformed CSV is rejected with actionable structural errors", () => {
  const cases: [string, string][] = [
    ['id,note\n"one,note\n', "csv.unclosed-quote"],
    ['id,note\n"one"oops,note\n', "csv.trailing-characters"],
    ['id,note\none"bad,note\n', "csv.quote-placement"],
  ];
  for (const [content, code] of cases) assert.throws(() => previewImport({ format: "csv", presetId: "observation", content }), (error: unknown) => error instanceof ImportError && error.code === code);
});

test("row, column, file and UTF-8 cell limits are enforced in bytes", () => {
  const exactlyAtCellLimit = "😀".repeat(8192);
  const overCellLimit = "😀".repeat(8193);
  assert.equal(previewImport({ format: "csv", presetId: "observation", content: `id,note\nrow,${exactlyAtCellLimit}\n` }).rows[0]?.source.note, exactlyAtCellLimit);
  assert.throws(() => previewImport({ format: "csv", presetId: "observation", content: `id,note\nrow,${overCellLimit}\n` }), (error: unknown) => error instanceof ImportError && error.code === "input.cell-limit");
  const sixtyFourColumns = Array.from({ length: 64 }, (_, index) => `c${index}`).join(",");
  assert.equal(previewImport({ format: "csv", presetId: "observation", content: `${sixtyFourColumns}\n${Array.from({ length: 64 }, () => "x").join(",")}\n` }).summary.total, 1);
  const sixtyFiveColumns = Array.from({ length: 65 }, (_, index) => `c${index}`).join(",");
  assert.throws(() => previewImport({ format: "csv", presetId: "observation", content: `${sixtyFiveColumns}\n${Array.from({ length: 65 }, () => "x").join(",")}\n` }), (error: unknown) => error instanceof ImportError && error.code === "input.column-limit");
  const tooManyRows = Array.from({ length: 1001 }, (_, index) => `row-${index}`).join("\n");
  assert.throws(() => previewImport({ format: "csv", presetId: "observation", content: `id\n${tooManyRows}\n` }), (error: unknown) => error instanceof ImportError && error.code === "input.row-limit");
  assert.throws(() => previewImport({ format: "json", presetId: "observation", content: `[{"note":"${"😀".repeat(524289)}"}]` }), (error: unknown) => error instanceof ImportError && error.code === "input.byte-limit");
});

test("GeoJSON geometry is checked without parsing or changing its values", () => {
  const valid = { type: "Point", coordinates: [151.2, -33.8] };
  const invalid = { type: "Point", coordinates: [181, -91] };
  const nonNumeric = { type: "Point", coordinates: ["151.2", -33.8] };
  const result = previewImport({ format: "json", presetId: "observation", content: JSON.stringify([{ id: "valid", geometry: valid }, { id: "invalid", geometry: invalid }, { id: "non-numeric", geometry: nonNumeric }, { id: "text", geometry: JSON.stringify(valid) }]) });
  assert.deepEqual(result.rows[0]?.source.geometry, valid);
  assert.equal(result.rows[0]?.findings.some((finding) => finding.code.startsWith("geometry.")), false);
  assert.deepEqual(result.rows[1]?.source.geometry, invalid);
  assert.equal(result.rows[1]?.findings.some((finding) => finding.code === "geometry.longitude-out-of-range"), true);
  assert.equal(result.rows[1]?.findings.some((finding) => finding.code === "geometry.latitude-out-of-range"), true);
  assert.deepEqual(result.rows[2]?.source.geometry, nonNumeric);
  assert.equal(result.rows[2]?.findings.some((finding) => finding.code === "geometry.coordinate-not-numeric"), true);
  assert.equal(result.rows[3]?.findings.some((finding) => finding.code === "geometry.object-required"), true);
});

test("three-way changes merge disjoint fields and report optimistic conflicts", () => {
  const base: ImportRow = { sourceId: "r1", source: {}, data: { count: 1, note: "base" } };
  const local: ImportRow = { sourceId: "r1", source: {}, data: { count: 2, note: "base" } };
  const current: ImportRow = { sourceId: "r1", source: {}, data: { count: 1, note: "server" } };
  const merged = compareChanges([base], [local], [current]);
  assert.equal(merged.status, "merged");
  assert.deepEqual(merged.merged[0]?.data, { count: 2, note: "server" });
  assert.equal(merged.conflicts.length, 0);

  const conflict = compareChanges([base], [local], [{ sourceId: "r1", source: {}, data: { count: 3, note: "base" } }]);
  assert.equal(conflict.status, "conflicted");
  assert.equal(conflict.conflicts[0]?.field, "data.count");
  assert.equal(conflict.conflicts[0]?.reason, "both-changed");
});

