/**
 * Makes a clean copy of this repository for publication: no history, no remote, one commit.
 *
 *   node scripts/export-public.mjs [--out DIR] [--test]
 *
 * What it does, in order:
 *   1. `git archive HEAD` into a NEW folder outside this repository (default: a sibling named
 *      clio-open-public-export-<timestamp>). Only committed files are exported: uncommitted changes are
 *      reported and left out. The folder must not exist, and must not be inside this repository.
 *      The digest list `scripts/private-terms.ts` is REMOVED from the copy: a guessable name (a brand, say) can be
 *      confirmed by hashing it, so the digests stay in the private repository. Nothing may import that file statically (the
 *      public checks load it through scripts/private-terms-optional.ts and carry on without it); if a file in the copy does, the
 *      export fails.
 *   2. Runs the checks on the COPY: the scrub (`scripts/scrub-check.ts`, which includes the public patterns and the
 *      local-path and account patterns); the full private-name check, done HERE with the digests from the source repository
 *      over every text file, every file name and the commit author (skipped, and said so, if this script runs somewhere the
 *      digest file does not exist); and gitleaks, if it is installed (otherwise it says "gitleaks not installed" and the
 *      secret scan has NOT been done). With --test it also installs the copy's dependencies offline and runs its tests.
 *   3. `git init` in the copy and ONE commit with a placeholder author (research-kit authors, noreply@example.org).
 *      No remote is added, nothing is pushed or published.
 *
 * Exit code 1 if the scrub or the private-name check finds anything (the folder is left so you can look, and the
 * output says it is NOT safe to publish). A missing gitleaks does not fail the run but is printed loudly.
 * The path of the copy is the last line printed.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUTHOR = { name: "research-kit authors", email: "noreply@example.org" };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

function fail(message) {
  console.error(`export-public: ${message}`);
  process.exit(2);
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function defaultOutput(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/gu, "").replace("T", "-").slice(0, 15);
  return join(dirname(repo), `clio-open-public-export-${stamp}`);
}

/** Checks the output location before anything is written. Returns an error message, or undefined when it is fine. */
export function outputProblem(out) {
  if (isInside(repo, out)) return `the output folder must be outside this repository (${out})`;
  if (isInside(out, repo)) return "the output folder must not contain this repository";
  if (existsSync(out)) return `the output folder already exists: ${out} (it must be new)`;
  return undefined;
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

/** The digest list that exists only in the private repository, or undefined when it is not there. */
async function loadDigests() {
  const file = join(repo, "scripts", "private-terms.ts");
  if (!existsSync(file)) return undefined;
  const { PRIVATE_TERMS } = await import(pathToFileURL(file).href);
  const { findPrivateTerms } = await import(pathToFileURL(join(repo, "scripts", "term-match.ts")).href);
  return { terms: PRIVATE_TERMS, find: (text) => findPrivateTerms(text, PRIVATE_TERMS) };
}

/** The contact addresses the maintainer chose to publish (same list as scripts/scrub-check.ts); removed from a line before the digests read it. */
const PUBLIC_CONTACTS = ["security@cliomuseum.org"];
const withoutPublicContacts = (line) => PUBLIC_CONTACTS.reduce((text, contact) => text.split(contact).join(" "), line);

/** Reads every file name, every text line and the commit author through the digests (names are never printed). */
function privateNameCheck(out, authorText, digests) {
  const hits = [];
  for (const file of listFiles(out)) {
    const shown = relative(out, file).split(sep).join("/");
    for (const label of digests.find(shown)) hits.push(`${shown}: file name: ${label}`);
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue; // binary (the stored zip in test/vectors repeats files that are scanned as text)
    buffer.toString("utf8").split(/\r?\n/u).forEach((line, index) => {
      for (const label of digests.find(withoutPublicContacts(line))) hits.push(`${shown}:${index + 1}: ${label}`);
    });
  }
  for (const label of digests.find(authorText)) hits.push(`commit author: ${label}`);
  return hits;
}

/** Files in the copy that import the excluded digest module directly (a loader that uses a variable path does not count). */
function staticImportersOfDigests(out) {
  const pattern = /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*["'][^"']*private-terms(?:\.ts|\.js)?["']/u;
  return listFiles(out).filter((file) => /\.(?:ts|mjs|js|cjs)$/u.test(file) && pattern.test(readFileSync(file, "utf8"))).map((file) => relative(out, file).split(sep).join("/"));
}

function main() {
  const outIndex = process.argv.indexOf("--out");
  const out = resolve(outIndex >= 0 ? (process.argv[outIndex + 1] ?? fail("--out needs a folder")) : defaultOutput());
  const problem = outputProblem(out);
  if (problem) fail(problem);
  if (run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo }).stdout.trim() !== "true") fail("this is not a git repository");

  const dirty = run("git", ["status", "--porcelain"], { cwd: repo }).stdout.trim();
  if (dirty) console.log(`Note: uncommitted changes are NOT exported (only HEAD is):\n${dirty.split("\n").slice(0, 15).join("\n")}\n`);
  const head = run("git", ["rev-parse", "--short", "HEAD"], { cwd: repo }).stdout.trim();

  // 1. git archive HEAD into the new folder
  const scratch = mkdtempSync(join(tmpdir(), "export-public-"));
  const tarball = join(scratch, "head.tar");
  try {
    const archive = run("git", ["archive", "--format=tar", "--output", tarball, "HEAD"], { cwd: repo });
    if (archive.status !== 0) fail(`git archive failed: ${archive.stderr}`);
    mkdirSync(out, { recursive: true });
    // Run in the scratch folder with a relative archive name: GNU tar reads "C:..." as a remote host ("host:file").
    const extract = run("tar", ["-xf", "head.tar", "-C", out], { cwd: scratch });
    if (extract.status !== 0) { rmSync(out, { recursive: true, force: true }); fail(`could not extract the archive: ${extract.stderr}`); }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  // The digest list stays in the private repository.
  const digestFile = join(out, "scripts", "private-terms.ts");
  const excluded = existsSync(digestFile);
  if (excluded) rmSync(digestFile);
  const importers = staticImportersOfDigests(out);
  if (importers.length > 0) fail(`these files import the excluded digest module directly and would break in the public tree: ${importers.join(", ")}. Load it through scripts/private-terms-optional.ts instead. The folder ${out} was left for inspection.`);
  console.log(`Exported HEAD (${head}) to ${out} (${listFiles(out).length} files). ${excluded ? "scripts/private-terms.ts (the digests) was left out." : "scripts/private-terms.ts was not in HEAD."}`);

  // 2. checks on the copy
  let failed = false;
  const scrub = run(process.execPath, ["scripts/scrub-check.ts"], { cwd: out });
  console.log(`\nScrub: ${scrub.status === 0 ? "clean" : "FOUND PROBLEMS"}`);
  if (scrub.status !== 0) { failed = true; console.log((scrub.stdout + scrub.stderr).trim().split("\n").slice(0, 30).join("\n")); }

  return loadDigests().then((digests) => {
    if (digests === undefined) {
      console.log("Private-name check (digests): SKIPPED, scripts/private-terms.ts is not present here (it lives in the private repository). The scrub's pattern and local-path checks above did run.");
    } else {
      const hits = privateNameCheck(out, `${AUTHOR.name} <${AUTHOR.email}>`, digests);
      console.log(`Private-name check (digests from the source repository; file names, text, commit author): ${hits.length === 0 ? "clean" : "FOUND PROBLEMS"}`);
      if (hits.length > 0) { failed = true; console.log(hits.slice(0, 30).join("\n")); }
    }

    const version = run("gitleaks", ["version"]);
    if (version.error || version.status !== 0) {
      console.log("gitleaks not installed. The secret scan has NOT been done: install gitleaks (or trufflehog) and run it on the output folder before anything is pushed.");
    } else {
      const leaks = run("gitleaks", ["detect", "--source", out, "--no-git", "--redact", "--no-banner"]);
      console.log(`gitleaks ${version.stdout.trim()}: ${leaks.status === 0 ? "no leaks found" : "FOUND PROBLEMS"}`);
      if (leaks.status !== 0) { failed = true; console.log((leaks.stdout + leaks.stderr).trim().split("\n").slice(0, 30).join("\n")); }
    }

    // 3. one commit, placeholder author, no remote
    const env = { ...process.env, GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email };
    const steps = [
      ["init", "--quiet", "--initial-branch=main"],
      ["add", "-A"],
      ["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", "Initial export of research-kit (placeholder commit; no history)"],
    ];
    for (const args of steps) {
      const step = run("git", args, { cwd: out, env });
      if (step.status !== 0) fail(`git ${args[0]} failed in the copy: ${step.stderr}`);
    }
    const remotes = run("git", ["remote"], { cwd: out }).stdout.trim();
    const commits = run("git", ["rev-list", "--count", "HEAD"], { cwd: out }).stdout.trim();
    const author = run("git", ["log", "-1", "--format=%an <%ae>"], { cwd: out }).stdout.trim();
    console.log(`\nNew repository: ${commits} commit, author ${author}, remotes: ${remotes === "" ? "none" : remotes}. Nothing was pushed or published.`);
    if (remotes !== "") fail("the copy has a remote; that must never happen");
    const tracked = run("git", ["ls-files"], { cwd: out }).stdout.split("\n");
    if (tracked.some((name) => /(^|\/)private-terms\.ts$/u.test(name)) || existsSync(digestFile)) fail("the digest file is in the copy; that must never happen");
    console.log("Digest file in the copy: none.");

    if (process.argv.includes("--test")) {
      // Constant commands only. pnpm is a .cmd file on Windows, so a shell is used.
      const install = run("pnpm install --frozen-lockfile --offline", [], { cwd: out, shell: true });
      if (install.status !== 0) { failed = true; console.log(`Tests: could not install the copy's dependencies offline.\n${(install.stdout + install.stderr).trim().split("\n").slice(-15).join("\n")}`); }
      else {
        const tests = run("pnpm test", [], { cwd: out, shell: true });
        const summary = (tests.stdout + tests.stderr).split("\n").filter((line) => /^# (?:tests|pass|fail|skipped)|^ℹ (?:tests|pass|fail|skipped)/u.test(line));
        console.log(`Tests in the copy: ${tests.status === 0 ? "passed" : "FAILED"}\n${summary.join("\n")}`);
        if (tests.status !== 0) { failed = true; console.log((tests.stdout + tests.stderr).trim().split("\n").slice(-30).join("\n")); }
      }
    }

    console.log(failed ? "\nNOT SAFE TO PUBLISH: fix the problems above in the source repository, commit, and export again." : "\nChecks passed (see the gitleaks line above for whether the secret scan ran).");
    console.log(out);
    process.exit(failed ? 1 : 0);
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
