import { Route, Routes } from 'react-router-dom';

import { useLiveCacheSync, useStatus } from './api/queries';
import { BottomTabs } from './components/BottomTabs';
import { LiveBar } from './components/LiveBar';
import { Spinner } from './components/ui';
import { GalleryScreen } from './screens/GalleryScreen';
import { GenerateScreen } from './screens/GenerateScreen';
import { LoginScreen } from './screens/LoginScreen';
import { QueueScreen } from './screens/QueueScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { useLiveSocket } from './state/useLiveSocket';

export function App() {
  const status = useStatus();
  const authenticated = status.data ? !status.data.authRequired || status.data.authenticated : false;

  // Only hold a socket open once we're allowed to use the API.
  useLiveSocket(authenticated);
  useLiveCacheSync();

  if (status.isLoading) {
    return (
      <div className="grid h-[100dvh] place-items-center">
        <Spinner className="size-8 text-muted" />
      </div>
    );
  }

  if (!authenticated) {
    return <LoginScreen onAuthenticated={() => void status.refetch()} />;
  }

  return (
    // 100dvh (not vh) so the layout tracks the collapsing mobile URL bar
    // instead of hiding the tab bar behind it.
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <Routes>
          <Route path="/" element={<GenerateScreen />} />
          <Route path="/gallery" element={<GalleryScreen />} />
          <Route path="/queue" element={<QueueScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<GenerateScreen />} />
        </Routes>
      </main>

      <LiveBar />
      <BottomTabs />
    </div>
  );
}
