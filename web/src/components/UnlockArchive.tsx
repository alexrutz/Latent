import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client';
import { Button, ErrorNote, Sheet } from './ui';

/**
 * Re-entering the password to unseal the archive.
 *
 * The archive key is derived from the password and only ever held in memory, so
 * it does not survive the server restarting. The *session* does — the cookie is
 * an HMAC over the stored password hash, which keeps verifying — and the two
 * together produce the state this exists for: signed in, working normally, and
 * every attempt to import or keep an image answered with "the archive is
 * locked" and nowhere to do anything about it.
 *
 * Deliberately not a full-screen login. Nothing about the session is wrong, and
 * making it look like one would invite signing out to fix something that is not
 * a sign-in problem.
 */
export function UnlockArchiveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const queries = useQueryClient();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.unlockArchive(password);
      setPassword('');
      // Everything that failed while it was shut can succeed now, and the
      // gallery is full of thumbnails that answered 423.
      await queries.invalidateQueries();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not unlock the archive');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Unlock the image archive" closeLabel="Not now">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">
          Your pictures are stored encrypted, and the key is only ever held in memory — so it is
          gone whenever the Latent server restarts. It is the same password you sign in with.
          Until it is entered, importing and keeping images are unavailable.
        </p>

        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          aria-label="Password"
          autoFocus
          className="w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-center focus:border-accent focus:outline-none"
        />

        <ErrorNote>{error}</ErrorNote>

        <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!password}>
          Unlock
        </Button>
      </form>
    </Sheet>
  );
}

/**
 * The line that says so, wherever you happen to be.
 *
 * A locked archive is not an error in the flow you are in — generating works
 * perfectly well — so it is not worth a modal on sight. It *is* worth being
 * visible, because the alternative was finding out only at the moment a keep or
 * an import failed, with nothing to press.
 */
export function ArchiveLockedBar({ onUnlock }: { onUnlock: () => void }) {
  return (
    <button
      type="button"
      onClick={onUnlock}
      className="flex w-full items-center gap-2 bg-warn/15 px-4 py-2 text-left text-xs text-warn active:bg-warn/25"
    >
      <span aria-hidden>🔒</span>
      <span className="min-w-0 flex-1">
        The image archive is locked — importing and keeping are unavailable.
      </span>
      <span className="shrink-0 font-medium underline">Unlock</span>
    </button>
  );
}
