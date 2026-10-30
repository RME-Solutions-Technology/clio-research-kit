/**
 * Pre-publication scrub: fails when any file in the working tree contains a
 * private host, an account or database identifier, a personal e-mail address
 * or another marker that must never reach a public repository.
 *
 * It is a cheap grep, not a secret scanner. Run gitleaks or trufflehog too.
 *
 *   node scripts/scrub-check.ts        exit 1 on any hit
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findPrivateTermsIfPresent } from "./private-terms-optional.ts";

/** A local user folder or account name in a file is a leak whatever the name is, so these need no list of private words. */
export const LOCAL_PATH_PATTERNS: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  { name: "Windows user folder", pattern: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/u },
  { name: "Unix home folder", pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]{2,}\//u },
  { name: "OneDrive folder", pattern: /OneDrive\s*-\s*\S+/u },
  { name: "Azure AD account", pattern: /AzureAD\+\S+/u },
];

export const SCRUB_PATTERNS: readonly Readonly<{ name: string; pattern: RegExp }>[] = [
  { name: "staging host", pattern: /\bstaging\./iu },
  { name: "hosting subdomain", pattern: /\.(workers|pages)\.dev\b/iu },
  { name: "32-hex account or database id", pattern: /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/iu },
  { name: "UUID", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu },
  { name: "object-store scheme", pattern: /\br2:\/\//iu },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: "bearer or API token shape", pattern: /\b(?:ghp|gho|github_pat|sk|xox[abp])[-_][A-Za-z0-9_-]{20,}/u },
];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/gu;
const ALLOWED_EMAIL_DOMAINS = new Set(["example.org", "example.com", "example.net"]);
/** Not e-mail: the OData annotation `child@odata.navigationLink`. */
const NOT_EMAIL_DOMAINS = new Set(["odata.navigationlink"]);
const allowedDomain = (domain: string): boolean => NOT_EMAIL_DOMAINS.has(domain) || [...ALLOWED_EMAIL_DOMAINS].some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));

/**
 * Contact addresses the maintainer chose to publish. Each is removed from a line before the rules run, so the exact address is allowed
 * and nothing else at its domain is (another address there is still reported).
 */
export const PUBLIC_CONTACTS: readonly string[] = ["security@cliomuseum.org"];
const withoutPublicContacts = (line: string): string => PUBLIC_CONTACTS.reduce((text, contact) => text.split(contact).join(" "), line);

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "tmp", "sbom"]);
/** No file is exempt. Private names exist in the private repository only as digests; a public export has no digests and relies on the patterns above. */
const SKIP_PATHS = new Set<string>();
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);

/** Public sample data (ODK and Kobo test fixtures) is full of example UUIDs; the UUID rule is for private ids elsewhere. */
const UUID_EXEMPT_PREFIXES: readonly string[] = ["test/fixtures/", "test/connector-"];

export type ScrubHit = Readonly<{ file: string; line: number; rule: string; text: string }>;

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...listFiles(full));
    else if (!SKIP_FILES.has(entry)) files.push(full);
  }
  return files;
}

export function scrub(root: string): ScrubHit[] {
  const hits: ScrubHit[] = [];
  for (const file of listFiles(root)) {
    const shown = relative(root, file).split(sep).join("/");
    if (SKIP_PATHS.has(shown)) continue;
    const buffer = readFileSync(file);
    if (buffer.includes(0)) continue; // binary
    buffer.toString("utf8").split(/\r?\n/u).forEach((rawLine, index) => {
      const line = withoutPublicContacts(rawLine);
      for (const label of findPrivateTermsIfPresent(line)) hits.push({ file: shown, line: index + 1, rule: label, text: "(private term; the text is not shown)" });
      for (const { name, pattern } of LOCAL_PATH_PATTERNS) if (pattern.test(line)) hits.push({ file: shown, line: index + 1, rule: name, text: "(local path or account; the text is not shown)" });
      for (const { name, pattern } of SCRUB_PATTERNS) {
        if (name === "UUID" && UUID_EXEMPT_PREFIXES.some((prefix) => shown.startsWith(prefix))) continue;
        if (pattern.test(line)) hits.push({ file: shown, line: index + 1, rule: name, text: line.trim().slice(0, 160) });
      }
      for (const match of line.matchAll(EMAIL)) {
        if (!allowedDomain(match[1]!.toLowerCase())) hits.push({ file: shown, line: index + 1, rule: "e-mail address", text: match[0] });
      }
    });
  }
  return hits;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const hits = scrub(root);
  if (hits.length > 0) {
    console.error(hits.map((hit) => `${hit.file}:${hit.line}: ${hit.rule}: ${hit.text}`).join("\n"));
    process.exit(1);
  }
  console.log("Scrub check is clean.");
}
