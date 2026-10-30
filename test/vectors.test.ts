import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyResearchPackage } from "../src/research-package.ts";
import { readStoredZip } from "../src/zip-store.ts";
import { buildVectors, diffVectors } from "../scripts/generate-vectors.ts";

const folder = resolve(dirname(fileURLToPath(import.meta.url)), "vectors");

test("the committed test vectors are exactly what the code builds today", async () => {
  assert.deepEqual(diffVectors(folder, await buildVectors()), []);
});

test("vectors.json lists a SHA-256 that matches every file on disk", () => {
  const index = JSON.parse(readFileSync(resolve(folder, "vectors.json"), "utf8")) as { files: { path: string; bytes: number; sha256: string }[]; packageManifestSha256: string };
  assert.ok(index.files.length >= 20);
  for (const item of index.files) {
    const bytes = readFileSync(resolve(folder, item.path));
    assert.equal(bytes.byteLength, item.bytes, item.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256, item.path);
  }
  const manifest = readFileSync(resolve(folder, "package", "manifest-sha256.txt"));
  assert.equal(createHash("sha256").update(manifest).digest("hex"), index.packageManifestSha256);
});

test("the committed package verifies from its bytes, and the committed zip holds the committed archive files", async () => {
  const index = JSON.parse(readFileSync(resolve(folder, "vectors.json"), "utf8")) as { files: { path: string }[] };
  const packageFiles = index.files.filter((item) => item.path.startsWith("package/")).map((item) => ({ path: item.path.slice("package/".length), bytes: readFileSync(resolve(folder, item.path)) }));
  assert.deepEqual(await verifyResearchPackage(packageFiles), { valid: true, problems: [] });
  const zipped = readStoredZip(readFileSync(resolve(folder, "dwca.zip")));
  assert.deepEqual(zipped.map((entry) => entry.name).sort(), ["eml.xml", "extendedmeasurementorfact.txt", "meta.xml", "multimedia.txt", "occurrence.txt"]);
  for (const entry of zipped) assert.deepEqual(Buffer.from(entry.bytes), readFileSync(resolve(folder, "dwca", entry.name)), entry.name);
});
