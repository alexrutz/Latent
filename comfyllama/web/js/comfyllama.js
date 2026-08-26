import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

// Nodes that return {"ui": {"text": [...]}} get a read-only textarea widget so
// the generated text is visible in the graph without opening the console.
const TEXT_OUTPUT_NODES = new Set(["LlamaCppPreviewText"]);

function setDisplayText(node, value) {
	const text = Array.isArray(value) ? value.join("") : String(value ?? "");
	let widget = node.widgets?.find((w) => w.name === "llamacpp_output");

	if (!widget) {
		widget = ComfyWidgets["STRING"](
			node,
			"llamacpp_output",
			["STRING", { multiline: true }],
			app,
		).widget;
		widget.inputEl.readOnly = true;
		widget.inputEl.style.opacity = 0.75;
		widget.serializeValue = () => undefined; // keep it out of the workflow json
	}

	widget.value = text;
	// Grow the node once so short captions are readable straight away.
	const size = node.computeSize();
	node.setSize([Math.max(node.size[0], size[0]), Math.max(node.size[1], size[1])]);
	app.graph.setDirtyCanvas(true, false);
}

app.registerExtension({
	name: "comfyllama.textPreview",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!TEXT_OUTPUT_NODES.has(nodeData.name)) {
			return;
		}

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);
			if (message?.text !== undefined) {
				setDisplayText(this, message.text);
			}
		};
	},
});

// --- One slider across temperature, top_p and top_k -------------------------
// The arithmetic is `comfyllama/scale.py`, reproduced here so the fields on the
// node always show what the node is about to send. The node computes it again
// when it runs, which is what makes the slider mean the same thing in a front
// end that never loads this file.
const SCALED = ["temperature", "top_p", "top_k"];
const INTEGER_SCALED = new Set(["top_k"]);
const DEFAULT_RANGES = {
	temperature: [0.1, 1.4],
	top_p: [0.5, 1.0],
	top_k: [10, 100],
};
const INTENSITY_BOUNDS = SCALED.flatMap((name) => [`${name}_min`, `${name}_max`]);

const clamp01 = (position) => {
	const value = Number(position);
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
};

function boundsOf(node, name) {
	const [low, high] = DEFAULT_RANGES[name];
	const min = Number(readWidget(node, `${name}_min`, low));
	const max = Number(readWidget(node, `${name}_max`, high));
	return [Number.isFinite(min) ? min : low, Number.isFinite(max) ? max : high];
}

function scaledValue(node, name, position) {
	const [low, high] = boundsOf(node, name);
	const value = low + clamp01(position) * (high - low);
	// `top_k` is a count of tokens; the rest are rounded because they are shown
	// in a widget, and 0.7499999999999999 is not a temperature anyone typed.
	return INTEGER_SCALED.has(name) ? Math.round(value) : Math.round(value * 1e4) / 1e4;
}

function positionFor(node, name, value) {
	const [low, high] = boundsOf(node, name);
	// A range with no width has no answer; a slider that cannot move reads as
	// being at its start.
	return high === low ? 0 : clamp01((Number(value) - low) / (high - low));
}

/*
 * Writing to widgets triggers the very callbacks that write to widgets, so the
 * two halves would otherwise chase each other around. One flag, held for the
 * length of one synchronisation.
 */
let syncing = false;

function setWidget(node, name, value) {
	const widget = widgetByName(node, name);
	if (!widget || widget.value === value) {
		return;
	}
	widget.value = value;
	// Some widget types keep their own DOM element in step this way.
	widget.callback?.(value, app.canvas, node);
}

/** Push the slider out into the three fields it stands for. */
function applyIntensity(node) {
	// Nothing while the slider is not the thing deciding — otherwise loading a
	// workflow whose three values were set by hand would overwrite all of them
	// with whatever position the slider happened to be left at.
	if (syncing || readWidget(node, "use_intensity", false) !== true) {
		return;
	}
	syncing = true;
	try {
		const position = readWidget(node, "intensity", 0.5);
		for (const name of SCALED) {
			setWidget(node, name, scaledValue(node, name, position));
			// The slider is meaningless if the values it sets are not sent, so
			// turning it on turns their own switches on with it.
			setWidget(node, `use_${name}`, true);
		}
	} finally {
		syncing = false;
	}
	applySamplingSwitches(node);
}

