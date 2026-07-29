import { platform } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';

/**
 * A real shell, bridged to the browser.
 *
 * This is remote code execution by design — it exists so the machine running
 * Latent can be maintained from a phone. It is double-gated: the route is only
 * registered when `LATENT_TERMINAL=1`, and it sits behind the same session
 * check as every other API route.
 *
 * `node-pty` is loaded lazily so that a deployment which never enables the
 * terminal does not need the native module to load at all.
 */

interface PtyProcess {
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  readonly pid: number;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string | undefined>;
    },
  ): PtyProcess;
}

let ptyModule: PtyModule | null = null;
let ptyLoadError: string | null = null;

async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule) return ptyModule;
  if (ptyLoadError) return null;
  try {
    // Loaded through a variable specifier deliberately: node-pty is an optional
    // native dependency, and a platform without a prebuilt binary must still be
    // able to build and run everything else. The structural `PtyModule` above
    // supplies the types instead.
    const specifier = 'node-pty';
    ptyModule = (await import(specifier)) as unknown as PtyModule;
    return ptyModule;
  } catch (error) {
    ptyLoadError = error instanceof Error ? error.message : String(error);
    return null;
  }
}

/** Messages the browser sends us. Anything else is treated as keystrokes. */
type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

function defaultShell(): string {
  if (platform() === 'win32') return process.env.COMSPEC ?? 'powershell.exe';
  return process.env.SHELL ?? '/bin/bash';
}

export interface TerminalSession {
  close(): void;
}

/**
 * Attach a PTY to a connected browser socket.
 *
 * One shell per socket, killed when the socket closes — a phone that locks its
 * screen should not leave orphaned shells behind.
 */
export async function attachTerminal(
  socket: WebSocket,
  log: FastifyBaseLogger,
  options: { cwd?: string } = {},
): Promise<TerminalSession | null> {
  const pty = await loadPty();
  if (!pty) {
    socket.send(
      JSON.stringify({
        type: 'error',
        message:
          'The terminal is enabled but node-pty could not be loaded on this machine. ' +
          `Reinstall dependencies to build it. (${ptyLoadError ?? 'unknown error'})`,
      }),
    );
    socket.close();
    return null;
  }

  const shell = defaultShell();
  const child = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: options.cwd ?? process.env.HOME ?? process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  log.warn(`Terminal session opened (pid ${child.pid}, ${shell})`);

  const onData = child.onData((data) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'output', data }));
    }
  });

  const onExit = child.onExit(({ exitCode }) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'exit', code: exitCode }));
      socket.close();
    }
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onData.dispose();
    onExit.dispose();
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    log.warn(`Terminal session closed (pid ${child.pid})`);
  };

  socket.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(raw)) as ClientMessage;
    } catch {
      return;
    }

    if (message.type === 'input' && typeof message.data === 'string') {
      child.write(message.data);
      return;
    }
    if (message.type === 'resize') {
      const cols = Math.max(2, Math.min(500, Math.floor(message.cols)));
      const rows = Math.max(2, Math.min(200, Math.floor(message.rows)));
      if (Number.isFinite(cols) && Number.isFinite(rows)) child.resize(cols, rows);
    }
  });

  socket.on('close', close);
  socket.on('error', close);

  return { close };
}
