/**
 * Matching text against a list of private terms kept as SHA-256 digests. The matcher is generic and public; the list
 * of digests (scripts/private-terms.ts) exists in the private repository only, because a short, guessable name can be
 * confirmed by hashing it. The public tree falls back to the pattern and local-path checks in scrub-check.ts.
 *
 * A digest is of a lower-case word, or of two adjacent words joined with "-". Text is split into words of letters and
 * digits, so "my-private.example" is checked as "my", "private", "example", "my-private" and "private-example".
 */
import { createHash } from "node:crypto";

export type PrivateTerm = Readonly<{ label: string; digest: string }>;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Labels of the private terms found in the text (one entry per distinct label). */
export function findPrivateTerms(text: string, terms: readonly PrivateTerm[]): string[] {
  const known = new Map(terms.map((term) => [term.digest, term.label]));
  const words = text.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const found = new Set<string>();
  const check = (candidate: string): void => {
    const label = known.get(sha256(candidate));
    if (label !== undefined) found.add(label);
  };
  words.forEach((word, index) => {
    check(word);
    if (index + 1 < words.length) check(`${word}-${words[index + 1]}`);
  });
  return [...found];
}