/**
 * Pull the slider back to wherever a value that was typed sits in its range,
 * and bring the other two along with it.
 *
 * This is the half that makes the two one control rather than two. Typing a
 * temperature is a statement about intensity, and the other two parameters
 * following it there is the whole point of them moving together.
 */
function intensityFromField(node, name) {
	if (syncing || readWidget(node, "use_intensity", false) !== true) {
		return;
	}
	syncing = true;
	try {
		// Snapped to the slider's own step first, and the other two computed
		// from where the slider actually lands. Reading them off the unrounded
		// position would leave three values the slider cannot reproduce, and
		// the next nudge of it would jump.
		const position = Math.round(positionFor(node, name, readWidget(node, name, 0)) * 100) / 100;
		setWidget(node, "intensity", position);
		for (const other of SCALED) {
			if (other !== name) {
				setWidget(node, other, scaledValue(node, other, position));
			}
		}
	} finally {
		syncing = false;
	}
	node.setDirtyCanvas?.(true, false);
}

// Each sampler setting has a switch in front of it; the value widgets it
// controls are greyed out while the switch is off, because they are then left
// out of the request entirely.
const SAMPLING_SWITCHES = {
	use_temperature: ["temperature"],
	use_top_p: ["top_p"],
	use_top_k: ["top_k"],
	use_min_p: ["min_p"],
	use_typical_p: ["typical_p"],
	use_repeat_penalty: ["repeat_penalty"],
	use_presence_penalty: ["presence_penalty"],
	use_frequency_penalty: ["frequency_penalty"],
	use_mirostat: ["mirostat_mode", "mirostat_tau", "mirostat_eta"],
	use_stop_sequences: ["stop_sequences"],
	use_intensity: ["intensity", ...INTENSITY_BOUNDS],
};

function applySamplingSwitches(node) {
	for (const [switchName, targets] of Object.entries(SAMPLING_SWITCHES)) {
		const toggle = node.widgets?.find((w) => w.name === switchName);
		if (!toggle) {
			continue;
		}
		for (const name of targets) {
			const widget = node.widgets.find((w) => w.name === name);
			if (!widget) {
				continue;
			}
			widget.disabled = !toggle.value;
			if (widget.inputEl) {
				widget.inputEl.style.opacity = toggle.value ? "" : "0.4";
			}
		}
	}

	/*
	 * While the slider is driving, the three switches it forces on are not
	 * decisions any more. The value fields themselves stay live — typing into
	 * one is the other way of moving the slider — but their switches are
	 * greyed, because a switch that flips itself back on is worse than one
	 * that says plainly it is not yours to flip.
	 */
	const driven = node.widgets?.find((w) => w.name === "use_intensity")?.value === true;
	for (const name of SCALED) {
		const widget = node.widgets?.find((w) => w.name === `use_${name}`);
		if (!widget) {
			continue;
		}
		widget.disabled = driven;
		if (widget.inputEl) {
			widget.inputEl.style.opacity = driven ? "0.4" : "";
		}
	}

	node.setDirtyCanvas?.(true, false);
}

// --- Polling a llama-server for its model list -----------------------------
// The list lives on the remote server, so it cannot come from INPUT_TYPES.
// The button asks the backend route, which makes the same /v1/models request
// the nodes make when they run.
const CONNECT_NODE = "LlamaServerConnect";
const MODEL_PICKER_NODES = new Set([
	CONNECT_NODE,
	"LlamaServerChat",
	"LlamaServerVisionChat",
	"LlamaServerComplete",
	"LlamaServerPresetChat",
]);

function readWidget(node, name, fallback = "") {
	const widget = node?.widgets?.find((w) => w.name === name);
	return widget === undefined ? fallback : widget.value;
}

