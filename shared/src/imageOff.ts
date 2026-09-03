import type { ApiWorkflow, ObjectInfo } from './comfyTypes.js';
import { isNodeLink } from './paramSchema.js';
import type { ParamField, ParamSchema, ParamValues } from './paramTypes.js';

/**
 * Running the same workflow without its picture.
 *
 * A graph is a fixed set of links. Once a workflow has an image loader wired
 * into it, every run through that graph sends a picture — there is no value you
 * can type into the form that means "not this time", because the loader's
 * filename is a string and every string is a filename. In the editor you would
 * drag the link off; from a phone there was nothing to do at all, so a reference
 * image, once chosen, was permanent.
 *
 * This is the switch. It does not delete anything and it does not touch the
 * loader: it removes the *link* from whatever the loader feeds, on the way to
 * ComfyUI. The consumer then sees an input that is simply not there, which is
 * exactly what it would see if nothing had ever been connected — and the loader,
 * now feeding nothing, is unreachable, so ComfyUI never runs it.
 *
 * Unlinking rather than deleting the node matters. A deleted node leaves every
 * link that pointed at it dangling, and ComfyUI answers that with a validation
 * error about a node id nobody recognises. Removing the input key is what "no
 * image connected" already looks like in an API prompt, so nothing downstream
 * has to be taught anything.
 */

/**
 * The input name of the synthetic switch, appended to a node id.
 *
 * A field id rather than a separate structure, so the switch is an ordinary
 * part of the form: it is stored in a draft, saved in a preset, arranged in the
 * layout editor and hidden if you never want to see it, all without any of
 * those knowing it exists. `__` marks it as one Latent invented — no ComfyUI
 * input is named this, so it cannot collide with a real one.
 */
export const IMAGE_OFF_INPUT = '__image';

/** The field id carrying the switch for one node. */
export function imageOffFieldId(nodeId: string): string {
  return `${nodeId}.${IMAGE_OFF_INPUT}`;
}

/** Whether a field is one of these switches rather than a real node input. */
export function isImageOffField(field: { inputName: string }): boolean {
  return field.inputName === IMAGE_OFF_INPUT;
}

/** The roles whose fields name a picture the workflow loads. */
const PICTURE_ROLES = new Set(['image_input', 'folder_image']);

/**
 * The nodes worth offering a switch for.
 *
 * Only nodes that load a picture, and only when something actually reads it: a
 * loader nothing consumes is already doing nothing, and a switch for it would
 * be a control with no effect.
 */
export function switchableImageNodes(schema: ParamSchema, workflow: ApiWorkflow): string[] {
  const loaders = new Set(
    schema.fields.filter((field) => PICTURE_ROLES.has(field.role)).map((field) => field.nodeId),
  );
  if (loaders.size === 0) return [];

  const consumed = new Set<string>();
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node?.inputs ?? {})) {
      if (isNodeLink(value)) consumed.add(String(value[0]));
    }
  }

  return [...loaders].filter((nodeId) => consumed.has(nodeId)).sort();
}

/** Where a link into a switched-off node was found. */
interface Consumer {
  nodeId: string;
  inputName: string;
  classType: string;
}

function consumersOf(workflow: ApiWorkflow, nodeIds: Set<string>): Consumer[] {
  const found: Consumer[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    for (const [inputName, value] of Object.entries(node?.inputs ?? {})) {
      if (isNodeLink(value) && nodeIds.has(String(value[0]))) {
        found.push({ nodeId, inputName, classType: node.class_type });
      }
    }
  }
  return found;
}

function isRequired(objectInfo: ObjectInfo, classType: string, inputName: string): boolean {
  const required = objectInfo[classType]?.input?.required;
  return Boolean(required && inputName in required);
}

export interface ImageOffResult {
  workflow: ApiWorkflow;
  /**
   * Why it could not be done, if it could not.
   *
   * Checked here rather than left to ComfyUI, which answers a missing required
   * input with a validation error naming the input and not the switch that
   * caused it — true, and no help at all to somebody who just turned something
   * off on a phone.
   */
  error?: string;
}

/**
 * Take the switched-off pictures out of a graph on its way to ComfyUI.
 *
 * `objectInfo` decides whether an input may be left unconnected. Without it —
 * an unknown custom node, say — the link is removed anyway: the alternative is
 * refusing a switch that would probably have worked, and ComfyUI's own error is
 * then the honest one.
 */
export function applyImageOff(
  workflow: ApiWorkflow,
  offNodeIds: Iterable<string>,
  objectInfo: ObjectInfo = {},
): ImageOffResult {
  const off = new Set([...offNodeIds].map(String));
  if (off.size === 0) return { workflow };

  const consumers = consumersOf(workflow, off);
  const blocked = consumers.filter((consumer) =>
    isRequired(objectInfo, consumer.classType, consumer.inputName),
  );

  if (blocked.length > 0) {
    const first = blocked[0]!;
    return {
      workflow,
      error:
        `This workflow cannot run without that picture: ${first.classType} needs ` +
        `'${first.inputName}' and nothing else supplies it. Switch it back on, or ` +
        'use a workflow that treats the picture as optional.',
    };
  }

  const next: ApiWorkflow = structuredClone(workflow);
  for (const consumer of consumers) {
    const node = next[consumer.nodeId];
    if (node?.inputs) delete node.inputs[consumer.inputName];
  }
  return { workflow: next };
}

/**
 * The nodes a set of form values has switched off.
 *
 * Absent means on. A workflow saved before this existed, a preset from last
 * month and a draft mid-edit all have no opinion about it, and the picture they
 * were built around should keep arriving.
 */
export function imageOffNodes(schema: ParamSchema, values: ParamValues): string[] {
  return schema.fields
    .filter((field) => isImageOffField(field) && values[field.id] === false)
    .map((field) => field.nodeId);
}

/** The switch, as a field the rest of the form can treat like any other. */
export function imageOffField(nodeId: string, nodeTitle: string, order: number): ParamField {
  return {
    id: imageOffFieldId(nodeId),
    nodeId,
    inputName: IMAGE_OFF_INPUT,
    classType: '',
    nodeTitle,
    label: 'Use this picture',
    role: 'other',
    control: 'boolean',
    // On, because a workflow with a picture wired in was built to use it.
    defaultValue: true,
    group: 'main',
    order,
    hidden: false,
    unknownNodeType: false,
  };
}
