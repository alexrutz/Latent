import { keepOutOfWorkflow, inputDefaults, repairNullsOnConfigure } from '../../web/js/workflowWidgets.js';
import assert from 'node:assert/strict';
const nodeData = { input: {
  required: { video_fps: ['INT', { default: 24 }], mode: [['a', 'b'], {}] },
  optional: { picture_1: ['STRING', { default: '' }], use_picture_1: ['BOOLEAN', { default: true }] },
} };
assert.deepEqual(inputDefaults(nodeData), { video_fps: 24, mode: 'a', picture_1: '', use_picture_1: true });
// Simulate a frontend: positional restore skipping serialize === false.
function NodeType() {}
NodeType.prototype.onConfigure = function () { this.sawUse = this.widgets[3].value; };
repairNullsOnConfigure(NodeType, nodeData);
const node = new NodeType();
node.widgets = [
  { name: 'video_fps', value: 24 }, { name: 'mode', value: 'a' },
  { name: 'picture_1', value: '' }, { name: 'use_picture_1', value: true },
  keepOutOfWorkflow({ name: 'Browse picture_1…', value: null, options: {} }),
];
// Saved before the switch existed: [fps, mode, path, null (the button)]
const saved = [30, 'b', 'output/x.png', null];
let i = 0;
for (const w of node.widgets) { if (w.serialize === false) continue; w.value = saved[i++]; }
assert.equal(node.widgets[3].value, null);
node.onConfigure({});
assert.equal(node.widgets[3].value, true, 'switch restored to its default');
assert.equal(node.sawUse, true, 'chained handler sees the repaired value');
assert.equal(node.widgets[2].value, 'output/x.png');
assert.equal(node.widgets[0].value, 30);
assert.equal(node.widgets[4].serialize, false);
assert.equal(node.widgets[4].options.serialize, false);
console.log('ok');