// The URL and credentials live on the connect node, which for a generation
// node sits on the other end of its `server` input.
function findConnectNode(node) {
	if (node.type === CONNECT_NODE) {
		return node;
	}
	const slot = node.inputs?.findIndex((input) => input.name === "server");
	if (slot === undefined || slot < 0) {
		return null;
	}
	let origin = node.getInputNode?.(slot);
	// Step through reroute nodes, which pass the link straight through.
	for (let hops = 0; origin && origin.type !== CONNECT_NODE && hops < 8; hops++) {
		origin = origin.getInputNode?.(0);
	}
	return origin?.type === CONNECT_NODE ? origin : null;
}

async function pollModels(node) {
	const connect = findConnectNode(node);
	if (!connect) {
		return { models: [], error: "Connect this node to a 'Connect to llama-server' node first." };
	}
	try {
		const response = await api.fetchApi("/comfyllama/models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				base_url: readWidget(connect, "base_url"),
				auth: readWidget(connect, "auth", "auto"),
				api_key: readWidget(connect, "api_key"),
				username: readWidget(connect, "username"),
				password: readWidget(connect, "password"),
				timeout: 15,
			}),
		});
		return await response.json();
	} catch (error) {
		return { models: [], error: String(error) };
	}
}

// Which widget a picked model should be written into.
function modelTargetWidget(node) {
	if (node.type !== "LlamaServerPresetChat") {
		return node.widgets?.find((w) => w.name === "model");
	}
	// On the preset node each preset has its own model; target the active one.
	const activeWidget = node.widgets?.find((w) => w.name === "active");
	const slotCount = Number(readWidget(node, "slot_count", 1)) || 1;
	const names = presetNames(node, Math.min(slotCount, MAX_PRESET_SLOTS));
	const index = names.indexOf(activeWidget?.value) + 1;
	return node.widgets?.find((w) => w.name === `model_${index || 1}`);
}

async function showModelMenu(node, event) {
	const target = modelTargetWidget(node);
	if (!target) {
		return;
	}
	const result = await pollModels(node);
	const entries = result.models?.length
		? ["auto", ...result.models]
		: [`⚠ ${result.error || "no models reported"}`];

	new LiteGraph.ContextMenu(entries, {
		event,
		title: result.models?.length ? `Models on ${result.base_url}` : "Could not list models",
		callback: (value) => {
			if (typeof value !== "string" || value.startsWith("⚠")) {
				return;
			}
			target.value = value;
			target.callback?.(value);
			node.setDirtyCanvas?.(true, true);
		},
	});
}

function addModelPicker(nodeType) {
	const onNodeCreated = nodeType.prototype.onNodeCreated;
	nodeType.prototype.onNodeCreated = function () {
		onNodeCreated?.apply(this, arguments);
		this.addWidget(
			"button",
			"⟳ fetch models",
			null,
			(_value, _widget, node, _pos, event) => showModelMenu(node ?? this, event),
			// Never serialised: it would shift every saved widget value.
			{ serialize: false },
		);
	};
}

// --- Chat with Prompt Presets ---------------------------------------------
// The node carries a fixed number of system prompt slots. Only `slot_count` of
// them are in use, so the rest are hidden, and the `active` dropdown is filled
// from whatever the slots were renamed to.
const MAX_PRESET_SLOTS = 6;
const PASSTHROUGH = "passthrough";
const HIDDEN_TYPE = "comfyllama-hidden";

function widgetByName(node, name) {
	return node.widgets?.find((w) => w.name === name);
}

function showWidget(widget, visible) {
	if (!widget) {
		return;
	}
	// Newer frontends honour `hidden` on their own; the type swap covers the
	// older ones that draw every widget unconditionally.
	widget.hidden = !visible;
	if (!visible) {
		if (widget.type !== HIDDEN_TYPE) {
			widget.originalType = widget.type;
			widget.originalComputeSize = widget.computeSize;
			widget.type = HIDDEN_TYPE;
			widget.computeSize = () => [0, -4];
			// Keep the value reachable for "export (API)": a frontend that
			// does not recognise the swapped type may otherwise drop it. The
			// node declares these inputs optional too, so a dropped value is
			// survivable either way.
			widget.serializeValue = () => widget.value;
		}
		if (widget.inputEl) {
			widget.inputEl.style.display = "none";
		}
	} else if (widget.type === HIDDEN_TYPE) {
		widget.type = widget.originalType;
		widget.computeSize = widget.originalComputeSize;
		if (widget.inputEl) {
			widget.inputEl.style.display = "";
		}
	}
}

