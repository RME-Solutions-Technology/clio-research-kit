import assert from "node:assert/strict";
import test from "node:test";
import { ZipStoreError, crc32, createStoredZip, dosDateTime, isSafeZipName, readStoredZip } from "../src/zip-store.ts";

const encode = (value: string) => new TextEncoder().encode(value);

test("CRC-32 matches the published check values", () => {
  // Standard vectors: the CRC-32 "check" value for 123456789 and common strings.
  assert.equal(crc32(new Uint8Array()), 0x00000000);
  assert.equal(crc32(encode("a")), 0xe8b7be43);
  assert.equal(crc32(encode("abc")), 0x352441c2);
  assert.equal(crc32(encode("123456789")), 0xcbf43926);
  assert.equal(crc32(encode("The quick brown fox jumps over the lazy dog")), 0x414fa339);
  assert.equal(crc32(new Uint8Array(32)), 0x190a55ad);
  assert.equal(crc32(new Uint8Array(32).fill(0xff)), 0xff6cab0b);
});

test("DOS timestamps are UTC, two-second resolution and clamped to the ZIP range", () => {
  assert.deepEqual(dosDateTime("2026-10-23T09:30:15.000Z"), { date: ((2026 - 1980) << 9) | (10 << 5) | 23, time: (9 << 11) | (30 << 5) | 7 });
  assert.deepEqual(dosDateTime("1970-01-01T00:00:00.000Z"), { date: (1 << 5) | 1, time: 0 });
  assert.throws(() => dosDateTime("not a date"), ZipStoreError);
});

test("a stored ZIP round-trips byte for byte with UTF-8 names and is deterministic", () => {
  const entries = [
    { name: "bagit.txt", bytes: encode("BagIt-Version: 1.0\nTag-File-Character-Encoding: UTF-8\n") },
    { name: "data/README.txt", bytes: encode("Synthetic test data\n") },
    { name: "data/schemas/reef/1.0.0.clio.json", bytes: encode("{}\n") },
    { name: "data/empty.csv", bytes: new Uint8Array() },
    { name: "data/naïve-ünïcode.txt", bytes: new Uint8Array([0, 1, 2, 255]) },
  ];
  const zip = createStoredZip(entries, { modifiedAt: "2026-10-23T00:00:00.000Z" });
  const again = createStoredZip(entries, { modifiedAt: "2026-10-23T00:00:00.000Z" });
  assert.deepEqual(zip, again);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50, "starts with a local file header");
  assert.equal(view.getUint16(8, true), 0, "method 0 (stored)");
  assert.equal(view.getUint16(6, true) & 0x0800, 0x0800, "UTF-8 name flag");
  const read = readStoredZip(zip);
  assert.deepEqual(read.map((entry) => entry.name), entries.map((entry) => entry.name));
  read.forEach((entry, index) => assert.deepEqual(entry.bytes, entries[index]!.bytes));
  // Size is exactly headers plus payload: nothing is compressed.
  const names = entries.reduce((sum, entry) => sum + encode(entry.name).byteLength, 0);
  const payload = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
  assert.equal(zip.byteLength, entries.length * (30 + 46) + 2 * names + payload + 22);
});

test("an empty archive is just the end record", () => {
  const zip = createStoredZip([], { modifiedAt: "2026-10-23T00:00:00.000Z" });
  assert.equal(zip.byteLength, 22);
  assert.deepEqual(readStoredZip(zip), []);
});

test("the writer refuses unsafe and duplicate names", () => {
  for (const name of ["", "/etc/passwd", "../escape.txt", "data/../x", "a//b", "C:/x", "a\\b", "./x", "bad\u0000name"]) {
    assert.equal(isSafeZipName(name), false, name);
    assert.throws(() => createStoredZip([{ name, bytes: new Uint8Array() }], { modifiedAt: "2026-10-23T00:00:00Z" }), ZipStoreError, name);
  }
  assert.throws(() => createStoredZip([{ name: "a.txt", bytes: new Uint8Array() }, { name: "a.txt", bytes: new Uint8Array() }], { modifiedAt: "2026-10-23T00:00:00Z" }), /Duplicate/u);
});

test("the reader detects corruption, truncation and unsupported features", () => {
  const zip = createStoredZip([{ name: "data/a.txt", bytes: encode("synthetic payload") }], { modifiedAt: "2026-10-23T00:00:00Z" });
  const flipped = zip.slice();
  flipped[30 + "data/a.txt".length] ^= 0x01;
  assert.throws(() => readStoredZip(flipped), /CRC-32/u);
  assert.throws(() => readStoredZip(zip.slice(0, zip.byteLength - 1)), /end of central directory/u);
  assert.throws(() => readStoredZip(encode("not a zip at all, just some synthetic text")), ZipStoreError);
  const deflated = zip.slice();
  const centralStart = new DataView(deflated.buffer).getUint32(deflated.byteLength - 6, true);
  new DataView(deflated.buffer).setUint16(centralStart + 10, 8, true);
  assert.throws(() => readStoredZip(deflated), /stored/u);
});
