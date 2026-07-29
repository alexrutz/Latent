import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Just enough PNG to read a file's size and make a thumbnail from it.
 *
 * Deliberately dependency-free. The alternative is `sharp`, a large native
 * module that has to compile on some platforms — a heavy price for "make this
 * picture smaller", especially on a home server or a Raspberry Pi. ComfyUI
 * writes PNG by default, so this covers the overwhelming majority of images
 * Latent ever handles; anything else falls back to being served at full size.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export interface Dimensions {
  width: number;
  height: number;
}

export function isPng(buffer: Buffer): boolean {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

/** Read `width`/`height` out of the IHDR chunk without decoding pixels. */
export function readPngSize(buffer: Buffer): Dimensions | null {
  if (!isPng(buffer) || buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Read a JPEG's size by walking its segment markers to the frame header.
 * Only the size — decoding JPEG pixels is well beyond what belongs here.
 */
export function readJpegSize(buffer: Buffer): Dimensions | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1] as number;
    // SOF0-SOF15, excluding the non-frame markers in that range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/** Size of any image we can recognise. */
export function readImageSize(buffer: Buffer): Dimensions | null {
  return readPngSize(buffer) ?? readJpegSize(buffer);
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

interface DecodedPng extends Dimensions {
  /** RGB triples, one byte per channel. */
  pixels: Uint8Array;
}

const CHANNELS: Record<number, number> = {
  0: 1, // greyscale
  2: 3, // truecolour
  3: 1, // palette index
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decode a PNG to RGB.
 *
 * Supports 8-bit greyscale, truecolour, palette and their alpha variants —
 * everything ComfyUI produces. Returns null for interlaced or 16-bit images
 * rather than guessing, so the caller can fall back to the original file.
 */
export function decodePng(buffer: Buffer): DecodedPng | null {
  if (!isPng(buffer)) return null;

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlaced = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) break;

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      bitDepth = buffer[start + 8] as number;
      colourType = buffer[start + 9] as number;
      interlaced = buffer[start + 12] as number;
    } else if (type === 'PLTE') {
      palette = buffer.subarray(start, end);
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(start, end));
    } else if (type === 'IEND') {
      break;
    }

    offset = end + 4; // skip the CRC
  }

  // Anything exotic: let the caller serve the original instead.
  if (!width || !height || bitDepth !== 8 || interlaced !== 0) return null;
  const channels = CHANNELS[colourType];
  if (!channels || idat.length === 0) return null;
  if (colourType === 3 && !palette) return null;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  // Undo the per-scanline filters in place.
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const target = lines.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? lines.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const rawByte = source[x] as number;
      const left = x >= channels ? (target[x - channels] as number) : 0;
      const up = previous ? (previous[x] as number) : 0;
      const upLeft = previous && x >= channels ? (previous[x - channels] as number) : 0;

      let value: number;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + left;
          break;
        case 2:
          value = rawByte + up;
          break;
        case 3:
          value = rawByte + ((left + up) >> 1);
          break;
        case 4:
          value = rawByte + paeth(left, up, upLeft);
          break;
        default:
          return null;
      }
      target[x] = value & 0xff;
    }
  }

  // Flatten whatever colour model it used into plain RGB.
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const source = i * channels;
    let r: number;
    let g: number;
    let b: number;

    if (colourType === 3) {
      const index = (lines[source] as number) * 3;
      r = (palette as Buffer)[index] ?? 0;
      g = (palette as Buffer)[index + 1] ?? 0;
      b = (palette as Buffer)[index + 2] ?? 0;
    } else if (colourType === 0 || colourType === 4) {
      r = g = b = lines[source] as number;
    } else {
      r = lines[source] as number;
      g = lines[source + 1] as number;
      b = lines[source + 2] as number;
    }

    pixels[i * 3] = r;
    pixels[i * 3 + 1] = g;
    pixels[i * 3 + 2] = b;
  }

  return { width, height, pixels };
}

/* ------------------------------------------------------------------ */
/* Encoding and resizing                                               */
/* ------------------------------------------------------------------ */

export function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width * 3; x += 1) {
      raw[offset] = pixels[y * width * 3 + x] as number;
      offset += 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Box-filter downscale. Averaging every source pixel that lands in a target
 * pixel keeps thumbnails from shimmering the way nearest-neighbour does, and is
 * cheap enough to run inline while archiving.
 */
export function resizeRgb(
  source: DecodedPng,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const output = new Uint8Array(targetWidth * targetHeight * 3);
  const xRatio = source.width / targetWidth;
  const yRatio = source.height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor(y * yRatio);
    const y1 = Math.max(y0 + 1, Math.min(source.height, Math.floor((y + 1) * yRatio)));

    for (let x = 0; x < targetWidth; x += 1) {
      const x0 = Math.floor(x * xRatio);
      const x1 = Math.max(x0 + 1, Math.min(source.width, Math.floor((x + 1) * xRatio)));

      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const index = (sy * source.width + sx) * 3;
          r += source.pixels[index] as number;
          g += source.pixels[index + 1] as number;
          b += source.pixels[index + 2] as number;
          count += 1;
        }
      }

      const target = (y * targetWidth + x) * 3;
      output[target] = Math.round(r / count);
      output[target + 1] = Math.round(g / count);
      output[target + 2] = Math.round(b / count);
    }
  }

  return output;
}

export interface Thumbnail {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Make a thumbnail whose longest side is `maxSize`.
 *
 * Returns null when the image cannot be decoded (JPEG, 16-bit, interlaced) or is
 * already small enough to send as-is.
 */
export function makeThumbnail(buffer: Buffer, maxSize = 384): Thumbnail | null {
  const decoded = decodePng(buffer);
  if (!decoded) return null;

  const scale = maxSize / Math.max(decoded.width, decoded.height);
  if (scale >= 1) return null; // already small; the original is the thumbnail

  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));

  return {
    data: encodePng(width, height, resizeRgb(decoded, width, height)),
    width,
    height,
  };
}
