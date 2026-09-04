import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  addWords,
  formatLoraTag,
  MODEL_FOLDERS,
  MODEL_FOLDER_LABELS,
  parseLoraTags,
  serializeLoraTags,
  resolveWords,
  strengthFor,
  type ModelFolder,
  type ModelNote,
  type ModelSummary,
  type WordSource,
} from '@latent/shared';

import { api, ApiError, modelExampleUrl } from '../api/client';
import { queryKeys, useVisibleWorkflows, useWorkflow } from '../api/queries';
import { NumericInput } from '../components/NumericInput';
import { Button, Card, cn, ErrorNote, Sheet, Spinner } from '../components/ui';
import { useBlur } from '../state/blur';
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
            {MODEL_FOLDER_LABELS[entry]}
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

      {models.data && models.data.models.length > 0 && (
        <LookupAll folder={folder} models={models.data.models} />
      )}

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
              : `Nothing in ${MODEL_FOLDER_LABELS[folder].toLowerCase()} on the ComfyUI machine.`}
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

/**
 * One model in the list, over the picture the creator chose to show it with.
 *
 * The image is the fastest answer to "which one is this" that exists — faster
 * than the name, which is whatever the file was called when it was downloaded.
 * It sits *behind* the row rather than beside it because a thumbnail column
 * costs width a phone does not have, and because what is wanted is recognition
 * rather than inspection.
 *
 * The scrim over it is not decoration: the text has to stay readable over an
 * image nobody has seen, which may be white, busy, or both. A fixed dark
 * gradient is the only version of this that cannot fail.
 */
function ModelRow({ model, onEdit }: { model: ModelSummary; onEdit: () => void }) {
  const example = model.note?.civitai?.examples?.[0] ?? null;
  const blurred = useBlur((state) => state.blurred);

  return (
    <Card className="relative overflow-hidden" data-model={model.name}>
      {example && (
        <>
          <img
            src={modelExampleUrl(example.url)}
            alt=""
            aria-hidden
            loading="lazy"
            className={cn(
              'pointer-events-none absolute inset-0 size-full object-cover opacity-40',
              // The app-wide blur applies here too: these are strangers'
              // pictures, and the setting means "not on this screen either".
              blurred && 'blur-xl',
            )}
            onError={(event) => {
              // No internet, a dead CDN link, an image that will not decode:
              // the row is still a row. Losing the picture must not lose it.
              event.currentTarget.style.display = 'none';
            }}
          />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-gradient-to-r from-surface via-surface/90 to-surface/60"
          />
        </>
      )}

      <div className="relative space-y-2">
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
                  className="rounded-md bg-surface-2/80 px-2 py-0.5 text-[11px] text-body"
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
      </div>
    </Card>
  );
}

/**
 * Look up everything that has not been looked up.
 *
 * One at a time, on the client, with the count on screen. It could have been a
 * single request the server loops inside, and that would have been worse: each
 * model means hashing a file — tens of seconds for a checkpoint — so a folder
 * of forty is long enough to time out a request, and long enough that watching
 * it stop at 12 of 40 is information you want rather than a spinner.
 *
 * Sequential, not parallel, because the far end rate-limits and because the
 * hashing is disk-bound on one machine: eight at once would be eight times the
 * seeking for the same total throughput.
 */
