/**
 * A minimal, dependency-free ZIP writer and reader for store-only (method 0,
 * no compression) archives, as described in PKWARE's APPNOTE.TXT.
 *
 * It exists so a browser, Worker or script can hand a research team one downloadable file
 * without a new dependency. Deliberately small:
 * - store only (no deflate), so output is deterministic and CRC-32 is the only
 *   computation per byte;
 * - no ZIP64, encryption, data descriptors, comments or extra fields;
 * - UTF-8 names (general purpose flag bit 11) that must be safe relative paths;
 * - one fixed modification time for every entry, so the same input always
 *   produces the same bytes.
 *
 * The reader accepts only what the writer produces and checks every CRC-32.
 * It is used by tests and by anyone who wants to re-check a package without
 * an unzip tool.
 */

export const ZIP_STORE_LIMITS = Object.freeze({
  entries: 65_535,
  /** Stay well below the 4 GiB classic ZIP ceiling; real exports are far smaller. */
  totalBytes: 0x7fff_ffff,
  nameBytes: 1_024,
});

export type ZipEntry = Readonly<{ name: string; bytes: Uint8Array }>;

export class ZipStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipStoreError";
  }
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const encoder = new TextEncoder();

let crcTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const result = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    result[index] = value >>> 0;
  }
  crcTable = result;
  return result;
}

/** CRC-32 (ISO 3309 / ITU-T V.42, the ZIP and PNG polynomial) as an unsigned integer. */
export function crc32(bytes: Uint8Array): number {
  const lookup = table();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = lookup[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time for an ISO date-time, clamped to the 1980-2107 range ZIP can hold. */
export function dosDateTime(iso: string): Readonly<{ date: number; time: number }> {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) throw new ZipStoreError("modifiedAt must be an ISO date-time");
  const instant = new Date(parsed);
  const year = instant.getUTCFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (year > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((year - 1980) << 9) | ((instant.getUTCMonth() + 1) << 5) | instant.getUTCDate(),
    time: (instant.getUTCHours() << 11) | (instant.getUTCMinutes() << 5) | Math.floor(instant.getUTCSeconds() / 2),
  };
}

/** A safe relative name: no absolute path, drive letter, backslash, empty or dot segment, or control character. */
export function isSafeZipName(name: string): boolean {
  if (name.length === 0 || encoder.encode(name).byteLength > ZIP_STORE_LIMITS.nameBytes) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name) || name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(name)) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !isWindowsUnsafeSegment(segment));
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

/** A segment Windows or macOS would rename, alias or refuse on extraction: reserved device names, a trailing dot or space, or < > : " | ? *. */
function isWindowsUnsafeSegment(segment: string): boolean {
  return /[<>:"|?*]/u.test(segment) || /[. ]$/u.test(segment) || WINDOWS_RESERVED.test(segment);
}

/**
 * Writes a store-only ZIP. Entry order is preserved, so callers control it
 * (BagIt readers do not care; some Darwin Core tools want meta.xml first).
 */
export function createStoredZip(entries: readonly ZipEntry[], options: Readonly<{ modifiedAt: string }>): Uint8Array<ArrayBuffer> {
  if (entries.length > ZIP_STORE_LIMITS.entries) throw new ZipStoreError(`A store-only ZIP can hold at most ${ZIP_STORE_LIMITS.entries} entries`);
  const { date, time } = dosDateTime(options.modifiedAt);
  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    if (!isSafeZipName(entry.name)) throw new ZipStoreError(`Unsafe ZIP entry name: ${JSON.stringify(entry.name.slice(0, 80))}`);
    if (seen.has(entry.name.toLowerCase())) throw new ZipStoreError(`Duplicate ZIP entry name (names that differ only by case collide on Windows and macOS): ${entry.name}`);
    seen.add(entry.name.toLowerCase());
    return { name: encoder.encode(entry.name), bytes: entry.bytes, crc: crc32(entry.bytes) };
  });
  let localBytes = 0;
  let centralBytes = 0;
  for (const entry of prepared) {
    localBytes += 30 + entry.name.byteLength + entry.bytes.byteLength;
    centralBytes += 46 + entry.name.byteLength;
  }
  const total = localBytes + centralBytes + 22;
  if (total > ZIP_STORE_LIMITS.totalBytes) throw new ZipStoreError("The ZIP would be larger than this writer allows");
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  let offset = 0;
  const offsets: number[] = [];
  for (const entry of prepared) {
    offsets.push(offset);
    view.setUint32(offset, LOCAL_HEADER, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, UTF8_FLAG, true);
    view.setUint16(offset + 8, 0, true);
    view.setUint16(offset + 10, time, true);
    view.setUint16(offset + 12, date, true);
    view.setUint32(offset + 14, entry.crc, true);
    view.setUint32(offset + 18, entry.bytes.byteLength, true);
    view.setUint32(offset + 22, entry.bytes.byteLength, true);
    view.setUint16(offset + 26, entry.name.byteLength, true);
    view.setUint16(offset + 28, 0, true);
    output.set(entry.name, offset + 30);
    output.set(entry.bytes, offset + 30 + entry.name.byteLength);
    offset += 30 + entry.name.byteLength + entry.bytes.byteLength;
  }
  const centralStart = offset;
  prepared.forEach((entry, index) => {
    view.setUint32(offset, CENTRAL_HEADER, true);
    view.setUint16(offset + 4, VERSION, true);
    view.setUint16(offset + 6, VERSION, true);
    view.setUint16(offset + 8, UTF8_FLAG, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, time, true);
    view.setUint16(offset + 14, date, true);
    view.setUint32(offset + 16, entry.crc, true);
    view.setUint32(offset + 20, entry.bytes.byteLength, true);
    view.setUint32(offset + 24, entry.bytes.byteLength, true);
    view.setUint16(offset + 28, entry.name.byteLength, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true);
    view.setUint16(offset + 34, 0, true);
    view.setUint16(offset + 36, 0, true);
    view.setUint32(offset + 38, 0, true);
    view.setUint32(offset + 42, offsets[index]!, true);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.byteLength;
  });
  view.setUint32(offset, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, prepared.length, true);
  view.setUint16(offset + 10, prepared.length, true);
  view.setUint32(offset + 12, offset - centralStart, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);
  return output;
}

