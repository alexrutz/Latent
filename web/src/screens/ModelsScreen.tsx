import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addWords,
  formatLoraTag,
  MODEL_FOLDERS,
  parseLoraTags,
  serializeLoraTags,
  resolveWords,
  strengthFor,
  type ModelFolder,
  type ModelNote,
  type ModelSummary,
  type WordSource,
} from '@latent/shared';

import { api, ApiError } from '../api/client';
import { queryKeys, useVisibleWorkflows, useWorkflow } from '../api/queries';
import { NumericInput } from '../components/NumericInput';
import { Button, Card, cn, ErrorNote, Sheet, Spinner } from '../components/ui';
import { useFormDrafts } from '../state/formDraft';

/**
 * The models installed on the ComfyUI machine, and the words each one wants.
 *
 * Not a gallery of cards. A LoRA manager elsewhere is a browser for files you
 * are choosing between; the thing that is actually tedious here is different
 * and smaller — a LoRA does a fraction of what it can without its trigger
 * words, those words live on a web page, and that page is not open on a phone
 * at the moment you are writing a prompt. So this screen is a list of what you
 * have, each row carrying the words it needs, and one button that puts both the
 * LoRA and its words where they belong.
 *
 * Where the words come from is ranked rather than merged — see `resolveWords` —
 * and the row says which source won, because "these are the creator's words"
 * and "these are the tags it was trained on" are different degrees of
 * confidence and you should be able to see which one you are trusting.
 */
export function ModelsScreen() {
  const [folder, setFolder] = useState<ModelFolder>('loras');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ModelSummary | null>(null);

  const models = useQuery({
    queryKey: queryKeys.models(folder),
    queryFn: () => api.listModels(folder),
  });

  const shown = useMemo(() => {
    const all = models.data?.models ?? [];
    const needle = search.trim().toLowerCase();
    if (needle === '') return all;
    return all.filter(
      (model) =>
        model.name.toLowerCase().includes(needle) ||
        (model.title ?? '').toLowerCase().includes(needle) ||
        model.words.some((word) => word.toLowerCase().includes(needle)),
    );
  }, [models.data, search]);

  return (
    <div className="readable safe-t space-y-4 px-4 pt-3 pb-6">
      <div>
        <h1 className="text-xl font-semibold">Models</h1>
        <p className="mt-1 text-xs text-muted">What is installed, and the words each one wants.</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {MODEL_FOLDERS.map((entry) => (
          <button
            key={entry}
            type="button"
            aria-pressed={folder === entry}
            onClick={() => setFolder(entry)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs',
              folder === entry ? 'bg-accent text-white' : 'bg-surface-2 text-muted',
            )}
          >
            {entry === 'loras' ? 'LoRAs' : 'Checkpoints'}
          </button>
        ))}
      </div>

      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search names and words"
        aria-label="Search models"
        className="w-full rounded-xl border border-line bg-surface px-4 py-2.5 text-sm focus:border-accent focus:outline-none"
      />

      {/* Said, not hidden: without comfyllama the names are all there is. */}
      {models.data?.warning && <p className="text-xs text-warn">{models.data.warning}</p>}
      <ErrorNote>{models.error instanceof Error ? models.error.message : null}</ErrorNote>

      {models.isPending ? (
        <div className="grid place-items-center py-12">
          <Spinner className="size-6 text-muted" />
        </div>
      ) : shown.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">
            {search.trim() !== ''
              ? 'Nothing here matches that.'
              : `No ${folder === 'loras' ? 'LoRAs' : 'checkpoints'} on the ComfyUI machine.`}
          </p>
        </Card>
      ) : (
        <ul className="space-y-2" data-testid="model-list">
          {shown.map((model) => (
            <li key={model.name}>
              <ModelRow model={model} onEdit={() => setEditing(model)} />
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ModelSheet
          model={editing}
          folder={folder}
          onClose={() => setEditing(null)}
          /*
           * Re-resolved, not just re-noted. The words a model *uses* are
           * derived from the note, so saving one and carrying the old
           * `words` forward would leave the sheet's own "add to the form"
           * button pasting the words you had just replaced.
           */
          onSaved={(note) => {
            const { words, from } = resolveWords(editing, note);
            setEditing({ ...editing, note, words, wordsFrom: from });
          }}
        />
      )}
    </div>
  );
}

/** Where a row's words came from, in the fewest words that distinguish them. */
const SOURCE_LABEL: Record<WordSource, string> = {
  yours: 'yours',
  civitai: 'from the creator',
  trained: 'trained on',
  none: '',
};

function ModelRow({ model, onEdit }: { model: ModelSummary; onEdit: () => void }) {
  return (
    <Card className="space-y-2" data-model={model.name}>
      <button type="button" onClick={onEdit} className="block w-full text-left">
        <p className="truncate font-medium">{model.title || stripExtension(model.name)}</p>
        <p className="truncate text-[11px] text-muted">
          {model.name}
          {model.baseModel && ` · ${model.baseModel}`}
        </p>
      </button>

      {model.words.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] text-muted">{SOURCE_LABEL[model.wordsFrom]}</p>
          <div className="flex flex-wrap gap-1">
            {model.words.slice(0, 8).map((word) => (
              <span
                key={word}
                className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-body"
              >
                {word}
              </span>
            ))}
            {model.words.length > 8 && (
              <span className="px-1 text-[11px] text-muted">+{model.words.length - 8}</span>
            )}
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-muted">No words known. Open it to add some.</p>
      )}
    </Card>
  );
}