function presetNames(node, slotCount) {
	const names = [];
	for (let index = 1; index <= slotCount; index++) {
		const widget = widgetByName(node, `name_${index}`);
		const name = String(widget?.value ?? "").trim();
		names.push(name || `Preset ${index}`);
	}
	return names;
}

function applyPresetState(node) {
	const slotCountWidget = widgetByName(node, "slot_count");
	const activeWidget = widgetByName(node, "active");
	if (!slotCountWidget || !activeWidget) {
		return;
	}
	const slotCount = Math.max(1, Math.min(Number(slotCountWidget.value) || 1, MAX_PRESET_SLOTS));
	const names = presetNames(node, slotCount);

	// Keep the dropdown in sync with the slot names.
	const options = [PASSTHROUGH, ...names];
	activeWidget.options = { ...(activeWidget.options ?? {}), values: options };
	if (!options.includes(activeWidget.value)) {
		activeWidget.value = PASSTHROUGH;
	}

	const activeIndex = names.indexOf(activeWidget.value) + 1; // 0 = passthrough

	for (let index = 1; index <= MAX_PRESET_SLOTS; index++) {
		const inUse = index <= slotCount;
		showWidget(widgetByName(node, `name_${index}`), inUse);
		showWidget(widgetByName(node, `system_${index}`), inUse);
		showWidget(widgetByName(node, `model_${index}`), inUse);

		// The matching extra input is only read while its slot is the active
		// one; say so in the label rather than dropping the connection.
		const input = node.inputs?.find((i) => i.name === `extra_${index}`);
		if (input) {
			input.label = index === activeIndex
				? `extra_${index}`
				: `extra_${index} (inactive)`;
		}
	}

	node.setSize([node.size[0], node.computeSize()[1]]);
	node.setDirtyCanvas?.(true, true);
}

// --- The image input: clearing it, and switching it off --------------------
// A graph is a fixed set of links, so "the same workflow, this time without a
// picture" used to mean dragging the link off and dragging it back on later.
// Two things replace that: `use_image`, which ignores the image without
// unplugging it (and, because the input is lazy, without running the branch
// that produces it), and a button that unplugs it in one click when you do
// want it gone for good.
const IMAGE_NODES = new Set([
	"LlamaCppChat",
	"LlamaCppVisionChat",
	"LlamaServerChat",
	"LlamaServerVisionChat",
	"LlamaServerPresetChat",
]);

// Which controls only mean something while an image is actually being sent.
const IMAGE_ENCODING_WIDGETS = ["image_max_size", "image_quality"];

const CLEAR_IMAGE_LABEL = "✕ clear image";
const NO_IMAGE_LABEL = "no image connected";

function imageInputSlot(node) {
	const slot = node.inputs?.findIndex((input) => input.name === "image");
	return slot === undefined || slot < 0 ? null : slot;
}

function hasImageLink(node) {
	const slot = imageInputSlot(node);
	return slot !== null && node.inputs[slot].link != null;
}

function clearImage(node) {
	const slot = imageInputSlot(node);
	if (slot === null || node.inputs[slot].link == null) {
		return;
	}
	node.disconnectInput(slot);
	applyImageState(node);
	app.graph.setDirtyCanvas(true, true);
}

function applyImageState(node) {
	const connected = hasImageLink(node);
	// The vision nodes have no switch: an image is what they are for.
	const toggle = widgetByName(node, "use_image");
	const sending = connected && (toggle === undefined || toggle.value !== false);

	for (const name of IMAGE_ENCODING_WIDGETS) {
		const widget = widgetByName(node, name);
		if (!widget) {
			continue;
		}
		widget.disabled = !sending;
		if (widget.inputEl) {
			widget.inputEl.style.opacity = sending ? "" : "0.4";
		}
	}

	// Say on the input itself why a connected image is not being used, rather
	// than leaving a live-looking link that quietly goes nowhere.
	const slot = imageInputSlot(node);
	if (slot !== null) {
		node.inputs[slot].label = connected && !sending ? "image (off)" : undefined;
	}

	const button = node.widgets?.find((w) => w.name === CLEAR_IMAGE_LABEL || w.name === NO_IMAGE_LABEL);
	if (button) {
		button.name = connected ? CLEAR_IMAGE_LABEL : NO_IMAGE_LABEL;
	}

	node.setDirtyCanvas?.(true, false);
}


