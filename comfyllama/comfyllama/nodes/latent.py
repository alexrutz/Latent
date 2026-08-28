"""A general-purpose empty latent node, sized by aspect ratio and megapixels.

Nothing here touches llama.cpp — it is bundled because it is the companion
node most workflows in this pack end up needing.
"""

from __future__ import annotations

import math
from typing import Dict, List, NamedTuple, Optional, Tuple

from .common import CATEGORY_LATENT

# The two ratios asked for most often come first; the rest are ordered in
# landscape/portrait pairs.
ASPECT_RATIOS: List[Tuple[str, int, int]] = [
    ("1:1", 1, 1),
    ("2:3", 2, 3),
    ("3:2", 3, 2),
    ("3:4", 3, 4),
    ("4:3", 4, 3),
    ("4:5", 4, 5),
    ("5:4", 5, 4),
    ("9:16", 9, 16),
    ("16:9", 16, 9),
    ("9:21", 9, 21),
    ("21:9", 21, 9),
    ("1:2", 1, 2),
    ("2:1", 2, 1),
]

RATIO_BY_LABEL: Dict[str, Tuple[int, int]] = {
    label: (width, height) for label, width, height in ASPECT_RATIOS
}

RATIO_LABELS = [label for label, _, _ in ASPECT_RATIOS]

# One megapixel means 1024x1024, the convention the SDXL/Flux resolution
# tables are written in.
PIXELS_PER_MEGAPIXEL = 1024 * 1024

class LatentSpec(NamedTuple):
    """What one model family expects an empty latent to look like."""

    channels: int
    downscale: int      # pixels per latent cell, per axis
    minimum_multiple: int  # smallest edge granularity the model tolerates


DEFAULT_FORMAT = "SD1.5 / SDXL (4 channels)"

# Krea 2 decodes through the Qwen-Image autoencoder: 16 channels at f8, the
# same tensor shape ComfyUI's own Krea 2 workflow builds with
# EmptySD3LatentImage.  Its transformer patchifies the latent in 2x2 blocks,
# so edges are kept on a 16 pixel grid.
LATENT_FORMATS: Dict[str, LatentSpec] = {
    DEFAULT_FORMAT: LatentSpec(channels=4, downscale=8, minimum_multiple=8),
    "SD3 / Flux (16 channels)": LatentSpec(channels=16, downscale=8,
                                           minimum_multiple=8),
    "Krea 2 (16 channels)": LatentSpec(channels=16, downscale=8,
                                       minimum_multiple=16),
}


# What a connected picture is allowed to decide.
#
# Two different questions, and a workflow wants one or the other rather than
# both. *Resolution* is "make it exactly this size again" — an upscale pass, a
# second take at a frame you already have. *Aspect ratio* is "this shape, at my
# budget" — the far commoner case, because the source is a phone photo at twelve
# megapixels and the model wants one.
FROM_IMAGE_OFF = "off"
FROM_IMAGE_RATIO = "aspect ratio"
FROM_IMAGE_RESOLUTION = "resolution"
FROM_IMAGE_MODES = [FROM_IMAGE_OFF, FROM_IMAGE_RATIO, FROM_IMAGE_RESOLUTION]


def image_size(image) -> Tuple[int, int]:
    """The width and height of a ComfyUI IMAGE, as pixels.

    The tensor is ``[batch, height, width, channels]`` — height before width,
    which is the wrong way round from everything else in this file and is
    exactly the sort of thing worth having in one named place.
    """
    shape = getattr(image, "shape", None)
    if shape is None or len(shape) < 3:
        raise ValueError("The connected image is not in ComfyUI's IMAGE format.")
    return int(shape[2]), int(shape[1])


def resolve_dimensions(aspect_ratio: str, megapixels: float, divisible_by: int = 8,
                       minimum_multiple: int = 1) -> Tuple[int, int]:
    """Pixel size closest to ``megapixels`` at the given ratio.

    Both edges are rounded to a multiple of ``divisible_by``, or of
    ``minimum_multiple`` when the chosen model needs a coarser grid than that.
    The rounding means the area lands near, not exactly on, the requested
    megapixels.
    """
    try:
        width_ratio, height_ratio = RATIO_BY_LABEL[aspect_ratio]
    except KeyError:
        raise ValueError(
            f"Unknown aspect ratio '{aspect_ratio}'. Pick one of: "
            f"{', '.join(RATIO_LABELS)}."
        ) from None

    step = max(1, int(divisible_by), int(minimum_multiple))
    pixels = max(float(megapixels), 0.0) * PIXELS_PER_MEGAPIXEL
    scale = math.sqrt(pixels / (width_ratio * height_ratio))
    width = _round_to(width_ratio * scale, step)
    height = _round_to(height_ratio * scale, step)
    return width, height


def _round_to(value: float, multiple: int) -> int:
    return max(multiple, int(round(value / multiple)) * multiple)


