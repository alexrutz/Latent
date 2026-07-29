import type { ConnectionAuthMode } from '@latent/shared';

/**
 * Everything needed to reach one ComfyUI endpoint.
 *
 * Shared by the REST client and the WebSocket, so both authenticate identically
 * — which matters because a browser `WebSocket` cannot set an `Authorization`
 * header at all. Only a server-side socket can, and that is precisely why Latent
 * proxies rather than letting the phone connect directly.
 */
export interface ConnectionConfig {
  id: string;
  name: string;
  url: string;
  authMode: ConnectionAuthMode;
  username: string | null;
  secret: string | null;
  allowSelfSigned: boolean;
}

/**
 * The auth header for a connection, if any.
 *
 * vast.ai's proxy accepts either form:
 *   - `Authorization: Bearer <token>`
 *   - Basic auth as `vastai:<token>`
 * where the token is the instance's auto-generated `OPEN_BUTTON_TOKEN`, or
 * whatever `WEB_PASSWORD` was set to at launch — setting it replaces the
 * generated one, which is the only way to know the token in advance.
 */
export function authHeaders(config: ConnectionConfig): Record<string, string> {
  if (!config.secret) return {};

  switch (config.authMode) {
    case 'bearer':
      return { authorization: `Bearer ${config.secret}` };
    case 'basic': {
      const username = config.username?.trim() || 'vastai';
      const encoded = Buffer.from(`${username}:${config.secret}`).toString('base64');
      return { authorization: `Basic ${encoded}` };
    }
    case 'none':
    default:
      return {};
  }
}

/** `http://host:8188` -> `ws://host:8188`, preserving TLS. */
export function toWebSocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

export function isHttps(url: string): boolean {
  return url.startsWith('https:');
}

/** A local, unauthenticated connection — the shape v1 always assumed. */
export function plainConnection(url: string, id = 'default', name = 'Default'): ConnectionConfig {
  return {
    id,
    name,
    url: url.replace(/\/+$/, ''),
    authMode: 'none',
    username: null,
    secret: null,
    allowSelfSigned: false,
  };
}
