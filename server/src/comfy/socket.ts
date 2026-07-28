import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

import {
  BINARY_EVENT_PREVIEW_IMAGE,
  BINARY_IMAGE_TYPE_PNG,
  type ComfyWsMessage,
} from '@latent/shared';

export interface PreviewFrame {
  mimeType: 'image/jpeg' | 'image/png';
  data: Buffer;
}

export interface ComfySocketEvents {
  open: [];
  close: [];
  message: [ComfyWsMessage];
  preview: [PreviewFrame];
  error: [Error];
}

const INITIAL_RETRY_MS = 1_000;
/**
 * Capped low on purpose. While this socket is down the app shows ComfyUI as
 * offline and disables Generate, so a long backoff is directly visible to the
 * user as a dead button. `reconnectNow()` short-circuits it when we have
 * evidence the server is actually back.
 */
const MAX_RETRY_MS = 8_000;

/**
 * The single upstream connection to ComfyUI's `/ws`.
 *
 * One socket for the whole server (not one per browser) is deliberate: every
 * prompt is submitted with this socket's `clientId`, so ComfyUI addresses its
 * execution events here, and we fan them out to whichever phones happen to be
 * connected. A phone that sleeps and reconnects therefore misses nothing.
 */
export class ComfySocket extends EventEmitter<ComfySocketEvents> {
  private socket: WebSocket | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private open = false;

  constructor(
    private readonly wsUrl: string,
    readonly clientId: string,
  ) {
    super();
  }

  get isOpen(): boolean {
    return this.open;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.open = false;
  }

  /**
   * Retry immediately instead of waiting out the backoff.
   *
   * Called when something else proves ComfyUI is reachable — a successful HTTP
   * request, or a phone opening the app. Without this, a ComfyUI restart could
   * leave the UI showing "offline" for the remainder of a backoff window even
   * though every other request was succeeding.
   */
  reconnectNow(): void {
    if (this.stopped || this.open) return;
    // A connection attempt is already in flight; a second would race it.
    if (this.socket) return;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryMs = INITIAL_RETRY_MS;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;

    const url = `${this.wsUrl}/ws?clientId=${encodeURIComponent(this.clientId)}`;
    const socket = new WebSocket(url, { handshakeTimeout: 10_000 });
    socket.binaryType = 'nodebuffer';
    this.socket = socket;

    socket.on('open', () => {
      this.open = true;
      this.retryMs = INITIAL_RETRY_MS;
      this.emit('open');
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = parseBinaryFrame(toBuffer(data));
        if (frame) this.emit('preview', frame);
        return;
      }
      try {
        this.emit('message', JSON.parse(toBuffer(data).toString('utf8')) as ComfyWsMessage);
      } catch {
        // A malformed frame from a custom node shouldn't kill the connection.
      }
    });

    socket.on('error', (error) => {
      this.emit('error', error instanceof Error ? error : new Error(String(error)));
    });

    socket.on('close', () => {
      const wasOpen = this.open;
      this.open = false;
      this.socket = null;
      if (wasOpen) this.emit('close');
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Binary frames are `uint32 eventType` followed by a payload. For a preview
 * image the payload is `uint32 imageType` (1 = JPEG, 2 = PNG) then the bytes.
 */
export function parseBinaryFrame(buffer: Buffer): PreviewFrame | null {
  if (buffer.length < 8) return null;
  const eventType = buffer.readUInt32BE(0);
  if (eventType !== BINARY_EVENT_PREVIEW_IMAGE) return null;

  const imageType = buffer.readUInt32BE(4);
  return {
    mimeType: imageType === BINARY_IMAGE_TYPE_PNG ? 'image/png' : 'image/jpeg',
    data: buffer.subarray(8),
  };
}
