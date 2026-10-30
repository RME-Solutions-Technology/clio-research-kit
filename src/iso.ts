/**
 * Calendar and date-time checks shared by the exporters. `Date.parse` is not one of them:
 * V8 reads 2026-02-31 as 3 March, so a value that parses is not necessarily a real date.
 */

/** True for a real calendar day written YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2}):(\d{2}))$/u;

/** True for YYYY-MM-DDTHH:MM[:SS[.fff]] followed by Z or an offset, with a real calendar day and a real clock time. */
export function isIsoDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  if (!match || !isCalendarDate(match[1]!)) return false;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || (match[4] !== undefined && Number(match[4]) > 59)) return false;
  if (match[6] !== undefined && (Number(match[6]) > 23 || Number(match[7]) > 59)) return false;
  return true;
}

/** The calendar date, in UTC, of a valid date-time: what an `xs:date` or a BagIt Bagging-Date should carry. */
export function utcDateOf(value: string): string {
  if (!isIsoDateTime(value)) throw new RangeError("Not an ISO 8601 date-time with a zone and a real calendar day.");
  return new Date(value).toISOString().slice(0, 10);
}
