import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App';
import './index.css';

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
