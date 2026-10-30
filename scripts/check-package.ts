/**
 * Installs the packed tarball into an empty folder and uses it, the way a stranger would.
 *
 *   node scripts/check-package.ts
 *
 *   1. `pnpm pack` (its prepack step builds dist/ with tsc: JavaScript plus .d.ts)
 *   2. `npm install <tarball>` in a new folder outside this checkout
 *   3. plain `node` imports the package and runs it (no TypeScript stripping: Node refuses
 *      to strip types under node_modules, which is why dist/ exists)
 *   4. `tsc --strict` compiles a small consumer against the shipped .d.ts
 *
 * Exit code 1 on any failure. It needs no network: the package has no dependencies.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command: string, cwd: string, label: string): string {
  // Constant commands only; paths are quoted. One string because pnpm and npm are .cmd files on Windows.
  const result = spawnSync(command, { cwd, encoding: "utf8", shell: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error(`FAILED: ${label}\n${result.stdout}\n${result.stderr}`);
    process.exit(1);
  }
  return result.stdout;
}

const scratch = mkdtempSync(join(tmpdir(), "research-kit-check-"));
try {
  const packDir = join(scratch, "pack");
  mkdirSync(packDir);
  run(`pnpm pack --pack-destination "${packDir}"`, root, "pnpm pack");
  const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error("pnpm pack produced no tarball");

  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
  run(`npm install "${join(packDir, tarball)}" --ignore-scripts --no-audit --no-fund --prefer-offline`, consumer, "npm install of the tarball");

  const installed = join(consumer, "node_modules", "@clio-museum", "research-kit");
  for (const expected of ["dist/index.js", "dist/index.d.ts", "schemas/index.json", "LICENSE", "NOTICE"]) {
    if (!existsSync(join(installed, expected))) { console.error(`FAILED: ${expected} is not in the installed package`); process.exit(1); }
  }
  if (existsSync(join(installed, "src")) || existsSync(join(installed, "test"))) { console.error("FAILED: src/ or test/ was shipped"); process.exit(1); }

  writeFileSync(join(consumer, "use.mjs"), [
    'import { readFileSync } from "node:fs";',
    'import { previewImport, readStoredZip, createStoredZip, isIsoDateTime, SCHEMA_KEYWORDS } from "@clio-museum/research-kit";',
    'const preview = previewImport({ format: "csv", presetId: "observation", content: "id;date;lat;lon\\nr1;2026-09-14;-33.8;151.2\\n" });',
    'if (preview.summary.total !== 1 || preview.delimiter !== ";") throw new Error("importer did not run");',
    'const zip = createStoredZip([{ name: "a/b.txt", bytes: new TextEncoder().encode("x") }], { modifiedAt: "2026-01-01T00:00:00Z" });',
    'if (readStoredZip(zip)[0].name !== "a/b.txt") throw new Error("zip round trip failed");',
    'if (!isIsoDateTime("2026-10-22T01:00:00Z") || isIsoDateTime("2026-02-31T00:00:00Z")) throw new Error("date check failed");',
    'const index = JSON.parse(readFileSync(new URL(import.meta.resolve("@clio-museum/research-kit/schemas/index.json")), "utf8"));',
    'if (index.keywords.length !== SCHEMA_KEYWORDS.length) throw new Error("schemas/index.json keywords differ from SCHEMA_KEYWORDS");',
    'console.log("installed package works:", preview.summary.total, "row,", index.profiles.length, "schemas");',
  ].join("\n"));
  const output = run("node use.mjs", consumer, "using the installed package from plain Node");

  writeFileSync(join(consumer, "use.ts"), [
    'import { previewImport, buildResearchPackage, type PreviewImportResult, type ResearchPackageInput } from "@clio-museum/research-kit";',
    'const result: PreviewImportResult = previewImport({ format: "json", presetId: "observation", content: "[]" });',
    'const count: number = result.summary.noImportErrors;',
    'declare const input: ResearchPackageInput;',
    'export const build = (): Promise<unknown> => buildResearchPackage(input);',
    'export { count };',
  ].join("\n"));
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022", types: [] }, files: ["use.ts"] }));
  run(`pnpm --dir "${root}" exec tsc -p "${join(consumer, "tsconfig.json")}"`, root, "type-checking a consumer against the shipped .d.ts");

  console.log(output.trim());
  console.log("Package check passed: the tarball installs, runs in plain Node, and its types compile.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
