import assert from "node:assert/strict";
import test from "node:test";
import {
  ConnectorError,
  isSafeFilename,
  looksLikeFormula,
  mediaTypeFor,
  normaliseDateTime,
  parseDelimited,
  parseOdkLine,
  parseOdkPoint,
  parseWkt,
  pointToGeoJson,
} from "../src/connectors/common.ts";

const codeOf = (error: unknown): string | undefined => (error instanceof ConnectorError ? error.code : undefined);
const throwsCode = (run: () => unknown, code: string): void => assert.throws(run, (error: unknown) => codeOf(error) === code, code);

test("delimited text: BOM, CRLF, quotes, embedded delimiters and newlines, blank lines, short rows", () => {
  const table = parseDelimited("﻿a,b,c\r\n1,\"x,y\",\"line\nbreak\"\r\n\r\n2,\"say \"\"hi\"\"\"\r\n");
  assert.deepEqual(table.headers, ["a", "b", "c"]);
  assert.deepEqual(table.rows, [["1", "x,y", "line\nbreak"], ["2", "say \"hi\"", ""]]);
  assert.equal(table.delimiter, ",");
});

test("delimited text: the delimiter is detected outside quotes", () => {
  assert.equal(parseDelimited("a;b;c\n1;2;3\n").delimiter, ";");
  assert.equal(parseDelimited("a\tb\n1\t2\n").delimiter, "\t");
  assert.equal(parseDelimited("\"a;b;c\",d\n1,2\n").delimiter, ",");
  assert.deepEqual(parseDelimited("a;b\n\"1;2\";3\n").rows, [["1;2", "3"]]);
  assert.equal(parseDelimited("a;b\n1;2\n", { delimiter: "," }).headers[0], "a;b", "an explicit delimiter wins");
});

test("delimited text: structural problems stop the parse", () => {
  throwsCode(() => parseDelimited(""), "csv.empty");
  throwsCode(() => parseDelimited("a,b\n1,\"2\"x\n"), "csv.trailing-characters");
  throwsCode(() => parseDelimited("a,b\n1,x\"y\"\n"), "csv.quote-placement");
  throwsCode(() => parseDelimited("a,,c\n1,2,3\n"), "csv.blank-header");
  throwsCode(() => parseDelimited("a,b\n1,2\n", { maxBytes: 3 }), "limit.bytes");
  throwsCode(() => parseDelimited(`a\n${"x".repeat(70_000)}\n`), "limit.cell");
  throwsCode(() => parseDelimited(`${Array.from({ length: 600 }, (_, index) => `c${index}`).join(",")}\n`), "limit.columns");
  throwsCode(() => parseDelimited("a\n1\n2\n3\n", { maxRows: 2 }), "limit.rows");
  throwsCode(() => parseDelimited("a,prototype\n1,2\n"), "key.unsafe");
});

test("geopoints: lat lon alt accuracy, with ranges checked and zero accuracy treated as unknown", () => {
  assert.deepEqual(parseOdkPoint("-33.8 151.2"), { lat: -33.8, lon: 151.2 });
  assert.deepEqual(parseOdkPoint("-33.8 151.2 12.5 4.8"), { lat: -33.8, lon: 151.2, altitude: 12.5, accuracy: 4.8 });
  for (const bad of ["", "1", "1 2 3 4 5", "91 0", "0 181", "a b", "1e999 0", "0x10 0"]) assert.equal(parseOdkPoint(bad), undefined, bad);
  assert.deepEqual(pointToGeoJson({ lat: 1, lon: 2, altitude: 3, accuracy: 0 }), { type: "Point", coordinates: [2, 1, 3] });
  assert.deepEqual(pointToGeoJson({ lat: 1, lon: 2, accuracy: 6 }), { type: "Point", coordinates: [2, 1], accuracyMetres: 6 });
});

