"""The folder browser, and mostly the boundary around it.

`browse.py` decides what an HTTP route on a ComfyUI server will open. Whatever
it allows, anybody who can reach that server can read — so most of what is here
is the same question asked several ways: can a request name a path outside the
folders the server was configured with?

The listing tests are the other half: sorting and filtering are what make the
thing usable on a real output directory, and they are pure functions of a
directory tree, which is the easiest kind of thing to be sure about.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import time
import unittest

# Importing test_nodes installs the ComfyUI stubs before comfyllama is loaded.
from test_nodes import HAVE_IMAGING

from comfyllama import browse

try:
    import torch  # noqa: F401

    HAVE_TORCH = True
except ImportError:
    HAVE_TORCH = False

# Decoding a picture needs all three: Pillow to read it, numpy to turn it into
# an array, torch to hand ComfyUI the tensor it expects. Everything else in
# here — the boundary, the listing — is stdlib, which is the point.
CAN_DECODE = HAVE_IMAGING and HAVE_TORCH


class BrowseTestCase(unittest.TestCase):
    """A tree to look at, and only that tree allowed."""

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="comfyllama-browse-")
        self.root = os.path.join(self.tmp, "outputs")
        self.outside = os.path.join(self.tmp, "private")
        os.makedirs(os.path.join(self.root, "monday"))
        os.makedirs(os.path.join(self.root, "tuesday", "portraits"))
        os.makedirs(self.outside)

        self.write(self.root, "alpha.png", size=300)
        self.write(self.root, "beta.jpg", size=100)
        self.write(self.root, "notes.txt", size=10)
        self.write(os.path.join(self.root, "monday"), "gamma.png", size=200)
        self.write(os.path.join(self.root, "tuesday", "portraits"), "delta.webp", size=50)
        self.write(self.outside, "secret.png", size=10)

        self._previous = os.environ.get(browse.ROOTS_ENV)
        os.environ[browse.ROOTS_ENV] = self.root

    def tearDown(self) -> None:
        if self._previous is None:
            os.environ.pop(browse.ROOTS_ENV, None)
        else:
            os.environ[browse.ROOTS_ENV] = self._previous
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, folder: str, name: str, *, size: int = 1) -> str:
        path = os.path.join(folder, name)
        with open(path, "wb") as handle:
            handle.write(b"x" * size)
        return path

    @property
    def key(self) -> str:
        keys = list(browse.allowed_roots())
        self.assertTrue(keys, "the test root should be allowed")
        return keys[0]


class TestWhichFoldersAreAllowed(BrowseTestCase):
    def test_the_environment_names_them_and_nothing_else_does(self):
        self.assertEqual(list(browse.allowed_roots().values()),
                         [os.path.realpath(self.root)])

        # With the variable gone, so is the root. There is no default that
        # quietly keeps a folder reachable after it was un-configured.
        os.environ.pop(browse.ROOTS_ENV)
        self.assertEqual(browse.allowed_roots(), {})

    def test_a_folder_that_does_not_exist_is_not_offered(self):
        os.environ[browse.ROOTS_ENV] = os.path.join(self.tmp, "nowhere")
        self.assertEqual(browse.allowed_roots(), {})

    def test_two_folders_with_the_same_name_stay_separate(self):
        """Otherwise the second silently shadows the first."""
        other = os.path.join(self.tmp, "elsewhere", "outputs")
        os.makedirs(other)
        os.environ[browse.ROOTS_ENV] = os.pathsep.join([self.root, other])

        roots = browse.allowed_roots()
        self.assertEqual(len(roots), 2)
        self.assertEqual(len(set(roots.values())), 2)

    def test_the_same_folder_twice_is_one_root(self):
        os.environ[browse.ROOTS_ENV] = os.pathsep.join([self.root, self.root])
        self.assertEqual(len(browse.allowed_roots()), 1)


class TestNothingEscapesARoot(BrowseTestCase):
    """The reason this module exists as its own file."""

    def test_a_relative_path_inside_resolves(self):
        self.assertEqual(
            browse.resolve(self.key, "monday/gamma.png"),
            os.path.join(os.path.realpath(self.root), "monday", "gamma.png"),
        )

    def test_dot_dot_cannot_climb_out(self):
        for attempt in ("../private/secret.png",
                        "monday/../../private/secret.png",
                        "../../etc/passwd"):
            with self.subTest(path=attempt):
                with self.assertRaises(browse.BrowseError):
                    browse.resolve(self.key, attempt)

    def test_an_absolute_path_does_not_replace_the_root(self):
        """`os.path.join` discards the root when the second half is absolute."""
        with self.assertRaises(browse.BrowseError):
            browse.resolve(self.key, os.path.join(self.outside, "secret.png"))
        with self.assertRaises(browse.BrowseError):
            browse.resolve(self.key, "/etc/passwd")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks are required")
    def test_a_symlink_pointing_out_is_refused(self):
        """The case a textual check for `..` cannot see."""
        link = os.path.join(self.root, "escape")
        try:
            os.symlink(self.outside, link)
        except (OSError, NotImplementedError):
            self.skipTest("this platform will not create symlinks")

        with self.assertRaises(browse.BrowseError):
            browse.resolve(self.key, "escape/secret.png")

    def test_a_sibling_folder_with_the_root_as_a_prefix_is_outside(self):
        """`startswith` says yes to this; `commonpath` does not."""
        sibling = self.root + "-private"
        os.makedirs(sibling)
        self.write(sibling, "secret.png")
        with self.assertRaises(browse.BrowseError):
            browse.resolve(self.key, os.path.join(sibling, "secret.png"))

    def test_an_unknown_root_is_refused(self):
        with self.assertRaises(browse.BrowseError):
            browse.resolve("not-a-root", "alpha.png")

    def test_a_missing_file_is_refused_rather_than_returned(self):
        with self.assertRaises(browse.BrowseError):
            browse.resolve(self.key, "monday/nothing.png")


class TestTheStoredReference(BrowseTestCase):
    def test_a_reference_carries_its_root(self):
        self.assertEqual(browse.split_reference(f"{self.key}/monday/gamma.png"),
                         (self.key, "monday/gamma.png"))

    def test_backslashes_are_read_as_separators(self):
        """A path copied out of a Windows file manager."""
        self.assertEqual(
            browse.split_reference(f"{self.key}\\monday\\gamma.png"),
            (self.key, "monday/gamma.png"),
        )

    def test_an_empty_or_rootless_reference_says_what_to_do(self):
        for attempt in ("", "   ", "output"):
            with self.subTest(reference=attempt):
                with self.assertRaises(browse.BrowseError) as ctx:
                    browse.split_reference(attempt)
                self.assertIn("browser", str(ctx.exception))

    def test_resolving_a_reference_refuses_a_folder(self):
        with self.assertRaises(browse.BrowseError):
            browse.resolve_reference(f"{self.key}/monday")


class TestListing(BrowseTestCase):
    def test_folders_and_files_are_kept_apart(self):
        listing = browse.list_folder(self.key)
        self.assertEqual([entry["name"] for entry in listing["folders"]],
                         ["monday", "tuesday"])
        self.assertEqual({entry["name"] for entry in listing["files"]},
                         {"alpha.png", "beta.jpg"})

    def test_only_pictures_are_listed(self):
        names = {entry["name"] for entry in browse.list_folder(self.key)["files"]}
        self.assertNotIn("notes.txt", names)

    def test_a_flat_listing_stops_at_the_folder(self):
        listing = browse.list_folder(self.key)
        self.assertNotIn("gamma.png", {entry["name"] for entry in listing["files"]})

    def test_recursion_finds_what_is_underneath(self):
        listing = browse.list_folder(self.key, recursive=True)
        self.assertEqual(
            {entry["path"] for entry in listing["files"]},
            {"alpha.png", "beta.jpg", "monday/gamma.png",
             "tuesday/portraits/delta.webp"},
        )
        # Still only the folders one level down: those are the navigation.
        self.assertEqual([entry["name"] for entry in listing["folders"]],
                         ["monday", "tuesday"])

    def test_sorting_by_size_and_name(self):
        by_size = browse.list_folder(self.key, recursive=True, sort="size", order="desc")
        self.assertEqual([entry["name"] for entry in by_size["files"]][0], "alpha.png")

        by_name = browse.list_folder(self.key, recursive=True, sort="name", order="asc")
        self.assertEqual([entry["name"] for entry in by_name["files"]],
                         ["alpha.png", "beta.jpg", "delta.webp", "gamma.png"])

    def test_sorting_by_date_is_the_default_and_is_newest_first(self):
        newest = self.write(self.root, "zulu.png")
        os.utime(newest, (time.time() + 60, time.time() + 60))
        listing = browse.list_folder(self.key)
        self.assertEqual(listing["files"][0]["name"], "zulu.png")

    def test_the_filter_is_a_case_insensitive_substring(self):
        listing = browse.list_folder(self.key, recursive=True, query="AMM")
        self.assertEqual([entry["name"] for entry in listing["files"]], ["gamma.png"])

    def test_the_filter_reaches_folders_too(self):
        listing = browse.list_folder(self.key, query="mon")
        self.assertEqual([entry["name"] for entry in listing["folders"]], ["monday"])

    def test_a_listing_is_capped_and_says_so(self):
        listing = browse.list_folder(self.key, recursive=True, limit=2)
        self.assertEqual(len(listing["files"]), 2)
        self.assertTrue(listing["truncated"])
        self.assertGreater(listing["total"], 2)

    def test_an_uncapped_listing_does_not_claim_to_be_cut_short(self):
        listing = browse.list_folder(self.key, recursive=True)
        self.assertFalse(listing["truncated"])

    def test_a_nonsense_sort_falls_back_rather_than_failing(self):
        """The query string comes off the wire; it is not a promise."""
        nonsense = browse.list_folder(self.key, sort="colour", order="sideways")
        default = browse.list_folder(self.key)
        self.assertEqual([entry["name"] for entry in nonsense["files"]],
                         [entry["name"] for entry in default["files"]])

    def test_listing_a_file_is_refused(self):
        with self.assertRaises(browse.BrowseError):
            browse.list_folder(self.key, "alpha.png")

    def test_the_path_comes_back_relative_to_the_root(self):
        listing = browse.list_folder(self.key, "tuesday/portraits")
        self.assertEqual(listing["path"], "tuesday/portraits")
        self.assertEqual(browse.list_folder(self.key)["path"], "")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks are required")
    def test_a_symlinked_folder_is_not_walked_into(self):
        """Otherwise a link back up the tree makes the walk loop."""
        try:
            os.symlink(self.root, os.path.join(self.root, "monday", "loop"))
        except (OSError, NotImplementedError):
            self.skipTest("this platform will not create symlinks")

        listing = browse.list_folder(self.key, recursive=True)
        self.assertEqual(
            {entry["path"] for entry in listing["files"]},
            {"alpha.png", "beta.jpg", "monday/gamma.png",
             "tuesday/portraits/delta.webp"},
        )


class TestTheNode(BrowseTestCase):
    """What the node does with a reference, short of decoding pixels."""

    def test_an_unset_path_is_refused_before_the_queue(self):
        from comfyllama.nodes.browser import LoadImageFromFolder

        result = LoadImageFromFolder.VALIDATE_INPUTS(image="")
        self.assertIsInstance(result, str)
        self.assertIn("browser", result)

    def test_a_path_outside_a_root_is_refused_before_the_queue(self):
        from comfyllama.nodes.browser import LoadImageFromFolder

        result = LoadImageFromFolder.VALIDATE_INPUTS(
            image=f"{self.key}/../private/secret.png")
        self.assertIsInstance(result, str)

    def test_a_real_picture_validates(self):
        from comfyllama.nodes.browser import LoadImageFromFolder

        self.assertIs(
            LoadImageFromFolder.VALIDATE_INPUTS(image=f"{self.key}/alpha.png"), True)

    def test_the_cache_key_changes_when_the_file_does(self):
        """Or a replaced render keeps showing the one it replaced."""
        from comfyllama.nodes.browser import LoadImageFromFolder

        reference = f"{self.key}/alpha.png"
        before = LoadImageFromFolder.IS_CHANGED(image=reference)
        self.write(self.root, "alpha.png", size=999)
        self.assertNotEqual(before, LoadImageFromFolder.IS_CHANGED(image=reference))

    def test_an_unreachable_path_does_not_raise_from_is_changed(self):
        """ComfyUI calls it while building the prompt; `load` is where it fails."""
        from comfyllama.nodes.browser import LoadImageFromFolder

        self.assertIsNotNone(LoadImageFromFolder.IS_CHANGED(image="nope/nope.png"))

    @unittest.skipUnless(CAN_DECODE, "Pillow, numpy and torch are required")
    def test_loading_a_real_picture_gives_an_image_and_a_mask(self):
        from PIL import Image

        from comfyllama.nodes.browser import LoadImageFromFolder

        path = os.path.join(self.root, "real.png")
        Image.new("RGB", (8, 4), (255, 0, 0)).save(path)

        image, mask, name = LoadImageFromFolder().load(image=f"{self.key}/real.png")
        # [B, H, W, C], which is the shape every other node here expects.
        self.assertEqual(tuple(image.shape), (1, 4, 8, 3))
        self.assertEqual(tuple(mask.shape), (1, 4, 8))
        # Opaque, so nothing is masked.
        self.assertEqual(float(mask.abs().sum()), 0.0)
        # Without the extension: this is for a filename_prefix.
        self.assertEqual(name, "real")

    @unittest.skipUnless(CAN_DECODE, "Pillow, numpy and torch are required")
    def test_transparency_becomes_the_mask(self):
        from PIL import Image

        from comfyllama.nodes.browser import LoadImageFromFolder

        path = os.path.join(self.root, "clear.png")
        Image.new("RGBA", (4, 4), (0, 0, 0, 0)).save(path)

        _, mask, _ = LoadImageFromFolder().load(image=f"{self.key}/clear.png")
        # Fully transparent is fully masked — the inverse of the alpha.
        self.assertEqual(float(mask.min()), 1.0)


if __name__ == "__main__":
    unittest.main()
