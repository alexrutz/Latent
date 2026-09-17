/**
 * A tiny animated-GIF encoder, so the mock ComfyUI can return a real moving
 * picture without an encoding library or an ffmpeg on the box.
 *
 * It exists for the same reason the PNG encoder beside it does: a video
 * workflow has to be exercisable end to end — harvested, filed as a video,
 * archived, badged, played — and doing that against a file the browser refuses
 * to render tests the plumbing and none of the behaviour.
 *
 * The compression is the standard "stored" trick: GIF's LZW is emitted as
 * literal 9-bit codes with a clear code often enough that the table never
 * outgrows nine bits. The result is a valid GIF that every decoder reads and
 * that is slightly larger than the raw pixels — which, for a 96×96 test
 * animation, nobody is going to notice.
 */

/** LSB-first bit packing, which is what GIF's code stream wants. */
class BitWriter {
  private readonly bytes: number[] = [];
  private current = 0;
  private bits = 0;

  write(code: number, width: number): void {
    for (let bit = 0; bit < width; bit += 1) {
      if ((code >> bit) & 1) this.current |= 1 << this.bits;
      this.bits += 1;
      if (this.bits === 8) {
        this.bytes.push(this.current);
        this.current = 0;
        this.bits = 0;
      }
    }
  }

  finish(): Buffer {
    if (this.bits > 0) {
      this.bytes.push(this.current);
      this.current = 0;
      this.bits = 0;
    }
    return Buffer.from(this.bytes);
  }
}

/** Data sub-blocks: at most 255 bytes each, terminated by an empty one. */
function subBlocks(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 255) {
    const slice = data.subarray(offset, offset + 255);
    parts.push(Buffer.from([slice.length]), slice);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** One frame's indices, as a GIF LZW stream that never leaves nine bits. */
function encodeIndices(indices: Uint8Array): Buffer {
  const CLEAR = 256;
  const END = 257;
  const writer = new BitWriter();

  writer.write(CLEAR, 9);
  // The decoder adds an entry per code after a clear; at 254 the next code
  // would need ten bits, so clear again and keep the width where it is.
  let sinceClear = 0;
  for (const index of indices) {
    if (sinceClear >= 250) {
      writer.write(CLEAR, 9);
      sinceClear = 0;
    }
    writer.write(index, 9);
    sinceClear += 1;
  }
  writer.write(END, 9);

  return subBlocks(writer.finish());
}

export interface GifFrame {
  /** One palette index per pixel, row by row. */
  indices: Uint8Array;
  /** How long it is shown, in hundredths of a second. */
  delayCs: number;
}

/**
 * An animated GIF from indexed frames and a palette of up to 256 colours.
 */
export function encodeGif(
  width: number,
  height: number,
  palette: [number, number, number][],
  frames: GifFrame[],
): Buffer {
  // The global colour table is a power of two entries long, padded with black.
  let bits = 1;
  while (1 << bits < Math.max(2, palette.length)) bits += 1;
  const tableSize = 1 << bits;

  const table = Buffer.alloc(tableSize * 3);
  palette.forEach(([r, g, b], index) => {
    table[index * 3] = r;
    table[index * 3 + 1] = g;
    table[index * 3 + 2] = b;
  });

  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  // Global colour table, 8-bit colour resolution, and its size as `bits - 1`.
  screen[4] = 0x80 | 0x70 | (bits - 1);
  screen[5] = 0;
  screen[6] = 0;

  // Loop forever, which is what makes a four-frame render read as a clip.
  const netscape = Buffer.concat([
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ]);

  const parts: Buffer[] = [Buffer.from('GIF89a', 'ascii'), screen, table, netscape];

  for (const frame of frames) {
    const control = Buffer.alloc(8);
    control[0] = 0x21;
    control[1] = 0xf9;
    control[2] = 0x04;
    control[3] = 0x00; // no transparency, no disposal
    control.writeUInt16LE(frame.delayCs, 4);
    control[6] = 0x00;
    control[7] = 0x00;

    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0x00; // no local table, not interlaced

    parts.push(control, descriptor, Buffer.from([0x08]), encodeIndices(frame.indices));
  }

  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/**
 * A short animation whose frames plainly differ, for the mock's video nodes.
 *
 * A band sweeps across a two-tone field, so "is this actually moving" can be
 * answered by looking at it — and so the file is different for a different
 * seed, the way a render is.
 */
export function renderPlaceholderClip(
  width: number,
  height: number,
  seed: string,
  frames = 8,
  fps = 8,
): Buffer {
  const hash = [...seed].reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 7);
  const palette: [number, number, number][] = [
    [16, 18, 28],
    [(hash >> 16) & 0xff, (hash >> 8) & 0xff, hash & 0xff],
    [240, 240, 245],
    [90, 100, 120],
  ];

  const out: GifFrame[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const indices = new Uint8Array(width * height);
    const band = Math.round((frame / frames) * width);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inBand = Math.abs(x - band) < Math.max(2, width / 12);
        const checker = ((x >> 4) + (y >> 4)) % 2 === 0;
        indices[y * width + x] = inBand ? 2 : checker ? 1 : 0;
      }
    }
    out.push({ indices, delayCs: Math.max(2, Math.round(100 / fps)) });
  }

  return encodeGif(width, height, palette, out);
}

/**
 * A stand-in `.webm`, for the paths where only the container matters.
 *
 * Enough of an EBML header that a sniffer calls it a WebM, and deliberately not
 * a decodable one: what it exercises is the server's side of a video — the
 * output key it arrives under, the byte ranges it is fetched in, the archive
 * that stores it without encrypting it — none of which cares whether there are
 * frames inside.
 */
export function renderPlaceholderWebm(seed: string, kilobytes = 24): Buffer {
  const header = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, // EBML
    0x9f, // header length
    0x42, 0x86, 0x81, 0x01, // EBMLVersion 1
    0x42, 0xf7, 0x81, 0x01, // EBMLReadVersion 1
    0x42, 0xf2, 0x81, 0x04, // EBMLMaxIDLength 4
    0x42, 0xf3, 0x81, 0x08, // EBMLMaxSizeLength 8
    0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, // DocType "webm"
    0x42, 0x87, 0x81, 0x02, // DocTypeVersion 2
    0x42, 0x85, 0x81, 0x02, // DocTypeReadVersion 2
  ]);

  // Body bytes derived from the seed, so two runs are two different files and
  // the content-addressed archive is exercised rather than short-circuited.
  const body = Buffer.alloc(Math.max(1, kilobytes) * 1024);
  let state = [...seed].reduce((total, character) => (total * 31 + character.charCodeAt(0)) >>> 0, 11);
  for (let index = 0; index < body.length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    body[index] = state & 0xff;
  }

  return Buffer.concat([header, body]);
}
