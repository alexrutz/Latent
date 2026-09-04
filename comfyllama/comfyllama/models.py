"""What the model files on this machine are, and what they say about themselves.

A LoRA is useless without the words it was trained on. They are printed on the
page you downloaded it from, and nowhere near the point where you are writing a
prompt on a phone — so in practice they are typed from memory, badly, or the
LoRA is used without them and quietly does a third of what it could.

Two places to find them, and this module is the first:

* **The file's own header.** A `.safetensors` file begins with a JSON header,
  and the kohya trainers that produce most LoRAs write what they trained on into
  it — `ss_tag_frequency` is literally the tag list with counts. Reading it
  costs one seek and a few kilobytes, works with no network at all, and is
  therefore what everything else falls back to.
* **Civitai**, keyed by the file's SHA256, which is the creator's own trigger
  words and notes. That needs a hash of the whole file, so it is asked for
  rather than volunteered — see `file_hash`.

Read here, on the machine the models are on, for the same reason as the folder
browser and the power draw: Latent is routinely somewhere else, and a rented box
does not share a filesystem with the house.
"""

from __future__ import annotations

import hashlib
import json
import os
import struct
from typing import Any, Dict, List, Optional

ROUTE = "/comfyllama/models"
HASH_ROUTE = "/comfyllama/models/hash"

# Folders worth offering.
#
# Anything ComfyUI knows about could be listed, but these are the ones whose
# trigger words, base model and creator notes anybody asks about.
FOLDERS = ("loras", "checkpoints", "diffusion_models")

# Keys to try for one folder, in order.
#
# `unet` is not a second folder — ComfyUI aliases it to the same entry as
# `diffusion_models`, the same directories and the same files. Serving both as
# categories listed everything twice under two names, which is what it looked
# like: the same models in two places. So one category, and the old key only as
# a fallback for an install too old to have the new one.
ALIASES = {"diffusion_models": ("diffusion_models", "unet")}

# The header is JSON and small; a file claiming otherwise is not one we read.
#
# Real headers run to a few hundred kilobytes for a big checkpoint with
# thousands of tensors. 32 MB is far past any of them and still refuses to load
# a corrupt or hostile file that claims its header is the size of the disk.
MAX_HEADER_BYTES = 32 * 1024 * 1024

# Hashes are cached in memory, keyed by identity rather than by path: hashing a
# 7 GB checkpoint takes tens of seconds and the answer only changes when the
# file does.
_hashes: "dict[tuple[str, int, int], str]" = {}


def _folder_paths():
    try:
        import folder_paths  # provided by ComfyUI at runtime
    except ImportError:
        return None
    return folder_paths


def _identity(path: str) -> "tuple[str, int, int]":
    stat = os.stat(path)
    return (path, stat.st_size, stat.st_mtime_ns)


def read_header(path: str) -> Dict[str, Any]:
    """The `__metadata__` block of a safetensors file, or `{}`.

    Layout is fixed: eight bytes of little-endian length, then that many bytes
    of JSON. Anything else — a `.ckpt` pickle, a truncated download, a file that
    is not a model at all — gives an empty dict rather than raising, because a
    listing of forty models must not fail on one of them.
    """
    try:
        with open(path, "rb") as handle:
            packed = handle.read(8)
            if len(packed) < 8:
                return {}
            (length,) = struct.unpack("<Q", packed)
            if length <= 0 or length > MAX_HEADER_BYTES:
                return {}
            header = json.loads(handle.read(length).decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return {}

    metadata = header.get("__metadata__") if isinstance(header, dict) else None
    return metadata if isinstance(metadata, dict) else {}


def _tags_from_frequency(raw: str, limit: int) -> List[str]:
    """The trained tags, commonest first.

    `ss_tag_frequency` is a JSON string of `{directory: {tag: count}}` — one
    entry per training subfolder, which for a normal LoRA is one entry and for a
    multi-concept one is several. They are summed rather than taking the first,
    because a tag appearing in every folder is exactly the one that matters.
    """
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, dict):
        return []

    totals: Dict[str, int] = {}
    for group in parsed.values():
        if not isinstance(group, dict):
            continue
        for tag, count in group.items():
            if not isinstance(tag, str):
                continue
            cleaned = tag.strip()
            # Kohya writes the folder's repeat count into the tag list as a
            # bare number on some setups; it is not a word anybody prompts with.
            if not cleaned or cleaned.isdigit():
                continue
            try:
                totals[cleaned] = totals.get(cleaned, 0) + int(count)
            except (TypeError, ValueError):
                totals[cleaned] = totals.get(cleaned, 0) + 1

    ordered = sorted(totals.items(), key=lambda item: (-item[1], item[0]))
    return [tag for tag, _count in ordered[:limit]]


