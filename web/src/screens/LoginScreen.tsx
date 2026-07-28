import { useState, type FormEvent } from 'react';

import { api } from '../api/client';
import { Button, ErrorNote } from '../components/ui';

export function LoginScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in');
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="safe-t flex h-[100dvh] flex-col items-center justify-center gap-8 px-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Latent</h1>
        <p className="mt-1 text-sm text-muted">A mobile client for your ComfyUI</p>
      </div>

      <form onSubmit={submit} className="w-full max-w-xs space-y-3">
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          className="w-full rounded-2xl border border-line bg-surface px-4 py-3.5 text-center focus:border-accent focus:outline-none"
        />
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!password}>
          Unlock
        </Button>
      </form>
    </div>
  );
}
