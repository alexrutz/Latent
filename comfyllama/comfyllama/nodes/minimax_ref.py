"""MiniMax H3 reference-to-video, with slots you can switch on and off.

The stock `MiniMaxH3ReferenceToVideo` takes its references through *autogrow*
inputs — slots that appear as you connect things. That is pleasant in the graph
editor and unusable from anywhere else: an autogrow group cannot be expressed in
an API-format prompt. Sent nested it is accepted and silently ignored, sent flat
it raises `TypeError: execute() got an unexpected keyword argument`, and the
upstream issue asking for it to work was closed as not planned. Latent submits
API-format prompts, so driving that node from a phone produces a video that
ignores every reference and says nothing about it.

This node is the same node with its references arriving through ordinary fixed
inputs, which API format handles perfectly well. It does not reimplement any of
the conditioning: it packs the slots that are switched on into the dictionaries
the upstream `execute` wants and calls it. The encoding, the sizing and the
tokenizer presentation stay upstream, where they will keep being maintained.

The other half of the job is the numbering — see `comfyllama.refdesk`. Tag a
slot `woman`, write `@woman` in the prompt, and the ordinal is worked out after
the switches have had their say, so turning a reference off cannot quietly
repoint the rest of your prompt at the wrong pictures.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from ..refdesk import (MAX_AUDIOS, MAX_IMAGES, MAX_VIDEOS, Slot, SlotError,
                       describe, plan, reference_groups)

CATEGORY_MINIMAX = "comfyllama/minimax"

# Mirrors the upstream defaults so a graph built here and a graph built there
# start from the same place.
DEFAULT_WIDTH = 1344
DEFAULT_HEIGHT = 768
DEFAULT_LENGTH = 124
REF_IMAGE_SIZES = ["match", "max"]


def _switch(kind: str, index: int) -> Tuple[str, Dict[str, Any]]:
    return ("BOOLEAN", {
        "default": True,
        "label_on": "on",
        "label_off": "off",
        "tooltip": f"Include {kind} slot {index}. Switched off, nothing upstream "
                   "of it runs and every later reference keeps its number.",
    })


def _tag(kind: str, index: int) -> Tuple[str, Dict[str, Any]]:
    return ("STRING", {
        "default": "",
        "tooltip": f"A short name for {kind} slot {index}, so the prompt can say "
                   "'@name' instead of a number that moves when you switch "
                   "something off.",
    })


class MiniMaxH3ReferencesFlat:
    """Reference-to-video with a fixed slot per reference, each switchable."""

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        optional: Dict[str, Any] = {}

        for index in range(1, MAX_IMAGES + 1):
            optional[f"image_{index}"] = ("IMAGE", {
                "lazy": True,
                "tooltip": f"Reference picture {index}.",
            })
            optional[f"image_{index}_on"] = _switch("picture", index)
            optional[f"image_{index}_tag"] = _tag("picture", index)

        for index in range(1, MAX_VIDEOS + 1):
            optional[f"video_{index}"] = ("IMAGE", {
                "lazy": True,
                "tooltip": f"Reference video {index}: frames at 24 fps, 2-15s.",
            })
            optional[f"video_{index}_audio"] = ("AUDIO", {
                "lazy": True,
                "tooltip": f"Soundtrack for reference video {index}. It takes an "
                           "<Audio> number of its own, ahead of the standalone "
                           "audio slots — reachable in the prompt as '@tag-audio'.",
            })
            optional[f"video_{index}_on"] = _switch("video", index)
            optional[f"video_{index}_tag"] = _tag("video", index)

        for index in range(1, MAX_AUDIOS + 1):
            optional[f"audio_{index}"] = ("AUDIO", {
                "lazy": True,
                "tooltip": f"Standalone reference audio {index}.",
            })
            optional[f"audio_{index}_on"] = _switch("audio", index)
            optional[f"audio_{index}_tag"] = _tag("audio", index)

        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "prompt": ("STRING", {
                    "multiline": True,
                    "dynamic_prompts": True,
                    "tooltip": "Refer to a reference by its tag — '@woman' — and the "
                               "number is filled in for you. Writing '<Picture 2>' "
                               "directly still works and is left alone.",
                }),
                "width": ("INT", {"default": DEFAULT_WIDTH, "min": 32, "max": 16384, "step": 32}),
                "height": ("INT", {"default": DEFAULT_HEIGHT, "min": 32, "max": 16384, "step": 32}),
                "length": ("INT", {
                    "default": DEFAULT_LENGTH, "min": 5, "max": 3600, "step": 17,
                    "tooltip": "Frame count at 24 fps (124 = ~5s).",
                }),
                "ref_image_size": (REF_IMAGE_SIZES, {
                    "default": "match",
                    "tooltip": "'match' scales each reference to the generation's "
                               "pixel area; 'max' keeps more identity detail and is "
                               "several times slower, because reference tokens ride "
                               "through every sampling step.",
                }),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "STRING")
    RETURN_NAMES = ("positive", "latent", "prompt")
    FUNCTION = "build"
    CATEGORY = CATEGORY_MINIMAX
    DESCRIPTION = (
        "MiniMax H3 reference-to-video with nine picture slots, three video "
        "slots and three audio slots, each switchable, and tag names so the "
        "prompt does not have to hard-code reference numbers."
    )

    # ------------------------------------------------------------------
    # Reading the slots
    # ------------------------------------------------------------------

    @staticmethod
    def _wanted(kwargs: Dict[str, Any]) -> List[str]:
        """The inputs worth evaluating: the ones a live slot will actually read."""
        names: List[str] = []
        for index in range(1, MAX_IMAGES + 1):
            if kwargs.get(f"image_{index}_on", True):
                names.append(f"image_{index}")
        for index in range(1, MAX_VIDEOS + 1):
            if kwargs.get(f"video_{index}_on", True):
                names.extend([f"video_{index}", f"video_{index}_audio"])
        for index in range(1, MAX_AUDIOS + 1):
            if kwargs.get(f"audio_{index}_on", True):
                names.append(f"audio_{index}")
        return names

    def check_lazy_status(self, **kwargs) -> List[str]:
        """Only pull in the references that are switched on.

        This is what makes the switches worth having rather than merely tidy: a
        reference video that is switched off is never loaded, never resized and
        never decoded, so turning one off makes the run shorter instead of only
        making the prompt shorter.
        """
        return [name for name in self._wanted(kwargs) if kwargs.get(name) is None]

    @staticmethod
    def _slots(kwargs: Dict[str, Any]) -> List[Slot]:
        slots: List[Slot] = []
        for index in range(1, MAX_IMAGES + 1):
            slots.append(Slot(
                kind="image",
                index=index,
                on=bool(kwargs.get(f"image_{index}_on", True)),
                tag=str(kwargs.get(f"image_{index}_tag", "") or ""),
                value=kwargs.get(f"image_{index}"),
            ))
        for index in range(1, MAX_VIDEOS + 1):
            on = bool(kwargs.get(f"video_{index}_on", True))
            slots.append(Slot(
                kind="video",
                index=index,
                on=on,
                tag=str(kwargs.get(f"video_{index}_tag", "") or ""),
                value=kwargs.get(f"video_{index}"),
                # A soundtrack with its video switched off is not a reference.
                audio=kwargs.get(f"video_{index}_audio") if on else None,
            ))
        for index in range(1, MAX_AUDIOS + 1):
            slots.append(Slot(
                kind="audio",
                index=index,
                on=bool(kwargs.get(f"audio_{index}_on", True)),
                tag=str(kwargs.get(f"audio_{index}_tag", "") or ""),
                value=kwargs.get(f"audio_{index}"),
            ))
        return slots

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs) -> Any:
        """Catch a tag mistake before the queue rather than after the encode."""
        try:
            plan(cls._slots(kwargs), str(kwargs.get("prompt", "") or ""))
        except SlotError as error:
            return str(error)
        return True

    # ------------------------------------------------------------------
    # Running
    # ------------------------------------------------------------------

    def build(self, clip, vae, audio_vae, prompt, width, height, length,
              ref_image_size="match", **kwargs):
        slots = self._slots(kwargs)
        arrangement = plan(slots, prompt)

        if not arrangement.by_kind("image") and not arrangement.by_kind("video"):
            # Upstream would run and quietly produce an unconditioned video.
            raise SlotError(
                "No picture or video reference is switched on. MiniMax H3 needs at "
                "least one of those — reference audio on its own is not enough."
            )

        images, videos, video_audios, audios = reference_groups(slots)

        try:
            from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
        except ImportError as error:  # pragma: no cover - needs ComfyUI
            raise SlotError(
                "This ComfyUI does not have the MiniMax H3 nodes "
                "(comfy_extras/nodes_minimax_h3.py). Update ComfyUI."
            ) from error

        print(f"[comfyllama] MiniMax H3 references: {describe(arrangement)}")

        # Called rather than reimplemented: the sizing, the VAE encoding and the
        # tokenizer presentation are upstream's business and change with the
        # model. All this node decides is which references exist and what they
        # are called.
        result = MiniMaxH3ReferenceToVideo.execute(
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=arrangement.prompt,
            width=width,
            height=height,
            length=length,
            ref_image_size=ref_image_size,
            ref_images=images,
            ref_videos=videos,
            ref_video_audios=video_audios,
            ref_audios=audios,
        )

        conditioning, latent = _unpack(result)
        return (conditioning, latent, arrangement.prompt)


def _unpack(result: Any):
    """Get (conditioning, latent) out of whatever `execute` handed back.

    Upstream returns a V3 `NodeOutput`; older and newer shapes return a plain
    tuple. Reading both costs three lines and means a ComfyUI update changing
    the wrapper type does not take this node down with it.
    """
    values = getattr(result, "result", None)
    if values is None:
        values = result
    try:
        conditioning, latent = values[0], values[1]
    except (TypeError, IndexError, KeyError) as error:
        raise SlotError(
            "The MiniMax H3 node returned something this wrapper did not "
            f"recognise ({type(result).__name__}). ComfyUI may have changed it."
        ) from error
    return conditioning, latent