function LookupAll({ folder, models }: { folder: ModelFolder; models: ModelSummary[] }) {
  const client = useQueryClient();
  const [state, setState] = useState<{
    running: boolean;
    done: number;
    total: number;
    found: number;
    failed: number;
  } | null>(null);
  const stop = useRef(false);

  const pending = models.filter((model) => !model.note?.civitai);

  const run = async () => {
    stop.current = false;
    const queue = [...pending];
    setState({ running: true, done: 0, total: queue.length, found: 0, failed: 0 });

    let found = 0;
    let failed = 0;
    for (const [index, model] of queue.entries()) {
      if (stop.current) break;
      try {
        await api.lookupModel(folder, model.name);
        found += 1;
      } catch {
        // A model Civitai has never seen is the normal outcome for anything
        // trained at home. Counted, not announced, and never a reason to stop
        // the other thirty-nine.
        failed += 1;
      }
      setState({ running: true, done: index + 1, total: queue.length, found, failed });
    }

    setState((current) => (current ? { ...current, running: false } : null));
    await client.invalidateQueries({ queryKey: queryKeys.models(folder) });
  };

  if (pending.length === 0 && !state) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-3 py-2">
      <p className="min-w-0 text-[11px] text-muted">
        {state
          ? `${state.done} of ${state.total} · ${state.found} found${state.failed ? `, ${state.failed} not on Civitai` : ''}`
          : `${pending.length} not looked up yet.`}
      </p>
      {state?.running ? (
        <Button variant="ghost" size="sm" onClick={() => (stop.current = true)}>
          Stop
        </Button>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={pending.length === 0}
          onClick={() => void run()}
        >
          Look up all
        </Button>
      )}
    </div>
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
  const civitai = model.note?.civitai ?? null;

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
      await client.invalidateQueries({ queryKey: queryKeys.models(folder) });
    },
  });

  const forget = useMutation({
    mutationFn: () => api.forgetModelNote(folder, model.name),
    onSuccess: async () => {
      setWords('');
      setNotes('');
      setStrength(strengthFor(null));
      await client.invalidateQueries({ queryKey: queryKeys.models(folder) });
      onClose();
    },
  });

  return (
    <Sheet open onClose={onClose} title={model.title || stripExtension(model.name)} full>
      <div className="space-y-4">
        <p className="text-xs break-all text-muted">
          {model.name}
          {model.baseModel && ` · ${model.baseModel}`}
          {model.networkDim && ` · dim ${model.networkDim}`}
          {civitai?.creator && ` · by ${civitai.creator}`}
        </p>

        {/*
          What was gathered, before anything that can be typed.

          This module is a source of information first and an editor second: the
          question somebody opens a model to answer is "what is this and what
          can it do", and the creator's own pictures and prose answer it. The
          fields for your own words come after, because they are what you write
          once you have read this.
        */}
        <Gathered model={model} folder={folder} onLookedUp={onSaved} />

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

        <div className="flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            busy={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
          {/*
            Its own verb, not a blanked field. A lookup that matched the wrong
            thing, or a description from a version since replaced, cannot be
            emptied by clearing a text box — the gathered half is not typed.
          */}
          {model.note && (
            <Button variant="ghost" busy={forget.isPending} onClick={() => forget.mutate()}>
              Forget
            </Button>
          )}
        </div>

        {/*
          The words offered rather than pasted.
          ------------------------------------------------------------------
          Everything Civitai and the file itself know is *above*, under
          `Gathered`. What is left here is the pair of word lists, kept next to
          the field they fill: tapping one adds it to your own words, which is
          the only way this screen writes anything into the box for you.
        */}
        {(civitai?.trainedWords.length ?? 0) > 0 && (
          <div className="space-y-1 border-t border-line pt-4">
            <p className="text-sm">The creator's trigger words</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {civitai?.trainedWords.map((word) => (
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

/**
 * Everything gathered about a model, above everything that can be typed.
 *
 * The screen is a source of information first. What a model *is* — the
 * creator's explanation, the pictures they chose to show it with, the prompts
 * behind those pictures — is the reason to open it, and it belongs at the top;
 * the fields for your own words are what you fill in afterwards.
 *
 * The lookup button lives here rather than at the bottom because this is the
 * section it fills. Before it has run there is nothing in this space but the
 * button and a sentence saying what it costs.
 */
function Gathered({
  model,
  folder,
  onLookedUp,
}: {
  model: ModelSummary;
  folder: ModelFolder;
  onLookedUp: (note: ModelNote) => void;
}) {
  const client = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const blurred = useBlur((state) => state.blurred);
  const [openExample, setOpenExample] = useState<number | null>(null);

  const civitai = model.note?.civitai ?? null;

  const lookup = useMutation({
    mutationFn: () => api.lookupModel(folder, model.name),
    onSuccess: async (note) => {
      setError(null);
      onLookedUp(note);
      await client.invalidateQueries({ queryKey: queryKeys.models(folder) });
    },
    onError: (cause) =>
      setError(
        cause instanceof ApiError && cause.status === 404
          ? 'Civitai does not have this file. It was probably trained or renamed locally.'
          : cause instanceof Error
            ? cause.message
            : 'The lookup failed.',
      ),
  });

  const examples = civitai?.examples ?? [];
  const shown = openExample === null ? null : (examples[openExample] ?? null);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            {civitai ? (civitai.name ?? 'On Civitai') : 'Nothing gathered yet'}
          </p>
          <p className="text-[11px] text-muted">
            {civitai
              ? [civitai.type, civitai.versionName, civitai.baseModel].filter(Boolean).join(' · ')
              : 'Hashes the file, then asks Civitai. Slow for a checkpoint.'}
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

      <ErrorNote>{error}</ErrorNote>

      {/*
        The pictures, in a row that scrolls sideways.
        A grid would push everything else off the screen, and these are here to
        say "this is what it does" at a glance rather than to be studied — one
        tap opens the one you want, with the prompt that made it.
      */}
      {examples.length > 0 && (
        <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1">
          {examples.map((example, index) => (
            <button
              key={example.url}
              type="button"
              onClick={() => setOpenExample(index)}
              aria-label={`Example ${index + 1}`}
              className="h-28 w-20 shrink-0 snap-start overflow-hidden rounded-lg border border-line bg-surface-2"
            >
              <img
                src={modelExampleUrl(example.url)}
                alt=""
                loading="lazy"
                className={cn('size-full object-cover', blurred && 'blur-lg')}
                onError={(event) => {
                  event.currentTarget.style.visibility = 'hidden';
                }}
              />
            </button>
          ))}
        </div>
      )}

      {/*
        The creator's own explanation. This is the paragraph the whole second
        request exists for — what the model is for, what weight it likes, what
        it fights with — and it is a different field from the version notes
        below it, which are usually a changelog.
      */}
      {civitai?.modelDescription && (
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-body">
          {civitai.modelDescription}
        </p>
      )}

      {civitai?.description && (
        <div className="space-y-0.5">
          <p className="text-[11px] tracking-wide text-muted uppercase">This version</p>
          <p className="text-xs whitespace-pre-wrap text-muted">{civitai.description}</p>
        </div>
      )}

      {(civitai?.tags.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1">
          {civitai?.tags.map((tag) => (
            <span key={tag} className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
              {tag}
            </span>
          ))}
        </div>
      )}

      {civitai?.url && (
        <a
          href={civitai.url}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-block text-xs text-accent underline"
        >
          Open on Civitai
        </a>
      )}

      {shown && (
        <Sheet open onClose={() => setOpenExample(null)} title="Example" closeLabel="Close">
          <div className="space-y-3">
            <img
              src={modelExampleUrl(shown.url)}
              alt=""
              className={cn('w-full rounded-xl', blurred && 'blur-2xl')}
            />
            {shown.prompt ? (
              <div className="space-y-1">
                <p className="text-[11px] tracking-wide text-muted uppercase">The prompt</p>
                <p className="text-xs whitespace-pre-wrap text-body">{shown.prompt}</p>
              </div>
            ) : (
              <p className="text-xs text-muted">The creator left no prompt on this one.</p>
            )}
          </div>
        </Sheet>
      )}
    </div>
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
