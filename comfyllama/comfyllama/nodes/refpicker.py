"""Picking the reference material for MiniMax H3, in one node.

The stock `MiniMax H3 Reference to Video` takes up to nine pictures, three
videos with their soundtracks, and three standalone audio clips. Feeding it by
hand means a loader node per reference — fifteen nodes trailing wires across the
canvas before any of the interesting settings are reached.

This is one node that holds all of them. Each slot is a path you pick with the
folder browser, and each slot has an output. Wire the ones you filled into the
stock node's reference sockets and leave the rest alone.

It does not condition anything and it does not replace the stock node. It loads
files and hands them over, which is the whole job.

**Empty slots output nothing at all** — literally `None` — and the stock node
skips those, so a slot can be emptied without unwiring it and without renumbering
anything you have already connected. Which is also the reason the outputs are one
per slot rather than a list: the connection order into an autogrow socket is
fixed by the wire, so a slot that clears itself has to leave a hole the far end
knows to drop.

Decoding is PyAV for video and audio, which is what ComfyUI itself uses for
both — not a second decoder with its own opinions about frame rates and sample
formats.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

from ..browse import BrowseError, resolve_reference
from .browser import load_image

CATEGORY_MINIMAX = "comfyllama/minimax"

MAX_PICTURES = 9
MAX_VIDEOS = 3
MAX_AUDIOS = 3

# What the model was trained on. The stock node trims frame counts itself, but
# it cannot know that a 60 fps clip is playing at two and a half times speed.
TARGET_FPS = 24
# H3 takes 2–15s of reference video; longer is trimmed rather than refused,
# because a clip being a little long is not a mistake worth stopping for.
MAX_VIDEO_SECONDS = 15


def _slot(kind: str, index: int, label: str) -> Tuple[str, Dict[str, Any]]:
    return ("STRING", {
        "default": "",
        "tooltip": f"{label} {index}. Set by its Browse… button — reads "
                   "'<folder>/<path/to/file>', where the first part names one of "
                   "the folders this server offers.",
        # Read by the web extension to filter the browser to the right files.
        "comfyllama_browse": kind,
    })


def _switch(kind: str, index: int, label: str) -> Tuple[str, Dict[str, Any]]:
    """The on/off switch in front of one slot.

    Named `use_<slot>`, which is the convention the folder loader's own switch
    already uses. A slot switched off hands out nothing at all — the same as an
    empty one, which the stock node drops — so a reference can be taken out of a
    run without unwiring it or losing the path you found.

    Off is *lazy*: the picture is not loaded and the clip is not decoded, so
    switching one off makes the run shorter and not only the reference list.
    """
    return ("BOOLEAN", {
        "default": True,
        "label_on": "on",
        "label_off": "off",
        "tooltip": f"Send {label.lower()} {index}. Off keeps the path but leaves "
                   "the reference out of the run, and skips loading it.",
    })


def load_video(path: str, fps: int = TARGET_FPS, max_seconds: int = MAX_VIDEO_SECONDS):
    """A clip as an `IMAGE` batch of frames, resampled to `fps`.

    Resampled by picking the nearest source frame for each output frame rather
    than by dropping every Nth: the arithmetic is the same for an integer ratio
    and stays honest for 29.97, which is the frame rate most phone footage
    actually is.
    """
    import av
    import numpy as np
    import torch

    with av.open(path) as container:
        if not container.streams.video:
            raise BrowseError(f"'{os.path.basename(path)}' has no video in it.")
        stream = container.streams.video[0]
        source_fps = float(stream.average_rate or fps)
        frames = [frame.to_ndarray(format="rgb24") for frame in container.decode(stream)]

    if not frames:
        raise BrowseError(f"No frames could be read from '{os.path.basename(path)}'.")

    duration = len(frames) / source_fps if source_fps > 0 else 0.0
    wanted = max(1, int(round(min(duration, max_seconds) * fps)))
    picked = [frames[min(len(frames) - 1, int(round(i * source_fps / fps)))] for i in range(wanted)]

    stacked = np.stack(picked).astype(np.float32) / 255.0
    return torch.from_numpy(stacked)


def load_audio(path: str):
    """A file as ComfyUI's `AUDIO`: a waveform and its sample rate.

    The same PyAV decode ComfyUI's own `LoadAudio` does, including the channel
    reshape — a planar stream arrives as one flat buffer per frame and has to be
    folded back into channels, or a stereo clip becomes twice as long and mono.
    """
    import av
    import torch

    with av.open(path) as container:
        if not container.streams.audio:
            raise BrowseError(f"'{os.path.basename(path)}' has no sound in it.")
        stream = container.streams.audio[0]
        rate = stream.codec_context.sample_rate
        channels = stream.channels
        buffers = []
        for frame in container.decode(streams=stream.index):
            buffer = torch.from_numpy(frame.to_ndarray())
            if buffer.shape[0] != channels:
                buffer = buffer.view(-1, channels).t()
            buffers.append(buffer)

    if not buffers:
        raise BrowseError(f"No sound could be read from '{os.path.basename(path)}'.")

    waveform = torch.cat(buffers, dim=1)
    if waveform.dtype != torch.float32:
        # Integer PCM, scaled by the width of its own type.
        waveform = waveform.float() / float(1 << (8 * waveform.element_size() - 1))
    return {"waveform": waveform.unsqueeze(0), "sample_rate": rate}


def video_soundtrack(path: str):
    """The sound inside a video file, or `None` when it is silent.

    Offered as its own output because the stock node pairs a soundtrack with its
    video by slot number, and a reference clip that came with sound almost always
    wants that sound alongside it. A silent clip is not an error — most renders
    are silent — so this returns nothing rather than raising.
    """
    try:
        return load_audio(path)
    except BrowseError:
        return None


class MiniMaxH3ReferencePicker:
    """Fifteen reference slots, browsed from folders, ready to wire."""

    @classmethod
    def INPUT_TYPES(cls) -> Dict[str, Any]:
        optional: Dict[str, Any] = {}
        for index in range(1, MAX_PICTURES + 1):
            optional[f"picture_{index}"] = _slot("image", index, "Reference picture")
        for index in range(1, MAX_VIDEOS + 1):
            optional[f"video_{index}"] = _slot("video", index, "Reference video")
        for index in range(1, MAX_AUDIOS + 1):
            optional[f"audio_{index}"] = _slot("audio", index, "Reference audio")

        # Appended after every path, never interleaved with them.
        #
        # ComfyUI stores a node's widget values as a positional list, so a
        # widget inserted in the middle shifts every value after it: a workflow
        # saved before these existed would come back with its picture paths in
        # the wrong slots. Adding at the end is the one edit that is safe.
        for index in range(1, MAX_PICTURES + 1):
            optional[f"use_picture_{index}"] = _switch("image", index, "Reference picture")
        for index in range(1, MAX_VIDEOS + 1):
            optional[f"use_video_{index}"] = _switch("video", index, "Reference video")
        for index in range(1, MAX_AUDIOS + 1):
            optional[f"use_audio_{index}"] = _switch("audio", index, "Reference audio")

        return {
            "required": {
                "video_fps": ("INT", {
                    "default": TARGET_FPS, "min": 1, "max": 120,
                    "tooltip": "Reference videos are resampled to this. H3 expects "
                               "24 — leave it alone unless you know otherwise.",
                }),
                "video_seconds": ("INT", {
                    "default": MAX_VIDEO_SECONDS, "min": 1, "max": 60,
                    "tooltip": "Longer clips are trimmed to this many seconds. "
                               "H3 takes 2–15s of reference video.",
                }),
            },
            "optional": optional,
        }

    RETURN_TYPES = (
        *(["IMAGE"] * MAX_PICTURES),
        *(["IMAGE"] * MAX_VIDEOS),
        *(["AUDIO"] * MAX_VIDEOS),
        *(["AUDIO"] * MAX_AUDIOS),
    )
    RETURN_NAMES = (
        *[f"picture_{i}" for i in range(1, MAX_PICTURES + 1)],
        *[f"video_{i}" for i in range(1, MAX_VIDEOS + 1)],
        *[f"video_{i}_audio" for i in range(1, MAX_VIDEOS + 1)],
        *[f"audio_{i}" for i in range(1, MAX_AUDIOS + 1)],
    )
    FUNCTION = "pick"
    CATEGORY = CATEGORY_MINIMAX
    DESCRIPTION = (
        "Pick up to nine reference pictures, three videos and three audio clips "
        "from folders on this machine, and hand each one out on its own output "
        "for wiring into MiniMax H3 Reference to Video."
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs) -> Any:
        """Notice a replaced file without reading any of them.

        Size and modification time per filled slot. A byte-identical rewrite
        with a preserved timestamp is missed, and in that case the cached result
        is right anyway.
        """
        marks: List[str] = []
        for name, value in sorted(kwargs.items()):
            # A flipped switch changes the output without touching a path, so
            # it has to be part of the mark or the cached result would stand.
            if isinstance(value, bool):
                marks.append(f"{name}={value}")
                continue
            if not isinstance(value, str) or not value.strip():
                continue
            try:
                stat = os.stat(resolve_reference(value))
                marks.append(f"{name}={stat.st_size}:{stat.st_mtime_ns}")
            except (BrowseError, OSError):
                marks.append(f"{name}={value}")
        return "|".join(marks)

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs) -> Any:
        """Refuse a bad path before the queue rather than after the decode."""
        for name, value in sorted(kwargs.items()):
            if not isinstance(value, str) or not value.strip():
                continue
            if not name.startswith(("picture_", "video_", "audio_")):
                continue
            # A stale path in a slot that is switched off is not going to be
            # read, so it is not a reason to refuse the whole queue.
            if not kwargs.get(f"use_{name}", True):
                continue
            try:
                resolve_reference(value)
            except BrowseError as error:
                return f"{name}: {error}"
        return True

    def pick(self, video_fps: int = TARGET_FPS, video_seconds: int = MAX_VIDEO_SECONDS, **kwargs):
        def path_of(name: str) -> Optional[str]:
            # Absent means on: a workflow saved before the switches existed has
            # no value for them, and it used every slot it had a path for.
            if not kwargs.get(f"use_{name}", True):
                return None
            value = kwargs.get(name)
            if not isinstance(value, str) or not value.strip():
                return None
            return resolve_reference(value)

        pictures: List[Any] = []
        for index in range(1, MAX_PICTURES + 1):
            path = path_of(f"picture_{index}")
            # An empty slot hands out nothing, and the stock node drops it.
            pictures.append(load_image(path)[0] if path else None)

        videos: List[Any] = []
        soundtracks: List[Any] = []
        for index in range(1, MAX_VIDEOS + 1):
            path = path_of(f"video_{index}")
            videos.append(load_video(path, video_fps, video_seconds) if path else None)
            soundtracks.append(video_soundtrack(path) if path else None)

        audios: List[Any] = []
        for index in range(1, MAX_AUDIOS + 1):
            path = path_of(f"audio_{index}")
            audios.append(load_audio(path) if path else None)

        filled = sum(1 for entry in pictures + videos + audios if entry is not None)
        print(f"[comfyllama] MiniMax H3 reference picker: {filled} slot(s) filled")

        return (*pictures, *videos, *soundtracks, *audios)


__all__ = ["MiniMaxH3ReferencePicker", "load_video", "load_audio"]
