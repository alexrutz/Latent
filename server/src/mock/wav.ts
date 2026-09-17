/**
 * A short, real WAV file, for the mock ComfyUI to hand back.
 *
 * Real rather than plausible: a browser has to be able to play it, because the
 * end-to-end tests assert on an `<audio>` element that reports a duration —
 * which it only does once something has actually decoded the header. Random
 * bytes with a RIFF label in front would pass every server-side check and fail
 * the one that matters.
 *
 * 8 kHz, mono, 8-bit PCM: the smallest thing every browser plays, and a second
 * of it is eight kilobytes rather than the third of a megabyte CD-quality
 * stereo would cost for the same second.
 */

const SAMPLE_RATE = 8_000;

/** A tone whose pitch comes from the seed, so two runs are two files. */
export function renderPlaceholderWav(seed: string, seconds = 1): Buffer {
  const samples = Math.max(1, Math.round(SAMPLE_RATE * Math.min(seconds, 30)));
  const data = Buffer.alloc(samples);

  // 220–660 Hz from the seed: content-addressed storage is only exercised if
  // two different runs really do produce two different files.
  const hash = [...seed].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
  const frequency = 220 + (hash % 440);

  for (let index = 0; index < samples; index += 1) {
    const angle = (2 * Math.PI * frequency * index) / SAMPLE_RATE;
    // Unsigned 8-bit PCM: silence is 128, not 0.
    data[index] = Math.round(128 + 100 * Math.sin(angle));
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM header length
  header.writeUInt16LE(1, 20); // format: PCM
  header.writeUInt16LE(1, 22); // channels
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE, 28); // byte rate: rate × channels × bytes
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}
