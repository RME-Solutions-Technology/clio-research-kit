/**
 * Software bill of materials (CycloneDX 1.6) from the lockfile, using pnpm's built-in `pnpm sbom`.
 *
 *   node scripts/generate-sbom.ts                      writes sbom/research-kit.cdx.json (all dependencies,
 *                                                      dev tools included) and sbom/research-kit.prod.cdx.json
 *                                                      (runtime dependencies only: expected to list none)
 *   node scripts/generate-sbom.ts --compare FILE       generates a fresh SBOM in memory and compares its
 *                                                      component list (name@version) with FILE, which is how a
 *                                                      reader checks that a published SBOM matches the lockfile.
 *                                                      Exit 1 on any difference.
 *
 * --lockfile-only reads pnpm-lock.yaml and never the package store or the network, so the same lockfile gives
 * the same component list on any machine. Serial number and timestamp differ on every run, which is why
 * --compare looks at components only.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = "1.6";

function pnpmSbom(extra: readonly string[]): string {
  // Constant arguments only (no user input reaches the command line). One command string, because
  // pnpm is a .cmd file on Windows and Node needs a shell for that.
  const command = ["pnpm", "sbom", "--sbom-format", "cyclonedx", "--sbom-spec-version", SPEC, "--lockfile-only", ...extra].join(" ");
  const run = spawnSync(command, { cwd: root, encoding: "utf8", shell: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`pnpm sbom failed (${run.status}): ${run.stderr || run.stdout}`);
  return run.stdout;
}

type Bom = { bomFormat?: string; specVersion?: string; components?: { name: string; version?: string; group?: string }[] };

export function componentList(bom: Bom): string[] {
  if (bom.bomFormat !== "CycloneDX") throw new Error("Not a CycloneDX document.");
  return (bom.components ?? []).map((component) => `${component.group ? `${component.group}/` : ""}${component.name}@${component.version ?? "?"}`).sort();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const compareIndex = process.argv.indexOf("--compare");
  if (compareIndex >= 0) {
    const file = process.argv[compareIndex + 1];
    if (!file) throw new Error("--compare needs a file");
    const published = new Set(componentList(JSON.parse(readFileSync(resolve(file), "utf8")) as Bom));
    const fresh = new Set(componentList(JSON.parse(pnpmSbom([])) as Bom));
    const onlyPublished = [...published].filter((item) => !fresh.has(item));
    const onlyFresh = [...fresh].filter((item) => !published.has(item));
    if (onlyPublished.length === 0 && onlyFresh.length === 0) {
      console.log(`SBOM matches the lockfile: ${fresh.size} components.`);
    } else {
      for (const item of onlyPublished) console.error(`only in ${file}: ${item}`);
      for (const item of onlyFresh) console.error(`only in the lockfile: ${item}`);
      process.exit(1);
    }
  } else {
    const out = join(root, "sbom");
    mkdirSync(out, { recursive: true });
    const all = pnpmSbom([]);
    const prod = pnpmSbom(["--prod"]);
    writeFileSync(join(out, "research-kit.cdx.json"), all);
    writeFileSync(join(out, "research-kit.prod.cdx.json"), prod);
    console.log(`Wrote sbom/research-kit.cdx.json (${componentList(JSON.parse(all) as Bom).length} components) and sbom/research-kit.prod.cdx.json (${componentList(JSON.parse(prod) as Bom).length} runtime components).`);
  }
}
