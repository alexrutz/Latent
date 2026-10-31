/**
 * Picture inputs that grow as they are used.
 *
 * A chat node takes more than one picture — `image`, then `image_2` up to
 * `image_8` — because pictures to compare or combine are rarely one size, and
 * one batch has to be. Showing all eight sockets on every node would be seven
 * empty ones on most of them, so only the pictures in use are shown, plus one
 * empty socket after the last: connect a picture and the next socket appears,
 * pull it out and the spare ones go again.
 *
 * Not an extension itself: helpers, imported by `comfyllama.js`, kept apart so
 * they can be tested without ComfyUI.
 */

export const MAX_IMAGES = 8;

/** `image` is picture 1; `image_N` is picture N. Anything else is not a picture input. */
export function imageNumber(name) {
	if (name === "image") {
		return 1;
	}
	const match = /^image_(\d+)$/.exec(name ?? "");
	return match ? Number(match[1]) : null;
}

export function imageInputName(number) {
	return number === 1 ? "image" : `image_${number}`;
}

/** Whether a node's definition has the extra picture inputs at all. */
export function growsImages(nodeData) {
	return Boolean(nodeData?.input?.optional?.image_2);
}

/** Whether any picture input is wired. */
export function anyImageLinked(node) {
	return (node.inputs ?? []).some((input) => imageNumber(input.name) !== null && input.link != null);
}

/**
 * Show the pictures in use, and one empty socket after the last of them.
 *
 * An empty socket between two wired ones stays, so nothing renumbers under a
 * picture that is still connected. Removed from the highest slot down, because
 * removing a socket moves every one after it.
 */
export function fitImageInputs(node) {
	if (!node.inputs || node.__comfyllamaFittingImages) {
		return;
	}
	// Adding and removing sockets fires the connection hook that calls this.
	node.__comfyllamaFittingImages = true;
	try {
		const pictures = node.inputs
			.map((input, slot) => ({ input, slot, number: imageNumber(input.name) }))
			.filter((entry) => entry.number !== null);
		const wired = pictures.filter((entry) => entry.input.link != null).map((entry) => entry.number);
		const last = Math.min(MAX_IMAGES, Math.max(1, ...wired) + 1);

		for (const entry of [...pictures].sort((a, b) => b.slot - a.slot)) {
			if (entry.number > last && entry.input.link == null) {
				node.removeInput(entry.slot);
			}
		}

		const present = new Set(node.inputs.map((input) => input.name));
		for (let number = 2; number <= last; number++) {
			const name = imageInputName(number);
			if (!present.has(name)) {
				node.addInput(name, "IMAGE");
			}
		}

		if (node.computeSize && node.setSize && node.size) {
			node.setSize([node.size[0], node.computeSize()[1]]);
		}
	} finally {
		node.__comfyllamaFittingImages = false;
	}
}
