import type {
  MonitorEvent,
  MonitorEventKind,
  MonitorSnapshot,
  ResourceSample,
  SystemStats,
} from '@latent/shared';

import type { ComfyClient } from './comfy/client.js';

/** Roughly two hours at the idle rate, or twenty minutes flat out. */
const MAX_SAMPLES = 600;
const MAX_EVENTS = 400;

/** Fast enough to see a model load, slow enough not to matter. */
const BUSY_INTERVAL_MS = 2_000;
const IDLE_INTERVAL_MS = 20_000;

/**
 * What the box was doing, over time.
 *
 * Two things are being answered here, and they only make sense together: "why
 * did that run take so long" and "what was happening at the time". A VRAM curve
 * with no idea which node was running is a pretty picture; the same curve with
 * "loaded the checkpoint" and "started sampling" marked on it is a diagnosis.
 *
 * Held in memory on purpose. This is the recent past — the window in which you
 * are still asking why something just happened — and writing a row every two
 * seconds to answer that would be a poor trade against an SD card's lifetime.
 */
export class Monitor {
  private readonly samples: ResourceSample[] = [];
  private readonly events: MonitorEvent[] = [];

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private deviceName: string | null = null;
  private sources = { vram: false, ram: false, gpu: false, cpu: false, power: false };
  private utilisationSource: string | null = null;

  /**
   * Whether asking for the power draw is worth the round trip.
   *
   * The route only exists where comfyllama is installed, and only answers where
   * there is an NVIDIA card behind it. Both are facts about the machine rather
   * than about the moment, so one refusal is enough: without this, a ComfyUI
   * without the extension would be asked, and 404, every two seconds forever.
   */
  private powerAvailable = true;

  /**
   * The most recent utilisation reading pushed by an extension.
   *
   * ComfyUI core does not report GPU or CPU load at all. The widely used
   * Crystools extension broadcasts it over the same WebSocket we already hold,
   * so when it is installed these figures appear and when it is not the chart
   * says so rather than drawing a flat line at zero.
   */
  private pushed: {
    at: number;
    gpuPercent: number | null;
    cpuPercent: number | null;
    gpuTempC: number | null;
    ramUsed: number | null;
    ramTotal: number | null;
  } | null = null;

