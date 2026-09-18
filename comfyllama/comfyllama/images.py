"""Conversion from ComfyUI ``IMAGE`` tensors to data URIs.

llama.cpp's multimodal chat handlers accept OpenAI-style ``image_url`` content
parts, so batched ComfyUI images are encoded as base64 PNG/JPEG.
"""

from __future__ import annotations

import base64
import io
from typing import Any, Dict, List


def _to_pil_images(image) -> List[Any]:
    import numpy as np
    from PIL import Image

    array = image
    if hasattr(array, "detach"):  # torch tensor
        array = array.detach().cpu().numpy()
    array = np.asarray(array)

    if array.ndim == 3:
        array = array[None, ...]
    if array.ndim != 4:
        raise ValueError(f"Expected an IMAGE tensor of shape [B,H,W,C], got {array.shape}.")

    images = []
    for frame in array:
        if frame.dtype != np.uint8:
            frame = np.clip(frame * 255.0, 0, 255).astype(np.uint8)
        if frame.shape[-1] == 4:
            images.append(Image.fromarray(frame, "RGBA").convert("RGB"))
        elif frame.shape[-1] == 1:
            images.append(Image.fromarray(frame[..., 0], "L").convert("RGB"))
        else:
            images.append(Image.fromarray(frame[..., :3], "RGB"))
    return images


def _resize(image, max_size: int):
    if max_size <= 0:
        return image
    width, height = image.size
    longest = max(width, height)
    if longest <= max_size:
        return image
    from PIL import Image

    scale = max_size / float(longest)
    size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    return image.resize(size, Image.LANCZOS)


def image_to_data_uri(image, *, max_size: int = 1024, quality: int = 90) -> str:
    """Encode a single PIL image as a ``data:`` URI."""
    image = _resize(image, max_size)
    buffer = io.BytesIO()
    if quality >= 100:
        image.save(buffer, format="PNG")
        mime = "image/png"
    else:
        image.save(buffer, format="JPEG", quality=int(quality))
        mime = "image/jpeg"
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def images_to_content(image, *, max_size: int = 1024, quality: int = 90) -> List[Dict[str, Any]]:
    """Build the ``image_url`` content parts for an IMAGE batch."""
    return [
        {"type": "image_url", "image_url": {"url": image_to_data_uri(
            frame, max_size=max_size, quality=quality)}}
        for frame in _to_pil_images(image)
    ]


def sample_frames(video, count: int) -> List[Any]:
    """`count` frames spread evenly across a clip, first and last included.

    A clip reaching a chat node is an ``IMAGE`` batch — that is what ComfyUI's
    own ``Get Video Components`` produces and what this pack's reference picker
    produces — so "sending a video" is really sending some of its frames. Which
    ones matters: fifteen seconds at 24fps is 360 frames, and a model asked to
    look at 360 pictures will either refuse or spend a minute of context on a
    shot that barely moves.

    Evenly spaced rather than the first *n*, because the first second of a clip
    is the part that says least about it. First and last always included, so the
    sample spans the whole thing rather than stopping short of the end.
    """
    frames = _to_pil_images(video)
    if count <= 0 or len(frames) <= count:
        return frames
    if count == 1:
        return [frames[0]]
    step = (len(frames) - 1) / (count - 1)
    return [frames[int(round(index * step))] for index in range(count)]


def video_to_content(video, *, frames: int = 8, max_size: int = 1024,
                     quality: int = 90) -> List[Dict[str, Any]]:
    """A clip as the handful of frames a model can actually look at."""
    return [
        {"type": "image_url", "image_url": {"url": image_to_data_uri(
            frame, max_size=max_size, quality=quality)}}
        for frame in sample_frames(video, frames)
    ]


def audio_to_wav(audio) -> bytes:
    """ComfyUI's ``AUDIO`` as a WAV file, in memory.

    16-bit PCM through the standard library's ``wave``, rather than a new
    dependency: llama-server decodes with miniaudio, which takes mp3, wav and
    flac, and wav is the one of those that can be written without an encoder.

    The waveform arrives as ``(batch, channels, samples)`` floats in -1..1. Only
    the first item of the batch is sent — a chat turn is one sound — and the
    channel axis is interleaved, which is what a WAV frame is.
    """
    import wave

    import numpy as np

    waveform = audio["waveform"]
    rate = int(audio["sample_rate"])

    samples = waveform[0] if waveform.ndim == 3 else waveform
    array = samples.detach().cpu().numpy() if hasattr(samples, "detach") else np.asarray(samples)
    if array.ndim == 1:
        array = array.reshape(1, -1)

    # (channels, samples) -> interleaved (samples, channels), clipped before the
    # cast so a waveform that peaks above 1.0 does not wrap around to silence.
    interleaved = np.clip(array.T, -1.0, 1.0)
    pcm = (interleaved * 32767.0).astype("<i2")

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(array.shape[0])
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def audio_to_content(audio) -> List[Dict[str, Any]]:
    """The ``input_audio`` content part for one sound.

    llama-server's OpenAI-compatible endpoint takes audio as
    ``input_audio.data``, base64, and works the format out from the bytes
    themselves — the ``format`` field is documented as ignored. It is sent
    anyway, because every other client sends it and a server that stops
    ignoring it should be told the truth.
    """
    return [{
        "type": "input_audio",
        "input_audio": {
            "data": base64.b64encode(audio_to_wav(audio)).decode("ascii"),
            "format": "wav",
        },
    }]
