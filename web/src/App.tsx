import { useEffect, useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { setArchiveLockedHandler } from './api/client';
import { useLiveCacheSync, useSettings, useStatus } from './api/queries';
import { BottomTabs } from './components/BottomTabs';
import { Dock } from './components/Dock';
import { ErrorBoundary } from './components/ErrorBoundary';
import { KeyMap } from './components/KeyMap';
import { LiveBar } from './components/LiveBar';
import { SideRail } from './components/SideRail';
import { PrivacyCover } from './components/PrivacyCover';
import { ArchiveLockedBar, UnlockArchiveDialog } from './components/UnlockArchive';
import { cn, Spinner } from './components/ui';
import { BlocksScreen } from './screens/BlocksScreen';
import { ChatScreen } from './screens/ChatScreen';
import { GalleryScreen } from './screens/GalleryScreen';
import { FavoritesScreen } from './screens/FavoritesScreen';
import { GenerateScreen } from './screens/GenerateScreen';
import { LoginScreen } from './screens/LoginScreen';
import { ModelsScreen } from './screens/ModelsScreen';
import { MonitorScreen } from './screens/MonitorScreen';
import { StudyScreen } from './screens/StudyScreen';
import { QueueScreen } from './screens/QueueScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SupervisorScreen } from './screens/SupervisorScreen';
import { SetupScreen } from './screens/SetupScreen';
import { VariationScreen } from './screens/VariationScreen';
import { useDock } from './state/dock';
import { useRefuseStrayDrops } from './state/dropFiles';
import { useHotkeys } from './state/hotkeys';
import { useDesk, useTablet } from './state/layout';
import { useCovered, usePrivacyCover } from './state/privacy';
import { registerScrollContainer, useDocumentScrollAnchor } from './state/scroll';
import { useLiveSocket } from './state/useLiveSocket';

export function App() {
  const status = useStatus();
  const pathname = useLocation().pathname;
  const tablet = useTablet();
  const desk = useDesk();
  /** Whether the bench is showing what the bar would otherwise say. */
  const dockOpen = useDock((state) => state.open);
  const onGenerate = pathname === '/';
  /*
   * The chat manages its own height and its composer is pinned to the bottom of
   * it, so the progress bar would sit between the two — and the chat is the one
   * screen where every pixel of height is text you are reading.
   */
  const onChat = pathname.startsWith('/chat');
  const authenticated = status.data
    ? !status.data.authRequired || status.data.authenticated
    : false;

  // The keyboard shifts the page up and does not always shift it back.
  useDocumentScrollAnchor();

  /*
   * The keyboard as a way of driving the app, not only of typing into it.
   *
   * Bound whenever there is a session, rather than only at desk width: a
   * tablet with a keyboard attached is a machine with a keyboard, and there is
   * nothing about a narrow window that makes `g l` the wrong way to reach the
   * gallery. What the width decides is layout, which is a different question.
   */
  const { map, closeMap } = useHotkeys(authenticated);

  /*
   * A file dropped anywhere but on a target is refused rather than opened.
   *
   * The browser's default is to navigate to it, so missing an image field by
   * twenty pixels replaces the app with a PNG in a tab and takes the form you
   * had set up with it. See `useRefuseStrayDrops`.
   */
  useRefuseStrayDrops();

  /*
   * The app puts itself away when you stop looking at it.
   *
   * Armed as soon as there is a session, and *before* the settings that govern
   * it have arrived — which is why the fallback here is `true` rather than
   * `false`. The setting is on by default, so assuming it during the moment it
   * takes to fetch is assuming the truth for nearly everybody; assuming the
   * other way would leave the app uncovered for exactly the first second after
   * it is opened, which is a second somebody could spend switching apps. If the
   * setting turns out to be off the hook lowers the cover and stands down, so
   * the cost of guessing wrong is at most one frame nobody was looking at.
   *
   * Not armed at all without a session: a login screen has nothing on it worth
   * covering. See `PrivacySettings`.
   */
  const settings = useSettings(authenticated);
  usePrivacyCover(authenticated && (settings.data?.privacy.cover ?? true));
  const covered = useCovered();

  // Only hold a socket open once we're allowed to use the API.
  useLiveSocket(authenticated);
  useLiveCacheSync();

  /*
   * The archive can be shut while the session is perfectly good — its key is
   * derived from the password and lives only in memory, so a server restart
   * takes it and leaves the cookie working. Anything that answers 423 opens the
   * dialog straight away; the bar below covers noticing it before you try.
   */
  const [unlocking, setUnlocking] = useState(false);
  const archiveLocked = Boolean(status.data?.archiveLocked);
  useEffect(() => {
    setArchiveLockedHandler(() => {
      setUnlocking(true);
      void status.refetch();
    });
    return () => setArchiveLockedHandler(null);
  }, [status]);

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

  /*
   * Everything but the navigation, which is on a different side depending on
   * how much screen there is.
   *
   * One column either way — the archive warning, the screen, the progress bar —
   * so the only thing tablet mode changes about the shell is whether that
   * column sits above a bar or beside a rail.
   */
  const column = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {archiveLocked && <ArchiveLockedBar onUnlock={() => setUnlocking(true)} />}

      <main
        ref={registerScrollContainer}
        className={cn(
          'min-h-0 flex-1 overflow-x-clip overscroll-contain',
          // The chat is a fixed-height layout with its own scrolling region;
          // letting the page scroll as well would move the composer off screen.
          onChat ? 'overflow-y-hidden' : 'overflow-y-auto',
        )}
      >
        {/*
          Inside `<main>`, so the tab bar and the rail stay outside it: a screen
          that fails to draw should cost that screen, not the way out of it.
          Keyed on the path so navigating away clears the wreck rather than
          latching every later screen into the same error.
        */}
        <ErrorBoundary resetKey={pathname}>
          <Routes>
            <Route path="/" element={<GenerateScreen />} />
            <Route path="/gallery" element={<GalleryScreen />} />
            <Route path="/chat" element={<ChatScreen />} />
            <Route path="/favorites" element={<FavoritesScreen />} />
            <Route path="/blocks" element={<BlocksScreen />} />
            <Route path="/variation" element={<VariationScreen />} />
            <Route path="/models" element={<ModelsScreen />} />
            <Route path="/monitor" element={<MonitorScreen />} />
            <Route path="/study" element={<StudyScreen />} />
            <Route path="/queue" element={<QueueScreen />} />
            <Route path="/supervisor" element={<SupervisorScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            <Route path="*" element={<GenerateScreen />} />
          </Routes>
        </ErrorBoundary>
      </main>

      {/*
        Everywhere but Generate, which shows the same bar inline beside its
        button — two rows for progress and Generate is a lot of a phone screen
        for two things you look at together.

        And nowhere at all once the panel is beside it *and open*: the bar is a
        strip across the bottom saying what the panel is already saying in full,
        one column to the right. Shut, the panel says none of it — and the
        collapse is remembered, so without this a run had no progress, no ETA
        and no way to stop it anywhere outside Generate until somebody thought
        to reopen a panel they had put away days ago.
      */}
      {!onGenerate && !onChat && !(desk && dockOpen) && <LiveBar />}
    </div>
  );

  return (
    // 100dvh (not vh) so the layout tracks the collapsing mobile URL bar
    // instead of hiding the tab bar behind it.
    <div className={cn('flex h-[100dvh] overflow-hidden', tablet ? 'flex-row' : 'flex-col')}>
      {/*
        Either way the navigation is in the document where it is on the screen:
        first on a tablet, where it runs down the left, and last on a phone,
        where it sits along the bottom. Keeping the two in step is what makes
        the reading order and the tab order match what you can see.
      */}
      {tablet && <SideRail />}
      {/*
        Everything the cover covers, in one positioned box.

        The cover is "the app, minus the way out of it", and the way out is the
        navigation — the bar along the bottom of a phone, the rail down the side
        of a tablet. Both of those sit outside this box, so an absolutely
        positioned child of it reaches exactly the screen, the progress bar and
        the bench, and stops at the navigation without anything having to
        measure where the navigation is.
      */}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {column}
        {/*
          The third column, and the one that is not a screen. See `Dock`.

          Last in the document as well as on the right, so reading order and tab
          order still run navigation → what you are doing → what the machine is
          doing, which is the order of importance too.
        */}
        {desk && <Dock />}
        {covered && <PrivacyCover />}
      </div>
      {!tablet && <BottomTabs />}

      <UnlockArchiveDialog open={unlocking} onClose={() => setUnlocking(false)} />
      <KeyMap open={map} onClose={closeMap} />
    </div>
  );
}
