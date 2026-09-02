"""Browsing the folders of finished pictures, to feed one back in.

An output directory that has been used for a month holds thousands of files in
dozens of subfolders, and the one you want is "that portrait from Tuesday". A
combo box listing every filename is not a way to find it; a folder tree with
thumbnails is.

This module is the part with no opinion about the interface: which folders may
be looked at, how a path inside one is resolved, and what a listing of one
contains. The node uses it, the HTTP routes use it, and the tests use it — so
the rule about what is reachable is written once, in one place, and can be
tested without a server.

Nothing here imports ComfyUI, torch or PIL at module level: it has to stay
importable on a machine that has none of them, which is where its tests run.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional, Tuple

# What counts as a picture worth listing.
#
# Deliberately not "everything Pillow can open". This is a browser for choosing
# an input image, and a folder of renders also holds JSON sidecars, text logs
# and the occasional video — none of which a LoadImage can use.
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".tif"}

# Extra folders to allow, beyond ComfyUI's own, as an os.pathsep-separated list.
#
# An environment variable rather than a widget on the node, and this is the
# whole security design of the feature. The browser is an HTTP route: whatever
# it will open, anybody who can reach ComfyUI can open. If the node's own text
# field decided, then "which folders may be read" would be a value inside a
# workflow — editable by anyone who can post a graph, and travelling inside
# every shared .json — which is a route that serves any file on the machine,
# wearing a folder browser as a disguise.
#
# So the list is part of how the server was *started*, the same place its port
# and its listen address come from, and a request can only ever choose among
# the entries it already holds.
ROOTS_ENV = "COMFYLLAMA_IMAGE_ROOTS"

# How many files one listing may return.
#
# A cap rather than paging, because the answer to "forty thousand files in one
# folder" is to filter, not to turn a page four hundred times. The listing says
# when it has been cut short so the interface can say so too.
LIST_LIMIT = 2000

# How deep a recursive listing goes.
#
# Output directories are nested by date, or by project, or by both — three
# levels covers that. Unbounded recursion on a folder somebody pointed at their
# home directory is a scan that never finishes.
MAX_DEPTH = 6

SORT_KEYS = ("name", "date", "size")
SORT_ORDERS = ("asc", "desc")


class BrowseError(ValueError):
    """A path that may not be reached, or a root that is not there.

    One type for both, because from the caller's side they are the same event:
    what was asked for is not available. Distinguishing them in the reply would
    tell a stranger which directories exist, which is the one thing a refusal
    should not do.
    """


# --------------------------------------------------------------------------
# Which folders may be browsed
# --------------------------------------------------------------------------

def _comfy_directories() -> List[Tuple[str, str]]:
    """ComfyUI's own three, when running inside ComfyUI."""
    try:
        import folder_paths  # provided by ComfyUI at runtime
    except ImportError:
        return []

    found: List[Tuple[str, str]] = []
    for key, getter in (
        ("output", "get_output_directory"),
        ("input", "get_input_directory"),
        ("temp", "get_temp_directory"),
    ):
        function = getattr(folder_paths, getter, None)
        if function is None:
            continue
        try:
            path = function()
        except Exception:
            continue
        if path:
            found.append((key, str(path)))
    return found


def _configured_directories() -> List[Tuple[str, str]]:
    """The extra folders the environment names, keyed by their own name."""
    raw = os.environ.get(ROOTS_ENV, "")
    found: List[Tuple[str, str]] = []
    for entry in raw.split(os.pathsep):
        path = entry.strip().strip('"')
        if not path:
            continue
        path = os.path.expanduser(path)
        key = os.path.basename(os.path.normpath(path)) or "folder"
        found.append((key, path))
    return found


