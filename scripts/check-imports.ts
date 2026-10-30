/**
 * Import-graph check.
 *
 * This kit must stand alone. The rules, checked on every `import`, `export ...
 * from`, dynamic `import()` and `require()` in src/, test/ and scripts/:
 *
 *   src/      relative imports that stay inside src/, and `node:` built-ins. Nothing else.
 *   test/     the same, plus relative imports into src/, plus the dev-only test tools in TEST_TOOLS.
 *   scripts/  the same as test/.
 *
 * Explicitly forbidden anywhere: any `@clio/*` package, and any module whose name contains a term
 * on the private list (digests, kept in the private repository only; a public export checks without them).
 * package.json must have no runtime `dependencies`.
 *
 *   node scripts/check-imports.ts      exit 1 when a rule is broken
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrivateTermsIfPresent } from "./private-terms-optional.ts";

/** Its own self-test quotes import lines as sample text. */
const SELF_TEST = "test/hygiene.test.ts";

/** Dev-only packages that tests and scripts may import. They never ship. */
export const TEST_TOOLS: readonly string[] = ["ajv", "ajv-formats"];

/** Private package and vendor names are digests that exist in the private repository only; the public tree does not spell them. @clio/ is the app's own scope. */
const FORBIDDEN = [/^@clio\//u];
const forbiddenSpecifier = (specifier: string): boolean => FORBIDDEN.some((pattern) => pattern.test(specifier)) || findPrivateTermsIfPresent(specifier).length > 0;

export type ImportProblem = Readonly<{ file: string; specifier: string; reason: string }>;

const SPECIFIER = /(?:^|[\s;{}()])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;

export function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) found.push((match[1] ?? match[2] ?? match[3])!);
  return found;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".mjs") || entry.endsWith(".js")) files.push(full);
  }
  return files;
}

export function checkImports(root: string): ImportProblem[] {
  const problems: ImportProblem[] = [];
  const srcRoot = resolve(root, "src");
  for (const area of ["src", "test", "scripts"] as const) {
    for (const file of listFiles(join(root, area))) {
      const shown = relative(root, file).split(sep).join("/");
      if (shown === SELF_TEST) continue;
      const source = readFileSync(file, "utf8");
      for (const specifier of specifiersIn(source)) {
        const fail = (reason: string) => problems.push({ file: shown, specifier, reason });
        if (forbiddenSpecifier(specifier)) { fail("forbidden dependency"); continue; }
        if (specifier.startsWith("node:")) continue;
        if (specifier.startsWith(".")) {
          const target = resolve(dirname(file), specifier);
          if (area === "src" && target !== srcRoot && !target.startsWith(`${srcRoot}${sep}`)) fail("src/ must not import outside src/");
          if (!existsSync(target)) fail("relative import does not resolve to a file");
          continue;
        }
        if (area !== "src" && TEST_TOOLS.includes(packageName(specifier))) continue;
        fail(area === "src" ? "src/ may import only relative files and node: built-ins" : "not an allowed test tool");
      }
    }
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    problems.push({ file: "package.json", specifier: name, reason: "runtime dependencies are not allowed" });
  }
  return problems;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkImports(root);
  if (problems.length > 0) {
    console.error(problems.map((item) => `${item.file}: ${item.specifier}: ${item.reason}`).join("\n"));
    process.exit(1);
  }
  console.log("Import graph is clean: no external or Clio-app imports in src/.");
}
