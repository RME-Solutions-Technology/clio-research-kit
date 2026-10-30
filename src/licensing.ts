/**
 * Licence helpers.
 *
 * Record metadata is licensed CC BY 4.0 unless the caller passes another
 * {@link Licence}. The licence is a plain option on the builders and
 * validators; nothing here is tied to a particular service or deposit policy.
 */

export interface Licence {
  readonly name: string;
  readonly shortName: string;
  /** SPDX identifier, for example `CC-BY-4.0`. */
  readonly spdxIdentifier: string;
  /** Absolute https URI of the licence text. */
  readonly uri: string;
}

export const CC_BY_4_0: Licence = Object.freeze({
  name: "Creative Commons Attribution 4.0 International",
  shortName: "CC BY 4.0",
  spdxIdentifier: "CC-BY-4.0",
  uri: "https://creativecommons.org/licenses/by/4.0/",
} as const);

/** The licence used when a caller does not pass one. */
export const DEFAULT_LICENCE: Licence = CC_BY_4_0;
export const DEFAULT_LICENCE_URI: string = DEFAULT_LICENCE.uri;

/** Returns the licence to use: the caller's when given, else {@link DEFAULT_LICENCE}. */
export function resolveLicence(licence?: Licence): Licence {
  return licence ?? DEFAULT_LICENCE;
}

/** Problems with a caller-supplied licence; empty when it is usable. */
export function licenceProblems(licence: unknown): string[] {
  if (typeof licence !== "object" || licence === null) return ["licence must be an object"];
  const candidate = licence as Partial<Licence>;
  const problems: string[] = [];
  for (const key of ["name", "shortName", "spdxIdentifier"] as const) {
    if (typeof candidate[key] !== "string" || candidate[key]!.trim() === "") problems.push(`licence.${key} is required`);
  }
  try {
    const parsed = new URL(String(candidate.uri));
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") problems.push("licence.uri must be an https URL without credentials");
  } catch {
    problems.push("licence.uri must be an absolute https URL");
  }
  return problems;
}
