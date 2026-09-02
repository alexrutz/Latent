import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/**
 * A file browser for choosing an input picture.
 *
 * The stock way to pick one is a combo box of every file in ComfyUI's input
 * directory, which stops working at a few thousand of them and cannot see the
 * output directory at all. What anybody actually wants — "that portrait from
 * Tuesday, somewhere under outputs" — needs folders, thumbnails and a search
 * box, so this is those.
 *
 * The server decides what may be looked at; see `comfyllama/browse.py`. This
 * only ever names a root the server already told it about.
 */

const ROOTS = "/comfyllama/browse/roots";
const LIST = "/comfyllama/browse/list";
const THUMB = "/comfyllama/browse/thumb";

/** The node this exists for, and the widget the chosen path goes into. */
const BROWSER_NODES = new Set(["LoadImageFromFolder"]);
const PATH_WIDGET = "image";

/*
 * What the dialog remembers between openings.
 *
 * Not saved with the workflow, on purpose: where you were browsing is a fact
 * about the last five minutes, not about the graph. But re-opening the browser
 * and landing back in the folder you were just in is the difference between a
 * tool and a chore, so it lives for as long as the tab does.
 */
const remembered = { root: null, path: "", sort: "date", order: "desc", recursive: false };

function widgetByName(node, name) {
	return node.widgets?.find((w) => w.name === name);
}

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

