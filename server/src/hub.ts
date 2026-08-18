import type { WebSocket } from 'ws';

import type { ServerEvent } from '@latent/shared';

/**
 * Fan-out to connected browsers.
 *
 * Clients are cheap and stateless here — everything they need to rebuild their
 * UI arrives in the `snapshot` the orchestrator sends on connect, so a phone
 * that drops off and comes back is immediately correct.
 */
export class Hub {
  private readonly clients = new Set<WebSocket>();

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => {
      this.clients.delete(socket);
      socket.terminate();
    });
  }

  remove(socket: WebSocket): void {
    this.clients.delete(socket);
  }

  send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(event));
  }

  broadcast(event: ServerEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(payload);
    }
  }

  /**
   * Relay a preview frame as-is.
   *
   * Skipped when a client is still draining a previous frame: previews arrive
   * many times a second and a slow phone should show the newest one it can
   * decode, not queue up a backlog of stale ones.
   */
  broadcastBinary(data: Buffer): void {
    for (const client of this.clients) {
      if (client.readyState !== client.OPEN) continue;
      if (client.bufferedAmount > data.length * 2) continue;
      client.send(data, { binary: true });
    }
  }

  closeAll(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
  }
}