test("traces and shapes: a trace needs two points; a shape is closed and needs three", () => {
  assert.deepEqual(parseOdkLine("1 2 0 0; 3 4 0 0", "geotrace"), { type: "LineString", coordinates: [[2, 1, 0], [4, 3, 0]] });
  assert.equal(parseOdkLine("1 2", "geotrace"), undefined);
  assert.equal(parseOdkLine("1 2; 3 x", "geotrace"), undefined);
  assert.deepEqual(parseOdkLine("0 0; 0 1; 1 1", "geoshape"), { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, "an open ring is closed");
  assert.equal(parseOdkLine("0 0; 0 1", "geoshape"), undefined);
});

test("WKT: points, lines and polygons; anything else is refused", () => {
  assert.deepEqual(parseWkt("POINT (151.2 -33.8)"), { type: "Point", coordinates: [151.2, -33.8] });
  assert.deepEqual(parseWkt("POINT Z (151.2 -33.8 5)"), { type: "Point", coordinates: [151.2, -33.8, 5] });
  assert.deepEqual(parseWkt("LINESTRING (0 0, 1 1)"), { type: "LineString", coordinates: [[0, 0], [1, 1]] });
  assert.equal(parseWkt("POLYGON ((0 0, 1 0, 1 1, 0 0))")?.type, "Polygon");
  for (const bad of ["MULTIPOINT (0 0)", "POINT (0)", "POINT (200 0)", "POINT (a b)", "LINESTRING (0 0)", "POLYGON ((0 0, 1 0, 0 0))", "POINT (0 0) trailing", ""]) assert.equal(parseWkt(bad), undefined, bad);
});

test("date-times keep the local reading and its offset; they are normalised, not moved", () => {
  assert.deepEqual(normaliseDateTime("2026-03-05T09:15:00.000+11:00"), { value: "2026-03-05T09:15:00.000+11:00" });
  assert.deepEqual(normaliseDateTime("2026-03-05 09:15"), { value: "2026-03-05 09:15", code: "timestamp.no-offset", message: normaliseDateTime("2026-03-05 09:15").message! });
  assert.equal(normaliseDateTime("2026-03-05 09:15", { defaultUtcOffset: "Z" }).value, "2026-03-05T09:15:00Z");
  assert.equal(normaliseDateTime("2026-03-05T09:15:07+1100").value, "2026-03-05T09:15:07+11:00");
  assert.equal(normaliseDateTime("2026-03-05T09:15:07+11").value, "2026-03-05T09:15:07+11:00");
  assert.equal(normaliseDateTime("2026-03-05T09:15:07", { sourceIsUtc: true }).value, "2026-03-05T09:15:07Z");
  assert.equal(normaliseDateTime("2026-03-05T09:15:07.1Z").value, "2026-03-05T09:15:07.100Z");
  assert.equal(normaliseDateTime("2026-03-05T09:15:07.123999Z").code, "timestamp.fraction-truncated");
  for (const bad of ["2026-13-01T00:00:00Z", "2026-03-05T24:00:00Z", "2026-03-05T09:15:07+25:00", "yesterday"]) assert.equal(normaliseDateTime(bad).code, "timestamp.unreadable", bad);
});

test("spreadsheet formula detection leaves plain numbers alone", () => {
  for (const risky of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=1", "\r=1", "-abc", "+61 400 000 000"]) assert.equal(looksLikeFormula(risky), true, risky);
  for (const safe of ["", "-33.8", "+5", "1e5", "-1e-5", "text", "a=b", "151.2 -33.8"]) assert.equal(looksLikeFormula(safe), false, safe);
});

test("file names: only a plain name is accepted; media type comes from the server or the extension", () => {
  for (const good of ["photo.jpg", "IMG 0001.JPG", "a-b_c.mp4", "fîlé.png", "x😂.jpg"]) assert.equal(isSafeFilename(good), true, good);
  for (const bad of ["", ".", "..", "a/b", "a\\b", "../x", "x..y", "C:x", "~x", "a\u0000b", "a\nb", "a|b", "a?b", "x".repeat(300)]) assert.equal(isSafeFilename(bad), false, JSON.stringify(bad));
  assert.equal(mediaTypeFor("a.JPG"), "image/jpeg");
  assert.equal(mediaTypeFor("a.unknownext"), "application/octet-stream");
  assert.equal(mediaTypeFor("a.jpg", "image/png"), "image/png");
  assert.equal(mediaTypeFor("a.jpg", "text/html; charset=x\r\nSet-Cookie: a"), "image/jpeg", "a declared type that is not a bare media type is ignored");
});
