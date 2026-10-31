import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';

import { App } from './App';
import { apply as applyBlur, useBlur } from './state/blur';
import './index.css';

// Before the first paint, so a blurred app never flashes its pictures.
applyBlur(useBlur.getState().blurred);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The WebSocket is the source of truth for anything live, so polling on
      // window focus would just add redundant traffic on a mobile connection.
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      retry: 1,
    },
  },
});

/*
 * Stop Safari zooming the page.
 *
 * Safari has ignored `user-scalable=no` in the viewport meta since iOS 10, and
 * these Safari-only gesture events are the remaining way to refuse a page pinch.
 * The image viewer is untouched: it implements pinch with pointer events, which
 * these do not intercept.
 */
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

/*
 * The offline copy of the app, and moving off it when a new one is installed.
 *
 * The service worker keeps the app's files so it opens without the network.
 * It used to be registered by a script the build injected, which installs a
 * new version but never reloads the page onto it — so after an update the app
 * on screen stayed the old one until it was closed completely, which on an
 * iPhone home-screen app can be days. Registered here, an activated update
 * reloads the page; and the server is asked for one hourly and whenever the
 * app comes back to the front, not only when it is opened from cold.
 */
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => {
      if (navigator.onLine) void registration.update().catch(() => {});
    };
    setInterval(check, 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
