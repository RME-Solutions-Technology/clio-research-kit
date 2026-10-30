import assert from "node:assert/strict";
import test from "node:test";
import { odkFieldsFromXForm, ConnectorError } from "../src/connectors/index.ts";
import { previewImport, ImportError } from "../src/importer.ts";
import { toCsv, verifyResearchPackage } from "../src/research-package.ts";
import { ZipStoreError, createStoredZip, readStoredZip } from "../src/zip-store.ts";
import { dwcaCell } from "../src/dwca.ts";

// Each test here backs a row of docs/threat-model.md.

const bytes = (text: string) => new TextEncoder().encode(text);

/** A one-entry stored ZIP whose name is replaced by another name of the same length (the writer refuses unsafe names). */
function zipWithName(safe: string, unsafe: string): Uint8Array {
  assert.equal(safe.length, unsafe.length);
  const zip = createStoredZip([{ name: safe, bytes: bytes("x") }], { modifiedAt: "2026-01-01T00:00:00Z" });
  const text = new TextDecoder("latin1").decode(zip);
  const patched = text.replaceAll(safe, unsafe);
  return Uint8Array.from(patched, (char) => char.charCodeAt(0));
}

test("zip-slip: entry names that climb out of a folder are refused on read", () => {
  for (const [safe, unsafe] of [["aaaa", "../a"], ["aaaaaaa", "/etc/pw"], ["aaaaa", "C:abc"], ["aaaa", "a\\b\\"], ["aaa", "a/."], ["aaaaa", "..\\.."]] as const) {
    const zip = zipWithName(safe, unsafe);
    assert.throws(() => readStoredZip(zip), (error: unknown) => error instanceof ZipStoreError && /Unsafe ZIP entry name/u.test(error.message), unsafe);
  }
  assert.throws(() => createStoredZip([{ name: "../x", bytes: bytes("x") }], { modifiedAt: "2026-01-01T00:00:00Z" }), ZipStoreError);
  assert.equal(readStoredZip(createStoredZip([{ name: "ok/a.txt", bytes: bytes("x") }], { modifiedAt: "2026-01-01T00:00:00Z" }))[0]!.name, "ok/a.txt");
});

test("decompression bomb: the reader never inflates; any compressed entry is refused", () => {
  const zip = createStoredZip([{ name: "a.txt", bytes: bytes("x".repeat(100)) }], { modifiedAt: "2026-01-01T00:00:00Z" });
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // Central directory record starts after the local record: 30 + name (5) + data (100). Method is at +10.
  const central = 30 + 5 + 100;
  assert.equal(view.getUint32(central, true), 0x02014b50);
  for (const method of [8, 9, 12, 14, 93]) {
    const copy = new Uint8Array(zip);
    new DataView(copy.buffer).setUint16(central + 10, method, true);
    assert.throws(() => readStoredZip(copy), (error: unknown) => error instanceof ZipStoreError && /Only stored/u.test(error.message), `method ${method}`);
  }
  const encrypted = new Uint8Array(zip);
  new DataView(encrypted.buffer).setUint16(central + 8, 1, true);
  assert.throws(() => readStoredZip(encrypted), ZipStoreError);
  // A claimed size that does not match the file is refused, not trusted.
  const lying = new Uint8Array(zip);
  new DataView(lying.buffer).setUint32(central + 24, 0x7fffffff, true);
  assert.throws(() => readStoredZip(lying), ZipStoreError);
});

test("package manifests with paths outside the bag are reported", async () => {
  const files = [
    { path: "bagit.txt", bytes: bytes("BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n") },
    { path: "manifest-sha256.txt", bytes: bytes(`${"a".repeat(64)}  ../outside.txt\n${"b".repeat(64)}  /etc/passwd\n`) },
    { path: "bag-info.txt", bytes: bytes("Payload-Oxum: 0.0\n") },
  ];
  const result = await verifyResearchPackage(files);
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((problem) => /unsafe path \.\.\/outside\.txt/u.test(problem)));
  assert.ok(result.problems.some((problem) => /unsafe path \/etc\/passwd/u.test(problem)));
});

test("formula injection: exports keep the value as given (documented, not mitigated)", () => {
  const csv = toCsv(["name"], [{ name: "=HYPERLINK(\"https://example.org\")" }, { name: "@SUM(A1)" }]);
  assert.ok(csv.includes("=HYPERLINK"), "the value is written as it came in");
  assert.ok(csv.includes("@SUM(A1)"));
  assert.equal(dwcaCell("=1+1"), "=1+1");
  assert.equal(dwcaCell("a\tb\nc"), "a b c", "tabs and newlines are the only things the table writer changes");
});

test("importer: hostile structure is refused with a coded error", () => {
  const bad: [string, "csv" | "json" | "ndjson", string][] = [
    ["csv.unclosed-quote", "csv", "id,date\n\"x,2026-01-01\n"],
    ["json.unsafe-key", "json", "[{\"id\":\"a\",\"__proto__\":{\"x\":1}}]"],
    ["json.invalid", "json", "{not json"],
    ["input.column-limit", "csv", `${Array.from({ length: 65 }, (_, index) => `c${index}`).join(",")}\n`],
    ["input.cell-limit", "csv", `id\n${"x".repeat(33_000)}\n`],
  ];
  for (const [code, format, content] of bad) {
    assert.throws(() => previewImport({ format, content, presetId: "observation" }), (error: unknown) => error instanceof ImportError && error.code === code, code);
  }
  assert.throws(() => previewImport({ format: "csv", presetId: "observation", content: "x".repeat(2 * 1024 * 1024 + 1) }), (error: unknown) => error instanceof ImportError && error.code === "input.byte-limit");
});

test("form-definition scanner: refuses entity tricks and stays fast on adversarial input", () => {
  assert.throws(() => odkFieldsFromXForm("<!DOCTYPE lolz [<!ENTITY lol \"lol\">]><h:html>&lol;</h:html>"), (error: unknown) => error instanceof ConnectorError && error.code === "xform.doctype");
  const inputs = [
    `<a ${" b=\"c\"".repeat(200_000)}`,
    `<a${" ".repeat(1_000_000)}`,
    `${"<a ".repeat(100_000)}`,
    `<instance>${"<x>".repeat(40_000)}`,
    `<bind nodeset="${"/a".repeat(500_000)}" type="string"/>`,
  ];
  for (const input of inputs) {
    const started = Date.now();
    try { odkFieldsFromXForm(input); } catch { /* a coded refusal is fine; only the time matters */ }
    assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
  }
});