function stripExtension(name: string): string {
  return name.replace(/\.(safetensors|ckpt|pt|pth|bin)$/i, '');
}

/**
 * One model: what is known, what you want to add, and the button that uses it.
 *
 * The lookup and the note are the same sheet on purpose. "Ask Civitai" and
 * "these are the words I actually use" are two answers to one question, and
 * putting them side by side is what makes it obvious that yours wins.
 */
function ModelSheet({
  model,
  folder,
  onClose,
  onSaved,
}: {
  model: ModelSummary;
  folder: ModelFolder;
  onClose: () => void;
  onSaved: (note: ModelNote) => void;
}) {
  const client = useQueryClient();
  const [words, setWords] = useState(model.note?.triggerWords.join(', ') ?? '');
  const [notes, setNotes] = useState(model.note?.notes ?? '');
  const [strength, setStrength] = useState<number>(strengthFor(model.note));
  const [lookupError, setLookupError] = useState<string | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.models(folder) });

  const save = useMutation({
    mutationFn: () =>
      api.saveModelNote(folder, model.name, {
        triggerWords: words
          .split(',')
          .map((word) => word.trim())
          .filter((word) => word !== ''),
        notes,
        strength,
      }),
    onSuccess: async (note) => {
      onSaved(note);
      await refresh();
    },
  });

  const lookup = useMutation({
    mutationFn: () => api.lookupModel(folder, model.name),
    onSuccess: async (note) => {
      setLookupError(null);
      onSaved(note);
      await refresh();
    },
    onError: (cause) =>
      setLookupError(
        cause instanceof ApiError && cause.status === 404
          ? 'Civitai does not have this file. It was probably trained or renamed locally.'
          : cause instanceof Error
            ? cause.message
            : 'The lookup failed.',
      ),
  });

  const civitai = model.note?.civitai ?? null;

  return (
    <Sheet open onClose={onClose} title={model.title || stripExtension(model.name)} full>
      <div className="space-y-4">
        <p className="text-xs break-all text-muted">
          {model.name}
          {model.baseModel && ` · ${model.baseModel}`}
          {model.networkDim && ` · dim ${model.networkDim}`}
        </p>

        {folder === 'loras' && <UseThisLora model={model} onDone={onClose} />}

        <label className="block space-y-1">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">
            Trigger words
          </span>
          <input
            value={words}
            onChange={(event) => setWords(event.target.value)}
            placeholder={model.words.join(', ') || 'comma separated'}
            aria-label="Trigger words"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-sm focus:border-accent focus:outline-none"
          />
          <span className="block text-[11px] text-muted">
            Yours, and they win over everything below. Leave it empty to use whatever is known.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium tracking-wide text-muted uppercase">Notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            placeholder="What weight it likes, what it fights with, when to reach for it."
            aria-label="Notes"
            className="w-full rounded-xl border border-line bg-surface px-4 py-3 text-sm focus:border-accent focus:outline-none"
          />
        </label>

        {folder === 'loras' && (
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm">Strength when added</span>
            <NumericInput
              value={strength}
              onChange={setStrength}
              min={-2}
              max={2}
              step={0.05}
              aria-label="Strength when added"
              className="w-24 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm"
            />
          </label>
        )}

        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>

        {/* ---- What everything else knows ---------------------------- */}

        <div className="space-y-2 border-t border-line pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">Civitai</p>
              <p className="text-[11px] text-muted">
                {civitai
                  ? (civitai.name ?? 'Found') +
                    (civitai.versionName ? ` · ${civitai.versionName}` : '')
                  : 'Hashes the file, then asks what it is. Slow for a checkpoint.'}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              busy={lookup.isPending}
              onClick={() => lookup.mutate()}
            >
              {civitai ? 'Again' : 'Look up'}
            </Button>
          </div>

          <ErrorNote>{lookupError}</ErrorNote>

          {civitai && (
            <div className="space-y-2">
              {civitai.trainedWords.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {civitai.trainedWords.map((word) => (
                    <button
                      key={word}
                      type="button"
                      onClick={() => setWords((current) => joinWord(current, word))}
                      className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-body"
                    >
                      {word} +
                    </button>
                  ))}
                </div>
              )}
              {civitai.description && (
                <p className="text-xs whitespace-pre-wrap text-muted">{civitai.description}</p>
              )}
              {civitai.url && (
                <a
                  href={civitai.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-block text-xs text-accent underline"
                >
                  Open on Civitai
                </a>
              )}
            </div>
          )}
        </div>

        {model.trainedTags.length > 0 && (
          <div className="space-y-1 border-t border-line pt-4">
            <p className="text-sm">What the file says it was trained on</p>
            <p className="text-[11px] text-muted">
              Read out of the file itself. Not the same as trigger words, and usually close.
            </p>
            <div className="mt-1 flex flex-wrap gap-1">
              {model.trainedTags.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() => setWords((current) => joinWord(current, word))}
                  className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-body"
                >
                  {word} +
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

/** Append a word to the comma-separated field, without duplicating it. */
function joinWord(current: string, word: string): string {
  const parts = current
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.some((part) => part.toLowerCase() === word.toLowerCase())) return current;
  return [...parts, word].join(', ');
}

/**
 * The one button this screen exists for.
 *
 * Using a LoRA is two edits in two different fields — the tag into the LoRA
 * field, the trigger words into the prompt — and doing them by hand on a phone
 * is most of the reason people give up and use the LoRA without its words. Both
 * land in the *draft* of the workflow's form, which is where the Generate
 * screen reads from, so switching to it shows the change already made rather
 * than queueing anything.
 */
function UseThisLora({ model, onDone }: { model: ModelSummary; onDone: () => void }) {
  const workflows = useVisibleWorkflows();
  const first = workflows.data?.[0]?.id ?? null;
  const [workflowId, setWorkflowId] = useState<string | null>(first);
  const active = workflowId ?? first;
  const detail = useWorkflow(active);
  const drafts = useFormDrafts();

  const schema = detail.data?.schema;
  const loraField = schema?.fields.find((field) => field.role === 'lora_text');
  const promptField = schema?.fields.find((field) => field.role === 'prompt');

  const use = () => {
    if (!active || !schema || !detail.data) return;

    /*
     * On top of the draft if there is one, on top of what was last submitted if
     * there is not. Starting from the defaults instead would silently throw
     * away whatever was already set up on the Generate screen, which is the
     * opposite of what "add this to the form" should do.
     */
    const current = drafts.drafts[active];
    const values = { ...(current?.values ?? detail.data.lastValues ?? {}) };

    if (loraField) {
      const existing = String(values[loraField.id] ?? '');
      const parsed = parseLoraTags(existing);
      /*
       * The file name, extension and all. That is what ComfyUI's `lora_name`
       * takes and what every tag already in the field carries — stripping it
       * for tidiness would build a tag naming a file that does not exist, and
       * the failure would arrive at submit time rather than here.
       */
      if (!parsed.tags.some((tag) => tag.name === model.name)) {
        const tag = { name: model.name, strength: strengthFor(model.note) };
        values[loraField.id] = serializeLoraTags(existing, [...parsed.tags, tag]);
      }
    }

    if (promptField && model.words.length > 0) {
      values[promptField.id] = addWords(String(values[promptField.id] ?? ''), model.words);
    }

    drafts.set(active, {
      values,
      lockedSeeds: current?.lockedSeeds ?? [],
      batchCount: current?.batchCount ?? 1,
    });
    onDone();
  };

  if (workflows.data && workflows.data.length === 0) {
    return (
      <p className="text-xs text-muted">
        No workflows are switched on, so there is nowhere to put it yet.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
      <p className="text-sm">Use it</p>
      <p className="text-[11px] text-muted">
        Adds <code>{formatLoraTag({ name: model.name, strength: strengthFor(model.note) })}</code>
        {model.words.length > 0 && ' and its words'} to the form, ready to generate.
      </p>

      {(workflows.data?.length ?? 0) > 1 && (
        <select
          value={active ?? ''}
          onChange={(event) => setWorkflowId(event.target.value)}
          aria-label="Workflow"
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        >
          {workflows.data?.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>
      )}

      {detail.data && !loraField && (
        <p className="text-[11px] text-warn">
          That workflow has no LoRA field, so only the words would be added.
        </p>
      )}

      <Button variant="primary" size="sm" disabled={!detail.data} onClick={use}>
        Add to the form
      </Button>
    </div>
  );
}
