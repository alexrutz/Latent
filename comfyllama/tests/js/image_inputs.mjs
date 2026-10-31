import assert from 'node:assert/strict';
import { anyImageLinked, fitImageInputs, growsImages, imageNumber, MAX_IMAGES } from '../../web/js/imageInputs.js';

/** Just enough of a LiteGraph node: sockets that can be added and removed. */
function makeNode(names) {
  return {
    inputs: names.map((name) => ({ name, type: name.startsWith('image') ? 'IMAGE' : 'X', link: null })),
    addInput(name, type) { this.inputs.push({ name, type, link: null }); },
    removeInput(slot) { this.inputs.splice(slot, 1); },
  };
}
const names = (node) => node.inputs.map((input) => input.name);
const declared = ['messages', 'image', ...Array.from({ length: MAX_IMAGES - 1 }, (_, i) => `image_${i + 2}`), 'video', 'audio'];

assert.equal(imageNumber('image'), 1);
assert.equal(imageNumber('image_5'), 5);
assert.equal(imageNumber('images'), null);
assert.equal(growsImages({ input: { optional: { image_2: ['IMAGE'] } } }), true);
assert.equal(growsImages({ input: { required: { image: ['IMAGE'] } } }), false);

// A new node: one picture and one spare, not eight.
const node = makeNode(declared);
fitImageInputs(node);
assert.deepEqual(names(node), ['messages', 'image', 'image_2', 'video', 'audio']);

// Connecting the spare brings the next one.
node.inputs[2].link = 7;
fitImageInputs(node);
assert.deepEqual(names(node), ['messages', 'image', 'image_2', 'video', 'audio', 'image_3']);
assert.equal(anyImageLinked(node), true);

// And again; a gap left by an unplugged picture is kept while a later one is wired.
node.inputs[5].link = 8;
fitImageInputs(node);
assert.deepEqual(names(node), ['messages', 'image', 'image_2', 'video', 'audio', 'image_3', 'image_4']);
node.inputs[2].link = null;
fitImageInputs(node);
assert.deepEqual(names(node), ['messages', 'image', 'image_2', 'video', 'audio', 'image_3', 'image_4']);

// Unplugging the last drops the spares above the new last one.
node.inputs[5].link = null;
fitImageInputs(node);
assert.deepEqual(names(node), ['messages', 'image', 'image_2', 'video', 'audio']);
assert.equal(anyImageLinked(node), false);

// Never more than the node declares.
const full = makeNode(declared);
full.inputs.forEach((input) => { if (imageNumber(input.name)) input.link = 1; });
fitImageInputs(full);
assert.equal(full.inputs.filter((input) => imageNumber(input.name)).length, MAX_IMAGES);

// A workflow saved before the extra inputs existed gains the spare.
const old = makeNode(['messages', 'image', 'video']);
old.inputs[1].link = 3;
fitImageInputs(old);
assert.deepEqual(names(old), ['messages', 'image', 'video', 'image_2']);
console.log('ok');