def allowed_roots() -> Dict[str, str]:
    """Every folder that may be browsed, by the key a request names it with.

    Resolved to real paths here rather than at each use: a root reached through
    a symlink and the same root reached directly have to compare equal, or a
    file plainly inside one would be judged outside it.

    Keys are made unique by suffixing. Two configured folders that happen to
    share a basename would otherwise silently become one — the second shadowing
    the first — and the browser would show the wrong pictures under the right
    name.
    """
    roots: Dict[str, str] = {}
    for key, path in _comfy_directories() + _configured_directories():
        if not os.path.isdir(path):
            continue
        real = os.path.realpath(path)
        if real in roots.values():
            continue

        unique = key
        suffix = 2
        while unique in roots:
            unique = f"{key} ({suffix})"
            suffix += 1
        roots[unique] = real
    return roots


def describe_roots() -> List[Dict[str, str]]:
    """The allow-list, in the order the browser should offer it."""
    return [{"key": key, "path": path} for key, path in allowed_roots().items()]


# --------------------------------------------------------------------------
# Resolving one path inside one root
# --------------------------------------------------------------------------

def _is_inside(path: str, root: str) -> bool:
    """Whether `path` is `root` or sits under it.

    `os.path.commonpath` rather than `startswith`, which says yes to
    `/data/outputs-private` for the root `/data/outputs`.
    """
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        # Different drives on Windows, or one path relative and one absolute.
        return False


def resolve(root_key: str, relative: str = "") -> str:
    """The absolute path a request means, or `BrowseError`.

    Everything the routes and the node open goes through here. Three separate
    things are checked, and each has let a browser like this read a whole disk
    at some point in somebody's history:

    - the root is one of the allowed keys, never a path the caller supplied;
    - the joined path is resolved *fully*, so `..` cannot climb out of it and a
      symlink cannot point out of it;
    - the result is still inside the root after all of that resolving.

    The last is the one that matters. Refusing `..` in the text is not enough,
    because a symlink inside the folder is a `..` the text does not contain.
    """
    roots = allowed_roots()
    root = roots.get(root_key)
    if root is None:
        raise BrowseError(f"'{root_key}' is not a folder this server offers.")

    # An absolute path in the relative half would make `join` discard the root
    # entirely, which is the oldest way out of one.
    relative = (relative or "").replace("\\", "/").strip("/")
    candidate = os.path.realpath(os.path.join(root, relative)) if relative else root

    if not _is_inside(candidate, root):
        raise BrowseError("That path is outside the folder it claims to be in.")
    if not os.path.exists(candidate):
        raise BrowseError("There is nothing at that path.")
    return candidate


def split_reference(reference: str) -> Tuple[str, str]:
    """A stored `root/relative/path.png` into its two halves.

    What the node holds is one string, because a widget value is one string and
    has to survive an export as one. The root travels inside it because the
    same relative path exists under `output` and under `input`, and a picture
    that silently came from the wrong one is a bug nobody would think to look
    for.
    """
    text = (reference or "").replace("\\", "/").strip().strip("/")
    if not text:
        raise BrowseError("No image has been chosen. Open the browser and pick one.")
    root, _, relative = text.partition("/")
    if not relative:
        raise BrowseError(
            f"'{reference}' names a folder but no file. Open the browser and pick a picture."
        )
    return root, relative


def resolve_reference(reference: str) -> str:
    """The file a node's stored value points at."""
    root, relative = split_reference(reference)
    path = resolve(root, relative)
    if not os.path.isfile(path):
        raise BrowseError(f"'{reference}' is not a file.")
    return path


# --------------------------------------------------------------------------
# Listing
# --------------------------------------------------------------------------

def _entry(root: str, path: str) -> Optional[Dict[str, Any]]:
    """One file or folder, as the browser needs it.

    `None` for anything that cannot be read. A browser that raises because one
    file went away between the scan and the stat is a browser that fails on the
    folder ComfyUI is actively writing into — which is the folder you are most
    likely to be looking at.
    """
    try:
        stat = os.stat(path)
    except OSError:
        return None
    return {
        "name": os.path.basename(path),
        "path": os.path.relpath(path, root).replace(os.sep, "/"),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }


