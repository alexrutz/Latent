"""The HTTP routes behind the folder browser.

Three of them, and nothing else: what folders exist, what is in one, and a
thumbnail. Everything they are allowed to reach is decided by
`comfyllama.browse` — these are the transport, not the policy, and the split is
what lets the policy be tested without a server.

The thumbnail route is the one that serves bytes off the disk, so it goes
through the same `resolve` as everything else and re-encodes what it finds
rather than streaming the file: a browser grid asking for forty full-size
renders is forty times twenty megabytes, and re-encoding is also what keeps a
malformed file from being handed to the browser verbatim.
"""

from __future__ import annotations

import asyncio
import io
import os
from typing import Any, Dict, Optional, Tuple

from .browse import (BrowseError, LIST_LIMIT, describe_roots, list_folder,
                     resolve)

ROOTS_ROUTE = "/comfyllama/browse/roots"
LIST_ROUTE = "/comfyllama/browse/list"
THUMB_ROUTE = "/comfyllama/browse/thumb"

# How big a thumbnail is, and how many are kept.
#
# 256 is what a grid cell needs on a high-density display. The cache is small
# and in memory on purpose: it exists so that scrolling back up a grid does not
# re-decode everything, not so that a month of browsing is kept on disk.
THUMB_SIZE = 256
CACHE_ENTRIES = 512

_cache: "dict[Tuple[str, str], bytes]" = {}


def _cache_key(path: str) -> Tuple[str, str]:
    """Keyed by the file's identity, not just its name.

    A render written to the same path twice — which is what a `filename_prefix`
    without a counter does — would otherwise keep showing the first one.
    """
    try:
        stat = os.stat(path)
        return (path, f"{stat.st_size}:{stat.st_mtime_ns}")
    except OSError:
        return (path, "missing")


def thumbnail(root_key: str, relative: str, size: int = THUMB_SIZE) -> bytes:
    """A small WebP of one picture. Raises `BrowseError` for anything else."""
    path = resolve(root_key, relative)
    if not os.path.isfile(path):
        raise BrowseError("That is not a file.")

    key = _cache_key(path)
    cached = _cache.get(key)
    if cached is not None:
        return cached

    from PIL import Image, ImageOps

    with Image.open(path) as opened:
        upright = ImageOps.exif_transpose(opened)
        upright = upright.convert("RGB")
        upright.thumbnail((size, size), Image.LANCZOS)
        buffer = io.BytesIO()
        upright.save(buffer, format="WEBP", quality=75)
    encoded = buffer.getvalue()

    # A plain cap rather than a real LRU: the access pattern here is scrolling
    # one folder, so the useful entries are all recent, and the whole thing is
    # cheap to rebuild.
    if len(_cache) >= CACHE_ENTRIES:
        _cache.clear()
    _cache[key] = encoded
    return encoded


def _as_bool(value: Optional[str]) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _listing(query: Dict[str, str]) -> Dict[str, Any]:
    """One listing, from the query string a route was called with."""
    try:
        limit = min(int(query.get("limit") or LIST_LIMIT), LIST_LIMIT)
    except (TypeError, ValueError):
        limit = LIST_LIMIT

    return list_folder(
        query.get("root") or "",
        query.get("path") or "",
        recursive=_as_bool(query.get("recursive")),
        query=query.get("q") or "",
        sort=query.get("sort") or "date",
        order=query.get("order") or "desc",
        limit=limit,
        # Which files this slot can use. An unknown kind falls back to pictures
        # rather than to everything: showing an mp3 in a picture slot is a
        # decode failure somebody has to go and understand.
        kind=query.get("kind") or "image",
    )


def register_routes() -> bool:
    """Attach the three routes to ComfyUI's aiohttp app. No-op outside it."""
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return False

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if routes is None:
        return False

    @routes.get(ROOTS_ROUTE)
    async def get_roots(request):  # pragma: no cover - needs a running server
        return web.json_response({"roots": describe_roots()})

    @routes.get(LIST_ROUTE)
    async def get_listing(request):  # pragma: no cover - needs a running server
        try:
            # Walking a directory is blocking work; a recursive listing of a
            # large output folder would stall every other request on the loop.
            result = await asyncio.to_thread(_listing, dict(request.query))
        except BrowseError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        return web.json_response(result)

    @routes.get(THUMB_ROUTE)
    async def get_thumbnail(request):  # pragma: no cover - needs a running server
        query = request.query
        try:
            data = await asyncio.to_thread(
                thumbnail, query.get("root") or "", query.get("path") or ""
            )
        except BrowseError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except Exception:
            # A file Pillow cannot open is a broken picture, not a broken
            # server: the grid shows a placeholder for it and carries on.
            return web.json_response({"error": "That image could not be read."}, status=415)

        return web.Response(
            body=data,
            content_type="image/webp",
            # Keyed by path and mtime upstream, so a browser holding one for an
            # hour can only ever be holding the right one.
            headers={"Cache-Control": "private, max-age=3600"},
        )

    return True
