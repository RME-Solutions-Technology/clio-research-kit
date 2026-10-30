/**
 * Loads the private-term digests when they exist. In the private repository scripts/private-terms.ts is present and the
 * full digest check runs. In a public export that file is deliberately absent, and every check that uses this module
 * carries on with the pattern and local-path checks only.
 */
import { findPrivateTerms, type PrivateTerm } from "./term-match.ts";

// A variable, not a literal, so type-checking and the import-graph check do not require the file to exist.
const modulePath = "./private-terms.ts";

async function load(): Promise<readonly PrivateTerm[] | undefined> {
  try {
    const loaded = (await import(modulePath)) as { PRIVATE_TERMS?: readonly PrivateTerm[] };
    return loaded.PRIVATE_TERMS;
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

/** The digest list, or undefined when scripts/private-terms.ts is not present (a public export). */
export const PRIVATE_TERM_LIST: readonly PrivateTerm[] | undefined = await load();

export const privateTermsAvailable: boolean = PRIVATE_TERM_LIST !== undefined;

/** Labels of the private terms found in the text; always empty when the digest list is not present. */
export function findPrivateTermsIfPresent(text: string): string[] {
  return PRIVATE_TERM_LIST === undefined ? [] : findPrivateTerms(text, PRIVATE_TERM_LIST);
}
