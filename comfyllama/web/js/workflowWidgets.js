/**
 * Two rules for widgets this package adds to a node, and one repair for the
 * workflows saved before the rules were followed.
 *
 * ComfyUI saves a node's widget values as a positional list. A button added
 * from here is a widget like any other, so unless it is kept out of that list
 * it saves a `null` — and the next widget the Python side appends lands on
 * that position when an older workflow loads, and comes back as `null`. For a
 * `use_*` switch that reads as "off", which is how a reference disappears
 * from a run nobody touched.
 *
 * Not an extension itself: only helpers, imported by the files that are.
 */

/**
 * Keep a widget out of the saved workflow.
 *
 * The flag has to be on the widget. Passed in `addWidget`'s options it lands
 * on `widget.options.serialize`, which only governs the prompt sent for a run
 * — the saved workflow reads `widget.serialize`, and saved the button anyway.
 * Both are set, so the button is left out of the prompt as well.
 */
export function keepOutOfWorkflow(widget) {
	if (!widget) return widget;
	widget.serialize = false;
	widget.options = { ...(widget.options ?? {}), serialize: false };
	return widget;
}

/**
 * Each input's default, by name, from the node definition.
 *
 * A combo's default is its first option when the definition names none, which
 * is what ComfyUI itself picks for a fresh node.
 */
export function inputDefaults(nodeData) {
	const defaults = {};
	const inputs = nodeData?.input ?? {};
	for (const section of ["required", "optional"]) {
		for (const [name, spec] of Object.entries(inputs[section] ?? {})) {
			const [type, options] = Array.isArray(spec) ? spec : [];
			if (options && "default" in options) {
				defaults[name] = options.default;
			} else if (Array.isArray(type) && type.length > 0) {
				defaults[name] = type[0];
			}
		}
	}
	return defaults;
}

/**
 * Put back the default of any widget that loaded as `null`.
 *
 * None of this package's widgets has `null` as a value — a switch, a number,
 * a path or a choice always holds one — so a `null` after loading is a
 * button's old position, never something somebody chose.
 */
export function restoreNullWidgets(node, defaults) {
	let repaired = false;
	for (const widget of node.widgets ?? []) {
		if (widget.serialize === false) continue;
		if (widget.value !== null && widget.value !== undefined) continue;
		if (!(widget.name in defaults)) continue;
		widget.value = defaults[widget.name];
		repaired = true;
	}
	return repaired;
}

/**
 * Repair on every load, for nodes of this definition.
 *
 * Before the chained handler rather than after: the values are already in
 * place when `onConfigure` runs, and whatever else reacts to them there — the
 * image switch greying out its controls — should see the repaired ones.
 */
export function repairNullsOnConfigure(nodeType, nodeData) {
	const defaults = inputDefaults(nodeData);
	const onConfigure = nodeType.prototype.onConfigure;
	nodeType.prototype.onConfigure = function () {
		restoreNullWidgets(this, defaults);
		return onConfigure?.apply(this, arguments);
	};
}
