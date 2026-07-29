import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

import { cn } from '../components/ui';

/**
 * A shell on the machine running Latent.
 *
 * The soft-key row is not a nicety: a phone keyboard has no Esc, no Tab, no
 * Ctrl and no arrow keys, so without it you cannot exit `less`, complete a path,
 * or interrupt anything — which would make the terminal a read-only curiosity.
 */

const SOFT_KEYS: { label: string; send: string; sticky?: boolean }[] = [
  { label: 'esc', send: '\x1b' },
  { label: 'tab', send: '\t' },
  { label: 'ctrl', send: '', sticky: true },
  { label: '↑', send: '\x1b[A' },
  { label: '↓', send: '\x1b[B' },
  { label: '←', send: '\x1b[D' },
  { label: '→', send: '\x1b[C' },
  { label: '/', send: '/' },
  { label: '-', send: '-' },
  { label: '|', send: '|' },
  { label: '~', send: '~' },
];

export function TerminalScreen({ onClose }: { onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const ctrlRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      convertEol: true,
      theme: {
        background: '#0a0a0f',
        foreground: '#e9e9f2',
        cursor: '#7c5cff',
        selectionBackground: '#7c5cff55',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    terminalRef.current = terminal;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/terminal/ws`);
    socketRef.current = socket;

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };

    socket.onopen = () => {
      setStatus('open');
      sendResize();
      terminal.focus();
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as
          | { type: 'output'; data: string }
          | { type: 'exit'; code: number }
          | { type: 'error'; message: string };

        if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'exit') terminal.write(`\r\n[exited with code ${message.code}]\r\n`);
        else if (message.type === 'error') terminal.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
      } catch {
        // Ignore a frame we can't parse.
      }
    };

    socket.onclose = () => setStatus('closed');
    socket.onerror = () => setStatus('closed');

    const disposeInput = terminal.onData((data) => {
      if (socket.readyState !== WebSocket.OPEN) return;

      // A "sticky" Ctrl: tap ctrl, then a letter, and it becomes the control
      // character — the only way to send Ctrl-C from a touch keyboard.
      let payload = data;
      if (ctrlRef.current) {
        const code = data.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) payload = String.fromCharCode(code - 64);
        ctrlRef.current = false;
        setCtrlArmed(false);
      }
      socket.send(JSON.stringify({ type: 'input', data: payload }));
    });

    const onResize = () => {
      fit.fit();
      sendResize();
    };
    window.addEventListener('resize', onResize);
    // The soft keyboard opening changes the visual viewport, not the window.
    window.visualViewport?.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      disposeInput.dispose();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      socketRef.current = null;
    };
  }, []);

  const send = (key: (typeof SOFT_KEYS)[number]) => {
    if (key.sticky) {
      ctrlRef.current = !ctrlRef.current;
      setCtrlArmed(ctrlRef.current);
      terminalRef.current?.focus();
      return;
    }
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data: key.send }));
    }
    terminalRef.current?.focus();
  };

  return (
    <div className="fixed inset-0 z-60 flex flex-col bg-ink">
      <div className="safe-t flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
        <span className="text-sm font-medium">Terminal</span>
        <span
          className={cn(
            'text-xs',
            status === 'open' ? 'text-success' : status === 'closed' ? 'text-danger' : 'text-muted',
          )}
        >
          {status === 'open' ? 'connected' : status}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-3 py-1.5 text-sm text-muted active:bg-surface-2"
        >
          Close
        </button>
      </div>

      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-1 py-1" />

      <div className="no-scrollbar safe-b flex shrink-0 gap-1.5 overflow-x-auto border-t border-line px-2 py-2">
        {SOFT_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            onClick={() => send(key)}
            className={cn(
              'h-10 min-w-11 shrink-0 rounded-lg px-3 font-mono text-sm',
              key.sticky && ctrlArmed ? 'bg-accent text-white' : 'bg-surface-2 text-body',
            )}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
