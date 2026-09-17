"""An image input that browses the folders instead of listing every file.

Stock `LoadImage` offers a combo of everything in ComfyUI's input directory,
which works right up until there are a few thousand of them — and it cannot see
the output directory at all, so the commonest thing anybody wants to do with a
render (feed it back in) means finding it in a file manager and copying it
across first.

This node holds a path instead, and the web extension beside it opens a browser
over the folders the server allows: subfolders, thumbnails, sorting, a search
box. See `comfyllama.browse` for which folders those are, and why the list of
them deliberately does not live on this node.
"""

from __future__ import annotations

import os
from typing import Any, Dict

from ..browse import BrowseError, resolve_reference
from .common import CATEGORY_LATENT


def load_image(path: str):
    """One file as a ComfyUI `IMAGE` and `MASK`.

    The same pair stock `LoadImage` produces, mask included: the alpha channel
    inverted, so a picture with transparency can be composited without a second
    node, and an opaque one gives the all-zero mask that means "nothing masked".

    EXIF orientation is applied. A photograph off a phone is stored rotated with
    a tag saying which way up it goes, and a loader that ignores the tag hands
    the sampler a sideways picture.
    """
    import numpy as np
    import torch
    from PIL import Image, ImageOps

    with Image.open(path) as opened:
        upright = ImageOps.exif_transpose(opened)
        rgb = upright.convert("RGB")
        pixels = np.asarray(rgb).astype(np.float32) / 255.0
        image = torch.from_numpy(pixels)[None, ...]

        if "A" in upright.getbands():
            alpha = np.asarray(upright.getchannel("A")).astype(np.float32) / 255.0
            mask = torch.from_numpy(1.0 - alpha)[None, ...]
        else:
            mask = torch.zeros((1, rgb.size[1], rgb.size[0]), dtype=torch.float32)

    return image, mask


def _fingerprint(path: str) -> str:
    """Enough to notice the file changed, without reading it.

    ComfyUI caches a node's result until `IS_CHANGED` returns something new.
    Stock `LoadImage` hashes the whole file; that is exact and costs a full read
    of every input image on every queued prompt. Size and modification time
    catch a replaced file, an edited file and a different file, and the case
    they miss — a byte-identical rewrite with a preserved timestamp — is one
    where the cached result is correct anyway.
    """
    try:
        stat = os.stat(path)
    except OSError:
        return "missing"
    return f"{stat.st_size}:{stat.st_mtime_ns}"


class LoadImageFromFolder:
    """Pick a picture out of the output folder — or any allowed folder."""

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        return {
            "required": {
                "image": ("STRING", {
                    "default": "",
                    "tooltip": "Set by the Browse… button. Reads "
                               "'<folder>/<path/to/picture.png>', where the "
                               "first part names one of the folders this "
                               "server offers — normally 'output'.",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING")
    RETURN_NAMES = ("image", "mask", "name")
    FUNCTION = "load"
    CATEGORY = CATEGORY_LATENT
    DESCRIPTION = (
        "Load an image chosen from a folder browser, so a finished render can "
        "be fed straight back in without copying it anywhere first."
    )

    @classmethod
    def IS_CHANGED(cls, image: str = "", **kwargs) -> Any:
        try:
            return _fingerprint(resolve_reference(image))
        except BrowseError:
            # An unset or unreachable path is not a reason to fail here —
            # `load` raises with a sentence somebody can act on.
            return image

    @classmethod
    def VALIDATE_INPUTS(cls, image: str = "", **kwargs) -> Any:
        """Refuse before the queue rather than after.

        A wrong path fails at the same place either way, but failing here says
        so the moment the button is pressed, instead of after everything
        upstream of this node has been executed.
        """
        try:
            resolve_reference(image)
        except BrowseError as exc:
            return str(exc)
        return True

    def load(self, image: str = "", **kwargs):
        path = resolve_reference(image)
        tensor, mask = load_image(path)
        # Without the extension: this is for a `filename_prefix`, and "a.png.png"
        # is what happens when it is not.
        name = os.path.splitext(os.path.basename(path))[0]
        return (tensor, mask, name)