def _is_image(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS


def _collect(start: str, *, recursive: bool, limit: int) -> Tuple[List[str], List[str]]:
    """Subfolders and image files under `start`, as absolute paths.

    Only the *immediate* subfolders come back, even walking recursively: they
    are the navigation, and a flat list of every folder underneath is not a
    thing anybody clicks. Recursion is for the files.

    Symlinked directories are not followed. A link back up the tree would make
    the walk loop, and a link out of the root would produce files that
    `resolve` then correctly refuses to open — a listing full of pictures that
    cannot be picked.
    """
    folders: List[str] = []
    files: List[str] = []

    try:
        entries = sorted(os.scandir(start), key=lambda entry: entry.name.lower())
    except OSError as exc:
        raise BrowseError(f"That folder could not be read ({exc}).") from exc

    for entry in entries:
        try:
            if entry.is_dir(follow_symlinks=False):
                folders.append(entry.path)
            elif entry.is_file(follow_symlinks=False) and _is_image(entry.name):
                files.append(entry.path)
        except OSError:
            continue

    if not recursive:
        return folders, files

    # One extra past the cap, so the caller can tell "exactly the limit" from
    # "more than the limit" without walking the rest of the tree to count them.
    for walk_root, directories, names in os.walk(start, followlinks=False):
        depth = walk_root[len(start):].count(os.sep)
        if depth >= MAX_DEPTH:
            directories[:] = []
            continue
        if walk_root == start:
            continue  # already scanned above
        for name in names:
            if _is_image(name):
                files.append(os.path.join(walk_root, name))
        if len(files) > limit:
            return folders, files

    return folders, files


def _sort_key(sort: str):
    if sort == "name":
        return lambda entry: entry["name"].lower()
    if sort == "size":
        return lambda entry: entry["size"]
    return lambda entry: entry["mtime"]


def list_folder(
    root_key: str,
    relative: str = "",
    *,
    recursive: bool = False,
    query: str = "",
    sort: str = "date",
    order: str = "desc",
    limit: int = LIST_LIMIT,
) -> Dict[str, Any]:
    """What is in one folder, ready to draw.

    Folders and files are kept apart rather than sorted into one list: a folder
    is a place to go and a file is a thing to choose, and interleaving them by
    date puts the way onwards somewhere in the middle of a grid of pictures.

    `recursive` is what makes this usable on a real output directory, where the
    picture you want is under a date folder you would otherwise have to
    remember the name of. It is also the expensive mode, so it is off unless
    asked for, and capped like everything else.
    """
    root = allowed_roots().get(root_key)
    if root is None:
        raise BrowseError(f"'{root_key}' is not a folder this server offers.")
    start = resolve(root_key, relative)
    if not os.path.isdir(start):
        raise BrowseError("That is a file, not a folder.")

    sort = sort if sort in SORT_KEYS else "date"
    order = order if order in SORT_ORDERS else "desc"
    query = (query or "").strip().lower()
    limit = max(1, int(limit))

    # Not named `folder_paths`: that is the ComfyUI module this file imports a
    # few lines up, and shadowing it here would be a trap for the next edit.
    subfolders, pictures = _collect(start, recursive=recursive, limit=limit)

    def keep(entry: Optional[Dict[str, Any]]) -> bool:
        return entry is not None and (not query or query in entry["name"].lower())

    folders = [entry for entry in (_entry(root, path) for path in subfolders) if keep(entry)]
    files = [entry for entry in (_entry(root, path) for path in pictures) if keep(entry)]

    # Folders always by name. A folder's own date is when something was last
    # written into it, which is not a fact anybody navigates by.
    folders.sort(key=lambda entry: entry["name"].lower())
    files.sort(key=_sort_key(sort), reverse=(order == "desc"))

    return {
        "root": root_key,
        "path": "" if start == root else os.path.relpath(start, root).replace(os.sep, "/"),
        "folders": folders,
        "files": files[:limit],
        "truncated": len(files) > limit,
        "total": len(files),
    }
