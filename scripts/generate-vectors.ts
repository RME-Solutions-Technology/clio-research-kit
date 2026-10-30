/**
 * Test vectors for the export formats.
 *
 * Builds the synthetic sample (scripts/sample-package.ts) and writes the exact bytes the library
 * produces to test/vectors/, with a vectors.json that lists every file's SHA-256. A different
 * implementation, or a later version of this one, can be compared against them byte for byte.
 *
 *   node scripts/generate-vectors.ts           rewrite test/vectors/
 *   node scripts/generate-vectors.ts --check   exit 1 if test/vectors/ differs from what the code builds
 *
 * Formats covered: Darwin Core Archive (meta.xml, eml.xml, occurrence, eMoF and multimedia tables, and the
 * stored ZIP), BagIt 1.0 bag, RO-Crate 1.2 metadata, Frictionless Data Package descriptor, CSV tables.
 * The input is fixed and synthetic, so the output never changes unless the code does.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createStoredZip, listDarwinCoreArchiveEntries } from "../src/index.ts";
import { buildSampleArchive, buildSamplePackage } from "./sample-package.ts";

export type VectorFile = Readonly<{ path: string; bytes: Uint8Array }>;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export async function buildVectors(): Promise<VectorFile[]> {
  const files: VectorFile[] = [];
  const archive = buildSampleArchive();
  const entries = listDarwinCoreArchiveEntries(archive);
  for (const entry of entries) files.push({ path: `dwca/${entry.name}`, bytes: entry.bytes });
  files.push({ path: "dwca.zip", bytes: createStoredZip(entries, { modifiedAt: "2026-10-22T01:00:00Z" }) });
  const pkg = await buildSamplePackage();
  for (const file of pkg.files) files.push({ path: `package/${file.path}`, bytes: file.bytes });
  const index = {
    note: "Exact output of the library for the fixed synthetic input in scripts/sample-package.ts. Regenerate with: node scripts/generate-vectors.ts",
    formats: {
      "darwin-core-archive": "dwca/ (meta.xml, eml.xml, occurrence.txt, extendedmeasurementorfact.txt, multimedia.txt) and dwca.zip (stored ZIP of the same files)",
      "bagit-1.0": "package/ (bagit.txt, bag-info.txt, manifest-sha256.txt, tagmanifest-sha256.txt, data/)",
      "ro-crate-1.2": "package/data/ro-crate-metadata.json",
      "frictionless-data-package": "package/data/datapackage.json with the CSV tables beside it",
    },
    packageManifestSha256: pkg.manifestSha256,
    files: files.map((file) => ({ path: file.path, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) })),
  };
  files.push({ path: "vectors.json", bytes: new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`) });
  return files;
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const full = join(directory, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/** Differences between the built vectors and the folder on disk: missing, changed, or extra files. */
export function diffVectors(folder: string, built: readonly VectorFile[]): string[] {
  const problems: string[] = [];
  const onDisk = new Map(listFiles(folder).map((full) => [relative(folder, full).split(sep).join("/"), full]));
  for (const file of built) {
    const full = onDisk.get(file.path);
    if (!full) problems.push(`missing: ${file.path}`);
    else if (Buffer.compare(readFileSync(full), file.bytes) !== 0) problems.push(`changed: ${file.path}`);
    onDisk.delete(file.path);
  }
  for (const extra of onDisk.keys()) problems.push(`extra: ${extra}`);
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test", "vectors");
  const built = await buildVectors();
  if (process.argv.includes("--check")) {
    const problems = diffVectors(folder, built);
    if (problems.length > 0) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(`Test vectors match (${built.length} files).`);
  } else {
    rmSync(folder, { recursive: true, force: true });
    for (const file of built) {
      const target = join(folder, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes);
    }
    console.log(`Wrote ${built.length} files to test/vectors/.`);
  }
}
