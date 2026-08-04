import { Route, Routes, useLocation } from 'react-router-dom';

import { useLiveCacheSync, useStatus } from './api/queries';
import { BottomTabs } from './components/BottomTabs';
import { LiveBar } from './components/LiveBar';
import { cn, Spinner } from './components/ui';
import { BlocksScreen } from './screens/BlocksScreen';
import { ChatScreen } from './screens/ChatScreen';
import { GalleryScreen } from './screens/GalleryScreen';
import { FavoritesScreen } from './screens/FavoritesScreen';
import { GenerateScreen } from './screens/GenerateScreen';
import { LoginScreen } from './screens/LoginScreen';
import { MonitorScreen } from './screens/MonitorScreen';
import { QueueScreen } from './screens/QueueScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SetupScreen } from './screens/SetupScreen';
import { VariationScreen } from './screens/VariationScreen';
import { registerScrollContainer } from './state/scroll';
import { useLiveSocket } from './state/useLiveSocket';

export function App() {
  const status = useStatus();
  const pathname = useLocation().pathname;
  const onGenerate = pathname === '/';
  /*
   * The chat manages its own height and its composer is pinned to the bottom of
   * it, so the progress bar would sit between the two — and the chat is the one
   * screen where every pixel of height is text you are reading.
   */
  const onChat = pathname.startsWith('/chat');
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

  // A server nobody has claimed yet asks for a password to be chosen, rather
  // than showing a login screen with nothing to log in to.
  if (status.data?.setupRequired) {
    return <SetupScreen onDone={() => void status.refetch()} />;
  }

  if (!authenticated) {
    return <LoginScreen onAuthenticated={() => void status.refetch()} />;
  }

  return (
    // 100dvh (not vh) so the layout tracks the collapsing mobile URL bar
    // instead of hiding the tab bar behind it.
    <div className="flex h-[100dvh] flex-col overflow-hidden">
      <main
        ref={registerScrollContainer}
        className={cn(
          'min-h-0 flex-1 overflow-x-clip overscroll-contain',
          // The chat is a fixed-height layout with its own scrolling region;
          // letting the page scroll as well would move the composer off screen.
          onChat ? 'overflow-y-hidden' : 'overflow-y-auto',
        )}
      >
        <Routes>
          <Route path="/" element={<GenerateScreen />} />
          <Route path="/gallery" element={<GalleryScreen />} />
          <Route path="/chat" element={<ChatScreen />} />
          <Route path="/favorites" element={<FavoritesScreen />} />
          <Route path="/blocks" element={<BlocksScreen />} />
          <Route path="/variation" element={<VariationScreen />} />
          <Route path="/monitor" element={<MonitorScreen />} />
          <Route path="/queue" element={<QueueScreen />} />
          <Route path="/settings" element={<SettingsScreen />} />
          <Route path="*" element={<GenerateScreen />} />
        </Routes>
      </main>

      {/*
        Everywhere but Generate, which shows the same bar inline beside its
        button — two rows for progress and Generate is a lot of a phone screen
        for two things you look at together.
      */}
      {!onGenerate && !onChat && <LiveBar />}
      <BottomTabs />
    </div>
  );
}
