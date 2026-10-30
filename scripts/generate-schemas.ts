/**
 * Writes the JSON Schema files under schemas/ from the profile registry.
 *
 *   node scripts/generate-schemas.ts           write the files
 *   node scripts/generate-schemas.ts --check   exit 1 if the files on disk differ
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSchemaFiles } from "../src/schema-generator.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const check = process.argv.includes("--check");
const files = generateSchemaFiles();

function listGenerated(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listGenerated(full));
    else if (entry.name.endsWith(".json")) found.push(relative(root, full).replaceAll("\\", "/"));
  }
  return found;
}

const expected = new Map(files.map((file) => [file.path, file.text]));
const onDisk = listGenerated(root);
const problems: string[] = [];
for (const [path, text] of expected) {
  const full = join(root, path);
  if (!existsSync(full)) problems.push(`missing ${path}`);
  else if (readFileSync(full, "utf8") !== text) problems.push(`out of date ${path}`);
}
for (const path of onDisk) if (!expected.has(path)) problems.push(`stale ${path}`);

if (check) {
  if (problems.length > 0) {
    console.error(`schemas/ is not in sync with the profile registry:\n${problems.map((item) => `  ${item}`).join("\n")}\nRun: pnpm run schemas:generate`);
    process.exit(1);
  }
  console.log(`schemas/ is in sync (${files.length} files).`);
} else {
  for (const path of onDisk) if (!expected.has(path)) rmSync(join(root, path));
  for (const [path, text] of expected) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  console.log(`Wrote ${files.length} files to schemas/.`);
}
