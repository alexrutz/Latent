import { useState, type FormEvent } from 'react';

import { api } from '../api/client';
import { Button, ErrorNote } from '../components/ui';

/**
 * First-run claim.
 *
 * The server has no password yet, so whoever gets here first chooses it. That is
 * deliberately a one-shot window: once submitted, this screen can never be
 * reached again on this server.
 */
export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < 6;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= 6 && confirm === password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setError(null);
    try {
      await api.setup(password);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not set the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="safe-t flex min-h-[100dvh] flex-col items-center justify-center gap-6 px-8 py-10">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Latent</h1>
        <p className="mt-1 text-sm text-muted">Choose a password for this server</p>
      </div>

      <form onSubmit={submit} className="w-full max-w-xs space-y-3">
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="New password"
          autoComplete="new-password"
          autoFocus
          className="w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-center focus:border-accent focus:outline-none"
        />
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          placeholder="Repeat it"
          autoComplete="new-password"
          className="w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-center focus:border-accent focus:outline-none"
        />

        {tooShort && <p className="text-center text-xs text-muted">At least 6 characters.</p>}
        {mismatch && <p className="text-center text-xs text-danger">Those do not match.</p>}
        <ErrorNote>{error}</ErrorNote>

        <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!canSubmit}>
          Set password
        </Button>
      </form>

      {/*
        Said plainly rather than buried: until this is submitted, anyone who can
        reach this address can claim the server.
      */}
      <p className="max-w-xs text-center text-xs text-muted">
        Nobody can use this server until a password is set — and until then, anyone who can reach
        this address could set it. Do this now.
      </p>
    </div>
  );
}