def plan_dimensions(aspect_ratio: str, megapixels: float, divisible_by: int,
                    minimum_multiple: int, from_image: str = FROM_IMAGE_OFF,
                    source: Optional[Tuple[int, int]] = None) -> Tuple[int, int]:
    """The size this node will make, whatever decided it.

    One place, because there are three ways in now and `generate` deciding for
    itself is how a node ends up making a latent of one size and reporting
    another out of its `width`/`height` outputs.

    `source` is the connected picture's own pixel size, or `None` for no
    picture. The widgets decide whenever nothing else does — which is both the
    default and what a workflow saved before this existed keeps doing.
    """
    step = max(1, int(divisible_by), int(minimum_multiple))

    if from_image == FROM_IMAGE_RESOLUTION and source is not None:
        # Rounded, not taken raw: a latent cannot represent 1023 pixels, so an
        # odd-sized source has to land on the grid like everything else.
        width, height = source
        return _round_to(width, step), _round_to(height, step)

    if from_image == FROM_IMAGE_RATIO and source is not None:
        width, height = source
        if width <= 0 or height <= 0:
            raise ValueError("The connected image has no size to take a ratio from.")
        # The picture's own proportions rather than the nearest of the thirteen
        # labels: a 3024x4032 photo is 3:4 and a 2778x1284 screenshot is not any
        # of them, and snapping the second one to 2:1 would be a crop nobody
        # asked for.
        pixels = max(float(megapixels), 0.0) * PIXELS_PER_MEGAPIXEL
        scale = math.sqrt(pixels / (width * height))
        return _round_to(width * scale, step), _round_to(height * scale, step)

    return resolve_dimensions(aspect_ratio, megapixels, divisible_by,
                              minimum_multiple)


class EmptyLatentByAspectRatio:
    """Empty latent sized by aspect ratio and megapixels instead of w/h."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "aspect_ratio": (RATIO_LABELS, {
                    "default": "1:1",
                    "tooltip": "width:height. Both orientations are listed.",
                }),
                "megapixels": ("FLOAT", {
                    "default": 1.0, "min": 0.01, "max": 64.0, "step": 0.01,
                    "tooltip": "Target area, where 1.0 MP = 1024x1024. SD1.5 "
                               "likes 0.26, SDXL and Flux 1.0, Krea 2 anything "
                               "from 1.0 (1K) to 2.0 (2K).",
                }),
                "divisible_by": ([8, 16, 32, 64], {
                    "default": 8,
                    "tooltip": "Both edges are rounded to a multiple of this. "
                               "8 is the minimum a latent can represent; 64 "
                               "keeps SDXL happy. Raised automatically when "
                               "the latent format needs a coarser grid.",
                }),
                "batch_size": ("INT", {"default": 1, "min": 1, "max": 4096}),
            },
            "optional": {
                "latent_format": (list(LATENT_FORMATS), {
                    "default": DEFAULT_FORMAT,
                    "tooltip": "Shape of the empty latent. SD3, Flux and other "
                               "16-channel VAEs need the second entry; Krea 2 "
                               "is the same shape but keeps both edges on a "
                               "16 pixel grid.",
                }),
                # Appended, not put up beside `aspect_ratio` where it reads
                # best: ComfyUI stores widget values positionally, so anything
                # inserted higher shifts every value after it in a workflow
                # that has already been saved.
                #
                # Off by default, so a graph made before this existed goes on
                # meaning exactly what it meant — including one that already had
                # a picture wired somewhere near this node.
                "from_image": (FROM_IMAGE_MODES, {
                    "default": FROM_IMAGE_OFF,
                    "tooltip": "Take the size from the connected picture. "
                               "'aspect ratio' keeps your megapixel budget and "
                               "only borrows the shape; 'resolution' makes the "
                               "latent the picture's own size. Both round to "
                               "the grid the format needs.",
                }),
                # Lazy: with `from_image` off, nothing upstream of this input
                # runs at all — no loader, no decode, no resize.
                "image": ("IMAGE", {
                    "lazy": True,
                    "tooltip": "Only read when 'from_image' asks for it.",
                }),
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("latent", "width", "height")
    FUNCTION = "generate"
    CATEGORY = CATEGORY_LATENT
    DESCRIPTION = "Empty latent from an aspect ratio and a megapixel budget."

    def check_lazy_status(self, from_image=FROM_IMAGE_OFF, **kwargs):
        """Only pull the picture in when something is going to read it."""
        return ["image"] if from_image != FROM_IMAGE_OFF else []

    def generate(self, aspect_ratio, megapixels, divisible_by, batch_size,
                 latent_format=DEFAULT_FORMAT, from_image=FROM_IMAGE_OFF,
                 image=None):
        import torch

        if from_image != FROM_IMAGE_OFF and image is None:
            raise ValueError(
                f"'from_image' is set to '{from_image}' but no picture is "
                f"connected. Connect one, or set 'from_image' to "
                f"'{FROM_IMAGE_OFF}'."
            )

        spec = LATENT_FORMATS.get(latent_format, LATENT_FORMATS[DEFAULT_FORMAT])
        width, height = plan_dimensions(
            aspect_ratio, megapixels, divisible_by, spec.minimum_multiple,
            from_image, image_size(image) if image is not None else None,
        )

        device = None
        try:
            import comfy.model_management as model_management

            device = model_management.intermediate_device()
        except Exception:
            device = None

        samples = torch.zeros(
            [batch_size, spec.channels, height // spec.downscale,
             width // spec.downscale],
            device=device,
        )
        return ({"samples": samples}, width, height)