function addImageControls(nodeType) {
	const onNodeCreated = nodeType.prototype.onNodeCreated;
	nodeType.prototype.onNodeCreated = function () {
		onNodeCreated?.apply(this, arguments);

		this.addWidget(
			"button",
			NO_IMAGE_LABEL,
			null,
			(_value, _widget, node) => clearImage(node ?? this),
			// Never serialised: it would shift every saved widget value.
			{ serialize: false },
		);

		const toggle = widgetByName(this, "use_image");
		if (toggle) {
			const original = toggle.callback;
			toggle.callback = (...args) => {
				const result = original?.apply(toggle, args);
				applyImageState(this);
				return result;
			};
		}
		applyImageState(this);
	};

	const onConfigure = nodeType.prototype.onConfigure;
	nodeType.prototype.onConfigure = function () {
		onConfigure?.apply(this, arguments);
		applyImageState(this);
	};

	// Plugging an image in or pulling it out is the other half of the state.
	const onConnectionsChange = nodeType.prototype.onConnectionsChange;
	nodeType.prototype.onConnectionsChange = function () {
		onConnectionsChange?.apply(this, arguments);
		applyImageState(this);
	};
}

app.registerExtension({
	name: "comfyllama.imageInput",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (IMAGE_NODES.has(nodeData.name)) {
			addImageControls(nodeType);
		}
	},
});

app.registerExtension({
	name: "comfyllama.modelPicker",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (MODEL_PICKER_NODES.has(nodeData.name)) {
			addModelPicker(nodeType);
		}
	},
});

app.registerExtension({
	name: "comfyllama.presetChat",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "LlamaServerPresetChat") {
			return;
		}

		const watched = ["slot_count", "active"];
		for (let index = 1; index <= MAX_PRESET_SLOTS; index++) {
			watched.push(`name_${index}`);
		}

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			onNodeCreated?.apply(this, arguments);
			for (const name of watched) {
				const widget = widgetByName(this, name);
				if (!widget) {
					continue;
				}
				const original = widget.callback;
				widget.callback = (...args) => {
					const result = original?.apply(widget, args);
					applyPresetState(this);
					return result;
				};
			}
			applyPresetState(this);
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			onConfigure?.apply(this, arguments);
			// The saved `active` value may name a renamed preset, so restore the
			// options before validating it.
			applyPresetState(this);
		};

		const onConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function () {
			onConnectionsChange?.apply(this, arguments);
			applyPresetState(this);
		};
	},
});

app.registerExtension({
	name: "comfyllama.samplingSwitches",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "LlamaCppSampling") {
			return;
		}

		/** Run `after` once the widget's own callback has been let through. */
		const watch = (node, name, after) => {
			const widget = widgetByName(node, name);
			if (!widget) {
				return;
			}
			const original = widget.callback;
			widget.callback = (...args) => {
				const result = original?.apply(widget, args);
				after(node);
				return result;
			};
		};

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			onNodeCreated?.apply(this, arguments);

			for (const switchName of Object.keys(SAMPLING_SWITCHES)) {
				watch(this, switchName, applySamplingSwitches);
			}

			// The slider, and the ranges that decide what its ends mean: both
			// change what the three fields below should read.
			watch(this, "intensity", applyIntensity);
			for (const bound of INTENSITY_BOUNDS) {
				watch(this, bound, applyIntensity);
			}
			// Turning it on has to fill the fields in straight away, or they
			// sit there showing the last thing typed while the node sends
			// something else.
			watch(this, "use_intensity", applyIntensity);

			// And the other direction.
			for (const name of SCALED) {
				watch(this, name, (node) => intensityFromField(node, name));
			}

			applySamplingSwitches(this);
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			onConfigure?.apply(this, arguments);
			// A saved workflow carries both halves; the slider is the one that
			// decided, so the fields are brought back into line with it.
			applyIntensity(this);
			applySamplingSwitches(this);
		};
	},
});
