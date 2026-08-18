import { useState } from 'react';

import type {
  ConnectionAuthMode,
  ConnectionInput,
  ConnectionKind,
  ConnectionSummary,
  ConnectionTestResult,
} from '@latent/shared';

import { api } from '../api/client';
import {
  useActivateConnection,
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useUpdateConnection,
} from '../api/queries';
import { Toggle } from '../components/ParamControl';
import { Button, Card, cn, ErrorNote, Sheet } from '../components/ui';

/**
 * Every server Latent talks to, in one list.
 *
 * ComfyUI and the model server used to live in different places — one a screen
 * of presets, the other an address buried in the chat settings — which made no
 * sense the moment both were on rented boxes. It is the same problem twice: an
 * address that changes every time you rent one, a token, usually a certificate
 * nobody signed. One list, one dialog, and one of each kind in use at a time.
 */

const KINDS: { value: ConnectionKind; label: string; blurb: string; placeholder: string }[] = [
  {
    value: 'comfy',
    label: 'ComfyUI',
    blurb: 'Where the pictures are made.',
    placeholder: 'https://12.34.56.78:8188',
  },
  {
    value: 'llama',
    label: 'Model server',
    blurb:
      'What the chat talks to. Anything offering llama.cpp’s OpenAI-compatible routes works; ' +
      'the tools need a model that can call them, and images need a multimodal one.',
    placeholder: 'http://127.0.0.1:8080',
  },
];

