import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The export script is exercised for real by running it (see the fixes report). These tests cover its refusals,
// which happen before anything is written, and what the script promises in its text.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "export-public.mjs");
const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: root });

test("export: refuses an output folder inside the repository, one that already exists, and one that contains the repository", () => {
  const inside = join(root, "tmp", "export-should-not-exist");
  const insideResult = run(["--out", inside]);
  assert.equal(insideResult.status, 2);
  assert.match(insideResult.stderr, /outside this repository/u);
  assert.equal(existsSync(inside), false, "nothing was created");

  const existing = mkdtempSync(join(tmpdir(), "export-existing-"));
  const existingResult = run(["--out", existing]);
  assert.equal(existingResult.status, 2);
  assert.match(existingResult.stderr, /already exists/u);

  const parent = dirname(root);
  const containing = run(["--out", parent]);
  assert.equal(containing.status, 2, "a folder that contains the repository is refused (it exists, or contains it)");

  const missingValue = run(["--out"]);
  assert.equal(missingValue.status, 2);
  mkdirSync(join(existing, "x"), { recursive: true });
});

test("export: the script archives HEAD, checks the copy, makes one commit with a placeholder author and never adds a remote", () => {
  const text = readFileSync(script, "utf8");
  assert.match(text, /"archive", "--format=tar"/u);
  assert.match(text, /scripts\/scrub-check\.ts/u);
  assert.match(text, /gitleaks not installed/u);
  assert.match(text, /research-kit authors/u);
  assert.match(text, /noreply@example\.org/u);
  assert.doesNotMatch(text, /["']remote["'],\s*["']add["']|["']push["']/u, "no remote is added and nothing is pushed");
  assert.match(text, /rev-list", "--count"/u);
  // The digest list stays in the private repository: it is removed from the copy, nothing may import it statically, and the
  // copy is checked to hold no such file.
  assert.ok(text.includes("rmSync(digestFile)"));
  assert.match(text, /staticImportersOfDigests/u);
  assert.match(text, /the digest file is in the copy/u);
});
