/**
 * Spreadsheet formula injection ("CSV injection"). A spreadsheet runs a cell whose text starts
 * with =, +, - or @ (or a tab or carriage return) as a formula. Exports keep values exactly as
 * given by default; the opt-in `spreadsheetSafe` export option puts a single quote in front of
 * such a cell, which spreadsheets read as "this is text" (OWASP's recommendation). The quote is
 * part of the stored text, so a reader who wants the original value strips one leading quote.
 */

/**
 * True when a spreadsheet might run the text as a formula. A plain number such as -33.8 or 1e-5
 * is not reported, because a numeric column holds those and quoting them would turn numbers into text.
 */
export function looksLikeFormula(text: string): boolean {
  if (text.length === 0) return false;
  const first = text[0]!;
  if (first === "=" || first === "@" || first === "\t" || first === "\r") return true;
  if (first === "+" || first === "-") return !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(text);
  return false;
}

/** The text with a leading single quote when a spreadsheet would run it as a formula; unchanged otherwise. */
export function spreadsheetSafeText(text: string): string {
  return looksLikeFormula(text) ? `'${text}` : text;
}
