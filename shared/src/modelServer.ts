import type { ApiWorkflow } from './comfyTypes.js';
import { isNodeLink } from './paramSchema.js';
import type { ConnectionAuthMode } from './apiTypes.js';
import type { ParamField } from './paramTypes.js';

/**
 * Pointing a workflow's llama-server nodes at the model server Latent is using.
 *
 * The [comfyllama](https://github.com/alexrutz/comfyllama) nodes reach a
 * `llama-server` over HTTP, and its address is a widget on the node — which
 * means it is baked into the workflow JSON. That is fine until the server is a
 * rented box: the address changes every time one is started, and following it
 * means opening every workflow that mentions it and editing the same field
 * again. Latent already knows where the model server is, because the chat is
 * talking to it. This puts that address into those nodes on the way out.
 *
 * Substitution happens at submit time and only in the copy being submitted, so
 * the token never reaches the stored workflow — which is a second reason to do
 * it here rather than by hand, since a widget value lives in the workflow JSON
 * in plain text.
 */

/**
 * Node classes that hold a llama-server endpoint.
 *
 * A list rather than one name because a fork or a renamed build is a normal
 * thing to be running, and because the same idea will hold for the next set of
 * nodes that talks to the same server.
 */
export const LLAMA_SERVER_NODE_CLASSES = ['LlamaServerConnect'];

/** The widget names on such a node that describe *how to reach* the server. */
export const LLAMA_SERVER_INPUTS = ['base_url', 'auth', 'api_key', 'username', 'password'];

/** Where Latent's active model server is, in the shape those widgets want. */
export interface ModelServerTarget {
  url: string;
  authMode: ConnectionAuthMode;
  username: string | null;
  /** Server-side only. Never sent to the browser, never stored in a graph. */
  secret: string | null;
}

/** True when this field is one of those widgets on one of those nodes. */
export function isLlamaServerField(field: ParamField): boolean {
  return (
    LLAMA_SERVER_NODE_CLASSES.includes(field.classType) &&
    LLAMA_SERVER_INPUTS.includes(field.inputName)
  );
}

/**
 * What each widget should hold for this connection.
 *
 * `auth` is spelled the way the node spells it. Latent's `bearer` and `basic`
 * line up one to one; `none` is sent explicitly rather than left at the node's
 * `auto`, because `auto` guesses from whether the other fields are filled and a
 * connection that deliberately has no token should not be guessed about.
 */
function widgetValues(target: ModelServerTarget): Record<string, string> {
  const secret = target.secret ?? '';

  if (target.authMode === 'basic') {
    return {
      base_url: target.url,
      auth: 'basic',
      api_key: '',
      // vast.ai's proxy wants `vastai`, which is what the connection stores.
      username: target.username?.trim() || 'vastai',
      password: secret,
    };
  }

  if (target.authMode === 'bearer') {
    return { base_url: target.url, auth: 'bearer', api_key: secret, username: '', password: '' };
  }

  return { base_url: target.url, auth: 'none', api_key: '', username: '', password: '' };
}

/**
 * Put the active model server into every llama-server node in the graph.
 *
 * Returns the graph unchanged when there is nothing to do, so the caller can
 * use the result unconditionally. Inputs wired from another node are left
 * alone: a link is a deliberate arrangement — somebody is computing the address
 * — and overwriting it with a string would break the graph rather than fix it.
 */
export function applyModelServer(
  workflow: ApiWorkflow,
  target: ModelServerTarget | null,
): ApiWorkflow {
  if (!target || target.url.trim() === '') return workflow;

  const values = widgetValues(target);
  let next: ApiWorkflow | null = null;

  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!LLAMA_SERVER_NODE_CLASSES.includes(node.class_type)) continue;

    for (const [input, value] of Object.entries(values)) {
      const current = node.inputs?.[input];
      /*
       * Written even when the export does not carry the widget.
       *
       * All five are declared by the node, so adding one is accepted; and a
       * credential that is *not* written is a 401 halfway through a graph,
       * which is a worse failure than an input ComfyUI would name outright.
       * A link is the one thing left alone — somebody computing the address is
       * a deliberate arrangement, and a string would break it.
       */
      if (isNodeLink(current)) continue;
      if (current === value) continue;

      next ??= structuredClone(workflow);
      next[nodeId]!.inputs[input] = value;
    }
  }

  return next ?? workflow;
}
