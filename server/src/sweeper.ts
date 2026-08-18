import type { FastifyBaseLogger } from 'fastify';

import type { Archive } from './archive.js';
import type { Store } from './db.js';

/** Checked often enough to be timely, rarely enough to be invisible. */
const INTERVAL_MS = 10 * 60_000;

/**
 * Deletes generations nobody chose to keep, once they are old enough.
 *
 * Generating is cheap and most of what comes out is a near-miss. Without this
 * the gallery becomes thousands of pictures you scrolled past once, which makes
 * the handful worth having *harder* to find — the opposite of what a gallery is
 * for.
 *
 * A star or a keep on any image in a run protects the whole run, and so does a
 * favourite. Deleting three of four from a batch because only one was rated
 * would throw away the comparison that made the rating mean something.
 *
 * Off unless a period is set, and it only ever touches things this app
 * generated: an imported folder is somebody's existing library, not our
 * scratch space.
 */
export class Sweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly archive: Archive,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.run(), INTERVAL_MS);
    this.timer.unref?.();
    // One pass at boot, so a server that was off all night catches up.
    this.run();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns how many runs were removed. */
  run(): number {
    const hours = this.store.getSettings().autoDeleteHours;
    if (!hours || hours <= 0) return 0;

    const stale = this.store.listSweepable(hours * 3_600_000);
    for (const record of stale) {
      for (const image of record.images) {
        const row = this.store.findImage(image);
        // Nothing here was rated or kept, so nothing here should be archived —
        // but a thumbnail may exist, and it should go with the row.
        if (row) void this.archive.forget(row.id, row);
      }
      this.store.deleteGeneration(record.id);
    }

    if (stale.length > 0) {
      this.log.info(`Swept ${stale.length} unkept generation(s) older than ${hours}h`);
    }
    return stale.length;
  }
}
