/**
 * Minimal ZIP reader that touches only what it needs: the central directory at the end of
 * the file, then the bytes of the one or two entries we want (conversations.json). The
 * ChatGPT export can be hundreds of MB of images — reading it with `File.slice` means the
 * phone never loads (or uploads) the media. Supports stored + deflate entries and ZIP64
 * sizes/offsets. Decompression is injected (`inflateRaw`) so this stays dependency-free:
 * the browser passes fflate's `inflateSync`, tests pass node:zlib.
 */

export interface RandomAccess {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)) + b[o + 3]! * 0x1000000;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 0x100000000;

export function randomAccessFromBytes(bytes: Uint8Array): RandomAccess {
  return { size: bytes.length, read: async (s, e) => bytes.subarray(s, e) };
}

/** Lists every entry from the central directory. */
export async function listZipEntries(file: RandomAccess): Promise<ZipEntry[]> {
  const tailLen = Math.min(file.size, 65557 + 20);
  const tail = await file.read(file.size - tailLen, file.size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("That doesn't look like a .zip file (or it's incomplete — try downloading it again).");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  // ZIP64 end-of-central-directory locator sits right before the EOCD.
  const loc = eocd - 20;
  if ((count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) && loc >= 0 && u32(tail, loc) === 0x07064b50) {
    const z64Offset = u64(tail, loc + 8);
    const z64 = await file.read(z64Offset, z64Offset + 56);
    if (u32(z64, 0) !== 0x06064b50) throw new ZipError("This .zip uses a layout we can't read.");
    count = u64(z64, 32);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  if (cdOffset + cdSize > file.size) throw new ZipError("That .zip is incomplete — try downloading it again.");
  const cd = await file.read(cdOffset, cdOffset + cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  const decoder = new TextDecoder();
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const method = u16(cd, p + 10);
    let compressedSize = u32(cd, p + 20);
    let uncompressedSize = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localHeaderOffset = u32(cd, p + 42);
    const name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
    // ZIP64 extra field (0x0001): only the fields that were 0xFFFFFFFF are present, in order.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(cd, q);
          q += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(cd, q);
          q += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p = extraEnd + commentLen;
  }
  return entries;
}

/** Decompressed bytes of one entry. */
export async function readZipEntry(file: RandomAccess, entry: ZipEntry, inflateRaw: (data: Uint8Array) => Uint8Array): Promise<Uint8Array> {
  const header = await file.read(entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (u32(header, 0) !== 0x04034b50) throw new ZipError("That .zip looks damaged — try downloading it again.");
  const dataStart = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
  const data = await file.read(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new ZipError("This .zip is compressed in a way we can't read. Unzip it and choose conversations.json instead.");
}
