import { isPng, makeThumbnail, readImageSize } from './png.js';

/**
 * Small copies of big pictures, made here because nobody else will.
 *
 * ComfyUI's `/view?preview=webp;70` sounds like a thumbnail and is not one: it
 * re-encodes the file and leaves every pixel where it was. A 4000×4000 output
 * comes back as a 4000×4000 WebP — a couple of megabytes on the wire, and
 * 4000 × 4000 × 4 = 64 MB of bitmap once the browser has decoded it. Twenty of
 * those in a gallery grid is over a gigabyte in the renderer, which is why
 * scrolling a page of upscaled images killed the tab outright.
 *
 * So a preview is downscaled here, and the result is kept: decoding a
 * 4000×4000 PNG in JavaScript costs a few hundred milliseconds, which is fine
 * once per picture and unthinkable once per scroll.
 */

/** Longest side of a derived thumbnail. Matches the archive's own. */
export const THUMBNAIL_SIZE = 384;

/** How much of these to keep. They are ~130 kB each at 384px. */
const DEFAULT_BUDGET = 64 * 1024 * 1024;

export interface DerivedThumbnail {
  data: Buffer;
  contentType: string;
}

export class ThumbnailCache {
  /** Insertion-ordered, so the oldest key is simply the first one. */
  private readonly entries = new Map<string, DerivedThumbnail | null>();
  /** One promise per key being built, so a grid of tiles fetches each once. */
  private readonly inFlight = new Map<string, Promise<DerivedThumbnail | null>>();
  /** The tail of the work queue; see `serialise`. */
  private tail: Promise<unknown> = Promise.resolve();
  private bytes = 0;

  constructor(
    private readonly maxSize: number = THUMBNAIL_SIZE,
    private readonly budget: number = DEFAULT_BUDGET,
  ) {}

  /**
   * The thumbnail for `key`, deriving it from the original if need be.
   *
   * `null` means the original cannot be shrunk here — a JPEG, a 16-bit or
   * interlaced PNG — and the caller should serve what it would have served
   * before. That answer is remembered too, so an image we cannot handle is not
   * fetched again on every tile.
   */
  async get(
    key: string,
    loadOriginal: () => Promise<Buffer | null>,
  ): Promise<DerivedThumbnail | null> {
    if (this.entries.has(key)) {
      const hit = this.entries.get(key) ?? null;
      // Re-insert to move it to the young end of the map.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const work = this.build(key, loadOriginal).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  /** Drop everything, for a test or a connection change. */
  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** How much is being held, so a test can watch the budget work. */
  get size(): number {
    return this.bytes;
  }

  private async build(
    key: string,
    loadOriginal: () => Promise<Buffer | null>,
  ): Promise<DerivedThumbnail | null> {
    const original = await loadOriginal();
    if (!original || original.length === 0) return null;

    /*
     * Already small enough: the original *is* the thumbnail. Said here rather
     * than left to `makeThumbnail`, which answers `null` both for this and for
     * a format it cannot read — and those two want opposite things from the
     * caller.
     */
    const size = readImageSize(original);
    if (size && Math.max(size.width, size.height) <= this.maxSize) {
      return this.remember(key, {
        data: original,
        contentType: isPng(original) ? 'image/png' : 'image/jpeg',
      });
    }

    const thumbnail = await this.serialise(() => makeThumbnail(original, this.maxSize));
    if (!thumbnail) return this.remember(key, null);
    return this.remember(key, { data: thumbnail.data, contentType: 'image/png' });
  }

  /**
   * Run the decoding one picture at a time, yielding first.
   *
   * It is several hundred milliseconds of straight-line JavaScript, which
   * nothing else can run during. A gallery page asks for twenty at once; doing
   * them concurrently would not be faster — there is one thread — and would
   * hold the event loop for the whole batch, stalling the ComfyUI socket and
   * every other request behind it. One at a time, with a turn of the loop in
   * between, spreads the same work out so the app stays answerable.
   */
  private serialise<T>(task: () => T): Promise<T> {
    const next = this.tail.then(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return task();
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  private remember(key: string, value: DerivedThumbnail | null): DerivedThumbnail | null {
    this.entries.set(key, value);
    this.bytes += value?.data.length ?? 0;

    // Oldest first, which is the map's own order.
    for (const [oldest, held] of this.entries) {
      if (this.bytes <= this.budget) break;
      if (oldest === key) break; // never evict what was just asked for
      this.entries.delete(oldest);
      this.bytes -= held?.data.length ?? 0;
    }

    return value;
  }
}
