import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkImports, specifiersIn } from "../scripts/check-imports.ts";
import { PRIVATE_TERM_LIST, privateTermsAvailable } from "../scripts/private-terms-optional.ts";
import { LOCAL_PATH_PATTERNS, SCRUB_PATTERNS, scrub } from "../scripts/scrub-check.ts";
import { findPrivateTerms } from "../scripts/term-match.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// scripts/private-terms.ts (the digests) exists in the private repository only. A public export has no such file, and
// everything below that does not need it still runs: the import graph, the scrub, the public patterns, the local-path
// patterns and the matcher. The tests that read the digest list are skipped, with the reason shown.
const NEEDS_DIGESTS = privateTermsAvailable ? false : "scripts/private-terms.ts is not present (private repository only); the pattern and local-path checks still run";

test("import graph: src/ imports only its own files and node: built-ins; nothing from the app, private packages or other scopes", () => {
  assert.deepEqual(checkImports(root), []);
});

test("the import scanner sees static, type, re-export, dynamic and require forms", () => {
  const source = [
    `import a from "./a.ts";`,
    `import type { B } from "../b.ts";`,
    `import { c } from "@scope/pkg";`,
    `export * from "./d.ts";`,
    `export { e } from "@clio/app-package";`,
    `const f = await import("some-dynamic");`,
    `const g = require("some-required");`,
    `import "node:fs";`,
  ].join("\n");
  assert.deepEqual(specifiersIn(source), ["./a.ts", "../b.ts", "@scope/pkg", "./d.ts", "@clio/app-package", "some-dynamic", "some-required", "node:fs"]);
});

test("scrub: no private hosts, account ids, personal e-mail addresses, local paths or key material in the tree", () => {
  assert.deepEqual(scrub(root), []);
});

test("the public scrub rules catch what they are meant to catch", () => {
  const sample: Record<string, string> = {
    "staging host": ["stag", "ing.example.org"].join(""),
    "32-hex account or database id": "a".repeat(32),
    UUID: ["123e4567", "e89b", "12d3", "a456", "426614174000"].join("-"),
    "object-store scheme": ["r2", "://bucket/key"].join(""),
  };
  for (const [name, text] of Object.entries(sample)) {
    assert.ok(SCRUB_PATTERNS.some((rule) => rule.name === name && rule.pattern.test(text)), name);
  }
  assert.equal(SCRUB_PATTERNS.some((rule) => rule.name === "32-hex account or database id" && rule.pattern.test("a".repeat(64))), false, "a 64-hex SHA-256 is not an account id");
});

test("the local-path patterns catch a user folder, a home folder, a OneDrive folder and an Azure AD account, whatever the name", () => {
  const sample: Record<string, string> = {
    "Windows user folder": ["C", ":\\", "Users", "\\", "someone", "\\Documents"].join(""),
    "Unix home folder": ["", "home", "someone", "work"].join("/") + "/",
    "OneDrive folder": ["OneDrive", " - ", "Some Company"].join(""),
    "Azure AD account": ["AzureAD", "+SomeOne"].join(""),
  };
  for (const [name, text] of Object.entries(sample)) {
    assert.ok(LOCAL_PATH_PATTERNS.some((rule) => rule.name === name && rule.pattern.test(text)), `${name}: ${text}`);
  }
  for (const fine of ["see the Users guide", "C is a language", "docs/users/guide.md", "https://example.org/Users"]) {
    assert.equal(LOCAL_PATH_PATTERNS.some((rule) => rule.pattern.test(fine)), false, fine);
  }
});

test("scrub reports a local path in a file without printing it back", () => {
  const folder = mkdtempSync(join(tmpdir(), "scrub-"));
  mkdirSync(join(folder, "docs"), { recursive: true });
  const path = ["C", ":\\", "Users", "\\", "someone", "\\work"].join("");
  writeFileSync(join(folder, "docs", "a.md"), `built in ${path}\nok line\n`);
  const hits = scrub(folder);
  assert.deepEqual(hits.map((hit) => `${hit.file}:${hit.line}:${hit.rule}`), ["docs/a.md:1:Windows user folder"]);
  assert.ok(hits.every((hit) => !hit.text.includes("someone")));
});

test("private terms are matched as digests of words and adjacent word pairs; nothing else", () => {
  // The real terms are not written in this repository, so the matcher is tested with a made-up one.
  const terms = [{ label: "made-up term", digest: sha256("zzqx-vault") }, { label: "made-up word", digest: sha256("quuxplorer") }];
  assert.deepEqual(findPrivateTerms("import x from 'zzqx-vault/client'", terms), ["made-up term"]);
  assert.deepEqual(findPrivateTerms("ZZQX.Vault", terms), ["made-up term"], "case and separators do not hide a term");
  assert.deepEqual(findPrivateTerms("see QuuxPlorer docs", terms), ["made-up word"]);
  assert.deepEqual(findPrivateTerms("zzqx and vault apart; nothing here", terms), []);
  assert.deepEqual(findPrivateTerms("anything at all", []), []);
});

test("the digest list is well formed (private repository only)", { skip: NEEDS_DIGESTS }, () => {
  const list = PRIVATE_TERM_LIST!;
  assert.ok(list.length >= 10 && list.every((term) => /^[0-9a-f]{64}$/u.test(term.digest) && term.label.length > 0));
  assert.equal(new Set(list.map((term) => term.digest)).size, list.length, "no duplicate digests");
});

test("scrub accepts the published security contact and nothing else at its domain", () => {
  const folder = mkdtempSync(join(tmpdir(), "scrub-"));
  const host = ["clio", "museum.org"].join("");
  writeFileSync(join(folder, "a.md"), `email security@${host}
`);
  writeFileSync(join(folder, "b.md"), `email someone.else@${host}
`);
  const hits = scrub(folder);
  assert.deepEqual(hits.filter((hit) => hit.file === "a.md"), [], "the published address passes");
  assert.ok(hits.some((hit) => hit.file === "b.md" && hit.rule === "e-mail address"), "another address at that domain is still reported");
});

test("scrub flags look-alike e-mail domains and accepts subdomains of the example domains", () => {
  const folder = mkdtempSync(join(tmpdir(), "scrub-"));
  mkdirSync(join(folder, "docs"), { recursive: true });
  const lookAlike = ["evil", "example.org", "attacker.net"].join(".");
  writeFileSync(join(folder, "docs", "a.md"), `contact someone@${lookAlike}\nok line\n`);
  writeFileSync(join(folder, "docs", "b.md"), "subdomain someone@sub.example.org is fine\n");
  const hits = scrub(folder);
  assert.deepEqual(hits.map((hit) => `${hit.file}:${hit.rule}`), ["docs/a.md:e-mail address"]);
});
