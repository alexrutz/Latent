/**
 * Generates the PWA icons in web/public.
 *
 * Kept as a script rather than committing opaque binaries with no source:
 * re-run `node scripts/make-icons.mjs` after changing the mark or the accent
 * colour. Self-contained (only node:zlib) so it needs no dependencies.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public');

/* --- minimal PNG encoder ------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y);
      raw[offset++] = Math.max(0, Math.min(255, Math.round(r)));
      raw[offset++] = Math.max(0, Math.min(255, Math.round(g)));
      raw[offset++] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --- the mark ------------------------------------------------------ */

const INK = [10, 10, 15];
const ACCENT = [124, 92, 255];
const ACCENT_HI = [180, 150, 255];

const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * Math.max(0, Math.min(1, t)));

/**
 * A four-pointed spark — the "✦" used for the Generate tab — glowing on the
 * app's own near-black background. Anti-aliased by supersampling.
 */
function markAt(nx, ny) {
  // Centre-relative coordinates in [-1, 1].
  const x = nx * 2 - 1;
  const y = ny * 2 - 1;

  const glow = Math.exp(-(x * x + y * y) * 2.2);
  let colour = mix(INK, ACCENT, glow * 0.55);

  // Astroid |x|^(2/3) + |y|^(2/3) <= r^(2/3) gives the concave-sided star.
  const k = Math.pow(Math.abs(x) / 0.62, 2 / 3) + Math.pow(Math.abs(y) / 0.62, 2 / 3);
  if (k <= 1) {
    const depth = 1 - k;
    colour = mix(mix(ACCENT, ACCENT_HI, depth * 1.6), [255, 255, 255], depth * 0.9);
  }

  return colour;
}

function renderIcon(size) {
  const SS = 3; // supersampling factor
  return encodePng(size, (px, py) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy += 1) {
      for (let sx = 0; sx < SS; sx += 1) {
        const [cr, cg, cb] = markAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
        r += cr;
        g += cg;
        b += cb;
      }
    }
    const n = SS * SS;
    return [r / n, g / n, b / n];
  });
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#7c5cff" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#0a0a0f" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="spark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#b496ff"/>
      <stop offset="100%" stop-color="#7c5cff"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" fill="#0a0a0f"/>
  <rect width="64" height="64" fill="url(#glow)"/>
  <path fill="url(#spark)" d="M32 4c1.6 12.6 6.8 18.4 20 24-13.2 5.6-18.4 11.4-20 24-1.6-12.6-6.8-18.4-20-24 13.2-5.6 18.4-11.4 20-24z"/>
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'icon-192.png'), renderIcon(192));
writeFileSync(join(OUT_DIR, 'icon-512.png'), renderIcon(512));
writeFileSync(join(OUT_DIR, 'icon.svg'), SVG);

console.log(`Wrote icon-192.png, icon-512.png and icon.svg to ${OUT_DIR}`);