/**
 * Reads a store-only ZIP written by createStoredZip (or any equivalent
 * archive): every entry must be stored, unencrypted, without a data
 * descriptor, with matching local and central records and a correct CRC-32.
 */
export function readStoredZip(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (message: string): never => { throw new ZipStoreError(message); };
  if (bytes.byteLength < 22) fail("Not a ZIP file: too short");
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 22 - 0xffff); offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY && offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength) { end = offset; break; }
  }
  if (end < 0) fail("Not a ZIP file: no end of central directory record");
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) fail("Multi-disk ZIP files are not supported");
  const count = view.getUint16(end + 10, true);
  if (count !== view.getUint16(end + 8, true)) fail("Inconsistent ZIP entry count");
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  if (centralStart + centralSize !== end) fail("ZIP central directory is not where the end record says");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let offset = centralStart;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== CENTRAL_HEADER) fail(`ZIP central record ${index} is malformed`);
    const flags = view.getUint16(offset + 8, true);
    if (flags & 0x0001) fail("Encrypted ZIP entries are not supported");
    if (flags & 0x0008) fail("ZIP data descriptors are not supported");
    if (view.getUint16(offset + 10, true) !== 0) fail("Only stored (uncompressed) ZIP entries are supported");
    const crc = view.getUint32(offset + 16, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (compressedSize !== size) fail("A stored ZIP entry must have equal sizes");
    let name = "";
    try { name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)); } catch { fail("ZIP entry name is not UTF-8"); }
    if (!isSafeZipName(name)) fail(`Unsafe ZIP entry name: ${JSON.stringify(name.slice(0, 80))}`);
    if (names.has(name.toLowerCase())) fail(`Duplicate ZIP entry name (names that differ only by case collide on Windows and macOS): ${name}`);
    names.add(name.toLowerCase());
    if (localOffset + 30 > centralStart || view.getUint32(localOffset, true) !== LOCAL_HEADER) fail(`ZIP local record for ${name} is malformed`);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    let localName = "";
    try { localName = decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)); } catch { fail(`ZIP local name for ${name} is not UTF-8`); }
    if (view.getUint16(localOffset + 8, true) !== 0 || view.getUint32(localOffset + 14, true) !== crc
      || view.getUint32(localOffset + 18, true) !== size || view.getUint32(localOffset + 22, true) !== size
      || localNameLength !== nameLength
      || localName !== name) {
      fail(`ZIP local and central records disagree for ${name}`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + size > centralStart) fail(`ZIP entry ${name} runs past the central directory`);
    const data = bytes.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) fail(`ZIP entry ${name} does not match its CRC-32`);
    entries.push({ name, bytes: data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) fail("ZIP central directory has trailing bytes");
  return entries;
}
