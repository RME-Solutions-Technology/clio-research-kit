/**
 * ORCID iD checks (ISO 7064 MOD 11-2), kept local so the library has no
 * dependency on any identifier-registration code.
 */

const ORCID_ORIGIN = "https://orcid.org";
const ORCID_ID_PATTERN = /^\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/u;

function normalizeOrcidId(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || /[\s?#\\]/u.test(value)) return null;
  let candidate = value;
  if (candidate.startsWith(`${ORCID_ORIGIN}/`)) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      return null;
    }
    if (parsed.origin !== ORCID_ORIGIN || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
    if (!/^\/\d{4}-\d{4}-\d{4}-\d{3}[\dXx]$/u.test(parsed.pathname)) return null;
    candidate = parsed.pathname.slice(1);
  }
  if (!ORCID_ID_PATTERN.test(candidate)) return null;
  return candidate.slice(0, -1) + candidate.slice(-1).toUpperCase();
}

/** True for a bare iD (`0000-0002-1825-0097`) or an `https://orcid.org/` URL whose check digit is correct. */
export function isValidOrcid(value: unknown): value is string {
  const id = normalizeOrcidId(value);
  if (!id) return false;
  const digits = id.replaceAll("-", "");
  let total = 0;
  for (const digit of digits.slice(0, 15)) total = (total + Number(digit)) * 2;
  const remainder = total % 11;
  const check = (12 - remainder) % 11;
  const expected = check === 10 ? "X" : String(check);
  return digits.slice(-1) === expected;
}

/** The canonical `https://orcid.org/<id>` form, or null when the value is not a valid iD. */
export function normalizeOrcid(value: unknown): string | null {
  const id = normalizeOrcidId(value);
  return id !== null && isValidOrcid(id) ? `${ORCID_ORIGIN}/${id}` : null;
}
