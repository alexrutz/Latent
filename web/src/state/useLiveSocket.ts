import { useEffect, useRef } from 'react';

import type { ServerEvent } from '@latent/shared';

import { useLiveStore } from './live';

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 15_000;

/**
 * Keeps a WebSocket open to the Latent server for the app's lifetime.
 *
 * Mobile browsers kill sockets aggressively when a tab is backgrounded, the
 * screen locks, or the phone changes network. Rather than trying to prevent
 * that, we reconnect eagerly — on close, on regaining visibility, and when the
 * OS reports the network is back. The server answers every new connection with
 * a full snapshot, so a reconnect is indistinguishable from never having
 * dropped.
 */
export function useLiveSocket(enabled: boolean): void {
  const socketRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(INITIAL_RETRY_MS);
  const timerRef = useRef<number | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    closedRef.current = false;
    const { applyEvent, setPreview, setSocketConnected } = useLiveStore.getState();

    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const connect = () => {
      if (closedRef.current) return;
      if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
      socket.binaryType = 'blob';
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = INITIAL_RETRY_MS;
        setSocketConnected(true);
      };

      socket.onmessage = (event) => {
        // Binary frames are sampler previews; everything else is JSON.
        if (event.data instanceof Blob) {
          setPreview(event.data);
          return;
        }
        try {
          applyEvent(JSON.parse(String(event.data)) as ServerEvent);
        } catch {
          // Ignore a frame we can't parse rather than tearing down the socket.
        }
      };

      socket.onclose = () => {
        socketRef.current = null;
        setSocketConnected(false);
        scheduleReconnect();
      };

      socket.onerror = () => socket.close();
    };

    const scheduleReconnect = () => {
      if (closedRef.current || timerRef.current !== null) return;
      const delay = retryRef.current;
      retryRef.current = Math.min(delay * 2, MAX_RETRY_MS);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        connect();
      }, delay);
    };

    /** Don't wait out the backoff when the user is clearly looking at the app. */
    const reconnectNow = () => {
      if (document.visibilityState !== 'visible') return;
      if (socketRef.current?.readyState === WebSocket.OPEN) return;
      clearTimer();
      retryRef.current = INITIAL_RETRY_MS;
      connect();
    };

    connect();
    document.addEventListener('visibilitychange', reconnectNow);
    window.addEventListener('online', reconnectNow);
    window.addEventListener('focus', reconnectNow);

    return () => {
      closedRef.current = true;
      clearTimer();
      document.removeEventListener('visibilitychange', reconnectNow);
      window.removeEventListener('online', reconnectNow);
      window.removeEventListener('focus', reconnectNow);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [enabled]);
}