def describe(path: str, name: str, tag_limit: int = 24) -> Dict[str, Any]:
    """One model, as far as its own file will admit."""
    try:
        stat = os.stat(path)
        size: Optional[int] = stat.st_size
        modified: Optional[float] = stat.st_mtime
    except OSError:
        size = None
        modified = None

    metadata = read_header(path)

    # Two conventions, both in the wild. `modelspec.*` is the newer cross-tool
    # standard and is trusted first where it exists; `ss_*` is what the kohya
    # trainers have always written and is what most LoRAs actually carry.
    base = (
        metadata.get("modelspec.architecture")
        or metadata.get("ss_base_model_version")
        or metadata.get("ss_sd_model_name")
        or None
    )

    tags = _tags_from_frequency(metadata.get("ss_tag_frequency", ""), tag_limit)

    return {
        "name": name,
        "size": size,
        "modified": modified,
        # What it was trained on, commonest first. Not the same thing as the
        # creator's trigger words — those come from Civitai — but for a LoRA
        # with no page left on the internet it is all there is, and it is
        # usually right.
        "trainedTags": tags,
        "baseModel": base if isinstance(base, str) else None,
        "title": metadata.get("modelspec.title") or metadata.get("ss_output_name") or None,
        "description": metadata.get("modelspec.description") or None,
        "networkDim": metadata.get("ss_network_dim") or None,
        "networkAlpha": metadata.get("ss_network_alpha") or None,
        "clipSkip": metadata.get("ss_clip_skip") or None,
        "trainImages": metadata.get("ss_num_train_images") or None,
        # Whether there was a header worth reading at all, so the caller can
        # tell "nothing in it" from "not a safetensors file".
        "hasMetadata": bool(metadata),
    }


def _keys(folder: str) -> "tuple[str, ...]":
    """The registry keys to try for a folder. See `ALIASES`."""
    return ALIASES.get(folder, (folder,))


def _resolve(folder: str, name: str) -> Optional[str]:
    """The full path of one model, or None. Never escapes the folder registry."""
    paths = _folder_paths()
    if paths is None or folder not in FOLDERS:
        return None
    for key in _keys(folder):
        try:
            full = paths.get_full_path(key, name)
        except Exception:
            continue
        if full and os.path.isfile(full):
            return full
    return None


def list_models(folder: str, tag_limit: int = 24) -> Dict[str, Any]:
    """Every model in one of ComfyUI's folders, with what its header says.

    The names are exactly what `/object_info` offers and what a `<lora:…>` tag
    takes, because that is the only identifier that survives the trip to a
    phone and back into a prompt.
    """
    if folder not in FOLDERS:
        return {"folder": folder, "models": [], "error": "unknown folder"}

    paths = _folder_paths()
    if paths is None:
        return {"folder": folder, "models": [], "error": "not running inside ComfyUI"}

    # Tried in order, and "readable but empty" is a real answer: a configured
    # folder with nothing in it is not the same as a key this ComfyUI has never
    # heard of, and reporting the first as the second would send somebody
    # looking for a configuration problem that is not there.
    names: List[str] = []
    readable = False
    for key in _keys(folder):
        try:
            names = paths.get_filename_list(key)
        except Exception:
            continue
        readable = True
        if names:
            break

    if not readable:
        return {"folder": folder, "models": [], "error": "that folder is not configured"}

    models = []
    for name in names:
        full = _resolve(folder, name)
        if full is None:
            # Listed but gone: a model deleted since ComfyUI cached the list.
            continue
        models.append(describe(full, name, tag_limit))

    return {"folder": folder, "models": models}


def file_hash(folder: str, name: str) -> Optional[str]:
    """The SHA256 of one model file, cached by its identity.

    Slow on purpose-built hardware and slower on a rented box — a 7 GB
    checkpoint is tens of seconds of pure I/O — which is why nothing calls this
    on its own initiative. It is what Civitai keys on, so it is computed when
    somebody actually asks to look a model up.
    """
    full = _resolve(folder, name)
    if full is None:
        return None

    try:
        key = _identity(full)
    except OSError:
        return None

    cached = _hashes.get(key)
    if cached is not None:
        return cached

    digest = hashlib.sha256()
    try:
        with open(full, "rb") as handle:
            # A megabyte at a time: big enough that the syscall overhead
            # disappears, small enough not to hold a checkpoint in memory.
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None

    value = digest.hexdigest()
    _hashes[key] = value
    return value


def reset() -> None:
    """Forget the cached hashes. For tests."""
    _hashes.clear()


def register_routes() -> bool:
    """Attach the two model routes to ComfyUI's aiohttp app. No-op outside it."""
    try:
        import asyncio

        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return False

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if routes is None:
        return False

    @routes.get(ROUTE)
    async def get_models(request):  # pragma: no cover - needs a running server
        folder = request.query.get("folder") or "loras"
        # Reading forty headers is forty seeks; off the event loop so ComfyUI
        # keeps answering everything else while it happens.
        result = await asyncio.to_thread(list_models, folder)
        return web.json_response(result)

    @routes.get(HASH_ROUTE)
    async def get_hash(request):  # pragma: no cover - needs a running server
        folder = request.query.get("folder") or "loras"
        name = request.query.get("name") or ""
        digest = await asyncio.to_thread(file_hash, folder, name)
        if digest is None:
            return web.json_response({"error": "No such model."}, status=404)
        return web.json_response({"folder": folder, "name": name, "sha256": digest})

    return True