export function ConnectionsScreen() {
  const connections = useConnections();
  const activate = useActivateConnection();
  const remove = useDeleteConnection();
  const [editing, setEditing] = useState<ConnectionSummary | ConnectionKind | null>(null);

  const all = connections.data ?? [];

  return (
    <section className="space-y-2">
      <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Connections</h2>

      <ErrorNote>{errorText(activate.error) ?? errorText(remove.error)}</ErrorNote>

      {/*
        Grouped by kind and stacked, rather than two sections apart. The two are
        set up together — you rent one box and reach both from it — and reading
        down one list is how you check that both are actually connected.
      */}
      {KINDS.map((kind) => {
        const mine = all.filter((connection) => connection.kind === kind.value);
        return (
          <div key={kind.value} className="space-y-2">
            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="min-w-0 text-xs text-muted">
                <span className="text-body">{kind.label}</span> · {kind.blurb}
              </p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditing(kind.value)}
                aria-label={`Add a ${kind.label} connection`}
              >
                Add
              </Button>
            </div>

            {mine.length === 0 && (
              <Card>
                <p className="text-sm text-muted">Nothing added yet.</p>
              </Card>
            )}

            {mine.map((connection) => (
              <Card key={connection.id} className={cn(connection.isActive && 'border-accent/50')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate font-medium">
                      {connection.name}
                      {connection.isActive && (
                        <span className="shrink-0 rounded-full bg-accent/20 px-2 py-0.5 text-[10px] text-accent">
                          in use
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-muted">{connection.url}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      {connection.authMode === 'none' ? 'No auth' : `${connection.authMode} token`}
                      {connection.allowSelfSigned && ' · self-signed OK'}
                    </p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {!connection.isActive && (
                    <Button
                      variant="primary"
                      size="sm"
                      busy={activate.isPending}
                      onClick={() => activate.mutate(connection.id)}
                    >
                      Use this
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => setEditing(connection)}>
                    Edit
                  </Button>
                  {/* ComfyUI's cannot be deleted while it is the one in use —
                      the app holds a socket to it. A model server can: it is
                      asked for per request, and a box you have stopped renting
                      should not be undeletable. */}
                  {(!connection.isActive || connection.kind === 'llama') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      busy={remove.isPending}
                      onClick={() => remove.mutate(connection.id)}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        );
      })}

      {editing && (
        <ConnectionSheet
          connection={typeof editing === 'string' ? null : editing}
          kind={typeof editing === 'string' ? editing : editing.kind}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function errorText(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

const AUTH_MODES: { value: ConnectionAuthMode; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'A server with no proxy in front of it.' },
  {
    value: 'bearer',
    label: 'Token',
    hint: 'Sent as “Authorization: Bearer …”. This is what vast.ai expects.',
  },
  {
    value: 'basic',
    label: 'Basic',
    hint: 'Username and password. vast.ai accepts this too, as vastai:<token>.',
  },
];

/**
 * One dialog for both kinds.
 *
 * The kind is a choice at the top rather than two forms, because everything
 * below it is identical — and because "this address is a model server, not a
 * ComfyUI" is exactly the sort of thing you want to be able to correct without
 * deleting and retyping the rest.
 */
function ConnectionSheet({
  connection,
  kind: initialKind,
  onClose,
}: {
  connection: ConnectionSummary | null;
  kind: ConnectionKind;
  onClose: () => void;
}) {
  const create = useCreateConnection();
  const update = useUpdateConnection();

  const [kind, setKind] = useState<ConnectionKind>(connection?.kind ?? initialKind);
  const [name, setName] = useState(connection?.name ?? '');
  const [url, setUrl] = useState(connection?.url ?? '');
  const [authMode, setAuthMode] = useState<ConnectionAuthMode>(connection?.authMode ?? 'bearer');
  const [username, setUsername] = useState(connection?.username ?? 'vastai');
  const [secret, setSecret] = useState('');
  const [allowSelfSigned, setAllowSelfSigned] = useState(connection?.allowSelfSigned ?? false);

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = KINDS.find((entry) => entry.value === kind)!;

  const payload = (): ConnectionInput => ({
    kind,
    name: name.trim(),
    url: url.trim(),
    authMode,
    username: authMode === 'basic' ? username.trim() : null,
    // Blank means "keep what's stored" when editing, and "no secret" when new.
    ...(secret ? { secret } : connection ? {} : { secret: null }),
    allowSelfSigned,
  });

  const test = async () => {
    setTesting(true);
    setResult(null);
    setError(null);
    try {
      // Testing a saved connection with a blank secret must use the stored one.
      const outcome =
        connection && !secret
          ? await api.testConnection({ ...payload(), secret: undefined })
          : await api.testConnection(payload());
      setResult(outcome);
      // A self-signed rejection has exactly one fix; offer it rather than
      // making the user work out what the message means.
      if (outcome.outcome === 'self_signed') setAllowSelfSigned(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not test that connection');
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(null);
    try {
      if (connection) await update.mutateAsync({ id: connection.id, patch: payload() });
      else await create.mutateAsync(payload());
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that connection');
    }
  };

  const canSave = name.trim() !== '' && url.trim() !== '';

  return (
    <Sheet open onClose={onClose} title={connection ? 'Edit connection' : 'Add connection'} full>
      <div className="space-y-4">
        <Field label="What is at this address" hint={chosen.blurb} group>
          <div className="flex gap-2">
            {KINDS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-pressed={kind === entry.value}
                onClick={() => {
                  setKind(entry.value);
                  setResult(null);
                }}
                className={cn(
                  'flex-1 rounded-xl border px-3 py-2.5 text-sm',
                  kind === entry.value
                    ? 'border-accent/50 bg-accent/15 text-accent'
                    : 'border-line bg-surface text-muted',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Rented GPU"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
        </Field>

        <Field
          label="Address"
          hint={
            kind === 'comfy'
              ? 'On vast.ai this is the host and port the instance portal shows for ComfyUI.'
              : 'Where `llama-server` is listening. Its OpenAI-compatible routes hang off this.'
          }
        >
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={chosen.placeholder}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
          />
        </Field>

        <Field label="Authentication" group>
          <div className="flex gap-2">
            {AUTH_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => setAuthMode(mode.value)}
                className={cn(
                  'flex-1 rounded-xl border px-3 py-2.5 text-sm',
                  authMode === mode.value
                    ? 'border-accent/50 bg-accent/15 text-accent'
                    : 'border-line bg-surface text-muted',
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-muted">
            {AUTH_MODES.find((mode) => mode.value === authMode)?.hint}
          </p>
        </Field>

        {authMode === 'basic' && (
          <Field label="Username">
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoCapitalize="none"
              className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
            />
          </Field>
        )}

        {authMode !== 'none' && (
          <Field
            label="Token"
            hint={
              connection?.hasSecret
                ? 'A token is stored. Leave blank to keep it.'
                : 'On vast.ai this is the WEB_PASSWORD you set when renting the instance. If you did not set one, it is the auto-generated OPEN_BUTTON_TOKEN, readable only over SSH.'
            }
          >
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={connection?.hasSecret ? '••••••••' : 'WEB_PASSWORD'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full rounded-xl border border-line bg-surface px-4 py-3 focus:border-accent focus:outline-none"
            />
          </Field>
        )}

        <div className="flex items-start justify-between gap-4 rounded-xl border border-line bg-surface px-3 py-3">
          <div className="min-w-0">
            <p className="text-sm">Allow self-signed certificate</p>
            <p className="mt-0.5 text-xs text-muted">
              Needed for vast.ai instances started with ENABLE_HTTPS. Only turn this on for a
              server you trust — it stops Latent verifying who it is talking to.
            </p>
          </div>
          <Toggle checked={allowSelfSigned} onChange={setAllowSelfSigned} />
        </div>

        {result && (
          <p
            className={cn(
              'rounded-xl border px-3 py-2 text-sm',
              result.outcome === 'ok'
                ? 'border-success/30 bg-success/10 text-success'
                : 'border-warn/30 bg-warn/10 text-warn',
            )}
          >
            {result.message}
          </p>
        )}
        <ErrorNote>{error}</ErrorNote>

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" busy={testing} onClick={test} disabled={!canSave}>
            Test
          </Button>
          <Button
            variant="primary"
            className="flex-1"
            busy={create.isPending || update.isPending}
            disabled={!canSave}
            onClick={save}
          >
            Save
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * A labelled row.
 *
 * `group` for a row of buttons rather than one input: a `<label>` wrapping
 * three buttons hands its own text to every one of them, so each button ends up
 * announcing itself as "Authentication None Token Basic" — the label belongs to
 * the group, not to any of its members.
 */
function Field({
  label,
  hint,
  group = false,
  children,
}: {
  label: string;
  hint?: string;
  group?: boolean;
  children: React.ReactNode;
}) {
  const Tag = group ? 'div' : 'label';
  return (
    <Tag className="block" {...(group ? { role: 'group', 'aria-label': label } : {})}>
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </Tag>
  );
}