/** `1.4 MB`, and never `1400000 bytes`. */
function readableSize(bytes) {
	if (!Number.isFinite(bytes)) return "";
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function readableDate(seconds) {
	if (!Number.isFinite(seconds)) return "";
	return new Date(seconds * 1000).toLocaleString();
}

async function getJSON(route, params) {
	const query = params ? `?${new URLSearchParams(params)}` : "";
	const response = await api.fetchApi(`${route}${query}`);
	if (!response.ok) {
		let message = `The server answered ${response.status}.`;
		try {
			message = (await response.json()).error ?? message;
		} catch {
			// A non-JSON error body; the status is all there is to say.
		}
		throw new Error(message);
	}
	return response.json();
}

/**
 * The dialog itself.
 *
 * Built once per opening and thrown away on close rather than kept hidden: it
 * holds a grid of a few hundred images, and leaving those decoded in a detached
 * DOM for the rest of the session is memory nobody asked to spend.
 */
function openBrowser(node) {
	const widget = widgetByName(node, PATH_WIDGET);
	if (!widget) return;

	const overlay = element("div", "comfyllama-browse-overlay");
	const dialog = element("div", "comfyllama-browse");
	overlay.appendChild(dialog);

	// --- chrome -----------------------------------------------------------

	const header = element("div", "comfyllama-browse-header");
	const rootPicker = element("select", "comfyllama-browse-root");
	const search = element("input", "comfyllama-browse-search");
	search.type = "search";
	search.placeholder = "Filter by name…";
	const sortPicker = element("select", "comfyllama-browse-sort");
	for (const [value, label] of [
		["date", "Newest first"],
		["date-asc", "Oldest first"],
		["name", "Name A–Z"],
		["name-desc", "Name Z–A"],
		["size", "Largest first"],
		["size-asc", "Smallest first"],
	]) {
		const option = element("option", null, label);
		option.value = value;
		sortPicker.appendChild(option);
	}

	const recursive = element("label", "comfyllama-browse-recursive");
	const recursiveBox = element("input");
	recursiveBox.type = "checkbox";
	recursive.appendChild(recursiveBox);
	recursive.appendChild(element("span", null, "Include subfolders"));

	const close = element("button", "comfyllama-browse-close", "✕");
	close.title = "Close";

	header.append(rootPicker, search, sortPicker, recursive, close);

	const crumbs = element("div", "comfyllama-browse-crumbs");
	const body = element("div", "comfyllama-browse-body");
	const status = element("div", "comfyllama-browse-status");

	dialog.append(header, crumbs, body, status);
	document.body.appendChild(overlay);

	// --- state ------------------------------------------------------------

	let state = { ...remembered };
	let closed = false;
	/** Only the newest listing may draw; a slow one must not overwrite it. */
	let generation = 0;

	const dismiss = () => {
		if (closed) return;
		closed = true;
		Object.assign(remembered, state);
		overlay.remove();
		document.removeEventListener("keydown", onKey);
	};

	const onKey = (event) => {
		if (event.key === "Escape") {
			event.stopPropagation();
			dismiss();
		}
	};
	document.addEventListener("keydown", onKey);
	close.addEventListener("click", dismiss);
	// A click on the backdrop, but not one that started inside the dialog.
	overlay.addEventListener("mousedown", (event) => {
		if (event.target === overlay) dismiss();
	});

	const choose = (file) => {
		widget.value = `${state.root}/${file.path}`;
		widget.callback?.(widget.value);
		node.setDirtyCanvas?.(true, true);
		dismiss();
	};

	// --- drawing ----------------------------------------------------------

	function drawCrumbs() {
		crumbs.replaceChildren();
		const parts = state.path ? state.path.split("/") : [];

		const home = element("button", "comfyllama-crumb", state.root ?? "…");
		home.addEventListener("click", () => go(""));
		crumbs.appendChild(home);

		parts.forEach((part, index) => {
			crumbs.appendChild(element("span", "comfyllama-crumb-sep", "›"));
			const crumb = element("button", "comfyllama-crumb", part);
			const target = parts.slice(0, index + 1).join("/");
			crumb.addEventListener("click", () => go(target));
			crumbs.appendChild(crumb);
		});
	}

	function drawListing(listing) {
		body.replaceChildren();

		if (state.path) {
			const up = element("button", "comfyllama-folder", "↑ ..");
			up.addEventListener("click", () => {
				go(state.path.split("/").slice(0, -1).join("/"));
			});
			body.appendChild(up);
		}

		for (const folder of listing.folders) {
			const button = element("button", "comfyllama-folder", `📁 ${folder.name}`);
			button.addEventListener("click", () => go(folder.path));
			body.appendChild(button);
		}

		const grid = element("div", "comfyllama-grid");
		for (const file of listing.files) {
			const tile = element("button", "comfyllama-tile");
			tile.title = `${file.name}\n${readableSize(file.size)} · ${readableDate(file.mtime)}`;

			const picture = element("img");
			// `loading=lazy` is what keeps a folder of two thousand from
			// firing two thousand requests the moment it is drawn.
			picture.loading = "lazy";
			picture.decoding = "async";
			picture.src = api.apiURL(
				`${THUMB}?${new URLSearchParams({ root: state.root, path: file.path })}`,
			);
			picture.addEventListener("error", () => {
				picture.replaceWith(element("span", "comfyllama-tile-broken", "?"));
			});

			tile.appendChild(picture);
			tile.appendChild(element("span", "comfyllama-tile-name", file.name));
			tile.addEventListener("click", () => choose(file));
			grid.appendChild(tile);
		}
		body.appendChild(grid);

		if (listing.files.length === 0 && listing.folders.length === 0) {
			status.textContent = state.recursive
				? "Nothing here, or under it."
				: "Nothing here. Try including subfolders.";
		} else if (listing.truncated) {
			status.textContent =
				`Showing ${listing.files.length} of ${listing.total}. ` +
				"Filter by name, or open a subfolder, to narrow it down.";
		} else {
			const count = listing.files.length;
			status.textContent = `${count} ${count === 1 ? "picture" : "pictures"}`;
		}
	}

	// --- loading ----------------------------------------------------------

	async function refresh() {
		if (!state.root) return;
		const mine = ++generation;
		status.textContent = "Reading…";
		drawCrumbs();

		try {
			const listing = await getJSON(LIST, {
				root: state.root,
				path: state.path,
				recursive: state.recursive ? "1" : "0",
				q: search.value,
				sort: state.sort,
				order: state.order,
			});
			if (closed || mine !== generation) return;
			state.path = listing.path;
			drawCrumbs();
			drawListing(listing);
		} catch (error) {
			if (closed || mine !== generation) return;
			body.replaceChildren();
			status.textContent = error.message;
		}
	}

	function go(path) {
		state.path = path;
		body.scrollTop = 0;
		refresh();
	}

	// --- wiring -----------------------------------------------------------

	rootPicker.addEventListener("change", () => {
		state.root = rootPicker.value;
		go("");
	});

	sortPicker.addEventListener("change", () => {
		const [sort, order] = sortPicker.value.split("-");
		state.sort = sort;
		// Name reads best ascending and the other two descending, so the
		// unsuffixed option means whichever of those it is.
		state.order = order ?? (sort === "name" ? "asc" : "desc");
		refresh();
	});

	recursiveBox.addEventListener("change", () => {
		state.recursive = recursiveBox.checked;
		refresh();
	});

	// Typing filters as you go, but not once per keystroke: a recursive
	// listing of an output folder is real work on the server.
	let typing;
	search.addEventListener("input", () => {
		window.clearTimeout(typing);
		typing = window.setTimeout(refresh, 220);
	});

	(async () => {
		try {
			const { roots } = await getJSON(ROOTS);
			if (closed) return;
			if (!roots?.length) {
				status.textContent =
					"This server offers no folders to browse. Set COMFYLLAMA_IMAGE_ROOTS, " +
					"or check that ComfyUI's output directory exists.";
				return;
			}

			for (const root of roots) {
				const option = element("option", null, root.key);
				option.value = root.key;
				option.title = root.path;
				rootPicker.appendChild(option);
			}

			// Back where you were, when that root still exists.
			const known = roots.some((root) => root.key === state.root);
			state.root = known ? state.root : roots[0].key;
			if (!known) state.path = "";
			rootPicker.value = state.root;

			sortPicker.value =
				state.sort === "name"
					? state.order === "asc" ? "name" : "name-desc"
					: state.sort === "size"
						? state.order === "desc" ? "size" : "size-asc"
						: state.order === "desc" ? "date" : "date-asc";
			recursiveBox.checked = state.recursive;

			// And straight to the current selection's folder, if it has one.
			const current = String(widget.value ?? "");
			const slash = current.indexOf("/");
			if (slash > 0 && current.slice(0, slash) === state.root) {
				const inside = current.slice(slash + 1);
				state.path = inside.includes("/") ? inside.slice(0, inside.lastIndexOf("/")) : "";
			}

			refresh();
			search.focus();
		} catch (error) {
			status.textContent = error.message;
		}
	})();
}

/** The stylesheet, added once. */
function installStyles() {
	if (document.getElementById("comfyllama-browse-styles")) return;
	const style = document.createElement("style");
	style.id = "comfyllama-browse-styles";
	style.textContent = `
.comfyllama-browse-overlay {
	position: fixed; inset: 0; z-index: 1200;
	background: rgba(0,0,0,0.6);
	display: flex; align-items: center; justify-content: center;
}
.comfyllama-browse {
	display: flex; flex-direction: column;
	width: min(1100px, 92vw); height: min(760px, 88vh);
	background: var(--comfy-menu-bg, #202020);
	color: var(--fg-color, #ddd);
	border: 1px solid var(--border-color, #444);
	border-radius: 10px; overflow: hidden;
	font-size: 13px;
}
.comfyllama-browse-header {
	display: flex; gap: 8px; align-items: center;
	padding: 10px; border-bottom: 1px solid var(--border-color, #444);
}
.comfyllama-browse-search { flex: 1; min-width: 0; }
.comfyllama-browse-header select,
.comfyllama-browse-header input[type="search"] {
	background: var(--comfy-input-bg, #111); color: inherit;
	border: 1px solid var(--border-color, #444); border-radius: 6px;
	padding: 5px 8px;
}
.comfyllama-browse-recursive {
	display: flex; align-items: center; gap: 5px; white-space: nowrap;
}
.comfyllama-browse-close {
	background: none; border: none; color: inherit;
	font-size: 17px; cursor: pointer; padding: 4px 8px;
}
.comfyllama-browse-crumbs {
	display: flex; flex-wrap: wrap; align-items: center; gap: 3px;
	padding: 7px 10px; border-bottom: 1px solid var(--border-color, #444);
}
.comfyllama-crumb {
	background: none; border: none; color: inherit;
	cursor: pointer; padding: 2px 5px; border-radius: 4px;
}
.comfyllama-crumb:hover { background: rgba(255,255,255,0.1); }
.comfyllama-crumb-sep { opacity: 0.45; }
.comfyllama-browse-body { flex: 1; overflow: auto; padding: 10px; }
.comfyllama-folder {
	display: block; width: 100%; text-align: left;
	background: none; border: none; color: inherit;
	padding: 6px 8px; border-radius: 6px; cursor: pointer;
}
.comfyllama-folder:hover { background: rgba(255,255,255,0.08); }
.comfyllama-grid {
	display: grid; gap: 8px; margin-top: 8px;
	grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
}
.comfyllama-tile {
	display: flex; flex-direction: column; gap: 4px;
	background: none; border: 1px solid transparent; border-radius: 8px;
	padding: 4px; cursor: pointer; color: inherit; overflow: hidden;
}
.comfyllama-tile:hover { border-color: var(--border-color, #666); background: rgba(255,255,255,0.06); }
.comfyllama-tile img {
	width: 100%; aspect-ratio: 1; object-fit: cover;
	border-radius: 5px; background: #111;
}
.comfyllama-tile-broken {
	display: grid; place-items: center;
	width: 100%; aspect-ratio: 1; border-radius: 5px;
	background: #111; opacity: 0.5;
}
.comfyllama-tile-name {
	font-size: 11px; opacity: 0.8;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.comfyllama-browse-status {
	padding: 7px 10px; border-top: 1px solid var(--border-color, #444);
	opacity: 0.75; min-height: 1.4em;
}
`;
	document.head.appendChild(style);
}

app.registerExtension({
	name: "comfyllama.imageBrowser",
	async beforeRegisterNodeDef(nodeType, nodeData) {
		if (!BROWSER_NODES.has(nodeData.name)) {
			return;
		}
		installStyles();

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			onNodeCreated?.apply(this, arguments);
			this.addWidget("button", "Browse…", null, () => openBrowser(this));
		};

		/*
		 * Double-clicking the node opens it too.
		 *
		 * The button is the discoverable way; this is the one that stops being
		 * a trip to a small target once you know the node. Chained rather than
		 * replaced, so LiteGraph's own handler still runs.
		 */
		const onDblClick = nodeType.prototype.onDblClick;
		nodeType.prototype.onDblClick = function () {
			const handled = onDblClick?.apply(this, arguments);
			openBrowser(this);
			return handled;
		};
	},
});
