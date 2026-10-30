/**
 * Builds a small synthetic dataset with the library and runs the third-party
 * format validators on the result.
 *
 *   node scripts/run-validators.ts [--out tmp/validation] [--require]
 *
 * Writes, under --out (default tmp/validation, which git ignores):
 *   package/         the research package as a folder (BagIt bag, RO-Crate, Frictionless)
 *   dwca/, dwca.zip  the Darwin Core Archive on its own, as GBIF tools expect it
 *   report.json      one entry per validator: passed, failed, skipped
 *
 * Validators, and how each is run:
 *   frictionless          `python -m frictionless validate package/data/datapackage.json`
 *   rocrate-validator     `rocrate-validator validate package/data`
 *   dwca-reader           python-dwca-reader opens dwca.zip and reads every row (a structural read, not a validator)
 *   gbif-validator        NOT run here: GBIF's validator needs a GBIF account. Manual step printed below.
 *
 * Python is found as `py -3`, `python3` or `python`. Install the tools with
 *   python -m pip install --user frictionless roc-validator python-dwca-reader
 * A validator that is not installed is reported "skipped" and does not fail
 * the run, unless --require is given (CI passes it).
 *
 * Exit code: 1 if any validator ran and failed, or --require and any was skipped
 * (the GBIF validator is always a manual step and never counts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStoredZip, listDarwinCoreArchiveEntries } from "../src/index.ts";
import { buildSampleArchive, buildSamplePackage } from "./sample-package.ts";

export type ValidatorStatus = "passed" | "failed" | "skipped" | "manual";
export type ValidatorResult = Readonly<{ validator: string; status: ValidatorStatus; command?: string; detail: string }>;

type Python = Readonly<{ command: string; prefix: readonly string[] }>;

const CANDIDATES: readonly Python[] = [
  { command: "py", prefix: ["-3"] },
  { command: "python3", prefix: [] },
  { command: "python", prefix: [] },
];

export function findPython(): Python | undefined {
  for (const candidate of CANDIDATES) {
    const run = spawnSync(candidate.command, [...candidate.prefix, "-I", "-c", "import sys; assert sys.version_info >= (3, 10)"], { encoding: "utf8", timeout: 20_000 });
    if (run.status === 0) return candidate;
  }
  return undefined;
}

function pythonRun(python: Python, args: readonly string[], cwd: string, timeoutMs: number): { status: number | null; output: string } {
  // No -I here: the user-site packages (pip install --user) must be visible. cwd is a generated folder with no Python files.
  const run = spawnSync(python.command, [...python.prefix, ...args], { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, PYTHONUTF8: "1", NO_COLOR: "1" } });
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

function hasModule(python: Python, module: string, cwd: string): boolean {
  return pythonRun(python, ["-c", `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(module)}) else 1)`], cwd, 30_000).status === 0;
}

function tail(text: string, lines = 12): string {
  return text.split(/\r?\n/u).slice(-lines).join("\n");
}

export async function writeSampleFiles(out: string): Promise<{ packageDir: string; dwcaDir: string; dwcaZip: string }> {
  rmSync(out, { recursive: true, force: true });
  const packageDir = join(out, "package");
  const dwcaDir = join(out, "dwca");
  const pkg = await buildSamplePackage();
  for (const file of pkg.files) {
    const target = join(packageDir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  const archive = buildSampleArchive();
  mkdirSync(dwcaDir, { recursive: true });
  for (const file of listDarwinCoreArchiveEntries(archive)) writeFileSync(join(dwcaDir, file.name), file.bytes);
  const dwcaZip = join(out, "dwca.zip");
  writeFileSync(dwcaZip, createStoredZip(listDarwinCoreArchiveEntries(archive), { modifiedAt: "2026-10-22T01:00:00Z" }));
  return { packageDir, dwcaDir, dwcaZip };
}

export const GBIF_MANUAL_STEP = [
  "GBIF data validator is a manual step: it needs a GBIF account, so no credentials are kept in this repository or in CI.",
  "1. node scripts/run-validators.ts   (writes tmp/validation/dwca.zip)",
  "2. Sign in at https://www.gbif.org/tools/data-validator and upload tmp/validation/dwca.zip.",
  "3. Save the report link or PDF with the release notes. A clean report is evidence, not proof: GBIF's own tracker says it misses some error classes.",
].join("\n");

export async function runValidators(out: string): Promise<ValidatorResult[]> {
  const { packageDir, dwcaZip } = await writeSampleFiles(out);
  const results: ValidatorResult[] = [];
  const python = findPython();
  const skipped = (validator: string, why: string): void => { results.push({ validator, status: "skipped", detail: why }); };

  if (python === undefined) {
    skipped("frictionless", "Python 3.10 or newer was not found (tried py -3, python3, python).");
    skipped("rocrate-validator", "Python 3.10 or newer was not found.");
    skipped("dwca-reader", "Python 3.10 or newer was not found.");
  } else {
    const dataDir = join(packageDir, "data");
    if (!hasModule(python, "frictionless", out)) skipped("frictionless", "not installed: python -m pip install --user frictionless");
    else {
      const args = ["-m", "frictionless", "validate", "datapackage.json"];
      const run = pythonRun(python, args, dataDir, 300_000);
      results.push({ validator: "frictionless", status: run.status === 0 ? "passed" : "failed", command: `python ${args.join(" ")}  (in package/data)`, detail: tail(run.output) });
    }
    if (!hasModule(python, "rocrate_validator", out)) skipped("rocrate-validator", "not installed: python -m pip install --user roc-validator");
    else {
      const launcher = "import sys; from rocrate_validator.cli import cli; sys.argv[0] = 'rocrate-validator'; cli()";
      const run = pythonRun(python, ["-c", launcher, "validate", "--no-paging", "-v", dataDir], out, 600_000);
      const readable = run.output.split(/\r?\n/u).filter((line) => !line.startsWith(" |") && line.trim() !== "").join("\n");
      results.push({ validator: "rocrate-validator", status: run.status === 0 ? "passed" : "failed", command: "rocrate-validator validate package/data", detail: tail(readable, 25) });
    }
    if (!hasModule(python, "dwca", out)) skipped("dwca-reader", "not installed: python -m pip install --user python-dwca-reader");
    else {
      const script = [
        "import sys",
        "from dwca.read import DwCAReader",
        "with DwCAReader(sys.argv[1]) as dwca:",
        "    rows = list(dwca)",
        "    print('core rows:', len(rows), 'extension files:', len(dwca.descriptor.extensions))",
        "    assert len(rows) > 0",
        "    assert dwca.metadata is not None",
      ].join("\n");
      const run = pythonRun(python, ["-c", script, dwcaZip], out, 120_000);
      results.push({ validator: "dwca-reader", status: run.status === 0 ? "passed" : "failed", command: "python-dwca-reader: DwCAReader(dwca.zip)", detail: tail(run.output) });
    }
  }
  results.push({ validator: "gbif-validator", status: "manual", detail: GBIF_MANUAL_STEP });
  writeFileSync(join(out, "report.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  return results;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(root, outIndex >= 0 ? (process.argv[outIndex + 1] ?? "tmp/validation") : "tmp/validation");
  const require = process.argv.includes("--require");
  const results = await runValidators(out);
  for (const result of results) {
    console.log(`\n[${result.status.toUpperCase()}] ${result.validator}${result.command ? `  (${result.command})` : ""}`);
    console.log(result.detail.split("\n").map((line) => `    ${line}`).join("\n"));
  }
  const failed = results.some((result) => result.status === "failed");
  const missing = require && results.some((result) => result.status === "skipped");
  console.log(`\nReport: ${join(out, "report.json")}`);
  process.exit(failed || missing ? 1 : 0);
}