  constructor(
    private readonly client: () => ComfyClient,
    private readonly live: () => {
      busy: boolean;
      queueRemaining: number;
      stepsPerSecond: number | null;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  record(kind: MonitorEventKind, label: string, detail?: string, promptId?: string | null): void {
    this.events.push({ at: Date.now(), kind, label, detail, promptId: promptId ?? null });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /**
   * Absorb a monitoring message from ComfyUI's WebSocket.
   *
   * Returns whether the message was one — the orchestrator hands us everything
   * it does not recognise, which is exactly where extension traffic shows up.
   */
  absorb(type: string, data: unknown): boolean {
    if (!type.includes('monitor') || typeof data !== 'object' || data === null) return false;

    const payload = data as Record<string, unknown>;
    const gpus = Array.isArray(payload.gpus) ? (payload.gpus as Record<string, unknown>[]) : [];
    const gpu = gpus[0];

    const cpu = numberOrNull(payload.cpu_utilization);
    const gpuUse = gpu ? numberOrNull(gpu.gpu_utilization) : null;
    if (cpu === null && gpuUse === null) return false;

    this.pushed = {
      at: Date.now(),
      cpuPercent: cpu,
      gpuPercent: gpuUse,
      gpuTempC: gpu ? numberOrNull(gpu.gpu_temperature) : null,
      // Crystools reports RAM as a fraction plus a total; keep bytes so the two
      // sources cannot disagree about units.
      ramUsed: bytesFrom(payload.ram_used, payload.ram_used_percent, payload.ram_total),
      ramTotal: numberOrNull(payload.ram_total),
    };

    this.sources.cpu ||= cpu !== null;
    this.sources.gpu ||= gpuUse !== null;
    this.utilisationSource ??= type;
    return true;
  }

  snapshot(since?: number): MonitorSnapshot {
    const from = since ?? 0;
    return {
      samples: this.samples.filter((sample) => sample.at > from),
      events: this.events.filter((event) => event.at > from),
      sources: { ...this.sources },
      deviceName: this.deviceName,
      utilisationSource: this.utilisationSource,
    };
  }

  /** Drop everything — a different ComfyUI is a different machine. */
  reset(): void {
    this.samples.length = 0;
    this.events.length = 0;
    this.pushed = null;
    this.deviceName = null;
    this.utilisationSource = null;
    this.sources = { vram: false, ram: false, gpu: false, cpu: false, power: false };
    // A different ComfyUI may well have the extension this one lacked.
    this.powerAvailable = true;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sample().finally(() => {
        this.schedule(this.live().busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS);
      });
    }, delay);
    this.timer.unref?.();
  }

  private async sample(): Promise<void> {
    const live = this.live();
    let stats: SystemStats | null = null;
    try {
      stats = await this.client().systemStats();
    } catch {
      // An unreachable ComfyUI is already reported by the live state; a gap in
      // the chart is the honest way to draw it here.
      return;
    }

    const device = stats.devices?.find((entry) => entry.type !== 'cpu') ?? stats.devices?.[0];
    if (device?.name) this.deviceName = device.name;

    const vramTotal = numberOrNull(device?.vram_total);
    const vramFree = numberOrNull(device?.vram_free);
    const ramTotal = numberOrNull(stats.system?.ram_total);
    const ramFree = numberOrNull(stats.system?.ram_free);

    this.sources.vram ||= vramTotal !== null;
    this.sources.ram ||= ramTotal !== null;

    // Utilisation is only current if it arrived recently — a stale reading
    // drawn as if it were now would be worse than a gap.
    const pushed = this.pushed && Date.now() - this.pushed.at < 30_000 ? this.pushed : null;

    const power = await this.readPower();

    this.samples.push({
      at: Date.now(),
      vramUsed: vramTotal !== null && vramFree !== null ? vramTotal - vramFree : null,
      vramTotal,
      ramUsed:
        pushed?.ramUsed ?? (ramTotal !== null && ramFree !== null ? ramTotal - ramFree : null),
      ramTotal: pushed?.ramTotal ?? ramTotal,
      gpuPercent: pushed?.gpuPercent ?? null,
      cpuPercent: pushed?.cpuPercent ?? null,
      gpuTempC: pushed?.gpuTempC ?? null,
      gpuWatts: power?.watts ?? null,
      gpuWattsLimit: power?.limit ?? null,
      queueRemaining: live.queueRemaining,
      stepsPerSecond: live.stepsPerSecond,
    });

    if (this.samples.length > MAX_SAMPLES) {
      this.samples.splice(0, this.samples.length - MAX_SAMPLES);
    }
  }

  /**
   * The power draw, or nothing, and never a thrown error.
   *
   * The first card only. A second GPU in the box is not what this figure is
   * for — the question is whether the card doing the sampling is working or
   * waiting — and the sample is one row of numbers, not a list.
   */
  private async readPower(): Promise<{ watts: number; limit: number | null } | null> {
    if (!this.powerAvailable) return null;
    try {
      const reading = await this.client().gpuPower();
      const first = reading.gpus?.[0];
      if (!first) {
        // Answered, with nothing to say: no NVIDIA card behind it. Asking again
        // will not change that.
        this.powerAvailable = false;
        return null;
      }
      this.sources.power = true;
      return { watts: first.watts, limit: first.limit ?? null };
    } catch {
      // No comfyllama over there, or too old to have the route.
      this.powerAvailable = false;
      return null;
    }
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Bytes if given, otherwise reconstructed from a percentage of a total. */
function bytesFrom(used: unknown, percent: unknown, total: unknown): number | null {
  const direct = numberOrNull(used);
  if (direct !== null) return direct;
  const share = numberOrNull(percent);
  const whole = numberOrNull(total);
  return share !== null && whole !== null ? (share / 100) * whole : null;
}
