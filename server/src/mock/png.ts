import { deflateSync } from 'node:zlib';

/**
 * A tiny PNG encoder, so the mock ComfyUI can return real image bytes without
 * pulling in an image library. Truecolour, 8 bits per channel, no interlacing.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export type PixelFn = (x: number, y: number) => [number, number, number];

export function encodePng(width: number, height: number, pixel: PixelFn): Buffer {
  // Each scanline is prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Cheap deterministic hash, so the same seed always renders the same image. */
export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * A distinctive plasma pattern keyed off a seed string.
 *
 * Different prompts and seeds must produce visibly different images — otherwise
 * a gallery of mock results all look identical and bugs hide in plain sight.
 * `progress` (0..1) darkens the image so in-flight previews look unfinished.
 */
export function renderPlaceholder(
  width: number,
  height: number,
  seed: string,
  progress = 1,
): Buffer {
  const hash = hashString(seed);
  const hueShift = (hash % 360) / 360;
  const freqX = 1.5 + ((hash >>> 8) % 7);
  const freqY = 1.5 + ((hash >>> 16) % 5);
  const swirl = ((hash >>> 24) % 5) + 1;

  return encodePng(width, height, (x, y) => {
    const nx = x / width;
    const ny = y / height;
    const v =
      Math.sin(nx * freqX * Math.PI * 2) * 0.5 +
      Math.sin(ny * freqY * Math.PI * 2) * 0.3 +
      Math.sin((nx + ny) * swirl * Math.PI * 2) * 0.2;
    const [r, g, b] = hsvToRgb((hueShift + v * 0.15 + 1) % 1, 0.55, 0.35 + (v + 1) * 0.3);
    const fade = 0.25 + 0.75 * Math.min(1, Math.max(0, progress));
    return [Math.round(r * fade), Math.round(g * fade), Math.round(b * fade)];
  });
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  const table: [number, number, number][] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ];
  const [r, g, b] = table[i % 6] as [number, number, number];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
